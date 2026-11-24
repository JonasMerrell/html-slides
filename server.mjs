#!/usr/bin/env node
// HTML Slides editor server. Zero dependencies.
//   node server.mjs [--port 4173] [--host 127.0.0.1]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as store from './lib/store.mjs';
import { buildPresentation } from './lib/build.mjs';
import { buildEmbedDoc } from './lib/embed.mjs';

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal('--port', process.env.PORT || 4173));
const HOST = argVal('--host', process.env.HOST || '127.0.0.1');
const PUBLIC = path.join(store.ROOT, 'public');
store.setWriter('editor'); // slide history: saves through this server come from the editor

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf' };

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}
const json = (res, body, status = 200) => send(res, status, body);

// Deck files are also read by embed iframes, which are sandboxed (opaque origin): their fetch() of
// data files and the theme's @font-face fonts need CORS. The server only listens on localhost by default.
function serveFile(res, file, root, { cors = false } = {}) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', 'content-length': st.size,
      ...(cors ? { 'access-control-allow-origin': '*' } : {}) });
    fs.createReadStream(resolved).pipe(res);
  });
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new store.UserError('Body too large', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new store.UserError('Invalid JSON body'); }
}

// ------------------------------------------------------------ change feed (SSE)
// Polling is used instead of fs.watch: it behaves the same on NFS, macOS and Linux,
// and catches edits made by agents, editors, git checkouts, anything.
const clients = new Set();
let snapshot = new Map();
// Asynchronous and never overlapping: on a slow network filesystem one scan can take seconds,
// and a synchronous scan on a timer would then block every request (thumbnails stay black, saves hang).
const FS_JOBS = 4; // stat() calls in flight at once; leaves libuv threads free for requests
async function scan() {
  const fsp = fs.promises, next = new Map(), paths = [];
  let decks = [];
  try { decks = (await fsp.readdir(store.DECKS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()); } catch {}
  await Promise.all(decks.map(async (e) => {
    const dir = path.join(store.DECKS_DIR, e.name);
    const ls = async (sub) => { try { return (await fsp.readdir(path.join(dir, sub))).filter((f) => !f.startsWith('.')); } catch { return []; } };
    const [slides, assets] = await Promise.all([ls('slides'), ls('assets')]);
    for (const f of ['deck.json', 'theme.css', 'comments.json', ...slides.filter((f) => f.endsWith('.html')).map((f) => 'slides/' + f), ...assets.map((f) => 'assets/' + f)]) paths.push([e.name, f]);
  }));
  let i = 0;
  await Promise.all(Array.from({ length: FS_JOBS }, async () => {
    while (i < paths.length) {
      const [deck, f] = paths[i++];
      try { const st = await fsp.stat(path.join(store.DECKS_DIR, deck, f)); next.set(`${deck}/${f}`, `${st.mtimeMs}:${st.size}`); } catch {}
    }
  }));
  return next;
}
async function poll() {
  const next = await scan();
  const changed = new Map();
  const mark = (key) => {
    const [deck, ...rest] = key.split('/');
    if (!changed.has(deck)) changed.set(deck, []);
    changed.get(deck).push(rest.join('/'));
  };
  for (const [k, v] of next) if (snapshot.get(k) !== v) mark(k);
  for (const k of snapshot.keys()) if (!next.has(k)) mark(k);
  snapshot = next;
  for (const [deck, files] of changed) {
    broadcast({ deck, files });
    // a slide file changed on disk: keep it in the slide's history (no-op when the store already recorded it)
    for (const f of files) {
      const m = f.match(/^slides\/(.+)\.html$/);
      if (m && store.NAME_RE.test(m[1]) && next.has(`${deck}/${f}`)) queueHistory(deck, m[1]);
    }
  }
}
// history writes run one at a time, after the response/broadcast, so the poller and requests never wait on them
let historyChain = Promise.resolve();
const queueHistory = (deck, id, opts) => { historyChain = historyChain.then(() => store.recordFromDisk(deck, id, opts)).catch(() => {}); };
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}
// next scan starts 700 ms after the previous one finished
(async function loop() {
  snapshot = await scan();
  for (;;) {
    await new Promise((r) => setTimeout(r, 700).unref());
    try { await poll(); } catch (e) { console.error('scan failed:', e.message); }
  }
})();
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
};

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// where the files live, so the editor's "Agent" prompts can give a new agent absolute paths
route('GET', '/api/info', (req, res) => json(res, { root: store.ROOT, decksDir: store.DECKS_DIR, url: `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`, host: os.hostname() }));
route('GET', '/api/decks', (req, res) => json(res, store.listDecks()));
route('POST', '/api/decks', async (req, res) => {
  const b = await readJson(req);
  const name = b.name ? String(b.name) : store.slugify(b.title, 'deck');
  store.createDeck(name, { title: b.title, theme: b.theme || 'clean' });
  json(res, { name }, 201);
});
route('GET', '/api/decks/:d', (req, res, p) => {
  const deck = store.readDeck(p.d);
  json(res, deck);
  for (const s of deck.slides) queueHistory(p.d, s.id, { onlyIfNone: true }); // first copy of each slide, so the first change can be undone
});
route('PUT', '/api/decks/:d', async (req, res, p) => json(res, store.updateDeck(p.d, await readJson(req))));

