/* Warehouse Scan — Receive, Quality hold and Returns.
   Receive: open a Purchase Order, scan what arrived (switch to "Damaged" to count
   damaged goods apart), post the Purchase Receipt, then put it away.
   Quality hold: release checked stock to putaway, or reject it.
   Returns: open a Delivery Note or Sales Invoice, scan what came back (good or
   damaged), make the return, then put the good goods away.
   Server: api/inbound.py. Registers with the scanner core (wt-scan.js) before mount. */
(function () {
'use strict';
const W = window.WarehouseScan;
if (!W || !W.core) return;
const { EXT, api, flash, feedback, ask, confirmSheet, go, handler, fmt, cache } = W.core;
const { TopBar, Prompt, Icon, Done } = W.core.components;
const { reactive, computed } = Vue;

// Counting shared by Receive and Returns: lines [{line, item_code, uom, factor, limit}], counts {line: {good, damaged}}.
function counter(state, limitOf) {
  function total(ln) { const c = state.counts[ln.line] || {}; return (c.good || 0) + (c.damaged || 0); }
  function add(ln, qty) {
    const c = state.counts[ln.line] || (state.counts[ln.line] = { good: 0, damaged: 0 });
    const key = state.damaged ? 'damaged' : 'good';
    c[key] = +((c[key] || 0) + qty).toFixed(6);
    const over = total(ln) > limitOf(ln) + 1e-9;
    flash(over ? 'warn' : (state.damaged ? 'warn' : 'ok'), `${fmt(c[key])} ${ln.uom} ${ln.item_code}${state.damaged ? ' damaged' : ''}${over ? ' · more than expected' : ''}`);
  }
  function onItem(r) {
    const cands = state.doc.lines.filter(ln => ln.item_code === r.item_code);
    if (!cands.length) { flash('err', `${r.item_code} isn't on ${state.doc.name}`); return; }
    const ln = cands.find(c => total(c) < limitOf(c) - 1e-9) || cands[0];
    add(ln, r.factor > 1 ? r.factor / (ln.factor || 1) : 1);
  }
  async function type(ln) {
    const c = state.counts[ln.line] || { good: 0, damaged: 0 };
    const key = state.damaged ? 'damaged' : 'good';
    const v = await ask({ title: `${ln.item_code}${state.damaged ? ' · damaged' : ''}`, sub: `${fmt(limitOf(ln))} ${ln.uom} expected`,
      value: String(c[key] || (state.damaged ? 0 : limitOf(ln))), unit: ln.uom, ok: 'Set',
      quick: [{ label: 'All ' + fmt(limitOf(ln)), value: limitOf(ln) }, { label: 'None', value: 0 }] });
    if (v === null) return;
    state.counts[ln.line] = Object.assign({ good: 0, damaged: 0 }, state.counts[ln.line], { [key]: v });
  }
  const list = () => Object.entries(state.counts).map(([line, c]) => ({ line, good: c.good || 0, damaged: c.damaged || 0 })).filter(c => c.good + c.damaged > 0);
  return { total, add, onItem, type, list };
}

// ── Receive ───────────────────────────────────────────────────
const RV = reactive({ pos: null, txt: '', doc: null, counts: {}, damaged: false, dn: '', loading: false, result: null });
const Receive = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(RV, { pos: null, txt: '', doc: null, counts: {}, damaged: false, dn: '', loading: false, result: null }); },
  async load() {
    RV.loading = true;
    try { RV.pos = await api('inbound', 'get_open_purchase_orders', { txt: RV.txt || undefined }); }
    catch (e) { flash('err', e.message); RV.pos = []; }
    finally { RV.loading = false; }
  },
  async open(name) {
    if (RV.doc && Object.keys(RV.counts).length && RV.doc.name !== name && !(await confirmSheet('Leave this receipt?', 'What you counted is not posted.', 'Leave', true))) return;
    go('receive'); RV.loading = true; RV.result = null; RV.counts = {}; RV.damaged = false; RV.dn = '';
    try { RV.doc = await api('inbound', 'get_purchase_order', { name }); flash('ok', `${RV.doc.name} · ${RV.doc.supplier_name}`); }
    catch (e) { flash('err', e.message); RV.doc = null; }
    finally { RV.loading = false; }
  },
  setup() {
    if (!RV.doc && !RV.pos) Receive.load();
    const c = counter(RV, ln => ln.pending);
    const counted = computed(() => c.list().length);
    handler.fn = async r => {
      if (r.kind === 'document' && r.action === 'receive') return Receive.open(r.name);
      if (!RV.doc) { flash('warn', 'Scan or choose a Purchase Order first'); return; }
      if (r.kind === 'item') return c.onItem(r);
      flash('err', 'Scan an item');
    };
    async function post() {
      const counts = c.list();
      const over = RV.doc.lines.filter(ln => c.total(ln) > ln.pending + 1e-9);
      const held = RV.doc.lines.filter(ln => (RV.counts[ln.line] || {}).good > 0 && (RV.doc.hold_all || ln.inspect));
      const lines = [over.length ? `${over.length} line${over.length === 1 ? ' is' : 's are'} more than the order still expects; ERPNext may refuse it.` : '',
        held.length ? `${held.length} item${held.length === 1 ? '' : 's'} go to the quality hold.` : ''].filter(Boolean).join(' ');
      if (!(await confirmSheet(`Receive against ${RV.doc.name}?`, lines || 'Posts a Purchase Receipt.', 'Receive', !!over.length))) return;
      RV.loading = true;
      try {
        const r = await api('inbound', 'receive', { purchase_order: RV.doc.name, counts, supplier_delivery_note: RV.dn || undefined, submit: 1 }, true);
        const name = r.name;
        RV.result = { title: r.submitted ? 'Received' : 'Receipt saved as draft', tone: r.submitted && !r.held.length ? 'ok' : 'warn',
          lines: [name, r.held.length ? `On quality hold: ${r.held.join(', ')}` : '', r.note || ''].filter(Boolean), url: r.url, again: 'Receive another',
          next: r.putaway_ready ? { label: 'Put it away', fn: () => W.core.putaway.fromDocument('Purchase Receipt', name, 1) } : null };
        feedback('ok'); cache.clear();
      } catch (e) { flash('err', e.message); }
      finally { RV.loading = false; }
    }
    async function back() {
      if (RV.doc && !RV.result) { if (counted.value && !(await confirmSheet('Leave this receipt?', 'What you counted is not posted.', 'Leave', true))) return; RV.doc = null; RV.counts = {}; if (!RV.pos) Receive.load(); return; }
      Receive.reset(); go('home');
    }
    return { RV, c, counted, post, back, fmt, open: n => Receive.open(n), search: () => Receive.load(),
      again: () => { Receive.reset(); Receive.load(); }, home: () => { Receive.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Receive" :sub="RV.doc && !RV.result ? RV.doc.name + ' · ' + RV.doc.supplier_name : ''" @back="back"/>
      <main class="ws-main">
        <Done v-if="RV.result" :result="RV.result" @again="again" @home="home"/>
        <template v-else-if="!RV.doc">
          <Prompt text="Scan a Purchase Order" hint="Or choose one still to receive. Oldest due first."/>
          <label class="ws-field"><span>Supplier or PO</span><input v-model="RV.txt" @keyup.enter="search" placeholder="Search" autocomplete="off"/></label>
          <div v-if="RV.loading" class="ws-muted">Loading…</div>
          <button v-for="p in RV.pos || []" :key="p.name" class="ws-line btn" @click="open(p.name)">
            <div><b>{{p.supplier_name || p.supplier}}</b><small>{{p.name}}<span v-if="p.schedule_date"> · due {{p.schedule_date}}</span> · {{Math.round(p.per_received || 0)}}% received</small></div>
            <div class="ws-num"><small>Open</small></div>
          </button>
          <div v-if="RV.pos && !RV.pos.length" class="ws-muted">No Purchase Orders waiting to be received.</div>
        </template>
        <template v-else>
          <div class="ws-seg" role="group" aria-label="Condition">
            <button :class="{on:!RV.damaged}" @click="RV.damaged=false">Good</button>
            <button :class="{on:RV.damaged}" @click="RV.damaged=true">Damaged</button>
          </div>
          <Prompt :text="RV.damaged ? 'Scan damaged items' : 'Scan each item that arrived'" :hint="RV.damaged ? 'Counted apart; they go to the Rejected warehouse.' : 'Each scan adds one; a box barcode adds the box. Tap a line to type.'" :tone="RV.damaged ? 'warn' : 'go'"/>
          <button v-for="ln in RV.doc.lines" :key="ln.line" class="ws-line btn" :class="{done: c.total(ln) >= ln.pending - 1e-9 && ln.pending > 0}" @click="c.type(ln)">
            <div><b>{{ln.item_code}}</b><small>{{ln.item_name}}<span v-if="ln.inspect || RV.doc.hold_all"> · quality hold</span></small>
              <small v-if="RV.counts[ln.line] && RV.counts[ln.line].damaged" class="ws-fefo">{{fmt(RV.counts[ln.line].damaged)}} damaged</small></div>
            <div class="ws-num">{{fmt((RV.counts[ln.line] || {}).good || 0)}}<small>/{{fmt(ln.pending)}} {{ln.uom}}</small></div>
          </button>
          <label class="ws-field"><span>Supplier's delivery note / invoice no.</span><input v-model="RV.dn" autocomplete="off" placeholder="Optional"/></label>
          <div v-if="!RV.doc.can_receive" class="ws-note">You can't create Purchase Receipts. Ask a Stock Manager.</div>
        </template>
      </main>
      <div v-if="RV.doc && !RV.result" class="ws-footer">
        <button class="ws-btn primary wide" :disabled="RV.loading || !counted || !RV.doc.can_receive" @click="post"><Icon name="receive"/> Receive {{counted}} line{{counted===1?'':'s'}}</button>
      </div>
    </div>`,
};

// ── Quality hold ──────────────────────────────────────────────
const QC = reactive({ data: null, loading: false });
const Quality = {
  components: { TopBar, Prompt, Icon },
  async load() {
    QC.loading = true;
    try { QC.data = await api('inbound', 'get_quality_hold', {}); }
    catch (e) { flash('err', e.message); QC.data = { items: [] }; }
    finally { QC.loading = false; }
  },
  setup() {
    if (!QC.data) Quality.load();
    handler.fn = async r => {
      if (r.kind !== 'item' || !QC.data) { flash('err', 'Scan an item on hold'); return; }
      const it = QC.data.items.find(x => x.item_code === r.item_code);
      if (!it) { flash('warn', `${r.item_code} isn't on quality hold`); return; }
      flash('ok', `${it.item_code}: ${fmt(it.qty)} ${it.uom} on hold`);
    };
    async function release(it) {
      const qty = await ask({ title: `Release ${it.item_code}`, sub: 'Passed checking: find a location for it', value: String(it.qty), unit: it.uom, ok: 'Put away', quick: [{ label: 'All ' + fmt(it.qty), value: it.qty }] });
      if (!qty || qty <= 0) return;
      if (qty > it.qty + 1e-9) { flash('err', `Only ${fmt(it.qty)} on hold`); return; }
      W.core.putaway.items([{ item_code: it.item_code, item_name: it.item_name, qty, from_warehouse: QC.data.warehouse }], 'Quality hold');
      QC.data = null;
    }
    async function reject(it) {
      if (!QC.data.rejected_warehouse) { flash('err', 'Set a Rejected warehouse in Warehouse Theatre Settings'); return; }
      const qty = await ask({ title: `Reject ${it.item_code}`, sub: `Moves it to ${QC.data.rejected_warehouse}`, value: String(it.qty), unit: it.uom, ok: 'Reject', quick: [{ label: 'All ' + fmt(it.qty), value: it.qty }] });
      if (!qty || qty <= 0) return;
      QC.loading = true;
      try { const r = await api('inbound', 'reject_held', { item_code: it.item_code, qty }, true); flash(r.docstatus ? 'ok' : 'warn', r.docstatus ? `Rejected · ${r.name}` : `Draft ${r.name}: add batch/serial in ERPNext`); await Quality.load(); }
      catch (e) { flash('err', e.message); }
      finally { QC.loading = false; }
    }
    return { QC, release, reject, fmt, back: () => { QC.data = null; go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Quality hold" :sub="QC.data && QC.data.warehouse ? QC.data.warehouse : ''" @back="back"/>
      <main class="ws-main">
        <div v-if="QC.loading && !QC.data" class="ws-muted">Loading…</div>
        <div v-else-if="QC.data && !QC.data.warehouse" class="ws-note">No Quality hold warehouse is set. A System Manager sets it in Warehouse Theatre Settings.</div>
        <template v-else-if="QC.data">
          <Prompt text="Check, then release or reject" hint="Release finds a location and puts it away; reject moves it to the Rejected warehouse."/>
          <div v-for="it in QC.data.items" :key="it.item_code" class="ws-card">
            <div class="ws-line" style="border:none;padding:0">
              <div><b>{{it.item_code}}</b><small>{{it.item_name}}<span v-if="it.since"> · since {{it.since}}</span></small></div>
              <div class="ws-num">{{fmt(it.qty)}} <small>{{it.uom}}</small></div>
            </div>
            <div class="ws-actions" style="margin-top:8px">
              <button class="ws-btn primary" :disabled="QC.loading" @click="release(it)">Release</button>
              <button class="ws-btn" :disabled="QC.loading" @click="reject(it)">Reject</button>
            </div>
          </div>
          <div v-if="!QC.data.items.length" class="ws-muted">Nothing on hold.</div>
        </template>
      </main>
    </div>`,
};

// ── Returns ───────────────────────────────────────────────────
const RT = reactive({ doc: null, counts: {}, damaged: false, reason: '', loading: false, result: null });
const Returns = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(RT, { doc: null, counts: {}, damaged: false, reason: '', loading: false, result: null }); },
  async open(doctype, name) {
    go('returns'); RT.loading = true; RT.result = null; RT.counts = {}; RT.damaged = false;
    try { RT.doc = await api('inbound', 'get_return_source', { doctype, name }); flash('ok', `${RT.doc.name} · ${RT.doc.customer_name || RT.doc.customer}`); }
    catch (e) { flash('err', e.message); RT.doc = null; }
    finally { RT.loading = false; }
  },
  setup() {
    const c = counter(RT, ln => ln.returnable);
    const counted = computed(() => c.list().length);
    handler.fn = async r => {
      if (r.kind === 'document' && (r.doctype === 'Delivery Note' || r.doctype === 'Sales Invoice')) {
        if (r.docstatus !== 1) { flash('warn', `${r.name} isn't submitted, so nothing went out on it`); return; }
        return Returns.open(r.doctype, r.name);
      }
      if (r.kind === 'carton') return Returns.open(r.doctype, r.name);
      if (!RT.doc) { flash('warn', 'Scan the Delivery Note or Sales Invoice first'); return; }
      if (r.kind === 'item') return c.onItem(r);
      flash('err', 'Scan an item');
    };
    async function post() {
      const over = RT.doc.lines.filter(ln => c.total(ln) > ln.returnable + 1e-9);
      if (over.length) { flash('err', `${over[0].item_code}: only ${fmt(over[0].returnable)} can come back`); return; }
      const sub = RT.doc.doctype === 'Delivery Note' ? (RT.doc.can_submit ? 'Submits a Delivery Note return; good goods go back into stock.' : 'Saved as a draft for someone who can submit it.')
        : 'Saved as a draft credit note (Sales Invoice return) for accounts to check and submit.';
      if (!(await confirmSheet(`Take back ${counted.value} line${counted.value === 1 ? '' : 's'}?`, sub, 'Make return'))) return;
      RT.loading = true;
      try {
        const r = await api('inbound', 'make_return', { doctype: RT.doc.doctype, name: RT.doc.name, counts: c.list(), reason: RT.reason || undefined, submit: RT.doc.can_submit ? 1 : 0 }, true);
        const back = r.submitted && r.good > 0 && r.to_warehouse;
        const goods = RT.doc.lines.filter(ln => (RT.counts[ln.line] || {}).good > 0).map(ln => ({ item_code: ln.item_code, item_name: ln.item_name, qty: RT.counts[ln.line].good * (ln.factor || 1), from_warehouse: r.to_warehouse }));
        RT.result = { title: r.submitted ? 'Return posted' : 'Return saved as draft', tone: r.submitted ? 'ok' : 'warn',
          lines: [r.name, r.good ? `${fmt(r.good)} good` + (r.to_warehouse ? ` → ${r.to_warehouse}` : ' → back where it came from') : '', r.damaged ? `${fmt(r.damaged)} damaged → rejected` : ''].filter(Boolean),
          url: r.url, again: 'Another return',
          next: back ? { label: 'Put the good goods away', fn: () => W.core.putaway.items(goods, 'Returns') } : null };
        feedback('ok'); cache.clear();
      } catch (e) { flash('err', e.message); }
      finally { RT.loading = false; }
    }
    async function back() {
      if (RT.doc && !RT.result) { if (counted.value && !(await confirmSheet('Leave this return?', 'What you counted is not saved.', 'Leave', true))) return; RT.doc = null; RT.counts = {}; return; }
      Returns.reset(); go('home');
    }
    return { RT, c, counted, post, back, fmt, again: () => Returns.reset(), home: () => { Returns.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Returns" :sub="RT.doc && !RT.result ? RT.doc.name + ' · ' + (RT.doc.customer_name || RT.doc.customer) : ''" @back="back"/>
      <main class="ws-main">
        <Done v-if="RT.result" :result="RT.result" @again="again" @home="home"/>
        <template v-else-if="!RT.doc">
          <Prompt text="Scan the Delivery Note or Sales Invoice" hint="Or a carton label from the original shipment."/>
          <div v-if="RT.loading" class="ws-muted">Loading…</div>
        </template>
        <template v-else>
          <div class="ws-seg" role="group" aria-label="Condition">
            <button :class="{on:!RT.damaged}" @click="RT.damaged=false">Good</button>
            <button :class="{on:RT.damaged}" @click="RT.damaged=true">Damaged</button>
          </div>
          <Prompt :text="RT.damaged ? 'Scan damaged items' : 'Scan each returned item'" :hint="RT.damaged ? 'They go to the Rejected warehouse.' : 'Good items go back into stock. Tap a line to type.'" :tone="RT.damaged ? 'warn' : 'go'"/>
          <button v-for="ln in RT.doc.lines" :key="ln.line" class="ws-line btn" @click="c.type(ln)" :disabled="ln.returnable <= 0">
            <div><b>{{ln.item_code}}</b><small>{{ln.item_name}}<span v-if="ln.returned"> · {{fmt(ln.returned)}} already returned</span></small>
              <small v-if="RT.counts[ln.line] && RT.counts[ln.line].damaged" class="ws-fefo">{{fmt(RT.counts[ln.line].damaged)}} damaged</small></div>
            <div class="ws-num">{{fmt((RT.counts[ln.line] || {}).good || 0)}}<small>/{{fmt(ln.returnable)}} {{ln.uom}}</small></div>
          </button>
          <label class="ws-field"><span>Reason</span><input v-model="RT.reason" autocomplete="off" placeholder="e.g. wrong size, damaged in transit"/></label>
        </template>
      </main>
      <div v-if="RT.doc && !RT.result" class="ws-footer">
        <button class="ws-btn primary wide" :disabled="RT.loading || !counted" @click="post"><Icon name="returns"/> Make return</button>
      </div>
    </div>`,
};

EXT.screens.receive = Receive;
EXT.screens.quality = Quality;
EXT.screens.returns = Returns;
EXT.tiles.push(
  { id: 'receive', title: 'Receive', sub: 'Against a Purchase Order', needsFloor: false, open: () => { Receive.reset(); go('receive'); } },
  { id: 'quality', title: 'Quality hold', sub: 'Release or reject', needsFloor: false, open: () => { QC.data = null; go('quality'); } },
  { id: 'returns', title: 'Returns', sub: 'Customer returns', needsFloor: false, open: () => { Returns.reset(); go('returns'); } },
);
EXT.docActions.receive = r => Receive.open(r.name);
EXT.links.receive = v => Receive.open(v);
EXT.links.return = (v, q) => Returns.open(q.get('doctype') || 'Delivery Note', v);
W.core.inbound = { Receive, Quality, Returns, RV, QC, RT };
})();
