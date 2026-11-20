// Interactive embeds: <figure class="embed" data-src="assets/embeds/<name>/index.html"
// data-poster="assets/embeds/<name>/poster.png"><img src="…poster.png"></figure>
//
// The figure's children are its static view (the poster). The editor, `render` and `check`
// only ever see that. Present mode and export swap in a sandboxed iframe running the embed
// page while its slide is active. This module builds that page (with the runtime from
// core/embed-runtime.js injected) and checks embed markup.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, deckDir, UserError } from './store.mjs';

export const EMBED_RUNTIME = path.join(ROOT, 'core', 'embed-runtime.js');
export const EMBED_TEMPLATE = path.join(ROOT, 'templates', 'embed');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const TEXT = /\.(json|csv|tsv|txt|svg|xml|glsl|vert|frag|obj|gltf|js|mjs|css|html)$/i;
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u);
/** Keep inlined text from closing the surrounding <script>/<style> early. */
const scriptSafe = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

/** <figure class="embed"> elements in slide HTML (attributes only; regex, no DOM needed). */
export function findEmbeds(html) {
  const out = [];
  for (const m of String(html).matchAll(/<figure\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bclass\s*=\s*"[^"]*\bembed\b[^"]*"/i.test(tag)) continue;
    const attr = (n) => { const a = tag.match(new RegExp(`(?:^|\\s)${n}\\s*=\\s*"([^"]*)"`, 'i')); return a ? a[1] : null; };
    // the static view: first <img> inside this figure
    const after = html.slice(m.index + tag.length);
    const end = after.search(/<\/figure>/i);
    const img = (end >= 0 ? after.slice(0, end) : after).match(/<img\b[^>]*\bsrc\s*=\s*"([^"]*)"/i);
    out.push({ id: attr('data-id'), src: attr('data-src'), poster: attr('data-poster'), img: img ? img[1] : null });
  }
  return out;
}

