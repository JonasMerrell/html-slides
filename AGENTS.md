# Working on slide decks (instructions for agents)

This repo is an HTML slide editor. A human edits decks in the web editor
(`npm start` → http://127.0.0.1:4173) while you edit the **same files on disk**.
The editor live-reloads within a second whenever you save, so edit files
directly. You don't need the server running to work.

CLI: `node bin/slides.mjs <command>` (alias below: `slides`). Run `slides help` for everything.

## File layout

```
decks/<deck>/
  deck.json          {"title", "theme", "slides": [ordered slide ids]}
  theme.css          this deck's theme (CSS variables on .slide + extras)
  slides/<id>.html   ONE <section class="slide ..."> per file
  assets/            images; reference as src="assets/name.png"
  assets/embeds/<n>/ interactive embeds (see "Interactive embeds" below)
  comments.json      notes from the human (use the CLI to read/resolve them)
templates/layouts/   starting layouts (title, bullets, two-col, cards, stats, quote, ...)
templates/themes/    base themes (clean, midnight, paper, mprime, plus any local ones)
templates/embed/     starting point for a new embed (`slides embed`)
core/slides.css      layout classes shared by all themes (read it to see what exists)
```

## The slide contract

- Each slide is a fixed **1920×1080** canvas. Every file contains exactly one
  `<section class="slide layout-<name>" data-layout="<name>">`.
- Use the existing layout classes and utilities from `core/slides.css`
  (`kicker`, `lede`, `muted`, `accent`, `card`, `row`, `stack`, `pill`, `cols`, `stats`…)
  before writing inline styles. Put deck-wide styling in `theme.css`, not in slides.
- Give meaningful elements a stable `data-id` (`data-id="title"`, `data-id="chart"`).
  Human comments point at elements by `data-id`, so keep existing ids when you edit.
- Speaker notes go in `<aside class="notes">…</aside>` inside the section.
- **Respect human edits.** Inline `style="translate: …; width: …"` and `.free`
  absolutely-positioned elements are things the human placed by hand. Keep them
  unless you're asked to change them.
- Keep text short: one idea per slide, ≤ 6 bullets, ideally < 60 words.
  Don't add `<script>` to slides: use inline SVG for static diagrams and charts, and an
  embed (below) for anything interactive.
- After adding or deleting slide files directly, the order in `deck.json` is
  reconciled automatically (new files are appended). Use `slides mv` or `slides order` to reorder.

## Click builds (animations)

Any element can appear on a click in present mode and exports: add `data-build="N"` (N = 1, 2, …; elements with the
same N appear together) and optionally `data-build-effect="fade"` or `"zoom"` (grows from its CSS `transform-origin`; default is pop in). → / Space reveals the next step
before moving to the next slide, ← hides it again, and going back onto a slide shows it fully built. Printing shows
everything. No `<script>` needed.

**Steps in the editor.** A slide with builds is still one file. The editor shows it fully built (build elements
outlined with a dashed purple line) with a strip of snapshots under it: Start (before any click), Click 1, Click 2, …
(`[` / `]` step through them). On a snapshot the human can edit, add elements (they get that click's `data-build`),
and leave notes. A note left on a snapshot has `"step": K` in `comments.json`, and `slides comments` prints
`step: after click K` (0 = before any click). **Look at that snapshot, not the full slide:**
`slides render <deck> <slide> --step K`. `slides render <deck> [slide…] --steps [--sheet]` renders every step of every
animated slide (`<id>.stepK.png`). Without these flags `render` and `check` show the fully built slide. To ask about a
step yourself: `slides comment <deck> <slide> --step K "…"`.

## Section timelines (`<nav class="toc">`)

Themes with a chapter timeline (`mprime`, and others) put the same `<nav class="toc"><span>…</span>…</nav>` on every
content slide, and each slide says which chapter it belongs to with `data-section="N"` (1-based) on its `<section>`.
- **One timeline per deck.** Editing it on one slide in the editor (or saving a slide through the server or CLI with a
  changed nav) copies it to every slide that has one. New slides get the deck's current timeline and the chapter of
  the slide before them. If you edit slide files directly, run `slides toc <deck> --sync --from <id>` afterwards, or
  relabel everything at once with `slides toc <deck> --set "Intro|Method|Results"`. `slides toc <deck>` shows the
  labels, each slide's chapter, and any slide whose timeline differs.
- **In the editor:** the sidebar's "Chapters (timeline)" panel renames, adds, reorders and removes chapters for the
  whole deck (moving or removing one renumbers every slide's `data-section`, so slides stay with their chapter;
  `PUT /api/decks/<deck>/chapters`). The slide panel's "Chapter (timeline)" select sets one slide's chapter.
- **Present mode and exports:** each timeline item is a link to the first slide of that chapter. Double-click the
  slide number to type a slide number and jump there (Enter; Esc cancels).

## Themes that come with their own layouts

A theme can include its own layouts in `templates/layouts/<theme>/`, which replace the general layouts with the same name.
If that folder contains a `.exclusive` file, decks using the theme get only those layouts.
Run `slides layouts <deck>` to see what's available for a deck. `slides add` picks the right version automatically.

### `mprime` theme (U of U / mPRIME research talks)
Layouts: `title`, `content`, `split` (text | figure), `blank`. The frame is deliberately minimal:
- **Timeline:** content slides each carry the same `<nav class="toc">…</nav>` (Chapter 1, Chapter 2, Chapter 3 in the
  template). `data-section="N"` on the section says which chapter the slide is in: item N is highlighted and earlier
  ones are marked done. See "Section timelines" above for keeping it identical across slides.
- **Slide number and timer:** keep the empty `<div class="slide-num"></div>` and `<div class="slide-timer"></div>`.
  They're filled in when presenting (the timer counts up; click it to pause, press T to reset).
- **Logos:** U of U top-left, mPRIME top-right, from `decks/<deck>/assets/logos/uofu.png` and `mprime.png` (copied in
  when the theme is applied; replace a file to change it). Don't put logos in the slides. When presenting, the U logo
  links to the title slide and the mPRIME logo to the last slide (`--before-link: first; --after-link: last` in the theme).
- **Optional colour per section:** add `obj1` / `obj2` / `obj3` to the `<section>`.
- Body: `<div class="main">` vertically centres the content; also available are `.split`, `.figure`, `.caption`, `.cite` (source footer) and `.kicker`.
- Maths: use LaTeX equations (see "Equations" below).

Local themes that aren't part of the public repo are documented in `AGENTS.local.md`. Read it if it exists.

## Equations (LaTeX)

Equations are written in LaTeX and rendered with KaTeX (vendored in `vendor/katex/`, no CDN, works offline and in
exports). The LaTeX lives in `data-tex`; the element's children are the KaTeX rendering, which is generated for you:

```html
<p data-id="law">Basquin: <span class="math" data-tex="\sigma_a = \sigma_f' (2N_f)^b"></span></p>
<div class="math display" data-id="coffin" data-tex="\frac{\Delta\varepsilon}{2} = \frac{\sigma_f'}{E}(2N_f)^b + \varepsilon_f'(2N_f)^c"></div>
```

- Write the element **empty** (or leave the old rendering): saving through the editor or the CLI (`slides add`,
  `--stdin`, …) renders it. **After editing slide files directly, run `slides math <deck>`.** Present mode, exports,
  `render` and `check` render equations on the fly, so an unrendered one still shows correctly there. To change an
  equation, change `data-tex` only; never edit KaTeX's spans.
- `display` = its own line, centred; without it the equation sits inline in the text and scales with the text's
  font size. Escape `"` as `&quot;` and `&` (matrices) as `&amp;` inside `data-tex`. No `$…$` delimiters.
- `slides check` errors on LaTeX that doesn't parse and warns about equations that aren't rendered yet.
  `slides outline` shows equations as `$…$`.
- In the editor: **Equation** in the toolbar adds one (with a live preview); while editing text it is inserted inline
  at the cursor. Double-click an equation (or "Edit equation…" in the inspector) to change its LaTeX.

## Interactive embeds (sliders, buttons, live charts, three.js / WebGL)

Slides themselves stay static. Anything interactive goes in an **embed**: a small self-contained web page
in `decks/<deck>/assets/embeds/<name>/` that is placed on a slide with a `<figure class="embed">`.

```html
<figure class="figure embed" data-id="viewer"
        data-src="assets/embeds/viewer/index.html" data-poster="assets/embeds/viewer/poster.png">
  <img src="assets/embeds/viewer/poster.png" alt="What the view shows">
</figure>
```

- **The figure's children are its static view**, normally just the poster `<img>`. The editor, `slides render`
  and `slides check` only ever show the poster, and nothing in the embed runs there. The human wants static
  pictures while editing. The editor moves, resizes and comments on the figure like an image; its
  "▶ Live preview" button is off by default and is never saved.
- **Present mode and exports** put a sandboxed iframe (`sandbox="allow-scripts"`, no same-origin) over the
  poster while that slide is active. It replaces the poster at once (the poster is never shown while the page loads), and it is removed again
  when the slide is left, so at most one embed (one WebGL context) is alive at a time. State resets on revisit.
- The iframe fills the figure's box **in slide pixels**. Size the figure with the layout (or `width`/`height`
  styles) and design the page for that box; the slide's own scaling applies on top.

### The embed folder
```
assets/embeds/<name>/
  index.html     the page; scripts at the end of <body>, no defer/async
  app.js         your code
  lib/           libraries copied in (e.g. three.min.js + OrbitControls.js); never load from a CDN
  data.json      data files, any format; slice them per view, keep them small (a few MB at most)
  poster.png     the static picture (make it with `slides poster`)
  README.md      provenance (README/LICENSE/*.md are not exported)
```

### The `Embed` API (injected into every embed page; don't include it yourself)
- `Embed.start(async () => { … })` runs your code once the deck's theme and fonts have arrived.
- `Embed.ready()`: call it after the first frame is drawn. `slides poster` waits for it before the screenshot;
  present mode does not wait (the live page shows straight away).
- `Embed.data('data.json')` fetches and parses a file from the folder. Plain `fetch('relative/path')` works too, and both
  keep working after export, offline.
- **Theme:** the deck sends the slide's CSS variables (`--fg`, `--muted`, `--dim`, `--accent`, `--surface`,
  `--s1`…`--s5`, `--font-body`, `--font-head`, `--font-mono`, …) and its `@font-face` fonts. Use `var(--s1)` in
  CSS. For canvas/WebGL colours read them with `Embed.css('--s1', '#2A78D6')`. Put the same values as fallbacks in
  `:root` so the page also works on its own.
