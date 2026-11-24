#!/usr/bin/env node
// slides — CLI for agents and humans. Works directly on files; the editor
// (if running) picks up every change live.
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../lib/store.mjs';
import { buildPresentation } from '../lib/build.mjs';
import { embedIssues, EMBED_TEMPLATE } from '../lib/embed.mjs';
import { findMath, mathIssues, renderMathIn } from '../lib/math.mjs';
import { deckFigures, findFigures, figureStatus, runFigure } from '../lib/figures.mjs';
import { findInHtml, replaceInHtml } from '../lib/textfind.mjs';

const HELP = `slides — work with HTML slide decks (files live in ${path.relative(process.cwd(), store.DECKS_DIR) || '.'})

Decks
  slides decks                                   list decks
  slides new <deck> [--title T] [--theme clean]  create a deck (starts with a title slide)
  slides outline <deck>                          slide order, ids, layouts, text summary, open comments
  slides theme <deck> <theme>                    switch theme (overwrites decks/<deck>/theme.css)
  slides themes                                  list themes
  slides layouts [deck] [--theme T]              list layouts (a theme can add its own)

Slides
  slides path <deck> [slide]                     print the file path to edit directly
  slides show <deck> <slide>                     print slide HTML
  slides add <deck> [--layout L] [--title T] [--id ID] [--after ID | --at N] [--html-file F | --stdin] [--as NAME]
                                                 (--as also claims the new slide for NAME)
  slides dup <deck> <slide>                      duplicate (inserted after the original)
  slides rm <deck> <slide>
  slides mv <deck> <slide> (--after ID | --at N | --first)
  slides rename <deck> <slide> <new-id>
  slides order <deck> <id> <id> ...              set full slide order
  slides history <deck> <slide> [--show V]       earlier versions of a slide (every save, CLI write and direct
                                                 file edit is kept, last ${store.HISTORY_MAX}); --show prints one
  slides restore <deck> <slide> <version>        put a version back (by id, unique prefix, or -1 = the one
                                                 before the current); the restore can itself be undone
  slides toc <deck>                              show the section timeline and each slide's chapter
  slides toc <deck> --set "A|B|C" | --sync [--from ID]
                                                 relabel the timeline on every slide, or copy one slide's to all
                                                 (default source: the most recently edited slide)

Several agents at once (claims are advisory: they warn, never block; they lapse after ${store.CLAIM_TTL_MS / 3600000} h)
  slides claim <deck> <slide...> --as NAME [--note "what you're doing"] [--force]
                                                 mark slides as yours (re-claiming renews); fails if another
                                                 name holds one, unless --force. NAME may come from $SLIDES_AGENT
  slides release <deck> (<slide...> | --all) --as NAME
                                                 give your slides back when you're done
  slides claims <deck>                           who is working on which slide
  Commands that change a slide (rm, mv, rename, restore, target, math, figures --refresh) warn when another
  name holds it; pass --as NAME (or set SLIDES_AGENT) so your own claims don't warn.

Talk timing (presenter view: press P while presenting)
  slides target <deck>                           talk length and per-slide target times
  slides target <deck> --minutes 20              set the talk's target length (0 removes it)
  slides target <deck> <slide> --seconds 90      set a slide's target time (data-time; 0 removes it)
  slides rehearsals <deck> [--all]               times per slide from the last rehearsal (or every run)

Agent ↔ human loop
  slides comments <deck> [--all]                 notes the human left (open only by default)
  slides resolve <deck> <comment-id> [--reply "what you did"]
  slides comment <deck> <slide> [--target DATA-ID] [--step K] "text"   leave a note/question for the human

Find and replace (visible slide text only: never markup, attributes, equations, embeds or the timeline)
  slides find <deck> "text" [--case] [--word] [--notes]
                                                 every match with its slide and context (--notes: speaker notes too)
  slides replace <deck> "old" "new" [--case] [--word] [--notes] [--dry-run] [slide...]
                                                 replace in text only; the rest of each file stays byte-for-byte.
                                                 Whitespace in "old" matches any whitespace (line breaks too)

Interactive embeds (live only in present mode and exports; posters everywhere else)
  slides embed <deck> <name> [--from DIR]        scaffold assets/embeds/<name>/ (index.html, app.js, poster.png)
  slides poster <deck> <name> [--slide ID] [--scale 2] [--size 1280x720]
                                                 screenshot the live embed (headless WebGL) to its poster.png

Equations (LaTeX rendered with KaTeX into the slide; see AGENTS.md, Equations)
  slides math <deck> [slide...]                  render <span class="math" data-tex="…"> and <div class="math display" …>
                                                 after editing slide files directly (editor and CLI saves do it)

Figures made by scripts (<img data-source="scripts/plot.py" src="assets/figs/plot.png">; see AGENTS.md)
  slides figures <deck>                          each script-made figure: ok, stale (script or data newer), missing
  slides figures <deck> --refresh [slide|data-id...] [--all] [--timeout 120]
                                                 re-run the scripts of stale/missing figures (--all: every one)

Quality
  slides check <deck>                            lint + real-browser overflow check (needs Chrome)
  slides render <deck> [slide...] [--out DIR] [--sheet] [--cols N] [--step K | --steps]
                                                 screenshot slides to PNG (contact sheet with --sheet);
                                                 --step K shows click builds after K clicks (0 = none yet),
                                                 --steps renders every click step of slides that have builds
  slides export <deck> [--out FILE]              single self-contained HTML (assets inlined)
  slides pdf <deck> [slide...] [--out FILE] [--steps] [--notes]
                                                 print to PDF (one 16:9 page per slide, fully built; --steps adds
                                                 a page per click step, --notes a notes page after each slide)
  slides serve [--port 4173] [--host H]          start the web editor
`;

