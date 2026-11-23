// HTML Slides editor — vanilla JS, no build step.
// The filesystem is the source of truth: every change is saved to
// decks/<deck>/slides/<id>.html and changes made by agents on disk stream
// back in over SSE.

// ============================================================ utilities
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };
const norm = (s) => String(s ?? '').trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = {
  async req(method, url, body) {
    const r = await fetch(url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    return data;
  },
  get: (u) => api.req('GET', u), post: (u, b = {}) => api.req('POST', u, b), put: (u, b) => api.req('PUT', u, b), del: (u) => api.req('DELETE', u),
};

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2800);
}

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  text: '<path d="M4 7V5h16v2M12 5v14M9 19h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5L5 20"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.3"/><circle cx="12" cy="7.5" r="1.3"/><circle cx="16" cy="10" r="1.3"/><path d="M12 21a3 3 0 010-6h2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  bold: '<path d="M7 4h6a4 4 0 010 8H7zM7 12h7a4 4 0 010 8H7z"/>',
  italic: '<path d="M10 4h8M6 20h8M14 4l-4 16"/>',
  underline: '<path d="M7 4v7a5 5 0 0010 0V4M5 20h14"/>',
  alignL: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignC: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignR: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  reset: '<path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0112 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
};
const icon = (n) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.innerHTML = ICONS[n]; return s; };
const btn = (label, onclick, { cls = '', title, ic } = {}) => h('button', { class: `btn ${cls}`, title: title || false, onclick }, ic ? icon(ic) : null, label);

// ============================================================ editor light / dark
const uiTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
function toggleUiTheme() {
  const next = uiTheme() === 'dark' ? 'light' : 'dark';
  if (next === 'dark') document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('html-slides-ui', next); } catch {}
  $$('.ui-theme-btn').forEach((b) => b.replaceChildren(icon(next === 'dark' ? 'sun' : 'moon')));
}
const uiThemeBtn = () => h('button', { class: 'btn icon ghost ui-theme-btn', title: 'Light / dark editor', onclick: toggleUiTheme }, icon(uiTheme() === 'dark' ? 'sun' : 'moon'));

// ============================================================ state
const W = 1920, H = 1080;
const S = {
  view: null,
  deck: null,          // { name, title, theme }
  order: [],           // slide ids
  html: {},            // id -> current html (local truth)
  saved: {},           // id -> last html known to be on disk
  hist: {},            // id -> { stack, i }
  comments: [], status: {}, themes: [], layouts: [],
  current: null, doc: null, sel: null, editing: null,
  scale: 0.5, themeV: Date.now(), showAllComments: false,
};
const E = {}; // editor DOM refs
const D = () => S.deck?.name;

// ============================================================ slide documents
const EDIT_CSS = `.slide [data-build]{outline:2px dashed rgba(124,77,255,.55);outline-offset:3px}.slide{cursor:default}.slide [contenteditable]{outline:none;cursor:text}::selection{background:rgba(79,124,255,.35)}body.note-mode .slide,body.note-mode .slide *{cursor:crosshair!important}`;
function slideDoc(html, { deck = D(), themeHref, editing = false } = {}) {
  // absolute: Chrome's preload scanner resolves a relative <base> in srcdoc docs against about:srcdoc
  const base = `${location.origin}${deck ? `/decks/${deck}/` : '/templates/'}`;
  const theme = themeHref || `/decks/${deck}/theme.css?v=${S.themeV}`;
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}">` +
    `<link rel="stylesheet" href="/core/slides.css"><link rel="stylesheet" id="theme-css" href="${theme}">` +
    `<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:transparent}${editing ? EDIT_CSS : ''}</style>` +
    `</head><body>${html}</body></html>`;
}
function frame(html, opts = {}) {
  const ifr = h('iframe', { tabindex: '-1', title: 'slide preview' });
  ifr.srcdoc = slideDoc(html, opts);
  return h('div', { class: 'frame' }, ifr);
}
function fitFrames(root = document) {
  for (const f of $$('.frame', root)) {
    const w = f.clientWidth;
    if (w) f.firstElementChild.style.transform = `scale(${w / W})`;
  }
}
addEventListener('resize', () => { fitFrames(); if (S.view === 'editor') fitStage(); });

// ============================================================ home
async function showHome() {
  S.view = 'home'; S.deck = null; S.doc = null; S.current = null;
  document.title = 'HTML Slides';
  const [decks, themes] = await Promise.all([api.get('/api/decks'), api.get('/api/themes')]);
  S.themes = themes;
  const app = $('#app');

  const titleIn = h('input', { type: 'text', placeholder: 'Deck title', required: true });
  const nameIn = h('input', { type: 'text', placeholder: 'folder-name (auto)' });
  titleIn.addEventListener('input', () => { if (!nameIn.dataset.touched) nameIn.value = slug(titleIn.value); });
  nameIn.addEventListener('input', () => { nameIn.dataset.touched = '1'; });
  const sample = `<section class="slide layout-title"><p class="kicker">Theme</p><h1>Aa Title</h1><p class="lede">Body text looks like this.</p></section>`;
  const themePick = h('div', { class: 'theme-pick' }, themes.map((t, i) =>
    h('label', { title: t.description }, h('input', { type: 'radio', name: 'theme', value: t.name, checked: i === 0 }),
      frame(sample, { deck: null, themeHref: `/templates/themes/${t.name}.css` }), h('span', { class: 'name' }, t.name))));
  const create = async (e) => {
    e.preventDefault();
    const title = titleIn.value.trim();
    if (!title) return titleIn.focus();
    try {
      const { name } = await api.post('/api/decks', { title, name: nameIn.value.trim() || slug(title), theme: $('input[name=theme]:checked', form)?.value });
      location.hash = `#/deck/${name}`;
    } catch (err) { toast(err.message, 'error'); }
  };
  const form = h('form', { class: 'new-deck', onsubmit: create },
    h('h3', null, 'New deck'),
    h('label', { class: 'field' }, h('span', null, 'Title'), titleIn),
    h('label', { class: 'field' }, h('span', null, 'Folder'), nameIn),
    h('div', { class: 'field' }, h('span', null, 'Theme'), themePick),
    h('button', { class: 'btn primary', type: 'submit', style: { justifyContent: 'center' } }, 'Create deck'));

  const cards = decks.map((d) => h('div', { class: 'deck-card', onclick: () => { location.hash = `#/deck/${d.name}`; } },
    frame(d.firstHtml || '<section class="slide"></section>', { deck: d.name, themeHref: `/decks/${d.name}/theme.css?v=${d.updated}` }),
    h('div', { class: 'meta' }, h('b', null, d.title),
      h('span', null, `${d.slideCount} slide${d.slideCount === 1 ? '' : 's'} · ${d.theme} · ${d.name}`,
        d.openComments ? ` · ${d.openComments} open note${d.openComments > 1 ? 's' : ''}` : ''))));

  app.replaceChildren(h('div', { class: 'home' },
    h('div', { class: 'home-head' },
      h('div', { class: 'logo' }, icon('play')),
      h('div', null, h('h1', null, 'HTML Slides'), h('div', { class: 'sub' }, 'Decks are folders of HTML files — edit here, or let an agent edit them on disk.')),
      h('div', { style: { flex: 1 } }),
      btn('Agent prompts', () => agentModal(), { ic: 'bot' }), uiThemeBtn()),
    h('div', { class: 'deck-grid' }, form, cards)));
  requestAnimationFrame(() => fitFrames(app));
}
const refreshHomeSoon = debounce(() => { if (S.view === 'home' && !document.activeElement?.closest?.('form')) showHome(); }, 400);
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s_-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/^-|-$/g, '');

// ============================================================ editor: load
async function openDeck(name, slideId) {
  if (S.view === 'editor' && D() === name) { if (slideId && slideId !== S.current && S.html[slideId] != null) selectSlide(slideId); return; }
  let deck, layouts, themes;
  try {
    [deck, themes] = await Promise.all([api.get(`/api/decks/${name}`), api.get('/api/themes')]);
    layouts = await api.get(`/api/layouts?theme=${encodeURIComponent(deck.theme)}`);
  } catch (e) { toast(e.message, 'error'); location.hash = ''; return; }
  S.view = 'editor';
  S.layouts = layouts; S.themes = themes;
  S.hist = {}; S.sel = null; S.editing = null; S.doc = null; S.current = null;
  loadDeckData(deck);
  buildEditor();
  selectSlide(slideId && S.html[slideId] != null ? slideId : S.order[0]);
}

function loadDeckData(deck) {
  S.deck = { name: deck.name, title: deck.title, theme: deck.theme };
  S.order = deck.slides.map((s) => s.id);
  S.html = {}; S.saved = {};
  for (const s of deck.slides) { S.html[s.id] = s.html; S.saved[s.id] = s.html; }
  S.comments = deck.comments; S.status = deck.status || {};
  document.title = `${deck.title} — HTML Slides`;
}

async function reloadDeck(selectId) {
  await flushSaves();
  const deck = await api.get(`/api/decks/${D()}`);
  const keep = S.current;
  loadDeckData(deck);
  renderList();
  S.current = null;
  selectSlide(selectId && S.html[selectId] != null ? selectId : (S.html[keep] != null ? keep : S.order[0]));
}