- **Keys:** ←/→/↑/↓, PageUp/PageDown, Home/End, N, T and F are handed back to the deck (they change slides,
  toggle notes and so on) unless focus is in a text field. Mouse and touch stay inside the embed.
- The page runs with an opaque origin: no `localStorage`, cookies or access to the parent page.

### CLI
- `slides embed <deck> <name>` scaffolds the folder from `templates/embed/` (a themed example with `Embed.ready()`)
  and prints the figure markup. `--from DIR` copies an existing folder instead.
- `slides poster <deck> <name>` opens the live embed in headless Chrome (SwiftShader WebGL), waits for
  `Embed.ready()` and screenshots it at 2× to `poster.png`. If a slide uses the embed, it is shot in place at
  the figure's real size and theme; `--slide ID`, `--scale N` and `--size WxH` (for an embed not on a slide yet) adjust this.
  Needs Node 22+ and a local Chrome/Chromium.
- `slides check` **errors** on a missing `data-src` page or poster (and on paths outside `assets/embeds/`), and
  **warns** about network-loaded scripts, `defer`/`async`, a missing `<img>`, a missing `Embed.ready()` and any
  `<script>` placed directly in a slide. Overflow is measured on the poster.

### Export
`slides export` still writes one self-contained HTML file. Each embed page is inlined with its scripts,
styles, images and fonts, plus every other file in its folder as `window.EMBED_DATA` (which is what serves `fetch()`
offline). The result is stored as escaped text in a hidden `<textarea>` and given to the iframe as **`srcdoc`**
when the slide becomes active. srcdoc rather than a blob URL because it needs no object-URL lifetime management,
has no `file://`/opaque-origin blob quirks, and keeps the text exact: only `&` and `<` are escaped, which keeps
multi-MB data cheap. Expect the export to grow by roughly the size of each embed folder (a three.js embed with its data slice is typically ~1 MB).

