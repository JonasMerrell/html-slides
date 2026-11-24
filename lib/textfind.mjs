// Find / replace in the visible text of slide HTML, without touching markup.
//
// A small tokenizer walks the file (comments, tags with quoted attributes, raw-text elements) and yields only the
// text between tags. Matches are found per text node in its decoded form (so "AT&T" finds "AT&amp;T"), and a
// replacement rewrites exactly the raw bytes of the match: everything else in the file stays byte-for-byte.
// The same rules are used by the editor (public/app.js, on the DOM) so both find the same things.
//
// Skipped: attributes, <script>/<style>/<template>, equations (.math — their LaTeX is in data-tex), embeds
// (figure.embed), the chapter timeline (nav.toc: use `slides toc --set`), and speaker notes (aside.notes) unless
// notes: true. A match never spans two text nodes (e.g. across <b>…</b>); runs of whitespace in the query match
// any whitespace, since the source wraps lines where the slide doesn't.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', minus: '−', middot: '·', deg: '°', plusmn: '±', micro: 'µ', copy: '©', reg: '®', trade: '™', larr: '←', rarr: '→', uarr: '↑', darr: '↓', le: '≤', ge: '≥', ne: '≠', asymp: '≈', thinsp: ' ', ensp: ' ', emsp: ' ', shy: '­', bull: '•', laquo: '«', raquo: '»', sect: '§', para: '¶', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', infin: '∞', sum: '∑', radic: '√', prime: '′', Prime: '″' };

/** Class list of a start tag's raw text. */
function classesOf(tag) {
  const m = tag.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/).filter(Boolean) : [];
}
/** Does this start tag open a region whose text isn't searchable? */
export function skipTag(name, tag, { notes = false } = {}) {
  if (name === 'script' || name === 'style' || name === 'template') return true;
  const cls = classesOf(tag);
  if (cls.includes('math') || cls.includes('katex')) return true;
  if (name === 'figure' && cls.includes('embed')) return true;
  if (name === 'nav' && cls.includes('toc')) return true;
  if (!notes && cls.includes('notes')) return true;
  return false;
}

/** Text nodes of an HTML string: [{start, end, raw}] for searchable text only (raw byte offsets). */
export function textNodes(html, opts = {}) {
  const out = [];
  const stack = []; // open element names
  let skipDepth = -1; // stack length at which a skipped region started
  let i = 0;
  const n = html.length;
  const pushText = (a, b) => { if (b > a && skipDepth < 0) out.push({ start: a, end: b, raw: html.slice(a, b) }); };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { pushText(i, n); break; }
    if (lt > i) pushText(i, lt);
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(lt, lt + 64));
    if (!m) { pushText(lt, lt + 1); i = lt + 1; continue; } // a bare "<" in text
    // end of the tag, honouring quoted attribute values (which may contain ">")
    let j = lt + m[0].length, q = null;
    for (; j < n; j++) { const c = html[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    const tag = html.slice(lt, j + 1);
    i = j + 1;
    const name = m[2].toLowerCase();
    if (m[1]) { // end tag: pop to the matching element (tolerant of unclosed ones)
      const k = stack.lastIndexOf(name);
      if (k >= 0) { stack.length = k; if (skipDepth >= 0 && stack.length <= skipDepth) skipDepth = -1; }
      continue;
    }
    const selfClose = /\/\s*>$/.test(tag);
    if (VOID.has(name) || selfClose) continue;
    if (skipDepth < 0 && skipTag(name, tag, opts)) skipDepth = stack.length;
    stack.push(name);
    if (RAW.has(name)) { // raw text up to its end tag; never searched except <textarea>/<title>, which we skip too
      const re = new RegExp(`</${name}\\s*>`, 'ig'); re.lastIndex = i;
      const e = re.exec(html);
      i = e ? e.index + e[0].length : n;
      stack.pop(); if (skipDepth >= 0 && stack.length <= skipDepth) skipDepth = -1;
    }
  }
  return out;
}

/** Decode a raw text node; map[k] = raw offset of decoded char k (map[len] = raw length). */
export function decode(raw) {
  let s = ''; const map = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '&') {
      const m = /^&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/i.exec(raw.slice(i, i + 12));
      let ch = null;
      if (m) {
        const e = m[1];
        if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); if (cp > 0 && cp <= 0x10ffff) ch = String.fromCodePoint(cp); }
        else if (NAMED[e] != null) ch = NAMED[e];
      }
      if (ch != null) { for (const c of ch) { map.push(i); s += c; } i += m[0].length; continue; }
    }
    const cp = raw.codePointAt(i); const c = String.fromCodePoint(cp);
    for (let k = 0; k < c.length; k++) map.push(i);
    s += c; i += c.length;
  }
  map.push(raw.length);
  return { text: s, map };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The search regex shared with the editor: whitespace runs match any whitespace; optional case and whole word. */
export function queryRegex(query, { caseSensitive = false, word = false } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  let src = q.split(/\s+/).map(escRe).join('\\s+');
  if (word) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, 'gu' + (caseSensitive ? '' : 'i'));
}

/** Matches in one slide: [{start, end (raw offsets), match, context}]. */
export function findInHtml(html, query, opts = {}) {
  const re = queryRegex(query, opts);
  if (!re) return [];
  const out = [];
  for (const node of textNodes(html, opts)) {
    const { text, map } = decode(node.raw);
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) {
      if (!m[0]) { re.lastIndex++; continue; }
      const a = m.index, b = a + m[0].length;
      const pre = text.slice(Math.max(0, a - 40), a).replace(/\s+/g, ' ').trimStart();
      const post = text.slice(b, b + 40).replace(/\s+/g, ' ').trimEnd();
      out.push({ start: node.start + map[a], end: node.start + map[b], match: m[0], context: { before: (a > 40 ? '…' : '') + pre, match: m[0].replace(/\s+/g, ' '), after: post + (b + 40 < text.length ? '…' : '') } });
    }
  }
  return out;
}

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Replace every match (or the first `limit`); returns {html, count}. Only the matched bytes change. */
export function replaceInHtml(html, query, replacement, opts = {}) {
  let hits = findInHtml(html, query, opts);
  if (opts.limit != null) hits = hits.slice(0, opts.limit);
  if (!hits.length) return { html, count: 0 };
  const rep = escText(replacement ?? '');
  let out = '', at = 0;
  for (const h of hits) { out += html.slice(at, h.start) + rep; at = h.end; }
  return { html: out + html.slice(at), count: hits.length };
}
