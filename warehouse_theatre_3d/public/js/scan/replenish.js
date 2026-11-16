/* Warehouse Scan — Replenish.
   Refill pick shelves from reserve stock. The list shows pick faces due for a refill on
   this floor (urgent first: draft Pick Lists already need more than is there). Open one,
   take stock from the suggested locations (scan location, scan item, confirm quantity),
   then scan the pick shelf: one Material Transfer is posted.
   Server: api/replenish.py. Registers with the scanner core (wt-scan.js) before mount. */
(function () {
'use strict';
const W = window.WarehouseScan;
if (!W || !W.core) return;
const { S, EXT, api, flash, feedback, ask, confirmSheet, go, handler, fmt, cache } = W.core;
const { TopBar, Prompt, Icon, Done } = W.core.components;
const { reactive, computed } = Vue;

const R = reactive({ data: null, task: null, at: null, taken: [], loading: false, result: null });

const Replenish = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(R, { data: null, task: null, at: null, taken: [], loading: false, result: null }); },
  async load() {
    R.loading = true;
    try { R.data = await api('replenish', 'get_replenishment', { floor: S.floor || undefined }); }
    catch (e) { flash('err', e.message); R.data = { tasks: [] }; }
    finally { R.loading = false; }
  },
  setup() {
    if (!R.data && !R.task) Replenish.load();
    const t = computed(() => R.task);
    const carried = computed(() => R.taken.reduce((a, x) => a + x.qty, 0));
    const left = computed(() => t.value ? Math.max(0, +(t.value.need - carried.value).toFixed(6)) : 0);

    function open(task) { R.task = task; R.at = null; R.taken = []; R.result = null; flash('ok', `Refill ${task.item_code} at ${task.path}`); }

    async function take(loc) {
      const src = t.value.sources.find(x => x.warehouse === loc.warehouse);
      const already = R.taken.filter(x => x.warehouse === loc.warehouse).reduce((a, x) => a + x.qty, 0);
      const suggest = Math.min(left.value, src ? Math.max(0, src.qty - already) : left.value);
      const qty = await ask({ title: `Take ${t.value.item_code}`, sub: `From ${loc.path}${src ? '' : ' (not a suggested location)'} · ${fmt(left.value)} ${t.value.stock_uom || ''} still needed`,
        value: String(suggest || left.value), unit: t.value.stock_uom || '', ok: 'Taken',
        quick: [{ label: 'All needed ' + fmt(left.value), value: left.value }] });
      if (qty === null || qty <= 0) return;
      R.taken.push({ warehouse: loc.warehouse, path: loc.path, qty });
      flash('ok', `${fmt(qty)} taken · ${left.value > 0 ? fmt(left.value) + ' still needed' : 'enough, go to the pick shelf'}`);
    }

    handler.fn = async r => {
      if (!t.value) { if (r.kind === 'location') { const m = (R.data ? R.data.tasks : []).find(x => x.warehouse === r.warehouse); if (m) return open(m); } flash('warn', 'Choose a refill first'); return; }
      if (r.kind === 'location') {
        if (r.warehouse === t.value.warehouse) {
          if (!R.taken.length) { flash('warn', 'Take the stock from a reserve location first'); return; }
          return put();
        }
        R.at = r;
        const ok = t.value.sources.some(x => x.warehouse === r.warehouse);
        flash(ok ? 'ok' : 'warn', ok ? `At ${r.path}. Scan ${t.value.item_code}` : `${r.path} isn't a suggested location; you can take from it anyway`);
        return;
      }
      if (r.kind === 'item') {
        if (r.item_code !== t.value.item_code) { flash('err', `This refill is for ${t.value.item_code}`); return; }
        if (!R.at) { flash('warn', 'Scan the location you are taking it from first'); return; }
        return take(R.at);
      }
      flash('err', 'Scan a location or the item');
    };

    async function put() {
      const rows = R.taken.map(x => ({ item_code: t.value.item_code, qty: x.qty, s_warehouse: x.warehouse, t_warehouse: t.value.warehouse }));
      if (left.value > 1e-9 && !(await confirmSheet('Refill short?', `${fmt(carried.value)} of ${fmt(t.value.need)} brought. Post what you have?`, 'Post', true))) return;
      R.loading = true;
      try {
        const res = await api('replenish', 'create_replenishment', { rows, submit: 1 }, true);
        R.result = { title: res.submitted ? 'Shelf refilled' : 'Transfer saved as draft',
          lines: [`${fmt(carried.value)} ${t.value.stock_uom || ''} ${t.value.item_code} → ${t.value.path}`, res.name,
            res.needs_batch_or_serial ? 'Batch/serial item: choose batches and submit in ERPNext.' : ''].filter(Boolean),
          url: res.url, again: 'Next refill', tone: res.submitted ? 'ok' : 'warn' };
        feedback('ok'); cache.clear();
      } catch (e) { flash('err', e.message); }
      finally { R.loading = false; }
    }
    async function back() {
      if (R.task && !R.result) {
        if (R.taken.length && !(await confirmSheet('Leave this refill?', 'What you took is not posted yet.', 'Leave', true))) return;
        R.task = null; R.taken = []; R.at = null; return;
      }
      Replenish.reset(); go('home');
    }
    return { S, R, t, carried, left, open, put, back, fmt,
      again: () => { Replenish.reset(); Replenish.load(); }, home: () => { Replenish.reset(); go('home'); },
      undo: i => R.taken.splice(i, 1) };
  },
  template: `
    <div>
      <TopBar title="Replenish" :sub="t && !R.result ? t.item_code + ' → ' + t.path : ''" @back="back"/>
      <main class="ws-main">
        <Done v-if="R.result" :result="R.result" @again="again" @home="home"/>
        <template v-else-if="!t">
          <Prompt text="Pick shelves to refill" hint="Urgent ones first: draft Pick Lists already need more than is there. Or scan a pick shelf."/>
          <div v-if="R.loading" class="ws-muted">Loading…</div>
          <button v-for="x in (R.data ? R.data.tasks : [])" :key="x.name" class="ws-line btn" @click="open(x)">
            <div><b>{{x.item_code}}</b><small>{{x.path}} · {{fmt(x.on_hand)}} on shelf<span v-if="x.pending"> · {{fmt(x.pending)}} to pick</span><span v-if="x.short"> · only {{fmt(x.need - x.short)}} in reserve</span></small></div>
            <div class="ws-num"><span v-if="x.urgent" class="ws-chip warn">Urgent</span> +{{fmt(x.need)}} <small>{{x.stock_uom}}</small></div>
          </button>
          <div v-if="R.data && !R.data.tasks.length" class="ws-muted">{{R.data.faces ? 'Every pick shelf on this floor is above its refill level.' : 'No refill levels are set up yet. A Stock Manager adds them in ERPNext under Warehouse Pick Face.'}}</div>
        </template>
        <template v-else>
          <div class="ws-card hero">
            <div class="ws-kicker">Refill · {{fmt(t.on_hand)}} on shelf<span v-if="t.pending"> · {{fmt(t.pending)}} to pick</span> · fill to {{fmt(t.max_qty)}}</div>
            <div class="ws-big">{{t.item_code}}</div>
            <div class="ws-muted">{{t.item_name}} → {{t.path}}</div>
          </div>
          <div class="ws-progress"><span :style="{width: Math.min(100, 100 * carried / t.need) + '%'}"></span></div>
          <div class="ws-muted small">{{fmt(carried)}} of {{fmt(t.need)}} {{t.stock_uom}} taken</div>
          <Prompt v-if="left > 0" :text="R.at ? 'Scan ' + t.item_code : 'Go to ' + (t.sources[0] ? t.sources[0].path : 'a reserve location')" :hint="R.at ? 'At ' + R.at.path : 'Scan the location label when you get there.'" tone="go"/>
          <Prompt v-else :text="'Scan the pick shelf ' + t.path" hint="Posts the move." tone="go"/>
          <div class="ws-h">Take from</div>
          <div v-for="s in t.sources" :key="s.warehouse" class="ws-line">
            <div><b>{{s.path}}</b><small>{{s.floor_label && s.floor !== t.floor ? s.floor_label + ' · ' : ''}}<span v-if="s.expiry">first batch expires {{s.expiry}}</span></small></div>
            <div class="ws-num">{{fmt(s.qty)}} <small>{{t.stock_uom}}</small></div>
          </div>
          <div v-if="t.short" class="ws-note">Reserve is {{fmt(t.short)}} {{t.stock_uom}} short of a full refill.</div>
          <div v-if="!t.sources.length" class="ws-note">No reserve stock of {{t.item_code}} anywhere you can see. Raise a Material Request in ERPNext.</div>
          <template v-if="R.taken.length">
            <div class="ws-h">Taken</div>
            <div v-for="(x, i) in R.taken" :key="i" class="ws-line">
              <div><b>{{x.path}}</b></div>
              <div class="ws-num">{{fmt(x.qty)}} <button class="ws-x" aria-label="Remove" @click="undo(i)">×</button></div>
            </div>
          </template>
        </template>
      </main>
      <div v-if="t && !R.result && R.taken.length" class="ws-footer">
        <button class="ws-btn primary wide" :disabled="R.loading" @click="put">Put on {{t.path}}</button>
      </div>
    </div>`,
};

EXT.screens.replenish = Replenish;
EXT.tiles.push({ id: 'replenish', title: 'Replenish', sub: 'Refill pick shelves', open: () => { Replenish.reset(); go('replenish'); } });
W.core.replenish = { Replenish, R };
})();
