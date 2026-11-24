// Headless Chrome helpers so agents can *see* slides (PNG) and measure overflow.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildRenderPage, buildPresentation } from './build.mjs';
import { buildEmbedDoc, findEmbeds } from './embed.mjs';
import { deckDir, readMeta, readSlide } from './store.mjs';
import { launch, waitFor } from './cdp.mjs';

const CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];

export function findChrome() {
  if (process.env.SLIDES_CHROME) return process.env.SLIDES_CHROME;
  for (const c of CANDIDATES) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, c);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
  }
  return null;
}

function run(bin, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message += `\n${stderr}`; reject(err); } else resolve(stdout);
    });
  });
}

function baseArgs(profile) {
  return ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--allow-file-access-from-files', '--force-device-scale-factor=1', `--user-data-dir=${profile}`,
    '--virtual-time-budget=4000', ...(process.env.SLIDES_CHROME_NO_SANDBOX ? ['--no-sandbox'] : [])];
}

function requireChrome() {
  const bin = findChrome();
  if (!bin) throw new Error('No Chrome/Chromium found. Set SLIDES_CHROME=/path/to/chrome.');
  return bin;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'html-slides-')); }

/** Screenshot slides to PNG. Returns list of written files. */
export async function renderPngs(d, ids, outDir, { sheet = false, cols = 3 } = {}) {
  const bin = requireChrome();
  const tmp = tmpDir();
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  try {
    if (sheet) {
      const rows = Math.ceil(ids.length / cols);
      const w = 40 + cols * 480 + (cols - 1) * 20;
      const h = 40 + rows * (270 + 6 + 20) + (rows - 1) * 28;
      const page = path.join(tmp, 'sheet.html');
      fs.writeFileSync(page, buildRenderPage(d, ids, { sheet: true, cols }));
      const out = path.resolve(outDir, `${d}-sheet.png`);
      await run(bin, [...baseArgs(path.join(tmp, 'profile')), `--window-size=${w},${h}`, `--screenshot=${out}`, pathToFileURL(page).href]);
      written.push(out);
    } else {
      let i = 0;
      const worker = async () => {
        while (i < ids.length) {
          const it = ids[i++];
          const name = typeof it === 'string' ? it : `${it.id}.step${it.step}`; // { id, step }: a click-build snapshot
          const page = path.join(tmp, `${name}.html`);
          fs.writeFileSync(page, buildRenderPage(d, [it]));
          const out = path.resolve(outDir, `${name}.png`);
          await run(bin, [...baseArgs(path.join(tmp, `profile-${name}`)), '--window-size=1920,1080', `--screenshot=${out}`, pathToFileURL(page).href]);
          written.push(out);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return written;
}

/** Lay out every slide in a real browser and report overflow + word counts per slide. */
export async function measure(d, ids) {
  const bin = requireChrome();
  const tmp = tmpDir();
  try {
    const page = path.join(tmp, 'measure.html');
    fs.writeFileSync(page, buildRenderPage(d, ids));
    const dom = await run(bin, [...baseArgs(path.join(tmp, 'profile')), '--window-size=1920,1080', '--dump-dom', pathToFileURL(page).href]);
    const m = dom.match(/<pre id="__result"[^>]*>([\s\S]*?)<\/pre>/);
    if (!m) throw new Error('Measurement script produced no result');
    return JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Screenshot a live embed to assets/embeds/<name>/poster.png.
 * If a slide uses the embed, it is shot in place (present mode, real size and theme) at `scale`×;
 * otherwise the page is opened on its own at `size` (default 1280x720). Waits for Embed.ready().
 */
export async function capturePoster(d, name, { scale = 2, slide = null, size = '1280x720', timeout = 60000 } = {}) {
  const bin = requireChrome();
  const src = `assets/embeds/${name}/index.html`;
  const dir = path.join(deckDir(d), 'assets', 'embeds', name);
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`No embed "${name}" (expected ${path.join(dir, 'index.html')})`);
  const meta = readMeta(d);
  const idx = meta.slides.findIndex((id) => (!slide || id === slide) && findEmbeds(readSlide(d, id)).some((e) => e.src === src));
  if (slide && idx < 0) throw new Error(`Slide "${slide}" has no <figure class="embed" data-src="${src}">`);
  const tmp = tmpDir();
  const page = await launch(bin, { webgl: true });
  const errors = [];
  try {
    page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description).join(' ')); });
    page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    const settle = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400))))';
    let clip;
    if (idx >= 0) {
      const file = path.join(tmp, 'deck.html');
      fs.writeFileSync(file, buildPresentation(d, { inline: true }));
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: scale, mobile: false });
      await page.send('Page.navigate', { url: `${pathToFileURL(file).href}#${idx + 1}` });
      const sel = JSON.stringify(`.slide.active figure.embed[data-src="${src}"]`);
      await waitFor(page, `document.querySelector(${sel}) && document.querySelector(${sel}).classList.contains('live')`, { timeout, what: `embed "${name}" to call Embed.ready()` });
      await page.evaluate(`document.querySelectorAll('.ctrl, .hud').forEach(e => e.style.display = 'none'); ${settle}`);
      clip = await page.evaluate(`(() => { const r = document.querySelector(${sel}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 }; })()`);
    } else {
      const [w, h] = String(size).split('x').map(Number);
      const file = path.join(tmp, 'embed.html');
      fs.writeFileSync(file, buildEmbedDoc(d, src, { inline: true }));
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false });
      await page.send('Page.navigate', { url: pathToFileURL(file).href });
      await waitFor(page, 'window.EMBED_READY', { timeout, what: `embed "${name}" to call Embed.ready()` });
      await page.evaluate(settle);
      clip = { x: 0, y: 0, width: w, height: h, scale: 1 };
    }
    const shot = await page.send('Page.captureScreenshot', { format: 'png', clip });
    const out = path.join(dir, 'poster.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    return { out, slide: idx >= 0 ? meta.slides[idx] : null, width: Math.round(clip.width * scale), height: Math.round(clip.height * scale), errors };
  } finally {
    await page.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