route('POST', '/api/decks/:d/slides', async (req, res, p) => {
  const b = await readJson(req);
  json(res, { id: store.addSlide(p.d, b) }, 201);
});
route('GET', '/api/decks/:d/slides/:id', (req, res, p) => json(res, { id: p.id, html: store.readSlide(p.d, p.id) }));
route('PUT', '/api/decks/:d/slides/:id', async (req, res, p) => {
  const b = await readJson(req);
  if (typeof b.html !== 'string') throw new store.UserError('html (string) is required');
  store.writeSlide(p.d, p.id, b.html);
  json(res, { ok: true });
});
route('GET', '/api/decks/:d/slides/:id/history', (req, res, p) => json(res, store.listVersions(p.d, p.id)));
route('GET', '/api/decks/:d/slides/:id/history/:v', (req, res, p) => json(res, { id: p.v, html: store.readVersion(p.d, p.id, p.v) }));
route('POST', '/api/decks/:d/slides/:id/history/:v/restore', (req, res, p) => {
  const v = store.restoreVersion(p.d, p.id, p.v);
  json(res, { restored: v, html: store.readSlide(p.d, p.id) });
});
route('DELETE', '/api/decks/:d/slides/:id', (req, res, p) => { store.deleteSlide(p.d, p.id); json(res, { ok: true }); });
route('POST', '/api/decks/:d/slides/:id/duplicate', (req, res, p) => json(res, { id: store.duplicateSlide(p.d, p.id) }, 201));
route('POST', '/api/decks/:d/slides/:id/rename', async (req, res, p) => {
  const b = await readJson(req);
  store.renameSlide(p.d, p.id, String(b.id || ''));
  json(res, { id: b.id });
});

route('PUT', '/api/decks/:d/chapters', async (req, res, p) => { const b = await readJson(req); json(res, { changed: store.setChapters(p.d, b.labels, b.map) }); });
route('GET', '/api/decks/:d/theme', (req, res, p) => json(res, { css: store.readThemeCss(p.d) }));
route('PUT', '/api/decks/:d/theme', async (req, res, p) => { store.writeThemeCss(p.d, (await readJson(req)).css ?? ''); json(res, { ok: true }); });

route('POST', '/api/decks/:d/assets', async (req, res, p, url) => {
  const buf = await readBody(req);
  if (!buf.length) throw new store.UserError('Empty upload');
  json(res, { path: store.saveAsset(p.d, url.searchParams.get('name') || 'upload.png', buf) }, 201);
});

