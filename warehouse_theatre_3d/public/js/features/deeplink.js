/* Warehouse Theatre 3D — links in from ERPNext forms.
   The app understands these URL parameters (set by public/js/wt3d_forms.js):
     ?locate=ITEM                 find an item on the map
     ?locate=ITEM&focus=WH        …and open that warehouse's bin
     ?focus=WAREHOUSE             go to a warehouse (floor, rack, bin or zone)
     ?doc=DOCTYPE&name=NAME       show a stock document's lines on the map
     ?putaway=DOCTYPE&name=NAME   putaway suggestions for a receipt
     ?route=PICK_LIST             pick route for a Pick List
   Data: api/links.get_document_locations, find_warehouse. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, bus, engine, actions, addCSS, ui } = core;
  const { defineComponent, reactive, computed } = Vue;
  const { fmt, lvKey } = core.helpers;

  addCSS('wtf-deeplink-style', `
.wtf-doc-line{display:grid;grid-template-columns:22px 1fr auto;gap:8px;align-items:start;padding:7px 8px;border-radius:8px;border:1px solid var(--wt-cb);background:var(--wt-card);margin-bottom:5px;cursor:pointer}
.wtf-doc-line:hover{border-color:var(--wt-accent)}
.wtf-doc-n{width:20px;height:20px;border-radius:50%;background:var(--wt-pill);border:1px solid var(--wt-pillb);font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;color:var(--wt-text)}
.wtf-doc-item{font-size:11px;font-weight:700;color:var(--wt-text)}
.wtf-doc-move{font-size:10px;color:var(--wt-text2);margin-top:2px;line-height:1.5}
.wtf-doc-from{color:#ea580c;font-weight:700}
.wtf-doc-to{color:#16a34a;font-weight:700}
#wt-app.dark .wtf-doc-from{color:#fb923c}
#wt-app.dark .wtf-doc-to{color:#4ade80}
.wtf-doc-off{color:var(--wt-text3)}
.wtf-doc-qty{font-size:11px;font-weight:800;color:var(--wt-text);white-space:nowrap}
.wtf-doc-key{display:flex;gap:12px;font-size:10px;color:var(--wt-text2);margin-bottom:8px}
.wtf-doc-key span{display:flex;align-items:center;gap:5px}
`);

  const C_FROM = 0xfb923c, C_TO = 0x22c55e;

  // ── Document on the map ──
  const doc = reactive({ data: null, loading: false, error: '' });

  const floorsInDoc = computed(() => {
    if (!doc.data) return [];
    const by = {};
    doc.data.lines.forEach(ln => [ln.from, ln.to].forEach(p => {
      if (p && p.mapped && p.floor) (by[p.floor] = by[p.floor] || { floor: p.floor, label: p.floor_label, n: 0 }).n++;
    }));
    return Object.values(by).sort((a, b) => b.n - a.n);
  });

  function levelIndexOf(place) {
    if (!place || !place.slot) return null;
    const f = ui.findLevel(place.warehouse);
    return f ? f.level : null;
  }

  function drawDoc(fly) {
    if (!doc.data || !store.curGrp) { engine.clearOverlay('doc'); ui.highlight2D('wtf-doc-2d', []); return; }
    const targets = [];
    doc.data.lines.forEach(ln => {
      if (ln.from && ln.from.mapped && ln.from.floor === store.curGrp.id && ln.from.slot)
        targets.push({ slot: ln.from.slot, level: levelIndexOf(ln.from), color: C_FROM, label: ln.idx });
      if (ln.to && ln.to.mapped && ln.to.floor === store.curGrp.id && ln.to.slot)
        targets.push({ slot: ln.to.slot, level: levelIndexOf(ln.to), color: C_TO, label: ln.idx });
    });
    ui.drawBeacons('doc', targets);
    ui.highlight2D('wtf-doc-2d', [...new Set(targets.map(t => t.slot))], '#22c55e');
    if (fly && targets.length) ui.frameSlots(targets.map(t => t.slot));
  }

  async function goFloor(floorId) {
    const g = store.groups.find(x => x.id === floorId);
    if (!g) { core.alert('That floor is hidden by the company filter. Choose "All companies".', 'orange'); return false; }
    if (!store.curGrp || store.curGrp.id !== g.id) await actions.selectGroup(g);
    return true;
  }

  async function openDoc(doctype, name) {
    doc.data = null; doc.error = ''; doc.loading = true;
    ui.openPanel('doc');
    try {
      doc.data = await core.api('links', 'get_document_locations', { doctype, name });
      const best = floorsInDoc.value[0];
      if (best) await goFloor(best.floor);
      drawDoc(true);
    } catch (e) { doc.error = e.message; }
    finally { doc.loading = false; }
  }

  function closeDoc() { ui.closePanel('doc'); doc.data = null; engine.clearOverlay('doc'); ui.highlight2D('wtf-doc-2d', []); }

  async function focusPlace(place) {
    if (!place || !place.mapped) return;
    if (!(await goFloor(place.floor))) return;
    drawDoc(false);
    if (place.slot) {
      ui.frameSlots([place.slot]);
      const f = ui.findLevel(place.warehouse);
      if (f) { engine.highlight(lvKey(f.slot, f.lv)); actions.openDP({ slot: f.slot, lv: f.lv }); }
    }
  }

  bus.on('scene-built', () => { if (doc.data) drawDoc(false); });
  Vue.watch(() => ui.state.panel, p => { if (p !== 'doc' && doc.data) { doc.data = null; engine.clearOverlay('doc'); ui.highlight2D('wtf-doc-2d', []); } });

  function where(p) {
    if (!p) return '';
    if (!p.mapped) return (p.warehouse_label || p.warehouse) + ' (not on the map)';
    const here = store.curGrp && p.floor === store.curGrp.id;
    // A floor zone's only "level" is the zone itself, so its label adds nothing.
    const level = p.label && p.label !== p.slot_label && p.label !== 'Floor stack' ? p.label : null;
    const parts = [here ? null : p.floor_label, p.slot_label, level].filter(Boolean);
    return parts.join(' › ') || p.floor_label;
  }

  const DocPanel = defineComponent({
    name: 'WtfDocPanel',
    components: { WtfPanel: ui.Panel },
    setup() {
      return { doc, ui, store, floorsInDoc, fmt, where, focusPlace, closeDoc,
        url: () => doc.data ? '/app/' + doc.data.doctype.toLowerCase().replace(/ /g, '-') + '/' + encodeURIComponent(doc.data.name) : '#',
        goFloor: async f => { if (await goFloor(f)) drawDoc(true); } };
    },
    template: `
      <WtfPanel v-if="ui.state.panel==='doc'" :title="doc.data ? doc.data.doctype + ' ' + doc.data.name : 'Document on the map'"
        :sub="doc.data && doc.data.purpose ? doc.data.purpose : 'Where each line comes from and goes to.'" @close="closeDoc()">
        <div v-if="doc.loading" class="wtf-muted"><span class="wtf-spin"></span> Loading…</div>
        <div v-else-if="doc.error" class="wtf-err" role="alert">{{doc.error}}</div>
        <template v-else-if="doc.data">
          <div class="wtf-doc-key">
            <span><span class="wtf-dot" style="background:#fb923c"></span>From</span>
            <span><span class="wtf-dot" style="background:#22c55e"></span>To</span>
            <span class="wtf-muted">Numbers match the line numbers on the document.</span>
          </div>
          <div v-if="floorsInDoc.length > 1" class="wtf-field">
            <label for="wtf-doc-floor">Lines on {{floorsInDoc.length}} floors</label>
            <select id="wtf-doc-floor" class="wtf-inp" :value="store.curGrp && store.curGrp.id" @change="goFloor($event.target.value)">
              <option v-for="f in floorsInDoc" :key="f.floor" :value="f.floor">{{f.label}} · {{f.n}} location{{f.n===1?'':'s'}}</option>
            </select>
          </div>
          <div v-if="!floorsInDoc.length" class="wtf-muted" style="margin-bottom:8px">None of this document's warehouses are on the map yet.</div>
          <div v-for="ln in doc.data.lines" :key="ln.idx" class="wtf-doc-line" tabindex="0"
            @click="focusPlace(ln.to && ln.to.mapped ? ln.to : ln.from)" @keydown.enter="focusPlace(ln.to && ln.to.mapped ? ln.to : ln.from)">
            <span class="wtf-doc-n">{{ln.idx}}</span>
            <div style="min-width:0">
              <div class="wtf-doc-item">{{ln.item_code}}</div>
              <div class="wtf-doc-move">
                <span v-if="ln.from" :class="ln.from.mapped ? 'wtf-doc-from' : 'wtf-doc-off'">{{where(ln.from)}}</span>
                <span v-if="ln.from && ln.to"> → </span>
                <span v-if="ln.to" :class="ln.to.mapped ? 'wtf-doc-to' : 'wtf-doc-off'">{{where(ln.to)}}</span>
              </div>
            </div>
            <span class="wtf-doc-qty">{{fmt(ln.qty)}} {{ln.uom}}</span>
          </div>
          <div v-if="!doc.data.lines.length" class="wtf-muted">This document has no stock lines.</div>
        </template>
        <template #footer v-if="doc.data">
          <a class="wtf-btn" :href="url()" target="_blank" rel="noopener">Open in ERPNext ↗</a>
        </template>
      </WtfPanel>`,
  });
  ext.overlays.push(DocPanel);

  // ── Focus one warehouse ──
  async function focusWarehouse(wh) {
    try {
      const p = await core.api('links', 'find_warehouse', { warehouse: wh });
      if (!p || !p.mapped) { core.alert(`${wh} isn't on the warehouse map yet.`, 'orange'); return; }
      if (!(await goFloor(p.floor))) return;
      if (!p.slot) return;   // a floor: opening it is enough
      ui.frameSlots([p.slot]);
      const f = ui.findLevel(p.warehouse);
      if (f) { engine.highlight(lvKey(f.slot, f.lv)); actions.openDP({ slot: f.slot, lv: f.lv }); }
      else ui.drawBeacons('focus', [{ slot: p.slot, level: null, color: 0x3b82f6, label: null }]);
    } catch (e) { core.alert('Could not open ' + wh + ': ' + e.message, 'red'); }
  }

  // ── Read the link once the app has loaded its floors ──
  function readParams() {
    const p = {};
    try { new URLSearchParams(location.search).forEach((v, k) => { p[k] = v; }); } catch (e) {}
    // Desk page: /app/warehouse-theatre-3d?… arrives as route options
    if (window.frappe && frappe.route_options) { Object.assign(p, frappe.route_options); frappe.route_options = null; }
    return p;
  }

  async function handle(p) {
    if (!p || !Object.keys(p).length) return;
    if (store.curView !== '3d') actions.setView('3d');
    if (p.doc && p.name) return openDoc(p.doc, p.name);
    if (p.putaway && p.name && core.putaway) return core.putaway.openFor(p.putaway, p.name);
    if (p.route && core.routes) return core.routes.openFor(p.route);
    if (p.focus && !p.locate) return focusWarehouse(p.focus);
    if (p.locate && core.locate) {
      if (p.focus) {
        const pl = await core.api('links', 'find_warehouse', { warehouse: p.focus }).catch(() => null);
        if (pl && pl.mapped) await goFloor(pl.floor);
      }
      return core.locate.locate(p.locate);
    }
  }

  let done = false;
  bus.on('group-selected', () => {
    if (done) return;
    done = true;
    const p = readParams();
    const known = ['locate', 'focus', 'doc', 'putaway', 'route'];
    if (!known.some(k => p[k])) return;
    // Drop the parameters so a page refresh doesn't repeat the action.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    setTimeout(() => handle(p), 0);
  });

  core.deeplink = { handle, openDoc, focusWarehouse };
});

})();
