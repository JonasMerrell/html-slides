# HTML Slides

An HTML slide editor built for working with agents. Each deck is a folder of
plain HTML files. An agent writes and restructures them on disk, and you refine
them in a visual editor that live-reloads whenever the agent saves.

```bash
npm start                    # editor → http://127.0.0.1:4173   (no npm install needed)
node bin/slides.mjs help     # CLI used by agents (and you)
```

Requires Node 18+. Install Chrome or Chromium if you want `render`/`check`, which let an agent see its slides.
On a remote machine, forward the port with `ssh -L 4173:127.0.0.1:4173 host`, or start with `--host 0.0.0.0`.

## The loop

1. **Agent drafts.** In Claude Code (or any agent) in this folder:
   *"Make a 10-slide deck about X for Y."* `AGENTS.md` and the `html-slides` skill
   explain the file format and CLI. The agent scaffolds slides from layouts, writes the content,
   then runs `slides check` and `slides render --sheet` and looks at the PNGs to fix problems.
2. **You refine** in the editor:
   - click to select; drag to move; use the handles to resize; Shift locks the axis; Alt turns off snapping
   - double-click to rewrite text in place; Esc selects the parent element
   - add text boxes and images (or drop or paste images onto the slide)
   - use the inspector for font size, colour, alignment and classes, plus speaker notes, raw HTML and theme CSS
   - reorder slides by dragging thumbnails; ⌘Z / ⌘⇧Z undo and redo (agent edits are in the undo history too)
3. **You leave notes** pinned to elements ("make this punchier"). Then tell the agent
   *"address the open comments in deck X"*. It runs `slides comments`, edits the files and
   resolves each note with a reply, and you watch the slides update live.
4. **Present / export.** **Present** opens a live presentation (arrow keys, `F` fullscreen,
   `N` speaker notes; timeline items link to their chapter, double-click the slide number to jump to a slide).
   **Export** downloads one self-contained `.html` file (print it to PDF if needed).

## Layout

| Path | What |
|---|---|
| `decks/<deck>/slides/*.html` | one `<section class="slide">` per file, 1920×1080 |
| `decks/<deck>/deck.json` | title, theme, slide order |
| `decks/<deck>/theme.css` | the deck's own theme (copied from a template, edit freely) |
| `decks/<deck>/comments.json` | human ↔ agent notes |
| `templates/layouts/` | slide layouts (title, agenda, bullets, two-col, cards, image-right, image-full, stats, quote, code, closing, blank). Add your own with **Save as layout** in the editor |
| `templates/themes/` | base themes: `clean`, `midnight`, `paper`, `mprime` (fonts and other theme assets live in `templates/themes/assets/` and are copied into a deck when the theme is applied) |
| `templates/layouts/<theme>/` | layouts that belong to one theme (e.g. `mprime`) and replace the general layouts with the same name |
| `core/slides.css` | the layout classes and utilities that every theme builds on |

Interactive pieces (sliders, live charts, three.js views) are **embeds**: self-contained pages under
`decks/<deck>/assets/embeds/` that show a static poster while editing and run live when presenting and in exports.
See "Interactive embeds" in `AGENTS.md` (`slides embed`, `slides poster`).

Because decks are just files, `git` gives you history, diffs and rollback for both your edits and the agent's.