// Insert an image from a URL (dragged or pasted links the browser itself can't read because of CORS).
route('POST', '/api/decks/:d/assets/fetch', async (req, res, p) => {
  const { url } = await readJson(req);
  if (!/^https?:\/\//i.test(String(url || ''))) throw new store.UserError('Only http(s) image links can be fetched');
  let r;
  try { r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new store.UserError(`Could not download the image (${e.cause?.code || e.message})`, 502); }
  const type = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!r.ok) throw new store.UserError(`Could not download the image (HTTP ${r.status})`, 502);
  if (!type.startsWith('image/')) throw new store.UserError(`That link is not an image (${type || 'unknown type'})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 50 * 1024 * 1024) throw new store.UserError('Image is larger than 50 MB', 413);
  const ext = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' }[type] || type.split('/')[1];
  let name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'image';
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + ext;
  json(res, { path: store.saveAsset(p.d, name, buf) }, 201);
});

// What the browser delivered on paste/drop (debugging embedded browsers): POST from the editor, GET to read.
const DIAG = [];
route('POST', '/api/diag', async (req, res) => { DIAG.push({ at: new Date().toISOString(), ua: req.headers['user-agent'], ...(await readJson(req)) }); if (DIAG.length > 50) DIAG.shift(); json(res, { ok: true }); });
route('GET', '/api/diag', (req, res) => json(res, DIAG));

route('GET', '/api/decks/:d/comments', (req, res, p) => json(res, store.readComments(p.d)));
route('POST', '/api/decks/:d/comments', async (req, res, p) => json(res, store.addComment(p.d, await readJson(req)), 201));
route('PUT', '/api/decks/:d/comments/:cid', async (req, res, p) => json(res, store.updateComment(p.d, p.cid, await readJson(req))));
route('DELETE', '/api/decks/:d/comments/:cid', (req, res, p) => { store.deleteComment(p.d, p.cid); json(res, { ok: true }); });

route('POST', '/api/decks/:d/status', async (req, res, p) => json(res, store.writeStatus(p.d, await readJson(req))));

route('GET', '/api/decks/:d/targets', (req, res, p) => json(res, store.readTargets(p.d)));
route('PUT', '/api/decks/:d/targets', async (req, res, p) => { const b = await readJson(req); json(res, { talkMinutes: store.setTalkMinutes(p.d, b.talkMinutes) }); });
route('GET', '/api/decks/:d/rehearsals', (req, res, p) => json(res, store.readRehearsals(p.d)));
route('POST', '/api/decks/:d/rehearsals', async (req, res, p) => json(res, store.addRehearsal(p.d, await readJson(req)), 201));
route('GET', '/api/themes', (req, res) => json(res, store.listThemes()));
route('GET', '/api/layouts', (req, res, p, url) => json(res, store.listLayouts(url.searchParams.get('theme') || null)));
route('POST', '/api/layouts', async (req, res) => {
  const b = await readJson(req);
  json(res, { name: store.saveLayout(store.slugify(b.name, 'layout'), b.html, b.description, b.theme || null) }, 201);
});

route('GET', '/present/:d', (req, res, p) => send(res, 200, buildPresentation(p.d, { inline: false, base: `/decks/${p.d}/`, liveReload: true }), MIME['.html']));
route('GET', '/export/:d', (req, res, p) => {
  const html = buildPresentation(p.d, { inline: true });
  res.writeHead(200, { 'content-type': MIME['.html'], 'content-disposition': `attachment; filename="${p.d}.html"` });
  res.end(html);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Bad URL' }); }
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      return await r.fn(req, res, params, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 404, { error: 'Not found' });
    if (pathname === '/core/slides.css') return serveFile(res, store.CORE_CSS, path.join(store.ROOT, 'core'));
    // live embed page: /embed/<deck>/assets/embeds/<name>/index.html, runtime injected, files from /decks/<deck>/…
    const em = pathname.match(/^\/embed\/([^/]+)\/(assets\/embeds\/.+\.html)$/);
    if (em) {
      const html = buildEmbedDoc(em[1], em[2], { inline: false, base: `/decks/${em[1]}/${path.posix.dirname(em[2])}/` });
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(html);
    }
    const dm = pathname.match(/^\/decks\/([^/]+)\/(.+)$/);
    if (dm) return serveFile(res, path.join(store.deckDir(dm[1]), dm[2]), store.deckDir(dm[1]), { cors: true });
    if (pathname.startsWith('/templates/')) return serveFile(res, path.join(store.ROOT, pathname), store.TEMPLATES_DIR);
    if (pathname === '/' || !path.extname(pathname)) return serveFile(res, path.join(PUBLIC, 'index.html'), PUBLIC);
    return serveFile(res, path.join(PUBLIC, pathname), PUBLIC);
  } catch (e) {
    const status = e instanceof store.UserError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HTML Slides editor → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Decks directory    → ${store.DECKS_DIR}`);
});
