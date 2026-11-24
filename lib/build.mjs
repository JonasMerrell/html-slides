// Builds standalone HTML documents from a deck: the presentation/export file,
// and the pages headless Chrome uses for screenshots and overflow checks.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_CSS, deckDir, readMeta, readSlide, readThemeCss, escapeHtml, buildStepsOf } from './store.mjs';
import { findEmbeds, buildEmbedDoc } from './embed.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff' };

/** core + theme css, with @import rules hoisted so they stay valid. */
export function deckCss(d) {
  const all = fs.readFileSync(CORE_CSS, 'utf8') + '\n' + readThemeCss(d);
  const imports = [];
  const rest = all.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;\s*/g, (m) => { imports.push(m.trim()); return ''; });
  return imports.join('\n') + '\n' + rest;
}

function inlineAssets(d, html) {
  const dir = deckDir(d);
  const toData = (rel) => {
    const clean = decodeURIComponent(rel.split(/[?#]/)[0]);
    const p = path.join(dir, clean);
    if (!p.startsWith(path.join(dir, 'assets') + path.sep) || !fs.existsSync(p)) return null;
    const mime = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  };
  return html
    .replace(/(?<![\w-])((?:src|href|poster)\s*=\s*["'])(\.?\/?assets\/[^"']+)(["'])/gi, (m, a, rel, b) => { const u = toData(rel.replace(/^\.?\//, '')); return u ? a + u + b : m; })
    .replace(/url\((["']?)(\.?\/?assets\/[^)"']+)\1\)/gi, (m, q, rel) => { const u = toData(rel.replace(/^\.?\//, '')); return u ? `url("${u}")` : m; });
}

const PRESENT_CSS = `
html,body{margin:0;height:100%;background:#000;overflow:hidden}
.deck{position:fixed;inset:0}
.deck>.slide{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(var(--s,1));visibility:hidden}
.deck>.slide.active{visibility:visible}
.deck>.slide [data-build]:not(.built){visibility:hidden!important;opacity:0}
.deck>.slide.active [data-build][data-build-effect="fade"]{transition:opacity .45s ease,visibility .45s}
.deck>.slide [data-build][data-build-effect="zoom"]:not(.built){transform:scale(.06)}
.deck>.slide.active [data-build][data-build-effect="zoom"]{transition:transform .6s cubic-bezier(.2,.7,.2,1),opacity .35s ease,visibility .6s}
.hud{position:fixed;right:16px;bottom:12px;font:13px/1 system-ui,sans-serif;color:rgba(255,255,255,.55);opacity:0;transition:opacity .3s;pointer-events:none}
body:hover .hud{opacity:1}
.ctrl{position:fixed;right:14px;bottom:12px;display:flex;gap:6px;z-index:10;transition:opacity .4s}
.ctrl button{width:44px;height:44px;border-radius:50%;border:1px solid rgba(120,130,140,.35);background:rgba(255,255,255,.72);color:#55606b;font:28px/1 system-ui,sans-serif;display:grid;place-items:center;cursor:pointer;padding:0 0 3px;backdrop-filter:blur(4px);box-shadow:0 2px 8px rgba(0,0,0,.12)}
.ctrl button:hover{background:#fff;color:#14181c}
.ctrl button.next{color:#dc2626}
.ctrl button:disabled{opacity:.35;cursor:default}
body.idle .ctrl{opacity:.18}
.deck .toc-link{cursor:pointer}
.deck .slide-num{cursor:pointer;user-select:none}
.deck .slide-num.jump{cursor:text;user-select:text;outline:2px solid currentColor;outline-offset:4px;border-radius:3px;min-width:2.5em;display:inline-block}
.deck .toc-link:hover{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:.3em}
#notes{position:fixed;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;background:rgba(15,15,20,.94);color:#eee;font:18px/1.5 system-ui,sans-serif;padding:18px 28px;display:none;white-space:pre-wrap}
body.show-notes #notes{display:block}
@media print{
  @page{size:1920px 1080px;margin:0}
  html,body{background:none;height:auto;overflow:visible}
  .deck{position:static}
  .deck>.slide{position:relative;left:auto;top:auto;transform:none;visibility:visible;break-after:page;page-break-after:always}
  .hud,#notes,.ctrl,.embed-frame{display:none!important}
  .deck>.slide [data-build]{visibility:visible!important;opacity:1!important}
  .slide figure.embed.live>*{visibility:visible!important}
}`;

const PRESENT_JS = `
(()=>{const S=[...document.querySelectorAll('.deck>.slide')];let i=-1;const pad=n=>String(n).padStart(2,'0');
S.forEach((s,k)=>s.querySelectorAll('.slide-num:empty').forEach(e=>{e.textContent=pad(k+1)+' / '+pad(S.length)}));
const TK='slides-timer:'+location.pathname;let t0=Date.now(),acc=0,paused=false;
try{const v=JSON.parse(sessionStorage.getItem(TK));if(v){t0=v.t0;acc=v.acc;paused=v.paused}}catch{}
const save=()=>{try{sessionStorage.setItem(TK,JSON.stringify({t0,acc,paused}))}catch{}};const el=()=>paused?acc:acc+Date.now()-t0;
function tick(){const t=Math.floor(el()/1000),txt=Math.floor(t/60)+':'+String(t%60).padStart(2,'0')+(paused?' ❚❚':'');document.querySelectorAll('.slide-timer').forEach(e=>{e.textContent=txt;e.title='Click: pause/resume · T: reset'})}
function pause(){if(paused){t0=Date.now();paused=false}else{acc=el();paused=true}save();tick()}save();
setInterval(tick,1000);tick();const hud=document.querySelector('.hud');const notes=document.getElementById('notes');
function fit(){document.documentElement.style.setProperty('--s',Math.min(innerWidth/1920,innerHeight/1080))}
const prev=document.querySelector('.ctrl .prev'),next=document.querySelector('.ctrl .next');
// ---- interactive embeds: an iframe exists only while its slide is active (one WebGL context at a time)
const DECK=document.querySelector('.deck'),EB=DECK.dataset.embedBase||'';
const docOf=src=>{const t=[...document.querySelectorAll('textarea.embed-doc')].find(x=>x.dataset.src===src);return t?t.value:null};
function startEmbeds(sec){sec.querySelectorAll('figure.embed[data-src]').forEach(fig=>{if(fig.querySelector(':scope>iframe.embed-frame'))return;
 const src=fig.dataset.src,doc=docOf(src);if(doc==null&&!EB)return;
 const f=document.createElement('iframe');f.className='embed-frame';f.setAttribute('sandbox','allow-scripts');f.title=fig.dataset.id||'interactive figure';
 if(doc!=null)f.srcdoc=doc;else f.src=EB+src;
 fig.appendChild(f);fig.classList.add('live')})} // live at once: the poster is never shown in present/export
function stopEmbeds(sec){sec.querySelectorAll('figure.embed').forEach(fig=>{clearTimeout(fig.__t);fig.classList.remove('live');
 fig.querySelectorAll(':scope>iframe.embed-frame').forEach(f=>{f.removeAttribute('srcdoc');f.src='about:blank';f.remove()})})}
let VARS=null,FONTS=null;
function eachRule(cb){const walk=rs=>{for(const r of rs){cb(r);if(r.cssRules&&!r.selectorText)walk(r.cssRules)}};for(const s of document.styleSheets){try{walk(s.cssRules)}catch(e){}}}
function theme(fig){
 if(!VARS){const n=new Set();eachRule(r=>{if(r.selectorText&&/\\.slide\\b/.test(r.selectorText))for(const p of r.style)if(p.startsWith('--'))n.add(p)});VARS=[...n]}
 if(FONTS==null){const f=[];eachRule(r=>{if(r.constructor&&r.constructor.name==='CSSFontFaceRule'){const b=(r.parentStyleSheet&&r.parentStyleSheet.href)||document.baseURI;
  f.push(r.cssText.replace(/url\\((["']?)([^)"']+)\\1\\)/g,(m,q,u)=>/^(data|blob|https?):/i.test(u)?m:'url("'+new URL(u,b).href+'")'))}});FONTS=f.join('\\n')}
 const cs=getComputedStyle(fig),vars={};for(const n of VARS)vars[n]=cs.getPropertyValue(n).trim();
 return{__embed:1,type:'theme',vars,fontCss:FONTS,colorScheme:cs.colorScheme||'light'}}
addEventListener('message',e=>{const m=e.data;if(!m||!m.__embed)return;const f=[...document.querySelectorAll('iframe.embed-frame')].find(x=>x.contentWindow===e.source);if(!f)return;const fig=f.parentElement;
 if(m.type==='hello')e.source.postMessage(theme(fig),'*');
 else if(m.type==='ready'){clearTimeout(fig.__t);fig.classList.add('live');window.__embedsReady=(window.__embedsReady||0)+1}
 else if(m.type==='error')console.error('embed '+fig.dataset.src+': '+m.message);
 else if(m.type==='key')key(m.key)});
// ---- click builds: elements with data-build="N" appear on the Nth click (same N = together); data-build-effect="fade" fades
let step=0;const steps=s=>[...new Set([...s.querySelectorAll('[data-build]')].map(e=>parseFloat(e.dataset.build)).filter(v=>isFinite(v)))].sort((a,b)=>a-b);
function show(k){const st=steps(S[i]);step=Math.max(0,Math.min(st.length,k));const lim=step?st[step-1]:-Infinity;
 S[i].querySelectorAll('[data-build]').forEach(e=>e.classList.toggle('built',parseFloat(e.dataset.build)<=lim));
 prev.disabled=i===0&&step===0;next.disabled=i===S.length-1&&step===st.length}
function fwd(){if(step<steps(S[i]).length)show(step+1);else if(i<S.length-1)go(i+1)}
function back(){if(step>0)show(step-1);else if(i>0)go(i-1,true)}
function go(n,atEnd){const j=Math.max(0,Math.min(S.length-1,n));if(j!==i&&S[i])stopEmbeds(S[i]);i=j;S.forEach((s,k)=>s.classList.toggle('active',k===i));startEmbeds(S[i]);show(atEnd?Infinity:0);history.replaceState(null,'','#'+(i+1));hud.textContent=(i+1)+' / '+S.length;const a=S[i]&&S[i].querySelector('.notes');notes.textContent=a?a.textContent.trim():''}
addEventListener('resize',fit);fit();go((parseInt(location.hash.slice(1))||1)-1);
addEventListener('hashchange',()=>{const n=(parseInt(location.hash.slice(1))||1)-1;if(n!==i)go(n)});
function key(k){
 if(k==='t'||k==='T'){acc=0;t0=Date.now();save();tick();return true}
 if(['ArrowRight','ArrowDown','PageDown',' ','Enter'].includes(k)){fwd();return true}
 if(['ArrowLeft','ArrowUp','PageUp','Backspace'].includes(k)){back();return true}
 if(k==='Home'){go(0);return true}if(k==='End'){go(S.length-1);return true}
 if(k==='f'||k==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();return true}
 if(k==='n'||k==='N'){document.body.classList.toggle('show-notes');return true}return false}
addEventListener('keydown',e=>{if(e.metaKey||e.ctrlKey||e.altKey)return;if(e.target.closest&&e.target.closest('input,textarea,select,[contenteditable]'))return;if(key(e.key))e.preventDefault()});
// Clicks on the slide belong to the slide (interactive content); navigation is buttons + keys only.
// ---- timeline links: item N of a <nav class="toc"> jumps to the first slide with data-section="N"
const sec=n=>S.findIndex(s=>s.dataset.section===String(n));
S.forEach(s=>s.querySelectorAll('.toc').forEach(t=>[...t.children].forEach((c,k)=>{if(sec(k+1)>=0){c.classList.add('toc-link');c.setAttribute('role','link');c.title='Go to this section'}})));
// ---- logo links: a theme sets --before-link / --after-link (first | last | N) on .slide to make its ::before / ::after logo a link
function logoAt(e){const s=S[i];if(!s)return -1;const r=s.getBoundingClientRect(),k=r.width/1920,x=(e.clientX-r.left)/k,y=(e.clientY-r.top)/k,cs=getComputedStyle(s);
 for(const p of ['before','after']){const t=cs.getPropertyValue('--'+p+'-link').trim();if(!t)continue;const c=getComputedStyle(s,'::'+p);if(c.content==='none')continue;
  const W=parseFloat(c.width),H=parseFloat(c.height),T=parseFloat(c.top);let L=parseFloat(c.left);if(isNaN(L))L=1920-parseFloat(c.right)-W;
  if(x>=L&&x<=L+W&&y>=T&&y<=T+H)return t==='first'?0:t==='last'?S.length-1:Math.max(0,Math.min(S.length-1,(parseInt(t)||1)-1))}return -1}
addEventListener('mousemove',e=>{document.documentElement.style.cursor=logoAt(e)>=0?'pointer':''});
addEventListener('click',e=>{if(e.target.closest('.slide-timer'))pause();
 const l=e.target.closest('.toc-link');if(l){const j=sec([...l.parentNode.children].indexOf(l)+1);if(j>=0&&j!==i)go(j);return}
 if(e.target.closest('.slide-num[contenteditable]'))return;const j=logoAt(e);if(j>=0&&j!==i)go(j)});
// ---- jump to a slide: double-click the slide number, type a number, Enter (Esc cancels)
addEventListener('dblclick',e=>{const n=e.target.closest('.slide-num');if(!n||n.isContentEditable)return;e.preventDefault();
 const old=n.textContent;n.contentEditable='true';n.classList.add('jump');n.textContent=String(i+1);n.focus();getSelection().selectAllChildren(n);
 const done=ok=>{if(!n.isContentEditable)return;const v=parseInt(n.textContent,10);n.removeAttribute('contenteditable');n.classList.remove('jump');n.textContent=old;n.onkeydown=n.onblur=null;if(ok&&v>=1&&v<=S.length&&v-1!==i)go(v-1)};
 n.onkeydown=ev=>{ev.stopPropagation();if(ev.key==='Enter'){ev.preventDefault();done(true)}else if(ev.key==='Escape')done(false)};n.onblur=()=>done(false)});
[prev,next].forEach(b=>b.addEventListener('mousedown',e=>e.preventDefault()));
prev.addEventListener('click',back);next.addEventListener('click',fwd);
let idle;const wake=()=>{document.body.classList.remove('idle');clearTimeout(idle);idle=setTimeout(()=>document.body.classList.add('idle'),2500)};
addEventListener('mousemove',wake);wake();
})();`;

/**
 * Self-contained presentation. opts.inline embeds assets as data URIs (export);
 * opts.base sets a <base href> instead (live present mode from the server).
 */
export function buildPresentation(d, { inline = true, base = null, liveReload = false } = {}) {
  const meta = readMeta(d);
  let body = meta.slides.map((id) => readSlide(d, id).trim().replace(/^<section\b/i, `<section data-slide-id="${id}"`)).join('\n');
  let css = deckCss(d);
  if (inline) { body = inlineAssets(d, body); css = inlineAssets(d, css); }
  // Interactive embeds. Export: each embed page is inlined (scripts, data and all) and stored as text in a
  // hidden <textarea>; the player hands it to the iframe as srcdoc when the slide becomes active.
  // Live present mode: the iframe loads /embed/<deck>/<data-src> from the server instead.
  let embedDocs = '';
  if (inline) {
    const srcs = new Set();
    for (const id of meta.slides) for (const e of findEmbeds(readSlide(d, id))) if (e.src) srcs.add(e.src);
    for (const src of srcs) {
      let doc;
      try { doc = buildEmbedDoc(d, src, { inline: true }); } catch { continue; } // missing page: the poster stays
      embedDocs += `<textarea hidden class="embed-doc" data-src="${escapeHtml(src)}">${doc.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>\n`;
    }
  }
  const embedBase = !inline && base ? ` data-embed-base="/embed/${escapeHtml(d)}/"` : '';
  const reload = liveReload
    ? `<script>try{const es=new EventSource('/api/events');es.onmessage=e=>{const m=JSON.parse(e.data);if(m.deck===${JSON.stringify(d)})location.reload()}}catch{}</script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${escapeHtml(meta.title)}</title>
${base ? `<base href="${escapeHtml(base)}">` : ''}
<style>
${css}
${PRESENT_CSS}
</style>
</head>
<body>
<main class="deck" data-deck="${escapeHtml(d)}"${embedBase}>
${body}
</main>
${embedDocs}
<div class="hud"></div>
<nav class="ctrl"><button class="prev" type="button" aria-label="Previous slide" title="Previous (←)">&#8249;</button><button class="next" type="button" aria-label="Next slide" title="Next (→)">&#8250;</button></nav>
<div id="notes"></div>
<script>${PRESENT_JS}</script>
${reload}
</body>
</html>
`;
}

/**
 * Page for headless Chrome: every requested slide stacked (or as a contact sheet),
 * plus a script that measures overflow and writes JSON into #__result.
 */
// items: slide ids, or { id, step } to show a click-build snapshot (step 0 = before any click, N = after the Nth)
export function buildRenderPage(d, items, { sheet = false, cols = 3 } = {}) {
  const base = pathToFileURL(deckDir(d) + path.sep).href;
  const order = readMeta(d).slides;
  const pad = (n) => String(n).padStart(2, '0');
  const numbered = (id) => readSlide(d, id).replace(/(<div class="slide-num"[^>]*>)(<\/div>)/g, `$1${pad(order.indexOf(id) + 1)} / ${pad(order.length)}$2`);
  const cell = (it, n) => {
    const id = typeof it === 'string' ? it : it.id, step = typeof it === 'string' ? null : it.step;
    const html = numbered(id);
    let css = '', label = id;
    if (step != null) {
      const vals = buildStepsOf(html), lim = step > 0 ? vals[Math.min(step, vals.length) - 1] : -Infinity;
      const raw = [...new Set([...html.matchAll(/\sdata-build="([^"]*)"/g)].map((m) => m[1]))];
      const hide = raw.filter((r) => parseFloat(r) > lim).map((r) => `.cell[data-n="${n}"] .slide [data-build="${r.replace(/["\\]/g, '\\$&')}"]`);
      if (hide.length) css = `<style>${hide.join(',')}{visibility:hidden!important}</style>`;
      label = `${id} · ${step ? `click ${step}` : 'start'}`;
    }
    return `<div class="cell" data-id="${id}" data-n="${n}">${css}${sheet ? `<div class="label">${label}</div>` : ''}<div class="frame">${html}</div></div>`;
  };
  const body = items.map(cell).join('\n');
  const scale = sheet ? 0.25 : 1;
  const layout = sheet
    ? `body{margin:0;background:#cfd2d8;padding:20px;display:grid;grid-template-columns:repeat(${cols},${1920 * scale}px);gap:28px 20px;width:max-content}
       .cell{display:flex;flex-direction:column;gap:6px}.label{font:600 15px system-ui,sans-serif;color:#333}
       .frame{width:${1920 * scale}px;height:${1080 * scale}px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.25)}
       .frame>.slide{transform:scale(${scale});transform-origin:0 0}`
    : `body{margin:0}.cell{width:1920px;height:1080px;overflow:hidden}`;
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}">
<style>${deckCss(d)}
${layout}</style></head><body>${body}
<pre id="__result" style="display:none"></pre>
<script>
(function(){
  const out = {};
  document.querySelectorAll('.cell').forEach(cell => {
    const sec = cell.querySelector('.slide'); if (!sec) return;
    const sr = sec.getBoundingClientRect(); const sx = sr.width / 1920;
    const over = [], flagged = new Set();
    sec.querySelectorAll('*').forEach(el => {
      if (el.closest('.notes') || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) return;
      const r = el.getBoundingClientRect(); if (!r.width && !r.height) return;
      const l = (r.left - sr.left) / sx, t = (r.top - sr.top) / sx, rr = (r.right - sr.left) / sx, b = (r.bottom - sr.top) / sx;
      if (l < -2 || t < -2 || rr > 1922 || b > 1082) {
        flagged.add(el);
        if (el.parentElement && flagged.has(el.parentElement)) return;
        over.push(el.dataset.id || el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : ''));
      }
    });
    const text = sec.cloneNode(true); text.querySelectorAll('.notes').forEach(n => n.remove());
    const words = (text.textContent || '').trim().split(/\\s+/).filter(Boolean).length;
    out[cell.dataset.id] = { overflow: [...new Set(over)], words };
  });
  document.getElementById('__result').textContent = JSON.stringify(out);
})();
</script></body></html>`;
}