function buildEditor() {
  const titleIn = h('input', { class: 'title-input', type: 'text', value: S.deck.title, title: 'Deck title' });
  titleIn.addEventListener('change', async () => { try { await api.put(`/api/decks/${D()}`, { title: titleIn.value }); S.deck.title = titleIn.value; document.title = `${titleIn.value} — HTML Slides`; } catch (e) { toast(e.message, 'error'); } });
  const themeSel = h('select', { title: 'Theme' }, S.themes.map((t) => h('option', { value: t.name, selected: t.name === S.deck.theme }, `Theme: ${t.name}`)));
  themeSel.addEventListener('change', async () => {
    if (!confirm(`Switch to the "${themeSel.value}" theme? This replaces this deck's theme.css (any custom CSS in it is lost).`)) { themeSel.value = S.deck.theme; return; }
    await api.put(`/api/decks/${D()}`, { theme: themeSel.value });
    S.deck.theme = themeSel.value; reloadTheme();
    S.layouts = await api.get(`/api/layouts?theme=${encodeURIComponent(S.deck.theme)}`);
  });
  E.saveState = h('span', { class: 'save-state' }, 'Saved');
  E.undoBtn = btn('', () => undo(), { cls: 'icon ghost', ic: 'undo', title: 'Undo (⌘Z)' });
  E.redoBtn = btn('', () => redo(), { cls: 'icon ghost', ic: 'redo', title: 'Redo (⌘⇧Z)' });
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true });
  fileIn.addEventListener('change', () => { if (fileIn.files[0]) insertImageFile(fileIn.files[0]); fileIn.value = ''; });

  const topbar = h('header', { class: 'topbar' },
    btn('', () => { location.hash = ''; }, { cls: 'icon ghost', ic: 'back', title: 'All decks' }),
    titleIn, E.saveState,
    h('div', { class: 'grow' }),
    btn('Text', () => addTextBox(), { ic: 'text', title: 'Add a free text box' }),
    btn('Image', () => fileIn.click(), { ic: 'image', title: 'Add an image (or drop / paste one onto the slide)' }), fileIn,
    E.noteBtn = btn('Note', () => setNoteMode(!S.noteMode), { ic: 'pin', title: 'Note tool (N): click anywhere on the slide to leave a note for the agent' }),
    h('div', { class: 'sep' }), E.undoBtn, E.redoBtn, h('div', { class: 'sep' }),
    themeSel,
    btn('CSS', () => themeCssModal(), { ic: 'palette', title: "Edit this deck's theme.css" }),
    btn('Agent', () => agentModal(), { ic: 'bot', title: 'Prompts for working with an agent' }),
    h('div', { class: 'sep' }),
    btn('Export', () => { flushSaves().then(() => { location.href = `/export/${D()}`; }); }, { ic: 'download', title: 'Download a single self-contained HTML file' }),
    btn('Present', () => { flushSaves().then(() => window.open(`/present/${D()}#${S.order.indexOf(S.current) + 1}`, '_blank')); }, { cls: 'primary', ic: 'play' }),
    uiThemeBtn());

  E.list = h('div', { class: 'slide-list' });
  const sidebar = h('aside', { class: 'sidebar' }, E.list,
    h('div', { class: 'sidebar-foot' }, btn('Add slide', () => addSlideModal(), { ic: 'plus' })));

  E.iframe = h('iframe', { class: 'canvas', title: 'slide editor' });
  E.hover = h('div', { class: 'hover-box', hidden: true });
  E.selTag = h('div', { class: 'tag' });
  E.sel = h('div', { class: 'sel-box', hidden: true }, E.selTag, ['e', 's', 'se'].map((k) => h('div', { class: 'handle', 'data-h': k, onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); if (S.sel) beginDrag(k, e, S.sel); } })));
  E.gv = h('div', { class: 'guide v', hidden: true });
  E.gh = h('div', { class: 'guide h', hidden: true });
  E.markers = h('div');
  E.overlay = h('div', { class: 'overlay' }, E.hover, E.sel, E.gv, E.gh, E.markers);
  E.slidebox = h('div', { class: 'slidebox' }, E.iframe, E.overlay);
  E.stage = h('div', { class: 'stage' }, E.slidebox);
  E.status = h('div', { class: 'stage-status' });
  E.banner = h('div', { class: 'banner', hidden: true });
  E.modeChip = h('div', { class: 'mode-chip', hidden: true }, 'Note tool: click anywhere on the slide · Esc to exit');
  E.stageWrap = h('main', { class: 'stage-wrap', onmousedown: (e) => {
    if (E.pop?.contains(e.target)) return;
    if (!E.stage.contains(e.target)) { closePop(); stopEdit(); select(null); }
  } },
    E.stage, E.status, E.banner, E.modeChip,
    h('div', { class: 'hint' }, h('span', null, 'Click select · Drag move · Double-click edit text · N note · Esc parent · ⇧ lock axis · Alt no snap')));
  E.inspector = h('aside', { class: 'inspector' });

  $('#app').replaceChildren(h('div', { class: 'editor' }, topbar, sidebar, E.stageWrap, E.inspector));

  E.iframe.addEventListener('load', () => {
    S.doc = E.iframe.contentDocument;
    wireCanvas(S.doc);
    if (S.current) S.doc.body.innerHTML = S.html[S.current];
    ensureSection();
    afterCanvasRender();
    renderInspector();
  });
  E.iframe.srcdoc = slideDoc('', { editing: true });
  new ResizeObserver(() => fitStage()).observe(E.stageWrap);
  renderList();
  fitStage();
}

function fitStage() {
  if (!E.stageWrap) return;
  const pad = 40;
  const s = Math.max(0.05, Math.min((E.stageWrap.clientWidth - pad * 2) / W, (E.stageWrap.clientHeight - pad * 2 - 24) / H));
  S.scale = s;
  E.stage.style.width = `${W * s}px`;
  E.stage.style.height = `${H * s}px`;
  E.slidebox.style.transform = `scale(${s})`;
  E.slidebox.style.setProperty('--scale', s);
  updateOverlay();
  if (E.pop && S.popAt) placePop(E.pop, S.popAt.x, S.popAt.y);
}

// ============================================================ slide list
const thumbs = new Map(); // id -> { el, iframe, badges, num, html }
// Keeps the thumbnails that are still there (same element, no reload). Rebuilding every iframe after a delete
// or reorder made them all blank until each one reloaded, which on a slow disk took seconds.
function renderList() {
  if (!E.list.isConnected || [...thumbs.values()].some((t) => !E.list.contains(t.el))) { thumbs.clear(); E.list.replaceChildren(); }
  const want = new Set(S.order);
  for (const [id, t] of thumbs) if (!want.has(id)) { t.el.remove(); thumbs.delete(id); }
  let cursor = E.list.firstElementChild;
  S.order.forEach((id, i) => {
    let t = thumbs.get(id);
    if (!t) t = makeThumb(id);
    else if (t.html !== S.html[id]) { t.html = S.html[id]; updateThumb(id); }
    t.num.textContent = i + 1;
    if (t.el === cursor) cursor = cursor.nextElementSibling;
    else E.list.insertBefore(t.el, cursor); // only moved or new thumbnails (re)load
  });
  updateBadges();
  highlightThumb();
  requestAnimationFrame(() => fitFrames(E.list));
}
function makeThumb(id) {
  const f = frame(S.html[id]);
  const iframe = f.firstElementChild;
  const badges = h('div', { class: 'badges' });
  const num = h('span', { class: 'num' });
  const el = h('div', { class: 'thumb', draggable: true, 'data-id': id, title: id, onclick: () => selectSlide(id) },
    num, f, badges,
    h('div', { class: 'actions' },
      h('button', { title: 'Duplicate slide', onclick: (e) => { e.stopPropagation(); duplicateSlide(id); } }, icon('copy')),
      h('button', { title: 'Delete slide', onclick: (e) => { e.stopPropagation(); deleteSlide(id); } }, icon('trash'))));
  iframe.addEventListener('load', () => measureThumb(id, iframe));
  wireThumbDrag(el, id);
  const t = { el, iframe, badges, num, html: S.html[id] };
  thumbs.set(id, t);
  return t;
}

function highlightThumb() {
  for (const [id, t] of thumbs) t.el.classList.toggle('active', id === S.current);
  thumbs.get(S.current)?.el.scrollIntoView({ block: 'nearest' });
}

function updateBadges() {
  for (const [id, t] of thumbs) {
    const n = S.comments.filter((c) => c.slide === id && c.status !== 'resolved').length;
    const over = S.status[id]?.overflow?.length;
    t.badges.replaceChildren(...[
      over ? h('span', { class: 'badge warn', title: `Overflows: ${S.status[id].overflow.join(', ')}` }, '!') : null,
      n ? h('span', { class: 'badge', title: `${n} open note${n > 1 ? 's' : ''}` }, n) : null].filter(Boolean));
  }
}

const thumbTimers = {};
function updateThumb(id) {
  clearTimeout(thumbTimers[id]);
  thumbTimers[id] = setTimeout(() => {
    const t = thumbs.get(id);
    if (!t) return;
    t.html = S.html[id];
    const body = t.iframe.contentDocument?.body;
    if (body) { body.innerHTML = S.html[id]; measureThumb(id, t.iframe); } else t.iframe.srcdoc = slideDoc(S.html[id]);
  }, 250);
}
function flashThumb(id) {
  const el = thumbs.get(id)?.el;
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function wireThumbDrag(el, id) {
  el.addEventListener('dragstart', (e) => { S.dragId = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); });
  el.addEventListener('dragend', () => { S.dragId = null; $$('.thumb').forEach((t) => t.classList.remove('drop-before', 'drop-after')); });
  el.addEventListener('dragover', (e) => {
    if (!S.dragId) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    $$('.thumb').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
    if (S.dragId !== id) el.classList.add(before ? 'drop-before' : 'drop-after');
  });
  el.addEventListener('drop', async (e) => {
    if (!S.dragId) return;
    e.preventDefault();
    const before = el.classList.contains('drop-before');
    const moving = S.dragId;
    $$('.thumb').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
    if (moving === id) return;
    const order = S.order.filter((x) => x !== moving);
    order.splice(order.indexOf(id) + (before ? 0 : 1), 0, moving);
    S.order = order;
    renderList();
    try { await api.put(`/api/decks/${D()}`, { slides: order }); } catch (err) { toast(err.message, 'error'); }
  });
}

// ============================================================ slide-level actions
function selectSlide(id) {
  if (id == null || S.html[id] == null) id = S.order[0];
  if (id == null) { S.current = null; renderInspector(); return; }
  if (S.editing) stopEdit();
  if (id === S.current) return;
  closePop();
  S.current = id;
  S.sel = null;
  S.hist[id] ??= { stack: [S.html[id]], i: 0 };
  hideBanner();
  highlightThumb();
  setCanvasHtml(S.html[id]);
  history.replaceState(null, '', `#/deck/${D()}/${id}`);
  renderInspector();
  updateUndoButtons();
}

async function duplicateSlide(id) {
  try { await flushSaves(); const r = await api.post(`/api/decks/${D()}/slides/${id}/duplicate`); await reloadDeck(r.id); }
  catch (e) { toast(e.message, 'error'); }
}
async function deleteSlide(id) {
  if (!confirm(`Delete slide "${id}"?`)) return;
  const i = S.order.indexOf(id);
  const next = S.order[i + 1] ?? S.order[i - 1];
  try { await api.del(`/api/decks/${D()}/slides/${id}`); delete S.hist[id]; await reloadDeck(next); }
  catch (e) { toast(e.message, 'error'); }
}

function addSlideModal() {
  const grid = h('div', { class: 'layout-grid' }, S.layouts.map((l) =>
    h('div', { class: 'layout-opt', onclick: async () => {
      m.close();
      try { await flushSaves(); const r = await api.post(`/api/decks/${D()}/slides`, { layout: l.name, after: S.current }); await reloadDeck(r.id); }
      catch (e) { toast(e.message, 'error'); }
    } }, frame(l.html), h('b', null, l.name, l.theme ? h('span', { class: 'muted', style: { fontWeight: 400 } }, ` · ${l.theme}`) : null), h('span', null, l.description))));
  const m = modal({ title: 'Add slide', body: grid, wide: true });
  requestAnimationFrame(() => fitFrames(grid));
}

// ============================================================ canvas
function section() { return S.doc?.querySelector('section.slide') || null; }
function ensureSection() {
  if (!S.doc || section()) return;
  const sec = S.doc.createElement('section');
  sec.className = 'slide layout-blank';
  sec.dataset.layout = 'custom';
  while (S.doc.body.firstChild) sec.append(S.doc.body.firstChild);
  S.doc.body.append(sec);
}

function setCanvasHtml(html, keepPath = null) {
  if (!S.doc) return; // first load handled by iframe onload
  if (S.editing) S.editing = null;
  S.doc.body.innerHTML = html;
  ensureSection();
  S.sel = keepPath ? byPath(keepPath) : null;
  afterCanvasRender();
}