## Several agents at once

Several agents (and the human) can work on one deck at the same time. Every write is atomic, and the editor shows
each change within a second. To avoid overwriting one another:
- **Add slides only with `slides add … --after <id>`** (or `--stdin`), and reorder with `slides mv`. Never hand-edit
  `deck.json`: two agents rewriting it at once can lose each other's order changes. A slide file created directly
  is appended to the order automatically.
- **Stay on your own slides:** the ones you created or were assigned. Don't edit another agent's slides or `theme.css`
  unless that is your task. If you need something changed elsewhere, leave a note:
  `slides comment <deck> <slide> "…"`.
- **Re-read a slide file right before you edit it,** and make targeted edits instead of rewriting the whole file
  from an old copy. Someone may have changed it since you last looked.
- Use distinct, descriptive slide ids (`--id results-latency`) so parallel agents don't collide.
- Chapter timelines are deck-wide: change them with `slides toc`, not by editing one slide's `<nav>`.
- The editor's **Agent** button has a copy-ready "Join this deck" prompt with this repo's absolute paths for starting a new agent.

## Slide history (undo across agents)

Every version of a slide is kept in `decks/<deck>/.history/<id>/` (last 50): saves in the editor, CLI writes, and
direct file edits (picked up by the editor server, and by `slides comment` / `slides resolve`). Don't edit that folder.
- `slides history <deck> <slide>` lists versions (time, who: editor / agent via CLI / file edit / restore);
  `--show <version>` prints one.
