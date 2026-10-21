/* Warehouse Theatre 3D — "Spot the Bottleneck": pick routes and aisle traffic.
   Draws a Pick List's walking route in its saved order next to an optimised order,
   with distance/time saved, and can save the better order back to a draft Pick List.
   "Aisle traffic" overlays every pick trip in a period to show congested walkways.
   Geometry: routing.js (WT3DRouting). Data: api/routes.*. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, bus, engine, actions, addCSS, ui } = core;
  const { defineComponent, reactive, computed, watch } = Vue;
  const R = window.WT3DRouting;
  if (!R) { console.error('WT3D routes: routing.js not loaded'); return; }
  const { fmt } = core.helpers;

  addCSS('wtf-routes-style', `
.wtf-rt-legend{display:flex;gap:12px;margin:2px 0 10px;flex-wrap:wrap}
.wtf-rt-toggle{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;color:var(--wt-text2);cursor:pointer}
.wtf-rt-swatch{width:18px;height:4px;border-radius:2px}
.wtf-rt-save{font-size:22px;font-weight:900;color:#4ade80}
.wtf-rt-stop{display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--wt-border);cursor:pointer}
.wtf-rt-stop:hover .wtf-rt-bin{color:var(--wt-accent2)}
.wtf-rt-n{width:20px;height:20px;border-radius:50%;background:#4ade80;color:#0c0e14;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.wtf-rt-bin{font-size:11px;font-weight:700;color:var(--wt-text)}
.wtf-rt-items{font-size:9px;color:var(--wt-text3);line-height:1.4}
.wtf-rt-hot{display:flex;justify-content:space-between;align-items:center;gap:8px}
.wtf-rt-bar{height:4px;border-radius:2px;background:linear-gradient(90deg,#facc15,#ef4444);margin-top:4px}
`);

  const C_CUR = 0xf87171, C_OPT = 0x4ade80;

  const state = reactive({
    tab: 'route', lists: [], listsLoading: false, selected: '', loading: false, error: '',
    result: null, listMeta: null, offFloor: 0, showCur: true, showOpt: true, saving: false, saved: false,
    days: 30, trafficLoading: false, traffic: null,
  });
  let floorCache = null;

  function floorModel() {
    if (!engine.layout || !Object.keys(engine.slotPos).length) return null;
    if (!floorCache) floorCache = R.buildFloor(engine.layout, engine.slotPos);
    return floorCache;
  }
  bus.on('scene-built', () => { floorCache = null; if (state.result) recompute(); if (state.traffic) drawTraffic(); });
  bus.on('dock-changed', () => { if (state.result) recompute(); });

  const slotOfRow = r => { const f = ui.findLevel(r.warehouse); return f ? f.slot.wh : null; };

  async function loadLists() {
    if (!store.curGrp) return;
    state.listsLoading = true;
    try { state.lists = (await core.api('routes', 'get_pick_lists', { group_warehouse: store.curGrp.id, days: 30 })) || []; }
    catch (e) { state.lists = []; state.error = e.message; }
    finally { state.listsLoading = false; }
  }

  /* A made-up order over occupied bins, so the view works on floors with no pick history. */
  function simulatedRows() {
    const bins = [];
    store.slots.forEach(sl => sl.levels.forEach(lv => { if ((lv.items || []).length) bins.push({ sl, lv }); }));
    const pool = bins.length ? bins : store.slots.flatMap(sl => sl.levels.map(lv => ({ sl, lv })));
    const n = Math.min(pool.length, 12);
    const rows = [];
    const used = new Set();
    let seed = 42;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    while (rows.length < n && used.size < pool.length) {
      const i = Math.floor(rnd() * pool.length);
      if (used.has(i)) continue;
      used.add(i);
      const { lv } = pool[i];
      const it = (lv.items || [])[0];
      rows.push({ row_name: 'sim-' + i, idx: rows.length + 1, warehouse: lv.wh, item_code: it ? it.c : '—', item_name: it ? it.n : '', qty: 1, uom: it ? it.u : '' });
    }
    return rows;
  }

  let rows = [];
  async function selectList(name) {
    state.selected = name; state.error = ''; state.saved = false; state.result = null; state.listMeta = null;
    if (!name) { clearRoute(); return; }
    state.loading = true;
    try {
      if (name === '__sim__') {
        rows = simulatedRows();
        state.listMeta = { name: 'Simulated order', simulated: true, docstatus: null };
      } else {
        const r = await core.api('routes', 'get_pick_rows', { names: JSON.stringify([name]) });
        const pl = (r || [])[0];
        if (!pl) throw new Error('Pick List not found.');
        rows = pl.rows;
        state.listMeta = { name: pl.name, docstatus: pl.docstatus, status: pl.status };
      }
      recompute(true);
    } catch (e) { state.error = e.message; }
    finally { state.loading = false; }
  }

  function recompute(fly) {
    const f = floorModel();
    if (!f) return;
    const onFloor = rows.filter(r => slotOfRow(r));
    state.offFloor = rows.length - onFloor.length;
    if (!onFloor.length) { state.result = null; state.error = 'None of this Pick List\'s rows are in bins on this floor.'; clearRoute(); return; }
    state.result = R.compare(f, ui.floor.dockSlot, onFloor, slotOfRow);
    drawRoute();
    if (fly) ui.frameSlots(state.result.optimized.order.map(s => s.slot).concat(state.result.dock.slot ? [state.result.dock.slot] : []));
  }

  /* ── Drawing ── */
  function addPath(grp, path, color, width, y, opacity) {
    const THREE = window.THREE;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    for (let i = 1; i < path.length; i++) {
      const [x1, z1] = path[i - 1], [x2, z2] = path[i];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 1e-6) continue;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len + width, .02, width), mat);
      seg.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
      seg.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      grp.add(seg);
    }
  }

  let walker = null, walkerPath = null, walkerLen = 0;
  function drawRoute() {
    const THREE = window.THREE;
    const res = state.result;
    if (!res) { clearRoute(); return; }
    const grp = engine.overlay('routes');
    if (state.showCur) addPath(grp, res.current.path, C_CUR, .14, .04, .75);
    if (state.showOpt) {
      addPath(grp, res.optimized.path, C_OPT, .22, .07, .9);
      res.optimized.order.forEach((s, i) => {
        const p = engine.slotPos[s.slot];
        if (!p) return;
        const sp = ui.labelSprite(i + 1, C_OPT);
        sp.position.set(p.x, p.top + .9, p.z);
        sp.scale.set(.95, .48, 1);
        grp.add(sp);
      });
      walker = new THREE.Mesh(new THREE.SphereGeometry(.28, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      walker.position.y = .4;
      grp.add(walker);
      walkerPath = res.optimized.path;
      walkerLen = walkerPath.reduce((s, p, i) => i ? s + Math.hypot(p[0] - walkerPath[i - 1][0], p[1] - walkerPath[i - 1][1]) : 0, 0);
    } else { walker = null; }
    const d = res.dock;
    const dp = d.slot ? engine.slotPos[d.slot] : null;
    const dock = ui.labelSprite('DOCK', 0xffffff);
    dock.position.set(dp ? dp.x : d.x, (dp ? dp.top : 0) + 1.5, dp ? dp.z : floorModel().lanes[0].z);
    grp.add(dock);
  }
  engine.tickers.push(t => {
    if (!walker || !walker.parent || !walkerPath || walkerLen <= 0) return;
    let s = (t * 2.2) % walkerLen;   // ~2 m/s, looping
    for (let i = 1; i < walkerPath.length; i++) {
      const [x1, z1] = walkerPath[i - 1], [x2, z2] = walkerPath[i];
      const l = Math.hypot(x2 - x1, z2 - z1);
      if (s <= l) { const k = l ? s / l : 0; walker.position.x = x1 + (x2 - x1) * k; walker.position.z = z1 + (z2 - z1) * k; return; }
      s -= l;
    }
  });
  function clearRoute() { walker = null; walkerPath = null; engine.clearOverlay('routes'); }

  async function saveOrder() {
    if (!state.result || !state.listMeta || state.listMeta.docstatus !== 0) return;
    state.saving = true; state.error = '';
    try {
      const order = state.result.optimized.order.flatMap(v => v.rows.map(r => r.row_name));
      await core.api('routes', 'reorder_pick_list', { name: state.listMeta.name, order: JSON.stringify(order) }, true);
      state.saved = true;
      core.alert('Saved the walking order to ' + state.listMeta.name);
    } catch (e) { state.error = e.message; }
    finally { state.saving = false; }
  }

  /* ── Aisle traffic ── */
  async function loadTraffic() {
    state.trafficLoading = true; state.error = '';
    try {
      const lists = (await core.api('routes', 'get_period_pick_rows', { group_warehouse: store.curGrp.id, days: state.days })) || [];
      state.traffic = { lists, cells: [], hotspots: [], trips: 0 };
      drawTraffic(true);
    } catch (e) { state.error = e.message; state.traffic = null; }
    finally { state.trafficLoading = false; }
  }
  function drawTraffic(fly) {
    const THREE = window.THREE;
    const f = floorModel();
    if (!f || !state.traffic) return;
    const dock = R.dockStop(f, ui.floor.dockSlot);
    const paths = [];
    state.traffic.lists.forEach(pl => {
      const stops = R.stopsInOrder(f, pl.rows, slotOfRow);
      if (stops.length) paths.push(R.evaluate(f, [dock, ...stops, dock]).path);
    });
    const cells = R.traffic(f, paths, 1);
    const max = Math.max(1, ...cells.map(c => c.n));
    const grp = engine.overlay('traffic');
    cells.forEach(c => {
      const k = c.n / max;
      if (k < .08) return;
      const col = new THREE.Color().setHSL(.16 - .16 * k, .95, .5);   // yellow → red
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(.96, .96),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: .25 + .55 * k, depthWrite: false }));
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(c.x, .015, c.z);
      grp.add(tile);
    });
    // Hotspots: busiest cells, described by aisle and nearest slot. Every trip starts and
    // ends at the dock, so the walkway right by it is always "busiest" and says nothing;
    // skip it, keep spots ~3 m apart, and allow at most two per aisle so the list
    // points at different places.
    const dockPt = dock.slot && engine.slotPos[dock.slot]
      ? { x: engine.slotPos[dock.slot].x, z: engine.slotPos[dock.slot].z } : { x: dock.x, z: f.lanes[0].z };
    const spots = [], perLane = {};
    cells.slice().sort((a, b) => b.n - a.n).forEach(c => {
      if (spots.length >= 5 || spots.some(s => Math.hypot(s.x - c.x, s.z - c.z) < 3)) return;
      if (Math.hypot(c.x - dockPt.x, c.z - dockPt.z) < 5) return;
      const laneZ = R.laneAt(f, c.z).z;
      if ((perLane[laneZ] || 0) >= 2) return;
      perLane[laneZ] = (perLane[laneZ] || 0) + 1;
      let near = null, nd = Infinity;
      store.slots.forEach(sl => { const p = engine.slotPos[sl.wh]; if (!p) return; const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < nd) { nd = d; near = sl; } });
      const lane = R.laneAt(f, c.z);
      const rowName = r => { const sl = store.slots.find(s => s.row === r); return sl ? 'row ' + sl.label.replace(/\d+$/, '') : 'row ' + (r + 1); };
      const where = lane.kind === 'front' ? 'Front aisle' : lane.kind === 'back' ? 'Back aisle'
        : `Aisle between ${rowName(lane.between[0])} and ${rowName(lane.between[1])}`;
      spots.push({ x: c.x, z: c.z, n: c.n, where, near: near ? near.label : '' , slot: near ? near.wh : null });
    });
    state.traffic.trips = paths.length;
    state.traffic.hotspots = spots;
    state.traffic.max = max;
    if (fly && spots.length) engine.flyTo(spots[0].x, spots[0].z, 26);
  }
  function clearTraffic() { state.traffic = null; engine.clearOverlay('traffic'); }

  function reset() { state.result = null; state.selected = ''; state.listMeta = null; state.saved = false; state.error = ''; clearRoute(); clearTraffic(); }
  function close() { ui.closePanel('routes'); reset(); }

  bus.on('before-group-change', (g, changed) => { if (changed) { reset(); state.lists = []; } });
  bus.on('group-selected', (g, changed) => { if (changed && ui.state.panel === 'routes') loadLists(); });
  watch(() => ui.state.panel, p => { if (p === 'routes') { if (!state.lists.length) loadLists(); } else if (state.result || state.traffic) reset(); });
  watch(() => [state.showCur, state.showOpt], () => { if (state.result) drawRoute(); });

  const fmtM = m => Math.round(m) + ' m';
  const fmtT = s => s >= 3600 ? (s / 3600).toFixed(1) + ' h' : Math.round(s / 60) + ' min';

  const RoutesPanel = defineComponent({
    name: 'WtfRoutesPanel',
    components: { WtfPanel: ui.Panel },
    setup() {
      const stops = computed(() => state.result ? state.result.optimized.order.map(v => {
        const sl = store.slots.find(s => s.wh === v.slot);
        return { slot: v.slot, label: sl ? sl.label : v.slot, rows: v.rows };
      }) : []);
      return { state, ui, store, stops, fmt, fmtM, fmtT, selectList, saveOrder, loadTraffic, close, reset,
        focus: s => ui.frameSlots([s.slot]),
        focusSpot: h => engine.flyTo(h.x, h.z, 14),
        pickHeat: () => bus.emit('heatmap:set', 'picks'),
        setTab: t => { reset(); state.tab = t; } };
    },
    template: `
      <WtfPanel v-if="ui.state.panel==='routes'" title="🧭 Spot the bottleneck"
        sub="Compare how pickers walk today with the shortest order, and find congested aisles." @close="close()">
        <div class="wtf-pa-tabs" role="tablist">
          <button role="tab" :aria-selected="state.tab==='route'" :class="['wtf-pa-tab', state.tab==='route'?'act':'']" @click="setTab('route')">Pick route</button>
          <button role="tab" :aria-selected="state.tab==='traffic'" :class="['wtf-pa-tab', state.tab==='traffic'?'act':'']" @click="setTab('traffic')">Aisle traffic</button>
        </div>
        <div v-if="state.error" class="wtf-err" role="alert">{{state.error}}</div>

        <template v-if="state.tab==='route'">
          <div class="wtf-field"><label for="wtf-rt-list">Pick List (last 30 days, this floor)</label>
            <select id="wtf-rt-list" class="wtf-inp" :value="state.selected" @change="selectList($event.target.value)">
              <option value="">Choose…</option>
              <option value="__sim__">Simulated order (12 bins)</option>
              <option v-for="pl in state.lists" :key="pl.name" :value="pl.name">{{pl.name}} · {{pl.floor_rows}} rows · {{pl.status}}</option>
            </select>
            <span v-if="state.listsLoading" class="wtf-muted"><span class="wtf-spin"></span> Loading pick lists…</span>
            <span v-else-if="!state.lists.length" class="wtf-muted">No Pick Lists on this floor in the last 30 days — try the simulated order.</span>
          </div>
          <div v-if="state.loading" class="wtf-muted"><span class="wtf-spin"></span> Planning route…</div>
          <template v-else-if="state.result">
            <div class="wtf-stats">
              <div class="wtf-stat"><div class="wtf-stat-l">Saved order</div><div class="wtf-stat-v" style="color:#f87171">{{fmtM(state.result.current.distance)}}</div><div class="wtf-muted">≈ {{fmtT(state.result.current.seconds)}}</div></div>
              <div class="wtf-stat"><div class="wtf-stat-l">Optimised</div><div class="wtf-stat-v" style="color:#4ade80">{{fmtM(state.result.optimized.distance)}}</div><div class="wtf-muted">≈ {{fmtT(state.result.optimized.seconds)}}</div></div>
            </div>
            <div class="wtf-card" style="display:flex;justify-content:space-between;align-items:center">
              <div><div class="wtf-stat-l">Walking saved</div><div class="wtf-muted">{{fmtM(state.result.current.distance-state.result.optimized.distance)}} · {{state.result.stops}} stops</div></div>
              <div class="wtf-rt-save">{{Math.round(state.result.saving*100)}}%</div>
            </div>
            <div class="wtf-rt-legend">
              <label class="wtf-rt-toggle"><input type="checkbox" v-model="state.showCur"/><span class="wtf-rt-swatch" style="background:#f87171"></span>Saved order</label>
              <label class="wtf-rt-toggle"><input type="checkbox" v-model="state.showOpt"/><span class="wtf-rt-swatch" style="background:#4ade80"></span>Optimised</label>
            </div>
            <div v-if="state.offFloor" class="wtf-muted" style="margin-bottom:6px">⚠ {{state.offFloor}} row{{state.offFloor===1?'':'s'}} on other floors or unmapped warehouses aren't included.</div>
            <div v-if="!ui.floor.dockSlot" class="wtf-muted" style="margin-bottom:6px">Route starts at the front-left corner. Set the dock in Putaway for an accurate start point.</div>
            <div class="wtf-sec">Optimised stops</div>
            <div v-for="(s,i) in stops" :key="s.slot" class="wtf-rt-stop" @click="focus(s)" tabindex="0" @keydown.enter="focus(s)">
              <span class="wtf-rt-n">{{i+1}}</span>
              <div><div class="wtf-rt-bin">{{s.label}}</div>
                <div class="wtf-rt-items"><span v-for="(r,j) in s.rows" :key="r.row_name">{{j?', ':''}}{{r.item_code}} × {{fmt(r.qty)}}</span></div></div>
            </div>
            <div v-if="state.saved" class="wtf-ok" style="margin-top:10px">Saved. Pickers will see this order on {{state.listMeta.name}}.</div>
          </template>
        </template>

        <template v-else>
          <div class="wtf-field"><label for="wtf-rt-days">Period</label>
            <div class="wtf-row">
              <select id="wtf-rt-days" class="wtf-inp" v-model.number="state.days">
                <option :value="7">Last 7 days</option><option :value="30">Last 30 days</option><option :value="90">Last 90 days</option>
              </select>
              <button class="wtf-btn wtf-btn-pri" style="flex:0 0 auto" :disabled="state.trafficLoading" @click="loadTraffic()">
                <span v-if="state.trafficLoading" class="wtf-spin"></span>Analyse</button>
            </div>
          </div>
          <template v-if="state.traffic">
            <div class="wtf-muted" style="margin-bottom:8px">{{state.traffic.trips}} pick trip{{state.traffic.trips===1?'':'s'}} walked in their saved order. Red floor = most trips. The walkway by the dock is left out of the list, since every trip passes it.</div>
            <div v-if="!state.traffic.hotspots.length" class="wtf-muted">No pick trips on this floor in this period.</div>
            <div class="wtf-sec" v-if="state.traffic.hotspots.length">Busiest spots</div>
            <div v-for="(h,i) in state.traffic.hotspots" :key="i" class="wtf-card clickable" @click="focusSpot(h)" tabindex="0" @keydown.enter="focusSpot(h)">
              <div class="wtf-rt-hot"><div><div class="wtf-rt-bin">{{h.where}}</div><div class="wtf-rt-items">near {{h.near}}</div></div>
                <b class="wtf-num" style="color:var(--wt-text)">{{h.n}} trips</b></div>
              <div class="wtf-rt-bar" :style="{width:Math.round(h.n/state.traffic.max*100)+'%'}"></div>
            </div>
            <button v-if="state.traffic.hotspots.length" class="wtf-btn wtf-btn-block" style="margin-top:8px" @click="pickHeat()">🎨 Colour bins by pick frequency</button>
            <div class="wtf-muted" style="margin-top:8px">Tip: moving the hottest bins closer to the dock shortens every trip through these spots.</div>
          </template>
        </template>

        <template #footer v-if="state.tab==='route' && state.result && state.listMeta && !state.listMeta.simulated">
          <span v-if="state.listMeta.docstatus!==0" class="wtf-muted" style="margin-right:auto">Only draft Pick Lists can be reordered.</span>
          <button class="wtf-btn wtf-btn-pri" :disabled="state.saving || state.saved || state.listMeta.docstatus!==0 || state.result.saving<=0"
            @click="saveOrder()"><span v-if="state.saving" class="wtf-spin"></span>Save optimised order</button>
        </template>
      </WtfPanel>`,
  });
  ext.overlays.push(RoutesPanel);

  ext.tools.push({
    id: 'routes', icon: '🧭', label: 'Routes', title: 'Pick routes and aisle traffic',
    show: () => !store.replayDate,
    active: () => ui.state.panel === 'routes',
    onClick: () => { if (ui.state.panel === 'routes') close(); else ui.openPanel('routes'); },
  });
});

})();
