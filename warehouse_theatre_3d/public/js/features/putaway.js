/* Warehouse Theatre 3D — putaway suggestions.
   For goods just received (a Purchase Receipt / Stock Entry, or items typed in),
   rank the bins on this floor by free capacity, distance from the dock, shelf height
   and whether they already hold the item. Suggestions are marked on the map and can
   become one draft Material Transfer.
   Data: api/operations.get_receipt_items, get_putaway_plan, create_putaway_transfer. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, bus, engine, actions, addCSS, ui } = core;
  const { defineComponent, reactive, computed, watch } = Vue;
  const { fmt } = core.helpers;

  addCSS('wtf-putaway-style', `
.wtf-pa-line{display:grid;grid-template-columns:1fr 70px 22px;gap:5px;align-items:center;margin-bottom:5px}
.wtf-pa-item{border-left:3px solid var(--c);padding-left:8px;margin-bottom:12px}
.wtf-pa-item-h{display:flex;justify-content:space-between;gap:8px;font-size:11px;font-weight:800;color:var(--wt-text);margin-bottom:5px}
.wtf-pa-alloc{display:flex;gap:7px;align-items:flex-start;padding:6px 7px;border-radius:7px;background:var(--wt-card);border:1px solid var(--wt-cb);margin-bottom:4px;cursor:pointer}
.wtf-pa-alloc:hover{border-color:var(--wt-accent)}
.wtf-pa-n{width:20px;height:20px;border-radius:50%;background:var(--c);color:#0c0e14;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.wtf-pa-bin{font-size:11px;font-weight:700;color:var(--wt-text)}
.wtf-pa-why{font-size:9px;color:var(--wt-text3);line-height:1.4}
.wtf-pa-q{margin-left:auto;font-size:11px;font-weight:800;color:var(--wt-text);white-space:nowrap}
.wtf-pa-warn{font-size:10px;color:#fbbf24;margin:3px 0 4px}
.wtf-dock{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:10px;color:var(--wt-text2);margin-bottom:10px;padding:6px 8px;border-radius:7px;background:var(--wt-card);border:1px dashed var(--wt-cb)}
`);

  const COLORS = [0x22d3ee, 0xf472b6, 0xa3e635, 0xfbbf24, 0xc084fc, 0x60a5fa, 0xfb7185, 0x34d399];
  const SOURCES = ['Purchase Receipt', 'Stock Entry', 'Subcontracting Receipt'];

  const state = reactive({
    tab: 'doc', doctype: 'Purchase Receipt', docname: '', docOptions: [],
    lines: [{ item_code: '', qty: '' }], loadedFrom: null,
    loading: false, error: '', plan: null, dockSlot: null,
    sourceWh: '', creating: false, created: null,
  });

  function color(i) { return COLORS[i % COLORS.length]; }

  let searchTimer;
  function searchDocs() {
    clearTimeout(searchTimer);
    const txt = state.docname.trim();
    searchTimer = setTimeout(async () => {
      try {
        const r = await core.rpc('frappe.desk.search.search_link', { doctype: state.doctype, txt, page_length: 10 });
        state.docOptions = (r || []).map(o => o.value || o[0]).filter(Boolean);
      } catch (e) { state.docOptions = []; }
    }, 250);
  }

  async function loadDoc() {
    state.error = ''; state.plan = null; state.created = null;
    if (!state.docname.trim()) { state.error = 'Enter a document number.'; return; }
    state.loading = true;
    try {
      const items = await core.api('operations', 'get_receipt_items', { doctype: state.doctype, name: state.docname.trim() });
      if (!items || !items.length) { state.error = 'No received items with quantity on that document.'; return; }
      state.loadedFrom = { doctype: state.doctype, name: state.docname.trim(), items };
      await suggest(items);
    } catch (e) { state.error = e.message; }
    finally { state.loading = false; }
  }

  async function suggestManual() {
    state.error = ''; state.created = null;
    const items = state.lines.filter(l => l.item_code && +l.qty > 0).map(l => ({ item_code: l.item_code, qty: +l.qty }));
    if (!items.length) { state.error = 'Add at least one item with a quantity.'; return; }
    state.loadedFrom = null;
    state.loading = true;
    try { await suggest(items); } catch (e) { state.error = e.message; }
    finally { state.loading = false; }
  }

  async function suggest(items) {
    const r = await core.api('operations', 'get_putaway_plan', { group_warehouse: store.curGrp.id, items: JSON.stringify(items) });
    state.plan = r.plan;
    state.dockSlot = r.dock_slot;
    const froms = [...new Set(r.plan.map(p => p.from_warehouse).filter(Boolean))];
    state.sourceWh = froms.length === 1 ? froms[0] : (state.sourceWh || '');
    draw(true);
  }

  function draw(fly) {
    if (!state.plan) { engine.clearOverlay('putaway'); ui.highlight2D('wtf-putaway-2d', []); return; }
    let n = 0;
    const targets = [];
    state.plan.forEach((p, pi) => p.allocations.forEach(a => {
      n += 1; a._n = n;
      targets.push({ slot: a.slot, level: a.level, color: color(pi), label: n });
    }));
    if (ui.floor.dockSlot) targets.push({ slot: ui.floor.dockSlot, level: null, color: 0xffffff, label: 'DOCK' });
    ui.drawBeacons('putaway', targets);
    ui.highlight2D('wtf-putaway-2d', [...new Set(targets.map(t => t.slot))], '#f472b6');
    if (fly) ui.frameSlots(targets.map(t => t.slot));
  }

  const allocCount = computed(() => state.plan ? state.plan.reduce((s, p) => s + p.allocations.length, 0) : 0);
  const unplacedCount = computed(() => state.plan ? state.plan.filter(p => p.unplaced > 0).length : 0);

  async function createTransfer() {
    state.error = '';
    const rows = [];
    state.plan.forEach(p => p.allocations.forEach(a => rows.push({
      item_code: p.item_code, qty: a.qty, s_warehouse: p.from_warehouse || state.sourceWh, t_warehouse: a.wh,
    })));
    if (rows.some(r => !r.s_warehouse)) { state.error = 'Enter the warehouse the goods are coming from.'; return; }
    state.creating = true;
    try {
      state.created = await core.api('operations', 'create_putaway_transfer', { rows: JSON.stringify(rows) }, true);
    } catch (e) { state.error = e.message; }
    finally { state.creating = false; }
  }

  function focus(a) {
    ui.frameSlots([a.slot]);
    const f = ui.findLevel(a.wh);
    if (f) engine.highlight(core.helpers.lvKey(f.slot, f.lv));
  }

  function reset() {
    // sourceWh too: carrying the last receipt's warehouse into an unrelated putaway
    // would quietly move stock out of the wrong place.
    state.plan = null; state.created = null; state.error = ''; state.loadedFrom = null; state.sourceWh = '';
    draw(false);
  }
  function close() { ui.closePanel('putaway'); reset(); }

  bus.on('scene-built', () => { if (state.plan) draw(false); });
  bus.on('before-group-change', (g, changed) => { if (changed && state.plan) reset(); });
  bus.on('dock-changed', () => { if (state.plan) draw(false); });
  watch(() => ui.state.panel, p => { if (p !== 'putaway' && state.plan) reset(); });

  const PutawayPanel = defineComponent({
    name: 'WtfPutawayPanel',
    components: { WtfPanel: ui.Panel, WtfItemPicker: ui.ItemPicker },
    setup() {
      return { state, ui, store, SOURCES, color, fmt, allocCount, unplacedCount, searchDocs, loadDoc,
        suggestManual, createTransfer, focus, reset, close,
        hex: c => ui.hexCss(c),
        addLine: () => state.lines.push({ item_code: '', qty: '' }),
        removeLine: i => { state.lines.splice(i, 1); if (!state.lines.length) state.lines.push({ item_code: '', qty: '' }); },
        changeDock: () => ui.chooseDock(),
      };
    },
    template: `
      <WtfPanel v-if="ui.state.panel==='putaway'" title="📥 Putaway"
        sub="Where should received goods go? Bins are ranked by free space, distance from the dock and shelf height." @close="close()">
        <div class="wtf-dock">
          <span>🚚 Dock: <b>{{ui.dockLabel() || 'front-left corner (not set)'}}</b></span>
          <button v-if="store.canEdit" class="wtf-btn wtf-btn-sm" @click="changeDock()">{{ui.floor.dockSlot?'Change':'Set dock'}}</button>
        </div>
        <template v-if="!state.plan">
          <div class="wtf-pa-tabs" role="tablist">
            <button role="tab" :aria-selected="state.tab==='doc'" :class="['wtf-pa-tab', state.tab==='doc'?'act':'']" @click="state.tab='doc'">From a receipt</button>
            <button role="tab" :aria-selected="state.tab==='manual'" :class="['wtf-pa-tab', state.tab==='manual'?'act':'']" @click="state.tab='manual'">Enter items</button>
          </div>
          <div v-if="state.error" class="wtf-err" role="alert">{{state.error}}</div>
          <template v-if="state.tab==='doc'">
            <div class="wtf-field"><label for="wtf-pa-dt">Document type</label>
              <select id="wtf-pa-dt" class="wtf-inp" v-model="state.doctype" @change="state.docname='';state.docOptions=[]">
                <option v-for="d in SOURCES" :key="d" :value="d">{{d}}</option>
              </select></div>
            <div class="wtf-field"><label for="wtf-pa-dn">Document number</label>
              <input id="wtf-pa-dn" class="wtf-inp" list="wtf-pa-docs" v-model="state.docname" @input="searchDocs()" @focus="searchDocs()"
                @keydown.enter="loadDoc()" placeholder="e.g. MAT-PRE-2026-00011" autocomplete="off"/>
              <datalist id="wtf-pa-docs"><option v-for="o in state.docOptions" :key="o" :value="o"/></datalist></div>
            <button class="wtf-btn wtf-btn-pri wtf-btn-block" :disabled="state.loading" @click="loadDoc()">
              <span v-if="state.loading" class="wtf-spin"></span>Suggest bins</button>
          </template>
          <template v-else>
            <div class="wtf-pa-line wtf-lbl"><span>Item</span><span>Qty (stock UOM)</span><span></span></div>
            <div v-for="(l,i) in state.lines" :key="i" class="wtf-pa-line">
              <WtfItemPicker v-model="l.item_code"/>
              <input class="wtf-inp" type="number" min="0" step="any" v-model="l.qty" :aria-label="'Quantity line '+(i+1)"/>
              <button class="wtf-x" @click="removeLine(i)" :aria-label="'Remove line '+(i+1)">✕</button>
            </div>
            <button class="wtf-btn wtf-btn-sm" @click="addLine()" style="margin-bottom:10px">+ Add item</button>
            <button class="wtf-btn wtf-btn-pri wtf-btn-block" :disabled="state.loading" @click="suggestManual()">
              <span v-if="state.loading" class="wtf-spin"></span>Suggest bins</button>
          </template>
        </template>
        <template v-else>
          <div class="wtf-muted" style="margin-bottom:10px">
            <span v-if="state.loadedFrom">{{state.loadedFrom.doctype}} <b>{{state.loadedFrom.name}}</b> · </span>
            {{allocCount}} bin{{allocCount===1?'':'s'}} suggested<span v-if="unplacedCount"> · <b style="color:#fbbf24">{{unplacedCount}} item{{unplacedCount===1?'':'s'}} don't fully fit</b></span>
          </div>
          <div v-for="(p,pi) in state.plan" :key="p.item_code+pi" class="wtf-pa-item" :style="{'--c':hex(color(pi))}">
            <div class="wtf-pa-item-h"><span>{{p.item_code}}</span><span>{{fmt(p.qty)}} {{p.uom}}</span></div>
            <div v-if="p.item_name" class="wtf-muted" style="margin:-3px 0 5px">{{p.item_name}}</div>
            <div v-for="a in p.allocations" :key="a.wh" class="wtf-pa-alloc" @click="focus(a)" tabindex="0" @keydown.enter="focus(a)">
              <span class="wtf-pa-n">{{a._n}}</span>
              <div style="min-width:0"><div class="wtf-pa-bin">{{a.slot_label}} · {{a.label}}</div><div class="wtf-pa-why">{{a.reasons.join(' · ')}}</div></div>
              <span class="wtf-pa-q">{{fmt(a.qty)}}</span>
            </div>
            <div v-if="p.unplaced>0" class="wtf-pa-warn">⚠ {{fmt(p.unplaced)}} {{p.uom}} doesn't fit in any bin with known capacity on this floor.</div>
            <div v-if="!p.allocations.length && !p.unplaced" class="wtf-muted">No bins on this floor.</div>
          </div>
          <div v-if="state.created" class="wtf-ok">Draft <b>{{state.created.name}}</b> created with {{state.created.rows}} line{{state.created.rows===1?'':'s'}}.
            <span v-if="state.created.needs_batch_or_serial"> Some items are batch/serial tracked — fill those in before submitting.</span>
            <div style="margin-top:6px"><a :href="state.created.url" target="_blank" rel="noopener">Open {{state.created.name}} ↗</a></div></div>
          <template v-else-if="allocCount">
            <div v-if="state.error" class="wtf-err" role="alert">{{state.error}}</div>
            <div v-if="state.plan.some(p=>!p.from_warehouse)" class="wtf-field"><label for="wtf-pa-src">Coming from warehouse</label>
              <input id="wtf-pa-src" class="wtf-inp" v-model="state.sourceWh" placeholder="e.g. Receiving - ABC"/></div>
          </template>
        </template>
        <template #footer v-if="state.plan">
          <button class="wtf-btn" @click="reset()">← New</button>
          <button v-if="!state.created && allocCount" class="wtf-btn wtf-btn-pri" :disabled="state.creating" @click="createTransfer()">
            <span v-if="state.creating" class="wtf-spin"></span>Create draft transfer</button>
        </template>
      </WtfPanel>`,
  });
  ext.overlays.push(PutawayPanel);

  ext.tools.push({
    id: 'putaway', icon: '📥', label: 'Putaway', title: 'Suggest bins for received goods',
    show: () => !store.replayDate,
    active: () => ui.state.panel === 'putaway',
    onClick: () => { if (ui.state.panel === 'putaway') close(); else ui.openPanel('putaway'); },
  });
});

})();
