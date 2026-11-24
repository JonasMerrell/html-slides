// Tiny Chrome DevTools Protocol client (no dependencies; Node >= 22 for the global WebSocket).
// Used where the one-shot `--screenshot` flag is not enough: waiting for a live embed to say
// it is ready before taking its poster.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Flags that give headless Chrome a working WebGL (SwiftShader) on GPU-less nodes. */
export const WEBGL_FLAGS = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(bin, { webgl = false, timeout = 30000 } = {}) {
  if (typeof WebSocket !== 'function') throw new Error('Needs Node 22+ (global WebSocket).');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'html-slides-cdp-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--allow-file-access-from-files', '--mute-audio',
    ...(webgl ? WEBGL_FLAGS : ['--disable-gpu', ...(process.env.SLIDES_CHROME_NO_SANDBOX ? ['--no-sandbox'] : [])]), 'about:blank'];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const t0 = Date.now();
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, 'utf8').includes('\n')) {
    if (proc.exitCode != null || Date.now() - t0 > timeout) { proc.kill(); throw new Error(`Chrome did not start\n${stderr}`); }
    await sleep(100);
  }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  let target;
  while (!target) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
    if (!target) { if (Date.now() - t0 > timeout) throw new Error('No page target'); await sleep(100); }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools websocket failed')); });
  let id = 0;
  const pending = new Map(), listeners = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(`${d.error.message}`)) : p.res(d.result); }
    else if (d.method) for (const cb of listeners.get(d.method) || []) cb(d.params);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const on = (method, cb) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(cb); };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const close = async () => {
    try { ws.close(); } catch {}
    proc.kill();
    await new Promise((r) => (proc.exitCode != null ? r() : proc.once('exit', r)));
    // Chrome's helper processes can still be writing to the profile for a moment; cleanup never fails the job
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  };
  return { send, on, evaluate, close };
}

/** Poll an expression in the page until it is truthy. */
export async function waitFor(page, expression, { timeout = 30000, what = expression } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(`!!(${expression})`)) return;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out after ${timeout / 1000}s waiting for ${what}`);
    await sleep(150);
  }
}