- `slides restore <deck> <slide> <version>` puts one back (`-1` = the version before the current one). A restore is
  itself a new version, so it can be undone. If you broke a slide, or overwrote someone else's change, restore it.
- When you `slides resolve` a note, the slide as it was when the note was left and as it is now are stored on the
  note, and the human sees a before/after **See change** view. Make the edit first, then resolve.

## Presenter view and rehearsals

While presenting (`/present/<deck>` or an exported file), **P** (or the screen button) opens a presenter window: the
current slide at its click step, the next slide or click, large speaker notes, the talk timer, a clock and the
position. Both windows stay in sync either way (also from `file://` exports). Embeds run only in the audience window.
**● Rehearse** times each slide on the talk timer; **■ Finish** shows a table of time vs. target per slide.
- Targets: `slides target <deck> --minutes 20` (whole talk, `talkMinutes` in deck.json) and
  `slides target <deck> <slide> --seconds 90` (`data-time="90"` on the `<section>`). `slides target <deck>` lists them.
- `slides rehearsals <deck> [--all]` prints the last run (saved in `decks/<deck>/rehearsals.json` when presented from
  the server). Use it when asked to trim a talk: slides far over their target are the ones to shorten or split.
- Write speaker notes in `<aside class="notes">`: they are what the presenter reads.

## Workflow

1. **Orient**: `slides decks`, `slides outline <deck>`, `slides layouts`.
2. **Scaffold**: `slides new <deck> --title "…" --theme clean`, then
   `slides add <deck> --layout bullets --title "…" [--after <id>]` for each slide.
   This prints the file path. Then write the real content into that file with your file-editing tools.
   For a fully custom slide: `slides add <deck> --id my-slide --stdin < slide.html`.
3. **Verify visually**: `slides check <deck>` lays the deck out in headless Chrome
   and reports overflow, density and missing assets. `slides render <deck> --sheet`
   writes a contact-sheet PNG (`decks/<deck>/.renders/<deck>-sheet.png`), and
   `slides render <deck> <id>` renders one slide at full size. **Look at the PNGs**
   and fix what looks wrong, then check again.
4. **Human feedback loop**: the human leaves notes in the editor.
   - `slides comments <deck>` lists open notes: the slide, the `data-id` of the element the human clicked,
     the click position on the 1920×1080 slide (`at (x, y)`), and the text of that element (`on: "…"`).
     A note with a position but no target refers to that spot on the slide (e.g. "add a figure here").
   - Make the change in the slide file(s).
   - `slides resolve <deck> <comment-id> --reply "Shortened to 4 bullets"`.
   - To ask the human something: `slides comment <deck> <slide> "Which chart do you prefer?"`.
5. **Export** when asked: `slides export <deck> --out deck.html` (single file, assets and embeds inlined, works offline).
   Present mode, with speaker notes on `N` and the presenter view on `P`: open `/present/<deck>` in the editor.

## Example slide

```html
<section class="slide layout-two-col" data-layout="two-col">
  <h2 data-id="title">Latency dropped once we moved to edge caching</h2>
  <div class="cols">
    <div class="col" data-id="left">
      <h3>Before</h3>
      <ul><li>p95 at 840 ms</li><li>Every request hit origin</li></ul>
    </div>
    <div class="col" data-id="right">
      <h3 class="accent">After</h3>
      <ul><li>p95 at 120 ms</li><li>92% cache hit rate</li></ul>
    </div>
  </div>
  <aside class="notes">Pause here — this is the headline result.</aside>
</section>
```
