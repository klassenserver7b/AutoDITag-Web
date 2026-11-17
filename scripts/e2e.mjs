/**
 * End to end test of the web app in a real Firefox.
 *
 * It runs the whole flow in the browser: pick a folder of mp3 files, enter a
 * descriptor file, run the job and download the ZIP. The resulting archive is
 * checked by `scripts/verify_output.py` (mutagen reads the tags back).
 *
 * Usage: node scripts/e2e.mjs [--headed]
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = path.join(tmpdir(), 'autoditag-e2e');
const fixtureDir = path.join(workDir, 'Tanzmusik');
const mismatchDir = path.join(workDir, 'Unrelated');
const brokenAudioDir = path.join(workDir, 'Broken');
const outputDir = path.join(workDir, 'out');
const siteDir = path.join(workDir, 'site');
// the app is served from a sub path, exactly like on GitHub Pages
const appDir = path.join(siteDir, 'repo');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

/** A minimal static file server. */
function serve(directory, port) {
  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
    let filePath = path.join(directory, requestPath);
    if (!filePath.startsWith(directory)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const DESCRIPTOR = [
  '01_Voices of Spring; André Rieu -- Wiener Walzer',
  '02_Shut Up And Dance; Walk The Moon -- Discofox',
  '03_Friday I\'m In Love; The Cure -- Cha Cha Cha',
].join('\n');

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Builds a synthetic MPEG1 Layer III file (44.1 kHz, 128 kbit/s, stereo).
 *
 * The CI runner has no ffmpeg, so the fixtures are generated here. The frames
 * only need a valid header - the app and mutagen both derive the duration from
 * the frame headers and the file size.
 */
function makeMp3(durationSeconds) {
  const sampleRate = 44100;
  const bitrateKbps = 128;
  const frameLength = Math.floor((144 * bitrateKbps * 1000) / sampleRate);
  const frames = Math.ceil((durationSeconds * sampleRate) / 1152);
  const data = Buffer.alloc(frames * frameLength);
  for (let index = 0; index < frames; index += 1) {
    const offset = index * frameLength;
    data[offset] = 0xff;
    data[offset + 1] = 0xfb; // MPEG1, Layer III, no CRC
    data[offset + 2] = 0x90; // 128 kbit/s, 44.1 kHz
    data[offset + 3] = 0x00; // stereo
  }
  return data;
}

/** A tiny, valid 8x8 blue JPEG for the mocked Spotify cover. */
const COVER_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAHAQEBAAAAAAAAAAAAAAAAAAAFBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAgACAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AI4Av4p//9k=';

function createFixtures() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  for (const file of ['01-Song.mp3', '02-Song.mp3', '03-Song.mp3']) {
    writeFileSync(path.join(fixtureDir, file), makeMp3(3));
  }

  // a file in a sub folder - like the python tool, it has to be ignored
  mkdirSync(path.join(fixtureDir, 'sub'), { recursive: true });
  writeFileSync(path.join(fixtureDir, 'sub', '04-Sub.mp3'), makeMp3(1));

  // a folder whose file does not match any descriptor entry
  mkdirSync(mismatchDir, { recursive: true });
  writeFileSync(path.join(mismatchDir, '99-Other.mp3'), makeMp3(3));

  // a file that matches, but is not readable as audio
  mkdirSync(brokenAudioDir, { recursive: true });
  writeFileSync(path.join(brokenAudioDir, '01-broken.mp3'), Buffer.from('not an mp3 file'));

  // a small jpeg for the fake spotify cover
  writeFileSync(path.join(workDir, 'cover.jpg'), Buffer.from(COVER_JPEG_BASE64, 'base64'));
  return true;
}

async function main() {
  if (!createFixtures()) return;

  // publish the build like GitHub Pages would: a sub directory of the server
  rmSync(siteDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  const distDir = path.join(root, 'dist');
  for (const entry of readdirSync(distDir)) {
    cpSync(path.join(distDir, entry), path.join(appDir, entry), { recursive: true });
  }

  const server = await serve(siteDir, 4173);
  const url = 'http://127.0.0.1:4173/repo/';
  log(`static server: ${url}`);

  const browser = await firefox.launch({ headless: !process.argv.includes('--headed') });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    log(`loaded: ${await page.title()}`);

    if (!(await page.isDisabled('#cancel-button'))) {
      fail('the cancel button must be disabled while no job runs');
    }

    // 1. pick the folder with the mp3 files
    await page.setInputFiles('#music-input', fixtureDir);

    // 2. enter the descriptor file and the playlist name
    await page.fill('#descriptor-text', DESCRIPTOR);
    await page.fill('#playlist-name', 'E2E Playlist');

    // 2b. a descriptor file that is not UTF-8 is refused, the textarea stays
    const descriptorBefore = await page.inputValue('#descriptor-text');
    await page.setInputFiles('#descriptor-input', {
      name: 'broken.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from([0xff, 0xfe, 0x41]),
    });
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.includes('not valid UTF-8'),
      undefined,
      { timeout: 10_000 },
    );
    if ((await page.inputValue('#descriptor-text')) !== descriptorBefore) {
      fail('the textarea changed for a non UTF-8 descriptor file');
    } else {
      log('utf-8 check: the invalid descriptor file was refused');
    }
    await page.fill('#descriptor-text', DESCRIPTOR);

    // 3. the preview table must list every track
    await page.waitForFunction(
      () => document.querySelectorAll('#plan-body tr').length === 3,
      undefined,
      { timeout: 10_000 },
    );
    const firstRow = await page.locator('#plan-body tr').first().innerText();
    log(`preview row: ${firstRow.replace(/\n/g, ' | ')}`);
    if (!firstRow.includes('01_Voices of Spring')) {
      fail('the preview table does not show the new file name');
    }

    // 4. run the job
    await page.click('#run-button');
    await page.waitForSelector('body.state-done', { timeout: 120_000 });
    const status = await page.locator('#status').innerText();
    log(`status: ${status}`);
    if (!/done/i.test(status)) fail(`unexpected status: ${status}`);
    if (!(await page.isDisabled('#cancel-button'))) {
      fail('the cancel button must be disabled after the job finished');
    }

    // the result panel shows how many tracks had no matching file
    const resultText = (await page.locator('#results').innerText())
      .toLowerCase()
      .replace(/\s+/g, ' ');
    if (!resultText.includes('skipped (no matching file) 0')) {
      fail(`the result panel does not show the skipped tracks: ${resultText}`);
    }

    // 5. download the zip
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.click('#download-button');
    const download = await downloadPromise;
    const zipPath = path.join(outputDir, 'playlist.zip');
    await download.saveAs(zipPath);
    log(`downloaded: ${download.suggestedFilename()} -> ${zipPath}`);

    // 6. the archive must contain the playlists and the tagged mp3 files
    const listing = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
    log(listing.stdout);
    if (!listing.stdout.includes('E2E Playlist.m3u')) fail('the .m3u file is missing in the archive');
    if (!listing.stdout.includes('E2E Playlist.m3u8')) fail('the .m3u8 file is missing in the archive');
    if (!listing.stdout.includes('01_Voices of Spring')) fail('the tagged mp3 files are missing');
    if (listing.stdout.includes('04-Sub')) fail('a file from a sub folder must not be processed');

    // 6. the playlist content
    const m3u = spawnSync('unzip', ['-p', zipPath, 'E2E Playlist.m3u'], { encoding: 'utf8' });
    writeFileSync(path.join(outputDir, 'playlist.m3u'), m3u.stdout);
    log(`playlist:\n${m3u.stdout}`);

    // the file in the sub folder has to be reported as ignored
    const warnings = await page.locator('#warnings').innerText();
    if (!warnings.includes('sub')) {
      fail(`the ignored sub folder file is not reported: ${warnings}`);
    } else {
      log(`warnings: ${warnings.replace(/\n/g, ' | ')}`);
    }

    // 8. drag & drop of a file has to work as well (Firefox path)
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(512)], '05-Dropped.mp3', { type: 'audio/mpeg' }));
      const zone = document.getElementById('drop-zone');
      zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
    });
    await page.waitForFunction(
      () => document.getElementById('warnings')?.textContent?.includes('05-Dropped.mp3'),
      undefined,
      { timeout: 10_000 },
    );
    log('drag & drop: the dropped file was picked up');

    // 9. the spotify endpoints have to be reachable from the browser (CORS)
    //    (checked before the api is mocked below)
    const spotify = await page.evaluate(async () => {
      try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials&client_id=invalid&client_secret=invalid',
        });
        const body = await response.json();
        return { ok: true, status: response.status, body };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });
    if (spotify.ok) {
      log(`spotify token endpoint reachable from the browser (status ${spotify.status}, ${JSON.stringify(spotify.body)})`);
      if (spotify.status !== 400 || spotify.body?.error !== 'invalid_client') {
        log(`WARNING: unexpected answer from the spotify token endpoint: ${JSON.stringify(spotify.body)}`);
      }
    } else {
      // the reachability probe is only a warning: CI must not depend on
      // accounts.spotify.com. The mocked cover art flow below is the hard check.
      log(`WARNING: the spotify token endpoint is not reachable from the browser: ${spotify.error}`);
    }

    // 10. the spotify flow with a mocked api: the cover has to be embedded
    const coverBytes = readFileSync(path.join(workDir, 'cover.jpg'));
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    };
    await page.route('https://accounts.spotify.com/api/token', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 3600 }),
      });
    });
    await page.route('https://api.spotify.com/v1/search*', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          tracks: {
            items: [
              {
                id: 'fake-id',
                name: 'Voices of Spring',
                artists: [{ name: 'André Rieu' }],
                album: {
                  name: 'Fake Album',
                  images: [{ url: 'https://i.scdn.co/fake-cover.jpg', height: 640, width: 640 }],
                },
              },
            ],
          },
        }),
      });
    });
    await page.route('https://i.scdn.co/fake-cover.jpg', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'image/jpeg' },
        body: coverBytes,
      });
    });

    await page.check('#spotify-enabled');
    await page.fill('#spotify-client-id', 'fake-id');
    await page.fill('#spotify-client-secret', 'fake-secret');
    await page.setInputFiles('#music-input', fixtureDir);
    await page.fill('#descriptor-text', DESCRIPTOR);
    await page.fill('#playlist-name', 'E2E Cover');
    await page.click('#run-button');
    await page.waitForSelector('body.state-done', { timeout: 120_000 });
    const coverStatus = await page.locator('#status').innerText();
    log(`spotify status: ${coverStatus}`);
    if (!coverStatus.includes('3 covers found')) {
      fail(`the cover art was not found: ${coverStatus}`);
    }

    const coverDownload = page.waitForEvent('download', { timeout: 60_000 });
    await page.click('#download-button');
    const coverZip = await coverDownload;
    const coverZipPath = path.join(outputDir, 'cover.zip');
    await coverZip.saveAs(coverZipPath);
    log(`downloaded: ${coverZip.suggestedFilename()} -> ${coverZipPath}`);

    // 11. a broken descriptor file must be refused (all issues stay visible)
    await page.setInputFiles('#music-input', fixtureDir);
    await page.fill('#descriptor-text', '01_Song, Artist -- Dance');
    await page.click('#run-button');
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.includes('descriptor file has problems'),
      undefined,
      { timeout: 10_000 },
    );
    if (!(await page.locator('#issues').innerText()).includes('Found comma (,)')) {
      fail('the descriptor issues are not shown');
    }
    if (!(await page.isDisabled('#download-button'))) {
      fail('a broken descriptor file must not enable the download button');
    }
    log('descriptor check: a broken descriptor file was refused');

    // 12. a run without any matching file is an error, not a success
    await page.setInputFiles('#music-input', mismatchDir);
    await page.fill('#descriptor-text', DESCRIPTOR);
    await page.click('#run-button');
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.includes('No file could be processed'),
      undefined,
      { timeout: 10_000 },
    );
    if (!(await page.isDisabled('#download-button'))) {
      fail('a run without any processed track must not enable the download button');
    }
    log('empty run: reported as an error');

    // 13. warnings of a single track name the track they belong to
    await page.setInputFiles('#music-input', brokenAudioDir);
    await page.fill('#descriptor-text', '01_Waltz; Artist -- Dance');
    await page.click('#run-button');
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.includes('1 tracks processed'),
      undefined,
      { timeout: 10_000 },
    );
    const trackWarnings = await page.locator('#warnings').innerText();
    if (!trackWarnings.includes('01_Waltz; Artist -- Dance: The duration of the file could not be determined.')) {
      fail(`the per track warning is missing: ${trackWarnings}`);
    }
    log('warnings check: the per track warning names the track');

    if (consoleErrors.length > 0) {
      fail(`the browser reported errors:\n${consoleErrors.join('\n')}`);
    } else {
      log('no console errors');
    }
  } catch (error) {
    fail(`exception: ${error.message}`);
    if (consoleErrors.length > 0) log(`console errors:\n${consoleErrors.join('\n')}`);
  }

  await checkLayout(browser, url);

  await browser.close();
  server.close();

  if (process.exitCode) log('E2E FAILED');
  else log('E2E PASSED');
}

