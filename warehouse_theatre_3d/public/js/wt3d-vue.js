/* Warehouse Theatre  v2.0.0 — Vue 3 (CDN) + Three.js
   Mirrors every feature from wt-app.js v1.0.0
   Depends on: Vue 3 global build + THREE (loaded before this script) */
(function () {
'use strict';

const { createApp, defineComponent, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } = Vue;

/* ─────────────────────────────────────────────────────────────
   HELPERS & CONSTANTS
───────────────────────────────────────────────────────────── */
const FC  = p => p>=90?0xf87171:p>=70?0xfb923c:p>=40?0xfacc15:0x4ade80;
const FCH = p => p>=90?'#f87171':p>=70?'#fb923c':p>=40?'#facc15':'#4ade80';
const UCH = ['#60a5fa','#4ade80','#fbbf24','#f87171','#a78bfa','#34d399'];
const fmt  = n => (parseFloat(n)||0).toLocaleString('en-IN',{maximumFractionDigits:1});
const fmtK = n => { n=parseFloat(n)||0; return n>=1000?(n/1000).toFixed(1)+'K':fmt(n); };

function lvFill(lv) {
  const wc = (lv.uoms||[]).filter(u=>u.cap>0);
  if (!wc.length) return (lv.uoms||[]).some(u=>u.qty>0) ? 50 : 0;
  return Math.round(wc.reduce((s,u)=>s+Math.min(100,Math.round(u.qty/u.cap*100)),0)/wc.length);
}
function slotFill(sl) {
  return sl.levels.length ? Math.round(sl.levels.reduce((s,l)=>s+lvFill(l),0)/sl.levels.length) : 0;
}
function hasStock(sl) { return sl.levels.some(l=>(l.uoms||[]).some(u=>u.qty>0)); }
function lvKey(sl,lv)  { return sl.wh+'__'+lv.wh; }

/* ─────────────────────────────────────────────────────────────
   FRAPPE API  (auto-detect desk vs www)
───────────────────────────────────────────────────────────── */
const API_PREFIX = 'warehouse_theatre_3d.warehouse_theatre_3d.api.api.';
const SETUP_API_PREFIX = 'warehouse_theatre_3d.warehouse_theatre_3d.api.setup.';

function call(method, args={}) {
  const fullMethod = API_PREFIX + method;
  if (window.frappe && frappe.call) {
    return new Promise((res,rej) => frappe.call({
      method: fullMethod, args,
      callback: r => r.exc ? rej(new Error(r.exc)) : res(r.message),
      error: rej,
    }));
  }
  // www / PWA context
  const params = new URLSearchParams();
  for (const [k,v] of Object.entries(args||{})) {
    if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
  }
  const url = '/api/method/' + fullMethod + (params.toString() ? '?'+params.toString() : '');
  return fetch(url, { method:'GET', credentials:'same-origin', headers:{'Accept':'application/json'} })
    .then(r => r.json())
    .then(r => { if (r.message !== undefined) return r.message; throw new Error(r.exc||'API error'); });
}

function callSetup(method, args={}) {
  const fullMethod = SETUP_API_PREFIX + method;
  if (window.frappe && frappe.call) {
    return new Promise((res,rej) => frappe.call({
      method: fullMethod, args,
      callback: r => r.exc ? rej(new Error(r.exc)) : res(r.message),
      error: rej,
    }));
  }
  const params = new URLSearchParams();
  for (const [k,v] of Object.entries(args||{})) {
    if (v !== null && v !== undefined && v !== '') params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const url = '/api/method/' + fullMethod + (params.toString() ? '?'+params.toString() : '');
  return fetch(url, { method:'GET', credentials:'same-origin', headers:{'Accept':'application/json'} })
    .then(r => r.json())
    .then(r => { if (r.message !== undefined) return r.message; throw new Error(r.exc||'API error'); });
}

/* ─────────────────────────────────────────────────────────────
   CSS  (same as wt-app.js, injected once)
───────────────────────────────────────────────────────────── */
const CSS = `
#wt-app.dark{--wt-bg:#0c0e14;--wt-bg2:#13151e;--wt-bg3:#1a1e2a;--wt-border:rgba(255,255,255,.08);--wt-text:#fff;--wt-text2:rgba(255,255,255,.6);--wt-text3:rgba(255,255,255,.3);--wt-sb:rgba(10,12,18,.96);--wt-card:rgba(255,255,255,.04);--wt-cb:rgba(255,255,255,.08);--wt-accent:#3b82f6;--wt-accent2:#60a5fa;--wt-pill:rgba(255,255,255,.06);--wt-pillb:rgba(255,255,255,.1);--wt-floor:0x0a0c12;--wt-grid:#181c28}
#wt-app.light{--wt-bg:#f0f2f5;--wt-bg2:#fff;--wt-bg3:#f7f9fc;--wt-border:#e2e8f0;--wt-text:#1a202c;--wt-text2:#4a5568;--wt-text3:#a0aec0;--wt-sb:#fff;--wt-card:#fff;--wt-cb:#e2e8f0;--wt-accent:#2563eb;--wt-accent2:#3b82f6;--wt-pill:#eff6ff;--wt-pillb:#dbeafe;--wt-floor:0xf0f2f5;--wt-grid:#dde1e7}
#wt-app{width:100%;height:100%;display:flex;flex-direction:column;background:var(--wt-bg);font-family:-apple-system,"Inter",sans-serif;font-size:12px;color:var(--wt-text);position:relative;overflow:hidden;transition:background .3s}
#wt-cw{flex:1;position:relative;min-height:0}
#wt-c{display:block;width:100%;height:100%}
#wt-top{position:absolute;top:0;left:148px;right:0;display:flex;align-items:center;gap:10px;padding:9px 14px;background:linear-gradient(to bottom,rgba(12,14,20,.97) 55%,transparent);z-index:10;pointer-events:none}
#wt-app.light #wt-top{background:rgba(240,242,245,.95);backdrop-filter:blur(4px)}
@media(max-width:600px){
  #wt-top{left:0;flex-wrap:wrap;padding:6px 8px;gap:5px;background:var(--wt-bg);border-bottom:1px solid var(--wt-border)}
  #wt-brand{display:none}
  .wt-sep{display:none}
  #wt-search-wrap{order:3;flex:1 1 100%;max-width:100%}
  .wt-pills{margin-left:0;gap:4px}
  .wt-pill{min-width:38px;padding:2px 6px}
  .wt-pv{font-size:12px}
  .wt-pl{font-size:8px}
  .wt-sw-btn{height:28px;padding:0 10px;font-size:11px}
  #wt-bot{left:0}
  #wt-view2d{left:0;top:80px}
  #wt-sb{transform:translateX(-100%);transition:transform .28s cubic-bezier(.34,1.56,.64,1),background .3s}
  #wt-sb.mobile-open{transform:translateX(0)}
  #wt-sb-overlay{display:none;position:absolute;inset:0;background:rgba(0,0,0,.5);z-index:14}
  #wt-sb-overlay.show{display:block}
  #wt-mob-menu{display:flex}
  .wt-3d-wrap-mobile{top:52px!important}
}
#wt-search-wrap{position:relative;pointer-events:all;flex:1;max-width:280px}
#wt-mob-menu{display:none;width:30px;height:30px;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);cursor:pointer;align-items:center;justify-content:center;font-size:14px;pointer-events:all;flex-shrink:0}
#wt-app.light #wt-mob-menu{border-color:rgba(0,0,0,.12);background:rgba(0,0,0,.05)}
#wt-aisle-picker{position:absolute;inset:0;background:rgba(0,0,0,.65);z-index:80;display:flex;align-items:center;justify-content:center}
#wt-aisle-picker-box{background:#13151e;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:20px;min-width:280px;max-width:360px;box-shadow:0 24px 64px rgba(0,0,0,.6);animation:wtCfgIn .2s cubic-bezier(.34,1.56,.64,1)}
.wt-aisle-picker-title{font-size:14px;font-weight:700;color:#fff;margin-bottom:4px}
.wt-aisle-picker-sub{font-size:11px;color:rgba(255,255,255,.35);margin-bottom:14px}
.wt-aisle-gap-btn{width:100%;height:40px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#fff;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;padding:0 14px;gap:10px;margin-bottom:6px;transition:all .15s}
.wt-aisle-gap-btn:hover{background:rgba(59,130,246,.2);border-color:#3b82f6;color:#93c5fd}
.wt-aisle-gap-icon{font-size:16px}
.wt-aisle-cancel{width:100%;height:32px;border-radius:7px;border:1px solid rgba(255,255,255,.1);background:transparent;color:rgba(255,255,255,.4);font-size:11px;cursor:pointer;margin-top:6px}
.wt-aisle-cancel:hover{background:rgba(255,255,255,.06);color:rgba(255,255,255,.7)}
#wt-aisle-ctrl{position:absolute;bottom:60px;left:50%;transform:translateX(-50%);z-index:20;display:none;flex-direction:column;align-items:center;gap:8px;pointer-events:all}
#wt-aisle-ctrl.show{display:flex}
.wt-aisle-pad{display:grid;grid-template-columns:repeat(3,42px);grid-template-rows:repeat(2,42px);gap:5px}
.wt-aisle-key{width:42px;height:42px;border-radius:9px;border:1px solid rgba(255,255,255,.25);background:rgba(15,18,30,.88);color:#fff;font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;user-select:none;backdrop-filter:blur(6px);touch-action:none}
.wt-aisle-key{width:36px;height:36px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.1);color:#fff;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;user-select:none;backdrop-filter:blur(4px)}
.wt-aisle-key:active{background:rgba(255,255,255,.25)}
.wt-aisle-key.empty{background:transparent;border:none;pointer-events:none}
#wt-exit-aisle{height:28px;padding:0 14px;border-radius:7px;border:1px solid rgba(248,113,113,.4);background:rgba(248,113,113,.15);color:#f87171;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px}
#wt-exit-aisle:hover{background:rgba(248,113,113,.28)}
#wt-aisle-hint{font-size:9px;color:rgba(255,255,255,.35);text-align:center;line-height:1.6}
#wt-search{width:100%;height:28px;border-radius:7px;border:1px solid var(--wt-border);background:var(--wt-card);color:var(--wt-text);font-size:11px;padding:0 28px 0 28px;outline:none;transition:border-color .15s}
#wt-search::placeholder{color:var(--wt-text3)}
#wt-search:focus{border-color:var(--wt-accent)}
#wt-search-ico{position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--wt-text3);pointer-events:none}
#wt-search-clear{position:absolute;right:7px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--wt-text3);cursor:pointer;background:none;border:none;padding:0;line-height:1}
#wt-search-clear:hover{color:var(--wt-text)}
#wt-switcher{display:flex;align-items:center;gap:6px;pointer-events:all;margin-left:8px}
.wt-sw-group{display:flex;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:2px;gap:2px}
#wt-app.light .wt-sw-group{background:rgba(0,0,0,.06);border-color:rgba(0,0,0,.1)}
.wt-sw-btn{height:24px;padding:0 9px;border-radius:5px;border:none;font-size:10px;font-weight:700;cursor:pointer;background:transparent;color:rgba(255,255,255,.5);transition:all .18s;display:flex;align-items:center;gap:3px;white-space:nowrap;line-height:1}
#wt-app.light .wt-sw-btn{color:rgba(0,0,0,.45)}
.wt-sw-btn.act{background:#3b82f6;color:#fff;box-shadow:0 2px 8px rgba(59,130,246,.4)}
.wt-sw-btn:not(.act):hover{background:rgba(255,255,255,.1);color:#fff}
#wt-app.light .wt-sw-btn:not(.act):hover{background:rgba(0,0,0,.08);color:#1a202c}
.wt-theme-btn{width:28px;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;transition:all .18s;padding:0;line-height:1}
#wt-app.light .wt-theme-btn{border-color:rgba(0,0,0,.12);background:rgba(0,0,0,.05)}
.wt-theme-btn:hover{background:rgba(255,255,255,.18)}
#wt-app.light .wt-theme-btn:hover{background:rgba(0,0,0,.1)}
#wt-brand{font-size:13px;font-weight:700;color:var(--wt-text)}
.wt-sep{width:1px;height:18px;background:var(--wt-border)}
.wt-pills{display:flex;gap:5px;margin-left:auto;pointer-events:all}
.wt-pill{background:var(--wt-pill);border:1px solid var(--wt-pillb);border-radius:7px;padding:3px 9px;display:flex;flex-direction:column;align-items:center;min-width:46px;transition:all .3s}
.wt-pv{font-size:13px;font-weight:800;line-height:1.1;color:var(--wt-text)}
.wt-pl{font-size:8px;color:rgba(255,255,255,.35);font-weight:600;letter-spacing:.4px;margin-top:1px}
.wt-pill.occ .wt-pv{color:#fb923c}.wt-pill.free .wt-pv{color:#4ade80}.wt-pill.qty .wt-pv{color:#60a5fa;font-size:11px}
#wt-bot{position:absolute;bottom:0;left:148px;right:0;display:flex;align-items:flex-end;justify-content:space-between;padding:9px 14px;background:linear-gradient(to top,rgba(12,14,20,.97) 55%,transparent);z-index:10;pointer-events:none}
#wt-hint{font-size:9px;color:rgba(255,255,255,.25);line-height:1.8}
#wt-legend{display:flex;gap:8px;align-items:center}
.wt-li{display:flex;align-items:center;gap:4px;font-size:9px;color:rgba(255,255,255,.4)}
.wt-lb{width:10px;height:10px;border-radius:2px;flex-shrink:0}
#wt-sb{position:absolute;left:0;top:0;bottom:0;width:148px;background:var(--wt-sb);border-right:1px solid var(--wt-border);overflow-y:auto;z-index:15;display:flex;flex-direction:column;transition:background .3s,border-color .3s}
#wt-sb::-webkit-scrollbar{width:3px}
#wt-sb::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:10px}
.wt-sb-brand{padding:10px 10px 7px;font-size:12px;font-weight:800;color:var(--wt-text);border-bottom:1px solid var(--wt-border);flex-shrink:0}
.wt-sb-label{padding:9px 10px 2px;font-size:8px;font-weight:700;letter-spacing:1.2px;color:var(--wt-text3);text-transform:uppercase;display:block}
.wt-g-item{padding:7px 10px;cursor:pointer;border-left:3px solid transparent;border-bottom:1px solid var(--wt-border);transition:background .1s}
.wt-g-item:hover{background:var(--wt-card)}
.wt-g-item.act{background:var(--wt-pill);border-left-color:var(--wt-accent)}
.wt-g-name{font-size:11px;font-weight:700;color:var(--wt-text);display:block}
.wt-g-item.act .wt-g-name{color:var(--wt-accent2)}
.wt-g-meta{font-size:9px;color:var(--wt-text3)}
.wt-sb-foot{margin-top:auto;padding:8px 10px;border-top:1px solid rgba(255,255,255,.06)}
.wt-sb-btn{width:100%;height:28px;border-radius:6px;border:1px solid rgba(59,130,246,.4);background:rgba(59,130,246,.1);color:#60a5fa;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;line-height:1}
.wt-sb-btn:hover{background:rgba(59,130,246,.2)}
#wt-tt{position:absolute;background:var(--wt-bg2);border:1px solid var(--wt-border);border-radius:9px;padding:9px 11px;pointer-events:none;z-index:50;min-width:155px;box-shadow:0 4px 16px rgba(0,0,0,.18)}
#wt-tt-title{font-size:11px;font-weight:700;margin-bottom:5px;color:var(--wt-text)}
.wt-tt-row{display:flex;align-items:center;gap:5px;margin-bottom:2px}
.wt-tt-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.wt-tt-lbl{font-size:9px;color:var(--wt-text2);flex:1}
.wt-tt-val{font-size:9px;font-weight:700}
.wt-tt-bar{height:3px;background:var(--wt-cb);border-radius:2px;margin-top:6px;overflow:hidden}
.wt-tt-fill{height:100%;border-radius:2px}
#wt-dp{position:absolute;right:0;top:0;bottom:0;width:216px;background:var(--wt-bg2);border-left:1px solid var(--wt-border);transform:translateX(100%);transition:transform .3s cubic-bezier(.34,1.56,.64,1);z-index:20;overflow-y:auto;padding:12px}
#wt-dp::-webkit-scrollbar{width:3px}
#wt-dp::-webkit-scrollbar-thumb{background:var(--wt-border);border-radius:10px}
#wt-dp.open{transform:translateX(0)}
#wt-dp-x{position:absolute;top:8px;right:8px;background:var(--wt-card);border:none;border-radius:5px;color:var(--wt-text2);width:22px;height:22px;cursor:pointer;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0}
#wt-dp-x:hover{background:var(--wt-cb)}
.wt-dp-title{font-size:13px;font-weight:800;margin-bottom:1px;padding-right:26px;color:var(--wt-text)}
.wt-dp-sub{font-size:9px;color:var(--wt-text3);margin-bottom:12px}
.wt-dp-sec{font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--wt-text3);margin-bottom:6px;margin-top:10px;display:block}
.wt-dp-lv{background:var(--wt-card);border:1px solid var(--wt-cb);border-radius:8px;padding:8px;margin-bottom:6px;cursor:pointer;transition:border-color .15s}
.wt-dp-lv:hover{border-color:var(--wt-accent)}
.wt-dp-lv.sel{border-color:#3b82f6;background:rgba(59,130,246,.08)}
.wt-dp-lv-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}
.wt-dp-lv-name{font-size:10px;font-weight:700;color:var(--wt-text)}
.wt-dp-lv-pct{font-size:10px;font-weight:800}
.wt-urow{display:flex;align-items:center;gap:5px;margin-bottom:4px}
.wt-ulbl{font-size:8px;color:var(--wt-text2);min-width:28px}
.wt-utrack{flex:1;height:4px;background:var(--wt-cb);border-radius:2px;overflow:hidden}
.wt-ufill{height:100%;border-radius:2px;transition:width .5s}
.wt-uval{font-size:8px;color:var(--wt-text2);min-width:52px;text-align:right}
.wt-ucap-inp{width:44px;height:18px;background:var(--wt-card);border:1px solid var(--wt-border);border-radius:4px;color:var(--wt-text);font-size:9px;padding:0 4px;outline:none;text-align:right}
.wt-ucap-inp:focus{border-color:#3b82f6}
.wt-divider{height:1px;background:var(--wt-border);margin:10px 0}
.wt-dp-items-lbl{font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--wt-text3);margin:8px 0 5px;display:block}
.wt-dp-item{display:flex;align-items:center;justify-content:space-between;padding:5px 7px;background:var(--wt-card);border-radius:5px;margin-bottom:3px;border:1px solid var(--wt-cb)}
.wt-dp-icode{font-size:9px;font-weight:700;color:var(--wt-accent2)}
.wt-dp-imeta{font-size:8px;color:var(--wt-text3);margin-top:1px}
.wt-dp-iqty{font-size:10px;font-weight:800;color:#4ade80}
.wt-cfg-btn{width:100%;height:28px;border-radius:6px;border:none;background:#3b82f6;color:#fff;font-size:10px;font-weight:700;cursor:pointer;margin-top:8px;display:flex;align-items:center;justify-content:center;gap:4px;line-height:1}
.wt-cfg-btn:hover{background:#2563eb}
#wt-cfg-ov{display:none;position:absolute;inset:0;background:rgba(0,0,0,.6);z-index:80;align-items:center;justify-content:center}
#wt-cfg-ov.open{display:flex}
#wt-cfg-modal{background:#13151e;border:1px solid rgba(255,255,255,.1);border-radius:12px;width:330px;max-height:82%;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.6);overflow:hidden;animation:wtCfgIn .2s cubic-bezier(.34,1.56,.64,1)}
@keyframes wtCfgIn{from{opacity:0;transform:scale(.93)}to{opacity:1;transform:none}}
.wt-cfg-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0}
.wt-cfg-hdr-title{font-size:13px;font-weight:700}
.wt-x-btn{width:22px;height:22px;border-radius:5px;border:1px solid var(--wt-cb);background:var(--wt-card);color:var(--wt-text2);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;flex-shrink:0}
.wt-x-btn:hover{background:rgba(255,255,255,.14)}
.wt-cfg-body{flex:1;overflow-y:auto;padding:14px}
.wt-cfg-body::-webkit-scrollbar{width:3px}
.wt-cfg-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:10px}
.wt-cfg-slabel{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,.28);margin-bottom:8px;display:block}
.wt-cfg-preview{display:flex;align-items:flex-end;gap:3px;height:52px;padding:6px 8px;background:rgba(255,255,255,.02);border-radius:7px;border:1px solid rgba(255,255,255,.06);margin-bottom:10px}
.wt-cfg-pv-lv{border-radius:3px;border:1px solid rgba(255,255,255,.12);transition:all .3s cubic-bezier(.34,1.56,.64,1)}
.wt-cfg-lv-row{display:flex;align-items:center;gap:8px;padding:7px 10px;background:rgba(255,255,255,.04);border-radius:7px;border:1px solid rgba(255,255,255,.07);margin-bottom:4px}
.wt-cfg-lv-name{font-size:10px;font-weight:700;flex:1}
.wt-cfg-lv-wh{font-size:9px;color:rgba(255,255,255,.3)}
.wt-del-btn{width:20px;height:20px;border-radius:4px;border:none;background:rgba(248,113,113,.15);color:#f87171;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;flex-shrink:0}
.wt-del-btn:hover{background:rgba(248,113,113,.28)}
.wt-cfg-add-btn{width:100%;height:30px;border-radius:7px;border:1px dashed rgba(59,130,246,.4);background:rgba(59,130,246,.06);color:#60a5fa;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;line-height:1;margin-top:4px}
.wt-cfg-add-btn:hover{background:rgba(59,130,246,.14)}
.wt-cfg-field{display:flex;flex-direction:column;gap:4px;margin-top:12px}
.wt-cfg-field label{font-size:10px;color:rgba(255,255,255,.5)}
.wt-cfg-field input{height:32px;padding:0 10px;border-radius:7px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#fff;font-size:11px;outline:none}
.wt-cfg-field input:focus{border-color:#3b82f6}
.wt-slot-pick{padding:8px 10px;background:rgba(255,255,255,.04);border-radius:7px;margin-bottom:5px;cursor:pointer;border:1px solid rgba(255,255,255,.07);transition:border-color .12s}
.wt-slot-pick:hover{border-color:rgba(255,255,255,.2)}
.wt-slot-pick-name{font-size:11px;font-weight:700}
.wt-slot-pick-meta{font-size:9px;color:rgba(255,255,255,.35);margin-top:1px}
.wt-cfg-footer{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid rgba(255,255,255,.07);flex-shrink:0}
.wt-btn-cancel{height:32px;padding:0 14px;border-radius:7px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:rgba(255,255,255,.6);font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1}
.wt-btn-cancel:hover{background:rgba(255,255,255,.08)}
.wt-btn-save{height:32px;padding:0 16px;border-radius:7px;border:none;background:#3b82f6;color:#fff;font-size:11px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1}
.wt-btn-save:hover{background:#2563eb}
.wt-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;z-index:5}
.wt-spinner{width:28px;height:28px;border:2px solid rgba(255,255,255,.1);border-top-color:#3b82f6;border-radius:50%;animation:wtSpin .7s linear infinite}
@keyframes wtSpin{to{transform:rotate(360deg)}}
.wt-loading-text{font-size:12px;color:rgba(255,255,255,.4)}
#wt-im-ov{display:none;position:absolute;inset:0;background:rgba(0,0,0,.55);z-index:90;align-items:center;justify-content:center}
#wt-im-ov.open{display:flex}
#wt-im{background:#fff;color:#1a202c;border-radius:16px;width:90%;max-width:780px;max-height:88%;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.35);overflow:hidden;animation:wtImIn .22s cubic-bezier(.34,1.56,.64,1)}
@keyframes wtImIn{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}
#wt-im-hdr{display:flex;align-items:flex-start;justify-content:space-between;padding:18px 20px 14px;border-bottom:1px solid #e2e8f0;flex-shrink:0}
#wt-im-lvtabs{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.wt-im-lvtab{font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;border:1.5px solid #e2e8f0;background:#f7fafc;color:#4a5568;cursor:pointer;transition:all .15s}
.wt-im-lvtab:hover{border-color:#3b82f6;color:#2b6cb0}
.wt-im-lvtab.active{background:#ebf8ff;border-color:#3b82f6;color:#2b6cb0}
#wt-im-title{font-size:17px;font-weight:800;color:#1a202c;line-height:1.2}
#wt-im-sub{font-size:12px;color:#718096;margin-top:3px}
.wt-im-x{width:28px;height:28px;border-radius:7px;border:1px solid #e2e8f0;background:#f7fafc;color:#4a5568;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;flex-shrink:0}
.wt-im-x:hover{background:#edf2f7}
#wt-im-body{overflow-y:auto;padding:16px 20px;flex:1}
#wt-im-body::-webkit-scrollbar{width:4px}
#wt-im-body::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:10px}
.wt-im-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.wt-im-stat{background:#f7fafc;border-radius:10px;padding:12px 14px}
.wt-im-stat-lbl{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#a0aec0;margin-bottom:5px}
.wt-im-stat-val{font-size:22px;font-weight:800;color:#1a202c;line-height:1}
.wt-im-stat-val.blue{color:#2b6cb0}
.wt-im-stat-val.green{color:#276749}
.wt-im-tbl-wrap{overflow-x:auto}
#wt-im-tbl{width:100%;border-collapse:collapse;font-size:12px;min-width:600px}
#wt-im-tbl thead tr{background:#f7fafc}
#wt-im-tbl th{padding:8px 10px;font-size:10px;font-weight:700;color:#718096;border-bottom:2px solid #e2e8f0;text-align:left;white-space:nowrap}
#wt-im-tbl th:nth-child(n+5){text-align:right}
#wt-im-tbl td{padding:8px 10px;border-bottom:1px solid #edf2f7;color:#4a5568;vertical-align:middle}
#wt-im-tbl td:nth-child(n+5){text-align:right;font-variant-numeric:tabular-nums}
#wt-im-tbl tbody tr:hover{background:#f7fafc}
.wt-im-icode{color:#2b6cb0;font-weight:700;text-decoration:none;font-size:12px}
.wt-im-icode:hover{text-decoration:underline}
.wt-im-iname{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#2d3748}
.wt-im-grp{color:#718096;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wt-im-uom{background:#ebf8ff;color:#0c447c;font-size:10px;font-weight:700;padding:2px 6px;border-radius:5px}
.wt-im-qty{font-weight:700;color:#2b6cb0}
.wt-im-res{color:#c05621}
.wt-im-avl{color:#276749}
.wt-im-dim{color:#cbd5e0}
.wt-im-val{font-weight:700;color:#276749}
.wt-im-idx{color:#cbd5e0;text-align:center;width:28px}
.wt-im-empty{text-align:center;padding:28px;color:#a0aec0;font-size:13px}
#wt-view2d{position:absolute;left:148px;right:0;top:44px;bottom:0;overflow:auto;display:none;background:var(--wt-bg)}
#wt-view2d::-webkit-scrollbar{width:5px}
#wt-view2d::-webkit-scrollbar-thumb{background:var(--wt-border);border-radius:10px}
.wt-2d-wrap{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;padding:16px}
.wt-2d-sec{background:var(--wt-bg2);border-radius:14px;padding:12px;border:1.5px solid var(--wt-cb);box-shadow:0 1px 4px rgba(0,0,0,.06);transition:border-color .15s,box-shadow .15s}
.wt-2d-sec:hover{border-color:var(--wt-accent);box-shadow:0 4px 14px rgba(49,130,206,.1)}
.wt-2d-sec-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid var(--wt-border)}
.wt-2d-sec-name{font-size:11px;font-weight:800;color:var(--wt-text)}
.wt-2d-sec-cnt{font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;white-space:nowrap}
.wt-2d-sec-cnt.red{background:#fff5f5;color:#c53030}
.wt-2d-sec-cnt.org{background:#fffaf0;color:#c05621}
.wt-2d-sec-cnt.grn{background:#f0fff4;color:#276749}
#wt-app.dark .wt-2d-sec-cnt.red{background:rgba(197,48,48,.15);color:#fc8181}
#wt-app.dark .wt-2d-sec-cnt.org{background:rgba(192,86,33,.15);color:#fbd38d}
#wt-app.dark .wt-2d-sec-cnt.grn{background:rgba(39,103,73,.15);color:#68d391}
.wt-2d-sec-cap{height:3px;background:var(--wt-cb);border-radius:2px;margin-bottom:8px;overflow:hidden}
.wt-2d-sec-cap-fill{height:100%;border-radius:2px;transition:width .7s cubic-bezier(.34,1.56,.64,1)}
.wt-2d-slots{display:grid;gap:5px}
.wt-2d-tile{border-radius:8px;padding:7px 5px 5px;display:flex;flex-direction:column;align-items:center;cursor:pointer;text-align:center;border:1.5px solid var(--wt-cb);background:var(--wt-card);transition:transform .15s cubic-bezier(.34,1.56,.64,1),box-shadow .12s;position:relative;animation:wt2dIn .35s cubic-bezier(.34,1.56,.64,1) both;height:auto}
@keyframes wt2dIn{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:none}}
.wt-2d-tile:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 6px 16px rgba(0,0,0,.14);z-index:2}
.wt-2d-tile.empty{background:repeating-linear-gradient(-45deg,rgba(0,0,0,.04) 0,rgba(0,0,0,.04) 2px,transparent 2px,transparent 7px);border-color:var(--wt-cb)}
.wt-2d-tile.low{background:rgba(74,222,128,.12);border-color:#4ade80}
.wt-2d-tile.mid{background:rgba(250,204,21,.12);border-color:#facc15}
.wt-2d-tile.high{background:rgba(251,146,60,.12);border-color:#fb923c}
.wt-2d-tile.full{background:rgba(248,113,113,.12);border-color:#f87171}
#wt-app.light .wt-2d-tile.low{background:#f0fdf4;border-color:#22c55e}
#wt-app.light .wt-2d-tile.mid{background:#fefce8;border-color:#eab308}
#wt-app.light .wt-2d-tile.high{background:#fff7ed;border-color:#f97316}
#wt-app.light .wt-2d-tile.full{background:#fef2f2;border-color:#ef4444}
.wt-2d-tile-name{font-size:10px;font-weight:800;color:var(--wt-text);line-height:1.2;word-break:break-all}
.wt-2d-tile.empty .wt-2d-tile-name{color:var(--wt-text3)}
.wt-2d-tile-qty{font-size:8px;font-weight:600;color:var(--wt-text2);margin-top:2px}
.wt-2d-tile.empty .wt-2d-tile-qty{color:var(--wt-border)}
.wt-2d-tile-bar{position:absolute;bottom:0;left:0;right:0;height:2px;border-radius:0 0 6px 6px}
.wt-2d-levels{width:100%;margin-top:5px;display:flex;flex-direction:column;gap:3px}
.wt-2d-lv-row{display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:4px;background:rgba(255,255,255,.05);cursor:pointer;transition:background .12s}
.wt-2d-lv-row:hover{background:rgba(255,255,255,.1)}
#wt-app.light .wt-2d-lv-row{background:rgba(0,0,0,.04)}
#wt-app.light .wt-2d-lv-row:hover{background:rgba(0,0,0,.08)}
.wt-2d-lv-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.wt-2d-lv-name{font-size:9px;font-weight:700;color:var(--wt-text2);flex:1;text-align:left}
.wt-2d-lv-qty{font-size:9px;font-weight:700;font-variant-numeric:tabular-nums}
#wt-app.light #wt-dp{color:#1a202c}
#wt-app.light .wt-dp-title{color:#1a202c}
#wt-app.light .wt-dp-sub{color:#718096}
#wt-app.light .wt-dp-sec{color:#a0aec0}
#wt-app.light .wt-dp-lv-name{color:#1a202c}
#wt-app.light .wt-dp-items-lbl{color:#a0aec0}
#wt-app.light .wt-dp-icode{color:#2b6cb0}
#wt-app.light .wt-dp-imeta{color:#718096}
#wt-app.light .wt-x-btn{color:#2d3748;background:#edf2f7;border:1.5px solid #cbd5e0;font-weight:900}
#wt-app.light .wt-x-btn:hover{background:#e2e8f0}
#wt-app.light #wt-dp-x{color:#2d3748;background:#e2e8f0;border:1.5px solid #a0aec0}
#wt-app.light .wt-dp-lv{background:#f7fafc;border-color:#e2e8f0}
#wt-app.light .wt-dp-lv:hover{background:#edf2f7}
#wt-app.light .wt-divider{background:#e2e8f0}
#wt-fp-ov{display:none;position:absolute;inset:0;background:rgba(0,0,0,.6);z-index:95;align-items:center;justify-content:center}
#wt-fp-ov.open{display:flex}
#wt-fp-modal{background:#13151e;border:1px solid rgba(255,255,255,.1);border-radius:14px;width:680px;max-width:95vw;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden;animation:wtFpIn .22s cubic-bezier(.34,1.56,.64,1)}
@keyframes wtFpIn{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}
#wt-fp-hdr{display:flex;align-items:flex-start;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0}
#wt-fp-title{font-size:14px;font-weight:700;color:#fff}
#wt-fp-subtitle{font-size:10px;color:rgba(255,255,255,.35);margin-top:2px}
#wt-fp-body{flex:1;overflow-y:auto;padding:16px}
#wt-fp-body::-webkit-scrollbar{width:4px}
#wt-fp-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:10px}
#wt-fp-footer{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid rgba(255,255,255,.07);flex-shrink:0}
#wt-fp-footer-left{font-size:10px;color:rgba(255,255,255,.3)}
#wt-fp-footer-right{display:flex;gap:8px}
.wt-fp-row-wrap{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:10px;overflow:hidden}
.wt-fp-row-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.06)}
.wt-fp-row-lbl{font-size:10px;font-weight:700;color:rgba(255,255,255,.5);letter-spacing:.5px;flex:1}
.wt-fp-row-lbl input{background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,.15);color:#fff;font-size:10px;font-weight:700;width:120px;outline:none;padding:1px 3px}
.wt-fp-row-lbl input:focus{border-bottom-color:#3b82f6}
.wt-fp-row-del{width:22px;height:22px;border-radius:4px;border:none;background:rgba(248,113,113,.15);color:#f87171;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;flex-shrink:0}
.wt-fp-row-del:hover{background:rgba(248,113,113,.28)}
.wt-fp-cells{display:flex;gap:8px;padding:10px 12px;flex-wrap:wrap;align-items:stretch}
.wt-fp-cell{background:rgba(255,255,255,.04);border:1.5px dashed rgba(255,255,255,.12);border-radius:8px;padding:8px;min-width:130px;flex:1;display:flex;flex-direction:column;gap:6px;position:relative;transition:border-color .15s}
.wt-fp-cell:hover{border-color:rgba(59,130,246,.4)}
.wt-fp-cell.assigned{border-style:solid;border-color:#3b82f6;background:rgba(59,130,246,.08)}
.wt-fp-cell.is-aisle{background:repeating-linear-gradient(-45deg,rgba(255,255,255,.02) 0,rgba(255,255,255,.02) 2px,transparent 2px,transparent 8px);border-style:dashed;border-color:rgba(255,255,255,.08)}
.wt-fp-cell-top{display:flex;align-items:center;justify-content:space-between;gap:4px}
.wt-fp-cell-lbl{font-size:9px;color:rgba(255,255,255,.3);font-weight:600}
.wt-fp-span-sel{height:22px;padding:0 5px;border-radius:4px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.06);color:#fff;font-size:10px;outline:none;width:52px}
.wt-fp-cell-del{width:18px;height:18px;border-radius:3px;border:none;background:rgba(248,113,113,.12);color:#f87171;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;flex-shrink:0}
.wt-fp-wh-sel{width:100%;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#fff;font-size:10px;outline:none;cursor:pointer}
.wt-fp-wh-sel:focus{border-color:#3b82f6}
.wt-fp-aisle-chk{display:flex;align-items:center;gap:4px;font-size:9px;color:rgba(255,255,255,.35);cursor:pointer}
.wt-fp-aisle-chk input{width:auto;cursor:pointer}
.wt-fp-add-cell{height:28px;border-radius:6px;border:1px dashed rgba(59,130,246,.3);background:rgba(59,130,246,.05);color:#60a5fa;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:3px;min-width:80px;flex-shrink:0}
.wt-fp-add-cell:hover{background:rgba(59,130,246,.12)}
.wt-fp-add-row{width:100%;height:36px;border-radius:8px;border:1.5px dashed rgba(59,130,246,.3);background:rgba(59,130,246,.04);color:#60a5fa;font-size:11px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;transition:background .12s;margin-top:4px}
.wt-fp-add-row:hover{background:rgba(59,130,246,.12)}
.wt-fp-preview-wrap{margin-bottom:12px}
.wt-fp-preview-lbl{font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:rgba(255,255,255,.25);margin-bottom:6px}
.wt-fp-preview{display:flex;flex-direction:column;gap:4px;padding:10px;background:rgba(0,0,0,.2);border-radius:8px}
.wt-fp-prev-row{display:flex;gap:4px}
.wt-fp-prev-cell{height:28px;border-radius:4px;border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;flex:1;overflow:hidden;white-space:nowrap;padding:0 4px}
.wt-fp-prev-cell.empty{background:rgba(255,255,255,.03);color:rgba(255,255,255,.2);border-style:dashed}
.wt-fp-prev-cell.filled{background:rgba(59,130,246,.2);border-color:rgba(59,130,246,.5);color:#93c5fd}
.wt-fp-prev-cell.aisle{background:repeating-linear-gradient(-45deg,rgba(255,255,255,.03) 0,rgba(255,255,255,.03) 2px,transparent 2px,transparent 6px);color:rgba(255,255,255,.2)}
.wt-fp-save-ok{display:none;align-items:center;gap:6px;font-size:11px;color:#4ade80;margin-bottom:10px;padding:8px 10px;background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.2);border-radius:6px}
.wt-fp-save-ok.show{display:flex}
.wt-fp-gap-ctrl{display:flex;align-items:center;gap:6px;margin-left:auto}
.wt-fp-gap-lbl{font-size:9px;color:rgba(255,255,255,.3);white-space:nowrap}
.wt-fp-gap-val{font-size:9px;color:#60a5fa;font-weight:700;min-width:18px;text-align:right}
.wt-fp-gap-slider{-webkit-appearance:none;width:70px;height:3px;border-radius:2px;background:rgba(255,255,255,.12);outline:none;cursor:pointer}
.wt-fp-gap-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#3b82f6;cursor:pointer}
.wt-fp-row-gap-line{height:0;transition:height .3s cubic-bezier(.34,1.56,.64,1);background:transparent;display:flex;align-items:center;justify-content:center;overflow:hidden;margin:0 12px}
.wt-fp-row-gap-line.has-gap{border:1px dashed rgba(59,130,246,.25);border-radius:4px;background:rgba(59,130,246,.03)}
.wt-fp-gap-line-lbl{font-size:9px;color:rgba(59,130,246,.4);white-space:nowrap}
#wt-search-tag{display:none;align-items:center;gap:5px;background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.4);border-radius:6px;padding:2px 8px;font-size:10px;font-weight:700;color:#60a5fa;pointer-events:all;margin-left:4px}
#wt-search-tag.on{display:flex}
#wt-search-tag-x{cursor:pointer;font-size:11px;margin-left:2px;opacity:.7}
#wt-search-tag-x:hover{opacity:1}
#wt-setup{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--wt-bg);overflow-y:auto;padding:30px 16px}
#wt-setup-card{background:var(--wt-bg2);border:1px solid var(--wt-border);border-radius:16px;width:100%;max-width:640px;padding:28px 28px 24px;box-shadow:0 24px 64px rgba(0,0,0,.18)}
.wt-setup-steps{display:flex;align-items:center;gap:6px;margin-bottom:22px}
.wt-setup-step{display:flex;align-items:center;gap:6px;flex:1}
.wt-setup-dot{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.wt-setup-dot.done{background:#4ade80;color:#063a1c}
.wt-setup-dot.active{background:#3b82f6;color:#fff}
.wt-setup-dot.todo{background:var(--wt-card);color:var(--wt-text3);border:1px solid var(--wt-border)}
.wt-setup-line{flex:1;height:2px;background:var(--wt-border)}
.wt-setup-line.done{background:#4ade80}
.wt-setup-label{font-size:11px;color:var(--wt-text3);white-space:nowrap}
.wt-setup-h3{font-size:17px;font-weight:800;color:var(--wt-text);margin-bottom:4px}
.wt-setup-sub{font-size:13px;color:var(--wt-text2);margin-bottom:16px;line-height:1.5}
.wt-setup-hint{background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.25);border-radius:8px;padding:10px 12px;font-size:12px;color:#60a5fa;margin-bottom:16px;display:flex;gap:8px;align-items:flex-start;line-height:1.5}
.wt-setup-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--wt-card);border-radius:8px;margin-bottom:8px;border:1px solid var(--wt-border)}
.wt-setup-icon{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;background:rgba(59,130,246,.15)}
.wt-setup-info{flex:1;min-width:0}
.wt-setup-name{font-size:13px;font-weight:700;color:var(--wt-text)}
.wt-setup-meta{font-size:11px;color:var(--wt-text3);margin-top:1px}
.wt-setup-select{height:32px;padding:0 10px;border-radius:6px;border:1px solid var(--wt-border);background:var(--wt-bg2);font-size:12px;color:var(--wt-text);min-width:130px}
.wt-setup-actions{display:flex;justify-content:space-between;align-items:center;margin-top:18px;padding-top:14px;border-top:1px solid var(--wt-border)}
.wt-setup-btn{height:34px;padding:0 18px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid var(--wt-border);background:var(--wt-card);color:var(--wt-text2)}
.wt-setup-btn:hover{background:var(--wt-cb)}
.wt-setup-btn-primary{background:#3b82f6;color:#fff;border:none}
.wt-setup-btn-primary:hover{background:#2563eb}
.wt-setup-btn-primary:disabled{opacity:.5;cursor:not-allowed}
.wt-setup-summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
.wt-setup-stat{background:var(--wt-card);border:1px solid var(--wt-border);border-radius:10px;padding:14px 10px;text-align:center}
.wt-setup-stat-val{font-size:22px;font-weight:800;color:#60a5fa}
.wt-setup-stat-lbl{font-size:10px;color:var(--wt-text3);margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.wt-setup-empty{text-align:center;padding:40px 20px}
.wt-setup-empty-icon{font-size:40px;margin-bottom:12px;opacity:.4}
`;

/* ─────────────────────────────────────────────────────────────
   STORE  (shared reactive state)
───────────────────────────────────────────────────────────── */
const store = reactive({
  isDark: true,
  curView: '3d',
  groups: [],
  curGrp: null,
  slots: [],
  loading: false,
  searchQuery: '',
  selKey: null,
  dpOpen: false,
  dpData: null,
  imOpen: false,
  imData: null,
  imKeepTabs: false,
  cfgOpen: false,
  cfgSlot: null,
  cfgLvs: [],
  // Setup wizard
  setupChecking: true,
  setupComplete: false,
  setupStep: 1,
  setupScan: null,
  setupMapping: {},
  setupSaving: false,
  setupSummary: null,
  fpOpen: false,
  fpRows: [],
  fpAllSlots: [],
  fpGroup: null,
  fpSaveOk: false,
  fpSaving: false,
  ttVisible: false,
  ttX: 0,
  ttY: 0,
  ttData: null,
  threeReady: false,
  sidebarOpen: false,
  aisleMode: false,
  aislePickerOpen: false,
  aisleGaps: [],
  _aisleStartX: 0,
  canEdit: false,
  canView: true,
});

/* ─────────────────────────────────────────────────────────────
   COMPUTED HELPERS
───────────────────────────────────────────────────────────── */
function filteredSlots() {
  if (!store.searchQuery) return store.slots;
  const q = store.searchQuery.toLowerCase();
  return store.slots.filter(sl =>
    sl.levels.some(lv =>
      (lv.items||[]).some(it =>
        (it.c||'').toLowerCase().includes(q) ||
        (it.n||'').toLowerCase().includes(q)
      )
    )
  );
}

function hudStats() {
  const slots = store.slots;
  const total = slots.length;
  const occ   = slots.filter(s=>hasStock(s)).length;
  const qty   = slots.reduce((s,sl)=>s+sl.levels.reduce((ss,l)=>(l.uoms||[]).reduce((sss,u)=>sss+(u.qty||0),ss),s),0);
  return { total, occ, free: total-occ, qty: fmtK(qty) };
}

/* ─────────────────────────────────────────────────────────────
   THREE.JS ENGINE  (extracted from WarehouseTheatreApp)
───────────────────────────────────────────────────────────── */
class ThreeEngine {
  constructor() {
    this.meshMap = {};
    this.theta=.65; this.phi=.78; this.radius=28; this.panX=0; this.panZ=0;
    this.tT=.65; this.tP=.78; this.tR=28; this.tPX=0; this.tPZ=0;
    this.drag=false; this.rDrag=false; this.lx=0; this.ly=0;
    this.hovKey=null;
    this._animRunning=false;
    this.aisleMode=false;
  }

  init(canvas, cwEl) {
    const THREE = window.THREE;
    this.canvas=canvas; this.cwEl=cwEl;
    this.renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:false});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    this.renderer.shadowMap.enabled=true;
    this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    const bgCol = store.isDark ? 0x0c0e14 : 0xf0f2f5;
    this.renderer.setClearColor(bgCol,1);
    this.scene.background = new THREE.Color(bgCol);
    this.scene.fog = new THREE.Fog(bgCol,50,130);
    this.camera = new THREE.PerspectiveCamera(45,1,.1,200);
    this.camera.position.set(14,18,24);
    this.camera.lookAt(0,0,0);
    this.scene.add(new THREE.AmbientLight(0xffffff,.4));
    const dL = new THREE.DirectionalLight(0xffffff,.8);
    dL.position.set(12,22,12); dL.castShadow=true;
    dL.shadow.mapSize.set(2048,2048);
    dL.shadow.camera.left=-30; dL.shadow.camera.right=30;
    dL.shadow.camera.top=30; dL.shadow.camera.bottom=-30;
    this.scene.add(dL);
    const fL = new THREE.DirectionalLight(0x4060ff,.25);
    fL.position.set(-10,6,-10); this.scene.add(fL);
    this.ptL = new THREE.PointLight(0x60a5fa,.5,60);
    this.ptL.position.set(0,16,0); this.scene.add(this.ptL);
    const fl = new THREE.Mesh(
      new THREE.PlaneGeometry(80,80),
      new THREE.MeshStandardMaterial({color:0x0a0c12,roughness:.95,metalness:.05})
    );
    fl.rotation.x=-Math.PI/2; fl.position.y=-.02; fl.receiveShadow=true;
    this.scene.add(fl);
    const gc = store.isDark?0x181c28:0xdde1e7;
    this.scene.add(new THREE.GridHelper(80,40,gc,gc));
    this.rootGrp = new THREE.Group();
    this.scene.add(this.rootGrp);
    this._sizeRenderer();
    this._startAnimate();
    new ResizeObserver(()=>this._sizeRenderer()).observe(cwEl);
    store.threeReady=true;
  }

  _sizeRenderer() {
    const w=this.cwEl.clientWidth, h=this.cwEl.clientHeight;
    if (!w||!h) return;
    this.renderer.setSize(w,h,false);
    this.camera.aspect=w/h;
    this.camera.updateProjectionMatrix();
  }

  _startAnimate() {
    if (this._animRunning) return;
    this._animRunning=true;
    const loop=()=>{
      requestAnimationFrame(loop);
      const t=performance.now()*.001;
      this.theta  +=(this.tT -this.theta) *.08;
      this.phi    +=(this.tP -this.phi)   *.08;
      this.radius +=(this.tR -this.radius)*.08;
      this.panX   +=(this.tPX-this.panX)  *.08;
      this.panZ   +=(this.tPZ-this.panZ)  *.08;
      this._updateCamera();
      this.ptL.position.x=Math.sin(t*.35)*7;
      this.ptL.position.z=Math.cos(t*.35)*7;
      this.renderer.render(this.scene,this.camera);
    };
    loop();
  }

  _updateCamera() {
    if (this.aisleMode) {
      // First-person: camera stays at aisle height, looks along Z axis
      this.camera.position.set(this.fpX, this.fpY, this.fpZ);
      this.camera.lookAt(this.fpX + Math.sin(this.fpYaw), this.fpY + this.fpPitch, this.fpZ + Math.cos(this.fpYaw));
      return;
    }
    this.camera.position.set(
      this.panX+this.radius*Math.sin(this.phi)*Math.sin(this.theta),
      this.radius*Math.cos(this.phi),
      this.panZ+this.radius*Math.sin(this.phi)*Math.cos(this.theta)
    );
    this.camera.lookAt(this.panX,0,this.panZ);
  }

  enterAisleView(aisleZ) {
    // Position camera at human height in the aisle
    this.aisleMode = true;
    this.fpX = 0;
    this.fpY = 2.2;  // ~human eye height
    this.fpZ = aisleZ;
    this.fpYaw = Math.PI; // looking along -Z (down the aisle)
    this.fpPitch = 0;
    this.fpSpeed = 0.15;
    store.aisleMode = true;
  }

  exitAisleView() {
    this.aisleMode = false;
    store.aisleMode = false;
    // Restore orbit view
    this.tT=.65; this.tP=.78; this.tR=28; this.tPX=0; this.tPZ=0;
  }

  moveAisle(forward, strafe, turnY, turnX) {
    if (!this.aisleMode) return;
    this.fpYaw += turnY * 0.02;
    this.fpPitch = Math.max(-0.8, Math.min(0.8, this.fpPitch + turnX * 0.02));
    this.fpX += Math.sin(this.fpYaw) * forward * this.fpSpeed + Math.cos(this.fpYaw) * strafe * this.fpSpeed;
    this.fpZ += Math.cos(this.fpYaw) * forward * this.fpSpeed - Math.sin(this.fpYaw) * strafe * this.fpSpeed;
  }

  buildScene(slots) {
    const THREE=window.THREE;
    while (this.rootGrp.children.length) this.rootGrp.remove(this.rootGrp.children[0]);
    this.meshMap={};
    store.selKey=null;
    const SW=2.2, SD=2.2, GAP=.6, LVH=1.0, BASE=.1;
    const cols=Math.max(...slots.map(s=>s.col),0)+1;
    const maxRow=Math.max(...slots.map(s=>s.row),0);
    const rowZOffset={};
    let cumZ=0;
    for (let r=0;r<=maxRow;r++){
      rowZOffset[r]=cumZ;
      const rowSlots=slots.filter(s=>s.row===r);
      const rowGap=rowSlots.length?(parseFloat(rowSlots[0].row_gap)||0):0;
      cumZ+=SD+GAP+rowGap;
    }
    const totalDepth=cumZ-GAP;
    const ox=-(cols*(SW+GAP)-GAP)/2;
    const oz=-totalDepth/2;
    const baseMat =new THREE.MeshStandardMaterial({color:store.isDark?0x1a2235:0xdde3ef,roughness:.8,metalness:.25});
    const pilMat  =new THREE.MeshStandardMaterial({color:store.isDark?0x2d3a52:0xc5cdd8,roughness:.7,metalness:.4});
    const shelfMat=new THREE.MeshStandardMaterial({color:store.isDark?0x22304a:0xcfd6e0,roughness:.9});
    const bgCol=store.isDark?0x0c0e14:0xf0f2f5;
    this.scene.background.setHex(bgCol);
    this.scene.fog.color.setHex(bgCol);
    this.renderer.setClearColor(bgCol,1);
    slots.forEach(sl=>{
      const nL=sl.levels.length;
      const cx=ox+sl.col*(SW+GAP)+SW/2;
      const cz=oz+(rowZOffset[sl.row]||0)+SD/2;
      const base=new THREE.Mesh(new THREE.BoxGeometry(SW,BASE,SD),baseMat);
      base.position.set(cx,BASE/2,cz); base.castShadow=true; base.receiveShadow=true;
      this.rootGrp.add(base);
      [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dx,dz])=>{
        const p=new THREE.Mesh(new THREE.BoxGeometry(.06,nL*LVH+BASE,.06),pilMat);
        p.position.set(cx+dx*(SW/2-.04),(nL*LVH+BASE)/2,cz+dz*(SD/2-.04));
        p.castShadow=true; this.rootGrp.add(p);
      });
      sl.levels.forEach((lv,li)=>{
        const lp=lvFill(lv), hs=(lv.uoms||[]).some(u=>u.qty>0);
        const col=hs?FC(lp):(store.isDark?0x101827:0xe8edf5);
        const y0=BASE+li*LVH;
        const shelf=new THREE.Mesh(new THREE.BoxGeometry(SW,.024,SD),shelfMat);
        shelf.position.set(cx,y0+.012,cz); this.rootGrp.add(shelf);
        const shell=new THREE.Mesh(
          new THREE.BoxGeometry(SW-.08,LVH-.03,SD-.08),
          new THREE.MeshStandardMaterial({color:hs?col:(store.isDark?0x0f1520:0xdde3ef),transparent:true,opacity:hs?.13:.06,side:THREE.BackSide,roughness:.3,depthWrite:false})
        );
        shell.position.set(cx,y0+LVH/2,cz); this.rootGrp.add(shell);
        let fillM=null;
        if (hs){
          const fh=Math.max(.05,(lp/100)*(LVH-.12));
          fillM=new THREE.Mesh(
            new THREE.BoxGeometry(SW-.26,fh,SD-.26),
            new THREE.MeshStandardMaterial({color:col,roughness:.38,metalness:.14,emissive:col,emissiveIntensity:.2})
          );
          fillM.position.set(cx,y0+.06+fh/2,cz); fillM.castShadow=true;
          this.rootGrp.add(fillM);
        }
        const proxy=new THREE.Mesh(
          new THREE.BoxGeometry(SW-.06,LVH-.02,SD-.06),
          new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false})
        );
        proxy.position.set(cx,y0+LVH/2,cz);
        proxy.userData={slot:sl,lv,key:lvKey(sl,lv)};
        this.rootGrp.add(proxy);
        this.meshMap[lvKey(sl,lv)]={fillM,shellM:shell,proxy,lv,slot:sl,li,col};
      });
    });
  }

  highlight(key) {
    store.selKey=key;
    const selLv=key?this.meshMap[key]?.lv:null;
    Object.entries(this.meshMap).forEach(([k,d])=>{
      const isSel=k===key, same=selLv&&d.lv.label===selLv.label;
      const lp=lvFill(d.lv), hs=(d.lv.uoms||[]).some(u=>u.qty>0);
      const col=hs?FC(lp):(store.isDark?0x101827:0xe8edf5);
      if (d.fillM){
        d.fillM.material.color.setHex(isSel?0xffffff:same?0xd0d8ff:col);
        d.fillM.material.emissive.setHex(isSel?0x3b82f6:same?0x1e3a8a:col);
        d.fillM.material.emissiveIntensity=isSel?.6:same?.28:.2;
      }
      d.shellM.material.color.setHex(isSel?0x3b82f6:same?0x1e40af:hs?col:0x0f1520);
      d.shellM.material.opacity=isSel?.4:same?.22:hs?.13:.06;
    });
  }

  springIn() {
    let t=0;
    const ease=v=>1-(1-v)**3;
    const step=()=>{
      t=Math.min(1,t+.05);
      this.rootGrp.scale.setScalar(ease(t));
      if(t<1) requestAnimationFrame(step);
    };
    this.rootGrp.scale.setScalar(.01);
    requestAnimationFrame(step);
  }

  bindMouse(cwEl, onHover, onClick) {
    const rc=new window.THREE.Raycaster();
    const mouse=new window.THREE.Vector2();
    cwEl.addEventListener('mousedown',e=>{
      this.drag=true; this.rDrag=e.button===2;
      this.lx=e.clientX; this.ly=e.clientY; e.preventDefault();
    });
    cwEl.addEventListener('contextmenu',e=>e.preventDefault());
    window.addEventListener('mouseup',()=>{this.drag=false;});
    window.addEventListener('mousemove',e=>{
      if (!this.drag) return;
      const dx=e.clientX-this.lx, dy=e.clientY-this.ly;
      this.lx=e.clientX; this.ly=e.clientY;
      if (this.aisleMode) {
        this.moveAisle(0, 0, -dx, -dy);
      } else if (this.rDrag){
        this.tPX-=dx*.014*Math.cos(this.theta);
        this.tPZ+=dx*.014*Math.sin(this.theta);
      } else {
        this.tT-=dx*.008;
        this.tP=Math.max(.08,Math.min(1.45,this.tP+dy*.008));
      }
    });
    cwEl.addEventListener('wheel',e=>{
      e.preventDefault();
      this.tR=Math.max(5,Math.min(60,this.tR+e.deltaY*.04));
    },{passive:false});
    cwEl.addEventListener('touchstart',e=>{
      if (e.touches.length===2) this.ltD=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
      else { this.ltX=e.touches[0].clientX; this.ltY=e.touches[0].clientY; }
    },{passive:true});
    cwEl.addEventListener('touchmove',e=>{
      e.preventDefault();
      if (e.touches.length===2){
        const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
        this.tR=Math.max(5,Math.min(60,this.tR-(d-this.ltD)*.08)); this.ltD=d;
      } else {
        const dx=e.touches[0].clientX-this.ltX, dy=e.touches[0].clientY-this.ltY;
        this.tT-=dx*.01; this.tP=Math.max(.08,Math.min(1.45,this.tP+dy*.01));
        this.ltX=e.touches[0].clientX; this.ltY=e.touches[0].clientY;
      }
    },{passive:false});
    cwEl.addEventListener('mousemove',e=>{
      if (this.drag){onHover(null,0,0); return;}
      const r=cwEl.getBoundingClientRect();
      mouse.set(((e.clientX-r.left)/r.width)*2-1,-((e.clientY-r.top)/r.height)*2+1);
      rc.setFromCamera(mouse,this.camera);
      const hits=rc.intersectObjects(Object.values(this.meshMap).map(d=>d.proxy));
      if (hits.length){
        this.hovKey=hits[0].object.userData.key;
        onHover(this.meshMap[this.hovKey],e.clientX-r.left,e.clientY-r.top);
        cwEl.style.cursor='pointer';
      } else {
        this.hovKey=null; onHover(null,0,0); cwEl.style.cursor='grab';
      }
    });
    // Single click → highlight + side panel only
    cwEl.addEventListener('click',()=>{
      if (!this.hovKey) return;
      const d=this.meshMap[this.hovKey];
      if (!d) return;
      onClick(d, store.selKey===this.hovKey, false);
    });
    // Double click → open full item modal
    cwEl.addEventListener('dblclick',()=>{
      if (!this.hovKey) return;
      const d=this.meshMap[this.hovKey];
      if (!d) return;
      onClick(d, false, true);
    });
  }
}

