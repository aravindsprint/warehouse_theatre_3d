/* Warehouse Theatre 3D — shared UI for feature modules.
   Provides core.ui: Dialog, Panel, ItemPicker components, map beacons,
   and "pick a bin on the map" mode. Load this before the other feature files. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, bus, engine, addCSS } = core;
  const { defineComponent, reactive, ref, watch, onUnmounted } = Vue;

  addCSS('wtf-ui-style', `
.wtf-ov{position:absolute;inset:0;background:rgba(0,0,0,.55);z-index:96;display:flex;align-items:center;justify-content:center;padding:12px}
.wtf-dlg{background:var(--wt-bg2);color:var(--wt-text);border:1px solid var(--wt-border);border-radius:12px;max-width:100%;max-height:88%;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden;animation:wtCfgIn .2s cubic-bezier(.34,1.56,.64,1)}
.wtf-hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid var(--wt-border);flex-shrink:0}
.wtf-title{font-size:13px;font-weight:800;color:var(--wt-text)}
.wtf-sub{font-size:10px;color:var(--wt-text3);margin-top:2px;line-height:1.4}
.wtf-x{width:24px;height:24px;border-radius:6px;border:1px solid var(--wt-border);background:var(--wt-card);color:var(--wt-text2);cursor:pointer;font-size:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0}
.wtf-x:hover{color:var(--wt-text);border-color:var(--wt-accent)}
.wtf-body{padding:12px 14px;overflow-y:auto;flex:1;min-height:0}
.wtf-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--wt-border);flex-shrink:0}
.wtf-panel{position:absolute;left:158px;top:82px;bottom:56px;width:320px;max-width:calc(100% - 170px);z-index:19;background:var(--wt-bg2);color:var(--wt-text);border:1px solid var(--wt-border);border-radius:12px;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.35);overflow:hidden;animation:wtfPanelIn .22s cubic-bezier(.34,1.56,.64,1)}
@keyframes wtfPanelIn{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}
@media(max-width:600px){
  .wtf-panel{left:8px;right:8px;width:auto;max-width:none;top:auto;bottom:8px;max-height:58%}
  #wt-app .wtf-pop,#wt-app .wtf-pick-banner{top:calc(var(--wt-top-h, 80px) + 40px)}
}
.wtf-btn{height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--wt-border);background:var(--wt-card);color:var(--wt-text2);font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;line-height:1;white-space:nowrap}
.wtf-btn:hover{color:var(--wt-text);border-color:var(--wt-accent)}
.wtf-btn:disabled{opacity:.5;cursor:not-allowed}
.wtf-btn:focus-visible,.wtf-inp:focus-visible{outline:2px solid var(--wt-accent);outline-offset:1px}
.wtf-btn-pri{background:var(--wt-accent);border-color:var(--wt-accent);color:#fff}
.wtf-btn-pri:hover{background:#2563eb;color:#fff}
.wtf-btn-sm{height:24px;padding:0 8px;font-size:10px}
.wtf-btn-block{width:100%}
.wtf-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.wtf-field>label,.wtf-lbl{font-size:10px;font-weight:700;color:var(--wt-text2)}
.wtf-inp{height:30px;padding:0 9px;border-radius:7px;border:1px solid var(--wt-border);background:var(--wt-card);color:var(--wt-text);font-size:11px;outline:none;width:100%;min-width:0}
.wtf-inp:focus{border-color:var(--wt-accent)}
select.wtf-inp{padding:0 5px}
#wt-app.dark select.wtf-inp option{background:#13151e}
.wtf-row{display:flex;gap:8px;align-items:center}
.wtf-row>*{flex:1;min-width:0}
.wtf-muted{font-size:10px;color:var(--wt-text3);line-height:1.5}
.wtf-err{font-size:11px;color:#f87171;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);border-radius:7px;padding:7px 9px;margin-bottom:10px;line-height:1.4}
.wtf-ok{font-size:11px;color:#4ade80;background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.3);border-radius:7px;padding:8px 10px;margin-bottom:10px;line-height:1.5}
.wtf-ok a,.wtf-link{color:var(--wt-accent2);font-weight:700}
.wtf-sec{font-size:8px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--wt-text3);margin:12px 0 6px}
.wtf-sec:first-child{margin-top:0}
.wtf-card{background:var(--wt-card);border:1px solid var(--wt-cb);border-radius:8px;padding:8px 9px;margin-bottom:6px}
.wtf-card.clickable{cursor:pointer}
.wtf-card.clickable:hover{border-color:var(--wt-accent)}
.wtf-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-bottom:8px}
.wtf-stat{background:var(--wt-card);border:1px solid var(--wt-cb);border-radius:8px;padding:7px 9px}
.wtf-stat-l{font-size:8px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--wt-text3)}
.wtf-stat-v{font-size:16px;font-weight:800;color:var(--wt-text);margin-top:2px;font-variant-numeric:tabular-nums}
.wtf-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:10px;font-size:9px;font-weight:700;background:var(--wt-pill);border:1px solid var(--wt-pillb);color:var(--wt-text2)}
.wtf-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;display:inline-block}
.wtf-num{font-variant-numeric:tabular-nums}
.wtf-ac{position:relative}
.wtf-ac-list{position:absolute;left:0;right:0;top:calc(100% + 3px);z-index:5;background:var(--wt-bg2);border:1px solid var(--wt-border);border-radius:8px;box-shadow:0 12px 30px rgba(0,0,0,.35);max-height:220px;overflow-y:auto}
.wtf-ac-opt{padding:7px 9px;cursor:pointer;border-bottom:1px solid var(--wt-border)}
.wtf-ac-opt:last-child{border-bottom:none}
.wtf-ac-opt:hover,.wtf-ac-opt.hl{background:var(--wt-pill)}
.wtf-ac-code{font-size:11px;font-weight:700;color:var(--wt-accent2)}
.wtf-ac-name{font-size:10px;color:var(--wt-text3)}
.wtf-pick-banner{position:absolute;top:84px;left:50%;transform:translateX(-50%);z-index:60;background:#1e3a8a;color:#dbeafe;border:1px solid #3b82f6;border-radius:9px;padding:8px 12px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:10px;box-shadow:0 10px 30px rgba(0,0,0,.4);max-width:calc(100vw - 24px)}
.wtf-pick-banner button{height:24px;padding:0 9px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:10px;font-weight:700;cursor:pointer}
.wtf-spin{width:14px;height:14px;border:2px solid var(--wt-border);border-top-color:var(--wt-accent);border-radius:50%;animation:wtSpin .7s linear infinite;display:inline-block;vertical-align:middle}
.wtf-tbl{width:100%;border-collapse:collapse;font-size:11px}
.wtf-tbl th{font-size:9px;font-weight:800;color:var(--wt-text3);text-align:left;padding:5px 6px;border-bottom:1px solid var(--wt-border);white-space:nowrap}
.wtf-tbl td{padding:5px 6px;border-bottom:1px solid var(--wt-border);color:var(--wt-text2);vertical-align:middle}
.wtf-tbl td.r,.wtf-tbl th.r{text-align:right}
.wtf-pa-tabs{display:flex;gap:4px;margin-bottom:10px;background:var(--wt-card);border:1px solid var(--wt-cb);border-radius:8px;padding:3px}
.wtf-pa-tab{flex:1;height:26px;border:none;border-radius:6px;background:transparent;color:var(--wt-text2);font-size:10px;font-weight:700;cursor:pointer}
.wtf-pa-tab.act{background:var(--wt-accent);color:#fff}
.wtf-pa-tab:focus-visible{outline:2px solid var(--wt-accent);outline-offset:1px}
.wtf-pop{position:absolute;top:80px;z-index:30;background:var(--wt-bg2);color:var(--wt-text);border:1px solid var(--wt-border);border-radius:10px;box-shadow:0 16px 40px rgba(0,0,0,.4);padding:10px;width:250px;max-width:calc(100vw - 16px);animation:wtCfgIn .16s ease}
`);

  /* ── Panel exclusivity: only one left-hand panel / popover open at a time ── */
  const state = reactive({ panel: null, pick: null });
  function openPanel(id) { state.panel = id; }
  function togglePanel(id) { state.panel = state.panel === id ? null : id; }
  function closePanel(id) { if (!id || state.panel === id) state.panel = null; }

  /* ── Components ── */
  const Dialog = defineComponent({
    name: 'WtfDialog',
    props: { title: String, sub: String, width: { type: String, default: '420px' } },
    emits: ['close'],
    template: `
      <div class="wtf-ov" @click.self="$emit('close')" @keydown.esc.stop="$emit('close')">
        <div class="wtf-dlg" role="dialog" aria-modal="true" :aria-label="title" :style="{width}">
          <div class="wtf-hdr">
            <div><div class="wtf-title">{{title}}</div><div v-if="sub" class="wtf-sub">{{sub}}</div></div>
            <button class="wtf-x" @click="$emit('close')" aria-label="Close">✕</button>
          </div>
          <div class="wtf-body"><slot/></div>
          <div class="wtf-foot" v-if="$slots.footer"><slot name="footer"/></div>
        </div>
      </div>`,
  });

  const Panel = defineComponent({
    name: 'WtfPanel',
    props: { title: String, sub: String },
    emits: ['close'],
    template: `
      <div class="wtf-panel" role="region" :aria-label="title">
        <div class="wtf-hdr">
          <div><div class="wtf-title">{{title}}</div><div v-if="sub" class="wtf-sub">{{sub}}</div></div>
          <button class="wtf-x" @click="$emit('close')" aria-label="Close">✕</button>
        </div>
        <div class="wtf-body"><slot/></div>
        <div class="wtf-foot" v-if="$slots.footer"><slot name="footer"/></div>
      </div>`,
  });

  /* Item search box backed by insights.search_items. Emits `pick` with the item row. */
  const ItemPicker = defineComponent({
    name: 'WtfItemPicker',
    props: { placeholder: { type: String, default: 'Item code or name…' }, modelValue: String, autofocus: Boolean },
    emits: ['update:modelValue', 'pick'],
    setup(props, { emit }) {
      const txt = ref(props.modelValue || '');
      const opts = ref([]);
      const open = ref(false);
      const hl = ref(0);
      const busy = ref(false);
      let timer, seq = 0;
      watch(() => props.modelValue, v => { if (v !== undefined && v !== txt.value) txt.value = v || ''; });
      function onInput(e) {
        txt.value = e.target.value;
        emit('update:modelValue', txt.value);
        clearTimeout(timer);
        const q = txt.value.trim();
        if (!q) { opts.value = []; open.value = false; return; }
        timer = setTimeout(async () => {
          const my = ++seq;
          busy.value = true;
          try {
            const r = await core.api('insights', 'search_items', { txt: q });
            if (my !== seq) return;
            opts.value = r || []; hl.value = 0; open.value = true;
          } catch (err) { opts.value = []; }
          finally { if (my === seq) busy.value = false; }
        }, 250);
      }
      function choose(o) {
        txt.value = o.item_code; open.value = false;
        emit('update:modelValue', o.item_code); emit('pick', o);
      }
      function onKey(e) {
        if (!open.value || !opts.value.length) {
          if (e.key === 'Enter' && txt.value.trim()) emit('pick', { item_code: txt.value.trim() });
          return;
        }
        if (e.key === 'ArrowDown') { hl.value = Math.min(opts.value.length - 1, hl.value + 1); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { hl.value = Math.max(0, hl.value - 1); e.preventDefault(); }
        else if (e.key === 'Enter') { choose(opts.value[hl.value]); e.preventDefault(); }
        else if (e.key === 'Escape') { open.value = false; e.stopPropagation(); }
      }
      function onBlur() { setTimeout(() => { open.value = false; }, 150); }
      return { txt, opts, open, hl, busy, onInput, choose, onKey, onBlur };
    },
    template: `
      <div class="wtf-ac">
        <input class="wtf-inp" type="text" :value="txt" :placeholder="placeholder" autocomplete="off"
          :autofocus="autofocus" role="combobox" :aria-expanded="open" aria-autocomplete="list"
          @input="onInput" @keydown="onKey" @blur="onBlur" @focus="opts.length && (open=true)"/>
        <div class="wtf-ac-list" v-if="open" role="listbox">
          <div v-if="!opts.length" class="wtf-ac-opt wtf-muted">No matching items</div>
          <div v-for="(o,i) in opts" :key="o.item_code" role="option" :aria-selected="i===hl"
            :class="['wtf-ac-opt', i===hl?'hl':'']" @mousedown.prevent="choose(o)">
            <div class="wtf-ac-code">{{o.item_code}}</div>
            <div class="wtf-ac-name">{{o.item_name}} · {{o.stock_uom}}</div>
          </div>
        </div>
      </div>`,
  });

  /* ── Pick-a-bin-on-the-map mode ── */
  function startPick(opts) {
    // opts: { prompt, onPick(d), filter?(d), onCancel? }
    state.pick = opts;
    store.dpOpen = false;
    store.imOpen = false;
  }
  function cancelPick() {
    const p = state.pick;
    state.pick = null;
    if (p && p.onCancel) p.onCancel();
  }
  bus.on('level-click', d => {
    const p = state.pick;
    if (!p) return false;
    if (p.filter && !p.filter(d)) { core.alert('That bin can\'t be used here — pick another.', 'orange'); return true; }
    state.pick = null;
    p.onPick(d);
    return true;
  });
  bus.on('escape', () => { if (state.pick) cancelPick(); });

  const PickBanner = defineComponent({
    name: 'WtfPickBanner',
    setup() { return { state, cancelPick }; },
    template: `
      <div v-if="state.pick" class="wtf-pick-banner" role="status">
        <span>🎯 {{state.pick.prompt}}</span>
        <button @click="cancelPick()">Cancel (Esc)</button>
      </div>`,
  });
  core.ext.overlays.push(PickBanner);

  /* ── Map beacons ──
     targets: [{ slot, level (index|null), color (hex number), label (string|number|null) }]
     Beacons for slots that aren't in the current scene (e.g. filtered by search) are skipped. */
  function labelSprite(text, color) {
    const THREE = window.THREE;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    const css = '#' + color.toString(16).padStart(6, '0');
    g.fillStyle = 'rgba(12,14,20,.9)';
    g.strokeStyle = css; g.lineWidth = 5;
    const r = 18;
    g.beginPath();
    g.moveTo(r, 4); g.lineTo(124 - r, 4); g.quadraticCurveTo(124, 4, 124, 4 + r);
    g.lineTo(124, 60 - r); g.quadraticCurveTo(124, 60, 124 - r, 60);
    g.lineTo(r, 60); g.quadraticCurveTo(4, 60, 4, 60 - r);
    g.lineTo(4, 4 + r); g.quadraticCurveTo(4, 4, r, 4); g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 34px -apple-system,Inter,sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(text).slice(0, 6), 64, 34);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(1.3, .65, 1);
    sp.renderOrder = 10;
    return sp;
  }

  function drawBeacons(name, targets) {
    const THREE = window.THREE;
    if (!engine.overlayGrp) return 0;
    const grp = engine.overlay(name);
    let drawn = 0;
    const perSlot = {};
    (targets || []).forEach(t => {
      const p = engine.slotPos[t.slot];
      if (!p) return;
      const stack = perSlot[t.slot] = (perSlot[t.slot] || 0) + 1;
      const color = t.color || 0x22d3ee;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(.09, .09, p.top + 2.4, 12, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .28, depthWrite: false })
      );
      beam.position.set(p.x, (p.top + 2.4) / 2, p.z);
      grp.add(beam);
      const r0 = p.kind === 'zone' ? Math.max(p.halfW, p.halfD) + .15 : 1.25;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r0, r0 + .2, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .75, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, .03, p.z);
      ring.userData.pulse = { base: 1, amp: .18, speed: 3, phase: drawn * .7 };
      grp.add(ring);
      if (t.level !== null && t.level !== undefined && p.levelY[t.level] !== undefined) {
        // Rack: outline the shelf level. Floor zone: outline the whole area up to the pile top.
        const zone = p.kind === 'zone';
        const box = new THREE.Mesh(
          zone ? new THREE.BoxGeometry(p.halfW * 2 + .1, p.top + .1, p.halfD * 2 + .1) : new THREE.BoxGeometry(2.3, .96, 2.3),
          new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: .9 })
        );
        box.position.set(p.x, zone ? (p.top + .1) / 2 : p.levelY[t.level], p.z);
        box.userData.pulse = { base: 1, amp: .04, speed: 4, phase: drawn };
        grp.add(box);
      }
      if (t.label !== null && t.label !== undefined && t.label !== '') {
        const sp = labelSprite(t.label, color);
        sp.position.set(p.x, p.top + 1.1 + (stack - 1) * .75, p.z);
        grp.add(sp);
      }
      drawn++;
    });
    return drawn;
  }

  engine.tickers.push(t => {
    if (!engine.overlayGrp) return;
    engine.overlayGrp.traverse(o => {
      const p = o.userData && o.userData.pulse;
      if (p) o.scale.setScalar(p.base + Math.sin(t * p.speed + p.phase) * p.amp);
    });
  });

  /* Fly the camera so every listed slot is in view. */
  function frameSlots(slotWhs) {
    const pts = slotWhs.map(w => engine.slotPos[w]).filter(Boolean);
    if (!pts.length) return;
    const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    engine.flyTo(cx, cz, Math.max(12, span * 1.3 + 8));
  }

  /* Highlight 2D tiles for the given slots (2D tiles carry data-slot). */
  function highlight2D(id, slotWhs, color) {
    const old = document.getElementById(id);
    if (old) old.remove();
    if (!slotWhs || !slotWhs.length) return;
    const esc = window.CSS && CSS.escape ? CSS.escape : s => s.replace(/["\\]/g, '\\$&');
    const sel = slotWhs.map(w => `.wt-2d-tile[data-slot="${esc(w)}"]`).join(',');
    const st = document.createElement('style');
    st.id = id;
    st.textContent = `${sel}{outline:3px solid ${color || '#22d3ee'};outline-offset:2px;box-shadow:0 0 0 6px ${color || '#22d3ee'}33!important}`;
    document.head.appendChild(st);
  }

  function hexCss(hex) { return '#' + hex.toString(16).padStart(6, '0'); }

  /* Left offset (px, inside #wt-app) for a popover anchored under a toolbar button. */
  function popLeft(buttonId, width) {
    const b = document.getElementById(buttonId);
    const app = document.getElementById('wt-app');
    if (!b || !app) return 158;
    const x = b.getBoundingClientRect().left - app.getBoundingClientRect().left;
    return Math.max(8, Math.min(x, app.clientWidth - width - 8));
  }

  /* Open a desk URL. The standalone page shares the session, so /app links work there too. */
  function openDesk(url) { window.open(url, '_blank', 'noopener'); }

  /* Debounced helper to avoid repeated work on rapid events. */
  function onUnmountedSafe(fn) { try { onUnmounted(fn); } catch (e) {} }

  /* ── Per-floor settings shared by putaway and routes: the dock slot ── */
  const floor = reactive({ id: null, dockSlot: null });
  async function loadFloorMeta() {
    if (!store.curGrp) return;
    const id = store.curGrp.id;
    try {
      const r = await core.api('operations', 'get_floor_meta', { group_warehouse: id });
      if (store.curGrp && store.curGrp.id === id) { floor.id = id; floor.dockSlot = (r && r.dock_slot) || null; }
    } catch (e) { floor.id = id; floor.dockSlot = null; }
  }
  bus.on('group-selected', (g, changed) => { if (changed || floor.id !== g.id) loadFloorMeta(); });
  async function setDock(slotWh) {
    await core.api('operations', 'save_dock', { group_warehouse: store.curGrp.id, slot_warehouse: slotWh || '' }, true);
    floor.dockSlot = slotWh || null;
    bus.emit('dock-changed', floor.dockSlot);
  }
  function chooseDock(onDone) {
    startPick({
      prompt: 'Click the slot next to the receiving dock',
      onPick: async d => {
        try { await setDock(d.slot.wh); core.alert('Dock set to ' + d.slot.label); }
        catch (e) { core.alert('Could not save the dock: ' + e.message, 'red'); }
        if (onDone) onDone();
      },
      onCancel: onDone,
    });
  }
  function dockLabel() {
    const sl = floor.dockSlot && store.slots.find(s => s.wh === floor.dockSlot);
    return sl ? sl.label : null;
  }

  core.ui = {
    state, openPanel, togglePanel, closePanel,
    floor, setDock, chooseDock, dockLabel,
    Dialog, Panel, ItemPicker,
    startPick, cancelPick,
    drawBeacons, labelSprite, frameSlots, highlight2D, hexCss, popLeft, openDesk, onUnmountedSafe,
    /* Bins on the current floor as select options. */
    floorBins() {
      const out = [];
      store.slots.forEach(sl => sl.levels.forEach((lv, li) => out.push({ wh: lv.wh, slot: sl.wh, level: li, label: sl.label + ' · ' + lv.label })));
      return out;
    },
    findLevel(lvWh) {
      for (const sl of store.slots) {
        const li = sl.levels.findIndex(l => l.wh === lvWh);
        if (li >= 0) return { slot: sl, lv: sl.levels[li], level: li };
      }
      return null;
    },
  };
});

})();