/** Absolute path of an embed file, guaranteed to be inside decks/<d>/assets/embeds/. */
export function embedPath(d, rel) {
  const dir = deckDir(d);
  const clean = decodeURIComponent(String(rel || '').split(/[?#]/)[0]).replace(/^\.?\//, '');
  const p = path.resolve(dir, clean);
  if (!p.startsWith(path.join(dir, 'assets', 'embeds') + path.sep)) throw new UserError(`Embed files must live under assets/embeds/: ${rel}`);
  return p;
}

/** Embed folder name from its data-src ("assets/embeds/<name>/index.html" -> "<name>"). */
export const embedName = (src) => (String(src || '').match(/assets\/embeds\/([^/]+)\//) || [])[1] || null;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}

function injectHead(html, pre) {
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${pre}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>\n${pre}</head>`);
  return pre + html;
}

/**
 * The embed page as one HTML string, with the runtime injected.
 *  inline: true   (export, posters) scripts, stylesheets, images and fonts are inlined; every other
 *                 file in the folder goes into window.EMBED_DATA, which the runtime serves to fetch().
 *  base:   "/…/"  (live serving) adds <base href> so the page loads its files from the server.
 */
export function buildEmbedDoc(d, src, { inline = true, base = null } = {}) {
  const file = embedPath(d, src);
  if (!fs.existsSync(file)) throw new UserError(`Embed page not found: ${src}`, 404);
  const dir = path.dirname(file);
  let html = fs.readFileSync(file, 'utf8');
  let pre = '';
  if (inline) {
    const used = new Set([file]);
    const local = (rel, from = dir) => {
      if (!rel || isExternal(rel) || rel.startsWith('#') || rel.startsWith('data:')) return null;
      const p = path.resolve(from, decodeURIComponent(rel.split(/[?#]/)[0]));
      if (!p.startsWith(dir + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
      used.add(p);
      return p;
    };
    const dataUri = (p) => `data:${mimeOf(p)};base64,${fs.readFileSync(p).toString('base64')}`;
    const cssUrls = (css, from) => css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (m, q, u) => { const p = local(u, from); return p ? `url("${dataUri(p)}")` : m; });
    // media elements first, so inlined script text is never rewritten
    html = html.replace(/<(img|video|audio|source|track|image|input)\b[^>]*>/gi, (tag) =>
      tag.replace(/(\s(?:src|poster|href|xlink:href)\s*=\s*["'])([^"']+)(["'])/gi, (m, a, u, b) => { const p = local(u); return p ? a + dataUri(p) + b : m; }));
    html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, b) => a + scriptSafe(cssUrls(css, dir)) + b);
    html = html.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      const p = local((tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1]);
      return p ? `<style>${scriptSafe(cssUrls(fs.readFileSync(p, 'utf8'), path.dirname(p)))}</style>` : tag;
    });
    html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (m, a, u, b) => {
      const p = local(u);
      if (!p) return m;
      const attrs = `${a} ${b}`.replace(/\b(defer|async)\b/gi, '').replace(/\s+/g, ' ').trim();
      return `<script${attrs ? ' ' + attrs : ''}>${scriptSafe(fs.readFileSync(p, 'utf8'))}</script>`;
    });
    const data = {};
    for (const p of walk(dir)) {
      if (used.has(p)) continue;
      const r = path.relative(dir, p).split(path.sep).join('/');
      if (/^poster\.[a-z0-9]+$/i.test(r) || /(^|\/)(readme|license|licence|notice)[^/]*$/i.test(r) || /\.md$/i.test(r)) continue;
      data[r] = TEXT.test(r)
        ? { t: 'text', type: mimeOf(p), v: fs.readFileSync(p, 'utf8') }
        : { t: 'b64', type: mimeOf(p), v: fs.readFileSync(p).toString('base64') };
    }
    if (Object.keys(data).length) pre += `<script>window.EMBED_DATA=${scriptSafe(JSON.stringify(data))};</script>\n`;
  } else if (base) {
    pre += `<base href="${base.replace(/"/g, '&quot;')}">\n`;
  }
  pre += `<script>${scriptSafe(fs.readFileSync(EMBED_RUNTIME, 'utf8'))}</script>\n`;
  return injectHead(html, pre);
}

/**
 * Problems with the embeds on one slide, as [level, message] pairs ('error' | 'warn').
 * Used by `slides check`.
 */
export function embedIssues(d, html) {
  const issues = [];
  const dir = deckDir(d);
  const exists = (rel) => { try { return fs.existsSync(embedPath(d, rel)); } catch { return false; } };
  for (const e of findEmbeds(html)) {
    const who = e.id ? `embed #${e.id}` : 'embed';
    if (!e.src) { issues.push(['error', `${who}: missing data-src`]); continue; }
    if (!e.poster) issues.push(['error', `${who}: missing data-poster`]);
    let srcOk = false;
    try { embedPath(d, e.src); srcOk = exists(e.src); } catch (err) { issues.push(['error', `${who}: ${err.message}`]); continue; }
    if (!srcOk) issues.push(['error', `${who}: data-src file not found: ${e.src}`]);
    if (e.poster && !fs.existsSync(path.join(dir, decodeURIComponent(e.poster)))) issues.push(['error', `${who}: poster not found: ${e.poster} (make one with "slides poster ${d} ${embedName(e.src) || '<name>'}")`]);
    if (!e.img) issues.push(['warn', `${who}: no <img> inside the figure, so nothing shows while editing; put <img src="${e.poster || 'poster.png'}"> in it`]);
    else if (e.poster && e.img !== e.poster) issues.push(['warn', `${who}: the <img> shows ${e.img} but data-poster is ${e.poster}`]);
    if (srcOk) {
      const page = fs.readFileSync(embedPath(d, e.src), 'utf8');
      for (const m of page.matchAll(/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)) {
        issues.push(['warn', `${who}: loads ${m[1]} from the network; copy it into the embed folder so it works offline`]);
      }
      if (/<script\b[^>]*\b(defer|async)\b/i.test(page)) issues.push(['warn', `${who}: defer/async scripts run immediately once inlined for export; put scripts at the end of <body> instead`]);
      if (!/Embed\.ready\s*\(/.test(page) && !fs.readdirSync(path.dirname(embedPath(d, e.src))).some((f) => f.endsWith('.js') && /Embed\.ready\s*\(/.test(fs.readFileSync(path.join(path.dirname(embedPath(d, e.src)), f), 'utf8')))) {
        issues.push(['warn', `${who}: never calls Embed.ready(), so present mode waits 10 s before showing it`]);
      }
    }
  }
  return issues;
}