const engine = new ThreeEngine();

/* ─────────────────────────────────────────────────────────────
   ACTIONS  (business logic, shared across components)
───────────────────────────────────────────────────────────── */
const actions = {
  /* ── SETUP WIZARD ── */
  async checkSetup() {
    store.setupChecking = true;
    try {
      const access = await callSetup('is_setup_complete');
      store.setupComplete = !!access;
    } catch(e) {
      console.error('WT3D: setup check failed', e);
      store.setupComplete = false;
    } finally {
      store.setupChecking = false;
    }
  },

  async runScan() {
    store.loading = true;
    try {
      const result = await callSetup('scan_warehouse_tree');
      store.setupScan = result;
      // Seed default mapping by best-guess: last depth = Bin, first = Building, etc.
      const mapping = {};
      if (result && result.depths && result.depths.length) {
        const depths = result.depths.map(d=>d.depth).sort((a,b)=>a-b);
        const roleSeq = ['Building','Floor','Slot','Bin'];
        const offset = Math.max(0, roleSeq.length - depths.length);
        depths.forEach((d, i) => {
          mapping[d] = roleSeq[Math.min(i + offset, roleSeq.length-1)];
        });
      }
      store.setupMapping = mapping;
      store.setupStep = 2;
    } catch(e) {
      console.error('WT3D: scan failed', e);
      if (window.frappe) frappe.show_alert({message:'Scan failed: '+e.message, indicator:'red'}, 5);
    } finally {
      store.loading = false;
    }
  },

  setMappingRole(depth, role) {
    if (role === 'Skip') {
      delete store.setupMapping[depth];
    } else {
      store.setupMapping[depth] = role;
    }
  },

  async confirmMapping() {
    store.setupSaving = true;
    try {
      const mapping = Object.entries(store.setupMapping).map(([depth, role]) => ({ depth: parseInt(depth), role }));
      if (!mapping.length) {
        if (window.frappe) frappe.show_alert({message:'Assign at least one level before continuing.', indicator:'orange'}, 4);
        store.setupSaving = false;
        return;
      }
      await callSetup('apply_depth_mapping', { mapping: JSON.stringify(mapping) });
      const summary = await callSetup('get_setup_summary');
      store.setupSummary = summary;
      store.setupStep = 3;
    } catch(e) {
      console.error('WT3D: apply mapping failed', e);
      if (window.frappe) frappe.show_alert({message:'Save failed: '+e.message, indicator:'red'}, 5);
    } finally {
      store.setupSaving = false;
    }
  },

  async finishSetup() {
    store.setupComplete = true;
    await actions.loadGroups();
  },

  setupGoBack() {
    if (store.setupStep > 1) store.setupStep -= 1;
  },


  enterAisleView(gapIndex=null) {
    if (!store.slots.length) return;
    const SW=2.2, SD=2.2, GAP=.6;

    // Calculate row Z positions (same as buildScene)
    const maxRow=Math.max(...store.slots.map(s=>s.row),0);
    const maxCol=Math.max(...store.slots.map(s=>s.col),0);
    let cumZ=0;
    const rowZOffset={};
    const rowGaps={};
    for (let r=0;r<=maxRow;r++){
      rowZOffset[r]=cumZ;
      const rowSlots=store.slots.filter(s=>s.row===r);
      const rowGap=rowSlots.length?(parseFloat(rowSlots[0].row_gap)||0):0;
      rowGaps[r]=rowGap;
      cumZ+=SD+GAP+rowGap;
    }
    const totalDepth=cumZ-GAP;
    const oz=-totalDepth/2;
    const ox=-((maxCol+1)*(SW+GAP)-GAP)/2;
    const startX=ox+(maxCol/2)*(SW+GAP);

    // Build list of aisle gaps (between consecutive rows)
    const rows=[...new Set(store.slots.map(s=>s.row))].sort((a,b)=>a-b);
    const aisleGaps=[];

    // Gap before first row
    aisleGaps.push({
      label: `Before Row ${rows[0]+1}`,
      z: oz+(rowZOffset[rows[0]]||0)-2,
    });

    // Gaps between rows
    for (let i=0;i<rows.length-1;i++){
      const r0=rows[i], r1=rows[i+1];
      const z0=oz+(rowZOffset[r0]||0)+SD;
      const z1=oz+(rowZOffset[r1]||0);
      aisleGaps.push({
        label: `Aisle between Row ${r0+1} & Row ${r1+1}`,
        z: (z0+z1)/2,
      });
    }

    // Gap after last row
    aisleGaps.push({
      label: `After Row ${rows[rows.length-1]+1}`,
      z: oz+(rowZOffset[rows[rows.length-1]]||0)+SD+2,
    });

    store.aisleGaps = aisleGaps;
    store.aisleGapIndex = null;

    // If only one gap or specific gap requested, enter directly
    if (gapIndex !== null) {
      this._startAisleAt(aisleGaps[gapIndex], startX);
    } else if (aisleGaps.length === 1) {
      this._startAisleAt(aisleGaps[0], startX);
    } else {
      // Show gap picker
      store.aislePickerOpen = true;
      store._aisleStartX = startX;
    }
  },

  enterAisleGap(index) {
    store.aislePickerOpen = false;
    const gap = store.aisleGaps[index];
    actions._startAisleAt(gap, store._aisleStartX);
  },

  _startAisleAt(gap, startX) {
    engine.aisleMode = true;
    engine.fpX = startX;
    engine.fpY = 2.0;
    engine.fpZ = gap.z;
    engine.fpYaw = Math.PI/2;
    engine.fpPitch = 0;
    engine.fpSpeed = 0.18;
    store.aisleMode = true;
    store.aislePickerOpen = false;

    const keys={};
    const onKeyDown=e=>{if(store.aisleMode)keys[e.code]=true;};
    const onKeyUp=e=>{keys[e.code]=false;};
    const moveLoop=()=>{
      if(!store.aisleMode) return;
      const fwd=(keys['KeyW']||keys['ArrowUp']?1:0)-(keys['KeyS']||keys['ArrowDown']?1:0);
      const str=(keys['KeyD']||keys['ArrowRight']?1:0)-(keys['KeyA']||keys['ArrowLeft']?1:0);
      if(fwd||str) engine.moveAisle(fwd,str,0,0);
      requestAnimationFrame(moveLoop);
    };
    document.addEventListener('keydown',onKeyDown);
    document.addEventListener('keyup',onKeyUp);
    store._aisleKeyDown=onKeyDown;
    store._aisleKeyUp=onKeyUp;
    moveLoop();
  },

  exitAisleView() {
    engine.exitAisleView();
    if (store._aisleKeyDown) document.removeEventListener('keydown', store._aisleKeyDown);
    if (store._aisleKeyUp)   document.removeEventListener('keyup',   store._aisleKeyUp);
  },

  async loadGroups() {
    store.loading=true;
    try {
      try {
        const access = await call('get_user_access');
        store.canEdit = !!(access && access.can_edit);
        store.canView = !!(access && access.can_view);
      } catch(e) {
        console.error('WT: access check failed', e);
        store.canEdit = false;
        store.canView = false;
      }
      const groups = await call('get_warehouse_groups');
      store.groups = groups||[];
      if (store.groups.length) await actions.selectGroup(store.groups[0]);
    } catch(e){ console.error('WT: groups', e); }
    finally { store.loading=false; }
  },

  async selectGroup(g) {
    store.curGrp=g;
    store.dpOpen=false;
    store.imOpen=false;
    store.sidebarOpen=false;
    store.loading=true;
    try {
      const slots = await call('get_slots',{group_warehouse:g.id});
      store.slots=slots||[];
      if (store.curView==='3d') {
        engine.buildScene(filteredSlots());
        engine.springIn();
      } else {
        // 2D will re-render reactively
      }
    } catch(e){ console.error('WT: slots', e); }
    finally { store.loading=false; }
  },

  openDP(d) {
    store.dpData=d;
    store.dpOpen=true;
  },

  closeDP() {
    store.dpOpen=false;
    store.imOpen=false;
    engine.highlight(null);
    store.selKey=null;
  },

  openItemModal(d, keepTabs=false) {
    store.imData=d;
    store.imKeepTabs=keepTabs;
    store.imOpen=true;
  },

  closeItemModal() {
    store.imOpen=false;
  },

  open2DModal(slotWh) {
    const sl=store.slots.find(s=>s.wh===slotWh);
    if (!sl) return;
    const defaultLv=sl.levels.find(l=>(l.uoms||[]).some(u=>u.qty>0))||sl.levels[0];
    if (!defaultLv) return;
    actions.openDP({slot:sl,lv:defaultLv});
    actions.openItemModal({slot:sl,lv:defaultLv},true);
  },

  open2DModalLevel(slotWh, lvWh) {
    const sl=store.slots.find(s=>s.wh===slotWh);
    if (!sl) return;
    const lv=sl.levels.find(l=>l.wh===lvWh);
    if (!lv) return;
    actions.openDP({slot:sl,lv});
    actions.openItemModal({slot:sl,lv},true);
  },

  switchModalLevel(slotWh, lvWh) {
    const sl=store.slots.find(s=>s.wh===slotWh);
    if (!sl) return;
    const lv=sl.levels.find(l=>l.wh===lvWh);
    if (!lv) return;
    actions.openItemModal({slot:sl,lv},true);
  },

  clickLv(slotWh, lvWh) {
    const d=Object.values(engine.meshMap).find(x=>x.slot.wh===slotWh&&x.lv.wh===lvWh);
    if (!d) return;
    const k=lvKey(d.slot,d.lv), wasSel=store.selKey===k;
    engine.highlight(wasSel?null:k);
    if (!wasSel){ actions.openDP(d); actions.openItemModal(d); }
  },

  updateCap(slotWh, lvWh, ui, val) {
    store.slots.forEach(sl=>{
      if (sl.wh!==slotWh) return;
      sl.levels.forEach(lv=>{ if(lv.wh===lvWh) lv.uoms[ui].cap=parseFloat(val)||0; });
    });
    if (store.curView==='3d') engine.buildScene(filteredSlots());
    const d=Object.values(engine.meshMap).find(x=>x.slot.wh===slotWh&&x.lv.wh===lvWh);
    if (d){ const k=lvKey(d.slot,d.lv); engine.highlight(k); store.selKey=k; actions.openDP(d); }
    const lv=store.slots.find(s=>s.wh===slotWh)?.levels.find(l=>l.wh===lvWh);
    if (lv) call('save_uom_capacity',{warehouse:lvWh,uom:lv.uoms[ui].u,capacity:val}).catch(()=>{});
  },

  openCfg(slotWh) {
    store.cfgSlot=slotWh?store.slots.find(s=>s.wh===slotWh):null;
    store.cfgLvs=store.cfgSlot?JSON.parse(JSON.stringify(store.cfgSlot.levels)):[];
    store.cfgOpen=true;
  },

  closeCfg() { store.cfgOpen=false; },

  addLv() {
    const n=store.cfgLvs.length+1;
    store.cfgLvs.push({wh:`${store.cfgSlot.wh}-L${n}`,label:`L${n}`,uoms:[],items:[]});
  },

  delLv(i) {
    store.cfgLvs.splice(i,1);
    store.cfgLvs.forEach((lv,idx)=>{ lv.label=`L${idx+1}`; lv.wh=`${store.cfgSlot.wh}-L${idx+1}`; });
  },

  async saveCfg(labelVal) {
    if (!store.cfgSlot){ actions.closeCfg(); return; }
    if (labelVal) store.cfgSlot.label=labelVal;
    store.cfgSlot.levels=JSON.parse(JSON.stringify(store.cfgLvs));
    if (store.curView==='3d') engine.buildScene(filteredSlots());
    call('save_stack_config',{slot_warehouse:store.cfgSlot.wh,levels:JSON.stringify(store.cfgLvs)}).catch(()=>{});
    actions.closeCfg();
  },

  toggleTheme() {
    store.isDark=!store.isDark;
    const app=document.getElementById('wt-app');
    app.classList.toggle('dark',store.isDark);
    app.classList.toggle('light',!store.isDark);
    if (store.curView==='3d' && store.slots.length) engine.buildScene(filteredSlots());
  },

  setView(v) {
    store.curView=v;
    const cw3d=document.getElementById('wt-cw');
    const v2d=document.getElementById('wt-view2d');
    const isMobile=window.innerWidth<=600;
    if(cw3d) cw3d.style.display=v==='3d'?'block':'none';
    if(v2d){
      v2d.style.display=v==='2d'?'block':'none';
      if(isMobile) v2d.style.top='80px';
    }
    if (v==='3d' && store.slots.length) engine.buildScene(filteredSlots());
  },

  applySearch(q) {
    store.searchQuery=q?q.toLowerCase():'';
    if (store.curView==='3d') engine.buildScene(filteredSlots());
    // 2D re-renders reactively
  },

  clearSearch() {
    store.searchQuery='';
    if (store.curView==='3d') engine.buildScene(store.slots);
  },

  // Floor Plan
  fpOpen(group, currentSlots) {
    if (!group) {
      if (window.frappe) frappe.show_alert({message:'Select a warehouse group first',indicator:'orange'},3);
      return;
    }
    store.fpGroup=group;
    store.fpAllSlots=currentSlots||[];
    const byPos={};
    currentSlots.forEach(sl=>{
      const r=sl.row||0, c=sl.col||0;
      if(!byPos[r]) byPos[r]={};
      byPos[r][c]=sl;
    });
    const rowIdxs=Object.keys(byPos).map(Number).sort((a,b)=>a-b);
    if (rowIdxs.length){
      store.fpRows=rowIdxs.map(ri=>{
        const colIdxs=Object.keys(byPos[ri]).map(Number).sort((a,b)=>a-b);
        const firstSlot=byPos[ri][colIdxs[0]];
        return {
          label:`Row ${ri+1}`,
          cells:colIdxs.map(ci=>({wh:byPos[ri][ci].wh,span:1,aisle:false})),
          gap:parseFloat(firstSlot.row_gap)||0,
        };
      });
    } else {
      store.fpRows=[{label:'Row 1',cells:[{wh:'',span:1,aisle:false}],gap:0}];
    }
    store.fpSaveOk=false;
    store.fpOpen=true;
  },

  fpClose() { store.fpOpen=false; },

  fpAddRow() {
    store.fpRows.push({label:`Row ${store.fpRows.length+1}`,cells:[{wh:'',span:1,aisle:false}],gap:0});
  },

  fpDelRow(ri) { store.fpRows.splice(ri,1); },
  fpAddCell(ri) { store.fpRows[ri].cells.push({wh:'',span:1,aisle:false}); },
  fpDelCell(ri,ci) { store.fpRows[ri].cells.splice(ci,1); },
  fpSetCellWh(ri,ci,val) { store.fpRows[ri].cells[ci].wh=val; },
  fpSetCellSpan(ri,ci,val) { store.fpRows[ri].cells[ci].span=parseInt(val)||1; },
  fpSetCellAisle(ri,ci,val) { store.fpRows[ri].cells[ci].aisle=val; if(val) store.fpRows[ri].cells[ci].wh=''; },
  fpSetRowLabel(ri,val) { store.fpRows[ri].label=val; },
  fpSetRowGap(ri,val) { store.fpRows[ri].gap=parseFloat(val)||0; },

  async fpSave() {
    store.fpSaving=true;
    try {
      const saves=[];
      store.fpRows.forEach((row,ri)=>{
        row.cells.forEach((cell,ci)=>{
          if (cell.wh && !cell.aisle){
            saves.push(call('save_slot_position',{warehouse:cell.wh,row:ri,col:ci,row_gap:row.gap||0}));
          }
        });
      });
      await Promise.all(saves);
      store.fpSaveOk=true;
      if (window.frappe) frappe.show_alert({message:'Floor plan saved',indicator:'green'},3);
      await actions.selectGroup(store.fpGroup);
    } catch(e){
      if (window.frappe) frappe.show_alert({message:'Save failed: '+e.message,indicator:'red'},5);
    } finally {
      store.fpSaving=false;
    }
  },
};

