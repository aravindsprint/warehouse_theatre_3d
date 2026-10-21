/* Warehouse Theatre 3D — stock actions from inside the view.
   Move stock between bins (Material Transfer), count a bin (Stock Reconciliation)
   and open the Stock Ledger for a bin. Documents are created with the user's own
   ERPNext permissions and saved as drafts unless they tick "Submit now".
   Data: api/operations.get_bin_stock, create_material_transfer, create_stock_reconciliation. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, actions, addCSS, ui } = core;
  const { defineComponent, reactive, computed } = Vue;
  const { fmt } = core.helpers;

  addCSS('wtf-actions-style', `
.wtf-act-row{display:flex;gap:6px;margin-top:6px}
.wtf-act-row .wtf-btn{flex:1;height:28px;font-size:10px;padding:0 6px}
.wtf-src{background:var(--wt-card);border:1px solid var(--wt-cb);border-radius:8px;padding:8px 9px;margin-bottom:10px}
.wtf-src b{font-size:11px;color:var(--wt-text)}
.wtf-tgt{display:flex;gap:6px}
.wtf-tgt select{flex:1}
.wtf-check{display:flex;align-items:flex-start;gap:7px;font-size:11px;color:var(--wt-text2);cursor:pointer;line-height:1.4}
.wtf-check input{margin-top:2px}
.wtf-cnt-inp{width:84px;text-align:right}
.wtf-diff-up{color:#4ade80;font-weight:700}
.wtf-diff-down{color:#f87171;font-weight:700}
`);

  const ymd = d => d.toISOString().slice(0, 10);
  function ledgerUrl(warehouse, company) {
    const to = new Date(), from = new Date(); from.setDate(from.getDate() - 30);
    const q = new URLSearchParams({ warehouse, from_date: ymd(from), to_date: ymd(to) });
    if (company) q.set('company', company);
    return '/app/query-report/Stock Ledger?' + q.toString();
  }

  /* ── Move stock ── */
  const mv = reactive({
    open: false, hidden: false, src: null, items: [], loading: false, itemCode: '', qty: '', target: '',
    submit: false, busy: false, error: '', result: null,
  });

  async function openMove(d, itemCode) {
    if (store.replayDate) return;
    Object.assign(mv, { open: true, hidden: false, src: d, items: [], loading: true, itemCode: itemCode || '', qty: '',
      target: '', submit: false, busy: false, error: '', result: null });
    store.imOpen = false;
    try {
      const r = await core.api('operations', 'get_bin_stock', { warehouse: d.lv.wh });
      mv.items = (r && r.items) || [];
      if (!mv.itemCode && mv.items.length) mv.itemCode = mv.items[0].item_code;
      setDefaultQty();
    } catch (e) { mv.error = e.message; }
    finally { mv.loading = false; }
  }
  const mvItem = computed(() => mv.items.find(i => i.item_code === mv.itemCode));
  function setDefaultQty() {
    const it = mvItem.value;
    if (it) mv.qty = Math.max(0, (+it.actual_qty || 0) - (+it.reserved_qty || 0)) || +it.actual_qty || '';
  }
  function pickTarget() {
    mv.hidden = true;
    ui.startPick({
      prompt: 'Click the bin to move stock into',
      filter: d => d.lv.wh !== mv.src.lv.wh,
      onPick: d => { mv.target = d.lv.wh; mv.hidden = false; },
      onCancel: () => { mv.hidden = false; },
    });
  }
  async function doMove() {
    mv.error = '';
    if (!mv.itemCode) { mv.error = 'Choose an item.'; return; }
    if (!(+mv.qty > 0)) { mv.error = 'Enter a quantity greater than zero.'; return; }
    if (mvItem.value && +mv.qty > +mvItem.value.actual_qty) { mv.error = `Only ${fmt(mvItem.value.actual_qty)} in this bin.`; return; }
    if (!mv.target) { mv.error = 'Choose the target bin.'; return; }
    mv.busy = true;
    try {
      const r = await core.api('operations', 'create_material_transfer', {
        item_code: mv.itemCode, qty: mv.qty, s_warehouse: mv.src.lv.wh, t_warehouse: mv.target, submit: mv.submit ? 1 : 0,
      }, true);
      mv.result = r;
      if (r.submitted) { core.alert(`Moved ${fmt(mv.qty)} ${mv.itemCode} · ${r.name}`); await actions.refreshFloor(); }
    } catch (e) { mv.error = e.message; }
    finally { mv.busy = false; }
  }

  /* ── Count bin ── */
  const ct = reactive({ open: false, src: null, rows: [], loading: false, busy: false, error: '', result: null, company: '' });

  async function openCount(d) {
    if (store.replayDate) return;
    Object.assign(ct, { open: true, src: d, rows: [], loading: true, busy: false, error: '', result: null });
    store.imOpen = false;
    try {
      const r = await core.api('operations', 'get_bin_stock', { warehouse: d.lv.wh });
      ct.company = r.company;
      ct.rows = ((r && r.items) || []).map(i => ({ ...i, counted: String(+i.actual_qty), tracked: !!(i.has_batch_no || i.has_serial_no) }));
    } catch (e) { ct.error = e.message; }
    finally { ct.loading = false; }
  }
  const ctChanges = computed(() => ct.rows.filter(r => !r.tracked && r.counted !== '' && Math.abs(+r.counted - (+r.actual_qty)) > 1e-9));
  async function doCount() {
    ct.error = '';
    if (ct.rows.some(r => r.counted !== '' && (isNaN(+r.counted) || +r.counted < 0))) { ct.error = 'Counts must be zero or more.'; return; }
    if (!ctChanges.value.length) { ct.error = 'No differences from the system quantity — nothing to record.'; return; }
    ct.busy = true;
    try {
      ct.result = await core.api('operations', 'create_stock_reconciliation', {
        warehouse: ct.src.lv.wh,
        rows: JSON.stringify(ctChanges.value.map(r => ({ item_code: r.item_code, qty: +r.counted }))),
      }, true);
    } catch (e) { ct.error = e.message; }
    finally { ct.busy = false; }
  }

  async function openLedger(d) {
    // Open the tab synchronously (popup blockers), then point it at the report once
    // the bin's company is known - the Stock Ledger report needs a company filter.
    const w = window.open('about:blank', '_blank');
    let company = '';
    try { company = (await core.api('operations', 'get_bin_stock', { warehouse: d.lv.wh })).company; } catch (e) {}
    const url = ledgerUrl(d.lv.wh, company);
    if (w) w.location.href = url; else ui.openDesk(url);
  }

  const MoveDialog = defineComponent({
    name: 'WtfMoveDialog',
    components: { WtfDialog: ui.Dialog },
    setup() {
      const targets = computed(() => mv.src ? ui.floorBins().filter(b => b.wh !== mv.src.lv.wh) : []);
      const targetLabel = computed(() => { const t = targets.value.find(b => b.wh === mv.target); return t ? t.label : mv.target; });
      return { mv, mvItem, targets, targetLabel, pickTarget, doMove, setDefaultQty, fmt, ui,
        close: () => { mv.open = false; } };
    },
    template: `
      <WtfDialog v-if="mv.open && !mv.hidden" title="⇄ Move stock" width="400px"
        sub="Creates a Material Transfer stock entry." @close="close()">
        <div class="wtf-src"><div class="wtf-muted">From</div><b>{{mv.src.slot.label}} · {{mv.src.lv.label}}</b> <span class="wtf-muted">{{mv.src.lv.wh}}</span></div>
        <div v-if="mv.result" class="wtf-ok">
          <template v-if="mv.result.submitted">Submitted <b>{{mv.result.name}}</b>. The map has been refreshed.</template>
          <template v-else>Draft <b>{{mv.result.name}}</b> created.
            <span v-if="mv.result.needs_batch_or_serial"> This item is batch/serial tracked — pick the batch or serial in the stock entry, then submit it.</span>
            <span v-else> Review and submit it in ERPNext.</span></template>
          <div style="margin-top:6px"><a :href="mv.result.url" target="_blank" rel="noopener">Open {{mv.result.name}} ↗</a></div>
        </div>
        <template v-else>
          <div v-if="mv.error" class="wtf-err" role="alert">{{mv.error}}</div>
          <div v-if="mv.loading" class="wtf-muted"><span class="wtf-spin"></span> Loading bin stock…</div>
          <template v-else>
            <div v-if="!mv.items.length" class="wtf-muted" style="margin-bottom:10px">This bin has no stock to move.</div>
            <div class="wtf-field"><label for="wtf-mv-item">Item</label>
              <select id="wtf-mv-item" class="wtf-inp" v-model="mv.itemCode" @change="setDefaultQty()">
                <option v-for="i in mv.items" :key="i.item_code" :value="i.item_code">{{i.item_code}} — {{fmt(i.actual_qty)}} {{i.stock_uom}}</option>
              </select>
            </div>
            <div class="wtf-field"><label for="wtf-mv-qty">Quantity<span v-if="mvItem"> ({{mvItem.stock_uom}}; {{fmt(mvItem.actual_qty)}} in bin<span v-if="mvItem.reserved_qty>0">, {{fmt(mvItem.reserved_qty)}} reserved</span>)</span></label>
              <input id="wtf-mv-qty" class="wtf-inp" type="number" min="0" step="any" v-model="mv.qty"/>
            </div>
            <div class="wtf-field"><label for="wtf-mv-tgt">To bin</label>
              <div class="wtf-tgt">
                <select id="wtf-mv-tgt" class="wtf-inp" v-model="mv.target">
                  <option value="">Choose…</option>
                  <option v-for="b in targets" :key="b.wh" :value="b.wh">{{b.label}}</option>
                </select>
                <button class="wtf-btn" @click="pickTarget()" title="Click the target bin on the map">🎯 Pick on map</button>
              </div>
            </div>
            <label class="wtf-check"><input type="checkbox" v-model="mv.submit"/>
              <span>Submit now<br><span class="wtf-muted">Only for items without batch or serial numbers; tracked items are always saved as a draft.</span></span></label>
          </template>
        </template>
        <template #footer>
          <button class="wtf-btn" @click="close()">{{mv.result?'Close':'Cancel'}}</button>
          <button v-if="!mv.result" class="wtf-btn wtf-btn-pri" :disabled="mv.busy || mv.loading || !mv.items.length" @click="doMove()">
            <span v-if="mv.busy" class="wtf-spin"></span>{{mv.submit?'Move stock':'Create draft'}}</button>
        </template>
      </WtfDialog>`,
  });

  const CountDialog = defineComponent({
    name: 'WtfCountDialog',
    components: { WtfDialog: ui.Dialog },
    setup() {
      const diff = r => r.counted === '' || isNaN(+r.counted) ? 0 : (+r.counted - (+r.actual_qty));
      return { ct, ctChanges, doCount, fmt, diff, close: () => { ct.open = false; } };
    },
    template: `
      <WtfDialog v-if="ct.open" title="✓ Count bin" width="520px"
        :sub="ct.src.slot.label + ' · ' + ct.src.lv.label + ' — enter what is physically there. Only differences are recorded.'" @close="close()">
        <div v-if="ct.result && ct.result.name" class="wtf-ok">Draft <b>{{ct.result.name}}</b> created with {{ct.result.rows}} row{{ct.result.rows===1?'':'s'}}. Review and submit it in ERPNext.
          <div style="margin-top:6px"><a :href="ct.result.url" target="_blank" rel="noopener">Open {{ct.result.name}} ↗</a></div>
        </div>
        <div v-else-if="ct.result" class="wtf-ok">{{ct.result.message}}</div>
        <template v-else>
          <div v-if="ct.error" class="wtf-err" role="alert">{{ct.error}}</div>
          <div v-if="ct.loading" class="wtf-muted"><span class="wtf-spin"></span> Loading bin stock…</div>
          <div v-else-if="!ct.rows.length" class="wtf-muted">This bin is empty in ERPNext. To record stock found here, use a Stock Reconciliation in ERPNext.</div>
          <table v-else class="wtf-tbl">
            <thead><tr><th>Item</th><th class="r">System</th><th class="r">Counted</th><th class="r">Diff</th></tr></thead>
            <tbody>
              <tr v-for="r in ct.rows" :key="r.item_code">
                <td><b style="color:var(--wt-text)">{{r.item_code}}</b><div class="wtf-muted">{{r.item_name}}</div>
                  <div v-if="r.tracked" class="wtf-muted" style="color:#fbbf24">Batch/serial tracked — count in ERPNext</div></td>
                <td class="r wtf-num">{{fmt(r.actual_qty)}} {{r.stock_uom}}</td>
                <td class="r"><input class="wtf-inp wtf-cnt-inp" type="number" min="0" step="any" v-model="r.counted" :disabled="r.tracked" :aria-label="'Counted quantity for '+r.item_code"/></td>
                <td class="r wtf-num"><span v-if="diff(r)" :class="diff(r)>0?'wtf-diff-up':'wtf-diff-down'">{{diff(r)>0?'+':''}}{{fmt(diff(r))}}</span><span v-else class="wtf-muted">—</span></td>
              </tr>
            </tbody>
          </table>
        </template>
        <template #footer>
          <span v-if="!ct.result && ct.rows.length" class="wtf-muted" style="margin-right:auto">{{ctChanges.length}} difference{{ctChanges.length===1?'':'s'}}</span>
          <button class="wtf-btn" @click="close()">{{ct.result?'Close':'Cancel'}}</button>
          <button v-if="!ct.result" class="wtf-btn wtf-btn-pri" :disabled="ct.busy || ct.loading || !ctChanges.length" @click="doCount()">
            <span v-if="ct.busy" class="wtf-spin"></span>Create draft reconciliation</button>
        </template>
      </WtfDialog>`,
  });

  const ActionsSection = defineComponent({
    name: 'WtfActionsSection',
    props: { d: Object },
    setup() { return { store, openMove, openCount, openLedger }; },
    template: `
      <div v-if="d">
        <div class="wt-divider"></div>
        <span class="wt-dp-sec">Actions</span>
        <div v-if="store.replayDate" class="wtf-muted">Not available while replaying history.</div>
        <template v-else>
          <div class="wtf-act-row">
            <button class="wtf-btn" @click="openMove(d)">⇄ Move stock</button>
            <button class="wtf-btn" @click="openCount(d)">✓ Count bin</button>
          </div>
          <div class="wtf-act-row"><button class="wtf-btn" @click="openLedger(d)">📒 Stock ledger (30 days)</button></div>
        </template>
      </div>`,
  });

  ext.overlays.push(MoveDialog, CountDialog);
  ext.panelSections.push(ActionsSection);
  ext.itemActions.push({ icon: '⇄', label: 'Move', show: () => !store.replayDate, run: (it, d) => openMove(d, it.c) });

  core.stockActions = { openMove, openCount, openLedger };
});

})();