function afterCanvasRender() {
  if (!S.doc) return;
  updateOverlay();
  measureCanvasSoon();
  S.doc.fonts?.ready.then(() => { updateOverlay(); measureCanvasSoon(); });
}

function wireCanvas(doc) {
  const win = doc.defaultView;
  doc.addEventListener('mousedown', onCanvasDown, true);
  doc.addEventListener('dblclick', onCanvasDbl, true);
  doc.addEventListener('mousemove', onCanvasHover);
  doc.addEventListener('mouseleave', () => { E.hover.hidden = true; });
  doc.addEventListener('click', (e) => { if (e.target.closest?.('a')) e.preventDefault(); }, true);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('input', () => { updateOverlay(); commitSoon(); });
  doc.addEventListener('paste', onPaste);
  doc.addEventListener('dragstart', () => { innerDrag = true; }, true);
  doc.addEventListener('dragend', () => { innerDrag = false; }, true);
  doc.addEventListener('dragover', (e) => { if (canTakeDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  doc.addEventListener('keydown', onPasteKey, true);
  doc.addEventListener('drop', onCanvasDrop);
  doc.addEventListener('load', () => updateOverlay(), true); // images
  win.addEventListener('message', onEmbedMessage);
  win.addEventListener('scroll', () => { if (win.scrollX || win.scrollY) win.scrollTo(0, 0); });
}

const INLINE = /^(B|STRONG|I|EM|U|S|SPAN|A|CODE|SUB|SUP|BR|MARK|SMALL|ABBR|KBD|Q|DEL|INS|FONT)$/;
/** Innermost non-inline element under the pointer (inline formatting resolves to its block). */
function pick(t) {
  const sec = section();
  let el = t?.nodeType === 1 ? t : t?.parentElement;
  if (!sec || !el || el === sec || !sec.contains(el)) return null;
  if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') el = el.closest('svg');
  const emb = el.closest('figure.embed');
  if (emb && emb !== sec && sec.contains(emb)) return emb;
  while (el.parentElement && el.parentElement !== sec && INLINE.test(el.tagName)) el = el.parentElement;
  return el;
}

function editHostFor(el) {
  if (!el) return null;
  if (el.tagName === 'LI') return el.parentElement;
  if (/^(IMG|SVG|VIDEO|IFRAME|HR|CANVAS|PICTURE|FIGURE|svg)$/.test(el.tagName)) return null;
  if (/^(UL|OL)$/.test(el.tagName)) return el;
  if ([...el.children].every((c) => INLINE.test(c.tagName)) && el.textContent.trim() !== '' ) return el;
  if (!el.children.length) return el;
  return null;
}

function onCanvasDown(e) {
  if (e.button !== 0) return;
  if (S.noteMode) {
    e.preventDefault();
    if (S.editing) stopEdit();
    openNewNote(e.clientX, e.clientY, pick(e.target));
    return;
  }
  closePop();
  if (S.editing && S.editing.contains(e.target)) return; // caret placement inside the text being edited
  if (S.editing) stopEdit();
  const el = pick(e.target);
  e.preventDefault();
  E.iframe.contentWindow.focus();
  if (!el) { select(null); return; }
  const target = S.sel && S.sel !== el && S.sel.contains(el) ? S.sel : el; // keep container selection; dbl-click drills in
  if (target !== S.sel) select(target);
  beginDrag('move', e, target);
}

function onCanvasDbl(e) {
  if (S.noteMode) return;
  const el = pick(e.target);
  if (!el) return;
  let host = editHostFor(S.sel && S.sel.contains(el) ? S.sel : el) || editHostFor(el);
  if (!host) { select(el); return; }
  startEdit(host, e);
}

function onCanvasHover(e) {
  if (document.body.classList.contains('dragging')) return;
  let el = pick(e.target);
  if (el && S.sel && S.sel.contains(el)) el = null;
  if (!el) { E.hover.hidden = true; return; }
  placeBox(E.hover, el.getBoundingClientRect());
  E.hover.hidden = false;
}

function placeBox(box, r) {
  box.style.left = `${r.left}px`; box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`; box.style.height = `${r.height}px`;
}

function describe(el) {
  if (!el) return '';
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
  return `${el.tagName.toLowerCase()}${el.dataset?.id ? '#' + el.dataset.id : cls}`;
}

function updateOverlay() {
  if (!E.sel) return;
  const el = S.sel;
  if (!el || !el.isConnected) { E.sel.hidden = true; }
  else {
    placeBox(E.sel, el.getBoundingClientRect());
    E.sel.hidden = false;
    E.sel.classList.toggle('editing', !!S.editing);
    E.selTag.textContent = S.editing ? `editing ${describe(el)} · Esc to finish` : describe(el);
  }
  renderMarkers();
}

function select(el) {
  if (S.editing && el !== S.editing) stopEdit();
  S.sel = el || null;
  E.hover.hidden = true;
  updateOverlay();
  renderInspector();
}

// ---------- text editing
function startEdit(el, ev) {
  if (!el) return;
  if (S.editing && S.editing !== el) stopEdit();
  S.sel = el;
  S.editing = el;
  el.contentEditable = 'true';
  el.spellcheck = true;
  E.iframe.contentWindow.focus();
  el.focus({ preventScroll: true });
  const sel = S.doc.getSelection();
  let range = null;
  if (ev) {
    if (S.doc.caretRangeFromPoint) range = S.doc.caretRangeFromPoint(ev.clientX, ev.clientY);
    else if (S.doc.caretPositionFromPoint) { const p = S.doc.caretPositionFromPoint(ev.clientX, ev.clientY); if (p) { range = S.doc.createRange(); range.setStart(p.offsetNode, p.offset); } }
    if (range && !el.contains(range.startContainer)) range = null;
  }
  if (!range) { range = S.doc.createRange(); range.selectNodeContents(el); if (ev) range.collapse(false); }
  sel.removeAllRanges(); sel.addRange(range);
  updateOverlay();
  renderInspector();
}
function stopEdit() {
  const el = S.editing;
  if (!el) return;
  S.editing = null;
  el.removeAttribute('contenteditable');
  el.removeAttribute('spellcheck');
  S.doc?.getSelection()?.removeAllRanges();
  commitSoon.cancel();
  commit();
  updateOverlay();
  renderInspector();
}

// ---------- move / resize
function getT(el) {
  const v = el.style.translate;
  if (!v || v === 'none') return { x: 0, y: 0 };
  const [x, y] = v.split(/\s+/).map((n) => parseFloat(n) || 0);
  return { x, y: y || 0 };
}
function setT(el, x, y) {
  if (!x && !y) el.style.removeProperty('translate');
  else el.style.translate = `${x}px ${y}px`;
}
function pt(ev) {
  if (ev.view === window) return { x: ev.clientX, y: ev.clientY };
  const r = E.iframe.getBoundingClientRect();
  return { x: r.left + ev.clientX * S.scale, y: r.top + ev.clientY * S.scale };
}

function snapTargets(el) {
  const xs = [0, W / 2, W], ys = [0, H / 2, H];
  const sec = section();
  const others = [...sec.querySelectorAll(':scope > *, .free')].filter((o) => o !== el && !o.contains(el) && !el.contains(o) && !o.classList.contains('notes'));
  for (const o of others) {
    const r = o.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    xs.push(r.left, r.left + r.width / 2, r.right);
    ys.push(r.top, r.top + r.height / 2, r.bottom);
  }
  return { xs, ys };
}
function snapAxis(starts, delta, targets) {
  const th = 6 / S.scale;
  let best = null;
  for (const t of targets) for (const s of starts) {
    const d = t - (s + delta);
    if (Math.abs(d) <= th && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, t };
  }
  return best ? { delta: delta + best.d, guide: best.t } : { delta, guide: null };
}
function showGuides(gx, gy) {
  E.gv.hidden = gx == null; if (gx != null) E.gv.style.left = `${gx}px`;
  E.gh.hidden = gy == null; if (gy != null) E.gh.style.top = `${gy}px`;
}

function beginDrag(kind, e0, el) {
  const p0 = pt(e0);
  const t0 = getT(el);
  const r0 = el.getBoundingClientRect();
  const targets = kind === 'move' ? snapTargets(el) : null;
  let moved = false;
  const docs = [document, S.doc];
  const onMove = (ev) => {
    const p = pt(ev);
    if (!moved) {
      if (Math.abs(p.x - p0.x) + Math.abs(p.y - p0.y) < 4) return;
      moved = true;
      document.body.classList.add('dragging');
      E.hover.hidden = true;
    }
    let dx = (p.x - p0.x) / S.scale, dy = (p.y - p0.y) / S.scale;
    if (kind === 'move') {
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      let gx = null, gy = null;
      if (!ev.altKey) {
        if (dx || !ev.shiftKey) { const sx = snapAxis([r0.left, r0.left + r0.width / 2, r0.right], dx, targets.xs); dx = sx.delta; gx = sx.guide; }
        if (dy || !ev.shiftKey) { const sy = snapAxis([r0.top, r0.top + r0.height / 2, r0.bottom], dy, targets.ys); dy = sy.delta; gy = sy.guide; }
      }
      showGuides(gx, gy);
      setT(el, Math.round(t0.x + dx), Math.round(t0.y + dy));
    } else {
      if (kind.includes('e')) el.style.width = `${Math.max(16, Math.round(r0.width + dx))}px`;
      if (kind.includes('s') && !(el.tagName === 'IMG' && kind === 'se')) el.style.height = `${Math.max(16, Math.round(r0.height + dy))}px`;
      if (el.tagName === 'IMG' && kind === 'se') el.style.removeProperty('height');
      if (kind !== 's' && getComputedStyle(el).maxWidth !== 'none') el.style.maxWidth = 'none';
    }
    updateOverlay();
  };
  const onUp = () => {
    for (const d of docs) { d.removeEventListener('mousemove', onMove, true); d.removeEventListener('mouseup', onUp, true); }
    document.body.classList.remove('dragging');
    showGuides(null, null);
    if (moved) { commit(); renderInspector(); }
  };
  for (const d of docs) { d.addEventListener('mousemove', onMove, true); d.addEventListener('mouseup', onUp, true); }
}

// ---------- element operations
function uid(prefix) {
  const sec = section();
  let id;
  do { id = `${prefix}-${Math.random().toString(36).slice(2, 6)}`; } while (sec.querySelector(`[data-id="${id}"]`));
  return id;
}
function addTextBox() {
  if (!S.doc) return;
  const el = S.doc.createElement('div');
  el.className = 'free text-box';
  el.dataset.id = uid('text');
  el.style.cssText = 'left: 660px; top: 490px; width: 600px;';
  el.textContent = 'New text';
  section().append(el);
  commit();
  startEdit(el);
}
async function uploadFile(file) {
  const r = await fetch(`/api/decks/${D()}/assets?name=${encodeURIComponent(file.name || 'pasted.png')}`, { method: 'POST', body: file });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Upload failed');
  return j.path;
}
async function insertImageFile(file, at = null, replace = null, uploaded = null) {
  if (!uploaded && !file.type.startsWith('image/')) return toast('Only images can be dropped here', 'error');
  try {
    const src = uploaded || await uploadFile(file);
    if (replace) { replace.setAttribute('src', src); commit(); select(replace); return; }
    const img = S.doc.createElement('img');
    img.className = 'free';
    img.dataset.id = uid('img');
    img.alt = '';
    img.src = src;
    const w = 720;
    img.style.cssText = `left: ${Math.round((at?.x ?? W / 2) - w / 2)}px; top: ${Math.round((at?.y ?? H / 2) - 200)}px; width: ${w}px;`;
    section().append(img);
    img.addEventListener('load', () => updateOverlay(), { once: true });
    commit();
    select(img);
  } catch (e) { toast(e.message, 'error'); }
}
function duplicateEl() {
  const el = S.sel;
  if (!el) return;
  const c = el.cloneNode(true);
  if (c.dataset.id) c.dataset.id = uid(el.dataset.id.replace(/-[a-z0-9]{4}$/, '').replace(/-\d+$/, '') || 'el');
  c.querySelectorAll('[data-id]').forEach((n) => { n.dataset.id = uid(n.dataset.id.replace(/-[a-z0-9]{4}$/, '')); });
  el.after(c);
  if (c.classList.contains('free')) { const t = getT(el); setT(c, t.x + 32, t.y + 32); }
  commit();
  select(c);
}
function deleteEl() {
  const el = S.sel;
  if (!el) return;
  const parent = el.parentElement;
  el.remove();
  commit();
  select(parent && parent !== section() && parent.children.length ? parent : null);
}

// ---------- paste / drop
// Accepts image files, but also image *links* (dragging an image out of another page or app, e.g. a chat or a
// file viewer, hands over a URL rather than a file) and images inside pasted HTML. Embedded browsers (desktop
// app previews) sometimes swallow the paste event itself, so Ctrl/⌘+V falls back to reading the clipboard.
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i;
const dtTypes = (dt) => [...(dt?.types || [])];
let innerDrag = false; // a drag that started in this editor (thumbnails, selected text) is not an image drop
document.addEventListener('dragstart', () => { innerDrag = true; }, true);
document.addEventListener('dragend', () => { innerDrag = false; }, true);
const canTakeDrop = (e) => !innerDrag && dtTypes(e.dataTransfer).some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/html' || t === 'text/plain');
function diag(kind, e, extra) { // what the browser actually delivered; GET /api/diag shows the last events
  try {
    const dt = e?.dataTransfer || e?.clipboardData;
    const info = { kind, view: S.view, editing: !!S.editing, target: e?.target?.nodeName, types: dtTypes(dt),
      files: [...(dt?.files || [])].map((f) => `${f.type || '?'} ${f.size}`), items: [...(dt?.items || [])].map((i) => `${i.kind}:${i.type}`),
      uri: dt?.getData?.('text/uri-list')?.slice(0, 200) || undefined, ...extra };
    fetch('/api/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(info) }).catch(() => {});
  } catch {}
}
function imageFileFrom(dt) {
  const f = [...(dt?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) return f;
  for (const it of dt?.items || []) if (it.kind === 'file' && it.type.startsWith('image/')) { const g = it.getAsFile(); if (g) return g; }
  return null;
}
function imageUrlFrom(dt) {
  const html = dt?.getData?.('text/html') || '';
  const m = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  if (m) return m[1].replace(/&amp;/g, '&');
  const uris = (dt?.getData?.('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const plain = (dt?.getData?.('text/plain') || '').trim();
  for (const u of [...uris, plain]) if (/^data:image\//i.test(u) || (/^(https?|blob|file):/i.test(u) && (IMG_EXT.test(u) || uris.includes(u)))) return u;
  return null;
}
async function fileFromUrl(url) {
  const name = (decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || '') || 'image').slice(0, 80);
  const local = /^(data|blob):/i.test(url) || new URL(url, location.href).origin === location.origin;
  if (local) try { // data:, blob: and this server's own files; anything else goes through the server (no CORS there)
    const r = await fetch(url);
    if (r.ok) { const b = await r.blob(); if (b.type.startsWith('image/') || IMG_EXT.test(url)) return new File([b], IMG_EXT.test(name) ? name : `${name}.${(b.type.split('/')[1] || 'png').replace('svg+xml', 'svg')}`, { type: b.type || 'image/png' }); }
  } catch {}
  if (/^https?:/i.test(url)) { // let the server fetch it (no CORS there)
    const r = await fetch(`/api/decks/${D()}/assets/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.path) return { uploaded: j.path };
    throw new Error(j.error || `Could not load ${url}`);
  }
  throw new Error('Could not read that image. Save it as a file and drop the file instead.');
}
async function insertImageFrom(fileOrUrl, at, replace) {
  if (typeof fileOrUrl !== 'string') return insertImageFile(fileOrUrl, at, replace);
  try {
    const f = await fileFromUrl(fileOrUrl);
    return f.uploaded ? insertImageFile(null, at, replace, f.uploaded) : insertImageFile(f, at, replace);
  } catch (e) { toast(e.message, 'error'); }
}
let pasteSeen = 0;
function onPaste(e) {
  pasteSeen = Date.now();
  diag('paste', e);
  const dt = e.clipboardData;
  const file = imageFileFrom(dt);
  const url = file ? null : imageUrlFrom(dt);
  if (S.editing) {
    if (!file && !url) { e.preventDefault(); S.doc.execCommand('insertText', false, dt.getData('text/plain')); return; }
    stopEditQuiet(); // an image goes on the slide, not inside the text
  }
  if ((file || url) && S.view === 'editor') { e.preventDefault(); insertImageFrom(file || url, null, S.sel?.tagName === 'IMG' ? S.sel : null); }
}
// Ctrl/⌘+V with no paste event (some embedded browsers keep it): read the clipboard ourselves.
function onPasteKey(e) {
  if (!((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') || S.view !== 'editor') return;
  if (e.target?.closest?.('input,textarea,select') && e.target.ownerDocument === document) return;
  const t0 = Date.now();
  setTimeout(async () => {
    if (pasteSeen >= t0) return;
    diag('paste-key-without-event', null);
    if (!navigator.clipboard?.read) return toast('This browser did not hand the paste to the page. Drop the image file instead.', 'error');
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) { const b = await item.getType(type); if (S.editing) stopEditQuiet(); return insertImageFile(new File([b], `pasted.${type.split('/')[1].replace('svg+xml', 'svg')}`, { type }), null, S.sel?.tagName === 'IMG' ? S.sel : null); }
        for (const t of ['text/html', 'text/plain']) if (item.types.includes(t)) {
          const txt = await (await item.getType(t)).text();
          const u = imageUrlFrom({ getData: (k) => (k === t ? txt : '') });
          if (u) { if (S.editing) stopEditQuiet(); return insertImageFrom(u, null, S.sel?.tagName === 'IMG' ? S.sel : null); }
        }
      }
    } catch (err) { diag('clipboard-read-failed', null, { error: String(err) }); toast('Could not read the clipboard here. Drop the image file onto the slide instead.', 'error'); }
  }, 120);
}
function onCanvasDrop(e) {
  if (!canTakeDrop(e)) return;
  e.preventDefault();
  diag('drop', e);
  const file = imageFileFrom(e.dataTransfer);
  const url = file ? null : imageUrlFrom(e.dataTransfer);
  if (!file && !url) return toast(dtTypes(e.dataTransfer).includes('Files') ? 'Drop an image file' : 'Nothing to insert: drop an image or an image file', 'error');
  const el = pick(e.target);
  if (el?.matches?.('figure.embed')) return toast(`This is an interactive embed; its picture is its poster. Update it with: slides poster ${D()} ${embedNameOf(el)}`, 'error');
  const img = el?.tagName === 'IMG' ? el : el?.querySelector?.(':scope > img');
  insertImageFrom(file || url, { x: e.clientX, y: e.clientY }, img || null);
}
// Dropping on the grey area around the slide (or the selection box on top of it) also inserts, at the centre.
const onStage = (e) => S.view === 'editor' && S.doc && e.target.closest?.('.stage-wrap');
function onStageDrop(e) {
  if (!canTakeDrop(e) || !onStage(e)) { if (dtTypes(e.dataTransfer).includes('Files') && !e.target.closest?.('input,textarea')) e.preventDefault(); return; }
  e.preventDefault();
  diag('drop-stage', e);
  const file = imageFileFrom(e.dataTransfer), url = file ? null : imageUrlFrom(e.dataTransfer);
  if (!file && !url) return toast('Drop an image or an image file', 'error');
  const r = E.iframe.getBoundingClientRect(), k = r.width / W;
  const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
  const inside = x >= 0 && y >= 0 && x <= W && y <= H;
  insertImageFrom(file || url, inside ? { x, y } : null, null);
}
document.addEventListener('dragover', (e) => {
  if (canTakeDrop(e) && onStage(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  else if (dtTypes(e.dataTransfer).includes('Files') && !e.target.closest?.('input,textarea')) e.preventDefault(); // never navigate away to a dropped file
});
document.addEventListener('drop', onStageDrop);
document.addEventListener('paste', (e) => { if (!e.target.closest?.('input,textarea')) onPaste(e); });
document.addEventListener('keydown', onPasteKey, true);

// ---------- keyboard
function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const openModal = $('.modal-back');
  if (openModal) { if (e.key === 'Escape') openModal.close?.(); return; }
  if (S.view !== 'editor') return;
  if (mod && key === 's') { e.preventDefault(); if (!S.editing) commit(); else commitSoon.flush?.(); flushSaves(); return; }
  const t = e.target;
  const inField = t && t.ownerDocument === document && t.closest?.('input, textarea, select');
  if (inField) return;
  if (S.editing) {
    if (e.key === 'Escape') { e.preventDefault(); const el = S.editing; stopEdit(); select(el); }
    return; // everything else is native text editing
  }
  if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && key === 'y') { e.preventDefault(); redo(); return; }
  if (mod && key === 'd') { e.preventDefault(); duplicateEl(); return; }
  if (mod || e.altKey) return;
  if (key === 'n') { e.preventDefault(); setNoteMode(!S.noteMode); return; }
  if (e.key === 'Escape' && (E.pop || S.noteMode)) { if (E.pop) closePop(); else setNoteMode(false); return; }
  const step = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case 'Delete': case 'Backspace': if (S.sel) { e.preventDefault(); deleteEl(); } break;
    case 'Enter': case 'F2': if (S.sel) { e.preventDefault(); const host = editHostFor(S.sel); if (host) startEdit(host); } break;
    case 'Escape': if (S.sel) { const p = S.sel.parentElement; select(p && p !== section() ? p : null); } break;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      e.preventDefault();
      if (S.sel) {
        const tr = getT(S.sel);
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        setT(S.sel, tr.x + dx, tr.y + dy);
        updateOverlay(); commitSoon();
      } else {
        const i = S.order.indexOf(S.current) + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1);
        if (S.order[i]) selectSlide(S.order[i]);
      }
      break;
    }
  }
}
document.addEventListener('keydown', onKey);

