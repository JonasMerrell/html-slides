/*
 * HTML Slides embed runtime. Injected at the top of every embed page when it runs live
 * (present mode, export, `slides poster`, the editor's live preview). Embed pages don't
 * include it themselves.
 *
 *   Embed.start(fn)   run fn once the deck theme (CSS variables + fonts) has arrived
 *   Embed.ready()     tell the deck the first frame is drawn (it then swaps out the poster)
 *   Embed.css(name, fallback)   read a theme variable, e.g. Embed.css('--s1', '#2A78D6')
 *   Embed.data(path)  fetch + JSON.parse a file from the embed folder (works offline after export)
 *
 * fetch('relative/path') keeps working after export: files inlined into window.EMBED_DATA
 * are served from memory. Slide keys (←/→, PageUp/Down, Home/End, N, T, F) are handed back to
 * the deck, so arrow keys change slides even while the embed has focus.
 */
(function () {
  'use strict';
  if (window.Embed) return;
  var root = document.documentElement;
  var inFrame = window.parent && window.parent !== window;

  function post(msg) {
    if (!inFrame) return;
    msg.__embed = 1;
    try { window.parent.postMessage(msg, '*'); } catch (_) { /* host gone */ }
  }

  // ---------- offline data
  var DATA = window.EMBED_DATA || null;
  function key(u) {
    if (typeof u !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.charAt(0) === '/' || u.charAt(0) === '#') return null;
    var out = [];
    u.split(/[?#]/)[0].split('/').forEach(function (p) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); });
    return out.join('/');
  }
  function bytes(b64) {
    var s = atob(b64), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  if (DATA && window.fetch) {
    var realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var k = key(typeof input === 'string' ? input : null);
      var e = k != null ? DATA[k] : null;
      if (e) {
        var body = e.t === 'b64' ? bytes(e.v) : e.v;
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': e.type || 'application/octet-stream' } }));
      }
      return realFetch(input, init);
    };
  }

  // ---------- theme from the deck
  var themeDone;
  var theme = new Promise(function (res) { themeDone = res; });
  function applyTheme(m) {
    var vars = m.vars || {};
    for (var k in vars) if (vars[k]) root.style.setProperty(k, vars[k]);
    if (m.colorScheme) root.style.colorScheme = m.colorScheme;
    if (m.fontCss) {
      var st = document.createElement('style');
      st.setAttribute('data-embed-fonts', '');
      st.textContent = m.fontCss;
      (document.head || root).appendChild(st);
    }
    root.setAttribute('data-embed-theme', 'deck');
    themeDone(vars);
  }
  window.addEventListener('message', function (e) {
    if (!inFrame || e.source !== window.parent) return;
    var m = e.data;
    if (m && m.__embed && m.type === 'theme') applyTheme(m);
  });
  post({ type: 'hello' });
  // Opened on its own (or the host never answers): use the page's own CSS fallbacks.
  setTimeout(function () { themeDone(null); }, inFrame ? 1500 : 0);

  // ---------- hand slide keys back to the deck
  var FWD = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, PageUp: 1, PageDown: 1, Home: 1, End: 1, n: 1, N: 1, t: 1, T: 1, f: 1, F: 1 };
  var TYPING = 'textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset])';
  window.addEventListener('keydown', function (e) {
    if (!inFrame || e.metaKey || e.ctrlKey || e.altKey || !FWD[e.key]) return;
    var t = e.target;
    if (t && t.closest && t.closest(TYPING)) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'key', key: e.key });
  }, true);

  // ---------- errors go to the host console (present mode keeps the poster)
  window.addEventListener('error', function (e) { post({ type: 'error', message: String(e.message || e.error) }); });
  window.addEventListener('unhandledrejection', function (e) { post({ type: 'error', message: String(e.reason && e.reason.message || e.reason) }); });

  window.Embed = {
    inFrame: inFrame,
    theme: theme,
    start: function (fn) {
      return theme
        .then(function () { return document.fonts ? document.fonts.ready : null; })
        .then(function () { return fn(); })
        .catch(function (err) { post({ type: 'error', message: String(err && err.stack || err) }); throw err; });
    },
    ready: function () {
      if (window.EMBED_READY) return;
      window.EMBED_READY = true;
      post({ type: 'ready' });
    },
    css: function (name, fallback) {
      var v = getComputedStyle(root).getPropertyValue(name).trim();
      return v || fallback || '';
    },
    data: function (p) {
      return fetch(p).then(function (r) { if (!r.ok) throw new Error(p + ': HTTP ' + r.status); return r.json(); });
    },
  };
})();
