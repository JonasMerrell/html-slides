---
name: html-slides
description: Create, edit, review or restyle HTML slide decks in this repo (decks/<deck>/slides/*.html), and address the human's slide comments. Use whenever the user asks for slides, a deck, a presentation, or to work through deck notes/comments.
---

# HTML slides

Read `AGENTS.md` at the repo root first. It is the full contract. In short:

1. `node bin/slides.mjs outline <deck>` (or `decks` / `layouts`) to orient.
2. Scaffold with `node bin/slides.mjs new|add`, then write the content directly into
   `decks/<deck>/slides/<id>.html`: one `<section class="slide layout-…">` per file, 1920×1080.
   Use the classes from `core/slides.css`, give key elements `data-id`, and put speaker notes in `<aside class="notes">`.
3. Always verify: `node bin/slides.mjs check <deck>`, then
   `node bin/slides.mjs render <deck> --sheet`, and **Read the PNG** it prints to check the result visually.
   Fix overflow and crowding, and re-check.
4. Comments: `node bin/slides.mjs comments <deck>`, edit, then
   `node bin/slides.mjs resolve <deck> <id> --reply "…"` for each.
5. Interactive content (sliders, live charts, three.js) goes in an embed, never a `<script>` in a slide:
   `node bin/slides.mjs embed <deck> <name>`, then `poster`. See "Interactive embeds" in AGENTS.md.
6. Keep the human's manual edits (inline `translate`/size styles, `.free` elements) unless asked to change them.

The human may have the editor open, and it live-reloads your file changes, so keep each save to a valid slide.
