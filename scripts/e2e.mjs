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

function createFixtures() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const tones = [
    { file: '01-Song.mp3', frequency: 440 },
    { file: '02-Song.mp3', frequency: 523 },
    { file: '03-Song.mp3', frequency: 659 },
  ];
  for (const tone of tones) {
    const result = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${tone.frequency}:duration=3`,
        '-c:a', 'libmp3lame', '-b:a', '128k', '-y', path.join(fixtureDir, tone.file)],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      fail(`ffmpeg could not create the test file: ${result.stderr}`);
      return false;
    }
  }

  // a file in a sub folder - like the python tool, it has to be ignored
  mkdirSync(path.join(fixtureDir, 'sub'), { recursive: true });
  const nested = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
      '-c:a', 'libmp3lame', '-b:a', '128k', '-y', path.join(fixtureDir, 'sub', '04-Sub.mp3')],
    { encoding: 'utf8' },
  );
  if (nested.status !== 0) {
    fail(`ffmpeg could not create the nested test file: ${nested.stderr}`);
    return false;
  }
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

    // 1. pick the folder with the mp3 files
    await page.setInputFiles('#music-input', fixtureDir);

    // 2. enter the descriptor file and the playlist name
    await page.fill('#descriptor-text', DESCRIPTOR);
    await page.fill('#playlist-name', 'E2E Playlist');

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

    if (consoleErrors.length > 0) {
      fail(`the browser reported errors:\n${consoleErrors.join('\n')}`);
    } else {
      log('no console errors');
    }

    // 7. the Spotify endpoints have to be reachable from the browser (CORS)
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
        fail(`unexpected answer from the spotify token endpoint: ${JSON.stringify(spotify.body)}`);
      }
    } else {
      fail(`the spotify token endpoint is not reachable from the browser: ${spotify.error}`);
    }
  } catch (error) {
    fail(`exception: ${error.message}`);
    if (consoleErrors.length > 0) log(`console errors:\n${consoleErrors.join('\n')}`);
  } finally {
    await browser.close();
    server.close();
  }

  if (process.exitCode) log('E2E FAILED');
  else log('E2E PASSED');
}

await main();
