// Figures made by a script: <img data-source="scripts/plot.py" src="assets/figs/plot.png"> (or the same attributes on a
// <figure> around the <img>). The script is re-run when it (or a declared data input) is newer than the image.
//   data-source  the script, relative to the deck folder (then the repo root), or absolute
//   data-cmd     optional command template; {source} {out} {deck} {inputs} are replaced (shell-quoted)
//                default by extension: .py python3, .R Rscript, .sh bash, .js/.mjs node, .jl julia
//   data-inputs  optional space-separated data files the figure depends on (same path rules)
// The command always comes from the slide file on disk, never from a request.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, deckDir, readMeta, readSlide, UserError } from './store.mjs';

const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i')); return m ? unesc(m[1]) : null; };

/** Figures declared in one slide's HTML, in document order (same order as querySelectorAll('img[data-source], figure[data-source]')). */
export function findFigures(html) {
  const out = [];
  for (const m of String(html).matchAll(/<(img|figure)\b[^>]*\sdata-source="[^"]*"[^>]*>/gi)) {
    const tag = m[0], name = m[1].toLowerCase();
    let src = name === 'img' ? attr(tag, 'src') : null;
    if (name === 'figure') {
      const close = html.indexOf('</figure>', m.index);
      const im = html.slice(m.index + tag.length, close < 0 ? undefined : close).match(/<img\b[^>]*>/i);
      src = im ? attr(im[0], 'src') : null;
    }
    out.push({ index: out.length, id: attr(tag, 'data-id'), tag: name, source: attr(tag, 'data-source').trim(), cmd: attr(tag, 'data-cmd'),
      inputs: (attr(tag, 'data-inputs') || '').split(/\s+/).filter(Boolean), out: src });
  }
  return out;
}

/** A path from a slide: deck-relative first, then repo-relative; absolute paths are used as they are. */
export function resolvePath(d, p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  const inDeck = path.resolve(deckDir(d), p);
  if (fs.existsSync(inDeck)) return inDeck;
  const inRepo = path.resolve(ROOT, p);
  return fs.existsSync(inRepo) ? inRepo : inDeck;
}

/** The image file a figure writes: must be inside the deck folder (src="assets/…"). */
export function outPath(d, src) {
  if (!src || /^[a-z]+:/i.test(src) || src.startsWith('/')) return null;
  let rel = src.replace(/[?#].*$/, '');
  try { rel = decodeURIComponent(rel); } catch {}
  const dir = deckDir(d), f = path.resolve(dir, rel);
  return f.startsWith(dir + path.sep) ? f : null;
}

const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

/** ok | stale | missing (no image yet) | no-source | error, with a reason and the image's mtime. */
export function figureStatus(d, f) {
  const res = { ...f, status: 'ok', reason: '', outMtime: null };
  const outF = outPath(d, f.out);
  if (!outF) return { ...res, status: 'error', reason: f.out ? `image src "${f.out}" must be a file inside the deck (assets/…)` : 'no <img src> to write' };
  res.outMtime = mtime(outF);
  const srcF = resolvePath(d, f.source), srcM = mtime(srcF);
  if (srcM == null) return { ...res, status: 'no-source', reason: `source not found: ${f.source}` };
  let newest = srcM, newer = srcM > (res.outMtime ?? 0) ? f.source : null;
  const missing = [];
  for (const p of f.inputs) {
    const m = mtime(resolvePath(d, p));
    if (m == null) missing.push(p);
    else if (m > newest) newest = m;
    if (m != null && m > (res.outMtime ?? 0) && !newer) newer = p;
  }
  if (res.outMtime == null) return { ...res, status: 'missing', reason: 'image not made yet' };
  if (res.outMtime + 1 < newest) return { ...res, status: 'stale', reason: `${newer} is newer than the image` };
  if (missing.length) res.reason = `input not found: ${missing.join(', ')}`;
  return res;
}

/** Every declared figure in the deck, with its status. */
export function deckFigures(d, ids = readMeta(d).slides) {
  const list = [];
  for (const id of ids) {
    let html; try { html = readSlide(d, id); } catch { continue; }
    for (const f of findFigures(html)) list.push({ slide: id, ...figureStatus(d, f) });
  }
  return list;
}

const RUNNERS = { '.py': ['python3'], '.r': ['Rscript'], '.sh': ['bash'], '.js': [process.execPath], '.mjs': [process.execPath], '.cjs': [process.execPath], '.jl': ['julia'] };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Run one figure's script. Resolves { ok, ms, stdout, stderr, error }. */
export function runFigure(d, f, { timeout = 120000 } = {}) {
  const srcF = resolvePath(d, f.source), outF = outPath(d, f.out);
  if (!outF) return Promise.resolve({ ok: false, error: `image src "${f.out}" must be a file inside the deck (assets/…)` });
  if (!fs.existsSync(srcF)) return Promise.resolve({ ok: false, error: `source not found: ${f.source}` });
  fs.mkdirSync(path.dirname(outF), { recursive: true });
  const before = mtime(outF);
  let bin, args, shell = false;
  if (f.cmd) {
    const vars = { source: srcF, out: outF, deck: deckDir(d), inputs: f.inputs.map((p) => resolvePath(d, p)) };
    bin = f.cmd.replace(/\{(source|out|deck|inputs)\}/g, (_, k) => (Array.isArray(vars[k]) ? vars[k].map(shq).join(' ') : shq(vars[k])));
    args = []; shell = true;
  } else {
    const r = RUNNERS[path.extname(srcF).toLowerCase()];
    if (r) { bin = r[0]; args = [...r.slice(1), srcF, outF]; } else { bin = srcF; args = [outF]; }
  }
  const t0 = Date.now();
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ ms: Date.now() - t0, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000), ...r }); } };
    let child;
    try {
      child = spawn(bin, args, { cwd: path.dirname(srcF), shell, env: { ...process.env, FIG_SOURCE: srcF, FIG_OUT: outF, DECK_DIR: deckDir(d), MPLBACKEND: process.env.MPLBACKEND || 'Agg' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish({ ok: false, error: e.message }); }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: `timed out after ${Math.round(timeout / 1000)} s` }); }, timeout);
    child.stdout.on('data', (c) => { stdout = (stdout + c).slice(-8000); });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });
    child.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? `command not found: ${bin}` : e.message }));
    child.on('close', (code, sig) => {
      if (code !== 0) return finish({ ok: false, error: sig ? `killed (${sig})` : `exited with code ${code}` });
      const after = mtime(outF);
      if (after == null || after === before) return finish({ ok: false, error: `the script finished but did not write ${f.out} (it gets the output path as its last argument, and as $FIG_OUT)` });
      finish({ ok: true, outMtime: after });
    });
  });
}

/** Find a declared figure on a slide as it is on disk: by data-id, else by index. */
export function figureOn(d, slide, { id = null, index = null } = {}) {
  const list = findFigures(readSlide(d, slide));
  const f = id ? list.find((x) => x.id === id) : list[Number(index)];
  if (!f) throw new UserError(`No figure with data-source ${id ? `and data-id "${id}" ` : `#${index} `}on slide "${slide}" (save the slide first)`, 404);
  return f;
}