// ============================================================ history & saving
function serialize() {
  const sec = section().cloneNode(true);
  sec.querySelectorAll('iframe.embed-frame').forEach((f) => f.remove()); // live preview is never saved
  sec.querySelectorAll('figure.embed.live').forEach((f) => f.classList.remove('live'));
  for (const n of [sec, ...sec.querySelectorAll('[contenteditable], [spellcheck]')]) { n.removeAttribute('contenteditable'); n.removeAttribute('spellcheck'); }
  for (const n of [sec, ...sec.querySelectorAll('[style]')]) if (!n.getAttribute('style')?.trim()) n.removeAttribute('style');
  return sec.outerHTML;
}

function commit() {
  if (!S.doc || !S.current || !section()) return;
  const id = S.current;
  const html = serialize();
  if (norm(html) === norm(S.html[id])) return;
  S.html[id] = html;
  const H = (S.hist[id] ??= { stack: [html], i: 0 });
  H.stack.splice(H.i + 1);
  H.stack.push(html);
  if (H.stack.length > 300) H.stack.shift();
  H.i = H.stack.length - 1;
  queueSave(id);
  updateThumb(id);
  measureCanvasSoon();
  updateUndoButtons();
}
const commitSoon = debounce(commit, 500);
commitSoon.flush = () => { commitSoon.cancel(); commit(); };

