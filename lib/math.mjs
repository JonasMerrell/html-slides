// Equations. A slide stores each equation's LaTeX in data-tex and the KaTeX rendering as its children:
//   <span class="math" data-tex="E = mc^2">…KaTeX HTML…</span>          inline
//   <div class="math display" data-tex="\int_0^1 f">…</div>               display (centred, own line)
// The rendering is (re)done here whenever a slide is written through the store, so slides stay static
// (no scripts); showing them only needs vendor/katex/katex.min.css and its fonts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KATEX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'katex');

let K = null;
function katex() {
  if (K) return K;
  const src = fs.readFileSync(path.join(KATEX_DIR, 'katex.min.js'), 'utf8');
  const module = { exports: {} };
  new Function('module', 'exports', 'self', src)(module, module.exports, globalThis); // UMD → CommonJS branch
  return (K = module.exports.default || module.exports);
}

/** Options shared with the editor's preview (public/app.js uses the same ones, so the HTML is identical). */
export const KATEX_OPTS = { output: 'html', throwOnError: false, strict: 'ignore', trust: false };

export function renderTex(tex, display = false) {
  return katex().renderToString(String(tex), { ...KATEX_OPTS, displayMode: !!display });
}
/** null if the LaTeX parses, else KaTeX's message. */
export function texError(tex) {
  try { katex().renderToString(String(tex), { ...KATEX_OPTS, throwOnError: true }); return null; }
  catch (e) { return String(e.message || e).replace(/^KaTeX parse error: /, ''); }
}

const ENT = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ', '#39': "'" };
const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
  return ENT[e] ?? m;
});
const OPEN_RE = /<(span|div)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? unent(m[1] ?? m[2] ?? m[3]) : null;
};

/** Every equation element in html: { start, innerStart, innerEnd, end, tex, display, inner }. */
export function findMath(html) {
  html = String(html ?? '');
  const out = [];
  OPEN_RE.lastIndex = 0;
  let m;
  while ((m = OPEN_RE.exec(html))) {
    const [open, tag, attrs] = m;
    const tex = attr(attrs, 'data-tex');
    const cls = ` ${attr(attrs, 'class') || ''} `.replace(/\s+/g, ' ');
    if (tex == null || !cls.includes(' math ')) continue;
    // find the matching close tag (KaTeX output nests spans, so count depth)
    const re = new RegExp(`<(/?)${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
    re.lastIndex = m.index + open.length;
    let depth = 1, t, innerEnd = -1, end = -1;
    while ((t = re.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (!depth) { innerEnd = t.index; end = t.index + t[0].length; break; }
    }
    if (end < 0) break; // unbalanced: leave the rest alone
    out.push({ start: m.index, innerStart: m.index + open.length, innerEnd, end, tex, display: cls.includes(' display '), inner: html.slice(m.index + open.length, innerEnd) });
    OPEN_RE.lastIndex = end; // nested math isn't a thing
  }
  return out;
}

/**
 * A rendering's signature: tags reduced to name + class, text with entities decoded, no whitespace.
 * The browser re-serialises KaTeX's HTML differently (quotes, <path/>), so the editor's saves are compared
 * by signature: an equation is "up to date" when its children's signature matches a fresh rendering.
 * (public/app.js has the same function.)
 */
export function mathSig(s) {
  return unent(String(s ?? '').replace(/<(\/?)([a-z0-9]+)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (m, close, tag, attrs) => {
    if (close) return '';
    const c = attrs.match(/(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    return `<${tag.toLowerCase()} ${(c?.[1] ?? c?.[2] ?? '').trim().replace(/\s+/g, ' ')}>`;
  })).replace(/\s+/g, '');
}
const upToDate = (e) => mathSig(e.inner) === mathSig(renderTex(e.tex, e.display));

export const hasMath = (html) => /\bdata-tex\s*=/.test(String(html ?? '')) && findMath(html).length > 0;

/** Re-render every equation's children from its data-tex. Returns html unchanged when there is no math. */
export function renderMathIn(html) {
  html = String(html ?? '');
  if (!/\bdata-tex\s*=/.test(html)) return html;
  const list = findMath(html);
  if (!list.length) return html;
  let out = '', at = 0;
  for (const e of list) {
    if (upToDate(e)) continue; // keep the existing (possibly browser-serialised) markup
    out += html.slice(at, e.innerStart) + renderTex(e.tex, e.display);
    at = e.innerEnd;
  }
  return out + html.slice(at);
}

/** Problems for `slides check`: parse errors and equations whose rendering is out of date. */
export function mathIssues(html) {
  const out = [];
  for (const e of findMath(html)) {
    const short = e.tex.length > 40 ? e.tex.slice(0, 37) + '…' : e.tex;
    const err = texError(e.tex);
    if (err) out.push({ level: 'error', tex: e.tex, msg: `equation "${short}": ${err}` });
    else if (!upToDate(e)) out.push({ level: 'warn', tex: e.tex, msg: `equation "${short}" isn't rendered (or is out of date): run \`slides math <deck>\`` });
  }
  return out;
}

/** katex.min.css with its font URLs made absolute (urlFor(file) → URL), e.g. data: URIs for exports. */
export function katexCss(urlFor) {
  const css = fs.readFileSync(path.join(KATEX_DIR, 'katex.min.css'), 'utf8');
  return css.replace(/url\(fonts\/([^)]+)\)/g, (m, f) => `url("${urlFor(f)}")`);
}
export const fontDataUri = (f) => `data:font/woff2;base64,${fs.readFileSync(path.join(KATEX_DIR, 'fonts', f)).toString('base64')}`;
