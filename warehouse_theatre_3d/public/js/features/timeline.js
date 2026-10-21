/* Warehouse Theatre 3D — timeline replay.
   Rebuilds each bin's quantity day by day from the Stock Ledger and plays it back,
   so you can watch the floor fill and empty. While replaying, the view shows the
   historical snapshot (3D, 2D and the counters) and stock actions are disabled.
   Data: api/insights.get_timeline (opening balance + daily changes). */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, bus, engine, actions, addCSS, ui } = core;
  const { defineComponent, reactive, computed, onUnmounted } = Vue;
  const { filteredSlots } = core.helpers;

  addCSS('wtf-timeline-style', `
.wtf-tl{position:absolute;left:158px;right:12px;bottom:52px;z-index:18;background:var(--wt-bg2);color:var(--wt-text);border:1px solid var(--wt-border);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.4);padding:10px 12px;display:flex;flex-direction:column;gap:8px;animation:wtfPanelIn .2s ease}
#wt-app.has-tools .wtf-tl{bottom:52px}
.wtf-tl-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wtf-tl-title{font-size:12px;font-weight:800;margin-right:auto}
.wtf-tl-title .wtf-chip{margin-left:6px;background:rgba(251,191,36,.15);border-color:rgba(251,191,36,.4);color:#fbbf24}
.wtf-tl-range{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wtf-tl-range .wtf-inp{width:136px;height:28px}
.wtf-tl-play{display:flex;align-items:center;gap:10px}
.wtf-tl-play input[type=range]{flex:1;accent-color:#fbbf24;min-width:0}
.wtf-tl-date{min-width:150px;text-align:right;font-size:12px;font-weight:800;font-variant-numeric:tabular-nums}
.wtf-tl-date small{display:block;font-size:9px;font-weight:600;color:var(--wt-text3)}
.wtf-tl-ico{width:30px;padding:0}
@media(max-width:600px){
  .wtf-tl{left:8px;right:8px!important;bottom:8px}
  .wtf-tl-date{min-width:96px}
}
`);

  const ymd = d => d.toISOString().slice(0, 10);
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
  const pretty = s => { try { return new Date(s + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return s; } };

  const state = reactive({
    open: false, from: daysAgo(30), to: ymd(new Date()), loading: false, error: '',
    loaded: false, idx: 0, playing: false, speed: 1, n: 0,
  });
  let data = null, live = null, bal = null, cursor = -1, timer = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function balanceAt(i) {
    if (!bal || i < cursor) { bal = clone(data.start || {}); cursor = -1; }
    for (let k = cursor + 1; k <= i; k++) {
      (data.changes[k] || []).forEach(([wh, uom, q]) => { const b = bal[wh] = bal[wh] || {}; b[uom] = (b[uom] || 0) + q; });
    }
    cursor = i;
    return bal;
  }

  function snapshotSlots(b) {
    return live.map(sl => Object.assign({}, sl, {
      levels: sl.levels.map(lv => {
        const caps = {};
        (lv.uoms || []).forEach(u => { caps[u.u] = u.cap; });
        const q = b[lv.wh] || {};
        const uoms = Object.entries(q).filter(([, v]) => Math.abs(v) > 1e-9)
          .map(([u, v]) => ({ u, qty: Math.round(v * 1000) / 1000, reserved: 0, cap: caps[u] || 0 }));
        Object.entries(caps).forEach(([u, c]) => { if (c && !uoms.some(x => x.u === u)) uoms.push({ u, qty: 0, reserved: 0, cap: c }); });
        return Object.assign({}, lv, { uoms, items: [] });
      }),
    }));
  }

  function show(i) {
    if (!data || !data.dates.length) return;
    state.idx = Math.max(0, Math.min(data.dates.length - 1, i));
    store.slots = snapshotSlots(balanceAt(state.idx));
    store.replayDate = data.dates[state.idx];
    if (store.threeReady && store.curView === '3d') engine.buildScene(filteredSlots());
  }

  async function load() {
    state.error = '';
    if (!state.from || !state.to) { state.error = 'Choose both dates.'; return; }
    if (state.from > state.to) { state.error = '"From" must be before "To".'; return; }
    stop();
    state.loading = true;
    try {
      const r = await core.api('insights', 'get_timeline', { group_warehouse: store.curGrp.id, from_date: state.from, to_date: state.to });
      if (!r || !r.dates || !r.dates.length) { state.error = 'No dates in that range.'; return; }
      if (!live) live = clone(store.slots);   // keep the live view to restore later
      data = r; bal = null; cursor = -1;
      state.from = r.from_date; state.to = r.to_date;
      state.n = r.dates.length; state.loaded = true;
      store.dpOpen = false; store.imOpen = false;
      if (store.searchQuery) actions.clearSearch();   // search needs live item lists
      show(0);
    } catch (e) { state.error = e.message; }
    finally { state.loading = false; }
  }

  function play() {
    if (!state.loaded) return;
    if (state.idx >= state.n - 1) show(0);
    state.playing = true;
    clearInterval(timer);
    timer = setInterval(() => {
      if (state.idx >= state.n - 1) { stop(); return; }
      show(state.idx + 1);
    }, Math.round(700 / state.speed));
  }
  function stop() { state.playing = false; clearInterval(timer); timer = null; }
  function setSpeed(s) { state.speed = s; if (state.playing) play(); }

  function backToLive(rebuild = true) {
    stop();
    if (live) { store.slots = live; }
    live = null; data = null; bal = null; cursor = -1;
    store.replayDate = null;
    state.loaded = false; state.idx = 0; state.n = 0;
    if (rebuild && store.threeReady && store.curView === '3d') engine.buildScene(filteredSlots());
  }
  function close() { backToLive(); state.open = false; }

  // Leaving the floor: the new floor's live data replaces the snapshot anyway.
  bus.on('before-group-change', () => { if (store.replayDate || live) { stop(); live = null; data = null; store.replayDate = null; state.loaded = false; } });
  bus.on('escape', () => { if (state.open) close(); });

  const changedToday = computed(() => (state.loaded && data) ? (data.changes[state.idx] || []).length : 0);
  const dateLabel = computed(() => state.loaded && data ? pretty(data.dates[state.idx]) : '');

  const TimelineBar = defineComponent({
    name: 'WtfTimelineBar',
    setup() {
      onUnmounted(stop);
      return { state, store, load, play, stop, setSpeed, close, show, changedToday, dateLabel, pretty,
        today: ymd(new Date()), minDate: daysAgo(366) };
    },
    template: `
      <div v-if="state.open && !store.aisleMode" class="wtf-tl" role="region" aria-label="Timeline replay"
        :style="store.dpOpen ? {right:'228px'} : null">
        <div class="wtf-tl-top">
          <div class="wtf-tl-title">⏱ Replay stock history<span v-if="store.replayDate" class="wtf-chip">read-only</span></div>
          <div class="wtf-tl-range">
            <label class="wtf-lbl" for="wtf-tl-from">From</label>
            <input id="wtf-tl-from" class="wtf-inp" type="date" v-model="state.from" :min="minDate" :max="today"/>
            <label class="wtf-lbl" for="wtf-tl-to">To</label>
            <input id="wtf-tl-to" class="wtf-inp" type="date" v-model="state.to" :min="minDate" :max="today"/>
            <button class="wtf-btn wtf-btn-pri" :disabled="state.loading" @click="load()"><span v-if="state.loading" class="wtf-spin"></span>{{state.loaded?'Reload':'Load'}}</button>
          </div>
          <button class="wtf-btn" @click="close()" title="Return to live stock">✕ Back to live</button>
        </div>
        <div v-if="state.error" class="wtf-err" style="margin:0" role="alert">{{state.error}}</div>
        <div v-if="state.loaded" class="wtf-tl-play">
          <button class="wtf-btn wtf-tl-ico" @click="state.playing ? stop() : play()" :aria-label="state.playing?'Pause':'Play'">{{state.playing ? '⏸' : '▶'}}</button>
          <select class="wtf-inp" style="width:62px;height:30px" :value="state.speed" @change="setSpeed(+$event.target.value)" aria-label="Playback speed">
            <option :value="1">1×</option><option :value="2">2×</option><option :value="4">4×</option><option :value="8">8×</option>
          </select>
          <input type="range" min="0" :max="state.n-1" :value="state.idx" @input="stop(); show(+$event.target.value)" aria-label="Day"/>
          <div class="wtf-tl-date" aria-live="polite">{{dateLabel}}<small>{{changedToday}} bin movement{{changedToday===1?'':'s'}} · day {{state.idx+1}}/{{state.n}}</small></div>
        </div>
        <div v-else class="wtf-muted">Pick a range (up to a year) and press Load. The floor shows each bin's quantity at the end of each day.</div>
      </div>`,
  });
  ext.overlays.push(TimelineBar);

  const ReplayNote = defineComponent({
    name: 'WtfReplayNote',
    props: { d: Object },
    setup() { return { store, pretty }; },
    template: `
      <div v-if="store.replayDate" class="wtf-ok" style="margin-top:10px;color:#fbbf24;background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.3)">
        Quantities as at end of {{pretty(store.replayDate)}}. Item detail isn't kept for past dates — press "Back to live" to see items.
      </div>`,
  });
  ext.panelSections.unshift(ReplayNote);

  ext.tools.push({
    id: 'timeline', icon: '⏱', label: 'Replay', title: 'Replay stock history',
    active: () => state.open,
    onClick: () => { if (state.open) close(); else { ui.closePanel(); actions.closeDP(); state.open = true; } },
  });

  core.timeline = { state, backToLive };
});

})();