function pathOf(el) {
  const sec = section(); const p = [];
  while (el && el !== sec) { if (!el.parentElement) return null; p.unshift([...el.parentElement.children].indexOf(el)); el = el.parentElement; }
  return el === sec ? p : null;
}
function byPath(p) { let el = section(); for (const i of p) { el = el?.children[i]; } return el && el !== section() ? el : null; }

function restore(html) {
  const p = S.sel ? pathOf(S.sel) : null;
  S.html[S.current] = html;
  setCanvasHtml(html, p);
  queueSave(S.current);
  updateThumb(S.current);
  renderInspector();
  updateUndoButtons();
}
function undo() {
  if (S.editing) stopEdit();
  else commitSoon.flush();
  const H = S.hist[S.current];
  if (!H || H.i <= 0) return;
  H.i--; restore(H.stack[H.i]);
}
function redo() {
  if (S.editing) stopEdit();
  const H = S.hist[S.current];
  if (!H || H.i >= H.stack.length - 1) return;
  H.i++; restore(H.stack[H.i]);
}
function updateUndoButtons() {
  const H = S.hist[S.current];
  if (E.undoBtn) E.undoBtn.disabled = !H || H.i <= 0;
  if (E.redoBtn) E.redoBtn.disabled = !H || H.i >= H.stack.length - 1;
}

const saveQ = new Set();
let saveTimer = null, saving = null;
function setSaveState(s) {
  if (!E.saveState) return;
  E.saveState.className = `save-state ${s}`;
  E.saveState.textContent = { saving: 'Saving…', saved: 'Saved', error: 'Save failed' }[s];
}
function queueSave(id) {
  saveQ.add(id);
  setSaveState('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 400);
}
async function flushSaves() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!saveQ.size || !D()) return;
  const deck = D();
  const ids = [...saveQ]; saveQ.clear();
  saving = (async () => {
    for (const id of ids) {
      const html = S.html[id];
      try {
        await api.put(`/api/decks/${deck}/slides/${id}`, { html });
        S.saved[id] = html;
      } catch (e) { setSaveState('error'); toast(`Could not save ${id}: ${e.message}`, 'error'); return; }
    }
    if (!saveQ.size) setSaveState('saved');
  })();
  await saving; saving = null;
}
addEventListener('beforeunload', (e) => { if (saveQ.size || S.editing) { commitSoon.flush?.(); flushSaves(); e.preventDefault(); } });

// ============================================================ overflow measurement
function measureDoc(doc) {
  const sec = doc?.querySelector('section.slide');
  if (!sec) return null;
  const sr = sec.getBoundingClientRect();
  const over = []; const flagged = new Set();
  for (const el of sec.querySelectorAll('*')) {
    if (el.closest('.notes')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.left - sr.left < -2 || r.top - sr.top < -2 || r.right - sr.left > W + 2 || r.bottom - sr.top > H + 2) {
      flagged.add(el);
      if (el.parentElement && flagged.has(el.parentElement)) continue;
      over.push(describe(el));
    }
  }
  return [...new Set(over)];
}
function recordOverflow(id, over) {
  if (!over) return;
  const prev = S.status[id]?.overflow || [];
  if (prev.join() === over.join()) return;
  S.status[id] = { ...(S.status[id] || {}), overflow: over };
  updateBadges();
  api.post(`/api/decks/${D()}/status`, { [id]: { overflow: over } }).catch(() => {});
}
const measureCanvasSoon = debounce(() => {
  if (!S.doc || !S.current) return;
  const over = measureDoc(S.doc);
  recordOverflow(S.current, over);
  E.status.replaceChildren(over?.length ? h('span', { class: 'chip warn', title: 'Content extends beyond the 1920×1080 slide' }, `⚠ Overflows slide: ${over.join(', ')}`) : '');
}, 300);
function measureThumb(id, iframe) {
  const doc = iframe.contentDocument;
  if (!doc) return;
  const run = () => recordOverflow(id, measureDoc(doc));
  (doc.fonts?.ready || Promise.resolve()).then(() => setTimeout(run, 50));
}

