/* Warehouse Theatre 3D — Operations.
   Where every delivery order is (pending → picked → packed → dispatched), in both
   ERPNext flows (Delivery Note + Packing Slip, or Sales Invoice with Update Stock),
   and a dashboard per role:
     My work  every view role: what's waiting, what I picked and packed
     Orders   every view role: each order's stage, who handled it, its documents
     Team     Stock Manager / System Manager: pipeline, stage times, stuck orders, people
     System   System Manager: mapping coverage and data quality
   Data: api/fulfillment.get_operations. Reuses the Stock Health page styles (.wth-*). */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, addCSS } = core;
  const { defineComponent, reactive, computed, watch, onMounted } = Vue;

  addCSS('wtf-ops-style', `
.wto-stage{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:800;white-space:nowrap}
.wto-stage i{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.wto-stage.pending{background:rgba(100,116,139,.16);color:#64748b}
.wto-stage.picked{background:rgba(59,130,246,.15);color:#3b82f6}
.wto-stage.packed{background:rgba(139,92,246,.15);color:#8b5cf6}
.wto-stage.dispatched{background:rgba(34,197,94,.15);color:#16a34a}
.wto-card-stage::before{background:var(--stc,#64748b)!important}
.wto-funnel{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;margin-bottom:16px;border-radius:10px;overflow:hidden;border:1px solid var(--wt-cb)}
@media(max-width:600px){.wto-funnel{grid-template-columns:repeat(2,1fr)}}
.wto-fs{background:var(--wt-card);padding:10px 12px;cursor:pointer;border:none;text-align:left;color:var(--wt-text);position:relative}
.wto-fs:hover,.wto-fs.act{background:var(--wt-pill)}
.wto-fs:focus-visible{outline:2px solid var(--wt-accent);outline-offset:-2px}
.wto-fs .n{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:2px}
.wto-fs .d{font-size:10px;color:var(--wt-text2)}
.wto-fs .bar{height:4px;border-radius:2px;background:var(--wt-cb);margin-top:8px;overflow:hidden}
.wto-fs .bar>div{height:100%;border-radius:2px}
.wto-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:16px}
@media(max-width:900px){.wto-grid2{grid-template-columns:minmax(0,1fr)}}
.wto-box{background:var(--wt-card);border:1px solid var(--wt-cb);border-radius:10px;padding:12px}
.wto-bt{font-size:11px;font-weight:800;color:var(--wt-text);margin-bottom:2px}
.wto-bs{font-size:10px;color:var(--wt-text3);margin-bottom:10px}
.wto-cols{display:flex;align-items:flex-end;gap:2px;height:96px;border-bottom:1px solid var(--wt-border)}
.wto-col{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:100%;position:relative;cursor:default}
.wto-col>div{background:var(--wt-accent);border-radius:4px 4px 0 0;min-height:0}
.wto-col:hover>div{background:var(--wt-accent2)}
.wto-col.zero>div{background:var(--wt-cb);height:2px!important}
.wto-axis{display:flex;justify-content:space-between;font-size:9px;color:var(--wt-text3);margin-top:4px}
.wto-tip{position:absolute;bottom:calc(100% + 4px);left:50%;transform:translateX(-50%);background:var(--wt-bg2);border:1px solid var(--wt-cb);border-radius:6px;padding:3px 7px;font-size:10px;color:var(--wt-text);white-space:nowrap;pointer-events:none;display:none;z-index:2}
.wto-col:hover .wto-tip{display:block}
.wto-col:nth-child(-n+3) .wto-tip{left:0;transform:none}
.wto-col:nth-last-child(-n+3) .wto-tip{left:auto;right:0;transform:none}
.wto-peak{font-size:9px;color:var(--wt-text3);text-align:right;margin-bottom:2px}
.wto-times{width:100%;border-collapse:collapse;font-size:11px}
.wto-times td{padding:6px 4px;border-bottom:1px solid var(--wt-border);color:var(--wt-text2)}
.wto-times tr:last-child td{border-bottom:none}
.wto-times td.v{text-align:right;font-weight:800;color:var(--wt-text);font-variant-numeric:tabular-nums}
.wto-docs a{display:inline-block;margin-right:6px;font-size:10px;color:var(--wt-accent2);text-decoration:none;white-space:nowrap}
.wto-docs a.draft{color:var(--wt-text3)}
.wto-docs a:hover{text-decoration:underline}
.wto-flt{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.wto-pill{height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--wt-cb);background:transparent;color:var(--wt-text2);font-size:10px;font-weight:700;cursor:pointer}
.wto-pill.act{background:var(--wt-pill);border-color:var(--wt-accent);color:var(--wt-text)}
.wto-chk{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--wt-text2);cursor:pointer}
.wth-t td.wth-code a{white-space:nowrap}
.wto-who{font-size:10px;color:var(--wt-text2);white-space:nowrap}
.wto-muted{color:var(--wt-text3)}
`);

  const STAGE_LABEL = { pending: 'Pending', picked: 'Picked', packed: 'Packed', dispatched: 'Dispatched' };
  const STAGE_COLOR = { pending: '#64748b', picked: '#3b82f6', packed: '#8b5cf6', dispatched: '#22c55e' };
  const STAGE_HELP = {
    pending: 'Pick List still a draft',
    picked: 'Pick List submitted, not packed yet',
    packed: 'Packing Slip on a draft Delivery Note, or a draft stock invoice',
    dispatched: 'Delivery Note or stock invoice submitted',
  };
  const TIME_LABELS = [
    ['wait', 'Waiting to be picked', 'Pick List created → submitted'],
    ['pack', 'Picked → packed', 'Pick List submitted → Packing Slip or draft invoice'],
    ['ship', 'Packed → dispatched', 'Packed (or picked) → Delivery Note / invoice posted'],
    ['total', 'Order to dispatch', 'Pick List created → dispatched'],
  ];

  const state = reactive({
    data: null, loading: false, error: '', days: 30, floorOnly: false, tab: null, stage: 'open', loadedKey: '',
  });
  try {
    const t = localStorage.getItem('wt3d-ops-tab'); if (t) state.tab = t;
    state.floorOnly = localStorage.getItem('wt3d-ops-floor') === '1';
  } catch (e) {}

  function floor() { return state.floorOnly && store.curGrp ? store.curGrp.id : ''; }

  async function load(refresh) {
    const key = [store.company || '', state.days, floor()].join('|');
    if (!refresh && key === state.loadedKey && state.data) return;
    state.loading = true; state.error = '';
    try {
      state.data = await core.api('fulfillment', 'get_operations', {
        company: store.company || undefined, days: state.days, floor: floor() || undefined, refresh: refresh ? 1 : 0,
      });
      state.loadedKey = key;
    } catch (e) { state.error = 'Could not load operations: ' + e.message; }
    finally { state.loading = false; }
  }

  function hrs(h) {
    if (h === null || h === undefined) return '—';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
    if (h < 48) return (h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)) + 'h';
    return Math.round(h / 24) + 'd';
  }
  const pct = v => (v === null || v === undefined) ? '—' : v + '%';
  const docUrl = (dt, n) => '/app/' + dt.toLowerCase().replace(/ /g, '-') + '/' + encodeURIComponent(n);
  const shortDate = s => { const d = new Date(s + 'T00:00:00'); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };

  function match(o) {
    const q = (store.searchQuery || '').toLowerCase();
    if (!q) return true;
    return [o.name, o.customer, o.picked_by, o.packed_by, ...(o.docs || []).map(d => d.name)]
      .some(v => v && String(v).toLowerCase().includes(q));
  }

  const OpsView = defineComponent({
    name: 'WtfOpsView',
    setup() {
      onMounted(() => load(false));
      watch(() => store.company, () => load(false));
      watch(() => store.curGrp && store.curGrp.id, () => { if (state.floorOnly) load(false); });

      const d = computed(() => state.data);
      const access = computed(() => (d.value && d.value.access) || {});
      const tabs = computed(() => {
        const t = [{ id: 'me', label: 'My work' }, { id: 'orders', label: 'Orders' }];
        if (access.value.manager) t.push({ id: 'team', label: 'Team' });
        if (access.value.admin) t.push({ id: 'system', label: 'System' });
        return t;
      });
      const tab = computed(() => {
        const ids = tabs.value.map(t => t.id);
        if (state.tab && ids.includes(state.tab)) return state.tab;
        return access.value.manager ? 'team' : 'me';
      });
      function setTab(id) { state.tab = id; try { localStorage.setItem('wt3d-ops-tab', id); } catch (e) {} }
      function setFloorOnly(v) { state.floorOnly = v; try { localStorage.setItem('wt3d-ops-floor', v ? '1' : '0'); } catch (e) {} load(false); }

      const byName = computed(() => {
        const m = {}; (d.value ? d.value.orders : []).forEach(o => { m[o.name] = o; }); return m;
      });
      const pick = names => (names || []).map(n => byName.value[n]).filter(Boolean);
      const who = u => u ? ((d.value && d.value.names && d.value.names[u]) || u) : '—';

      const counts = computed(() => {
        const c = { pending: 0, picked: 0, packed: 0, dispatched: 0 };
        (d.value ? d.value.orders : []).forEach(o => { c[o.stage]++; });
        c.open = c.pending + c.picked + c.packed;
        return c;
      });
      const orders = computed(() => {
        if (!d.value) return [];
        const s = state.stage;
        return d.value.orders
          .filter(o => s === 'all' || (s === 'open' ? o.stage !== 'dispatched' : o.stage === s))
          .filter(match)
          .sort((a, b) => (b.hours_in_stage || 0) - (a.hours_in_stage || 0));
      });
      const funnelMax = computed(() => {
        const f = d.value && d.value.team ? d.value.team.funnel : counts.value;
        return Math.max(1, ...Object.values(f));
      });
      function setStage(s) { state.stage = s; setTab('orders'); }

      function series(list) {
        const max = Math.max(1, ...list.map(x => x.n));
        return list.map(x => ({ ...x, h: Math.round(100 * x.n / max) }));
      }

      return { state, store, d, access, tabs, tab, setTab, setFloorOnly, counts, orders, pick, who, hrs, pct, docUrl,
        shortDate, series, funnelMax, setStage, load, STAGE_LABEL, STAGE_COLOR, STAGE_HELP, TIME_LABELS,
        STAGES: ['pending', 'picked', 'packed', 'dispatched'],
        route: n => core.routes && core.routes.openFor(n),
        money: v => Math.round(v || 0).toLocaleString('en-IN') };
    },
    template: `
      <div class="wth" role="region" aria-label="Operations">
        <div class="wth-in">
          <div class="wth-head">
            <div>
              <div class="wth-title">Operations</div>
              <div class="wth-sub" v-if="d">As of {{d.as_of}} · {{d.company || 'all companies'}} · {{d.floor ? 'orders with lines on ' + (store.curGrp ? store.curGrp.name : d.floor) : 'every floor'}} · last {{d.days}} days plus anything still open</div>
            </div>
            <div class="wth-ctrl">
              <label class="wto-chk" v-if="store.curGrp"><input type="checkbox" :checked="state.floorOnly" @change="setFloorOnly($event.target.checked)"> This floor only</label>
              <select class="wtf-inp" v-model.number="state.days" @change="load(false)" aria-label="Period">
                <option :value="7">Last 7 days</option><option :value="14">Last 14 days</option>
                <option :value="30">Last 30 days</option><option :value="90">Last 90 days</option>
              </select>
              <button class="wtf-btn" :disabled="state.loading" @click="load(true)"><span v-if="state.loading" class="wtf-spin"></span>Refresh</button>
            </div>
          </div>

          <div v-if="state.error" class="wtf-err" role="alert">{{state.error}}</div>
          <div v-if="state.loading && !d" class="wth-load"><span class="wtf-spin"></span> Loading orders…</div>

          <template v-if="d">
            <div class="wth-tabs" role="tablist">
              <button v-for="t in tabs" :key="t.id" role="tab" :aria-selected="tab===t.id" :class="['wth-tab', tab===t.id?'act':'']" @click="setTab(t.id)">{{t.label}}</button>
            </div>

            <!-- ───────── My work ───────── -->
            <template v-if="tab==='me'">
              <div class="wth-cards">
                <button class="wth-card info" @click="setStage('pending')">
                  <div class="wth-cl">Waiting to pick</div><div class="wth-cv">{{d.me.waiting}}</div>
                  <div class="wth-cd">{{d.me.waiting ? 'Oldest waiting ' + hrs(d.me.oldest_pending_hours) : 'Nothing waiting'}}</div>
                </button>
                <div :class="['wth-card', d.me.assigned.length ? 'warn' : 'ok']">
                  <div class="wth-cl">Assigned to me</div><div class="wth-cv">{{d.me.assigned.length}}</div>
                  <div class="wth-cd">Draft Pick Lists assigned to you in ERPNext</div>
                </div>
                <div class="wth-card ok">
                  <div class="wth-cl">Picked today</div><div class="wth-cv">{{d.me.picked_today.orders}}</div>
                  <div class="wth-cd">{{d.me.picked_today.lines}} lines · {{pct(d.me.picked_today.accuracy)}} picked in full</div>
                </div>
                <div class="wth-card ok">
                  <div class="wth-cl">Picked this week</div><div class="wth-cv">{{d.me.picked_week.orders}}</div>
                  <div class="wth-cd">{{d.me.picked_week.lines}} lines · {{d.me.picked_week.short}} short</div>
                </div>
                <div class="wth-card info">
                  <div class="wth-cl">Packed</div><div class="wth-cv">{{d.me.packed_today}}</div>
                  <div class="wth-cd">today · {{d.me.packed_week}} this week</div>
                </div>
              </div>

              <div class="wto-grid2">
                <div class="wto-box">
                  <div class="wto-bt">Pick Lists I submitted</div><div class="wto-bs">Per day, last 14 days</div>
                  <div class="wto-peak">peak {{Math.max(...d.me.daily.map(x => x.n))}}/day</div>
                  <div class="wto-cols" role="img" :aria-label="'Pick Lists per day: ' + d.me.daily.map(x => shortDate(x.date) + ' ' + x.n).join(', ')">
                    <div v-for="x in series(d.me.daily)" :key="x.date" :class="['wto-col', x.n ? '' : 'zero']">
                      <div :style="{height: x.h + '%'}"></div><span class="wto-tip">{{shortDate(x.date)}} · {{x.n}}</span>
                    </div>
                  </div>
                  <div class="wto-axis"><span>{{shortDate(d.me.daily[0].date)}}</span><span>Today</span></div>
                </div>
                <div class="wto-box">
                  <div class="wto-bt">Assigned to me</div><div class="wto-bs">Open them in Warehouse Scan to pick</div>
                  <div v-if="!d.me.assigned.length" class="wto-muted" style="font-size:11px">Nothing assigned. Pick from the waiting list in Warehouse Scan.</div>
                  <div v-for="o in pick(d.me.assigned)" :key="o.name" class="wtf-al-row" style="padding:5px 0;border-bottom:1px solid var(--wt-border)">
                    <div><b style="font-size:11px">{{o.name}}</b> <span class="wto-muted" style="font-size:10px">{{o.customer}} · {{o.lines}} lines · waiting {{hrs(o.hours_in_stage)}}</span></div>
                    <a class="wtf-link" href="/warehouse-scan" style="font-size:10px">Scan ↗</a>
                  </div>
                </div>
              </div>

              <div class="wth-note">Orders I picked recently and where they are now.</div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Pick List</th><th>Customer</th><th>Now</th><th class="r">Lines</th><th class="r">Short</th><th>Picked</th></tr></thead>
                <tbody>
                  <tr v-for="o in pick(d.me.recent)" :key="o.name">
                    <td class="wth-code"><a class="wtf-link" :href="docUrl('Pick List', o.name)" target="_blank" rel="noopener">{{o.name}}</a></td>
                    <td>{{o.customer || '—'}}</td>
                    <td><span :class="['wto-stage', o.stage]"><i></i>{{STAGE_LABEL[o.stage]}}</span></td>
                    <td class="r">{{o.lines}}</td><td class="r"><span v-if="o.short" class="wth-chip warn">{{o.short}}</span><span v-else>0</span></td>
                    <td class="wto-who">{{o.picked_at}}</td>
                  </tr>
                  <tr v-if="!d.me.recent.length"><td colspan="6" class="wth-empty">You haven't submitted a Pick List in this period.</td></tr>
                </tbody>
              </table></div>
            </template>

            <!-- ───────── Orders ───────── -->
            <template v-else-if="tab==='orders'">
              <div class="wto-funnel">
                <button v-for="s in STAGES" :key="s" :class="['wto-fs', state.stage===s?'act':'']" @click="state.stage=s" :title="STAGE_HELP[s]">
                  <span :class="['wto-stage', s]"><i></i>{{STAGE_LABEL[s]}}</span>
                  <div class="n">{{counts[s]}}</div>
                  <div class="d">{{STAGE_HELP[s]}}</div>
                </button>
              </div>
              <div class="wto-flt">
                <button :class="['wto-pill', state.stage==='open'?'act':'']" @click="state.stage='open'">Not dispatched · {{counts.open}}</button>
                <button v-for="s in STAGES" :key="s" :class="['wto-pill', state.stage===s?'act':'']" @click="state.stage=s">{{STAGE_LABEL[s]}} · {{counts[s]}}</button>
                <button :class="['wto-pill', state.stage==='all'?'act':'']" @click="state.stage='all'">All · {{d.orders.length}}</button>
              </div>
              <div class="wth-tw"><table class="wth-t" style="min-width:860px">
                <thead><tr><th>Pick List</th><th>Customer</th><th>Stage</th><th class="r">In stage</th><th class="r">Lines</th><th>Picked by</th><th>Packed by</th><th>Documents</th><th class="r">Billed</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="o in orders" :key="o.name">
                    <td class="wth-code"><a class="wtf-link" :href="docUrl('Pick List', o.name)" target="_blank" rel="noopener">{{o.name}}</a></td>
                    <td><div class="wth-name" style="max-width:160px" :title="o.customer">{{o.customer || '—'}}</div></td>
                    <td><span :class="['wto-stage', o.stage]"><i></i>{{STAGE_LABEL[o.stage]}}</span>
                      <span v-if="o.partial" class="wth-chip warn" style="margin-left:4px" title="Less went out than was picked">part</span></td>
                    <td class="r"><span :class="o.stage!=='dispatched' && o.hours_in_stage>=24 ? 'wth-chip bad' : ''">{{hrs(o.hours_in_stage)}}</span></td>
                    <td class="r">{{o.stage==='pending' ? o.progress + '/' + o.lines : o.lines}}<span v-if="o.short" class="wth-chip warn" style="margin-left:4px" :title="o.short + ' short'">−{{o.short}}</span></td>
                    <td class="wto-who">{{o.picked_by ? who(o.picked_by) : (o.stage==='pending' ? (o.assigned.length ? '→ ' + o.assigned.map(who).join(', ') : '—') : '?')}}</td>
                    <td class="wto-who">{{who(o.packed_by)}}</td>
                    <td class="wto-docs"><a v-for="x in o.docs" :key="x.name" :class="x.docstatus ? '' : 'draft'" :href="docUrl(x.doctype, x.name)" target="_blank" rel="noopener" :title="x.doctype + (x.docstatus ? '' : ' (draft)')">{{x.name}}</a><span v-if="!o.docs.length" class="wto-muted">—</span></td>
                    <td class="r">{{o.billed===null ? '—' : o.billed + '%'}}</td>
                    <td class="wth-act"><button v-if="o.stage==='pending' && store.setupComplete" @click="route(o.name)" title="Show its walking route">🧭 Route</button></td>
                  </tr>
                  <tr v-if="!orders.length"><td colspan="10" class="wth-empty">{{store.searchQuery ? 'No matches.' : 'No orders here.'}}</td></tr>
                </tbody>
              </table></div>
              <div class="wth-note" style="margin-top:10px">“Picked by” is whoever submitted the Pick List (recorded from this version on; “?” for older lists). Delivery Note flow: packed = a submitted Packing Slip on a draft Delivery Note. Sales Invoice flow (Update Stock on): packed = a draft invoice, dispatched = submitted.</div>
            </template>

            <!-- ───────── Team ───────── -->
            <template v-else-if="tab==='team' && d.team">
              <div class="wto-funnel" role="list" aria-label="Orders by stage">
                <button v-for="s in STAGES" :key="s" class="wto-fs" role="listitem" @click="setStage(s)" :title="STAGE_HELP[s]">
                  <span :class="['wto-stage', s]"><i></i>{{STAGE_LABEL[s]}}</span>
                  <div class="n">{{d.team.funnel[s]}}</div>
                  <div class="d">{{s==='dispatched' ? 'in the last ' + d.days + ' days · ' + d.team.dispatched_today + ' today' : 'open now'}}</div>
                  <div class="bar"><div :style="{width: (100 * d.team.funnel[s] / funnelMax) + '%', background: STAGE_COLOR[s]}"></div></div>
                </button>
              </div>

              <div class="wth-cards">
                <button :class="['wth-card', d.team.stuck_count ? 'bad' : 'ok']" @click="setStage('open')">
                  <div class="wth-cl">Stuck over {{d.team.stuck_hours}}h</div><div class="wth-cv">{{d.team.stuck_count}}</div>
                  <div class="wth-cd">Orders not moved to the next stage in a day</div>
                </button>
                <div :class="['wth-card', d.team.accuracy.percent===null ? 'info' : d.team.accuracy.percent >= 98 ? 'ok' : 'warn']">
                  <div class="wth-cl">Picked in full</div><div class="wth-cv">{{pct(d.team.accuracy.percent)}}</div>
                  <div class="wth-cd">{{d.team.accuracy.short}} short of {{d.team.accuracy.lines}} lines</div>
                </div>
                <div :class="['wth-card', d.team.unbilled_count ? 'warn' : 'ok']">
                  <div class="wth-cl">Dispatched, not fully billed</div><div class="wth-cv">{{d.team.unbilled_count}}</div>
                  <div class="wth-cd">Delivery Notes still to invoice</div>
                </div>
                <div class="wth-card info">
                  <div class="wth-cl">Flows</div><div class="wth-cv">{{d.team.flows['Delivery Note']}} / {{d.team.flows['Sales Invoice']}}</div>
                  <div class="wth-cd">via Delivery Note / via stock invoice</div>
                </div>
                <div :class="['wth-card', d.team.scanner_share===null ? 'info' : d.team.scanner_share >= 80 ? 'ok' : 'warn']">
                  <div class="wth-cl">Picked with scanner</div><div class="wth-cv">{{pct(d.team.scanner_share)}}</div>
                  <div class="wth-cd">of submitted Pick Lists</div>
                </div>
                <div v-if="d.team.capacity_alerts!==null" :class="['wth-card', d.team.capacity_alerts ? 'warn' : 'ok']">
                  <div class="wth-cl">Bins over capacity</div><div class="wth-cv">{{d.team.capacity_alerts}}</div>
                  <div class="wth-cd">See ⚠ Alerts on the map</div>
                </div>
              </div>

              <div class="wto-grid2">
                <div class="wto-box">
                  <div class="wto-bt">How long each stage takes</div><div class="wto-bs">Median (average) over the period</div>
                  <table class="wto-times"><tbody>
                    <tr v-for="t in TIME_LABELS" :key="t[0]">
                      <td><div style="color:var(--wt-text);font-weight:700">{{t[1]}}</div><div class="wto-muted" style="font-size:9px">{{t[2]}} · {{d.team.times[t[0]].n}} orders</div></td>
                      <td class="v">{{hrs(d.team.times[t[0]].median)}} <span class="wto-muted" style="font-weight:400">({{hrs(d.team.times[t[0]].avg)}})</span></td>
                    </tr>
                  </tbody></table>
                </div>
                <div class="wto-box">
                  <div class="wto-bt">Dispatched per day</div><div class="wto-bs">Delivery Notes and stock invoices posted, last 14 days</div>
                  <div class="wto-peak">peak {{Math.max(...d.team.series.dispatched.map(x => x.n))}}/day</div>
                  <div class="wto-cols" role="img" :aria-label="'Dispatched per day: ' + d.team.series.dispatched.map(x => shortDate(x.date) + ' ' + x.n).join(', ')">
                    <div v-for="x in series(d.team.series.dispatched)" :key="x.date" :class="['wto-col', x.n ? '' : 'zero']">
                      <div :style="{height: x.h + '%'}"></div><span class="wto-tip">{{shortDate(x.date)}} · {{x.n}} dispatched</span>
                    </div>
                  </div>
                  <div class="wto-axis"><span>{{shortDate(d.team.series.dispatched[0].date)}}</span><span>Today</span></div>
                  <div class="wto-bt" style="margin-top:14px">Picked per day</div>
                  <div class="wto-peak">peak {{Math.max(...d.team.series.picked.map(x => x.n))}}/day</div>
                  <div class="wto-cols" style="height:60px" role="img" :aria-label="'Picked per day: ' + d.team.series.picked.map(x => shortDate(x.date) + ' ' + x.n).join(', ')">
                    <div v-for="x in series(d.team.series.picked)" :key="x.date" :class="['wto-col', x.n ? '' : 'zero']">
                      <div :style="{height: x.h + '%'}"></div><span class="wto-tip">{{shortDate(x.date)}} · {{x.n}} picked</span>
                    </div>
                  </div>
                </div>
              </div>

              <div class="wto-grid2">
                <div>
                  <div class="wto-bt" style="margin-bottom:6px">Pickers</div>
                  <div class="wth-tw"><table class="wth-t" style="min-width:0">
                    <thead><tr><th>Person</th><th class="r">Today</th><th class="r">7 days</th><th class="r">Lists</th><th class="r">Lines</th><th class="r">In full</th></tr></thead>
                    <tbody>
                      <tr v-for="p in d.team.pickers" :key="p.user">
                        <td class="wth-code">{{who(p.user)}}</td><td class="r">{{p.today}}</td><td class="r">{{p.week}}</td>
                        <td class="r">{{p.orders}}</td><td class="r">{{p.lines}}</td>
                        <td class="r"><span :class="['wth-chip', p.accuracy===null ? '' : p.accuracy >= 98 ? 'ok' : 'warn']">{{pct(p.accuracy)}}</span></td>
                      </tr>
                      <tr v-if="!d.team.pickers.length"><td colspan="6" class="wth-empty">No stamped picks yet.</td></tr>
                    </tbody>
                  </table></div>
                  <div v-if="d.team.unknown_picker" class="wth-note" style="margin-top:6px">{{d.team.unknown_picker}} Pick Lists were submitted before picker tracking was installed.</div>
                </div>
                <div>
                  <div class="wto-bt" style="margin-bottom:6px">Packers</div>
                  <div class="wth-tw"><table class="wth-t" style="min-width:0">
                    <thead><tr><th>Person</th><th class="r">Today</th><th class="r">7 days</th><th class="r">Orders</th><th class="r">Lines</th></tr></thead>
                    <tbody>
                      <tr v-for="p in d.team.packers" :key="p.user">
                        <td class="wth-code">{{who(p.user)}}</td><td class="r">{{p.today}}</td><td class="r">{{p.week}}</td><td class="r">{{p.orders}}</td><td class="r">{{p.lines}}</td>
                      </tr>
                      <tr v-if="!d.team.packers.length"><td colspan="5" class="wth-empty">No Packing Slips or stock invoices in this period.</td></tr>
                    </tbody>
                  </table></div>
                </div>
              </div>

              <div class="wto-bt" style="margin-bottom:6px">Stuck orders</div>
              <div class="wth-tw" style="margin-bottom:16px"><table class="wth-t">
                <thead><tr><th>Pick List</th><th>Customer</th><th>Stage</th><th class="r">In stage</th><th>Who</th></tr></thead>
                <tbody>
                  <tr v-for="o in pick(d.team.stuck)" :key="o.name">
                    <td class="wth-code"><a class="wtf-link" :href="docUrl('Pick List', o.name)" target="_blank" rel="noopener">{{o.name}}</a></td>
                    <td>{{o.customer || '—'}}</td><td><span :class="['wto-stage', o.stage]"><i></i>{{STAGE_LABEL[o.stage]}}</span></td>
                    <td class="r"><span class="wth-chip bad">{{hrs(o.hours_in_stage)}}</span></td>
                    <td class="wto-who">{{o.stage==='pending' ? (o.assigned.length ? '→ ' + o.assigned.map(who).join(', ') : 'unassigned') : o.stage==='picked' ? (o.picked_by ? 'picked by ' + who(o.picked_by) : 'picker not recorded') : 'packed by ' + who(o.packed_by)}}</td>
                  </tr>
                  <tr v-if="!d.team.stuck.length"><td colspan="5" class="wth-empty">Nothing stuck. 👍</td></tr>
                </tbody>
              </table></div>

              <template v-if="d.team.unbilled_count">
                <div class="wto-bt" style="margin-bottom:6px">Dispatched, not fully billed</div>
                <div class="wth-tw"><table class="wth-t">
                  <thead><tr><th>Pick List</th><th>Customer</th><th>Delivery Note</th><th class="r">Billed</th><th class="r">Since dispatch</th></tr></thead>
                  <tbody>
                    <tr v-for="o in pick(d.team.unbilled)" :key="o.name">
                      <td class="wth-code">{{o.name}}</td><td>{{o.customer || '—'}}</td>
                      <td class="wto-docs"><a v-for="x in o.docs" :key="x.name" :href="docUrl(x.doctype, x.name)" target="_blank" rel="noopener">{{x.name}}</a></td>
                      <td class="r"><span class="wth-chip warn">{{o.billed}}%</span></td><td class="r">{{hrs(o.hours_in_stage)}}</td>
                    </tr>
                  </tbody>
                </table></div>
              </template>
            </template>

            <!-- ───────── System ───────── -->
            <template v-else-if="tab==='system' && d.system">
              <div class="wth-cards">
                <div class="wth-card info">
                  <div class="wth-cl">Mapped</div><div class="wth-cv">{{d.system.locations}}</div>
                  <div class="wth-cd">stock locations · {{['Building','Floor','Slot','Bin','Zone'].map(t => (d.system.mapped[t]||0) + ' ' + t).join(' · ')}}</div>
                </div>
                <div :class="['wth-card', d.system.unmapped_with_stock ? 'warn' : 'ok']">
                  <div class="wth-cl">Stock outside the map</div><div class="wth-cv">{{d.system.unmapped_with_stock}}</div>
                  <div class="wth-cd">warehouses holding stock with no Warehouse Type (Theatre)</div>
                </div>
                <div :class="['wth-card', d.system.no_capacity ? 'warn' : 'ok']">
                  <div class="wth-cl">No capacity set</div><div class="wth-cv">{{d.system.no_capacity}}</div>
                  <div class="wth-cd">of {{d.system.locations}} bins and zones, so no fill % or alerts</div>
                </div>
                <div :class="['wth-card', d.system.pick_rows_off_map.unmapped ? 'warn' : 'ok']">
                  <div class="wth-cl">Pick lines off the map</div>
                  <div class="wth-cv">{{d.system.pick_rows_off_map.rows ? Math.round(100 * d.system.pick_rows_off_map.unmapped / d.system.pick_rows_off_map.rows) : 0}}%</div>
                  <div class="wth-cd">{{d.system.pick_rows_off_map.unmapped}} of {{d.system.pick_rows_off_map.rows}} lines pick from a warehouse that isn't a mapped Bin or Zone, so they get no route</div>
                </div>
                <div class="wth-card info">
                  <div class="wth-cl">Users</div><div class="wth-cv">{{(d.system.users['Stock User']||0)}}</div>
                  <div class="wth-cd">Stock Users · {{d.system.users['Stock Manager']||0}} Stock Managers · {{d.system.users['System Manager']||0}} System Managers</div>
                </div>
              </div>
              <div class="wth-note">Warehouses with stock that aren't on the map, by value. Give them a Warehouse Type (Theatre) under 🏬 Manage warehouses to see them in 3D and route picks through them.</div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Warehouse</th><th class="r">Items</th><th class="r">Value</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="r in d.system.unmapped_top" :key="r.warehouse">
                    <td class="wth-code">{{r.warehouse}}</td><td class="r">{{r.items}}</td><td class="r">{{money(r.value)}}</td>
                    <td class="wth-act"><a :href="docUrl('Warehouse', r.warehouse)" target="_blank" rel="noopener">Warehouse ↗</a></td>
                  </tr>
                  <tr v-if="!d.system.unmapped_top.length"><td colspan="4" class="wth-empty">All stock is in mapped locations. 👍</td></tr>
                </tbody>
              </table></div>
              <div class="wth-note" style="margin-top:10px">Who sees what: <b>Stock User</b> gets My work and Orders. <b>Stock Manager</b> also gets Team. <b>System Manager</b> also gets System. Change roles on the <a class="wtf-link" href="/app/user" target="_blank" rel="noopener">User list ↗</a>.</div>
            </template>
          </template>
        </div>
      </div>`,
  });

  ext.views.push({ id: 'ops', icon: '📦', label: 'Operations', component: OpsView });
  core.operations = { state, load, open: tab => { if (tab) state.tab = tab; core.actions.setView('ops'); } };
});

})();
