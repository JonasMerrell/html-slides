// Builds standalone HTML documents from a deck: the presentation/export file,
// and the pages headless Chrome uses for screenshots and overflow checks.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_CSS, deckDir, readMeta, readSlide, readThemeCss, escapeHtml, buildStepsOf } from './store.mjs';
import { findEmbeds, buildEmbedDoc } from './embed.mjs';
import { renderMathIn, hasMath, katexCss, fontDataUri, KATEX_DIR } from './math.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff' };

/** core + theme css, with @import rules hoisted so they stay valid. */
export function deckCss(d) {
  const all = fs.readFileSync(CORE_CSS, 'utf8') + '\n' + readThemeCss(d);
  const imports = [];
  const rest = all.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;\s*/g, (m) => { imports.push(m.trim()); return ''; });
  return imports.join('\n') + '\n' + rest;
}

/** KaTeX's CSS with its fonts as data: URIs ('inline'), /vendor/katex/ URLs ('server') or file:// URLs ('file'). */
export function mathCss(mode) {
  if (mode === 'inline') return katexCss(fontDataUri);
  if (mode === 'file') return katexCss((f) => pathToFileURL(path.join(KATEX_DIR, 'fonts', f)).href);
  return katexCss((f) => `/vendor/katex/fonts/${f}`);
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
body.presenter{background:#14161b;color:#e7e8ec;font:15px/1.4 system-ui,sans-serif}
body.presenter .deck,body.presenter .ctrl,body.presenter .hud,body.presenter #notes{display:none!important}
#pv{position:fixed;inset:0;display:grid;grid-template-columns:minmax(0,62fr) minmax(0,38fr);grid-template-rows:auto minmax(0,1fr) auto;gap:12px 16px;padding:12px 16px;box-sizing:border-box}
#pv header{grid-column:1/-1;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
#pv .pv-sp{flex:1}
#pv .pv-pos{font-size:19px;font-weight:600}
#pv .pv-timer{font:600 34px/1 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;color:#fff}
#pv .pv-goal,#pv .pv-clock{font:18px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa0ad}
#pv .pv-goal.over{color:#ff6b6b}
#pv button{background:#262a33;color:#e7e8ec;border:1px solid #3a3f4b;border-radius:8px;padding:7px 12px;font:14px/1 system-ui,sans-serif;cursor:pointer}
#pv button:hover{background:#323743}
#pv button.pv-nav{font-size:24px;padding:4px 16px 7px}
#pv button.pv-next-btn{background:#7c4dff;border-color:#7c4dff;color:#fff}
#pv button.pv-reh-btn.on{background:#c62828;border-color:#c62828;color:#fff}
#pv .pv-area{position:relative;min-height:0;min-width:0;display:grid;place-items:center}
#pv .pv-box{position:relative;overflow:hidden;background:#000;box-shadow:0 4px 24px rgba(0,0,0,.5);border-radius:4px}
#pv .pv-box>.slide{position:absolute;left:0;top:0;transform-origin:0 0;visibility:visible;margin:0}
#pv .pv-box .slide [data-build]:not(.built){visibility:hidden!important}
#pv .pv-end{position:absolute;inset:0;display:grid;place-items:center;color:#9aa0ad;font-size:18px;background:#1b1e25}
#pv .pv-side{display:grid;grid-template-rows:auto minmax(0,38%) auto minmax(0,1fr);gap:8px;min-height:0}
#pv .pv-label{color:#9aa0ad;font-size:12px;text-transform:uppercase;letter-spacing:.07em;font-weight:600}
#pv .pv-notes{overflow:auto;font-size:var(--pv-notes,26px);line-height:1.45;white-space:pre-wrap;background:#0d0f13;border-radius:8px;padding:14px 18px}
#pv .pv-notes.empty{color:#6b7080;font-size:16px}
#pv .pv-bar{grid-column:1/-1;font:16px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa0ad;min-height:0}
#pv .pv-bar.on{color:#fff;background:#262a33;border-radius:8px;padding:8px 12px}
#pv .pv-bar.over{background:#5c1d1d}
#pv .pv-report{position:absolute;inset:0;background:rgba(0,0,0,.6);display:grid;place-items:center;z-index:5}
#pv .pv-card{background:#1d2028;border:1px solid #3a3f4b;border-radius:12px;padding:20px 24px;max-width:min(900px,94vw);max-height:88vh;overflow:auto;box-sizing:border-box}
#pv .pv-card h2{margin:0 0 12px;font-size:20px}
#pv table{border-collapse:collapse;width:100%;font-size:14px}
#pv th{text-align:left;color:#9aa0ad;font-weight:600;border-bottom:1px solid #3a3f4b;padding:6px 10px}
#pv td{padding:5px 10px;border-bottom:1px solid #2a2e37}
#pv tr:not(.total):hover td{background:#262a33;cursor:pointer}
#pv td.n,#pv th:nth-child(n+3){text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
#pv td.over{color:#ff6b6b}#pv td.ok{color:#5fd38d}
#pv tr.total td{font-weight:700;border-top:2px solid #3a3f4b}
#pv .pv-muted{color:#9aa0ad;font-size:13px;margin:10px 0 0}
#pv .pv-row{display:flex;justify-content:flex-end;margin-top:14px}
#notes{position:fixed;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;background:rgba(15,15,20,.94);color:#eee;font:18px/1.5 system-ui,sans-serif;padding:18px 28px;display:none;white-space:pre-wrap}
body.show-notes #notes{display:block}
@media print{
  @page{size:1920px 1080px;margin:0}
  html,body{background:none;height:auto;overflow:visible}
  .deck{position:static}
  .deck>.slide{position:relative;left:auto;top:auto;transform:none;visibility:visible;break-after:page;page-break-after:always}
  .hud,#notes,.ctrl,.embed-frame,#pv{display:none!important}
  .deck>.slide [data-build]{visibility:visible!important;opacity:1!important}
  .slide figure.embed.live>*{visibility:visible!important}
}`;

const PRESENTER_JS = String.raw`// ---- presenter view (?presenter): current + next slide, notes, timer, clock, rehearsal.
// Windows stay in sync (slide, click step, timer) over BroadcastChannel and, for file:// exports, postMessage.
const ME=Math.random().toString(36).slice(2),SEEN={},peers=new Set();let seq=0,remote=false,pw=null,bc=null;
try{bc=new BroadcastChannel('slides-present:'+(DECK.dataset.deck||location.pathname))}catch(e){}
function send(m){m.__pres=1;m.from=ME;m.seq=++seq;try{bc&&bc.postMessage(m)}catch(e){}
 const ws=new Set(peers);if(window.opener)ws.add(window.opener);if(pw)ws.add(pw);ws.forEach(w=>{try{if(w&&!w.closed)w.postMessage(m,'*')}catch(e){}})}
function tsend(){if(READY)send({type:'timer',t0,acc,paused})}
function recv(m,src){if(!m||!m.__pres||m.from===ME)return;if(src)peers.add(src);if(SEEN[m.from]>=m.seq)return;SEEN[m.from]=m.seq;
 if(m.type==='hello'){send({type:'state',i,step});send({type:'timer',t0,acc,paused});return}
 if(m.type==='timer'){t0=m.t0;acc=m.acc;paused=m.paused;save();tick();if(PRES)pvTick();return}
 if(m.type==='state'&&m.i>=0&&m.i<S.length){remote=true;try{if(m.i!==i)go(m.i);if(m.step!==step)show(m.step)}finally{remote=false}}}
if(bc)bc.onmessage=e=>recv(e.data,null);
addEventListener('message',e=>recv(e.data,e.source));
function changed(){if(!READY)return;if(!remote)send({type:'state',i,step});if(PRES){rehMark();pvUpdate()}}
function openPresenter(){if(PRES)return;if(pw&&!pw.closed){pw.focus();return}
 const u=new URL(location.href);u.searchParams.set('presenter','1');u.hash='#'+(i+1);
 pw=window.open(u.href,'slides-presenter','popup,width=1280,height=800');if(pw)peers.add(pw)}
const pbtn=document.querySelector('.ctrl .pres');if(pbtn){pbtn.addEventListener('mousedown',e=>e.preventDefault());pbtn.addEventListener('click',openPresenter)}
// ---- rehearsal: time per slide, measured on the talk timer (pausing the timer pauses it)
const DK=DECK.dataset.deck||location.pathname,TALK=parseFloat(DECK.dataset.talkMinutes)||0,API=DECK.dataset.api||'';
const RK='slides-rehearse:'+location.pathname;let R={on:false,cur:-1,since:0,ms:{}};
try{const v=JSON.parse(sessionStorage.getItem(RK));if(v&&v.ms)R=v}catch(e){}
const rsave=()=>{try{sessionStorage.setItem(RK,JSON.stringify(R))}catch(e){}};
const sid=k=>S[k].dataset.slideId||String(k+1);
const target=k=>{const v=parseFloat(S[k]&&S[k].dataset.time);return v>0?v*1000:0};
const fmt=ms=>{const t=Math.round(ms/1000),a=Math.abs(t);return(t<0?'−':'')+Math.floor(a/60)+':'+String(a%60).padStart(2,'0')};
function rehMark(){if(!R.on)return;const now=el();if(now<R.since)R.since=now;if(R.cur!==i){if(R.cur>=0&&S[R.cur])R.ms[sid(R.cur)]=(R.ms[sid(R.cur)]||0)+(now-R.since);R.cur=i;R.since=now;rsave()}}
const spent=k=>(R.ms[sid(k)]||0)+(R.on&&R.cur===k?Math.max(0,el()-R.since):0);
let prevRun=null;
function loadPrev(){try{prevRun=JSON.parse(localStorage.getItem('slides-rehearsal:'+DK))}catch(e){}
 if(API)fetch(API+'/rehearsals').then(r=>r.ok?r.json():[]).then(l=>{if(Array.isArray(l)&&l.length)prevRun=l[l.length-1]}).catch(()=>{})}
// ---- presenter DOM
const mk=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const btn=(x,title,fn,c)=>{const b=mk('button',c||'',x);b.type='button';b.title=title;b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',fn);return b};
let P=null;
function slideTitle(k){const h=S[k].querySelector('h1,h2,h3,.title');const t=(h?h.textContent:'').replace(/\s+/g,' ').trim();return t?(t.length>60?t.slice(0,57)+'…':t):sid(k)}
function cloneInto(box,k,st){box.replaceChildren();box.__k=k;if(k<0||k>=S.length){box.appendChild(mk('div','pv-end','End of presentation'));return}
 const c=S[k].cloneNode(true);c.classList.remove('active');c.querySelectorAll('iframe.embed-frame').forEach(f=>f.remove());c.querySelectorAll('figure.embed.live').forEach(f=>f.classList.remove('live'));
 c.querySelectorAll('.notes').forEach(n=>n.remove());box.appendChild(c);setBuilt(box,k,st);fitBox(box)}
function setBuilt(box,k,st){const c=box.firstElementChild;if(!c||k<0||k>=S.length)return;const sv=steps(S[k]),lim=st?sv[st-1]:-Infinity;box.__st=st;
 c.querySelectorAll('[data-build]').forEach(e=>e.classList.toggle('built',parseFloat(e.dataset.build)<=lim))}
function fitBox(box){const a=box.parentElement,W=a.clientWidth,H=a.clientHeight;if(!W||!H)return;const k=Math.min(W/1920,H/1080);
 box.style.width=Math.floor(1920*k)+'px';box.style.height=Math.floor(1080*k)+'px';const c=box.firstElementChild;if(c&&c.classList.contains('slide'))c.style.transform='scale('+k+')'}
function show2(box,k,st){if(box.__k!==k)cloneInto(box,k,st);else if(box.__st!==st)setBuilt(box,k,st)}
function pvBuild(){document.title='Presenter · '+document.title;
 P={root:mk('div','',null)};P.root.id='pv';
 const hd=mk('header');P.pos=mk('span','pv-pos');P.timer=mk('span','pv-timer slide-timer');P.timer.title='Click: pause/resume · T: reset';
 P.goal=mk('span','pv-goal');P.clock=mk('span','pv-clock');
 P.reh=btn('● Rehearse','Time each slide on the talk timer (starts it from 0:00); Finish shows the report',()=>R.on?rehFinish():rehStart(),'pv-reh-btn');
 const sp=mk('span','pv-sp');
 hd.append(P.pos,P.timer,P.goal,P.clock,sp,btn('A−','Smaller notes',()=>fontBy(-2)),btn('A+','Larger notes',()=>fontBy(2)),
  btn('Report','Times per slide (last or current rehearsal)',()=>report(false)),P.reh,btn('‹','Previous (←)',back,'pv-nav'),btn('›','Next (→, Space)',fwd,'pv-nav pv-next-btn'));
 P.curA=mk('div','pv-area pv-cur');P.cur=mk('div','pv-box');P.curA.append(P.cur);
 const side=mk('aside','pv-side');P.nextL=mk('div','pv-label','Next');P.nextA=mk('div','pv-area');P.next=mk('div','pv-box pv-small');P.nextA.append(P.next);
 P.notesL=mk('div','pv-label','Notes');P.notes=mk('div','pv-notes');side.append(P.nextL,P.nextA,P.notesL,P.notes);
 P.bar=mk('div','pv-bar');
 P.root.append(hd,P.curA,side,P.bar);document.body.appendChild(P.root);
 let fs=26;try{fs=+localStorage.getItem('slides-notes-size')||26}catch(e){}P.root.style.setProperty('--pv-notes',fs+'px');
 function fontBy(d){fs=Math.max(14,Math.min(60,fs+d));P.root.style.setProperty('--pv-notes',fs+'px');try{localStorage.setItem('slides-notes-size',fs)}catch(e){}}
 addEventListener('resize',()=>{fitBox(P.cur);fitBox(P.next)});setInterval(pvTick,500);loadPrev()}
function pvUpdate(){if(!P)return;const st=steps(S[i]).length;
 P.pos.textContent='Slide '+(i+1)+' / '+S.length+(st?' · click '+step+' / '+st:'');
 show2(P.cur,i,step);
 if(step<st){P.nextL.textContent='Next: click '+(step+1);show2(P.next,i,step+1)}
 else if(i<S.length-1){P.nextL.textContent='Next slide';show2(P.next,i+1,0)}
 else{P.nextL.textContent='Next';cloneInto(P.next,-1,0)}
 const a=S[i].querySelector('.notes');P.notes.textContent=a?a.textContent.trim():'';P.notes.classList.toggle('empty',!a||!a.textContent.trim());if(!a||!a.textContent.trim())P.notes.textContent='No speaker notes for this slide.';
 pvTick()}
function pvTick(){if(!P)return;const d=new Date();P.clock.textContent=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
 const tot=el(),goal=TALK*60000;P.goal.textContent=goal?'of '+fmt(goal):'';P.goal.classList.toggle('over',goal>0&&tot>goal);
 P.reh.textContent=R.on?'■ Finish':'● Rehearse';P.reh.classList.toggle('on',R.on);
 if(R.on){if(el()<R.since)R.since=el();const s=spent(i),t=target(i);let cum=0;for(let k=0;k<i;k++)cum+=target(k);
  P.bar.textContent='Rehearsing · this slide '+fmt(s)+(t?' / '+fmt(t):'')+(cum&&TALK?'':'')+' · total '+fmt(tot)+(goal?' / '+fmt(goal):'');
  P.bar.className='pv-bar on'+(t&&s>t?' over':'')}else{P.bar.className='pv-bar';P.bar.textContent=''}}
function rehStart(){acc=0;t0=Date.now();paused=false;save();tick();tsend();R={on:true,cur:i,since:0,ms:{}};rsave();pvTick()}
function rehRun(){return{at:new Date().toISOString(),talkMinutes:TALK||undefined,slides:S.map((s,k)=>({id:sid(k),ms:Math.round(spent(k)),target:target(k)/1000||undefined})),totalMs:S.reduce((a,s,k)=>a+spent(k),0)}}
function rehFinish(){const now=el();if(R.cur>=0&&S[R.cur])R.ms[sid(R.cur)]=(R.ms[sid(R.cur)]||0)+Math.max(0,now-R.since);R.on=false;R.cur=-1;rsave();
 const run=rehRun(),before=prevRun;report(true,run,before);
 try{localStorage.setItem('slides-rehearsal:'+DK,JSON.stringify(run))}catch(e){}prevRun=run;
 const st=P.saved;if(API)fetch(API+'/rehearsals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(run)}).then(r=>{st.textContent=r.ok?'Saved with the deck (slides rehearsals).':'Could not save to the deck.'}).catch(()=>{st.textContent='Could not save to the deck.'});
 else st.textContent='Saved in this browser.';pvTick()}
function report(final,run,before){if(!P)return;if(P.rep)P.rep.remove();
 const live=R.on||Object.keys(R.ms).length;run=run||(live?rehRun():prevRun);before=before===undefined?(live?prevRun:null):before;
 const box=mk('div','pv-report');const card=mk('div','pv-card');box.appendChild(card);box.addEventListener('click',e=>{if(e.target===box)close()});
 const close=()=>{box.remove();P.rep=null};
 card.append(mk('h2',null,final?'Rehearsal finished':R.on?'Rehearsal so far':'Last rehearsal'));
 if(!run){card.append(mk('p',null,'No rehearsal yet. Press ● Rehearse, give the talk, then ■ Finish.'))}
 else{const by={};(run.slides||[]).forEach(s=>by[s.id]=s);const pb={};((before&&before.slides)||[]).forEach(s=>pb[s.id]=s);
  const tb=mk('table');const hr=mk('tr');['#','Slide','Time','Target','±',before?'Last run':null].forEach(x=>{if(x!==null)hr.append(mk('th',null,x))});tb.append(hr);
  let tot=0,tg=0;S.forEach((s,k)=>{const r=by[sid(k)]||{ms:0},t=target(k);tot+=r.ms;tg+=t;const tr=mk('tr');
   tr.append(mk('td','n',String(k+1)),mk('td',null,slideTitle(k)),mk('td','n',fmt(r.ms)),mk('td','n',t?fmt(t):'—'));
   const df=mk('td','n',t?(r.ms>t?'+':'')+fmt(r.ms-t):'');if(t)df.classList.add(r.ms>t?'over':'ok');tr.append(df);
   if(before)tr.append(mk('td','n',pb[sid(k)]?fmt(pb[sid(k)].ms):'—'));tr.addEventListener('click',()=>{close();go(k)});tr.title='Go to this slide';tb.append(tr)});
  const goal=TALK?TALK*60000:tg;const ft=mk('tr','total');ft.append(mk('td'),mk('td',null,'Total'+(TALK?' (talk target '+TALK+' min)':'')),mk('td','n',fmt(tot)),mk('td','n',goal?fmt(goal):'—'));
  const df=mk('td','n',goal?(tot>goal?'+':'')+fmt(tot-goal):'');if(goal)df.classList.add(tot>goal?'over':'ok');ft.append(df);if(before)ft.append(mk('td','n',fmt(before.totalMs||0)));tb.append(ft);
  card.append(tb);if(run.at)card.append(mk('p','pv-muted',(final?'':'Recorded ')+new Date(run.at).toLocaleString()))}
 P.saved=mk('p','pv-muted');card.append(P.saved);
 card.append(mk('p','pv-muted','Targets: data-time="seconds" on a slide, talkMinutes in deck.json (slides target).'));
 const row=mk('div','pv-row');row.append(btn('Close','Close (Esc)',close));card.append(row);
 P.rep=box;P.root.appendChild(box)}
addEventListener('keydown',e=>{if(e.key==='Escape'&&P&&P.rep){P.rep.remove();P.rep=null}});
READY=true;if(PRES){pvBuild();rehMark();pvUpdate()}send({type:'hello'});
`;

const PRESENT_JS = `
(()=>{const S=[...document.querySelectorAll('.deck>.slide')];let i=-1,READY=false;const PRES=new URLSearchParams(location.search).has('presenter');if(PRES)document.body.classList.add('presenter');const pad=n=>String(n).padStart(2,'0');
S.forEach((s,k)=>s.querySelectorAll('.slide-num:empty').forEach(e=>{e.textContent=pad(k+1)+' / '+pad(S.length)}));
const TK='slides-timer:'+location.pathname;let t0=Date.now(),acc=0,paused=false;
try{const v=JSON.parse(sessionStorage.getItem(TK));if(v){t0=v.t0;acc=v.acc;paused=v.paused}}catch{}
const save=()=>{try{sessionStorage.setItem(TK,JSON.stringify({t0,acc,paused}))}catch{}};const el=()=>paused?acc:acc+Date.now()-t0;
function tick(){const t=Math.floor(el()/1000),txt=Math.floor(t/60)+':'+String(t%60).padStart(2,'0')+(paused?' ❚❚':'');document.querySelectorAll('.slide-timer').forEach(e=>{e.textContent=txt;e.title='Click: pause/resume · T: reset'})}
function pause(){if(paused){t0=Date.now();paused=false}else{acc=el();paused=true}save();tick();tsend()}save();
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
 prev.disabled=i===0&&step===0;next.disabled=i===S.length-1&&step===st.length;changed()}
function fwd(){if(step<steps(S[i]).length)show(step+1);else if(i<S.length-1)go(i+1)}
function back(){if(step>0)show(step-1);else if(i>0)go(i-1,true)}
function go(n,atEnd){const j=Math.max(0,Math.min(S.length-1,n));if(j!==i&&S[i])stopEmbeds(S[i]);i=j;S.forEach((s,k)=>s.classList.toggle('active',k===i));if(!PRES)startEmbeds(S[i]);history.replaceState(null,'',location.pathname+location.search+'#'+(i+1));hud.textContent=(i+1)+' / '+S.length;const a=S[i]&&S[i].querySelector('.notes');notes.textContent=a?a.textContent.trim():'';show(atEnd?Infinity:0)}
addEventListener('resize',fit);fit();go((parseInt(location.hash.slice(1))||1)-1);
addEventListener('hashchange',()=>{const n=(parseInt(location.hash.slice(1))||1)-1;if(n!==i)go(n)});
function key(k){
 if(k==='t'||k==='T'){acc=0;t0=Date.now();save();tick();tsend();return true}
 if(k==='p'||k==='P'){openPresenter();return true}
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
${PRESENTER_JS}
})();`;

/**
 * Self-contained presentation. opts.inline embeds assets as data URIs (export);
 * opts.base sets a <base href> instead (live present mode from the server).
 */
export function buildPresentation(d, { inline = true, base = null, liveReload = false } = {}) {
  const meta = readMeta(d);
  const talk = +meta.talkMinutes > 0 ? ` data-talk-minutes="${+meta.talkMinutes}"` : '';
  let body = meta.slides.map((id) => renderMathIn(readSlide(d, id)).trim().replace(/^<section\b/i, `<section data-slide-id="${id}"`)).join('\n');
  let css = deckCss(d);
  if (inline) { body = inlineAssets(d, body); css = inlineAssets(d, css); }
  // equations: KaTeX's stylesheet only when the deck uses it (fonts inlined in exports, ~400 KB)
  if (hasMath(body)) css = mathCss(inline ? 'inline' : 'server') + '\n' + css;
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
<main class="deck" data-deck="${escapeHtml(d)}"${embedBase}${talk}${!inline && base ? ` data-api="/api/decks/${escapeHtml(d)}"` : ''}>
${body}
</main>
${embedDocs}
<div class="hud"></div>
<nav class="ctrl"><button class="pres" type="button" aria-label="Presenter view" title="Presenter view: notes, next slide, timer, rehearsal (P)"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="13" height="10" rx="1.5"/><path d="M18 6h4M18 10h4M18 14h4M5 19h14"/></svg></button><button class="prev" type="button" aria-label="Previous slide" title="Previous (←)">&#8249;</button><button class="next" type="button" aria-label="Next slide" title="Next (→)">&#8250;</button></nav>
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
export function buildRenderPage(d, items, { sheet = false, cols = 3, pdf = false, notes = false } = {}) {
  const base = pathToFileURL(deckDir(d) + path.sep).href;
  const order = readMeta(d).slides;
  const pad = (n) => String(n).padStart(2, '0');
  const numbered = (id) => renderMathIn(readSlide(d, id)).replace(/(<div class="slide-num"[^>]*>)(<\/div>)/g, `$1${pad(order.indexOf(id) + 1)} / ${pad(order.length)}$2`);
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
    const page = `<div class="cell" data-id="${id}" data-n="${n}">${css}${sheet ? `<div class="label">${label}</div>` : ''}<div class="frame">${html}</div></div>`;
    if (!pdf || !notes || step) return page; // --notes: one notes page after each slide (after its first step only)
    const nt = (html.match(/<aside class="notes"[^>]*>([\s\S]*?)<\/aside>/i) || [])[1];
    const txt = nt ? nt.replace(/<(br|\/p|\/li|\/div)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : '';
    return page + `<div class="cell notes-page"><div class="np-head">Notes · ${pad(order.indexOf(id) + 1)} ${escapeHtml(id)}</div><div class="np-body">${txt || '<span class="np-none">No speaker notes.</span>'}</div></div>`;
  };
  const body = items.map(cell).join('\n');
  const scale = sheet ? 0.25 : 1;
  const layout = sheet
    ? `body{margin:0;background:#cfd2d8;padding:20px;display:grid;grid-template-columns:repeat(${cols},${1920 * scale}px);gap:28px 20px;width:max-content}
       .cell{display:flex;flex-direction:column;gap:6px}.label{font:600 15px system-ui,sans-serif;color:#333}
       .frame{width:${1920 * scale}px;height:${1080 * scale}px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.25)}
       .frame>.slide{transform:scale(${scale});transform-origin:0 0}`
    : `body{margin:0}.cell{width:1920px;height:1080px;overflow:hidden}${pdf ? `
       @page{size:1920px 1080px;margin:0}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
       .cell{break-after:page;page-break-after:always;position:relative}.cell:last-of-type{break-after:auto;page-break-after:auto}
       .notes-page{background:#fff;color:#222;box-sizing:border-box;padding:90px 120px;font:40px/1.5 system-ui,sans-serif}
       .np-head{font-weight:700;color:#777;font-size:30px;margin-bottom:40px}.np-body{white-space:pre-wrap}.np-none{color:#999}` : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}">${pdf ? `<title>${escapeHtml(readMeta(d).title || d)}</title>` : ''}
<style>${hasMath(body) ? mathCss('file') : ''}
${deckCss(d)}
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
      if (el.closest('.notes') || el.closest('.katex') || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) return;
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