// ============================================================ overlay markers (comments)
function notePos(c) {
  if (c.x != null) return { x: c.x, y: c.y, pin: true };
  const el = c.target && section()?.querySelector(`[data-id="${CSS.escape(c.target)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.right, y: r.top, pin: false };
}
function renderMarkers() {
  if (!E.markers) return;
  const open = S.comments.filter((c) => c.slide === S.current && c.status !== 'resolved');
  const marks = open.map((c) => {
    const p = notePos(c);
    if (!p) return null;
    return h('div', {
      class: `marker ${p.pin ? 'pin' : ''} ${S.activeNote === c.id ? 'active' : ''}`, title: c.text,
      style: { left: `${p.x}px`, top: `${p.y}px` },
      onmousedown: (e) => { e.stopPropagation(); e.preventDefault(); openViewNote(c); },
    }, c.id);
  });
  if (S.pending) marks.push(h('div', { class: 'marker pin active', style: { left: `${S.pending.x}px`, top: `${S.pending.y}px` } }, '+'));
  E.markers.replaceChildren(...marks.filter(Boolean));
}

// ============================================================ note tool
function setNoteMode(on) {
  S.noteMode = !!on;
  if (!on) closePop();
  if (S.noteMode && S.editing) stopEdit();
  E.stageWrap?.classList.toggle('note-mode', S.noteMode);
  S.doc?.body.classList.toggle('note-mode', S.noteMode);
  if (E.modeChip) E.modeChip.hidden = !S.noteMode;
  E.noteBtn?.classList.toggle('on', S.noteMode);
  if (E.hover) E.hover.hidden = true;
}
function closePop() {
  if (!E.pop && !S.pending && !S.activeNote) return;
  E.pop?.remove();
  E.pop = null; S.popAt = null; S.pending = null; S.activeNote = null;
  renderMarkers();
}
/** Position a popover next to slide coordinate (x, y), kept inside the stage area. */
function placePop(pop, x, y) {
  S.popAt = { x, y };
  const wr = E.stageWrap.getBoundingClientRect();
  const sr = E.stage.getBoundingClientRect();
  const px = sr.left - wr.left + x * S.scale, py = sr.top - wr.top + y * S.scale;
  const w = pop.offsetWidth || 300, ht = pop.offsetHeight || 150;
  let left = px + 16;
  if (left + w > wr.width - 8) left = px - w - 16;
  const top = Math.max(8, Math.min(py - 20, wr.height - ht - 8));
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${top}px`;
}
function showPop(pop, x, y) {
  E.pop?.remove();
  E.pop = pop;
  E.stageWrap.append(pop);
  placePop(pop, x, y);
}
function openNewNote(x, y, el) {
  closePop();
  // empty space inside a layout wrapper (no text of its own) counts as "this spot on the slide", not the wrapper
  if (el && !el.matches('figure.embed, figure, img') && el.children.length && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) el = null;
  const snippet = el ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  S.pending = { x: Math.round(x), y: Math.round(y) };
  renderMarkers();
  const ta = h('textarea', { rows: 3, placeholder: 'What should change here?' });
  const save = async () => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    const at = S.pending;
    let target = null;
    if (el && el.isConnected) {
      if (!el.dataset.id) { el.dataset.id = uid(el.tagName.toLowerCase()); commit(); await flushSaves(); }
      target = el.dataset.id;
    }
    try {
      const c = await api.post(`/api/decks/${D()}/comments`, { slide: S.current, target, text, x: at.x, y: at.y, near: snippet || null });
      S.comments.push(c);
      closePop(); renderInspector(); updateBadges(); renderMarkers();
      toast(`Note ${c.id} added`, 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); closePop(); }
  });
  const pop = h('div', { class: 'note-pop' },
    h('div', { class: 'on' }, el ? ['On ', h('b', null, describe(el)), snippet ? ` — “${snippet}”` : ''] : 'On the slide background'),
    ta,
    h('div', { class: 'acts' }, h('span', { class: 'hint-k' }, 'Enter save · ⇧Enter newline'),
      btn('Cancel', () => closePop(), { cls: 'small ghost' }), btn('Add note', save, { cls: 'small primary' })));
  showPop(pop, x, y);
  ta.focus();
}
function openViewNote(c) {
  closePop();
  const p = notePos(c);
  if (!p) return;
  const el = c.target && section()?.querySelector(`[data-id="${CSS.escape(c.target)}"]`);
  if (el && !S.noteMode) select(el);
  S.activeNote = c.id;
  const update = async (patch) => {
    try { Object.assign(c, await api.put(`/api/decks/${D()}/comments/${c.id}`, patch)); closePop(); renderInspector(); updateBadges(); renderMarkers(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const pop = h('div', { class: 'note-pop' },
    h('div', { class: 'on' }, h('b', null, c.id), c.author === 'agent' ? ' · from the agent' : '', c.target ? [' · on ', h('b', null, `#${c.target}`)] : ''),
    h('div', { class: 'text' }, c.text),
    c.reply ? h('div', { class: 'reply' }, c.reply) : null,
    h('div', { class: 'acts' },
      btn('', async () => { await api.del(`/api/decks/${D()}/comments/${c.id}`); S.comments = S.comments.filter((x) => x.id !== c.id); closePop(); renderInspector(); updateBadges(); }, { cls: 'small ghost icon', ic: 'trash', title: 'Delete note' }),
      btn('Close', () => closePop(), { cls: 'small ghost' }),
      btn('Resolve', () => update({ status: 'resolved' }), { cls: 'small primary' })));
  showPop(pop, p.x, p.y);
  renderMarkers();
}

// ============================================================ inspector
function renderInspector() {
  if (!E.inspector) return;
  const scroll = E.inspector.scrollTop;
  E.inspector.replaceChildren(...[
    S.sel ? elementPanel(S.sel) : null,
    S.current ? slidePanel() : null,
    S.current ? chaptersPanel() : null,
    commentsPanel()].filter(Boolean));
  E.inspector.scrollTop = scroll;
}

const toHex = (c) => {
  const m = String(c).match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return '#000000';
  return '#' + m.slice(0, 3).map((n) => Math.round(+n).toString(16).padStart(2, '0')).join('');
};

function elementPanel(el) {
  const cs = S.doc.defaultView.getComputedStyle(el);
  const change = () => { updateOverlay(); commitSoon(); };
  const num = (label, prop, placeholder, unit = 'px') => {
    const inp = h('input', { type: 'number', step: unit ? 1 : 0.05, value: parseFloat(el.style[prop]) || '', placeholder: (unit ? Math.round(parseFloat(placeholder)) : '') || 'auto' });
    inp.addEventListener('input', () => { if (inp.value === '') el.style.removeProperty(prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())); else el.style[prop] = `${inp.value}${unit}`; change(); });
    return h('label', { class: 'field' }, h('span', null, label), inp);
  };
  const color = (label, prop) => {
    const inp = h('input', { type: 'color', value: toHex(cs[prop]) });
    inp.addEventListener('input', () => { el.style[prop] = inp.value; change(); });
    return h('div', { class: 'row', title: label }, inp, h('span', { class: 'muted', style: { flex: 1 } }, label),
      el.style[prop] ? btn('', () => { el.style[prop] = ''; commit(); renderInspector(); }, { cls: 'icon ghost small', ic: 'reset', title: 'Reset' }) : null);
  };
  const fmt = (cmd, ic, prop, on, off) => {
    const b = btn('', () => {
      if (S.editing) S.doc.execCommand(cmd);
      else { el.style[prop] = el.style[prop] === on ? off : on; }
      change();
    }, { cls: `icon small ${!S.editing && el.style[prop] === on ? 'on' : ''}`, ic, title: cmd });
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection in the slide
    return b;
  };
  const align = (val, ic) => btn('', () => { el.style.textAlign = el.style.textAlign === val ? '' : val; change(); renderInspector(); }, { cls: `icon small ${el.style.textAlign === val ? 'on' : ''}`, ic, title: `Align ${val}` });
  const t = getT(el);
  const tx = h('input', { type: 'number', value: t.x || '', placeholder: '0' });
  const ty = h('input', { type: 'number', value: t.y || '', placeholder: '0' });
  const applyT = () => { setT(el, Number(tx.value) || 0, Number(ty.value) || 0); change(); };
  tx.addEventListener('input', applyT); ty.addEventListener('input', applyT);
  const classIn = h('input', { type: 'text', value: el.getAttribute('class') || '', placeholder: 'classes (kicker, lede, card, accent, muted…)' });
  classIn.addEventListener('change', () => { if (classIn.value.trim()) el.setAttribute('class', classIn.value.trim()); else el.removeAttribute('class'); commit(); updateOverlay(); });

  const isImg = el.tagName === 'IMG';
  const isEmbed = el.matches('figure.embed');
  const isMedia = isImg || isEmbed;
  const live = isEmbed && !!el.querySelector(':scope > iframe.embed-frame');
  const host = editHostFor(el);
  const replaceIn = h('input', { type: 'file', accept: 'image/*', hidden: true });
  replaceIn.addEventListener('change', () => { if (replaceIn.files[0]) insertImageFile(replaceIn.files[0], null, el); });
  const fit = h('select', null, ['', 'cover', 'contain', 'fill'].map((v) => h('option', { value: v, selected: (el.style.objectFit || '') === v }, v || 'object-fit: default')));
  fit.addEventListener('change', () => { el.style.objectFit = fit.value; commit(); });

  return h('section', { class: 'panel' },
    h('h4', null, 'Selection', h('span', { class: 'grow' }),
      el.parentElement !== section() ? btn('', () => select(el.parentElement), { cls: 'icon ghost small', ic: 'up', title: 'Select parent (Esc)' }) : null),
    h('div', { class: 'el-name' }, describe(el)),
    isEmbed ? h('div', { class: 'field' },
      h('span', null, `Interactive embed · ${embedNameOf(el)}`),
      h('div', { class: 'muted', style: { fontSize: '12px', lineHeight: 1.45 } }, 'Shows its poster while you edit. It runs live when presenting and in exported files.'),
      h('div', { class: 'row' }, btn(live ? '■ Stop preview' : '▶ Live preview', () => toggleEmbedPreview(el), { cls: `small ${live ? 'on' : ''}`, title: 'Run it here for a quick look (not saved)' }))) : null,
    !isMedia ? h('div', { class: 'row wrap' },
      h('div', { class: 'btn-group' }, fmt('bold', 'bold', 'fontWeight', '700', ''), fmt('italic', 'italic', 'fontStyle', 'italic', ''), fmt('underline', 'underline', 'textDecoration', 'underline', '')),
      h('div', { class: 'btn-group' }, align('left', 'alignL'), align('center', 'alignC'), align('right', 'alignR'))) : null,
    !isMedia ? h('div', { class: 'row' }, num('Font size', 'fontSize', cs.fontSize), num('Line height', 'lineHeight', '', '')) : null,
    !isMedia ? color('Text color', 'color') : null,
    color('Background', 'backgroundColor'),
    h('div', { class: 'row' }, num('Width', 'width', el.getBoundingClientRect().width), num('Height', 'height', el.getBoundingClientRect().height)),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', null, 'Move X'), tx),
      h('label', { class: 'field' }, h('span', null, 'Move Y'), ty)),
    isImg ? h('div', { class: 'row' }, btn('Replace image…', () => replaceIn.click(), { ic: 'image' }), replaceIn) : null,
    isImg ? fit : null,
    h('label', { class: 'field' }, h('span', null, 'Classes'), classIn),
    buildField(el),
    h('div', { class: 'row wrap' },
      host && !S.editing ? btn('Edit text', () => startEdit(host), { cls: 'small' }) : null,
      btn('Reset layout', () => { setT(el, 0, 0); ['width', 'height', 'max-width', 'font-size', 'line-height', 'text-align'].forEach((p) => el.style.removeProperty(p)); commit(); updateOverlay(); renderInspector(); }, { cls: 'small', title: 'Remove manual position, size and font overrides' }),
      btn('Duplicate', () => duplicateEl(), { cls: 'small', title: '⌘D' }),
      btn('Delete', () => deleteEl(), { cls: 'small danger', title: 'Delete' })));
}

// ---------- click builds: data-build="N" makes the element appear on the Nth click when presenting
function buildField(el) {
  const cur = el.dataset.build || '';
  const max = Math.max(0, ...[...section().querySelectorAll('[data-build]')].map((e) => parseFloat(e.dataset.build) || 0));
  const opts = [['', 'Always visible'], ...Array.from({ length: max + 1 }, (_, k) => [String(k + 1), `Appears on click ${k + 1}`])];
  if (cur && !opts.some(([v]) => v === cur)) opts.push([cur, `Appears on click ${cur}`]);
  const sel = h('select', null, opts.map(([v, t]) => h('option', { value: v, selected: v === cur }, t)));
  sel.addEventListener('change', () => { if (sel.value) el.dataset.build = sel.value; else { delete el.dataset.build; delete el.dataset.buildEffect; } commit(); renderInspector(); });
  const eff = h('select', { disabled: !cur }, [['', 'Pop in'], ['fade', 'Fade in'], ['zoom', 'Zoom in (from transform-origin)']].map(([v, t]) => h('option', { value: v, selected: (el.dataset.buildEffect || '') === v }, t)));
  eff.addEventListener('change', () => { if (eff.value) el.dataset.buildEffect = eff.value; else delete el.dataset.buildEffect; commit(); });
  return h('label', { class: 'field' }, h('span', null, 'Animation (present mode)'), h('div', { class: 'row' }, sel, eff));
}

// ---------- interactive embeds: optional live preview (off by default, never saved)
const embedNameOf = (fig) => (String(fig.dataset.src || '').match(/assets\/embeds\/([^/]+)\//) || [])[1] || 'embed';
function toggleEmbedPreview(fig) {
  const cur = fig.querySelector(':scope > iframe.embed-frame');
  if (cur) { cur.remove(); fig.classList.remove('live'); }
  else if (fig.dataset.src) {
    const f = S.doc.createElement('iframe');
    f.className = 'embed-frame';
    f.setAttribute('sandbox', 'allow-scripts');
    f.title = 'live preview';
    f.src = `/embed/${D()}/${fig.dataset.src}`;
    fig.appendChild(f);
  }
  renderInspector();
}
function embedTheme(fig) {
  const names = new Set(), fonts = [];
  const walk = (rules) => { for (const r of rules) {
    if (r.selectorText && /\.slide\b/.test(r.selectorText)) for (const p of r.style) if (p.startsWith('--')) names.add(p);
    if (r.constructor.name === 'CSSFontFaceRule') {
      const base = r.parentStyleSheet?.href || S.doc.baseURI;
      fonts.push(r.cssText.replace(/url\((["']?)([^)"']+)\1\)/g, (m, q, u) => (/^(data|blob|https?):/i.test(u) ? m : `url("${new URL(u, base).href}")`)));
    }
    if (r.cssRules && !r.selectorText) walk(r.cssRules);
  } };
  for (const sh of S.doc.styleSheets) { try { walk(sh.cssRules); } catch {} }
  const cs = S.doc.defaultView.getComputedStyle(fig), vars = {};
  for (const n of names) vars[n] = cs.getPropertyValue(n).trim();
  return { __embed: 1, type: 'theme', vars, fontCss: fonts.join('\n'), colorScheme: cs.colorScheme || 'light' };
}
function onEmbedMessage(e) {
  const m = e.data;
  if (!m || !m.__embed || !S.doc) return;
  const f = [...S.doc.querySelectorAll('iframe.embed-frame')].find((x) => x.contentWindow === e.source);
  if (!f) return;
  if (m.type === 'hello') e.source.postMessage(embedTheme(f.parentElement), '*');
  else if (m.type === 'ready') f.parentElement.classList.add('live');
  else if (m.type === 'error') toast(`Embed error: ${m.message}`, 'error');
  // 'key' messages are ignored here: arrow keys in the editor nudge the selection
}

function slidePanel() {
  const id = S.current;
  const sec = section();
  const notesEl = sec?.querySelector(':scope > .notes');
  const notes = h('textarea', { rows: 4, placeholder: 'Speaker notes (press N while presenting)' });
  notes.value = notesEl ? notesEl.textContent.trim() : '';
  notes.addEventListener('input', () => {
    let a = section().querySelector(':scope > .notes');
    if (!a) { a = S.doc.createElement('aside'); a.className = 'notes'; section().append(a); }
    a.textContent = notes.value;
    commitSoon();
  });
  const idIn = h('input', { type: 'text', value: id });
  idIn.addEventListener('change', async () => {
    const nid = slug(idIn.value);
    if (!nid || nid === id) { idIn.value = id; return; }
    try { await flushSaves(); await api.post(`/api/decks/${D()}/slides/${id}/rename`, { id: nid }); S.hist[nid] = S.hist[id]; delete S.hist[id]; await reloadDeck(nid); }
    catch (e) { toast(e.message, 'error'); idIn.value = id; }
  });
  const bg = h('input', { type: 'color', value: toHex(S.doc?.defaultView.getComputedStyle(sec).backgroundColor || '#fff') });
  bg.addEventListener('input', () => { section().style.background = bg.value; commitSoon(); });
  const over = S.status[id]?.overflow || [];
  // chapter = which timeline item (<nav class="toc">) this slide belongs to (data-section="N")
  const toc = sec?.querySelector('.toc');
  let chapter = null;
  if (toc) {
    const cur = sec.dataset.section || '';
    const labels = [...toc.children].map((c, k) => c.textContent.trim() || `Item ${k + 1}`);
    const sel = h('select', null, [h('option', { value: '', selected: !cur }, '— none —'),
      ...labels.map((l, k) => h('option', { value: String(k + 1), selected: cur === String(k + 1) }, `${k + 1}. ${l}`))]);
    sel.addEventListener('change', () => { if (sel.value) section().dataset.section = sel.value; else delete section().dataset.section; commit(); renderInspector(); });
    chapter = h('label', { class: 'field', title: 'Highlights this item in the timeline. Editing the timeline text on any slide updates every slide.' }, h('span', null, 'Chapter (timeline)'), sel);
  }
  return h('section', { class: 'panel' },
    h('h4', null, `Slide ${S.order.indexOf(id) + 1} of ${S.order.length}`),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', null, 'Slide id (file name)'), idIn),
      h('label', { class: 'field', style: { flex: '0 0 auto' } }, h('span', null, 'Layout'), h('div', { class: 'el-name', style: { padding: '7px 0' } }, sec?.dataset.layout || '—'))),
    chapter,
    over.length ? h('div', { class: 'chip warn' }, `⚠ Overflows: ${over.join(', ')}`) : null,
    h('div', { class: 'row' }, bg, h('span', { class: 'muted', style: { flex: 1 } }, 'Slide background'),
      sec?.style.background ? btn('', () => { section().style.removeProperty('background'); commit(); renderInspector(); }, { cls: 'icon ghost small', ic: 'reset', title: 'Reset to theme' }) : null),
    h('label', { class: 'field' }, h('span', null, 'Speaker notes'), notes),
    h('div', { class: 'row wrap' },
      btn('Edit HTML', () => htmlModal(), { cls: 'small', ic: 'code' }),
      btn('Save as layout', () => saveLayoutModal(), { cls: 'small', title: 'Reuse this slide as a template layout' }),
      btn('Duplicate', () => duplicateSlide(id), { cls: 'small' }),
      btn('Delete', () => deleteSlide(id), { cls: 'small danger' })));
}

// ---------- chapters: the deck's section timeline (<nav class="toc">), edited for every slide at once
const TOC_HTML_RE = /<nav\b[^>]*\bclass\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i;
function deckChapters() {
  for (const id of [S.current, ...S.order]) {
    const m = (S.html[id] || '').match(TOC_HTML_RE);
    if (m) return [...m[1].matchAll(/<(\w+)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((x) => x[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim());
  }
  return null;
}
const slideChapter = (id) => ((S.html[id] || '').match(/^\s*<section\b[^>]*\bdata-section\s*=\s*["'](\d+)["']/i) || [])[1];
async function applyChapters(labels, map) {
  try {
    if (S.editing) stopEditQuiet();
    commit(); await flushSaves();
    await api.put(`/api/decks/${D()}/chapters`, { labels, map });
    await syncFromDisk(['slides']);
    renderInspector();
  } catch (e) { toast(e.message, 'error'); }
}
function chaptersPanel() {
  const labels = deckChapters();
  if (!labels) return null;
  const n = labels.length, MAX = 8;
  const ident = () => labels.map((_, k) => k);
  const counts = labels.map((_, k) => S.order.filter((id) => slideChapter(id) === String(k + 1)).length);
  const cur = slideChapter(S.current);
  const rows = labels.map((label, k) => {
    const inp = h('input', { type: 'text', value: label, placeholder: `Chapter ${k + 1}` });
    inp.addEventListener('change', () => { const v = inp.value.trim() || `Chapter ${k + 1}`; if (v === label) return; const next = [...labels]; next[k] = v; applyChapters(next, ident()); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    const move = (dir) => { const j = k + dir; const next = [...labels]; [next[k], next[j]] = [next[j], next[k]]; const map = ident(); map[k] = j; map[j] = k; applyChapters(next, map); };
    const remove = () => {
      if (counts[k] && !confirm(`Remove "${label}"? Its ${counts[k]} slide${counts[k] > 1 ? 's' : ''} move to ${k ? `"${labels[k - 1]}"` : 'no chapter'}.`)) return;
      const map = ident().map((i) => (i === k ? -1 : i > k ? i - 1 : i));
      applyChapters(labels.filter((_, i) => i !== k), map);
    };
    return h('div', { class: `chapter-row ${cur === String(k + 1) ? 'current' : ''}` },
      h('span', { class: 'chapter-num', title: cur === String(k + 1) ? 'This slide is in this chapter' : '' }, String(k + 1)),
      inp,
      h('span', { class: 'chapter-count muted', title: 'Slides in this chapter' }, String(counts[k])),
      btn('↑', () => move(-1), { cls: 'icon ghost small', title: 'Move up' }),
      btn('↓', () => move(1), { cls: 'icon ghost small', title: 'Move down' }),
      btn('×', remove, { cls: 'icon ghost small', title: 'Remove chapter' }));
  });
  rows.forEach((r, k) => { const b = r.querySelectorAll('button'); b[0].disabled = k === 0; b[1].disabled = k === n - 1; b[2].disabled = n === 1; });
  const add = btn('+ Add chapter', () => applyChapters([...labels, `Chapter ${n + 1}`], ident()), { cls: 'small', title: n >= MAX ? `The theme styles up to ${MAX} chapters` : 'Add a chapter at the end' });
  add.disabled = n >= MAX;
  return h('section', { class: 'panel' },
    h('h4', null, 'Chapters (timeline)'),
    h('div', { class: 'chapter-list' }, rows),
    h('div', { class: 'row' }, add),
    h('div', { class: 'muted', style: { fontSize: '12px', lineHeight: 1.45 } }, 'Changes apply to every slide. Moving or removing a chapter keeps each slide in its chapter. Choose this slide’s chapter in the slide panel above.'));
}

function commentsPanel() {
  const forSlide = S.showAllComments ? S.comments : S.comments.filter((c) => c.slide === S.current);
  const list = [...forSlide].sort((a, b) => (a.status === 'resolved') - (b.status === 'resolved'));
  const openCount = S.comments.filter((c) => c.status !== 'resolved').length;
  const ta = h('textarea', { rows: 3, placeholder: S.sel ? `Ask the agent to change ${describe(S.sel)}…` : 'Ask the agent to change this slide…' });
  const attach = h('input', { type: 'checkbox', checked: !!S.sel });
  const add = async () => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    let target = null;
    if (attach.checked && S.sel) {
      if (!S.sel.dataset.id) { S.sel.dataset.id = uid(S.sel.tagName.toLowerCase()); commit(); await flushSaves(); }
      target = S.sel.dataset.id;
    }
    try {
      const c = await api.post(`/api/decks/${D()}/comments`, { slide: S.current, target, text });
      S.comments.push(c);
      renderInspector(); updateBadges(); updateOverlay();
    } catch (e) { toast(e.message, 'error'); }
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } });

  const prompt = `Address the open slide comments in deck "${D()}" (node bin/slides.mjs comments ${D()}). Resolve each one with a short reply.`;
  return h('section', { class: 'panel comments-panel' },
    h('h4', null, 'Notes for the agent', openCount ? h('span', { class: 'count' }, openCount) : null, h('span', { class: 'grow' }),
      h('label', { class: 'row muted', style: { gap: '4px', textTransform: 'none', letterSpacing: 0, fontWeight: 500 } },
        h('input', { type: 'checkbox', checked: S.showAllComments, onchange: (e) => { S.showAllComments = e.target.checked; renderInspector(); } }), 'all slides')),
    S.current ? h('div', { class: 'field' }, ta,
      h('div', { class: 'row' },
        S.sel ? h('label', { class: 'row muted', style: { gap: '4px', flex: 1 } }, attach, `pin to ${describe(S.sel)}`) : h('span', { style: { flex: 1 } }),
        btn('Add note', add, { cls: 'small primary', title: '⌘Enter' }))) : null,
    list.length ? list.map(commentView) : h('div', { class: 'empty' }, S.showAllComments ? 'No notes in this deck.' : 'No notes on this slide. Press N (or the Note button) and click anywhere on the slide, or type one here.'),
    openCount ? h('div', { class: 'agent-help' }, 'Then tell your agent: ', h('code', null, prompt), ' ',
      btn('Copy', () => copy(prompt), { cls: 'small', ic: 'copy' })) : null);
}

function commentView(c) {
  const resolved = c.status === 'resolved';
  const update = async (patch) => {
    try { const n = await api.put(`/api/decks/${D()}/comments/${c.id}`, patch); Object.assign(c, n); renderInspector(); updateBadges(); renderMarkers(); }
    catch (e) { toast(e.message, 'error'); }
  };
  return h('div', { class: `comment ${resolved ? 'resolved' : ''}` },
    h('div', { class: 'head' },
      h('span', { class: 'id' }, c.id),
      c.author === 'agent' ? h('span', null, '· agent') : null,
      S.showAllComments && c.slide ? h('span', { class: 'target', onclick: () => selectSlide(c.slide) }, c.slide) : null,
      c.target ? h('span', { class: 'target', onclick: () => { if (c.slide !== S.current) selectSlide(c.slide); const el = section()?.querySelector(`[data-id="${CSS.escape(c.target)}"]`); if (el) select(el); } }, `#${c.target}`) : null,
      c.x != null && c.status !== 'resolved' ? h('span', { class: 'target', title: 'Show on slide', onclick: () => { if (c.slide !== S.current) selectSlide(c.slide); openViewNote(c); } }, '📍') : null,
      h('span', { style: { flex: 1 } }), resolved ? '✓ resolved' : 'open'),
    h('div', { class: 'body' }, c.text),
    c.reply ? h('div', { class: 'reply' }, c.reply) : null,
    h('div', { class: 'acts' },
      btn(resolved ? 'Reopen' : 'Resolve', () => update({ status: resolved ? 'open' : 'resolved' }), { cls: 'small ghost' }),
      btn('', async () => { await api.del(`/api/decks/${D()}/comments/${c.id}`); S.comments = S.comments.filter((x) => x.id !== c.id); renderInspector(); updateBadges(); renderMarkers(); }, { cls: 'small ghost icon', ic: 'trash', title: 'Delete note' })));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); }
  catch { const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied', 'ok'); }
}

// ============================================================ modals
function modal({ title, body, actions = [], wide = false }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => back.remove();
  back.close = close;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.append(h('div', { class: `modal ${wide ? 'wide' : ''}` },
    h('header', null, h('h3', null, title), btn('✕', close, { cls: 'ghost icon' })),
    h('div', { class: 'body' }, body),
    actions.length ? h('footer', null, actions) : null));
  document.body.append(back);
  return { close, el: back };
}

function codeArea(value) {
  const ta = h('textarea', { class: 'code-area', spellcheck: 'false' });
  ta.value = value;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
  });
  return ta;
}

function htmlModal() {
  commitSoon.flush();
  if (S.editing) stopEdit();
  const ta = codeArea(S.html[S.current]);
  const m = modal({
    title: `Edit HTML — ${S.current}.html`, body: ta, wide: true,
    actions: [btn('Cancel', () => m.close(), { cls: 'ghost' }), btn('Apply', () => {
      S.doc.body.innerHTML = ta.value;
      ensureSection();
      S.sel = null;
      commit();
      afterCanvasRender();
      renderInspector();
      m.close();
    }, { cls: 'primary' })],
  });
  ta.focus();
}

async function themeCssModal() {
  const { css } = await api.get(`/api/decks/${D()}/theme`);
  const ta = codeArea(css);
  const m = modal({
    title: `Theme CSS — decks/${D()}/theme.css`, wide: true,
    body: h('div', { class: 'stack', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div', { class: 'muted' }, 'Set the variables on .slide (--bg, --fg, --accent, --font-head…) or add any CSS. Layout classes live in core/slides.css.'), ta),
    actions: [btn('Cancel', () => m.close(), { cls: 'ghost' }), btn('Save', async () => {
      try { await api.put(`/api/decks/${D()}/theme`, { css: ta.value }); reloadTheme(); m.close(); toast('Theme saved', 'ok'); }
      catch (e) { toast(e.message, 'error'); }
    }, { cls: 'primary' })],
  });
}

function saveLayoutModal() {
  commitSoon.flush();
  const name = h('input', { type: 'text', placeholder: 'layout-name', value: section()?.dataset.layout && section().dataset.layout !== 'custom' ? `${section().dataset.layout}-custom` : '' });
  const desc = h('input', { type: 'text', placeholder: 'When to use this layout (agents read this)' });
  const m = modal({
    title: 'Save slide as layout',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('div', { class: 'muted' }, `Saves this slide to templates/layouts/${S.deck.theme}/ so you and agents can add new slides from it in any "${S.deck.theme}" deck.`),
      h('label', { class: 'field' }, h('span', null, 'Name'), name),
      h('label', { class: 'field' }, h('span', null, 'Description'), desc)),
    actions: [btn('Cancel', () => m.close(), { cls: 'ghost' }), btn('Save layout', async () => {
      try {
        const r = await api.post('/api/layouts', { name: name.value || 'custom', description: desc.value, html: S.html[S.current], theme: S.deck.theme });
        S.layouts = await api.get(`/api/layouts?theme=${encodeURIComponent(S.deck.theme)}`);
        m.close(); toast(`Saved layout "${r.name}"`, 'ok');
      } catch (e) { toast(e.message, 'error'); }
    }, { cls: 'primary' })],
  });
  name.focus();
}

let INFO = null;
async function agentModal() {
  INFO ||= await api.get('/api/info').catch(() => ({}));
  const root = INFO.root || '<repo>', dd = INFO.decksDir || `${root}/decks`;
  const d = D();
  const deck = d || '<deck>';
  const where = `Slide editor repo: ${root}` + (INFO.host ? ` (on ${INFO.host})` : '') + `\n` +
    `Read ${root}/AGENTS.md first (and AGENTS.local.md if it exists), including "Several agents at once". ` +
    `Run commands from the repo folder: node bin/slides.mjs help.`;
  const join = d
    ? `${where}\n\nYou're joining deck "${d}": ${dd}/${d}/ (slides in slides/<id>.html, order in deck.json, theme "${S.deck?.theme || ''}"). ` +
      `Other agents and I may be editing the same deck right now; the editor at ${INFO.url || 'http://127.0.0.1:4173'} live-reloads on every save.\n` +
      `1. Orient: node bin/slides.mjs outline ${d}  and  node bin/slides.mjs layouts ${d}.\n` +
      `2. Add slides only with the CLI (never hand-edit deck.json): node bin/slides.mjs add ${d} --layout <name> --title "…" --after <id> — it prints the file to write into.\n` +
      `3. Only edit the slides you create or that I assign to you. Re-read a slide file right before changing it and make targeted edits, not whole-file rewrites.\n` +
      `4. Check your slides: node bin/slides.mjs check ${d}  and  node bin/slides.mjs render ${d} <id>, look at the PNG, fix, repeat.\n\n` +
      `Task: <what to add — e.g. 3 slides on X after slide <id>>`
    : `${where}\n\nDecks live in ${dd}/<deck>/. List them with node bin/slides.mjs decks. Other agents may be editing at the same time; follow the multi-agent rules in AGENTS.md.\n\nTask: <what to do>`;
  const prompts = [
    ['Join this deck (new agent)', join, true],
    ['Create a deck', `${where}\n\nCreate a new HTML slide deck about <topic> for <audience>, ~10 slides, theme "clean". Use node bin/slides.mjs to scaffold slides from layouts, write the content directly into the slide files, then run "node bin/slides.mjs check" and "render --sheet" and fix anything that overflows or looks off.`],
    ['Address my notes', `${where}\n\nAddress the open slide comments in deck "${deck}" (node bin/slides.mjs comments ${deck}). Edit the slide files directly, then resolve each comment with a one-line reply describing what you changed.`],
    ['Review & polish', `${where}\n\nReview deck "${deck}": run node bin/slides.mjs check ${deck} and node bin/slides.mjs render ${deck} --sheet, look at the rendered image, then tighten wording, fix overflow and inconsistent styling. Don't change slides I've marked as final in the notes.`],
    ['Restyle', `${where}\n\nRestyle deck "${deck}" by editing ${dd}/${deck}/theme.css only (colors, fonts, flourishes). Keep layouts intact. Render a sheet before and after.`],
  ];
  modal({
    title: 'Working with agents',
    wide: true,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'muted', style: { lineHeight: 1.5 } }, 'Agents edit the same files you do, and this editor live-reloads when they save. Several agents can work on one deck at once. Start each one anywhere (Claude Code, etc.) and paste a prompt. It says where the files are, so the agent can run in any folder:'),
      prompts.map(([t, p, main]) => h('div', { class: 'comment' },
        h('div', { class: 'row' }, h('b', { style: { flex: 1 } }, t), btn('Copy', () => copy(p), { cls: main ? 'small primary' : 'small', ic: 'copy' })),
        h('div', { class: 'body muted', style: { whiteSpace: 'pre-wrap' } }, p)))),
  });
}

// ============================================================ theme reload
function reloadTheme() {
  S.themeV = Date.now();
  const href = `/decks/${D()}/theme.css?v=${S.themeV}`;
  const swap = (doc) => { const l = doc?.getElementById('theme-css'); if (l) l.href = href; };
  swap(S.doc);
  for (const t of thumbs.values()) swap(t.iframe.contentDocument);
  setTimeout(() => { updateOverlay(); measureCanvasSoon(); for (const [id, t] of thumbs) measureThumb(id, t.iframe); }, 400);
}

// ============================================================ live sync with disk
function showConflict(id, diskHtml) {
  E.banner.hidden = false;
  E.banner.replaceChildren(
    h('span', null, `"${id}" changed on disk (agent?) while you were editing.`),
    btn('Load disk version', () => { stopEditQuiet(); S.saved[id] = diskHtml; saveQ.delete(id); applyExternal(id, diskHtml); hideBanner(); }, { cls: 'small primary' }),
    btn('Keep mine', () => { S.saved[id] = diskHtml; queueSave(id); hideBanner(); }, { cls: 'small' }));
}
function hideBanner() { if (E.banner) E.banner.hidden = true; }
function stopEditQuiet() { if (S.editing) { S.editing.removeAttribute('contenteditable'); S.editing = null; } }

function applyExternal(id, html) {
  S.html[id] = html;
  const H = (S.hist[id] ??= { stack: [html], i: 0 });
  if (norm(H.stack[H.i]) !== norm(html)) { H.stack.splice(H.i + 1); H.stack.push(html); H.i = H.stack.length - 1; }
  if (id === S.current) { setCanvasHtml(html, S.sel ? pathOf(S.sel) : null); renderInspector(); updateUndoButtons(); }
  updateThumb(id);
  flashThumb(id);
}

async function syncFromDisk(files) {
  if (files.every((f) => f.startsWith('assets/'))) return;
  let deck;
  try { deck = await api.get(`/api/decks/${D()}`); } catch { return; }
  if (deck.name !== D()) return;
  if (files.includes('theme.css')) reloadTheme();
  if (deck.title !== S.deck.title) { S.deck.title = deck.title; const ti = $('.title-input'); if (ti && document.activeElement !== ti) ti.value = deck.title; }
  S.deck.theme = deck.theme;
  const commentsChanged = JSON.stringify(deck.comments) !== JSON.stringify(S.comments);
  S.comments = deck.comments;

  let structural = false;
  const changedOthers = [];
  for (const { id, html } of deck.slides) {
    if (S.html[id] == null) { S.html[id] = html; S.saved[id] = html; structural = true; flashLater(id); continue; }
    if (norm(html) === norm(S.html[id]) || norm(html) === norm(S.saved[id])) continue;
    if (id === S.current && (S.editing || saveQ.has(id))) { showConflict(id, html); continue; }
    S.saved[id] = html;
    applyExternal(id, html);
    changedOthers.push(id);
  }
  const ids = deck.slides.map((s) => s.id);
  if (ids.join('|') !== S.order.join('|')) structural = true;
  for (const id of Object.keys(S.html)) if (!ids.includes(id)) { delete S.html[id]; delete S.saved[id]; delete S.hist[id]; }
  S.order = ids;
  if (structural) {
    renderList();
    if (!ids.includes(S.current)) { S.current = null; selectSlide(ids[0]); }
  } else if (commentsChanged) updateBadges();
  if (changedOthers.includes(S.current)) toast('Slide updated from disk', 'ok');
  if (commentsChanged && !E.inspector.contains(document.activeElement)) { renderInspector(); renderMarkers(); }
}
function flashLater(id) { setTimeout(() => flashThumb(id), 50); }

let evChain = Promise.resolve();
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    evChain = evChain.then(async () => {
      if (S.view === 'home') refreshHomeSoon();
      else if (S.view === 'editor' && m.deck === D()) await syncFromDisk(m.files);
    }).catch((err) => console.error(err));
  };
}

// ============================================================ router
async function route() {
  const m = location.hash.match(/^#\/deck\/([^/]+)(?:\/([^/]+))?/);
  if (m) await openDeck(decodeURIComponent(m[1]), m[2] && decodeURIComponent(m[2]));
  else { if (S.view === 'editor') await flushSaves(); await showHome(); }
}
addEventListener('hashchange', route);
connectEvents();
route();