// ------------------------------------------------------------ arg parsing
const argv = process.argv.slice(2);
const pos = [], opt = {};
const FLAGS = new Set(['case', 'word', 'notes', 'dry-run', 'all', 'force', 'sheet', 'stdin', 'first']); // never take a value
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) opt[k] = v;
    else if (FLAGS.has(k)) opt[k] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
    else opt[k] = true;
  } else pos.push(a);
}
const [cmd, ...rest] = pos;

const need = (v, what) => { if (v === undefined || v === true || v === '') { fail(`Missing ${what}. Run "slides help".`); } return v; };
const fmtSec = (s) => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// claims: warn (never block) when a command changes a slide someone else is working on
function warnClaimed(d, ids) {
  for (const id of ids) {
    const c = store.claimedByOther(d, id, opt.as);
    if (c) console.error(`warning: "${id}" is claimed by ${c.by}${c.note ? ` (${c.note})` : ''}: they are working on it. Prefer a note: slides comment ${d} ${id} "…"`);
  }
}
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

// equations read as their LaTeX ($…$) rather than KaTeX's markup
const texText = (html) => { let out = '', at = 0; for (const e of findMath(html)) { out += html.slice(at, e.start) + ` $${e.tex}$ `.replace(/</g, '&lt;'); at = e.end; } return out + html.slice(at); };
const text = (html) => texText(html).replace(/<aside class="notes">[\s\S]*?<\/aside>/gi, '').replace(/<(br|\/p|\/li|\/h\d|\/div)>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const layoutOf = (html) => (html.match(/data-layout="([^"]+)"/) || [])[1] || '?';
const notesOf = (html) => text((html.match(/<aside class="notes">([\s\S]*?)<\/aside>/i) || [])[1] || '');
const rel = (p) => path.relative(process.cwd(), p) || p;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function printComments(d, list) {
  if (!list.length) { console.log('No comments.'); return; }
  for (const c of list) {
    const where = [c.slide && `slide ${c.slide}`, c.target && `[data-id="${c.target}"]`, c.x != null && `at (${c.x}, ${c.y}) of 1920×1080`].filter(Boolean).join(' ');
    console.log(`${c.id}  ${c.status.toUpperCase().padEnd(8)} ${c.author === 'agent' ? '(agent) ' : ''}${where || 'deck'}`);
    if (c.step != null) console.log(`    step: ${c.step ? `after click ${c.step}` : 'start (before any click)'} — see it: slides render ${d} ${c.slide} --step ${c.step}`);
    if (c.near) console.log(`    on: "${c.near}"`);
    console.log(`    ${c.text.replace(/\n/g, '\n    ')}`);
    if (c.reply) console.log(`    ↳ ${c.reply.replace(/\n/g, '\n      ')}`);
  }
}

// ------------------------------------------------------------ commands
async function main() {
  switch (cmd) {
    case undefined: case 'help': case '-h': console.log(HELP); return;

    case 'decks': {
      const decks = store.listDecks();
      if (!decks.length) return console.log('No decks yet. Create one: slides new <deck> --title "..."');
      for (const d of decks) console.log(`${d.name.padEnd(24)} ${String(d.slideCount).padStart(3)} slides  ${d.theme.padEnd(9)} ${d.openComments ? `${d.openComments} open comments  ` : ''}${d.title}`);
      return;
    }

    case 'new': {
      const d = need(rest[0], 'deck name');
      store.createDeck(d, { title: typeof opt.title === 'string' ? opt.title : undefined, theme: opt.theme || 'clean' });
      console.log(`Created ${rel(store.deckDir(d))}`);
      return;
    }

    case 'outline': {
      const d = need(rest[0], 'deck name');
      const meta = store.readMeta(d);
      const comments = store.readComments(d).filter((c) => c.status !== 'resolved');
      const status = store.readStatus(d);
      const claims = store.readClaims(d);
      console.log(`# ${meta.title}  (deck: ${d}, theme: ${meta.theme}, ${meta.slides.length} slides)\n`);
      meta.slides.forEach((id, i) => {
        const html = store.readSlide(d, id);
        const t = text(html);
        const flags = [];
        const n = comments.filter((c) => c.slide === id).length;
        if (n) flags.push(`${n} open comment${n > 1 ? 's' : ''}`);
        if (status[id]?.overflow?.length) flags.push(`OVERFLOW: ${status[id].overflow.join(', ')}`);
        if (claims[id]) flags.push(`claimed by ${claims[id].by}`);
        console.log(`${String(i + 1).padStart(2)}. ${id}  [${layoutOf(html)}]${flags.length ? '  ⚠ ' + flags.join('; ') : ''}`);
        console.log(`    ${t.length > 160 ? t.slice(0, 157) + '…' : t}`);
        const notes = notesOf(html);
        if (notes) console.log(`    notes: ${notes.length > 120 ? notes.slice(0, 117) + '…' : notes}`);
      });
      const deckLevel = comments.filter((c) => !c.slide);
      if (deckLevel.length) { console.log('\nDeck comments:'); printComments(d, deckLevel); }
      return;
    }

    case 'themes': for (const t of store.listThemes()) console.log(`${t.name.padEnd(12)} ${t.description}`); return;
    case 'layouts': {
      // slides layouts [deck] [--theme T]: a deck's theme adds its own layouts
      const theme = typeof opt.theme === 'string' ? opt.theme : rest[0] ? store.readMeta(rest[0]).theme : null;
      for (const l of store.listLayouts(theme)) console.log(`${l.name.padEnd(14)} ${l.theme ? `[${l.theme}] ` : ''}${l.description}`);
      return;
    }

    case 'theme': {
      const d = need(rest[0], 'deck name');
      store.updateDeck(d, { theme: need(rest[1], 'theme name') });
      console.log(`Theme of ${d} is now ${rest[1]}`);
      return;
    }

    case 'path': {
      const d = need(rest[0], 'deck name');
      console.log(rest[1] ? rel(store.slidePath(d, rest[1])) : rel(store.deckDir(d)));
      return;
    }

    case 'show': process.stdout.write(store.readSlide(need(rest[0], 'deck name'), need(rest[1], 'slide id'))); return;

    case 'add': {
      const d = need(rest[0], 'deck name');
      let html;
      if (opt['html-file']) html = fs.readFileSync(opt['html-file'], 'utf8');
      else if (opt.stdin) html = await readStdin();
      const id = store.addSlide(d, {
        layout: opt.layout, html, title: typeof opt.title === 'string' ? opt.title : undefined,
        id: opt.id, after: opt.after, index: opt.at !== undefined ? Number(opt.at) - 1 : undefined,
      });
      console.log(`Added ${id} → ${rel(store.slidePath(d, id))}`);
      if (store.agentName(opt.as)) { store.claimSlides(d, [id], { as: opt.as }); console.log(`Claimed ${id} for ${store.agentName(opt.as)} (release with: slides release ${d} ${id} --as ${store.agentName(opt.as)})`); }
      return;
    }

    case 'dup': {
      const d = need(rest[0], 'deck name');
      const id = store.duplicateSlide(d, need(rest[1], 'slide id'));
      console.log(`Duplicated as ${id} → ${rel(store.slidePath(d, id))}`);
      return;
    }

    case 'rm': warnClaimed(rest[0], [rest[1]]); store.deleteSlide(need(rest[0], 'deck name'), need(rest[1], 'slide id')); console.log(`Removed ${rest[1]}`); return;

    case 'mv': {
      const d = need(rest[0], 'deck name'), id = need(rest[1], 'slide id');
      warnClaimed(d, [id]);
      if (opt.first) store.moveSlide(d, id, { index: 0 });
      else if (opt.after) store.moveSlide(d, id, { after: opt.after });
      else store.moveSlide(d, id, { index: Number(need(opt.at, '--after, --at or --first')) - 1 });
      console.log(store.readMeta(d).slides.join(' → '));
      return;
    }

    case 'rename': warnClaimed(rest[0], [rest[1]]); store.renameSlide(need(rest[0], 'deck name'), need(rest[1], 'slide id'), need(rest[2], 'new id')); console.log(`Renamed ${rest[1]} → ${rest[2]}`); return;

    case 'order': {
      const d = need(rest[0], 'deck name');
      const meta = store.updateDeck(d, { slides: rest.slice(1) });
      console.log(meta.slides.join(' → '));
      return;
    }

    case 'toc': {
      const d = need(rest[0], 'deck name');
      if (typeof opt.set === 'string' || opt.sync) {
        const labels = typeof opt.set === 'string' ? opt.set.split('|').map((x) => x.trim()).filter(Boolean) : undefined;
        const changed = store.syncToc(d, typeof opt.from === 'string' ? opt.from : undefined, { labels });
        console.log(changed.length ? `Updated the timeline on: ${changed.join(', ')}` : 'Timeline already identical on every slide.');
      }
      const meta = store.readMeta(d);
      const withToc = meta.slides.map((id) => [id, store.readSlide(d, id)]).filter(([, h]) => store.tocOf(h));
      if (!withToc.length) { console.log(`No slide in "${d}" has a <nav class="toc"> timeline.`); return; }
      const labels = store.tocLabels(store.tocOf(withToc[0][1]));
      console.log(labels.map((l, k) => `${k + 1}. ${l}`).join('   '));
      const differ = withToc.filter(([, h]) => store.tocLabels(store.tocOf(h)).join('|') !== labels.join('|')).map(([id]) => id);
      if (differ.length) console.log(`⚠ different timeline on: ${differ.join(', ')} (fix with: slides toc ${d} --sync --from <id>)`);
      for (const [id, h] of withToc) { const n = store.sectionOf(h); console.log(`  ${id.padEnd(24)} ${n ? `${n}. ${labels[n - 1] ?? '(no such item)'}` : '—'}`); }
      return;
    }

    case 'target': {
      const d = need(rest[0], 'deck name');
      if (rest[1]) {
        if (opt.seconds === undefined || opt.seconds === true) fail('give --seconds N (0 removes the target)');
        warnClaimed(d, [rest[1]]);
        const v = store.setSlideTime(d, rest[1], +opt.seconds);
        console.log(v ? `${rest[1]}: target ${fmtSec(v)}` : `${rest[1]}: target removed`);
        return;
      }
      if (opt.minutes !== undefined && opt.minutes !== true) { const v = store.setTalkMinutes(d, +opt.minutes); console.log(v ? `Talk target: ${v} min` : 'Talk target removed'); }
      const t = store.readTargets(d);
      const sum = t.slides.reduce((a, s) => a + (s.seconds || 0), 0);
      console.log(`Talk target: ${t.talkMinutes ? t.talkMinutes + ' min' : '— (set with --minutes N)'}${sum ? `   per-slide targets add up to ${fmtSec(sum)}` : ''}`);
      t.slides.forEach((s, k) => console.log(`  ${String(k + 1).padStart(2)}. ${s.id.padEnd(24)} ${s.seconds ? fmtSec(s.seconds) : '—'}`));
      return;
    }
    case 'rehearsals': {
      const d = need(rest[0], 'deck name');
      const runs = store.readRehearsals(d);
      if (!runs.length) { console.log(`No rehearsals yet for "${d}". Present the deck, press P for the presenter view, then ● Rehearse.`); return; }
      const ids = store.readMeta(d).slides;
      for (const r of opt.all ? runs : runs.slice(-1)) {
        const goal = r.talkMinutes ? r.talkMinutes * 60 : 0;
        console.log(`Rehearsal ${r.at}: total ${fmtSec(r.totalMs / 1000)}${goal ? ` (target ${fmtSec(goal)}, ${r.totalMs / 1000 > goal ? 'over by ' + fmtSec(r.totalMs / 1000 - goal) : 'under by ' + fmtSec(goal - r.totalMs / 1000)})` : ''}`);
        for (const sl of r.slides) {
          const k = ids.indexOf(sl.id), sec = sl.ms / 1000;
          console.log(`  ${k >= 0 ? String(k + 1).padStart(2) + '.' : '  -'} ${sl.id.padEnd(24)} ${fmtSec(sec).padStart(6)}${sl.target ? `  target ${fmtSec(sl.target)}${sec > sl.target ? '  OVER +' + fmtSec(sec - sl.target) : ''}` : ''}`);
        }
      }
      return;
    }

    case 'claim': {
      const d = need(rest[0], 'deck name');
      const ids = [...rest.slice(1), ...(typeof opt.force === 'string' ? [opt.force] : [])];
      if (!ids.length) fail('Name the slide(s) to claim. Run "slides help".');
      store.claimSlides(d, ids, { as: opt.as, note: typeof opt.note === 'string' ? opt.note : undefined, force: !!opt.force });
      console.log(`Claimed ${ids.join(', ')} for ${store.agentName(opt.as)} (lapses after ${store.CLAIM_TTL_MS / 3600000} h; claim again to renew).`);
      console.log(`When you're done: slides release ${d} ${ids.join(' ')} --as ${store.agentName(opt.as)}`);
      return;
    }
    case 'release': {
      const d = need(rest[0], 'deck name');
      const ids = [...rest.slice(1), ...(typeof opt.all === 'string' ? [opt.all] : [])];
      if (!ids.length && !opt.all) fail('Name the slide(s) to release, or --all. Run "slides help".');
      const done = store.releaseSlides(d, opt.all ? null : ids, { as: opt.as });
      console.log(done.length ? `Released ${done.join(', ')}` : `Nothing to release: ${store.agentName(opt.as)} holds no ${opt.all ? '' : 'such '}claims in ${d}.`);
      return;
    }
    case 'claims': {
      const d = need(rest[0], 'deck name');
      const cl = store.readClaims(d), ids = Object.keys(cl);
      if (!ids.length) { console.log(`No slide in "${d}" is claimed.`); return; }
      const order = store.readMeta(d).slides;
      ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      for (const id of ids) console.log(`${id.padEnd(24)} ${cl[id].by.padEnd(16)} since ${ago(cl[id].since).padEnd(14)} renewed ${ago(cl[id].renewed)}${cl[id].note ? `  — ${cl[id].note}` : ''}`);
      return;
    }

    case 'history': {
      const d = need(rest[0], 'deck name'), id = need(rest[1], 'slide id');
      if (typeof opt.show === 'string') { process.stdout.write(store.readVersion(d, id, store.resolveVersion(d, id, opt.show))); return; }
      const cur = fs.existsSync(store.slidePath(d, id)) ? fs.readFileSync(store.slidePath(d, id), 'utf8') : null;
      const vs = store.listVersions(d, id);
      if (!vs.length) { console.log(`No history for "${id}" yet (it starts with the first change made through the editor or CLI).`); return; }
      const SRC = { original: 'original', editor: 'editor (human)', cli: 'agent via CLI', file: 'file edit', timeline: 'timeline sync', restore: 'restore' };
      vs.forEach((v, k) => {
        const isCur = k === vs.length - 1 && cur != null && store.readVersion(d, id, v.id) === cur;
        console.log(`${v.id.padEnd(24)}${new Date(v.time).toLocaleString()}  ${(SRC[v.source] || v.source).padEnd(15)} ${String(v.size ?? '?').padStart(6)} B${isCur ? '  ← current' : ''}`);
      });
      console.log(`\nView one: slides history ${d} ${id} --show <version>   Put one back: slides restore ${d} ${id} <version>`);
      return;
    }

    case 'restore': {
      const d = need(rest[0], 'deck name'), id = need(rest[1], 'slide id');
      warnClaimed(d, [id]);
      const v = store.restoreVersion(d, id, need(rest[2], 'version (see: slides history)'));
      console.log(`Restored ${id} to ${v} (undo with: slides restore ${d} ${id} -1)`);
      return;
    }

    case 'comments': {
      const d = need(rest[0], 'deck name');
      const all = store.readComments(d);
      printComments(d, opt.all ? all : all.filter((c) => c.status !== 'resolved'));
      return;
    }

    case 'resolve': {
      const d = need(rest[0], 'deck name');
      const c = store.updateComment(d, need(rest[1], 'comment id'), { status: 'resolved', ...(typeof opt.reply === 'string' ? { reply: opt.reply } : {}) });
      console.log(`Resolved ${c.id}${c.change ? ` (change on ${c.slide}: ${c.change.before} → ${c.change.after})` : ''}`);
      return;
    }

    case 'comment': {
      const d = need(rest[0], 'deck name');
      const c = store.addComment(d, { slide: need(rest[1], 'slide id'), target: opt.target, text: need(rest[2], 'comment text'), author: 'agent', step: opt.step });
      console.log(`Added ${c.id}`);
      return;
    }

    case 'check': {
      const d = need(rest[0], 'deck name');
      const meta = store.readMeta(d);
      const issues = [];
      for (const id of meta.slides) {
        const html = store.readSlide(d, id);
        if (!/^\s*<section\b[^>]*class="[^"]*\bslide\b/.test(html)) issues.push([id, 'file is not a single <section class="slide">']);
        const ids = [...html.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
        const dupes = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
        if (dupes.length) issues.push([id, `duplicate data-id: ${dupes.join(', ')}`]);
        for (const m of html.matchAll(/(?<![\w-])(?:src|href)="(assets\/[^"]+)"/g)) {
          if (!fs.existsSync(path.join(store.deckDir(d), decodeURIComponent(m[1])))) issues.push([id, `missing asset ${m[1]}`]);
        }
        for (const [level, msg] of embedIssues(d, html)) issues.push([id, msg, level]);
        for (const f of findFigures(html)) {
          const st = figureStatus(d, f);
          if (st.status !== 'ok') issues.push([id, `figure ${f.id || f.out}: ${st.status} — ${st.reason}${st.status === 'stale' || st.status === 'missing' ? ` (slides figures ${d} --refresh)` : ''}`, 'warn']);
        }
        for (const m of mathIssues(html)) issues.push([id, m.msg.replace('<deck>', d), m.level === 'warn' ? 'warn' : undefined]);
        if (/<script\b/i.test(html)) issues.push([id, `<script> placed directly in a slide never runs in the editor and runs on every slide at once in present mode; move interactive code into an embed: "slides embed ${d} <name>" (see AGENTS.md, Interactive embeds)`, 'warn']);
      }
      try {
        const { measure } = await import('../lib/chrome.mjs');
        const res = await measure(d, meta.slides);
        store.writeStatus(d, Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { overflow: v.overflow, words: v.words }])));
        for (const [id, r] of Object.entries(res)) {
          if (r.overflow.length) issues.push([id, `content overflows the slide: ${r.overflow.join(', ')}`]);
          if (r.words > 90) issues.push([id, `dense: ${r.words} words on the slide (aim for < 60)`]);
        }
      } catch (e) {
        issues.push(['-', `browser overflow check skipped: ${e.message.split('\n')[0]}`]);
      }
      const open = store.readComments(d).filter((c) => c.status !== 'resolved').length;
      const errs = issues.filter(([, , lv]) => lv !== 'warn'), warns = issues.filter(([, , lv]) => lv === 'warn');
      if (!issues.length) console.log(`✓ ${d}: ${meta.slides.length} slides, no issues.`);
      else {
        console.log(`${d}: ${errs.length} issue(s)${warns.length ? `, ${warns.length} warning(s)` : ''}`);
        for (const [id, m, lv] of [...errs, ...warns]) console.log(`  ${id.padEnd(20)} ${lv === 'warn' ? 'warning: ' : ''}${m}`);
      }
      if (open) console.log(`  (${open} open comment${open > 1 ? 's' : ''} — run "slides comments ${d}")`);
      if (errs.some(([id]) => id !== '-')) process.exitCode = 2;
      return;
    }

    case 'figures': {
      const d = need(rest[0], 'deck name');
      const list = deckFigures(d);
      if (!opt.refresh) {
        if (!list.length) { console.log(`${d}: no figures with data-source (see AGENTS.md, Figures made by scripts)`); return; }
        for (const f of list) console.log(`${f.status.padEnd(9)} ${f.slide.padEnd(18)} ${(f.id || `#${f.index}`).padEnd(14)} ${f.source} → ${f.out}${f.reason ? `  (${f.reason})` : ''}`);
        const n = list.filter((f) => f.status !== 'ok').length;
        if (n) console.log(`\n${n} need attention — "slides figures ${d} --refresh" re-runs stale and missing ones`);
        return;
      }
      const targets = [...rest.slice(1), ...(typeof opt.refresh === 'string' ? [opt.refresh] : [])];
      const pick = list.filter((f) => (targets.length ? targets.includes(f.slide) || targets.includes(f.id) : true) && (opt.all || targets.length ? f.status !== 'error' : f.status === 'stale' || f.status === 'missing'));
      if (!pick.length) { console.log(targets.length ? `No figures match ${targets.join(', ')}` : '✓ every figure is up to date (use --all to re-run anyway)'); return; }
      const timeout = (Number(opt.timeout) || 120) * 1000;
      let failed = 0;
      warnClaimed(d, [...new Set(pick.map((f) => f.slide))]);
      for (const f of pick) {
        process.stdout.write(`running ${f.source} → ${f.out} … `);
        const r = await runFigure(d, f, { timeout });
        if (r.ok) console.log(`ok (${(r.ms / 1000).toFixed(1)} s)`);
        else { failed++; console.log(`FAILED: ${r.error}`); if (r.stderr.trim()) console.log(r.stderr.trim().split('\n').map((l) => `    ${l}`).join('\n')); }
      }
      if (failed) process.exitCode = 2;
      return;
    }

    case 'find': case 'replace': {
      const d = need(rest[0], 'deck name');
      const query = need(rest[1], 'text to find');
      const repl = cmd === 'replace' ? rest[2] : undefined;
      if (cmd === 'replace' && repl === undefined) fail('Missing the replacement text: slides replace <deck> "old" "new"');
      const fo = { caseSensitive: !!opt.case, word: !!opt.word, notes: !!opt.notes };
      const only = rest.slice(cmd === 'replace' ? 3 : 2);
      const ids = only.length ? only : store.readMeta(d).slides;
      let total = 0, slides = 0;
      for (const id of ids) {
        const html = store.readSlide(d, id);
        const hits = findInHtml(html, query, fo);
        if (!hits.length) continue;
        total += hits.length; slides++;
        console.log(`${id}  (${hits.length})`);
        for (const h of hits) console.log(`    ${h.context.before}[${cmd === 'replace' ? `${h.context.match} → ${repl}` : h.context.match}]${h.context.after}`);
        if (cmd === 'replace' && !opt['dry-run']) {
          warnClaimed(d, [id]);
          store.writeSlide(d, id, replaceInHtml(html, query, repl, fo).html, { source: 'replace' });
        }
      }
      if (!total) console.log(`No matches for "${query}"${fo.notes ? '' : ' (speaker notes not searched: add --notes)'}.`);
      else if (cmd === 'find') console.log(`${total} match(es) on ${slides} slide(s).`);
      else console.log(opt['dry-run'] ? `Would replace ${total} match(es) on ${slides} slide(s) (dry run: nothing written).` : `Replaced ${total} match(es) on ${slides} slide(s). Undo one slide with: slides restore ${d} <slide> -1`);
      return;
    }

    case 'math': {
      const d = need(rest[0], 'deck name');
      const ids = rest.length > 1 ? rest.slice(1) : store.readMeta(d).slides;
      let n = 0, eqs = 0;
      for (const id of ids) {
        const html = store.readSlide(d, id);
        const list = findMath(html);
        eqs += list.length;
        for (const m of mathIssues(html)) if (m.level === 'error') console.log(`  ${id.padEnd(20)} ${m.msg}`);
        if (list.length && renderMathIn(html) !== html) { warnClaimed(d, [id]); store.writeSlide(d, id, html, { source: 'math' }); n++; console.log(`rendered ${id}`); }
      }
      console.log(eqs ? `${eqs} equation(s); ${n} slide(s) re-rendered.` : 'No equations (class="math" with data-tex).');
      return;
    }

    case 'render': {
      const d = need(rest[0], 'deck name');
      let ids = rest.length > 1 ? rest.slice(1) : store.readMeta(d).slides;
      if (typeof opt.steps === 'string') { ids = rest.length > 1 ? [...ids, opt.steps] : [opt.steps]; opt.steps = true; }
      if (opt.step !== undefined) {
        const k = Number(opt.step);
        if (!Number.isInteger(k) || k < 0) fail('--step takes a click number: 0 = before any click, 1 = after the first click, …');
        ids = ids.map((id) => ({ id, step: k }));
      } else if (opt.steps) {
        // every click-build snapshot of each slide that has builds (other slides render once)
        ids = ids.flatMap((id) => { const n = store.buildStepsOf(store.readSlide(d, id)).length; return n ? Array.from({ length: n + 1 }, (_, k) => ({ id, step: k })) : [id]; });
      }
      const { renderPngs } = await import('../lib/chrome.mjs');
      const out = typeof opt.out === 'string' ? opt.out : path.join(store.deckDir(d), '.renders');
      const files = await renderPngs(d, ids, out, { sheet: !!opt.sheet, cols: Number(opt.cols) || 3 });
      for (const f of files) console.log(rel(f));
      return;
    }

    case 'embed': {
      const d = need(rest[0], 'deck name'), name = need(rest[1], 'embed name');
      if (!store.NAME_RE.test(name)) fail(`Invalid embed name "${name}" (use lowercase letters, digits, "-" or "_")`);
      if (!store.deckExists(d)) fail(`No deck named "${d}"`);
      const dir = path.join(store.deckDir(d), 'assets', 'embeds', name);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail(`${rel(dir)} already exists`);
      const from = typeof opt.from === 'string' ? path.resolve(opt.from) : EMBED_TEMPLATE;
      if (!fs.existsSync(path.join(from, 'index.html'))) fail(`${from} has no index.html`);
      fs.mkdirSync(dir, { recursive: true });
      fs.cpSync(from, dir, { recursive: true });
      console.log(`Created ${rel(dir)}/ (${fs.readdirSync(dir).join(', ')})`);
      if (!fs.existsSync(path.join(dir, 'poster.png'))) {
        try {
          const { capturePoster } = await import('../lib/chrome.mjs');
          const r = await capturePoster(d, name, {});
          console.log(`Poster: ${rel(r.out)} (${r.width}×${r.height}, ${r.slide ? `as shown on slide ${r.slide}` : `page on its own; re-run "slides poster ${d} ${name}" once it is on a slide`})`);
        } catch (e) {
          console.log(`No poster yet (${e.message.split('\n')[0]}). Make one with: slides poster ${d} ${name}`);
        }
      }
      console.log(`\nPut it on a slide (the <img> is what the editor and renders show):\n` +
        `  <figure class="figure embed" data-id="${name}" data-src="assets/embeds/${name}/index.html" data-poster="assets/embeds/${name}/poster.png">` +
        `<img src="assets/embeds/${name}/poster.png" alt="…"></figure>`);
      return;
    }

    case 'poster': {
      const d = need(rest[0], 'deck name'), name = need(rest[1], 'embed name');
      const { capturePoster } = await import('../lib/chrome.mjs');
      const r = await capturePoster(d, name, { scale: Number(opt.scale) || 2, slide: typeof opt.slide === 'string' ? opt.slide : null,
        size: typeof opt.size === 'string' ? opt.size : '1280x720', timeout: (Number(opt.timeout) || 60) * 1000 });
      console.log(`Wrote ${rel(r.out)} (${r.width}×${r.height}${r.slide ? `, as shown on slide ${r.slide}` : ', page on its own'})`);
      for (const e of r.errors) console.log(`  console error: ${e}`);
      if (r.errors.length) process.exitCode = 2;
      return;
    }

    case 'pdf': {
      const d = need(rest[0], 'deck name');
      let ids = rest.length > 1 ? rest.slice(1) : store.readMeta(d).slides;
      if (typeof opt.steps === 'string') { ids = rest.length > 1 ? [...ids, opt.steps] : [opt.steps]; opt.steps = true; }
      if (typeof opt.notes === 'string') { ids = rest.length > 1 ? [...ids, opt.notes] : [opt.notes]; opt.notes = true; }
      for (const id of ids) store.readSlide(d, id); // unknown slide → clear error
      if (opt.steps) ids = ids.flatMap((id) => { const n = store.buildStepsOf(store.readSlide(d, id)).length; return n ? Array.from({ length: n + 1 }, (_, k) => ({ id, step: k })) : [id]; });
      const out = typeof opt.out === 'string' ? opt.out : `${d}.pdf`;
      const { renderPdf } = await import('../lib/chrome.mjs');
      const buf = await renderPdf(d, ids, out, { notes: !!opt.notes });
      console.log(`Wrote ${out} (${ids.length + (opt.notes ? new Set(ids.map((x) => x.id ?? x)).size : 0)} pages, ${(buf.length / 1024).toFixed(0)} KB)`);
      return;
    }

    case 'export': {
      const d = need(rest[0], 'deck name');
      const out = typeof opt.out === 'string' ? opt.out : `${d}.html`;
      fs.writeFileSync(out, buildPresentation(d, { inline: true }));
      console.log(`Wrote ${out}`);
      return;
    }

    case 'serve': {
      process.argv = [process.argv[0], 'server.mjs', ...(opt.port ? ['--port', String(opt.port)] : []), ...(opt.host ? ['--host', String(opt.host)] : [])];
      await import('../server.mjs');
      return;
    }

    default: fail(`Unknown command "${cmd}". Run "slides help".`);
  }
}

main().catch((e) => fail(e.message));
