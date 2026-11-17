/**
 * Accessibility and usability smoke test.
 *
 * Checks the things that are easy to break and hard to see: accessible names
 * for every control, a visible focus ring, a sensible tab order, a live
 * region for the status and a readable contrast in both colour schemes.
 *
 * Usage: node scripts/a11y.mjs
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(tmpdir(), 'autoditag-a11y');
const appDir = path.join(siteDir, 'repo');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

let failures = 0;

function fail(message) {
  process.stdout.write(`FAIL: ${message}\n`);
  failures += 1;
}

function ok(message) {
  process.stdout.write(`ok: ${message}\n`);
}

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

/** Relative luminance of an "rgb(r, g, b)" string. */
function luminance(color) {
  const parts = (color.match(/[\d.]+/g) ?? []).map(Number);
  const [r, g, b] = parts;
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

async function check(scheme) {
  const context = await firefox.launch();
  const page = await context.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
  await page.goto('http://127.0.0.1:4174/repo/', { waitUntil: 'networkidle' });

  // every control needs an accessible name
  const unnamed = await page.evaluate(() => {
    const problems = [];
    const controls = document.querySelectorAll('input, select, textarea, button');
    for (const control of controls) {
      const id = control.id;
      const hasLabel = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const ariaLabel = control.getAttribute('aria-label');
      const ariaLabelledBy = control.getAttribute('aria-labelledby');
      const wrapped = control.closest('label');
      const text = (control.textContent ?? '').trim();
      if (!hasLabel && !ariaLabel && !ariaLabelledBy && !wrapped && !text) {
        problems.push(id || control.tagName);
      }
    }
    return problems;
  });
  if (unnamed.length > 0) {
    fail(`${scheme}: controls without an accessible name: ${unnamed.join(', ')}`);
  } else {
    ok(`${scheme}: every control has an accessible name`);
  }

  // the status has to be announced
  const status = await page.evaluate(() => {
    const element = document.getElementById('status');
    return {
      live: element?.getAttribute('aria-live') ?? null,
      role: element?.getAttribute('role') ?? null,
    };
  });
  if (!status.live && !status.role) {
    fail(`${scheme}: the status line is not a live region`);
  } else {
    ok(`${scheme}: the status line is a live region (${status.live ?? status.role})`);
  }

  // the focus ring has to be visible
  const outline = await page.evaluate(() => {
    const button = document.getElementById('run-button');
    button.focus();
    const style = window.getComputedStyle(button);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  if (outline.style === 'none' || parseFloat(outline.width) < 1) {
    fail(`${scheme}: the focused button has no visible outline (${JSON.stringify(outline)})`);
  } else {
    ok(`${scheme}: the focus ring is visible (${outline.width} ${outline.style})`);
  }

  // the tab order has to reach the important controls
  const reached = [];
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    reached.push(
      await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || ''),
    );
  }
  for (const id of ['music-input', 'descriptor-input', 'descriptor-text', 'playlist-name', 'run-button']) {
    if (!reached.includes(id)) {
      fail(`${scheme}: the tab order does not reach #${id}`);
    }
  }
  if (!reached.includes('run-button')) {
    fail(`${scheme}: the tab order does not reach the run button`);
  } else {
    ok(`${scheme}: the tab order reaches the form controls`);
  }

  // the contrast of the body text
  const colors = await page.evaluate(() => {
    const body = window.getComputedStyle(document.body);
    const card = document.querySelector('.card');
    const cardStyle = card ? window.getComputedStyle(card) : null;
    return {
      bodyBackground: body.backgroundColor,
      bodyColor: body.color,
      cardBackground: cardStyle?.backgroundColor ?? body.backgroundColor,
      muted: window.getComputedStyle(document.querySelector('.lede') ?? document.body).color,
    };
  });
  const bodyRatio = contrastRatio(colors.bodyColor, colors.bodyBackground);
  if (bodyRatio < 4.5) {
    fail(`${scheme}: the body text contrast is only ${bodyRatio.toFixed(2)}:1`);
  } else {
    ok(`${scheme}: the body text contrast is ${bodyRatio.toFixed(2)}:1`);
  }
  const mutedRatio = contrastRatio(colors.muted, colors.cardBackground);
  if (mutedRatio < 4.5) {
    fail(`${scheme}: the muted text contrast is only ${mutedRatio.toFixed(2)}:1`);
  } else {
    ok(`${scheme}: the muted text contrast is ${mutedRatio.toFixed(2)}:1`);
  }

  // the page must not scroll sideways
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    fail(`${scheme}: the page scrolls sideways (${JSON.stringify(overflow)})`);
  } else {
    ok(`${scheme}: no sideways scrolling`);
  }

  await context.close();
}

async function main() {
  const distDir = path.join(root, 'dist');
  if (!existsSync(distDir)) {
    fail('dist/ is missing - run "npm run build" first');
    process.exit(1);
  }
  mkdirSync(appDir, { recursive: true });
  for (const entry of readdirSync(distDir)) {
    const source = path.join(distDir, entry);
    const target = path.join(appDir, entry);
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const child of readdirSync(source)) {
        const from = path.join(source, child);
        const to = path.join(target, child);
        const { copyFileSync } = await import('node:fs');
        copyFileSync(from, to);
      }
    } else {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(source, target);
    }
  }

  const server = await serve(siteDir, 4174);
  try {
    await check('light');
    await check('dark');
  } finally {
    server.close();
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} accessibility check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write('\nAll accessibility checks passed\n');
}

await main();
