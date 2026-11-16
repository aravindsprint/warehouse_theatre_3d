/* Warehouse Scan — Batch pick.
   Walk several draft Pick Lists in one route. Each list gets a tote number; at each
   shelf the picker takes the total for all lists and the app says how many go in which
   tote. Picks are saved back to each Pick List (scan.save_picks), and every list in the
   batch is assigned to the picker (ERPNext Assign To) so nobody else starts it.
   Server: api/picking.py. Registers with the scanner core (wt-scan.js) before mount. */
(function () {
'use strict';
const W = window.WarehouseScan;
if (!W || !W.core) return;
const { S, EXT, api, flash, feedback, ask, confirmSheet, go, handler, fmt, cache, daysAgo } = W.core;
const { TopBar, Prompt, Icon, Done } = W.core.components;
const { reactive, computed, watch } = Vue;

const MAX = 8;
const TOTE_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f'];

// Same rule as picking.split_pick: a short pick fills the first totes first.
function splitPick(total, demands) {
  const out = {}; let left = total;
  demands.forEach(([key, qty]) => { const take = Math.min(qty, Math.max(0, left)); out[key] = +take.toFixed(6); left -= take; });
  return out;
}

const B = reactive({ queue: null, chosen: {}, batch: null, picks: {}, skipped: {}, at: null, loading: false, result: null, last: null });

const Batch = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(B, { queue: null, chosen: {}, batch: null, picks: {}, skipped: {}, at: null, loading: false, result: null, last: null }); },
  async loadQueue() {
    B.loading = true;
    try {
      const q = await api('picking', 'get_work_queue', { floor: S.floor });
      B.queue = q.lists;
      // Start with my own lists, then unassigned ones, up to four.
      B.chosen = {};
      q.lists.filter(l => l.mine || !l.assigned.length).slice(0, 4).forEach(l => { B.chosen[l.name] = true; });
    } catch (e) { flash('err', e.message); B.queue = []; }
    finally { B.loading = false; }
  },
  async start(names) {
    B.loading = true;
    try {
      const c = await api('picking', 'claim', { names }, true);
      c.skipped.forEach(s => flash('warn', s.reason));
      const use = names.filter(n => c.claimed.includes(n) || !c.skipped.some(s => s.name === n));
      if (!use.length) return;
      B.batch = await api('picking', 'get_batch', { names: use });
      B.picks = {}; B.skipped = {}; B.at = null;
      B.batch.rows.forEach(r => { if (r.picked_qty > 0) B.picks[r.row_name] = { picked_qty: r.picked_qty, warehouse: null, saved: true }; });
      flash('ok', `${B.batch.lists.length} lists · ${B.batch.rows.length} lines`);
    } catch (e) { flash('err', e.message); }
    finally { B.loading = false; }
  },
  setup() {
    if (!B.batch && !B.queue) Batch.loadQueue();
    const rows = computed(() => B.batch ? B.batch.rows : []);
    const isDone = r => !!B.picks[r.row_name] || !!B.skipped[r.row_name];
    const totes = computed(() => B.batch ? Object.fromEntries(B.batch.lists.map(l => [l.name, l])) : {});
    // A stop is a run of rows at one shelf; within it, one task per item (and batch) across lists.
    const stops = computed(() => {
      const out = [];
      rows.value.forEach(r => {
        const last = out[out.length - 1];
        if (last && last.warehouse === r.warehouse) last.rows.push(r);
        else out.push({ warehouse: r.warehouse, path: r.path, floor_label: r.floor_label, mapped: r.mapped, rows: [r] });
      });
      out.forEach(s => {
        const g = {};
        s.rows.forEach(r => { const k = r.item_code + '|' + (r.batch_no || ''); (g[k] = g[k] || { key: k, item_code: r.item_code, item_name: r.item_name, uom: r.uom, batch_no: r.batch_no, rows: [] }).rows.push(r); });
        s.tasks = Object.values(g).map(t => ({ ...t, asked: t.rows.reduce((a, r) => a + r.qty, 0), done: t.rows.every(isDone) }));
      });
      return out;
    });
    const stopIdx = computed(() => stops.value.findIndex(s => s.rows.some(r => !isDone(r))));
    const stop = computed(() => stops.value[stopIdx.value] || null);
    const doneCount = computed(() => rows.value.filter(isDone).length);
    const pending = computed(() => Object.values(B.picks).filter(p => !p.saved).length);
    watch(stop, (a, b) => { if (!a || !b || a.warehouse !== b.warehouse) B.at = null; });

    async function pickTask(t, scanned) {
      const open = t.rows.filter(r => !B.picks[r.row_name] || B.picks[r.row_name].saved);
      const asked = open.reduce((a, r) => a + r.qty, 0);
      if (!open.length) { flash('warn', `${t.item_code} is done here`); return; }
      const qty = await ask({ title: `Pick ${t.item_code}`, sub: `${open.length} order${open.length === 1 ? '' : 's'} · totes ${open.map(r => r.tote).join(', ')}${t.batch_no ? ' · batch ' + t.batch_no : ''}`,
        value: String(scanned && scanned.factor > 1 && scanned.factor < asked ? scanned.factor : asked), unit: t.uom, ok: 'Picked',
        quick: [{ label: 'All ' + fmt(asked), value: asked }, { label: 'None', value: 0 }] });
      if (qty === null) return;
      if (qty > asked + 1e-9) { flash('err', `Only ${fmt(asked)} ${t.uom} asked for`); return; }
      const split = splitPick(qty, open.map(r => [r.row_name, r.qty]));
      const other = B.at && stop.value && B.at.warehouse !== stop.value.warehouse ? B.at.warehouse : null;
      open.forEach(r => { B.picks[r.row_name] = { picked_qty: split[r.row_name], warehouse: other, saved: false }; delete B.skipped[r.row_name]; });
      B.last = open.map(r => ({ tote: r.tote, qty: split[r.row_name], uom: r.uom, short: split[r.row_name] + 1e-9 < r.qty, pick_list: r.pick_list }));
      flash(qty + 1e-9 < asked ? 'warn' : 'ok', B.last.map(x => `Tote ${x.tote}: ${fmt(x.qty)}`).join(' · '));
    }

    handler.fn = async r => {
      if (!B.batch) { flash('warn', 'Start a batch first'); return; }
      const st = stop.value;
      if (r.kind === 'location') {
        if (!st) { flash('warn', 'All lines are done'); return; }
        B.at = r;
        flash(r.warehouse === st.warehouse ? 'ok' : 'warn', r.warehouse === st.warehouse ? `At ${r.path}` : `Picking from ${r.path} instead of ${st.path}`);
        return;
      }
      if (r.kind === 'item') {
        if (!st) { flash('warn', 'All lines are done'); return; }
        if (!B.at) { flash('warn', `Scan the location ${st.path} first`); return; }
        const t = st.tasks.find(x => x.item_code === r.item_code && !x.done && (!r.batch_no || !x.batch_no || x.batch_no === r.batch_no));
        if (!t) {
          const wrongBatch = st.tasks.find(x => x.item_code === r.item_code && x.batch_no && r.batch_no && x.batch_no !== r.batch_no);
          flash('err', wrongBatch ? `Wrong batch: this shelf's line needs ${wrongBatch.batch_no}` : `${r.item_code} isn't picked here`);
          return;
        }
        return pickTask(t, r);
      }
      flash('err', 'Scan a location or an item');
    };

    function skipStop() { if (stop.value) stop.value.rows.forEach(r => { if (!B.picks[r.row_name]) B.skipped[r.row_name] = true; }); }
    async function save(submit) {
      const byList = {};
      rows.value.forEach(r => {
        const p = B.picks[r.row_name];
        if (p && (!p.saved || submit)) (byList[r.pick_list] = byList[r.pick_list] || []).push({ row_name: r.row_name, picked_qty: p.picked_qty, warehouse: p.warehouse });
      });
      const writable = B.batch.lists.filter(l => l.can_write);
      if (submit) {
        const short = rows.value.filter(r => !B.picks[r.row_name] || B.picks[r.row_name].picked_qty + 1e-9 < r.qty).length;
        if (!(await confirmSheet(`Submit ${writable.length} Pick List${writable.length === 1 ? '' : 's'}?`, short ? `${short} line${short === 1 ? ' is' : 's are'} short or not picked.` : 'Every line is picked in full.', 'Save & submit all', !!short))) return;
      }
      B.loading = true;
      const done = [], failed = [];
      for (const l of writable) {
        if (!byList[l.name] && !submit) continue;
        try { await api('scan', 'save_picks', { name: l.name, picks: byList[l.name] || [], submit: submit ? 1 : 0 }, true); done.push(l); }
        catch (e) { failed.push(l.name + ': ' + e.message); }
      }
      rows.value.forEach(r => { const p = B.picks[r.row_name]; if (p && done.some(l => l.name === r.pick_list)) { p.saved = true; p.warehouse = null; } });
      B.loading = false;
      failed.forEach(f => flash('err', f));
      if (submit && !failed.length) {
        B.result = { title: 'Batch submitted', lines: done.map(l => `Tote ${l.tote} · ${l.name}${l.customer ? ' · ' + l.customer : ''}`), again: 'Next batch', tone: 'ok',
          next: EXT.afterPick && done.length === 1 ? EXT.afterPick(done[0].name) : null };
        feedback('ok'); cache.clear();
      } else if (!failed.length) flash('ok', 'Picks saved');
    }
    async function back() {
      if (pending.value && !(await confirmSheet('Leave this batch?', `${pending.value} pick${pending.value === 1 ? '' : 's'} haven't been saved.`, 'Leave', true))) return;
      if (B.batch && !B.result) { B.batch = null; Batch.loadQueue(); return; }
      Batch.reset(); go('home');
    }
    async function release(l) {
      try { await api('picking', 'release', { name: l.name }, true); flash('ok', `${l.name} back in the queue`); Batch.loadQueue(); }
      catch (e) { flash('err', e.message); }
    }
    const chosenNames = computed(() => (B.queue || []).filter(l => B.chosen[l.name]).map(l => l.name));
    function toggle(l) {
      if (!B.chosen[l.name] && chosenNames.value.length >= MAX) { flash('warn', `Up to ${MAX} lists in a batch`); return; }
      B.chosen[l.name] = !B.chosen[l.name];
    }
    return { S, B, rows, stops, stop, stopIdx, doneCount, pending, totes, isDone, pickTask, skipStop, save, back, release, toggle, chosenNames, fmt, daysAgo, TOTE_COLORS,
      start: () => Batch.start(chosenNames.value), again: () => { Batch.reset(); Batch.loadQueue(); }, home: () => { Batch.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Batch pick" :sub="B.batch && !B.result ? B.batch.lists.length + ' lists · ' + doneCount + '/' + rows.length + ' lines' : ''" @back="back"/>
      <main class="ws-main">
        <Done v-if="B.result" :result="B.result" @again="again" @home="home"/>
        <template v-else-if="!B.batch">
          <Prompt text="Choose the lists to pick together" hint="Up to 8. Each gets a tote number. Yours come first, then unassigned, by delivery date."/>
          <div v-if="B.loading" class="ws-muted">Loading…</div>
          <label v-for="l in B.queue || []" :key="l.name" class="ws-line btn" :class="{taken: l.assigned.length && !l.mine}">
            <div><b><input type="checkbox" :checked="!!B.chosen[l.name]" @change="toggle(l)" :disabled="l.assigned.length && !l.mine" style="margin-right:8px"/>{{l.customer || l.name}}</b>
              <small><span v-if="l.mine" class="ws-who">Yours · </span><span v-else-if="l.assigned.length" class="ws-who">{{l.assigned_names.join(', ')}} · </span><span v-if="l.due">due {{l.due}} · </span>{{l.floor_rows}} lines · {{l.name}}</small></div>
            <button v-if="l.mine" class="ws-x" :aria-label="'Release ' + l.name" @click.prevent="release(l)" title="Give back to the queue">↩</button>
          </label>
          <div v-if="B.queue && !B.queue.length" class="ws-muted">No draft Pick Lists on this floor.</div>
        </template>
        <template v-else>
          <div class="ws-row2 wrap">
            <span v-for="l in B.batch.lists" :key="l.name" class="ws-tote" :style="{'--tc': TOTE_COLORS[(l.tote - 1) % TOTE_COLORS.length]}"><b>{{l.tote}}</b>{{l.customer || l.name}}</span>
          </div>
          <div class="ws-progress"><span :style="{width: (doneCount / Math.max(1, rows.length) * 100) + '%'}"></span></div>
          <template v-if="stop">
            <div class="ws-card hero">
              <div class="ws-kicker">Stop {{stopIdx+1}} of {{stops.length}}<span v-if="stop.floor_label"> · {{stop.floor_label}}</span></div>
              <div class="ws-big">{{stop.path}}</div>
            </div>
            <Prompt v-if="!B.at" :text="'Scan the location ' + stop.path" tone="go"/>
            <Prompt v-else text="Scan each item" hint="Take the total, then split it into the totes shown." tone="go"/>
            <div v-if="B.last" class="ws-split">
              <span v-for="x in B.last" :key="x.tote" class="ws-tote" :class="{short: x.short}" :style="{'--tc': TOTE_COLORS[(x.tote - 1) % TOTE_COLORS.length]}"><b>{{x.tote}}</b>{{fmt(x.qty)}} {{x.uom}}</span>
            </div>
            <button v-for="t in stop.tasks" :key="t.key" class="ws-line btn" :class="{done: t.done}" @click="pickTask(t)">
              <div><b>{{t.item_code}}</b><small>{{t.item_name}}<span v-if="t.batch_no"> · batch {{t.batch_no}}</span></small>
                <small class="ws-totes"><span v-for="r in t.rows" :key="r.row_name" class="ws-tote mini" :style="{'--tc': TOTE_COLORS[(r.tote - 1) % TOTE_COLORS.length]}"><b>{{r.tote}}</b>{{B.picks[r.row_name] ? fmt(B.picks[r.row_name].picked_qty) + '/' : ''}}{{fmt(r.qty)}}</span></small></div>
              <div class="ws-num">{{fmt(t.asked)}} <small>{{t.uom}}</small></div>
            </button>
            <div class="ws-actions"><button class="ws-btn ghost" @click="skipStop">Skip this stop</button></div>
          </template>
          <Prompt v-else text="All lines done" hint="Save & submit all below." tone="go"/>
        </template>
      </main>
      <div v-if="!B.batch && !B.result && B.queue && B.queue.length" class="ws-footer">
        <button class="ws-btn primary wide" :disabled="B.loading || !chosenNames.length" @click="start">Start batch · {{chosenNames.length}} list{{chosenNames.length===1?'':'s'}}</button>
      </div>
      <div v-if="B.batch && !B.result" class="ws-footer two">
        <button class="ws-btn" :disabled="B.loading || !pending" @click="save(false)">Save{{pending ? ' ' + pending : ''}}</button>
        <button class="ws-btn primary" :disabled="B.loading" @click="save(true)">Save & submit all</button>
      </div>
    </div>`,
};

EXT.screens.batch = Batch;
EXT.tiles.push({ id: 'batch', title: 'Batch pick', sub: 'Several orders, one walk', open: () => { Batch.reset(); go('batch'); } });
W.core.batch = { Batch, B, splitPick };
})();