/** Checks the layout on a phone screen and in dark mode. */
async function checkLayout(browser, url) {
  const mobile = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await mobile.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    fail(`the page overflows horizontally on a 360px screen: ${JSON.stringify(overflow)}`);
  } else {
    log(`layout: no horizontal overflow on 360px (${overflow.scrollWidth}px)`);
  }

  const hidden = await page.evaluate(() => {
    const ids = [
      'music-input',
      'descriptor-text',
      'playlist-name',
      'run-button',
      'download-button',
      'status',
      'plan-table',
    ];
    return ids.filter((id) => {
      const element = document.getElementById(id);
      if (!element) return true;
      const style = window.getComputedStyle(element);
      return style.display === 'none' || style.visibility === 'hidden';
    });
  });
  if (hidden.length > 0) {
    fail(`these elements are not visible on a phone screen: ${hidden.join(', ')}`);
  } else {
    log('layout: all important elements are visible on a phone screen');
  }
  await mobile.close();

  const dark = await browser.newContext({ colorScheme: 'dark' });
  const darkPage = await dark.newPage();
  await darkPage.goto(url, { waitUntil: 'networkidle' });
  const colors = await darkPage.evaluate(() => {
    const style = window.getComputedStyle(document.body);
    return { background: style.backgroundColor, color: style.color };
  });
  const [red, green, blue] = (colors.background.match(/\d+/g) ?? ['255', '255', '255']).map(Number);
  if (red + green + blue > 200) {
    fail(`the dark mode does not use a dark background: ${colors.background}`);
  } else {
    log(`dark mode: background ${colors.background}, text ${colors.color}`);
  }
  await dark.close();
}

await main();
