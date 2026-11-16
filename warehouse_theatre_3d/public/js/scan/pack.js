/* Warehouse Scan — Pack and Dispatch.
   Pack: open a picked order, scan items into cartons, close each carton, print carton labels.
   Dispatch: scan the order or a carton label, tick every carton onto the vehicle, enter the
   transporter, LR and vehicle numbers, and submit the Delivery Note / Sales Invoice.
   Server: api/packing.py. Registers with the scanner core (wt-scan.js) before mount. */
(function () {
'use strict';
const W = window.WarehouseScan;
if (!W || !W.core) return;
const { S, EXT, api, flash, feedback, ask, confirmSheet, go, handler, prefs, fmt, loadScript, QR_URL, cache } = W.core;
const { TopBar, Prompt, Icon, Done } = W.core.components;
const { reactive, computed } = Vue;

const hrs = h => h === null || h === undefined ? '' : h < 1 ? 'just now' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd';

// ── Pack ──────────────────────────────────────────────────────
const PK = reactive({ queue: null, doc: null, carton: {}, loading: false, result: null, labels: null, qrReady: false });

function remaining(ln) { return Math.max(0, +(ln.qty - ln.packed - (PK.carton[ln.line] || 0)).toFixed(6)); }

const Pack = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(PK, { queue: null, doc: null, carton: {}, loading: false, result: null, labels: null }); },
  async loadQueue() {
    PK.loading = true;
    try { PK.queue = await api('packing', 'get_pack_queue', { floor: S.floor || undefined }); }
    catch (e) { flash('err', e.message); PK.queue = []; }
    finally { PK.loading = false; }
  },
  async open(args, quiet) {
    if (PK.doc && Object.keys(PK.carton).length) {
      if (!(await confirmSheet('Leave this carton?', 'Items in the open carton are not saved yet.', 'Leave', true))) return;
    }
    go('pack'); PK.loading = true; PK.result = null; PK.carton = {}; PK.labels = null;
    try {
      PK.doc = args.doctype ? await api('packing', 'get_pack_state', args) : await api('packing', 'start_pack', args, true);
      if (!quiet) flash(PK.doc.docstatus === 0 ? 'ok' : 'warn', PK.doc.docstatus === 0 ? PK.doc.name : PK.doc.name + ' is already dispatched');
      cache.clear();
    } catch (e) { flash('err', e.message); PK.doc = null; if (!PK.queue) Pack.loadQueue(); }
    finally { PK.loading = false; }
  },
  setup() {
    if (!PK.doc && !PK.queue) Pack.loadQueue();
    const d = computed(() => PK.doc);
    const inCarton = computed(() => Object.values(PK.carton).reduce((a, b) => a + b, 0));
    const next = computed(() => d.value ? (d.value.cartons.reduce((m, c) => Math.max(m, c.no), 0) + 1) : 1);
    const allPacked = computed(() => d.value && d.value.lines.every(ln => ln.packed + 1e-9 >= ln.qty));

    function add(ln, qty) {
      if (!d.value.can_pack) { flash('warn', "You can't pack this document"); return; }
      const left = remaining(ln);
      if (left <= 1e-9) { flash('warn', `${ln.item_code} is fully packed`); return; }
      const q = Math.min(qty, left);
      PK.carton[ln.line] = +((PK.carton[ln.line] || 0) + q).toFixed(6);
      flash(q < qty ? 'warn' : 'ok', `${fmt(PK.carton[ln.line])} ${ln.uom} ${ln.item_code} in carton ${next.value}` + (q < qty ? ' (line full)' : ''));
    }
    async function typeQty(ln) {
      if (!d.value.can_pack) return;
      const have = PK.carton[ln.line] || 0;
      const v = await ask({ title: `${ln.item_code} in carton ${next.value}`, sub: `${fmt(ln.qty - ln.packed)} ${ln.uom} left to pack`,
        value: String(have || remaining(ln)), unit: ln.uom, ok: 'Set',
        quick: [{ label: 'All left ' + fmt(ln.qty - ln.packed), value: +(ln.qty - ln.packed).toFixed(6) }, { label: 'None', value: 0 }] });
      if (v === null) return;
      if (v > ln.qty - ln.packed + 1e-9) { flash('err', `Only ${fmt(ln.qty - ln.packed)} ${ln.uom} left`); return; }
      if (v <= 0) delete PK.carton[ln.line]; else PK.carton[ln.line] = v;
    }

    handler.fn = async r => {
      if (r.kind === 'document' && (r.action === 'pack' || r.action === 'pick')) {
        return Pack.open(r.action === 'pick' ? { pick_list: r.name } : { doctype: r.doctype, name: r.name });
      }
      if (r.kind === 'carton') return Pack.open({ doctype: r.doctype, name: r.name });
      if (!d.value) { flash('warn', 'Scan a Pick List, Delivery Note or Sales Invoice first'); return; }
      if (r.kind !== 'item') { flash('err', 'Scan an item to pack it'); return; }
      const cands = d.value.lines.filter(ln => ln.item_code === r.item_code);
      if (!cands.length) { flash('err', `${r.item_code} isn't on ${d.value.name}`); return; }
      if (r.batch_no && cands.every(ln => ln.batch_no && ln.batch_no !== r.batch_no)) { flash('err', `Wrong batch: this order has ${cands.map(c => c.batch_no).join(', ')}`); return; }
      const ln = cands.find(c => remaining(c) > 1e-9 && (!r.batch_no || !c.batch_no || c.batch_no === r.batch_no)) || cands[0];
      // A pack barcode (box of 12, in stock units) counts as that many line units.
      const units = r.factor > 1 ? r.factor / (ln.factor || 1) : 1;
      add(ln, units);
    };

    async function closeCarton() {
      const lines = Object.entries(PK.carton).filter(([, q]) => q > 0).map(([line, qty]) => ({ line, qty }));
      if (!lines.length) { flash('warn', 'Scan items into the carton first'); return; }
      const weight = await ask({ title: `Close carton ${next.value}`, sub: 'Gross weight, optional', value: '', unit: 'kg', ok: 'Close carton' });
      if (weight === null && !(await confirmSheet(`Close carton ${next.value}?`, 'Without a weight.', 'Close carton'))) return;
      PK.loading = true;
      try {
        PK.doc = await api('packing', 'save_carton', { doctype: d.value.doctype, name: d.value.name, lines, weight: weight || undefined }, true);
        PK.carton = {}; feedback('ok'); flash('ok', `Carton ${next.value - 1} closed`);
        if (PK.doc.progress.done === PK.doc.progress.lines) flash('ok', 'Everything is packed. Print labels, then dispatch.');
      } catch (e) { flash('err', e.message); }
      finally { PK.loading = false; }
    }
    async function removeCarton(c) {
      if (!(await confirmSheet(`Unpack carton ${c.no}?`, d.value.doctype === 'Delivery Note' ? `Cancels Packing Slip ${c.ref}. Its items go back to “to pack”.` : 'Its items go back to “to pack”.', 'Unpack', true))) return;
      PK.loading = true;
      try { PK.doc = await api('packing', 'remove_carton', { doctype: d.value.doctype, name: d.value.name, no: c.no }, true); flash('ok', `Carton ${c.no} unpacked`); }
      catch (e) { flash('err', e.message); }
      finally { PK.loading = false; }
    }
    async function printLabels() {
      if (!d.value.cartons.length) { flash('warn', 'Close a carton first'); return; }
      PK.loading = true;
      try {
        PK.labels = await api('packing', 'get_carton_labels', { doctype: d.value.doctype, name: d.value.name });
        await loadScript(QR_URL); PK.qrReady = true;
        setTimeout(() => window.print(), 150);
      } catch (e) { flash('err', e.message); }
      finally { PK.loading = false; }
    }
    function qr(text) {
      if (!PK.qrReady || !window.qrcode) return '';
      const q = window.qrcode(0, 'M'); q.addData(text, 'Byte'); q.make();
      return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    }
    function dispatchNow() { Dispatch.open({ doctype: d.value.doctype, name: d.value.name }); }
    async function back() {
      if (Object.keys(PK.carton).length && !(await confirmSheet('Leave this carton?', 'Items in the open carton are not saved yet.', 'Leave', true))) return;
      if (PK.doc) { PK.doc = null; PK.carton = {}; Pack.loadQueue(); return; }
      Pack.reset(); go('home');
    }
    async function openQueued(o) {
      if (o.docs.length) return Pack.open({ doctype: o.docs[0].doctype, name: o.docs[0].name });
      if (!(await confirmSheet(`Start packing ${o.pick_list}?`, 'Creates the draft dispatch document (Delivery Note or Sales Invoice, as set in Warehouse Theatre Settings).', 'Start packing'))) return;
      return Pack.open({ pick_list: o.pick_list });
    }
    return { S, PK, d, inCarton, next, allPacked, remaining, typeQty, closeCarton, removeCarton, printLabels, qr, dispatchNow, back, openQueued, fmt, hrs,
      clearCarton: () => { PK.carton = {}; }, again: () => { Pack.reset(); Pack.loadQueue(); }, home: () => { Pack.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Pack" :sub="PK.doc ? PK.doc.name + ' · ' + PK.doc.customer_name : ''" @back="back"/>
      <main class="ws-main no-print">
        <template v-if="!d">
          <Prompt text="Scan a Pick List" hint="Or a Delivery Note or Sales Invoice. Picked orders waiting to be packed are below."/>
          <div v-if="PK.loading" class="ws-muted">Loading…</div>
          <button v-for="o in PK.queue || []" :key="o.pick_list" class="ws-line btn" @click="openQueued(o)">
            <div><b>{{o.customer || o.pick_list}}</b><small>{{o.pick_list}} · {{o.lines}} lines · {{o.stage === 'packed' ? 'packed, not dispatched' : 'picked ' + hrs(o.hours) + ' ago'}}<span v-if="o.docs.length"> · {{o.docs[0].name}}</span></small></div>
            <div class="ws-num"><small>{{o.docs.length ? 'Open' : 'Start'}}</small></div>
          </button>
          <div v-if="PK.queue && !PK.queue.length" class="ws-muted">Nothing waiting. Orders show here once their Pick List is submitted.</div>
        </template>
        <template v-else>
          <div class="ws-card hero">
            <div class="ws-kicker">{{d.doctype}} · {{d.pick_lists.join(', ') || d.name}}</div>
            <div class="ws-big">{{d.customer_name}}</div>
            <div v-if="d.address" class="ws-muted ws-addr">{{d.address}}</div>
          </div>
          <div class="ws-progress"><span :style="{width: (100 * d.progress.packed / Math.max(1e-9, d.progress.qty)) + '%'}"></span></div>
          <div class="ws-muted small">{{d.progress.done}} of {{d.progress.lines}} lines packed · {{d.cartons.length}} carton{{d.cartons.length===1?'':'s'}} closed</div>
          <template v-if="d.docstatus === 0">
            <Prompt v-if="!allPacked" :text="'Scan items into carton ' + next" :hint="inCarton ? fmt(inCarton) + ' in this carton so far. Tap a line to type a quantity.' : 'Each scan adds one. A box barcode adds the whole box.'" tone="go"/>
            <Prompt v-else text="All packed" hint="Print the carton labels, then dispatch." tone="go"/>
            <div class="ws-h">Lines</div>
            <button v-for="ln in d.lines" :key="ln.line" class="ws-line btn" :class="{done: ln.packed + 1e-9 >= ln.qty}" @click="typeQty(ln)">
              <div><b>{{ln.item_code}}</b><small>{{ln.item_name}}<span v-if="ln.batch_no"> · batch {{ln.batch_no}}</span></small></div>
              <div class="ws-num">
                <span v-if="PK.carton[ln.line]" class="ws-chip on">+{{fmt(PK.carton[ln.line])}}</span>
                {{fmt(ln.packed)}}<small>/{{fmt(ln.qty)}} {{ln.uom}}</small>
              </div>
            </button>
          </template>
          <template v-if="d.cartons.length">
            <div class="ws-h">Cartons</div>
            <div v-for="c in d.cartons" :key="c.no" class="ws-line">
              <div><b>Carton {{c.no}}</b><small>{{c.lines.length}} line{{c.lines.length===1?'':'s'}} · {{fmt(c.lines.reduce((a, l) => a + l.qty, 0))}} units<span v-if="c.weight"> · {{fmt(c.weight)}} kg</span><span v-if="c.ref"> · {{c.ref}}</span></small></div>
              <button v-if="d.docstatus === 0 && d.can_pack" class="ws-x" :aria-label="'Unpack carton ' + c.no" @click="removeCarton(c)">×</button>
            </div>
          </template>
          <div class="ws-actions">
            <button class="ws-btn" :disabled="PK.loading || !d.cartons.length" @click="printLabels"><Icon name="print"/> Carton labels</button>
            <button v-if="d.docstatus === 0" class="ws-btn" :disabled="!d.can_dispatch" @click="dispatchNow" :title="d.can_dispatch ? '' : 'You can\\'t submit this document'"><Icon name="dispatch"/> Dispatch</button>
            <a class="ws-btn ghost" :href="d.url" target="_blank" rel="noopener">Open in ERPNext ↗</a>
          </div>
        </template>
      </main>
      <div v-if="d && d.docstatus === 0 && d.can_pack && !allPacked" class="ws-footer two no-print">
        <button class="ws-btn" :disabled="!inCarton" @click="clearCarton">Empty carton</button>
        <button class="ws-btn primary" :disabled="PK.loading || !inCarton" @click="closeCarton">Close carton {{next}}</button>
      </div>
      <div v-if="PK.labels" class="ws-print carton" aria-hidden="true">
        <div v-for="c in PK.labels.cartons" :key="c.code" class="ws-clabel">
          <div class="ws-clabel-from">{{PK.labels.company}}</div>
          <div class="ws-clabel-to">To</div>
          <div class="ws-clabel-cust">{{PK.labels.customer_name}}</div>
          <div class="ws-clabel-addr">{{PK.labels.address}}</div>
          <div class="ws-clabel-row">
            <div class="ws-clabel-qr" v-html="qr(c.code)"></div>
            <div>
              <div class="ws-clabel-no">{{c.no}} <small>of {{c.of}}</small></div>
              <div class="ws-clabel-meta">{{c.units}} units<span v-if="c.weight"> · {{c.weight}} kg</span></div>
              <div class="ws-clabel-meta">{{PK.labels.name}}</div>
              <div v-if="PK.labels.lr_no" class="ws-clabel-meta">LR {{PK.labels.lr_no}}</div>
              <div v-if="PK.labels.date" class="ws-clabel-meta">{{PK.labels.date}}</div>
            </div>
          </div>
          <div class="ws-clabel-items"><span v-for="it in c.items" :key="it.item_code">{{it.item_code}} × {{it.qty}} {{it.uom}}</span></div>
          <div class="ws-clabel-code">{{c.code}}</div>
        </div>
      </div>
    </div>`,
};

// ── Dispatch ──────────────────────────────────────────────────
const DP = reactive({
  queue: null, doc: null, scanned: {}, loading: false, result: null,
  form: { transporter_name: prefs.get('transporter', ''), lr_no: '', vehicle_no: prefs.get('vehicle', '') },
});

const Dispatch = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(DP, { queue: null, doc: null, scanned: {}, loading: false, result: null }); DP.form.lr_no = ''; },
  async loadQueue() {
    DP.loading = true;
    try { DP.queue = await api('packing', 'get_dispatch_queue', { floor: S.floor || undefined }); }
    catch (e) { flash('err', e.message); DP.queue = []; }
    finally { DP.loading = false; }
  },
  async open(args, carton) {
    go('dispatch'); DP.loading = true; DP.result = null;
    try {
      if (!DP.doc || DP.doc.name !== args.name) { DP.scanned = {}; DP.form.lr_no = ''; }
      DP.doc = await api('packing', 'get_pack_state', args);
      const t = DP.doc.transport || {};
      if (t.lr_no) DP.form.lr_no = t.lr_no;
      if (t.transporter_name) DP.form.transporter_name = t.transporter_name;
      if (t.vehicle_no) DP.form.vehicle_no = t.vehicle_no;
      if (DP.doc.docstatus !== 0) flash('warn', DP.doc.name + ' is already dispatched');
      else if (carton) Dispatch.tick(carton);
      else flash('ok', DP.doc.name);
    } catch (e) { flash('err', e.message); DP.doc = null; if (!DP.queue) Dispatch.loadQueue(); }
    finally { DP.loading = false; }
  },
  tick(no) {
    const c = DP.doc.cartons.find(x => x.no === no);
    if (!c) { flash('err', `${DP.doc.name} has no carton ${no}`); return; }
    if (DP.scanned[no]) { flash('warn', `Carton ${no} already loaded`); return; }
    DP.scanned[no] = true;
    const left = DP.doc.cartons.length - Object.keys(DP.scanned).length;
    flash('ok', left ? `Carton ${no} loaded · ${left} to go` : 'All cartons loaded');
  },
  setup() {
    if (!DP.doc && !DP.queue) Dispatch.loadQueue();
    const d = computed(() => DP.doc);
    const loaded = computed(() => Object.keys(DP.scanned).length);
    const notPacked = computed(() => d.value ? d.value.lines.filter(ln => ln.packed + 1e-9 < ln.qty).length : 0);
    const blocked = computed(() => !!(d.value && d.value.require_carton_scan && d.value.cartons.length && loaded.value < d.value.cartons.length));

    handler.fn = async r => {
      if (r.kind === 'carton') {
        if (d.value && d.value.name === r.name) return Dispatch.tick(r.no);
        if (d.value && loaded.value && !(await confirmSheet('Switch order?', `Carton ${r.code} belongs to ${r.name}, not ${d.value.name}.`, 'Switch', true))) return;
        return Dispatch.open({ doctype: r.doctype, name: r.name }, r.no);
      }
      if (r.kind === 'document' && r.action === 'pack') return Dispatch.open({ doctype: r.doctype, name: r.name });
      if (r.kind === 'document' && r.action === 'pick') {
        const q = DP.queue || (await api('packing', 'get_dispatch_queue', {}));
        const o = q.find(x => x.pick_list === r.name);
        if (o && o.docs.length) return Dispatch.open({ doctype: o.docs[0].doctype, name: o.docs[0].name });
        flash('warn', `${r.name} has nothing ready to dispatch. Pack it first.`); return;
      }
      flash('err', 'Scan a carton label, Delivery Note or Sales Invoice');
    };

    async function send() {
      const f = DP.form;
      const warn = [
        notPacked.value ? `${notPacked.value} line${notPacked.value === 1 ? ' is' : 's are'} not packed in a carton.` : '',
        d.value.cartons.length && loaded.value < d.value.cartons.length ? `${d.value.cartons.length - loaded.value} carton${d.value.cartons.length - loaded.value === 1 ? '' : 's'} not scanned onto the vehicle.` : '',
        !f.lr_no ? 'No LR / AWB number.' : '',
      ].filter(Boolean);
      const ok = await confirmSheet(`Dispatch ${d.value.name}?`, (warn.length ? warn.join(' ') + ' ' : '') + `Submits the ${d.value.doctype}; stock leaves the warehouse.`, 'Dispatch', !!warn.length);
      if (!ok) return;
      DP.loading = true;
      try {
        const r = await api('packing', 'dispatch', { doctype: d.value.doctype, name: d.value.name, transporter_name: f.transporter_name, lr_no: f.lr_no, vehicle_no: f.vehicle_no }, true);
        prefs.set('transporter', f.transporter_name || ''); prefs.set('vehicle', f.vehicle_no || '');
        DP.result = { title: 'Dispatched', lines: [r.customer_name, `${r.name} submitted`, r.cartons ? `${r.cartons} carton${r.cartons === 1 ? '' : 's'}` : '', f.lr_no ? 'LR ' + f.lr_no : ''].filter(Boolean),
          url: r.url, again: 'Dispatch another', tone: warn.length ? 'warn' : 'ok' };
        feedback('ok'); cache.clear();
      } catch (e) { flash('err', e.message); }
      finally { DP.loading = false; }
    }
    function back() { if (DP.doc && !DP.result) { DP.doc = null; DP.scanned = {}; Dispatch.loadQueue(); return; } Dispatch.reset(); go('home'); }
    return { S, DP, d, loaded, notPacked, blocked, send, back, fmt, hrs,
      open: o => Dispatch.open({ doctype: o.docs[0].doctype, name: o.docs[0].name }),
      again: () => { Dispatch.reset(); Dispatch.loadQueue(); }, home: () => { Dispatch.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Dispatch" :sub="d && !DP.result ? d.name + ' · ' + d.customer_name : ''" @back="back"/>
      <main class="ws-main">
        <Done v-if="DP.result" :result="DP.result" @again="again" @home="home"/>
        <template v-else-if="!d">
          <Prompt text="Scan a carton label" hint="Or a Delivery Note or Sales Invoice. Orders ready to go are below."/>
          <div v-if="DP.loading" class="ws-muted">Loading…</div>
          <button v-for="o in DP.queue || []" :key="o.pick_list" class="ws-line btn" @click="open(o)">
            <div><b>{{o.customer || o.pick_list}}</b><small>{{o.docs[0].name}} · {{o.stage}} {{hrs(o.hours)}} ago</small></div>
            <div class="ws-num"><small>Open</small></div>
          </button>
          <div v-if="DP.queue && !DP.queue.length" class="ws-muted">Nothing ready. Pack an order first.</div>
        </template>
        <template v-else>
          <div class="ws-card hero">
            <div class="ws-kicker">{{d.doctype}} · {{d.name}}</div>
            <div class="ws-big">{{d.customer_name}}</div>
            <div v-if="d.address" class="ws-muted ws-addr">{{d.address}}</div>
          </div>
          <div v-if="d.docstatus !== 0" class="ws-note">Already dispatched.</div>
          <template v-else>
            <div v-if="notPacked" class="ws-note">{{notPacked}} line{{notPacked===1?' is':'s are'}} not in a carton yet.</div>
            <template v-if="d.cartons.length">
              <div class="ws-h">Cartons · {{loaded}} of {{d.cartons.length}} loaded</div>
              <div class="ws-progress"><span :style="{width: (100 * loaded / d.cartons.length) + '%'}"></span></div>
              <div class="ws-row2 wrap">
                <span v-for="c in d.cartons" :key="c.no" class="ws-chip" :class="{on: DP.scanned[c.no]}">{{DP.scanned[c.no] ? '✓ ' : ''}}{{c.no}}</span>
              </div>
              <Prompt v-if="loaded < d.cartons.length" text="Scan each carton as it goes on the vehicle" :hint="d.require_carton_scan ? 'Every carton must be scanned before dispatch.' : 'Optional, but catches a carton left behind.'" tone="go"/>
            </template>
            <div class="ws-h">Transport</div>
            <label class="ws-field"><span>Transporter</span><input v-model="DP.form.transporter_name" autocomplete="off" placeholder="e.g. VRL Logistics"/></label>
            <label class="ws-field"><span>LR / AWB number</span><input v-model="DP.form.lr_no" autocomplete="off" placeholder="Consignment number"/></label>
            <label class="ws-field"><span>Vehicle number</span><input v-model="DP.form.vehicle_no" autocomplete="off" placeholder="e.g. TN 63 AB 1234" style="text-transform:uppercase"/></label>
            <div v-if="!d.can_dispatch" class="ws-note">You can't submit this {{d.doctype}}. Ask someone who can, or open it in ERPNext.</div>
          </template>
        </template>
      </main>
      <div v-if="d && !DP.result && d.docstatus === 0" class="ws-footer">
        <button class="ws-btn primary wide" :disabled="DP.loading || !d.can_dispatch || blocked" @click="send"><Icon name="dispatch"/> {{blocked ? 'Scan all cartons first' : 'Dispatch'}}</button>
      </div>
    </div>`,
};

// ── Register ──────────────────────────────────────────────────
EXT.screens.pack = Pack;
EXT.screens.dispatch = Dispatch;
EXT.tiles.push(
  { id: 'pack', title: 'Pack', sub: 'Items into cartons', open: () => { Pack.reset(); go('pack'); } },
  { id: 'dispatch', title: 'Dispatch', sub: 'Load and ship', open: () => { Dispatch.reset(); go('dispatch'); } },
);
// A Delivery Note or Sales Invoice scanned from home: pack it while it has lines left, else dispatch.
EXT.docActions.pack = async r => {
  if (r.docstatus !== 0) { flash('warn', `${r.name} is already dispatched`); return; }
  await Pack.open({ doctype: r.doctype, name: r.name }, true);
  if (PK.doc && PK.doc.lines.every(ln => ln.packed + 1e-9 >= ln.qty)) { Pack.reset(); await Dispatch.open({ doctype: r.doctype, name: r.name }); }
  else if (PK.doc) flash('ok', PK.doc.name);
};
EXT.kinds.carton = r => r.docstatus === 0 ? Dispatch.open({ doctype: r.doctype, name: r.name }, r.no) : flash('warn', `${r.name} is already dispatched`);
// Links from ERPNext forms: ?pack=PICK_LIST or ?pack=DN&doctype=Delivery Note, ?dispatch=NAME&doctype=...
EXT.links.pack = (v, q) => Pack.open(q.get('doctype') ? { doctype: q.get('doctype'), name: v } : { pick_list: v });
EXT.links.dispatch = (v, q) => Dispatch.open({ doctype: q.get('doctype') || 'Delivery Note', name: v });
// After a Pick List is submitted in Pick: offer to pack it straight away.
EXT.afterPick = name => ({ label: 'Pack it now', fn: () => { Pack.reset(); Pack.open({ pick_list: name }); } });
W.core.pack = { Pack, Dispatch, PK, DP };
})();
