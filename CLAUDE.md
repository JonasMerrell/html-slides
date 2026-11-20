@AGENTS.md
@AGENTS.local.md

## Developing the editor itself

- Zero dependencies, no build step. `server.mjs` (HTTP + SSE change feed),
  `lib/store.mjs` (all file I/O; shared by server and CLI), `lib/build.mjs`
  (present/export/render pages), `lib/chrome.mjs` (headless Chrome),
  `public/app.js` (the editor UI, vanilla JS).
- The server polls `decks/` for changes every 700 ms and pushes them over
  `/api/events`. The editor diffs against its own last save to tell agent edits apart from its own echoes.
- Interactive embeds: `lib/embed.mjs` (find/validate embeds, build the embed page: inlined for export,
  `<base>` for the server's `/embed/<deck>/…` route), `core/embed-runtime.js` (injected into every embed page:
  theme handshake, `Embed.ready()`, offline `fetch`, key forwarding), the player in `lib/build.mjs`
  (PRESENT_JS: iframe only on the active slide), `lib/cdp.mjs` (dependency-free DevTools client used by
  `slides poster`). The editor never runs embeds except through its explicit live-preview button.
- Slides render in a same-origin iframe at 1920×1080, scaled with a CSS transform.
  Manual moves use the CSS `translate` property, so flow layout is never disturbed.
