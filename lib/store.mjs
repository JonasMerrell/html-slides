// File-backed deck store. The filesystem is the single source of truth:
// the web editor, the CLI and agents editing files directly all meet here.
//
// decks/<deck>/
//   deck.json        { title, theme, slides: [slideId, ...] }   (order)
//   theme.css        deck-local copy of a theme (edit freely)
//   slides/<id>.html one <section class="slide"> per file
//   assets/          images etc. referenced as "assets/<file>"
//   comments.json    notes between human and agent
//   .status.json     render diagnostics (overflow) written by editor / CLI
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DECKS_DIR = path.resolve(process.env.SLIDES_DECKS_DIR || path.join(ROOT, 'decks'));
export const TEMPLATES_DIR = path.join(ROOT, 'templates');
export const CORE_CSS = path.join(ROOT, 'core', 'slides.css');

export class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function slugify(s, fallback = 'slide') {
  const out = String(s ?? '').toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s_-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    .replace(/-$/, '');
  return out || fallback;
}

function check(name, what) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new UserError(`Invalid ${what} "${name}" (use lowercase letters, digits, "-" or "_")`);
  }
  return name;
}

export const deckDir = (d) => path.join(DECKS_DIR, check(d, 'deck name'));
export const slidePath = (d, id) => path.join(deckDir(d), 'slides', check(id, 'slide id') + '.html');

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new UserError(`Could not parse ${p}: ${e.message}`, 500); }
}

export function writeFileAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}
const writeJSON = (p, o) => writeFileAtomic(p, JSON.stringify(o, null, 2) + '\n');

export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- decks

export function deckExists(d) { return fs.existsSync(path.join(deckDir(d), 'deck.json')); }
function requireDeck(d) { if (!deckExists(d)) throw new UserError(`No deck named "${d}"`, 404); }

function slideFiles(d) {
  try {
    return fs.readdirSync(path.join(deckDir(d), 'slides'))
      .filter((f) => f.endsWith('.html') && NAME_RE.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5));
  } catch { return []; }
}

/** deck.json, with `slides` reconciled against files on disk (agents may add/remove files directly). */
export function readMeta(d) {
  requireDeck(d);
  const meta = readJSON(path.join(deckDir(d), 'deck.json'), {});
  const files = new Set(slideFiles(d));
  const order = [];
  for (const id of Array.isArray(meta.slides) ? meta.slides : []) {
    if (files.has(id) && !order.includes(id)) order.push(id);
  }
  for (const id of [...files].sort()) if (!order.includes(id)) order.push(id);
  meta.slides = order;
  meta.title ??= d;
  meta.theme ??= 'clean';
  return meta;
}

export function writeMeta(d, meta) {
  const { title, theme, slides, ...rest } = meta;
  writeJSON(path.join(deckDir(d), 'deck.json'), { title, theme, ...rest, slides });
}

function latestMtime(d) {
  let t = 0;
  const visit = (p) => { try { t = Math.max(t, fs.statSync(p).mtimeMs); } catch {} };
  visit(path.join(deckDir(d), 'deck.json'));
  visit(path.join(deckDir(d), 'theme.css'));
  for (const id of slideFiles(d)) visit(slidePath(d, id));
  return t;
}

export function listDecks() {
  if (!fs.existsSync(DECKS_DIR)) return [];
  return fs.readdirSync(DECKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && NAME_RE.test(e.name) && fs.existsSync(path.join(DECKS_DIR, e.name, 'deck.json')))
    .map((e) => {
      const m = readMeta(e.name);
      const first = m.slides[0];
      return {
        name: e.name, title: m.title, theme: m.theme, slideCount: m.slides.length,
        firstHtml: first ? readSlide(e.name, first) : '',
        updated: latestMtime(e.name),
        openComments: readComments(e.name).filter((c) => c.status !== 'resolved').length,
      };
    })
    .sort((a, b) => b.updated - a.updated);
}

export function readDeck(d) {
  const meta = readMeta(d);
  return {
    name: d,
    ...meta,
    slides: meta.slides.map((id) => ({ id, html: readSlide(d, id) })),
    comments: readComments(d),
    status: readStatus(d),
  };
}

