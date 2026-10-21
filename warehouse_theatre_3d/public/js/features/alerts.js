/* Warehouse Theatre 3D — capacity alerts.
   A toolbar badge counts bins at or above the threshold across all floors; the panel
   lists them and jumps to each one. Thresholds and the daily email are set in
   Warehouse Theatre Settings. Data: api/insights.get_capacity_alerts. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, bus, engine, actions, addCSS, ui } = core;
  const { defineComponent, reactive, computed } = Vue;

  addCSS('wtf-alerts-style', `
.wtf-al-row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.wtf-al-fill{font-size:13px;font-weight:900;color:#f87171;font-variant-numeric:tabular-nums}
.wtf-al-bar{height:4px;border-radius:2px;background:var(--wt-cb);margin-top:5px;overflow:hidden}
.wtf-al-bar>div{height:100%;background:#f87171}
`);

  const REFRESH_MS = 10 * 60 * 1000;
  const state = reactive({ data: null, loading: false, error: '', at: null });
  let timer = null;

  async function load() {
    state.loading = true; state.error = '';
    try {
      state.data = await core.api('insights', 'get_capacity_alerts', { company: store.company || undefined });
      state.at = new Date();
    } catch (e) { state.error = e.message; }
    finally { state.loading = false; }
  }

  // Load once the app is up, refresh periodically and after floor reloads (moves change fill).
  let started = false;
  bus.on('group-selected', () => {
    if (!started) { started = true; load(); timer = setInterval(load, REFRESH_MS); return; }
    if (!state.at || Date.now() - state.at.getTime() > 60 * 1000) load();
  });

  const count = computed(() => state.data ? state.data.bins.length : 0);
  const byFloor = computed(() => {
    if (!state.data) return [];
    const m = {};
    state.data.bins.forEach(b => { (m[b.floor] = m[b.floor] || { floor: b.floor, floor_label: b.floor_label, bins: [] }).bins.push(b); });
    return Object.values(m);
  });

  async function go(b) {
    if (!store.curGrp || store.curGrp.id !== b.floor) {
      const g = store.groups.find(x => x.id === b.floor);
      if (!g) { core.alert('That floor is hidden by the company filter.', 'orange'); return; }
      await actions.selectGroup(g);
    }
    const f = ui.findLevel(b.wh);
    if (!f) return;
    ui.drawBeacons('alert', [{ slot: f.slot.wh, level: f.level, color: 0xef4444, label: b.fill + '%' }]);
    ui.highlight2D('wtf-alert-2d', [f.slot.wh], '#ef4444');
    ui.frameSlots([f.slot.wh]);
    engine.highlight(core.helpers.lvKey(f.slot, f.lv));
    actions.openDP({ slot: f.slot, lv: f.lv });
  }
  function clearMarks() { engine.clearOverlay('alert'); ui.highlight2D('wtf-alert-2d', []); }
  function close() { ui.closePanel('alerts'); clearMarks(); }
  Vue.watch(() => ui.state.panel, p => { if (p !== 'alerts') clearMarks(); });

  const AlertsPanel = defineComponent({
    name: 'WtfAlertsPanel',
    components: { WtfPanel: ui.Panel },
    setup() { return { state, ui, store, byFloor, count, go, close, load }; },
    template: `
      <WtfPanel v-if="ui.state.panel==='alerts'" title="⚠ Capacity alerts"
        :sub="state.data ? 'Bins at or above ' + state.data.bin_threshold + '% · floors at or above ' + state.data.floor_threshold + '%' : 'Checking…'" @close="close()">
        <div v-if="state.error" class="wtf-err" role="alert">{{state.error}}</div>
        <div v-if="state.loading && !state.data" class="wtf-muted"><span class="wtf-spin"></span> Checking capacity…</div>
        <template v-else-if="state.data">
          <template v-if="state.data.floors.length">
            <div class="wtf-sec">Floors</div>
            <div v-for="f in state.data.floors" :key="f.floor" class="wtf-card"><div class="wtf-al-row">
              <div><div class="wtf-pa-bin" style="font-size:11px;font-weight:700">{{f.floor_label}}</div><div class="wtf-muted">average of {{f.bins}} bins with capacity set</div></div>
              <div class="wtf-al-fill">{{f.fill}}%</div></div></div>
          </template>
          <div v-if="!count && !state.data.floors.length" class="wtf-ok">Nothing over the limit. 👍</div>
          <template v-for="g in byFloor" :key="g.floor">
            <div class="wtf-sec">{{g.floor_label}} · {{g.bins.length}} bin{{g.bins.length===1?'':'s'}}</div>
            <div v-for="b in g.bins" :key="b.wh" class="wtf-card clickable" @click="go(b)" tabindex="0" @keydown.enter="go(b)">
              <div class="wtf-al-row">
                <div><div style="font-size:11px;font-weight:700;color:var(--wt-text)">{{b.slot_label}} · {{b.label}}</div><div class="wtf-muted">{{b.wh}}</div></div>
                <div class="wtf-al-fill">{{b.fill}}%</div>
              </div>
              <div class="wtf-al-bar"><div :style="{width:Math.min(100,b.fill)+'%'}"></div></div>
            </div>
          </template>
          <div class="wtf-muted" style="margin-top:10px">Only bins with a UOM capacity set are checked.
            <template v-if="store.canEdit"> Change thresholds or turn on the daily email in <a class="wtf-link" href="/app/warehouse-theatre-settings" target="_blank" rel="noopener">Warehouse Theatre Settings ↗</a>.</template></div>
        </template>
        <template #footer><button class="wtf-btn" :disabled="state.loading" @click="load()"><span v-if="state.loading" class="wtf-spin"></span>Refresh</button></template>
      </WtfPanel>`,
  });
  ext.overlays.push(AlertsPanel);

  ext.tools.push({
    id: 'alerts', icon: '⚠', label: 'Alerts', title: 'Bins over capacity',
    badge: () => count.value || null,
    active: () => ui.state.panel === 'alerts',
    onClick: () => { if (ui.state.panel === 'alerts') close(); else { ui.openPanel('alerts'); load(); } },
  });

  // Company switch changes which bins count.
  Vue.watch(() => store.company, () => { if (started) load(); });
});

})();
