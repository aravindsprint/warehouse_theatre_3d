/* Warehouse Scan — Pallets.
   Build a pallet (scan its location, then what's on it), print its label, and later move
   everything on it by scanning the label and the new location: one Material Transfer.
   Server: api/pallets.py. Registers with the scanner core (wt-scan.js) before mount. */
(function () {
'use strict';
const W = window.WarehouseScan;
if (!W || !W.core) return;
const { EXT, api, flash, feedback, ask, confirmSheet, go, handler, fmt, cache, loadScript, QR_URL } = W.core;
const { TopBar, Prompt, Icon, Done } = W.core.components;
const { reactive, computed } = Vue;

const PL = reactive({ mode: 'scan', pallet: null, at: null, rows: [], moving: false, loading: false, result: null, print: false, qrReady: false });

const Pallets = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(PL, { mode: 'scan', pallet: null, at: null, rows: [], moving: false, loading: false, result: null, print: false }); },
  async open(name) {
    go('pallets'); PL.loading = true; PL.result = null; PL.mode = 'view'; PL.moving = false;
    try { PL.pallet = await api('pallets', 'get_pallet', { name }); flash(PL.pallet.short.length ? 'warn' : 'ok', PL.pallet.short.length ? `${name}: contents don't match the shelf` : `${name} at ${PL.pallet.path}`); }
    catch (e) { flash('err', e.message); PL.mode = 'scan'; }
    finally { PL.loading = false; }
  },
  setup() {
    const units = computed(() => PL.rows.reduce((a, r) => a + r.qty, 0));
    function addItem(r) {
      const row = PL.rows.find(x => x.item_code === r.item_code && (x.batch_no || null) === (r.batch_no || null));
      const qty = r.factor > 1 ? r.factor : 1;
      if (row) row.qty = +(row.qty + qty).toFixed(6);
      else PL.rows.push({ item_code: r.item_code, item_name: r.item_name, uom: r.stock_uom || r.uom || '', batch_no: r.batch_no || null, qty });
      const now = PL.rows.find(x => x.item_code === r.item_code && (x.batch_no || null) === (r.batch_no || null));
      flash('ok', `${fmt(now.qty)} ${r.item_code}${r.batch_no ? ' · ' + r.batch_no : ''}`);
    }
    async function type(row) {
      const v = await ask({ title: row.item_code, sub: row.batch_no ? 'Batch ' + row.batch_no : 'On this pallet', value: String(row.qty), unit: row.uom, ok: 'Set', quick: [{ label: 'Remove', value: 0 }] });
      if (v === null) return;
      if (v <= 0) PL.rows.splice(PL.rows.indexOf(row), 1); else row.qty = v;
    }
    handler.fn = async r => {
      if (r.kind === 'pallet') {
        if (PL.mode === 'build' && PL.rows.length) { flash('warn', 'Save or clear this pallet first'); return; }
        return Pallets.open(r.name);
      }
      if (PL.mode === 'view' && PL.moving) {
        if (r.kind !== 'location') { flash('err', 'Scan the location to move it to'); return; }
        return move(r);
      }
      if (PL.mode === 'build') {
        if (r.kind === 'location') { PL.at = r; flash('ok', `Pallet at ${r.path}`); return; }
        if (r.kind === 'item') { if (!PL.at) { flash('warn', 'Scan the pallet\'s location first'); return; } return addItem(r); }
      }
      if (PL.mode === 'scan') {
        if (r.kind === 'location') { PL.mode = 'build'; PL.rows = []; PL.at = r; flash('ok', `New pallet at ${r.path}`); return; }
      }
      flash('err', 'Scan a pallet label, or a location to start a new pallet');
    };
    async function save() {
      PL.loading = true;
      try {
        PL.pallet = await api('pallets', 'save_pallet', { warehouse: PL.at.warehouse, contents: PL.rows.map(r => ({ item_code: r.item_code, qty: r.qty, batch_no: r.batch_no })), name: PL.pallet && PL.mode === 'build' && PL.pallet.warehouse === PL.at.warehouse ? PL.pallet.name : undefined }, true);
        PL.mode = 'view'; PL.rows = []; feedback('ok'); flash('ok', `${PL.pallet.name} saved. Print its label.`);
      } catch (e) { flash('err', e.message); }
      finally { PL.loading = false; }
    }
    async function move(loc) {
      const p = PL.pallet;
      if (loc.warehouse === p.warehouse) { flash('warn', `${p.name} is already at ${loc.path}`); return; }
      if (!(await confirmSheet(`Move ${p.name} to ${loc.path}?`, `${p.contents.length} item${p.contents.length === 1 ? '' : 's'} from ${p.path}. Posts one Material Transfer.`, 'Move'))) return;
      PL.loading = true;
      try {
        const r = await api('pallets', 'move_pallet', { name: p.name, target: loc.warehouse, submit: 1 }, true);
        PL.pallet = r.pallet; PL.moving = false;
        PL.result = { title: r.submitted ? 'Pallet moved' : 'Move saved as draft', tone: r.submitted ? 'ok' : 'warn',
          lines: [`${p.name} → ${loc.path}`, r.stock_entry, r.submitted ? '' : 'Finish the batch / serial numbers in ERPNext.'].filter(Boolean), url: r.url, again: 'Another pallet' };
        feedback('ok'); cache.clear();
      } catch (e) { flash('err', e.message); }
      finally { PL.loading = false; }
    }
    async function empty() {
      if (!(await confirmSheet(`Empty ${PL.pallet.name}?`, 'The pallet was broken up. The stock stays where it is; only the pallet record is cleared.', 'Empty', true))) return;
      try { PL.pallet = await api('pallets', 'empty_pallet', { name: PL.pallet.name }, true); flash('ok', 'Pallet emptied'); }
      catch (e) { flash('err', e.message); }
    }
    function edit() {
      PL.mode = 'build'; PL.at = { warehouse: PL.pallet.warehouse, path: PL.pallet.path };
      PL.rows = PL.pallet.contents.map(c => ({ ...c }));
    }
    async function label() {
      try { await loadScript(QR_URL); PL.qrReady = true; PL.print = true; setTimeout(() => window.print(), 150); }
      catch (e) { flash('err', e.message); }
    }
    function qr(text) {
      if (!PL.qrReady || !window.qrcode) return '';
      const q = window.qrcode(0, 'M'); q.addData(text, 'Byte'); q.make();
      return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    }
    function back() {
      if (PL.mode === 'build' && PL.rows.length) { confirmSheet('Discard this pallet?', 'What you scanned is not saved.', 'Discard', true).then(ok => { if (ok) Pallets.reset(); }); return; }
      if (PL.mode !== 'scan' && !PL.result) { Pallets.reset(); return; }
      Pallets.reset(); go('home');
    }
    return { PL, units, type, save, empty, edit, label, qr, back, fmt,
      startNew: () => { Object.assign(PL, { mode: 'build', pallet: null, at: null, rows: [] }); },
      again: () => Pallets.reset(), home: () => { Pallets.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Pallets" :sub="PL.pallet && PL.mode==='view' ? PL.pallet.name + ' · ' + PL.pallet.path : (PL.mode==='build' && PL.at ? 'New pallet at ' + PL.at.path : '')" @back="back"/>
      <main class="ws-main no-print">
        <Done v-if="PL.result" :result="PL.result" @again="again" @home="home"/>
        <template v-else-if="PL.mode==='scan'">
          <Prompt text="Scan a pallet label" hint="To see what's on it or move it. Or scan a location to start a new pallet there."/>
          <div class="ws-actions"><button class="ws-btn primary" @click="startNew">New pallet</button></div>
        </template>
        <template v-else-if="PL.mode==='build'">
          <Prompt v-if="!PL.at" text="Scan the pallet's location" tone="go"/>
          <Prompt v-else text="Scan what's on the pallet" hint="Each scan adds one; a box barcode adds the box. Tap a line to type." tone="go"/>
          <button v-for="r in PL.rows" :key="r.item_code + (r.batch_no || '')" class="ws-line btn" @click="type(r)">
            <div><b>{{r.item_code}}</b><small>{{r.item_name}}<span v-if="r.batch_no"> · batch {{r.batch_no}}</span></small></div>
            <div class="ws-num">{{fmt(r.qty)}} <small>{{r.uom}}</small></div>
          </button>
          <div v-if="PL.at && !PL.rows.length" class="ws-muted">Nothing scanned yet.</div>
        </template>
        <template v-else-if="PL.pallet">
          <div class="ws-card hero">
            <div class="ws-kicker">Pallet · {{PL.pallet.status}}<span v-if="PL.pallet.floor_label"> · {{PL.pallet.floor_label}}</span></div>
            <div class="ws-big">{{PL.pallet.name}}</div>
            <div class="ws-muted">at {{PL.pallet.path}}</div>
          </div>
          <div v-for="s in PL.pallet.short" :key="s.item_code" class="ws-note">{{s.item_code}}: the pallet says {{fmt(s.need)}}, but the location has {{fmt(s.have)}}. Edit the pallet.</div>
          <Prompt v-if="PL.moving" text="Scan the location to move it to" tone="go"/>
          <div class="ws-h">On the pallet</div>
          <div v-for="c in PL.pallet.contents" :key="c.item_code + (c.batch_no || '')" class="ws-line">
            <div><b>{{c.item_code}}</b><small>{{c.item_name}}<span v-if="c.batch_no"> · batch {{c.batch_no}}</span></small></div>
            <div class="ws-num">{{fmt(c.qty)}} <small>{{c.uom}}</small></div>
          </div>
          <div v-if="!PL.pallet.contents.length" class="ws-muted">Empty.</div>
          <div class="ws-actions" v-if="PL.pallet.can_write">
            <button class="ws-btn" @click="label"><Icon name="print"/> Label</button>
            <button class="ws-btn" @click="edit">Edit</button>
            <button v-if="PL.pallet.contents.length" class="ws-btn ghost" @click="empty">Empty</button>
          </div>
        </template>
      </main>
      <div v-if="PL.mode==='build' && PL.at && !PL.result" class="ws-footer no-print">
        <button class="ws-btn primary wide" :disabled="PL.loading || !PL.rows.length" @click="save">Save pallet · {{fmt(units)}} units</button>
      </div>
      <div v-if="PL.mode==='view' && PL.pallet && !PL.result && PL.pallet.can_write && PL.pallet.contents.length" class="ws-footer no-print">
        <button class="ws-btn wide" :class="PL.moving ? '' : 'primary'" @click="PL.moving = !PL.moving">{{PL.moving ? 'Cancel move' : 'Move this pallet'}}</button>
      </div>
      <div v-if="PL.print && PL.pallet" class="ws-print carton" aria-hidden="true">
        <div class="ws-clabel">
          <div class="ws-clabel-from">Pallet</div>
          <div class="ws-clabel-cust">{{PL.pallet.name}}</div>
          <div class="ws-clabel-addr">{{PL.pallet.contents.map(c => c.item_code + ' × ' + fmt(c.qty) + ' ' + (c.uom || '')).join('\\n')}}</div>
          <div class="ws-clabel-row"><div class="ws-clabel-qr" style="width:60mm;height:60mm" v-html="qr(PL.pallet.name)"></div></div>
          <div class="ws-clabel-code">{{PL.pallet.name}}</div>
        </div>
      </div>
    </div>`,
};

EXT.screens.pallets = Pallets;
EXT.tiles.push({ id: 'pallets', title: 'Pallets', sub: 'Build, label, move', group: 'Stock', order: 115, needsFloor: false, open: () => { Pallets.reset(); go('pallets'); } });
EXT.kinds.pallet = r => Pallets.open(r.name);
EXT.links.pallet = v => Pallets.open(v);
W.core.pallets = { Pallets, PL };
})();