/* ─────────────────────────────────────────────────────────────
   COMPONENT: Sidebar
───────────────────────────────────────────────────────────── */
const Sidebar = defineComponent({
  name: 'Sidebar',
  setup() {
    const byParent = computed(()=>{
      const m={};
      store.groups.forEach(g=>{
        const k=g.parent_name||'Root';
        if(!m[k]) m[k]=[];
        m[k].push(g);
      });
      return m;
    });
    return { store, byParent, actions };
  },
  template: `
    <div>
      <div id="wt-sb-overlay" :class="store.sidebarOpen?'show':''" @click="actions.toggleSidebar()"></div>
      <div id="wt-sb" :class="store.sidebarOpen?'mobile-open':''">
        <div class="wt-sb-brand">Warehouse Theatre</div>
        <div id="wt-sb-list">
          <template v-for="(gs, parent) in byParent" :key="parent">
            <span class="wt-sb-label">{{parent}}</span>
            <div v-for="g in gs" :key="g.id"
              :class="['wt-g-item', store.curGrp?.id===g.id?'act':'']"
              @click="actions.selectGroup(g)">
              <span class="wt-g-name">{{g.name}}</span>
              <span class="wt-g-meta">{{g.slot_count||0}} slots</span>
            </div>
          </template>
        </div>
        <div class="wt-sb-foot" v-if="store.canEdit">
          <button class="wt-sb-btn" style="margin-bottom:6px"
            @click="actions.fpOpen(store.curGrp, store.slots)">⋹ Edit floor plan</button>
          <button class="wt-sb-btn" @click="actions.openCfg(null)">⚙ Configure slot</button>
        </div>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: TopBar
───────────────────────────────────────────────────────────── */
const TopBar = defineComponent({
  name: 'TopBar',
  setup() {
    const hud = computed(()=>hudStats());
    const searchVal = ref('');
    let timer;
    function onSearch(e) {
      searchVal.value=e.target.value;
      clearTimeout(timer);
      timer=setTimeout(()=>actions.applySearch(e.target.value.trim()),300);
    }
    function clearSearch() {
      searchVal.value='';
      actions.clearSearch();
    }
    return { store, hud, searchVal, onSearch, clearSearch, actions, fmtK };
  },
  template: `
    <div id="wt-top">
      <button id="wt-mob-menu" @click="actions.toggleSidebar()" aria-label="Menu">☰</button>
      <div id="wt-brand">Warehouse Theatre</div>
      <div class="wt-sep"></div>
      <div id="wt-switcher">
        <div class="wt-sw-group">
          <button :class="['wt-sw-btn', store.curView==='3d'?'act':'']" @click="actions.setView('3d')">⬡ 3D</button>
          <button :class="['wt-sw-btn', store.curView==='2d'?'act':'']" @click="actions.setView('2d')">⊞ 2D</button>
        </div>
        <button class="wt-theme-btn" @click="actions.toggleTheme()">{{store.isDark?'🌙':'☀️'}}</button>
        <button v-if="store.curView==='3d' && !store.aisleMode"
          class="wt-sw-btn" style="background:rgba(99,102,241,.2);color:#a5b4fc;border:1px solid rgba(99,102,241,.4);border-radius:6px;height:26px;padding:0 10px"
          @click="actions.enterAisleView()" title="Enter aisle walk-through view">
          👁 Aisle View
        </button>
        <button v-if="store.aisleMode" id="wt-exit-aisle" @click="actions.exitAisleView()">✕ Exit Aisle</button>
      </div>
      <div id="wt-search-wrap">
        <span id="wt-search-ico">🔍</span>
        <input id="wt-search" type="text" placeholder="Search item code…" autocomplete="off"
          :value="searchVal" @input="onSearch"/>
        <button v-if="searchVal" id="wt-search-clear" @click="clearSearch">✕</button>
      </div>
      <div id="wt-search-tag" :class="store.searchQuery?'on':''">
        <span>{{store.searchQuery}}</span>
        <span id="wt-search-tag-x" @click="clearSearch">✕</span>
      </div>
      <div class="wt-pills">
        <div class="wt-pill"><div class="wt-pv">{{hud.total}}</div><div class="wt-pl">Slots</div></div>
        <div class="wt-pill occ"><div class="wt-pv">{{hud.occ}}</div><div class="wt-pl">Active</div></div>
        <div class="wt-pill free"><div class="wt-pv">{{hud.free}}</div><div class="wt-pl">Empty</div></div>
        <div class="wt-pill qty"><div class="wt-pv">{{hud.qty}}</div><div class="wt-pl">Total qty</div></div>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: BottomBar (3D only)
───────────────────────────────────────────────────────────── */
const BottomBar = defineComponent({
  name: 'BottomBar',
  setup(){ return {store}; },
  template: `
    <div id="wt-bot" v-if="store.curView==='3d'">
      <div id="wt-hint">Left drag · orbit &nbsp;|&nbsp; Right drag · pan &nbsp;|&nbsp; Scroll · zoom<br>Click · highlight &amp; side panel &nbsp;|&nbsp; Double click · full stock details</div>
      <div id="wt-legend">
        <span class="wt-li"><span class="wt-lb" style="background:#4ade80"></span>Low</span>
        <span class="wt-li"><span class="wt-lb" style="background:#facc15"></span>Mid</span>
        <span class="wt-li"><span class="wt-lb" style="background:#fb923c"></span>High</span>
        <span class="wt-li"><span class="wt-lb" style="background:#f87171"></span>Full</span>
        <span class="wt-li"><span class="wt-lb" style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18)"></span>Empty</span>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: Tooltip
───────────────────────────────────────────────────────────── */
const Tooltip = defineComponent({
  name: 'Tooltip',
  setup(){
    return { store, UCH, fmt, FCH, lvFill };
  },
  computed:{
    uoms(){ return this.store.ttData?.lv?.uoms||[]; },
    lp(){ return this.store.ttData?lvFill(this.store.ttData.lv):0; },
    clr(){ const hs=(this.uoms).some(u=>u.qty>0); return hs?FCH(this.lp):'rgba(255,255,255,.2)'; },
  },
  template: `
    <div id="wt-tt" v-if="store.ttVisible"
      :style="{left:store.ttX+'px', top:store.ttY+'px', display:'block'}">
      <div id="wt-tt-title" v-if="store.ttData">
        {{store.ttData.slot.label}} · {{store.ttData.lv.label}} ({{store.ttData.lv.wh}})
      </div>
      <div v-if="uoms.length">
        <div v-for="(u,i) in uoms" :key="i" class="wt-tt-row">
          <span class="wt-tt-dot" :style="{background:UCH[i]}"></span>
          <span class="wt-tt-lbl">{{u.u}}</span>
          <span class="wt-tt-val" :style="{color:UCH[i]}">{{fmt(u.qty)}}/{{u.cap>0?fmt(u.cap):'∞'}}</span>
        </div>
      </div>
      <div v-else style="font-size:9px;color:var(--wt-text3);margin-top:2px">Empty level</div>
      <div class="wt-tt-bar"><div class="wt-tt-fill" :style="{width:lp+'%',background:clr}"></div></div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: DetailPanel (right slide-in panel)
───────────────────────────────────────────────────────────── */
const DetailPanel = defineComponent({
  name: 'DetailPanel',
  setup(){
    return { store, UCH, fmt, FCH, fmtK, lvFill, lvKey, actions };
  },
  computed:{
    d(){ return this.store.dpData; },
    lp(){ return this.d?lvFill(this.d.lv):0; },
    hs(){ return this.d?(this.d.lv.uoms||[]).some(u=>u.qty>0):false; },
  },
  template: `
    <div id="wt-dp" :class="store.dpOpen?'open':''">
      <button id="wt-dp-x" @click="actions.closeDP()">✕</button>
      <template v-if="d">
        <div class="wt-dp-title">{{d.slot.label}} — {{d.lv.label}}</div>
        <div class="wt-dp-sub">{{d.lv.wh}} · {{lp}}% · {{hs?'In stock':'Empty'}}</div>

        <span class="wt-dp-sec">UOM fill</span>
        <div v-if="!d.lv.uoms?.length" style="font-size:10px;color:rgba(255,255,255,.3);margin-bottom:8px">No UOMs configured</div>
        <div v-for="(u,ui) in (d.lv.uoms||[])" :key="ui" class="wt-urow" style="margin-bottom:6px">
          <div class="wt-ulbl">{{u.u}}</div>
          <div class="wt-utrack"><div class="wt-ufill" :style="{width:(u.cap>0?Math.min(100,Math.round(u.qty/u.cap*100)):100)+'%',background:UCH[ui]}"></div></div>
          <div class="wt-uval">{{fmt(u.qty)}}/<input v-if="store.canEdit" class="wt-ucap-inp" type="number" :value="u.cap" min="0"
            @change="actions.updateCap(d.slot.wh, d.lv.wh, ui, $event.target.value)"/><span v-else>{{u.cap>0?fmt(u.cap):'∞'}}</span></div>
        </div>

        <div class="wt-divider"></div>
        <span class="wt-dp-items-lbl">Items in level</span>
        <div v-if="!d.lv.items?.length" style="font-size:10px;color:rgba(255,255,255,.3)">No stock</div>
        <div v-for="it in (d.lv.items||[])" :key="it.c" class="wt-dp-item">
          <div>
            <div class="wt-dp-icode">{{it.c}}</div>
            <div class="wt-dp-imeta">{{it.n}} · {{it.u}}</div>
          </div>
          <div class="wt-dp-iqty">{{fmt(it.a)}}</div>
        </div>

        <div class="wt-divider"></div>
        <span class="wt-dp-sec">All levels — {{d.slot.label}}</span>
        <div v-for="lv2 in d.slot.levels" :key="lv2.wh"
          :class="['wt-dp-lv', lvKey(d.slot,lv2)===store.selKey?'sel':'']"
          @click="actions.clickLv(d.slot.wh, lv2.wh)">
          <div class="wt-dp-lv-hdr">
            <div class="wt-dp-lv-name">{{lv2.label}} — {{lv2.wh}}</div>
            <div class="wt-dp-lv-pct"
              :style="{color:(lv2.uoms||[]).some(u=>u.qty>0)?FCH(lvFill(lv2)):'rgba(255,255,255,.2)'}">
              {{(lv2.uoms||[]).some(u=>u.qty>0)?lvFill(lv2)+'%':'Empty'}}
            </div>
          </div>
          <div v-for="(u,ui) in (lv2.uoms||[])" :key="ui" class="wt-urow">
            <div class="wt-ulbl">{{u.u}}</div>
            <div class="wt-utrack">
              <div class="wt-ufill" :style="{width:(u.cap>0?Math.min(100,Math.round(u.qty/u.cap*100)):100)+'%',background:UCH[ui]}"></div>
            </div>
            <div class="wt-uval">{{fmt(u.qty)}}/{{u.cap>0?fmt(u.cap):'∞'}}</div>
          </div>
        </div>

        <button v-if="store.canEdit" class="wt-cfg-btn" @click="actions.openCfg(d.slot.wh)">⚙ Configure stack levels</button>
      </template>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: ItemModal (light popup with level tabs)
───────────────────────────────────────────────────────────── */
const ItemModal = defineComponent({
  name: 'ItemModal',
  setup(){
    return { store, fmt, fmtK, actions, lvFill };
  },
  computed:{
    d(){ return this.store.imData; },
    sl(){ return this.d?.slot; },
    lv(){ return this.d?.lv; },
    items(){ return this.d?.lv?.items||[]; },
    totalQty(){ return this.items.reduce((s,it)=>s+(parseFloat(it.a)||0),0); },
    totalVal(){ return this.items.reduce((s,it)=>s+(parseFloat(it.stock_value)||(parseFloat(it.a||0)*180)),0); },
    showTabs(){ return this.sl && this.sl.levels.length>1 && this.store.imKeepTabs; },
  },
  template: `
    <div id="wt-im-ov" :class="store.imOpen?'open':''" @click.self="actions.closeItemModal()">
      <div id="wt-im">
        <div id="wt-im-hdr">
          <div style="flex:1;min-width:0">
            <div id="wt-im-title">{{sl?.label}} — {{lv?.label}}</div>
            <div id="wt-im-sub" v-if="lv">{{lv.wh}} · Actual Qty: {{fmt(lv.uoms?.reduce((s,u)=>s+(u.qty||0),0)||0)}}</div>
            <div id="wt-im-lvtabs" v-if="showTabs">
              <button v-for="tab in sl.levels" :key="tab.wh"
                :class="['wt-im-lvtab', tab.wh===lv.wh?'active':'']"
                @click="actions.switchModalLevel(sl.wh, tab.wh)">{{tab.label}}</button>
            </div>
          </div>
          <button class="wt-im-x" @click="actions.closeItemModal()">✕</button>
        </div>
        <div id="wt-im-body" v-if="d">
          <div class="wt-im-stats">
            <div class="wt-im-stat">
              <div class="wt-im-stat-lbl">ITEMS</div>
              <div class="wt-im-stat-val">{{items.length}}</div>
            </div>
            <div class="wt-im-stat">
              <div class="wt-im-stat-lbl">TOTAL QTY</div>
              <div class="wt-im-stat-val blue">{{fmt(totalQty)}}</div>
            </div>
            <div class="wt-im-stat">
              <div class="wt-im-stat-lbl">STOCK VALUE</div>
              <div class="wt-im-stat-val green">₹{{Math.round(totalVal).toLocaleString('en-IN')}}</div>
            </div>
          </div>
          <div class="wt-im-tbl-wrap">
            <table id="wt-im-tbl">
              <thead><tr>
                <th style="color:#718096;width:28px">#</th>
                <th>Item Code</th><th>Item Name</th><th>Group</th><th>UOM</th>
                <th>Actual</th><th>Reserved</th><th>Available</th>
                <th>Rate ₹</th><th>Value ₹</th>
              </tr></thead>
              <tbody>
                <tr v-if="!items.length">
                  <td colspan="10" class="wt-im-empty">No items with stock in this level</td>
                </tr>
                <tr v-for="(it,i) in items" :key="it.c">
                  <td class="wt-im-idx">{{i+1}}</td>
                  <td><a class="wt-im-icode" :href="'/app/item/'+encodeURIComponent(it.c)" target="_blank">{{it.c}}</a></td>
                  <td class="wt-im-iname" :title="it.n||''">{{it.n||''}}</td>
                  <td class="wt-im-grp" :title="it.g||''">{{it.g||'—'}}</td>
                  <td><span class="wt-im-uom">{{it.u||''}}</span></td>
                  <td class="wt-im-qty">{{fmt(it.a)}}</td>
                  <td :class="(it.r>0)?'wt-im-res':'wt-im-dim'">{{it.r>0?fmt(it.r):'—'}}</td>
                  <td :class="((parseFloat(it.a)||0)-(parseFloat(it.r)||0)>0)?'wt-im-avl':'wt-im-dim'">{{fmt((parseFloat(it.a)||0)-(parseFloat(it.r)||0))}}</td>
                  <td style="color:#718096">{{(parseFloat(it.rate)||0)>0?fmt(it.rate):'—'}}</td>
                  <td class="wt-im-val">{{(parseFloat(it.stock_value)||0)>0?Math.round(parseFloat(it.stock_value)).toLocaleString('en-IN'):'—'}}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: ConfigModal
───────────────────────────────────────────────────────────── */
const ConfigModal = defineComponent({
  name: 'ConfigModal',
  setup(){
    const labelVal = ref('');
    watch(()=>store.cfgSlot, s=>{ labelVal.value=s?.label||''; });
    return { store, actions, lvFill, FCH, labelVal };
  },
  template: `
    <div id="wt-cfg-ov" :class="store.cfgOpen?'open':''" @click.self="actions.closeCfg()">
      <div id="wt-cfg-modal">
        <div class="wt-cfg-hdr">
          <div class="wt-cfg-hdr-title">{{store.cfgSlot?'Configure: '+store.cfgSlot.label:'Select slot'}}</div>
          <button class="wt-x-btn" @click="actions.closeCfg()">✕</button>
        </div>
        <div class="wt-cfg-body">
          <template v-if="!store.cfgSlot">
            <span class="wt-cfg-slabel">Select a slot to configure</span>
            <div v-for="sl in store.slots" :key="sl.wh" class="wt-slot-pick" @click="actions.openCfg(sl.wh)">
              <div class="wt-slot-pick-name">{{sl.label}}</div>
              <div class="wt-slot-pick-meta">{{sl.levels.length}} levels</div>
            </div>
          </template>
          <template v-else>
            <span class="wt-cfg-slabel">Stack preview ({{store.cfgLvs.length}} levels)</span>
            <div class="wt-cfg-preview">
              <div v-for="lv in store.cfgLvs" :key="lv.wh" style="flex:1;display:flex;align-items:flex-end;height:100%">
                <div class="wt-cfg-pv-lv"
                  :style="{width:'100%',height:Math.max(10,Math.round((lvFill(lv)/100)*38))+'px',background:(lv.uoms||[]).some(u=>u.qty>0)?FCH(lvFill(lv)):'rgba(255,255,255,.07)'}"
                  :title="lv.label"></div>
              </div>
            </div>
            <span class="wt-cfg-slabel">Levels</span>
            <div v-for="(lv,i) in store.cfgLvs" :key="lv.wh" class="wt-cfg-lv-row">
              <div>
                <div class="wt-cfg-lv-name">{{lv.label}}</div>
                <div class="wt-cfg-lv-wh">{{lv.wh}}</div>
              </div>
              <button class="wt-del-btn" @click="actions.delLv(i)">✕</button>
            </div>
            <button class="wt-cfg-add-btn" @click="actions.addLv()">+ Add level</button>
            <div class="wt-cfg-field">
              <label>Slot label</label>
              <input v-model="labelVal"/>
            </div>
          </template>
        </div>
        <div class="wt-cfg-footer">
          <button class="wt-btn-cancel" @click="actions.closeCfg()">Cancel</button>
          <button class="wt-btn-save" @click="actions.saveCfg(labelVal)">Save</button>
        </div>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: FloorPlanModal
───────────────────────────────────────────────────────────── */
const FloorPlanModal = defineComponent({
  name: 'FloorPlanModal',
  setup(){
    function shortName(wh){ return wh.replace(/\s*-\s*[A-Z]{2,6}$/,'').split('/').pop().trim(); }
    return { store, actions, shortName };
  },
  template: `
    <div id="wt-fp-ov" :class="store.fpOpen?'open':''" @click.self="actions.fpClose()">
      <div id="wt-fp-modal">
        <div id="wt-fp-hdr">
          <div>
            <div id="wt-fp-title">Floor Plan — {{store.fpGroup?.name}}</div>
            <div id="wt-fp-subtitle">{{store.fpAllSlots.length}} slot warehouses available</div>
          </div>
          <button class="wt-x-btn" @click="actions.fpClose()">✕</button>
        </div>
        <div id="wt-fp-body">
          <div class="wt-fp-save-ok" :class="store.fpSaveOk?'show':''">✓ Layout saved! Reload 3D view to see changes.</div>
          <!-- Preview -->
          <div class="wt-fp-preview-wrap">
            <div class="wt-fp-preview-lbl">Layout preview</div>
            <div class="wt-fp-preview">
              <div v-if="!store.fpRows.length" style="font-size:10px;color:rgba(255,255,255,.2);text-align:center;padding:8px">No rows yet</div>
              <div v-for="row in store.fpRows" :key="row.label" class="wt-fp-prev-row">
                <div v-for="cell in row.cells" :key="cell.wh||Math.random()"
                  :class="['wt-fp-prev-cell', cell.aisle?'aisle':cell.wh?'filled':'empty']"
                  :style="{flex:cell.span}">
                  {{cell.aisle?'▥':cell.wh?shortName(cell.wh):'·'}}
                </div>
              </div>
            </div>
          </div>
          <!-- Rows -->
          <div v-for="(row, ri) in store.fpRows" :key="ri" class="wt-fp-row-wrap">
            <div class="wt-fp-row-hdr">
              <div class="wt-fp-row-lbl">
                <input :value="row.label" placeholder="Row label" @change="actions.fpSetRowLabel(ri,$event.target.value)"/>
              </div>
              <div class="wt-fp-gap-ctrl">
                <span class="wt-fp-gap-lbl">Row gap</span>
                <input type="range" class="wt-fp-gap-slider" min="0" max="5" step="0.5"
                  :value="row.gap||0" @input="actions.fpSetRowGap(ri,$event.target.value)"/>
                <span class="wt-fp-gap-val">{{row.gap||0}}</span>
              </div>
              <button class="wt-fp-row-del" @click="actions.fpDelRow(ri)">✕</button>
            </div>
            <div class="wt-fp-cells">
              <div v-for="(cell, ci) in row.cells" :key="ci"
                :class="['wt-fp-cell', cell.wh?'assigned':'', cell.aisle?'is-aisle':'']">
                <div class="wt-fp-cell-top">
                  <span class="wt-fp-cell-lbl">Col {{ci+1}} · span</span>
                  <select class="wt-fp-span-sel" @change="actions.fpSetCellSpan(ri,ci,$event.target.value)">
                    <option v-for="s in [1,2,3,4]" :key="s" :selected="cell.span===s">{{s}}</option>
                  </select>
                  <button class="wt-fp-cell-del" @click="actions.fpDelCell(ri,ci)">✕</button>
                </div>
                <div v-if="cell.aisle" style="text-align:center;font-size:9px;color:rgba(255,255,255,.25);padding:4px">Aisle / gap</div>
                <select v-else class="wt-fp-wh-sel" @change="actions.fpSetCellWh(ri,ci,$event.target.value)">
                  <option value="">— unassigned —</option>
                  <option v-for="sl in store.fpAllSlots" :key="sl.wh" :value="sl.wh" :selected="cell.wh===sl.wh">
                    {{shortName(sl.wh)}}
                  </option>
                </select>
                <label class="wt-fp-aisle-chk">
                  <input type="checkbox" :checked="cell.aisle" @change="actions.fpSetCellAisle(ri,ci,$event.target.checked)"/>
                  Aisle
                </label>
              </div>
              <button class="wt-fp-add-cell" @click="actions.fpAddCell(ri)">+ Cell</button>
            </div>
            <div :class="['wt-fp-row-gap-line', (row.gap||0)>0?'has-gap':'']"
              :style="{height:(row.gap||0)>0?Math.round((row.gap||0)*8)+'px':'0px'}">
              <span v-if="(row.gap||0)>0" class="wt-fp-gap-line-lbl">↕ {{row.gap}} unit gap</span>
            </div>
          </div>
          <button class="wt-fp-add-row" @click="actions.fpAddRow()">+ Add row</button>
        </div>
        <div id="wt-fp-footer">
          <div id="wt-fp-footer-left">Drag rows to reorder • Assign slot warehouses to cells</div>
          <div id="wt-fp-footer-right">
            <button class="wt-btn-cancel" @click="actions.fpClose()">Cancel</button>
            <button class="wt-btn-save" :disabled="store.fpSaving" @click="actions.fpSave()">
              {{store.fpSaving?'Saving…':'Save layout'}}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: View2D
───────────────────────────────────────────────────────────── */
const View2D = defineComponent({
  name: 'View2D',
  setup(){
    const sections = computed(()=>{
      const slots=filteredSlots();
      const secMap={}, secOrder=[];
      slots.forEach(sl=>{
        const nm=(sl.label||sl.wh).replace(/\s*-\s*[A-Z]{1,8}$/,'').split('/').pop().trim();
        const key=nm.match(/^([A-Za-z]+)/)?.[1]||nm.substring(0,2);
        if(!secMap[key]){secMap[key]=[];secOrder.push(key);}
        secMap[key].push({...sl,shortName:nm});
      });
      secOrder.sort((a,b)=>a.localeCompare(b));
      secOrder.forEach(key=>{if(secMap[key])secMap[key].sort((a,b)=>a.shortName.localeCompare(b.shortName));});
      return secOrder.map(key=>{
        const tiles=secMap[key];
        const cols=tiles.length<=1?1:tiles.length<=4?2:3;
        const occ=tiles.filter(s=>hasStock(s)).length;
        const pct=tiles.length?Math.round((occ/tiles.length)*100):0;
        const cntCls=pct>=80?'red':pct>=50?'org':'grn';
        const avgFp=tiles.length?Math.round(tiles.reduce((s,t)=>s+slotFill(t),0)/tiles.length):0;
        const barClr=avgFp>0?FCH(avgFp):'var(--wt-border)';
        return {key,tiles,cols,occ,cntCls,avgFp,barClr};
      });
    });

    function tileCls(sl){
      const fp=slotFill(sl), hs=hasStock(sl);
      return !hs?'empty':fp>=90?'full':fp>=70?'high':fp>=40?'mid':'low';
    }
    function tileQty(sl){ return sl.levels.reduce((s,l)=>(l.uoms||[]).reduce((ss,u)=>ss+(u.qty||0),s),0); }
    function lvColor(lv){ const q=(lv.uoms||[]).reduce((s,u)=>s+(u.qty||0),0); return q>0?FCH(lvFill(lv)):'var(--wt-border)'; }
    function lvQty(lv){ return (lv.uoms||[]).reduce((s,u)=>s+(u.qty||0),0); }

    return { store, sections, tileCls, tileQty, lvColor, lvQty, actions, fmtK, fmt, FCH, slotFill, hasStock };
  },
  template: `
    <div id="wt-view2d" :style="{display:store.curView==='2d'?'block':'none'}">
      <div class="wt-2d-wrap">
        <template v-if="sections.length">
          <div v-for="sec in sections" :key="sec.key" class="wt-2d-sec">
            <div class="wt-2d-sec-hdr">
              <div class="wt-2d-sec-name">{{sec.key}}</div>
              <div :class="['wt-2d-sec-cnt', sec.cntCls]">{{sec.occ}}/{{sec.tiles.length}}</div>
            </div>
            <div class="wt-2d-sec-cap">
              <div class="wt-2d-sec-cap-fill" :style="{width:sec.avgFp+'%',background:sec.barClr}"></div>
            </div>
            <div class="wt-2d-slots" :style="{'grid-template-columns':'repeat('+sec.cols+',1fr)'}">
              <div v-for="(sl,ti) in sec.tiles" :key="sl.wh"
                :class="['wt-2d-tile', tileCls(sl)]"
                :style="{'animation-delay':ti*30+'ms'}"
                :title="sl.wh+(tileQty(sl)>0?'\\nQty: '+fmt(tileQty(sl)):'\\nEmpty')"
                @click="actions.open2DModal(sl.wh)">
                <div class="wt-2d-tile-name">{{sl.shortName}}</div>
                <div class="wt-2d-tile-qty">{{tileQty(sl)>0?fmtK(tileQty(sl)):'—'}}</div>
                <div v-if="sl.levels && sl.levels.length>1" class="wt-2d-levels">
                  <div v-for="lv in [...sl.levels].reverse()" :key="lv.wh"
                    class="wt-2d-lv-row"
                    @click.stop="actions.open2DModalLevel(sl.wh, lv.wh)">
                    <div class="wt-2d-lv-dot" :style="{background:lvColor(lv)}"></div>
                    <div class="wt-2d-lv-name">{{lv.label.split('/').pop()}}</div>
                    <div class="wt-2d-lv-qty" :style="{color:lvQty(lv)>0?lvColor(lv):'var(--wt-text3)'}">
                      {{lvQty(lv)>0?fmtK(lvQty(lv)):'—'}}
                    </div>
                  </div>
                </div>
                <div class="wt-2d-tile-bar" :style="{background:hasStock(sl)?FCH(slotFill(sl)):'transparent'}"></div>
              </div>
            </div>
          </div>
        </template>
        <div v-else style="padding:32px;color:var(--wt-text3);font-size:13px">
          <span v-if="store.searchQuery">No warehouses found with stock for "<b style="color:var(--wt-text2)">{{store.searchQuery}}</b>"</span>
          <span v-else>No slots to display</span>
        </div>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: View3D  (Three.js canvas + event wiring)
───────────────────────────────────────────────────────────── */
const View3D = defineComponent({
  name: 'View3D',
  setup(){
    onMounted(()=>{
      const canvas=document.getElementById('wt-c');
      const cwEl=document.getElementById('wt-cw');
      engine.init(canvas, cwEl);
      engine.bindMouse(cwEl,
        // hover
        (d, x, y)=>{
          if (!d){ store.ttVisible=false; return; }
          store.ttVisible=true;
          store.ttData=d;
          const tw=180;
          store.ttX=x+tw>cwEl.clientWidth?x-tw-12:x+12;
          store.ttY=y>160?y-110:y+10;
        },
        // click — single: highlight + side panel only | double: open full item modal
        (d, wasSel, isDouble)=>{
          if (isDouble) {
            // Double click → open full item modal
            engine.highlight(lvKey(d.slot,d.lv));
            actions.openDP(d);
            actions.openItemModal(d);
          } else {
            // Single click → highlight + side panel only
            engine.highlight(wasSel?null:lvKey(d.slot,d.lv));
            if (wasSel){ actions.closeDP(); }
            else { actions.openDP(d); actions.closeItemModal(); }
          }
        }
      );
    });
    let moveInterval = null;
    function startMove(dir) {
      stopMove();
      const move = () => {
        if (dir==='fwd')   engine.moveAisle(1,0,0,0);
        if (dir==='back')  engine.moveAisle(-1,0,0,0);
        if (dir==='left')  engine.moveAisle(0,-1,0,0);
        if (dir==='right') engine.moveAisle(0,1,0,0);
      };
      move();
      moveInterval = setInterval(move, 80);
    }
    function stopMove() {
      if (moveInterval) { clearInterval(moveInterval); moveInterval=null; }
    }
    return { store, engine, startMove, stopMove };
  },
  template: `
    <div id="wt-cw" :style="{display:store.curView==='3d'?'block':'none'}">
      <canvas id="wt-c"></canvas>
      <div id="wt-aisle-ctrl" :class="store.aisleMode?'show':''">
        <div id="wt-aisle-hint">Drag to look · WASD or buttons to move</div>
        <div class="wt-aisle-pad">
          <div class="wt-aisle-key empty"></div>
          <div class="wt-aisle-key"
            @mousedown="startMove('fwd')" @mouseup="stopMove()" @mouseleave="stopMove()"
            @touchstart.prevent="startMove('fwd')" @touchend.prevent="stopMove()">▲</div>
          <div class="wt-aisle-key empty"></div>
          <div class="wt-aisle-key"
            @mousedown="startMove('left')" @mouseup="stopMove()" @mouseleave="stopMove()"
            @touchstart.prevent="startMove('left')" @touchend.prevent="stopMove()">◄</div>
          <div class="wt-aisle-key"
            @mousedown="startMove('back')" @mouseup="stopMove()" @mouseleave="stopMove()"
            @touchstart.prevent="startMove('back')" @touchend.prevent="stopMove()">▼</div>
          <div class="wt-aisle-key"
            @mousedown="startMove('right')" @mouseup="stopMove()" @mouseleave="stopMove()"
            @touchstart.prevent="startMove('right')" @touchend.prevent="stopMove()">►</div>
        </div>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: Loading Overlay
───────────────────────────────────────────────────────────── */
const Loading = defineComponent({
  name: 'Loading',
  setup(){ return {store}; },
  template: `
    <div class="wt-loading" v-if="store.loading">
      <div class="wt-spinner"></div>
      <div class="wt-loading-text">Loading warehouse data…</div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: AislePicker
───────────────────────────────────────────────────────────── */
const AislePicker = defineComponent({
  name: 'AislePicker',
  setup(){ return { store, actions }; },
  template: `
    <div id="wt-aisle-picker" v-if="store.aislePickerOpen" @click.self="store.aislePickerOpen=false">
      <div id="wt-aisle-picker-box">
        <div class="wt-aisle-picker-title">👁 Choose an Aisle</div>
        <div class="wt-aisle-picker-sub">Select which aisle gap to walk through</div>
        <button v-for="(gap, i) in store.aisleGaps" :key="i"
          class="wt-aisle-gap-btn"
          @click="actions.enterAisleGap(i)">
          <span class="wt-aisle-gap-icon">🚶</span>
          {{gap.label}}
        </button>
        <button class="wt-aisle-cancel" @click="store.aislePickerOpen=false">Cancel</button>
      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   COMPONENT: SetupWizard
   Scans the customer's existing Warehouse parent_warehouse tree
   by depth (no relabeling) and lets a System Manager assign a
   Building/Floor/Slot/Bin role per depth level.
───────────────────────────────────────────────────────────── */
const SetupWizard = defineComponent({
  name: 'SetupWizard',
  setup(){
    onMounted(()=>{ if (!store.setupScan) actions.runScan(); });
    const roleIcon = { Building:'🏢', Floor:'🗂️', Slot:'📦', Bin:'🧱' };
    return { store, actions, roleIcon };
  },
  template: `
    <div id="wt-setup">
      <div id="wt-setup-card">

        <div class="wt-setup-steps">
          <div class="wt-setup-step">
            <div :class="['wt-setup-dot', store.setupStep>1?'done':'active']">{{store.setupStep>1?'✓':'1'}}</div>
            <span class="wt-setup-label">Scan</span>
          </div>
          <div :class="['wt-setup-line', store.setupStep>1?'done':'']"></div>
          <div class="wt-setup-step">
            <div :class="['wt-setup-dot', store.setupStep>2?'done':(store.setupStep===2?'active':'todo')]">{{store.setupStep>2?'✓':'2'}}</div>
            <span class="wt-setup-label">Map levels</span>
          </div>
          <div :class="['wt-setup-line', store.setupStep>2?'done':'']"></div>
          <div class="wt-setup-step">
            <div :class="['wt-setup-dot', store.setupStep===3?'active':'todo']">3</div>
            <span class="wt-setup-label">Done</span>
          </div>
        </div>

        <template v-if="store.loading && !store.setupScan">
          <div class="wt-setup-empty">
            <div class="wt-setup-empty-icon">⏳</div>
            <div class="wt-setup-h3">Scanning your warehouses…</div>
            <div class="wt-setup-sub">Reading your existing warehouse tree. Nothing is changed yet.</div>
          </div>
        </template>

        <template v-else-if="store.setupScan && !store.setupScan.depths.length">
          <div class="wt-setup-empty">
            <div class="wt-setup-empty-icon">📭</div>
            <div class="wt-setup-h3">No warehouses found</div>
            <div class="wt-setup-sub">Create at least one Warehouse in Stock settings, then come back here.</div>
          </div>
        </template>

        <template v-else-if="store.setupStep===2 && store.setupScan">
          <div class="wt-setup-h3">Map your warehouse hierarchy</div>
          <div class="wt-setup-sub">We found your existing warehouse tree below. Assign a role to each depth — no warehouses will be renamed or moved.</div>
          <div class="wt-setup-hint">
            <span>ℹ️</span>
            <span>Pick the levels that represent physical storage. Choose "Skip level" for any depth that doesn't apply — for example a level used only for accounting grouping.</span>
          </div>

          <div v-for="d in store.setupScan.depths" :key="d.depth" class="wt-setup-row" :style="{marginLeft:(Math.min(d.depth-1,4)*16)+'px'}">
            <div class="wt-setup-icon">{{roleIcon[store.setupMapping[d.depth]] || '➖'}}</div>
            <div class="wt-setup-info">
              <div class="wt-setup-name">{{d.sample_names.slice(0,3).join(', ')}}<span v-if="d.count>3">…</span></div>
              <div class="wt-setup-meta">depth {{d.depth}} · {{d.count}} warehouse{{d.count===1?'':'s'}}{{d.is_leaf?' · leaf nodes':''}}</div>
            </div>
            <select class="wt-setup-select"
              :value="store.setupMapping[d.depth] || 'Skip'"
              @change="actions.setMappingRole(d.depth, $event.target.value)">
              <option value="Building">Building</option>
              <option value="Floor">Floor</option>
              <option value="Slot">Slot</option>
              <option value="Bin">Bin</option>
              <option value="Skip">Skip level</option>
            </select>
          </div>

          <div class="wt-setup-actions">
            <span></span>
            <button class="wt-setup-btn wt-setup-btn-primary" :disabled="store.setupSaving" @click="actions.confirmMapping()">
              {{store.setupSaving?'Saving…':'Continue →'}}
            </button>
          </div>
        </template>

        <template v-else-if="store.setupStep===3">
          <div class="wt-setup-h3">You're all set</div>
          <div class="wt-setup-sub">Your warehouse hierarchy has been mapped. Here's what we configured:</div>

          <div class="wt-setup-summary-grid">
            <div class="wt-setup-stat">
              <div class="wt-setup-stat-val">{{store.setupSummary?.Building || 0}}</div>
              <div class="wt-setup-stat-lbl">Buildings</div>
            </div>
            <div class="wt-setup-stat">
              <div class="wt-setup-stat-val">{{store.setupSummary?.Floor || 0}}</div>
              <div class="wt-setup-stat-lbl">Floors</div>
            </div>
            <div class="wt-setup-stat">
              <div class="wt-setup-stat-val">{{store.setupSummary?.Slot || 0}}</div>
              <div class="wt-setup-stat-lbl">Slots</div>
            </div>
            <div class="wt-setup-stat">
              <div class="wt-setup-stat-val">{{store.setupSummary?.Bin || 0}}</div>
              <div class="wt-setup-stat-lbl">Bins</div>
            </div>
          </div>

          <div class="wt-setup-hint">
            <span>💡</span>
            <span>You can fine-tune slot positions any time from "Edit floor plan", and configure per-UOM capacity from "Configure slot" in the sidebar.</span>
          </div>

          <div class="wt-setup-actions">
            <span></span>
            <button class="wt-setup-btn wt-setup-btn-primary" @click="actions.finishSetup()">Open Warehouse Theatre 3D →</button>
          </div>
        </template>

      </div>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   ROOT APP COMPONENT
───────────────────────────────────────────────────────────── */
const App = defineComponent({
  name: 'WarehouseTheatreVue',
  components: { Sidebar, TopBar, BottomBar, Tooltip, DetailPanel, ItemModal, ConfigModal, FloorPlanModal, View3D, View2D, Loading, AislePicker, SetupWizard },
  setup(){
    onMounted(async ()=>{
      // Keyboard shortcuts
      document.addEventListener('keydown', e=>{
        if (e.key==='Escape'){
          actions.closeDP();
          actions.closeCfg();
          actions.closeItemModal();
          actions.fpClose();
          actions.clearSearch();
          store.sidebarOpen=false;
        }
      });
      await actions.checkSetup();
      if (store.setupComplete) {
        await actions.loadGroups();
      }
    });
    return { store };
  },
  template: `
    <div id="wt-app" :class="store.isDark?'dark':'light'">
      <template v-if="store.setupChecking">
        <div class="wt-loading" style="position:relative;height:100%">
          <div class="wt-spinner"></div>
          <div class="wt-loading-text">Loading Warehouse Theatre 3D…</div>
        </div>
      </template>
      <template v-else-if="!store.setupComplete">
        <SetupWizard/>
      </template>
      <template v-else>
        <Sidebar/>
        <View3D/>
        <View2D/>
        <TopBar/>
        <BottomBar/>
        <Tooltip/>
        <DetailPanel/>
        <ItemModal/>
        <ConfigModal/>
        <FloorPlanModal/>
        <AislePicker/>
        <Loading/>
      </template>
    </div>
  `,
});

/* ─────────────────────────────────────────────────────────────
   PUBLIC API  (same interface as wt-app.js)
───────────────────────────────────────────────────────────── */
window.WarehouseTheatre3D = {
  init(mountId) {
    // Inject CSS once
    if (!document.getElementById('wt-style')) {
      const style = document.createElement('style');
      style.id = 'wt-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    // Mount Vue app
    setTimeout(()=>{
      const app = createApp(App);
      app.mount('#'+mountId);
    }, 80);
  }
};

})();
