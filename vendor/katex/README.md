# KaTeX 0.19.1 (vendored)

From the `katex@0.19.1` npm package (MIT, see LICENSE): `dist/katex.min.js`, `dist/katex.min.css` and the
`.woff2` fonts. The CSS was trimmed to reference only the woff2 files. Used by `lib/math.mjs` (renders
equations into slide HTML at save time) and by the editor's equation dialog (live preview). Slides themselves
never load the script: only the CSS and fonts are needed to show a rendered equation.
