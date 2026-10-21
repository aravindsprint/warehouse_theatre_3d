/* Warehouse Theatre 3D — heatmap modes.
   Recolours bins by movement, value, stock age, batch expiry or pick frequency
   instead of fill %. Data: api/insights.get_bin_metrics. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, hooks, bus, engine, addCSS, ui } = core;
  const { defineComponent, reactive, computed } = Vue;
  const { fmt, fmtK } = core.helpers;

  addCSS('wtf-heat-style', `
.wtf-heat-modes{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.wtf-heat-mode{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent}
.wtf-heat-mode:hover{background:var(--wt-pill)}
.wtf-heat-mode.act{background:var(--wt-pill);border-color:var(--wt-accent)}
.wtf-heat-mode input{margin-top:2px}
.wtf-heat-name{font-size:11px;font-weight:700;color:var(--wt-text)}
.wtf-heat-desc{font-size:9px;color:var(--wt-text3);line-height:1.4}
.wtf-heat-legend{display:flex;flex-direction:column;gap:3px;padding-top:8px;border-top:1px solid var(--wt-border)}
.wtf-heat-li{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--wt-text2)}
`);

  // Cool → hot ramp for "more activity" metrics; good → bad ramp for age/expiry.
  const COLD = 0x475569;
  const RAMP = [0x38bdf8, 0xa78bfa, 0xfb923c, 0xef4444];
  const RISK = [0x4ade80, 0xfacc15, 0xfb923c, 0xef4444];

  /* Quantile cut points over the non-zero values on this floor, so "fast" means fast
     relative to this warehouse rather than an arbitrary fixed number. */
  function cuts(values) {
    const v = values.filter(x => x > 0).sort((a, b) => a - b);
    if (!v.length) return null;
    const q = p => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
    return [q(1 / 3), q(2 / 3)];
  }
  function bucket3(x, c) { return x <= c[0] ? 1 : x <= c[1] ? 2 : 3; }
  const rng = (a, b) => a === b ? fmtK(a) : fmtK(a) + '–' + fmtK(b);

  const MODES = {
    fill: { label: 'Fill %', desc: 'How full each bin is against its UOM capacity (default).' },
    velocity: {
      label: 'Movement', desc: 'Outward stock movements in the period. Spot fast movers and dead stock.',
      value: m => m.out_txn || 0, relative: true, zeroLabel: 'Not moving', names: ['Slow', 'Medium', 'Fast'],
      fmt: (m, days) => `${m.out_txn || 0} moves out in ${days}d` + (m.idle_days != null ? ` · last move ${m.idle_days}d ago` : ''),
    },
    picks: {
      label: 'Pick frequency', desc: 'Pick List rows pointing at each bin. Hot bins belong near the dock.',
      value: m => m.picks || 0, relative: true, zeroLabel: 'No picks', names: ['Occasional', 'Regular', 'Hot'],
      fmt: (m, days) => `${m.picks || 0} picks in ${days}d`,
    },
    value: {
      label: 'Stock value', desc: 'Current stock value per bin (₹).',
      value: m => m.value || 0, relative: true, zeroLabel: null, names: ['Low value', 'Medium value', 'High value'],
      fmt: m => `Value ₹${Math.round(m.value || 0).toLocaleString('en-IN')}`,
    },
    ageing: {
      label: 'Stock age', desc: 'Average age of the stock on hand, estimated first-in-first-out from receipts.',
      fixed: [[30, '≤ 30 days'], [90, '31–90 days'], [180, '91–180 days'], [Infinity, '> 180 days']],
      value: m => m.age_days, palette: RISK,
      fmt: m => m.age_days == null ? null : `Avg age ${m.age_days}d` + (m.oldest_item ? ` · oldest ${m.oldest_item} (${m.oldest_age}d)` : ''),
    },
    expiry: {
      label: 'Batch expiry', desc: 'Days until the earliest expiring batch in the bin. Bins without batch expiry stay grey.',
      fixed: [[-1, 'Expired'], [30, '≤ 30 days'], [90, '31–90 days'], [Infinity, '> 90 days']],
      value: m => m.expiry_days, palette: [0xef4444, 0xfb923c, 0xfacc15, 0x4ade80],
      fmt: m => m.expiry_days == null ? null
        : (m.expiry_days < 0 ? `Batch ${m.expiry_batch} expired ${-m.expiry_days}d ago` : `Batch ${m.expiry_batch} expires in ${m.expiry_days}d`),
    },
  };

  const state = reactive({
    mode: 'fill', days: 90, metrics: {}, cuts: {}, loading: false, error: '', loadedKey: '', asOf: '',
  });

  function metricsFor(lv) { return state.metrics[lv.wh] || {}; }

  /* Bucket index (0 = coldest/none) for a level in the active mode, or -1 for "no colour". */
  function bucketOf(lv) {
    const M = MODES[state.mode];
    if (!M || !M.value) return -1;
    const m = metricsFor(lv);
    const hasStock = (lv.uoms || []).some(u => u.qty > 0);
    const x = M.value(m);
    if (M.fixed) {
      if (x === null || x === undefined) return -1;
      return M.fixed.findIndex(([max]) => x <= max);
    }
    // Zero activity is only worth a colour on a bin that holds stock ("dead stock").
    if (!x) return (M.zeroLabel && hasStock) ? 0 : -1;
    const c = state.cuts[state.mode];
    return c ? bucket3(x, c) : 3;
  }

  function colorOfBucket(b) {
    const M = MODES[state.mode];
    if (b < 0) return null;
    const hex = M.fixed ? (M.palette || RISK)[b] : (b === 0 ? COLD : RAMP[b]);
    return { hex, css: ui.hexCss(hex) };
  }

  function legend() {
    const M = MODES[state.mode];
    if (!M || !M.value) return null;
    if (M.fixed) return M.fixed.map(([, label], i) => ({ color: ui.hexCss((M.palette || RISK)[i]), label }));
    const c = state.cuts[state.mode];
    const out = [];
    if (M.zeroLabel) out.push({ color: ui.hexCss(COLD), label: M.zeroLabel });
    if (c) {
      const vals = Object.values(state.metrics).map(M.value).filter(x => x > 0);
      const max = Math.max(...vals);
      // Counts are whole numbers, so the next band starts one above the cut ("1–3, 4–6");
      // money is continuous, so bands share the boundary.
      const ints = vals.every(Number.isInteger);
      const above = x => ints ? x + 1 : x;
      out.push({ color: ui.hexCss(RAMP[1]), label: `${M.names[0]} (${rng(Math.min(...vals), c[0])})` });
      if (c[1] > c[0]) out.push({ color: ui.hexCss(RAMP[2]), label: `${M.names[1]} (${rng(above(c[0]), c[1])})` });
      if (max > c[1]) out.push({ color: ui.hexCss(RAMP[3]), label: `${M.names[2]} (${rng(above(c[1]), max)})` });
    }
    return out;
  }

  function apply() {
    const active = state.mode !== 'fill' && state.loadedKey;
    // Metrics describe today, so they'd be wrong on a replayed date: show fill % then.
    const live = () => !store.replayDate;
    hooks.lvColor = active ? (lv => live() ? colorOfBucket(bucketOf(lv)) : null) : null;
    hooks.slotColor = active ? (sl => live() ? colorOfBucket(Math.max(-1, ...sl.levels.map(bucketOf))) : null) : null;
    hooks.legend = active ? (() => live() ? legend() : null) : null;
    hooks.tooltipLines = active ? ((lv) => {
      if (!live()) return [];
      const M = MODES[state.mode];
      const line = M.fmt(metricsFor(lv), state.days);
      return line ? [line] : ['No data for this mode'];
    }) : null;
    if (store.threeReady) engine.recolor();
  }

  async function load(force) {
    if (!store.curGrp || state.mode === 'fill') { apply(); return; }
    const key = store.curGrp.id + '|' + state.days;
    if (!force && key === state.loadedKey) { apply(); return; }
    state.loading = true; state.error = '';
    try {
      const r = await core.api('insights', 'get_bin_metrics', { group_warehouse: store.curGrp.id, days: state.days });
      state.metrics = (r && r.metrics) || {};
      state.asOf = r && r.as_of;
      const cs = {};
      Object.entries(MODES).forEach(([k, M]) => {
        if (M.relative) cs[k] = cuts(Object.values(state.metrics).map(M.value));
      });
      state.cuts = cs;
      state.loadedKey = key;
    } catch (e) {
      state.error = 'Could not load heatmap data: ' + e.message;
      state.loadedKey = '';
    } finally {
      state.loading = false;
      apply();
    }
  }

  function setMode(mode) {
    if (!MODES[mode]) return;
    state.mode = mode;
    try { localStorage.setItem('wt3d-heat-mode', mode); } catch (e) {}
    load(false);
  }
  function setDays(d) { state.days = d; load(false); }

  try {
    const saved = localStorage.getItem('wt3d-heat-mode');
    if (saved && MODES[saved]) state.mode = saved;
  } catch (e) {}

  bus.on('group-selected', (g, changed) => { if (changed) state.loadedKey = ''; load(!changed); });
  bus.on('heatmap:set', mode => { setMode(mode); });

  const HeatPopover = defineComponent({
    name: 'WtfHeatPopover',
    setup() {
      const leg = computed(() => legend());
      return { state, MODES, setMode, setDays, leg, ui, load, left: () => ui.popLeft('wt-tool-heat', 250) };
    },
    template: `
      <div v-if="ui.state.panel==='heat'" class="wtf-pop" :style="{left:left()+'px'}" role="dialog" aria-label="Heatmap mode">
        <div class="wtf-heat-modes" role="radiogroup">
          <label v-for="(M,k) in MODES" :key="k" :class="['wtf-heat-mode', state.mode===k?'act':'']">
            <input type="radio" name="wtf-heat" :value="k" :checked="state.mode===k" @change="setMode(k)"/>
            <span><div class="wtf-heat-name">{{M.label}}</div><div class="wtf-heat-desc">{{M.desc}}</div></span>
          </label>
        </div>
        <div v-if="state.mode!=='fill' && state.mode!=='value'" class="wtf-field">
          <label for="wtf-heat-days">Period</label>
          <select id="wtf-heat-days" class="wtf-inp" :value="state.days" @change="setDays(+$event.target.value)">
            <option :value="30">Last 30 days</option><option :value="90">Last 90 days</option>
            <option :value="180">Last 180 days</option><option :value="365">Last 365 days</option>
          </select>
        </div>
        <div v-if="state.loading" class="wtf-muted"><span class="wtf-spin"></span> Loading…</div>
        <div v-else-if="state.error" class="wtf-err">{{state.error}} <a href="#" class="wtf-link" @click.prevent="load(true)">Retry</a></div>
        <div v-else-if="leg && leg.length" class="wtf-heat-legend">
          <div v-for="(l,i) in leg" :key="i" class="wtf-heat-li"><span class="wtf-dot" :style="{background:l.color}"></span>{{l.label}}</div>
          <div class="wtf-muted" style="margin-top:4px">As of {{state.asOf}} · hover a bin for its value</div>
        </div>
        <div v-else-if="state.mode!=='fill'" class="wtf-muted">No data for this mode on this floor yet.</div>
      </div>`,
  });
  ext.overlays.push(HeatPopover);

  /* Every metric for the selected bin, in the detail panel. */
  const HeatSection = defineComponent({
    name: 'WtfHeatSection',
    props: { d: Object },
    setup(props) {
      const rows = computed(() => {
        if (!props.d || !state.loadedKey) return [];
        const m = metricsFor(props.d.lv);
        return Object.entries(MODES).filter(([, M]) => M.fmt).map(([k, M]) => ({ k, label: M.label, text: M.fmt(m, state.days) })).filter(r => r.text);
      });
      return { rows, state };
    },
    template: `
      <div v-if="rows.length">
        <div class="wt-divider"></div>
        <span class="wt-dp-sec">Insights · {{state.days}} days</span>
        <div v-for="r in rows" :key="r.k" style="font-size:10px;color:var(--wt-text2);margin-bottom:4px;line-height:1.4">
          <b style="color:var(--wt-text)">{{r.label}}:</b> {{r.text}}
        </div>
      </div>`,
  });
  ext.panelSections.push(HeatSection);

  ext.tools.push({
    id: 'heat', icon: '🎨', title: 'Heatmap mode',
    get label() { return state.mode === 'fill' ? 'Heatmap' : MODES[state.mode].label; },
    active: () => state.mode !== 'fill' || ui.state.panel === 'heat',
    onClick: () => { ui.togglePanel('heat'); if (state.mode !== 'fill') load(false); },
  });

  core.heatmap = { state, setMode, MODES };
});

})();