export function createDeck(d, { title, theme = 'clean' } = {}) {
  check(d, 'deck name');
  if (deckExists(d)) throw new UserError(`Deck "${d}" already exists`, 409);
  const dir = deckDir(d);
  fs.mkdirSync(path.join(dir, 'slides'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(TEMPLATES_DIR, 'placeholder.svg'), path.join(dir, 'assets', 'placeholder.svg'));
  fs.copyFileSync(themePath(theme), path.join(dir, 'theme.css'));
  copyThemeAssets(d, theme);
  writeMeta(d, { title: title || d, theme, created: new Date().toISOString(), slides: [] });
  addSlide(d, { layout: 'title', id: 'title', title: title || d });
  return readMeta(d);
}

export function updateDeck(d, { title, theme, slides } = {}) {
  const meta = readMeta(d);
  if (title !== undefined) meta.title = String(title);
  if (theme !== undefined && theme !== meta.theme) {
    fs.copyFileSync(themePath(theme), path.join(deckDir(d), 'theme.css'));
    copyThemeAssets(d, theme);
    meta.theme = theme;
  }
  if (slides !== undefined) {
    if (!Array.isArray(slides)) throw new UserError('slides must be an array of slide ids');
    const cur = new Set(meta.slides);
    const next = slides.filter((id, i) => cur.has(id) && slides.indexOf(id) === i);
    for (const id of meta.slides) if (!next.includes(id)) next.push(id);
    meta.slides = next;
  }
  writeMeta(d, meta);
  return meta;
}

export function readThemeCss(d) {
  requireDeck(d);
  try { return fs.readFileSync(path.join(deckDir(d), 'theme.css'), 'utf8'); } catch { return ''; }
}
export function writeThemeCss(d, css) {
  requireDeck(d);
  writeFileAtomic(path.join(deckDir(d), 'theme.css'), String(css));
}

// ---------------------------------------------------------------- slides

export function readSlide(d, id) {
  try { return fs.readFileSync(slidePath(d, id), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') throw new UserError(`No slide "${id}" in deck "${d}"`, 404); throw e; }
}

/** Make sure html is a single <section class="slide">; wrap loose markup. */
export function normalizeSlide(html) {
  const s = String(html ?? '').trim();
  if (/^<section\b[^>]*\bclass\s*=\s*["'][^"']*\bslide\b/i.test(s)) return s + '\n';
  return `<section class="slide layout-blank" data-layout="custom">\n${s}\n</section>\n`;
}

// ---------- section timeline (<nav class="toc">): one per deck, kept identical on every slide that has one
const TOC_RE = /<nav\b[^>]*\bclass\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>[\s\S]*?<\/nav>/i;
const SECTION_TAG_RE = /^\s*<section\b[^>]*>/i;
export const tocOf = (html) => (String(html ?? '').match(TOC_RE) || [])[0] || null;
const normToc = (t) => t && t.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
/** The labels of a timeline, in order. */
export const tocLabels = (toc) => [...String(toc ?? '').replace(/^<nav\b[^>]*>|<\/nav>$/gi, '')
  .matchAll(/<(\w+)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
export const sectionOf = (html) => (String(html ?? '').match(SECTION_TAG_RE)?.[0].match(/\bdata-section\s*=\s*["']([^"']*)["']/i) || [])[1];

/**
 * Copy the timeline of slide `from` to every other slide of the deck that has one.
 * With `labels`, first rewrite `from`'s timeline to those labels. Returns the ids that changed.
 */
export function syncToc(d, from, { labels } = {}) {
  const meta = readMeta(d);
  if (!from) { // default: the most recently edited slide that has a timeline
    const mt = (id) => { try { return fs.statSync(slidePath(d, id)).mtimeMs; } catch { return 0; } };
    from = meta.slides.filter((id) => tocOf(safeRead(d, id))).sort((a, b) => mt(b) - mt(a))[0];
  }
  if (!from) throw new UserError(`No slide in "${d}" has a <nav class="toc"> timeline`);
  let src = tocOf(readSlide(d, from));
  if (!src) throw new UserError(`Slide "${from}" has no <nav class="toc"> timeline`);
  if (labels) {
    const open = src.match(/^<nav\b[^>]*>/i)[0];
    src = open + labels.map((l) => `<span>${escapeHtml(l)}</span>`).join('') + '</nav>';
  }
  const changed = [];
  for (const id of meta.slides) {
    const html = safeRead(d, id), cur = tocOf(html);
    if (!cur || normToc(cur) === normToc(src)) continue;
    writeFileAtomic(slidePath(d, id), html.replace(TOC_RE, () => src));
    changed.push(id);
  }
  return changed;
}
/**
 * Rewrite the deck's chapters: `labels` is the new list, `map[k]` the new 0-based index of old chapter k
 * (-1 = removed; its slides move to the nearest earlier chapter that survives, or lose their chapter).
 * Updates the timeline on every slide that has one and renumbers data-section everywhere.
 */
export function setChapters(d, labels, map = null) {
  labels = (labels || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  if (!labels.length) throw new UserError('A timeline needs at least one chapter');
  const meta = readMeta(d);
  const changed = [];
  const remap = (n) => {
    if (!map) return n;
    for (let k = n - 1; k >= 0; k--) if (map[k] != null && map[k] >= 0) return map[k] + 1;
    return null;
  };
  for (const id of meta.slides) {
    let html = safeRead(d, id);
    const before = html;
    const toc = tocOf(html);
    if (toc) {
      const open = toc.match(/^<nav\b[^>]*>/i)[0];
      html = html.replace(TOC_RE, () => open + labels.map((l) => `<span>${escapeHtml(l)}</span>`).join('') + '</nav>');
    }
    const cur = sectionOf(html);
    if (cur && /^\d+$/.test(cur)) {
      let n = remap(Number(cur));
      if (n != null) n = Math.min(n, labels.length);
      html = html.replace(SECTION_TAG_RE, (tag) => n == null
        ? tag.replace(/\s+data-section\s*=\s*["'][^"']*["']/i, '')
        : tag.replace(/\bdata-section\s*=\s*["'][^"']*["']/i, `data-section="${n}"`));
    }
    if (html !== before) { writeFileAtomic(slidePath(d, id), html); changed.push(id); }
  }
  return changed;
}
function safeRead(d, id) { try { return fs.readFileSync(slidePath(d, id), 'utf8'); } catch { return ''; } }

export function writeSlide(d, id, html) {
  requireDeck(d);
  check(id, 'slide id');
  const before = tocOf(safeRead(d, id));
  writeFileAtomic(slidePath(d, id), normalizeSlide(html));
  const after = tocOf(html);
  if (after && normToc(after) !== normToc(before)) syncToc(d, id); // editing the timeline on one slide updates them all
  const raw = readJSON(path.join(deckDir(d), 'deck.json'), {});
  if (!Array.isArray(raw.slides) || !raw.slides.includes(id)) writeMeta(d, readMeta(d)); // record new slide in the order
  return id;
}

function uniqueId(existing, base) {
  base = slugify(base);
  let id = base, n = 2;
  while (existing.includes(id)) id = `${base}-${n++}`;
  return id;
}

function setHeading(html, text) {
  return html.replace(/(<(h1|h2)\b[^>]*>)[\s\S]*?(<\/\2>)/i, (m, open, _t, close) => open + escapeHtml(text) + close);
}

/**
 * Add a slide. Options:
 *   layout  name from templates/layouts (default "bullets"), ignored if html given
 *   html    full slide markup
 *   title   text for the first <h1>/<h2>, also used to derive the id
 *   id      explicit id (must be unused)
 *   after   insert after this slide id;  index  insert at 0-based position
 */
export function addSlide(d, { layout, html, title, id, after, index } = {}) {
  const meta = readMeta(d);
  const fromLayout = html == null;
  if (fromLayout) html = getLayout(layout || 'bullets', meta.theme).html;
  if (title) html = setHeading(html, title);
  if (id) {
    check(id, 'slide id');
    if (meta.slides.includes(id)) throw new UserError(`Slide "${id}" already exists in "${d}"`, 409);
  } else {
    id = uniqueId(meta.slides, title || layout || 'slide');
  }
  let pos = meta.slides.length;
  if (after != null && after !== '') {
    const i = meta.slides.indexOf(after);
    if (i < 0) throw new UserError(`No slide "${after}" to insert after`, 404);
    pos = i + 1;
  } else if (index != null && index !== '') {
    pos = Math.max(0, Math.min(meta.slides.length, Number(index)));
  }
  if (tocOf(html)) {
    // a new slide takes the deck's current timeline, and the chapter of the slide before it
    const before = meta.slides.slice(0, pos).reverse(), others = [...before, ...meta.slides.slice(pos)];
    const deckToc = others.map((s) => tocOf(safeRead(d, s))).find(Boolean);
    if (deckToc) html = html.replace(TOC_RE, () => deckToc);
    const prevSec = before.map((s) => sectionOf(safeRead(d, s))).find((v) => v);
    if (prevSec && fromLayout && sectionOf(html) !== undefined)
      html = html.replace(SECTION_TAG_RE, (tag) => tag.replace(/\bdata-section\s*=\s*["'][^"']*["']/i, `data-section="${prevSec}"`));
  }
  writeFileAtomic(slidePath(d, id), normalizeSlide(html));
  meta.slides.splice(pos, 0, id);
  writeMeta(d, meta);
  return id;
}

export function duplicateSlide(d, id) {
  const html = readSlide(d, id);
  const meta = readMeta(d);
  return addSlide(d, { html, id: uniqueId(meta.slides, `${id}-copy`), after: id });
}

export function deleteSlide(d, id) {
  const meta = readMeta(d);
  try { fs.unlinkSync(slidePath(d, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  meta.slides = meta.slides.filter((s) => s !== id);
  writeMeta(d, meta);
}

export function moveSlide(d, id, { after, index } = {}) {
  const meta = readMeta(d);
  if (!meta.slides.includes(id)) throw new UserError(`No slide "${id}"`, 404);
  const rest = meta.slides.filter((s) => s !== id);
  let pos;
  if (after === '' || after === null) pos = 0;
  else if (after !== undefined) {
    const i = rest.indexOf(after);
    if (i < 0) throw new UserError(`No slide "${after}"`, 404);
    pos = i + 1;
  } else pos = Math.max(0, Math.min(rest.length, Number(index ?? rest.length)));
  rest.splice(pos, 0, id);
  meta.slides = rest;
  writeMeta(d, meta);
}

export function renameSlide(d, id, newId) {
  check(newId, 'slide id');
  const meta = readMeta(d);
  if (!meta.slides.includes(id)) throw new UserError(`No slide "${id}"`, 404);
  if (meta.slides.includes(newId)) throw new UserError(`Slide "${newId}" already exists`, 409);
  fs.renameSync(slidePath(d, id), slidePath(d, newId));
  meta.slides = meta.slides.map((s) => (s === id ? newId : s));
  writeMeta(d, meta);
  const comments = readComments(d);
  if (comments.some((c) => c.slide === id)) writeComments(d, comments.map((c) => (c.slide === id ? { ...c, slide: newId } : c)));
}

// ---------------------------------------------------------------- assets

export function saveAsset(d, filename, buf) {
  requireDeck(d);
  const ext = (path.extname(filename || '').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.bin'])[0];
  const base = slugify(path.basename(filename || 'file', path.extname(filename || '')), 'image');
  const dir = path.join(deckDir(d), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  let name = base + ext, n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `assets/${name}`;
}

// ---------------------------------------------------------------- templates

export function themePath(name) {
  const p = path.join(TEMPLATES_DIR, 'themes', check(name, 'theme') + '.css');
  if (!fs.existsSync(p)) throw new UserError(`No theme "${name}" (see templates/themes)`, 404);
  return p;
}

function leadingComment(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

export function listThemes() {
  const dir = path.join(TEMPLATES_DIR, 'themes');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.css')).sort().map((f) => {
    const css = fs.readFileSync(path.join(dir, f), 'utf8');
    return { name: f.slice(0, -4), description: leadingComment(css, /^\s*\/\*([\s\S]*?)\*\//), css };
  });
}

/** Copy files a theme references as url("assets/...") from templates/themes/assets into the deck. */
export function copyThemeAssets(d, theme) {
  const src = path.join(TEMPLATES_DIR, 'themes');
  const css = fs.readFileSync(themePath(theme), 'utf8');
  for (const m of css.matchAll(/url\(\s*["']?(assets\/[^"')]+)["']?\s*\)/g)) {
    const from = path.resolve(src, m[1]);
    const to = path.resolve(deckDir(d), m[1]);
    if (!from.startsWith(path.join(src, 'assets') + path.sep) || !fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function parseLayout(name, text, theme = null) {
  const description = leadingComment(text, /^\s*<!--([\s\S]*?)-->/);
  const html = text.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim() + '\n';
  return { name, description, html, theme };
}

const layoutDir = (theme) => path.join(TEMPLATES_DIR, 'layouts', ...(theme ? [check(theme, 'theme')] : []));
const htmlNames = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)); } catch { return []; } };

const ORDER = ['title', 'content', 'split', 'outline', 'section', 'agenda', 'bullets', 'text-figure', 'figure', 'two-col', 'cards', 'approach', 'image-right', 'image-full', 'diagram-stats', 'stats', 'table', 'summary', 'quote', 'code', 'closing', 'blank'];
/**
 * Layouts available to a deck: the global ones in templates/layouts plus, when a theme is
 * given, the theme's own layouts in templates/layouts/<theme>/ (which win on name clashes).
 */
export function listLayouts(theme = null) {
  const rank = (n) => (ORDER.includes(n) ? ORDER.indexOf(n) : ORDER.length);
  const own = theme ? htmlNames(layoutDir(theme)) : [];
  // a theme folder containing ".exclusive" offers only its own layouts
  const exclusive = theme && fs.existsSync(path.join(layoutDir(theme), '.exclusive'));
  const names = [...new Set([...own, ...(exclusive ? [] : htmlNames(layoutDir()))])];
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((n) => getLayout(n, theme));
}

export function getLayout(name, theme = null) {
  check(name, 'layout');
  for (const t of theme ? [theme, null] : [null]) {
    const p = path.join(layoutDir(t), name + '.html');
    if (fs.existsSync(p)) return parseLayout(name, fs.readFileSync(p, 'utf8'), t);
  }
  throw new UserError(`No layout "${name}". Available: ${listLayouts(theme).map((l) => l.name).join(', ')}`, 404);
}

export function saveLayout(name, html, description = '', theme = null) {
  check(name, 'layout name');
  let s = normalizeSlide(html).replace(/<aside class="notes">[\s\S]*?<\/aside>/i, '<aside class="notes"></aside>');
  s = s.replace(/data-layout="[^"]*"/, `data-layout="${name}"`);
  const desc = String(description || 'Custom layout').replace(/--/g, '-');
  writeFileAtomic(path.join(layoutDir(theme), name + '.html'), `<!-- ${desc} -->\n${s}`);
  return name;
}

// ---------------------------------------------------------------- comments

const commentsPath = (d) => path.join(deckDir(d), 'comments.json');
export function readComments(d) { const c = readJSON(commentsPath(d), []); return Array.isArray(c) ? c : []; }
export function writeComments(d, list) { writeJSON(commentsPath(d), list); }

export function addComment(d, { slide, target, text, author = 'human', x, y, near }) {
  requireDeck(d);
  if (!text || !String(text).trim()) throw new UserError('Comment text is required');
  const list = readComments(d);
  const n = list.reduce((m, c) => Math.max(m, Number(String(c.id).replace(/\D/g, '')) || 0), 0) + 1;
  const c = { id: `c${n}`, slide: slide || null, target: target || null, author, text: String(text).trim(), status: 'open', created: new Date().toISOString() };
  // optional pin position on the 1920x1080 slide, plus a snippet of the element that was clicked
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x !== null && y !== null) { c.x = Math.round(Number(x)); c.y = Math.round(Number(y)); }
  if (near) c.near = String(near).slice(0, 120);
  list.push(c);
  writeComments(d, list);
  return c;
}

export function updateComment(d, id, patch) {
  const list = readComments(d);
  const c = list.find((x) => x.id === id);
  if (!c) throw new UserError(`No comment "${id}"`, 404);
  if (patch.status) {
    c.status = patch.status === 'resolved' ? 'resolved' : 'open';
    if (c.status === 'resolved') c.resolved = new Date().toISOString(); else delete c.resolved;
  }
  if (patch.reply !== undefined) c.reply = String(patch.reply);
  if (patch.text !== undefined) c.text = String(patch.text);
  writeComments(d, list);
  return c;
}

export function deleteComment(d, id) {
  writeComments(d, readComments(d).filter((c) => c.id !== id));
}

// ---------------------------------------------------------------- status

const statusPath = (d) => path.join(deckDir(d), '.status.json');
export function readStatus(d) { return readJSON(statusPath(d), {}); }
export function writeStatus(d, patch) {
  requireDeck(d);
  const cur = readStatus(d);
  for (const [id, v] of Object.entries(patch || {})) {
    if (NAME_RE.test(id)) cur[id] = { ...v, checked: new Date().toISOString() };
  }
  writeJSON(statusPath(d), cur);
  return cur;
}
