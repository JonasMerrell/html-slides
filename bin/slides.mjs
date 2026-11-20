#!/usr/bin/env node
// slides — CLI for agents and humans. Works directly on files; the editor
// (if running) picks up every change live.
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../lib/store.mjs';
import { buildPresentation } from '../lib/build.mjs';
import { embedIssues, EMBED_TEMPLATE } from '../lib/embed.mjs';

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
  slides add <deck> [--layout L] [--title T] [--id ID] [--after ID | --at N] [--html-file F | --stdin]
  slides dup <deck> <slide>                      duplicate (inserted after the original)
  slides rm <deck> <slide>
  slides mv <deck> <slide> (--after ID | --at N | --first)
  slides rename <deck> <slide> <new-id>
  slides order <deck> <id> <id> ...              set full slide order
  slides toc <deck>                              show the section timeline and each slide's chapter
  slides toc <deck> --set "A|B|C" | --sync [--from ID]
                                                 relabel the timeline on every slide, or copy one slide's to all
                                                 (default source: the most recently edited slide)

Agent ↔ human loop
  slides comments <deck> [--all]                 notes the human left (open only by default)
  slides resolve <deck> <comment-id> [--reply "what you did"]
  slides comment <deck> <slide> [--target DATA-ID] "text"   leave a note/question for the human

Interactive embeds (live only in present mode and exports; posters everywhere else)
  slides embed <deck> <name> [--from DIR]        scaffold assets/embeds/<name>/ (index.html, app.js, poster.png)
  slides poster <deck> <name> [--slide ID] [--scale 2] [--size 1280x720]
                                                 screenshot the live embed (headless WebGL) to its poster.png

Quality
  slides check <deck>                            lint + real-browser overflow check (needs Chrome)
  slides render <deck> [slide...] [--out DIR] [--sheet] [--cols N]
                                                 screenshot slides to PNG (contact sheet with --sheet)
  slides export <deck> [--out FILE]              single self-contained HTML (assets inlined)
  slides serve [--port 4173] [--host H]          start the web editor
`;

// ------------------------------------------------------------ arg parsing
const argv = process.argv.slice(2);
const pos = [], opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) opt[k] = v;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
    else opt[k] = true;
  } else pos.push(a);
}
const [cmd, ...rest] = pos;

const need = (v, what) => { if (v === undefined || v === true || v === '') { fail(`Missing ${what}. Run "slides help".`); } return v; };
function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

const text = (html) => html.replace(/<aside class="notes">[\s\S]*?<\/aside>/gi, '').replace(/<(br|\/p|\/li|\/h\d|\/div)>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
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
      console.log(`# ${meta.title}  (deck: ${d}, theme: ${meta.theme}, ${meta.slides.length} slides)\n`);
      meta.slides.forEach((id, i) => {
        const html = store.readSlide(d, id);
        const t = text(html);
        const flags = [];
        const n = comments.filter((c) => c.slide === id).length;
        if (n) flags.push(`${n} open comment${n > 1 ? 's' : ''}`);
        if (status[id]?.overflow?.length) flags.push(`OVERFLOW: ${status[id].overflow.join(', ')}`);
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
      return;
    }

    case 'dup': {
      const d = need(rest[0], 'deck name');
      const id = store.duplicateSlide(d, need(rest[1], 'slide id'));
      console.log(`Duplicated as ${id} → ${rel(store.slidePath(d, id))}`);
      return;
    }

    case 'rm': store.deleteSlide(need(rest[0], 'deck name'), need(rest[1], 'slide id')); console.log(`Removed ${rest[1]}`); return;

    case 'mv': {
      const d = need(rest[0], 'deck name'), id = need(rest[1], 'slide id');
      if (opt.first) store.moveSlide(d, id, { index: 0 });
      else if (opt.after) store.moveSlide(d, id, { after: opt.after });
      else store.moveSlide(d, id, { index: Number(need(opt.at, '--after, --at or --first')) - 1 });
      console.log(store.readMeta(d).slides.join(' → '));
      return;
    }

    case 'rename': store.renameSlide(need(rest[0], 'deck name'), need(rest[1], 'slide id'), need(rest[2], 'new id')); console.log(`Renamed ${rest[1]} → ${rest[2]}`); return;

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

    case 'comments': {
      const d = need(rest[0], 'deck name');
      const all = store.readComments(d);
      printComments(d, opt.all ? all : all.filter((c) => c.status !== 'resolved'));
      return;
    }

    case 'resolve': {
      const d = need(rest[0], 'deck name');
      const c = store.updateComment(d, need(rest[1], 'comment id'), { status: 'resolved', ...(typeof opt.reply === 'string' ? { reply: opt.reply } : {}) });
      console.log(`Resolved ${c.id}`);
      return;
    }

    case 'comment': {
      const d = need(rest[0], 'deck name');
      const c = store.addComment(d, { slide: need(rest[1], 'slide id'), target: opt.target, text: need(rest[2], 'comment text'), author: 'agent' });
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

    case 'render': {
      const d = need(rest[0], 'deck name');
      const ids = rest.length > 1 ? rest.slice(1) : store.readMeta(d).slides;
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
