/* Warehouse Theatre 3D — Stock Health.
   Inventory problems found from data every ERPNext site already has: dead stock, slow
   movers, stock age, expiring batches, items below reorder level, negative stock and
   value by warehouse. Needs no warehouse mapping, so it is also the first screen
   before setup. Data: api/health.get_stock_health. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, actions, addCSS } = core;
  const { defineComponent, reactive, computed, watch, onMounted } = Vue;
  const { fmt } = core.helpers;

  addCSS('wtf-health-style', `
.wth{position:absolute;left:148px;right:0;top:44px;bottom:0;overflow-y:auto;background:var(--wt-bg);color:var(--wt-text)}
.wth.pre{position:relative;left:0;top:0;height:100%}
.wth-in{max-width:1180px;margin:0 auto;padding:16px max(16px,env(safe-area-inset-right,0px)) 32px max(16px,env(safe-area-inset-left,0px))}
.wth-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.wth-title{font-size:20px;font-weight:800;letter-spacing:-.2px;text-wrap:balance}
.wth-sub{font-size:11px;color:var(--wt-text3);margin-top:3px}
.wth-ctrl{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.wth-ctrl .wtf-inp{width:auto;height:30px}
.wth-setup{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;border-radius:10px;margin-bottom:14px;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.3)}
.wth-setup b{font-size:12px;color:var(--wt-text)}
.wth-setup p{font-size:11px;color:var(--wt-text2);margin-top:2px;line-height:1.5;max-width:62ch}
.wth-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:16px}
@media(max-width:1100px){.wth-cards{grid-template-columns:repeat(4,1fr)}.wth-cards .wth-card:first-child{grid-column:span 2}}
@media(max-width:600px){.wth-cards{grid-template-columns:repeat(2,1fr)}}
.wth-card{position:relative;text-align:left;background:var(--wt-card);border:1px solid var(--wt-cb);border-radius:10px;padding:11px 12px 11px 15px;cursor:pointer;color:var(--wt-text);overflow:hidden;transition:border-color .15s}
.wth-card:hover,.wth-card.act{border-color:var(--wt-accent)}
.wth-card:focus-visible{outline:2px solid var(--wt-accent);outline-offset:1px}
.wth-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--sev,#64748b)}
.wth-card.ok{--sev:#22c55e}.wth-card.warn{--sev:#f59e0b}.wth-card.bad{--sev:#ef4444}.wth-card.info{--sev:#3b82f6}
.wth-cl{font-size:9px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--wt-text3)}
.wth-cv{font-size:20px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}
.wth-cd{font-size:10px;color:var(--wt-text2);margin-top:2px;line-height:1.4}
.wth-tabs{display:flex;gap:4px;border-bottom:1px solid var(--wt-border);margin-bottom:12px;overflow-x:auto;scrollbar-width:none}
.wth-tabs::-webkit-scrollbar{display:none}
.wth-tab{flex-shrink:0;padding:8px 11px;border:none;background:none;color:var(--wt-text2);font-size:11px;font-weight:700;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.wth-tab.act{color:var(--wt-accent2);border-bottom-color:var(--wt-accent)}
.wth-tab:focus-visible{outline:2px solid var(--wt-accent)}
.wth-n{display:inline-block;min-width:16px;padding:0 4px;margin-left:4px;border-radius:8px;background:var(--wt-pill);font-size:9px;text-align:center}
.wth-note{font-size:11px;color:var(--wt-text2);margin-bottom:10px;line-height:1.5}
.wth-tw{overflow-x:auto;border:1px solid var(--wt-cb);border-radius:10px}
.wth-t{width:100%;border-collapse:collapse;font-size:11px;min-width:560px}
.wth-t th{position:sticky;top:0;background:var(--wt-bg2);text-align:left;font-size:9px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--wt-text3);padding:8px 10px;border-bottom:1px solid var(--wt-border);white-space:nowrap}
.wth-t td{padding:7px 10px;border-bottom:1px solid var(--wt-border);color:var(--wt-text2);vertical-align:middle}
.wth-t tr:last-child td{border-bottom:none}
.wth-t .r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.wth-code{font-weight:700;color:var(--wt-text)}
.wth-name{font-size:10px;color:var(--wt-text3);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wth-act{white-space:nowrap;text-align:right}
.wth-act a,.wth-act button{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 8px;margin-left:4px;border-radius:6px;border:1px solid var(--wt-cb);background:transparent;color:var(--wt-text2);font-size:10px;font-weight:700;cursor:pointer;text-decoration:none}
.wth-act a:hover,.wth-act button:hover{border-color:var(--wt-accent);color:var(--wt-text)}
.wth-chip{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;white-space:nowrap}
.wth-chip.bad{background:rgba(239,68,68,.15);color:#ef4444}.wth-chip.warn{background:rgba(245,158,11,.15);color:#d97706}
.wth-chip.ok{background:rgba(34,197,94,.15);color:#16a34a}
.wth-age{display:flex;height:22px;border-radius:6px;overflow:hidden;margin:4px 0 8px;background:var(--wt-cb)}
.wth-age>div{height:100%;min-width:2px}
.wth-age-l{display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:14px}
.wth-age-l span{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--wt-text2)}
.wth-age-l i{width:10px;height:10px;border-radius:2px;display:inline-block}
.wth-bar{height:6px;border-radius:3px;background:var(--wt-cb);overflow:hidden;min-width:80px}
.wth-bar>div{height:100%;background:var(--wt-accent)}
.wth-empty{padding:26px;text-align:center;color:var(--wt-text3);font-size:12px}
.wth-load{display:flex;align-items:center;gap:10px;padding:40px;justify-content:center;color:var(--wt-text3);font-size:12px}
@media(max-width:600px){
  .wth{left:0;top:calc(var(--wt-top-h, 80px) + 2px)}
  .wth-cv{font-size:17px}
}
`);

  const AGE_COLORS = ['#22c55e', '#84cc16', '#f59e0b', '#f97316', '#ef4444'];
  const TABS = [
    { id: 'dead', label: 'Dead stock', count: d => d.summary.dead_count },
    { id: 'slow', label: 'Slow movers', count: d => d.summary.slow_count },
    { id: 'ageing', label: 'Stock age', count: () => null },
    { id: 'expiring', label: 'Expiring batches', count: d => d.summary.expiring_count },
    { id: 'reorder', label: 'Below reorder level', count: d => d.summary.reorder_count },
    { id: 'negative', label: 'Negative stock', count: d => d.summary.negative_count },
    { id: 'warehouses', label: 'By warehouse', count: () => null },
  ];

  const state = reactive({
    data: null, loading: false, error: '', days: 90, expiryDays: 60, tab: 'dead',
    companies: [], company: null, loadedKey: '',
  });
  try {
    const t = localStorage.getItem('wt3d-health-tab');
    if (t && TABS.some(x => x.id === t)) state.tab = t;
  } catch (e) {}

  function company() { return store.setupComplete ? (store.company || '') : (state.company || ''); }

  async function load(refresh) {
    const key = [company(), state.days, state.expiryDays].join('|');
    if (!refresh && key === state.loadedKey && state.data) return;
    state.loading = true; state.error = '';
    try {
      state.data = await core.api('health', 'get_stock_health', {
        company: company() || undefined, days: state.days, expiry_days: state.expiryDays, refresh: refresh ? 1 : 0,
      });
      state.loadedKey = key;
    } catch (e) { state.error = 'Could not load stock health: ' + e.message; }
    finally { state.loading = false; }
  }

  /* Short money amounts: lakh/crore for rupees (₹5.8L, ₹1.2Cr), K/M/B otherwise.
     Intl's own compact style prints thousands as "T" in en-IN, which reads as trillions. */
  const symbols = {};
  function symbol(cur) {
    if (symbols[cur] === undefined) {
      try {
        const part = new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur }).formatToParts(0).find(x => x.type === 'currency');
        symbols[cur] = part ? part.value : cur + ' ';
      } catch (e) { symbols[cur] = cur + ' '; }
    }
    return symbols[cur];
  }
  function money(v) {
    const cur = (state.data && state.data.currency) || 'INR';
    const n = parseFloat(v) || 0, a = Math.abs(n);
    const units = cur === 'INR' ? [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']] : [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    const u = units.find(([d]) => a >= d);
    const body = u ? (n / u[0]).toFixed(1).replace(/\.0$/, '') + u[1] : Math.round(n).toLocaleString('en-IN');
    return (n < 0 ? '-' : '') + symbol(cur) + body.replace(/^-/, '');
  }
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
  function ago(days) {
    if (days === null || days === undefined) return 'none in 2 years';
    if (days < 60) return days + ' days ago';
    if (days < 730) return Math.round(days / 30) + ' months ago';
    return 'over 2 years ago';
  }
  function months(d) { return d >= 730 ? '2+ years' : Math.round(d / 30) + ' months'; }

  /* The top-bar search box also filters these lists. */
  function match(r) {
    const q = (store.searchQuery || '').toLowerCase();
    if (!q) return true;
    // `warehouses` is a list on batch rows and a count on item rows.
    return [r.item_code, r.item_name, r.warehouse, r.batch_no, Array.isArray(r.warehouses) ? r.warehouses.join(' ') : '']
      .some(v => v && String(v).toLowerCase().includes(q));
  }

  function locate(code) {
    if (!store.setupComplete || !core.locate) return;
    actions.setView('3d');
    setTimeout(() => core.locate.locate(code), 50);
  }

  const HealthView = defineComponent({
    name: 'WtfHealthView',
    props: { preSetup: Boolean },
    setup(props) {
      onMounted(async () => {
        if (props.preSetup && !state.companies.length) {
          try { state.companies = (await core.call('get_companies')) || []; } catch (e) {}
        }
        load(false);
      });
      watch(() => store.company, () => { if (!props.preSetup) load(false); });

      const d = computed(() => state.data);
      const s = computed(() => d.value ? d.value.summary : null);
      const cards = computed(() => {
        if (!s.value) return [];
        const S = s.value, total = S.total_value;
        return [
          { id: 'warehouses', label: 'Stock value', value: money(total), sev: 'info',
            desc: `${S.items_in_stock.toLocaleString('en-IN')} items in ${S.warehouses_with_stock} warehouses` },
          { id: 'dead', label: 'Dead stock', value: money(S.dead_value), sev: S.dead_count ? 'warn' : 'ok',
            desc: `${S.dead_count} items, no outward movement in ${d.value.days} days · ${pct(S.dead_value, total)}% of value` },
          { id: 'slow', label: 'Slow movers', value: money(S.slow_value), sev: S.slow_count ? 'warn' : 'ok',
            desc: `${S.slow_count} items with over 6 months of stock at the current rate` },
          { id: 'ageing', label: 'Older than 90 days', value: money(S.aged_value), sev: pct(S.aged_value, total) > 40 ? 'warn' : 'ok',
            desc: `${pct(S.aged_value, total)}% of stock value, first-in-first-out estimate` },
          { id: 'expiring', label: 'Expiring batches', value: String(S.expiring_count), sev: S.expired_count ? 'bad' : S.expiring_count ? 'warn' : 'ok',
            desc: S.expired_count ? `${S.expired_count} already expired, rest within ${d.value.expiry_days} days` : `Expiring within ${d.value.expiry_days} days` },
          { id: 'reorder', label: 'Below reorder level', value: String(S.reorder_count), sev: S.reorder_count ? 'warn' : 'ok',
            desc: 'Item Reorder rules at or under their level' },
          { id: 'negative', label: 'Negative stock', value: String(S.negative_count), sev: S.negative_count ? 'bad' : 'ok',
            desc: S.negative_count ? 'Item and warehouse pairs below zero' : 'None' },
        ];
      });
      const tabs = computed(() => d.value ? TABS.map(t => ({ ...t, n: t.count(d.value) })) : TABS);
      const rows = computed(() => {
        if (!d.value) return [];
        const list = state.tab === 'ageing' ? d.value.ageing.oldest : (d.value[state.tab] || []);
        return list.filter(match);
      });
      const ageTotal = computed(() => d.value ? d.value.ageing.buckets.reduce((a, b) => a + b.value, 0) : 0);

      function setTab(id) { state.tab = id; try { localStorage.setItem('wt3d-health-tab', id); } catch (e) {} }

      return { state, store, d, s, cards, tabs, rows, ageTotal, AGE_COLORS, money, pct, ago, months, fmt, load, setTab, locate,
        itemUrl: c => '/app/item/' + encodeURIComponent(c),
        batchUrl: c => '/app/batch/' + encodeURIComponent(c),
        startSetup: () => { store.showWizard = true; },
        setCompany: c => { state.company = c; load(false); } };
    },
    template: `
      <div :class="['wth', preSetup ? 'pre' : '']" role="region" aria-label="Stock health">
        <div class="wth-in">
          <div class="wth-head">
            <div>
              <div class="wth-title">{{preSetup ? 'Warehouse Theatre 3D · ' : ''}}Stock health</div>
              <div class="wth-sub" v-if="d">As of {{d.as_of}}{{d.company ? ' · ' + d.company : ' · all companies'}} · from your ERPNext stock ledger</div>
            </div>
            <div class="wth-ctrl">
              <select v-if="preSetup && state.companies.length > 1" class="wtf-inp" :value="state.company || ''"
                @change="setCompany($event.target.value)" aria-label="Company">
                <option value="">All companies</option>
                <option v-for="c in state.companies" :key="c.name" :value="c.name">{{c.name}}</option>
              </select>
              <select class="wtf-inp" v-model.number="state.days" @change="load(false)" aria-label="Period for dead and slow stock">
                <option :value="30">Dead after 30 days</option><option :value="90">Dead after 90 days</option>
                <option :value="180">Dead after 180 days</option><option :value="365">Dead after 365 days</option>
              </select>
              <button class="wtf-btn" :disabled="state.loading" @click="load(true)"><span v-if="state.loading" class="wtf-spin"></span>Refresh</button>
            </div>
          </div>

          <div v-if="preSetup" class="wth-setup">
            <div>
              <b>See where this stock sits on a 3D map of your warehouse</b>
              <p>This report already works from your ERPNext data. Setup reads your Warehouse tree and takes about two minutes; it never renames or moves anything.</p>
            </div>
            <button v-if="store.canEdit" class="wtf-btn wtf-btn-pri" @click="startSetup()">Set up the 3D map →</button>
            <span v-else class="wtf-muted">A System Manager can set up the 3D map.</span>
          </div>

          <div v-if="state.error" class="wtf-err" role="alert">{{state.error}}</div>
          <div v-if="state.loading && !d" class="wth-load"><span class="wtf-spin"></span> Checking your stock…</div>

          <template v-if="d">
            <div class="wth-cards">
              <button v-for="c in cards" :key="c.id" :class="['wth-card', c.sev, state.tab===c.id?'act':'']" @click="setTab(c.id)">
                <div class="wth-cl">{{c.label}}</div>
                <div class="wth-cv">{{c.value}}</div>
                <div class="wth-cd">{{c.desc}}</div>
              </button>
            </div>

            <div class="wth-tabs" role="tablist">
              <button v-for="t in tabs" :key="t.id" role="tab" :aria-selected="state.tab===t.id"
                :class="['wth-tab', state.tab===t.id?'act':'']" @click="setTab(t.id)">{{t.label}}<span v-if="t.n" class="wth-n">{{t.n}}</span></button>
            </div>

            <!-- Dead stock -->
            <template v-if="state.tab==='dead'">
              <div class="wth-note">Items in stock with no outward movement (sales, transfers out, consumption) in the last {{d.days}} days, by value. Candidates for clearance, return to supplier, or moving out of prime locations.</div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Item</th><th>Group</th><th class="r">Qty</th><th class="r">Value</th><th>Last outward</th><th class="r">Warehouses</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="r in rows" :key="r.item_code">
                    <td><div class="wth-code">{{r.item_code}}</div><div class="wth-name">{{r.item_name}}</div></td>
                    <td>{{r.item_group}}</td>
                    <td class="r">{{fmt(r.qty)}} {{r.uom}}</td><td class="r">{{money(r.value)}}</td>
                    <td><span :class="['wth-chip', r.idle_days===null || r.idle_days>365 ? 'bad' : 'warn']">{{ago(r.idle_days)}}</span></td>
                    <td class="r">{{r.warehouses}}</td>
                    <td class="wth-act"><button v-if="store.setupComplete" @click="locate(r.item_code)" title="Show on the 3D map">📍 Locate</button><a :href="itemUrl(r.item_code)" target="_blank" rel="noopener">Item ↗</a></td>
                  </tr>
                  <tr v-if="!rows.length"><td colspan="7" class="wth-empty">{{store.searchQuery ? 'No matches.' : 'No dead stock. Everything in stock has moved in the last ' + d.days + ' days.'}}</td></tr>
                </tbody>
              </table></div>
            </template>

            <!-- Slow movers -->
            <template v-else-if="state.tab==='slow'">
              <div class="wth-note">Items that are moving, but so slowly that today's stock would last more than 6 months at the rate of the last {{d.days}} days. Usually over-bought; slow down purchasing.</div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Item</th><th class="r">In stock</th><th class="r">Out in {{d.days}} days</th><th class="r">Stock lasts</th><th class="r">Value</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="r in rows" :key="r.item_code">
                    <td><div class="wth-code">{{r.item_code}}</div><div class="wth-name">{{r.item_name}}</div></td>
                    <td class="r">{{fmt(r.qty)}} {{r.uom}}</td><td class="r">{{fmt(r.out_qty)}}</td>
                    <td class="r"><span :class="['wth-chip', r.cover_days>365 ? 'bad' : 'warn']">{{months(r.cover_days)}}</span></td>
                    <td class="r">{{money(r.value)}}</td>
                    <td class="wth-act"><button v-if="store.setupComplete" @click="locate(r.item_code)">📍 Locate</button><a :href="itemUrl(r.item_code)" target="_blank" rel="noopener">Item ↗</a></td>
                  </tr>
                  <tr v-if="!rows.length"><td colspan="6" class="wth-empty">{{store.searchQuery ? 'No matches.' : 'No slow movers.'}}</td></tr>
                </tbody>
              </table></div>
            </template>

            <!-- Ageing -->
            <template v-else-if="state.tab==='ageing'">
              <div class="wth-note">How long the stock on hand has been in the company, estimated first-in-first-out from receipts and production (transfers between warehouses don't reset the age).</div>
              <div class="wth-age" role="img" :aria-label="'Stock value by age: ' + d.ageing.buckets.map(b => b.label + ' ' + money(b.value)).join(', ')">
                <div v-for="(b,i) in d.ageing.buckets" :key="b.label" :style="{width: pct(b.value, ageTotal) + '%', background: AGE_COLORS[i]}" :title="b.label + ': ' + money(b.value)"></div>
              </div>
              <div class="wth-age-l">
                <span v-for="(b,i) in d.ageing.buckets" :key="b.label"><i :style="{background: AGE_COLORS[i]}"></i>{{b.label}} · <b>{{money(b.value)}}</b> ({{pct(b.value, ageTotal)}}%)</span>
              </div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Item with stock older than 6 months</th><th class="r">Average age</th><th class="r">Oldest</th><th class="r">Value over 6 months</th><th class="r">Total value</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="r in rows" :key="r.item_code">
                    <td><div class="wth-code">{{r.item_code}}</div><div class="wth-name">{{r.item_name}}</div></td>
                    <td class="r">{{r.avg_age}} days</td><td class="r">{{r.max_age >= d.ageing.history_days ? '2+ years' : r.max_age + ' days'}}</td>
                    <td class="r">{{money(r.old_value)}}</td><td class="r">{{money(r.value)}}</td>
                    <td class="wth-act"><button v-if="store.setupComplete" @click="locate(r.item_code)">📍 Locate</button><a :href="itemUrl(r.item_code)" target="_blank" rel="noopener">Item ↗</a></td>
                  </tr>
                  <tr v-if="!rows.length"><td colspan="6" class="wth-empty">{{store.searchQuery ? 'No matches.' : 'No stock older than 6 months.'}}</td></tr>
                </tbody>
              </table></div>
            </template>

            <!-- Expiring -->
            <template v-else-if="state.tab==='expiring'">
              <div class="wth-note">Batches with stock that have expired or expire in the next {{d.expiry_days}} days. Use them first, or move them out of sellable stock.</div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Batch</th><th>Item</th><th>Expiry</th><th class="r">Qty</th><th>Warehouses</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="r in rows" :key="r.batch_no">
                    <td class="wth-code">{{r.batch_no}}</td>
                    <td><div class="wth-code">{{r.item_code}}</div><div class="wth-name">{{r.item_name}}</div></td>
                    <td>{{r.expiry_date}} <span :class="['wth-chip', r.days_left < 0 ? 'bad' : r.days_left <= 30 ? 'warn' : 'ok']">{{r.days_left < 0 ? 'expired ' + (-r.days_left) + 'd ago' : r.days_left + 'd left'}}</span></td>
                    <td class="r">{{fmt(r.qty)}} {{r.uom}}</td>
                    <td><div class="wth-name" :title="r.warehouses.join(', ')">{{r.warehouses.join(', ')}}</div></td>
                    <td class="wth-act"><button v-if="store.setupComplete" @click="locate(r.item_code)">📍 Locate</button><a :href="batchUrl(r.batch_no)" target="_blank" rel="noopener">Batch ↗</a></td>
                  </tr>
                  <tr v-if="!rows.length"><td colspan="6" class="wth-empty">{{store.searchQuery ? 'No matches.' : 'No batches expiring in the next ' + d.expiry_days + ' days.'}}</td></tr>
                </tbody>
              </table></div>
            </template>

            <!-- Reorder -->
            <template v-else-if="state.tab==='reorder'">
              <div class="wth-note">Items whose projected quantity (stock plus ordered, minus reserved) is at or below the re-order level set on the Item. Raise a Material Request, or check that ERPNext's automatic re-order is turned on in Stock Settings.</div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Item</th><th>Warehouse</th><th class="r">Projected</th><th class="r">Re-order level</th><th class="r">Short by</th><th class="r">Re-order qty</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="r in rows" :key="r.item_code + r.warehouse">
                    <td><div class="wth-code">{{r.item_code}}</div><div class="wth-name">{{r.item_name}}</div></td>
                    <td>{{r.warehouse}}</td>
                    <td class="r">{{fmt(r.projected)}} {{r.uom}}</td><td class="r">{{fmt(r.level)}}</td>
                    <td class="r"><span class="wth-chip warn">{{fmt(r.shortfall)}}</span></td>
                    <td class="r">{{fmt(r.reorder_qty)}} · {{r.request_type}}</td>
                    <td class="wth-act"><a :href="itemUrl(r.item_code)" target="_blank" rel="noopener">Item ↗</a></td>
                  </tr>
                  <tr v-if="!rows.length"><td colspan="7" class="wth-empty">{{store.searchQuery ? 'No matches.' : 'Nothing below its re-order level. (Only items with re-order levels set on the Item are checked.)'}}</td></tr>
                </tbody>
              </table></div>
            </template>

            <!-- Negative -->
            <template v-else-if="state.tab==='negative'">
              <div class="wth-note">Stock below zero usually means a receipt was missed or a transfer was posted twice. It also makes valuation unreliable. Fix with the missing entry or a Stock Reconciliation.</div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Item</th><th>Warehouse</th><th class="r">Qty</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="r in rows" :key="r.item_code + r.warehouse">
                    <td><div class="wth-code">{{r.item_code}}</div><div class="wth-name">{{r.item_name}}</div></td>
                    <td>{{r.warehouse}}</td><td class="r"><span class="wth-chip bad">{{fmt(r.qty)}} {{r.uom}}</span></td>
                    <td class="wth-act"><a :href="'/app/query-report/Stock Ledger?item_code=' + encodeURIComponent(r.item_code) + '&warehouse=' + encodeURIComponent(r.warehouse)" target="_blank" rel="noopener">Ledger ↗</a></td>
                  </tr>
                  <tr v-if="!rows.length"><td colspan="4" class="wth-empty">{{store.searchQuery ? 'No matches.' : 'No negative stock.'}}</td></tr>
                </tbody>
              </table></div>
            </template>

            <!-- By warehouse -->
            <template v-else>
              <div class="wth-note">Where the stock value sits.</div>
              <div class="wth-tw"><table class="wth-t">
                <thead><tr><th>Warehouse</th><th class="r">Value</th><th>Share</th><th class="r">Items</th></tr></thead>
                <tbody>
                  <tr v-for="r in rows" :key="r.warehouse">
                    <td class="wth-code">{{r.warehouse}}</td><td class="r">{{money(r.value)}}</td>
                    <td><div style="display:flex;align-items:center;gap:8px"><div class="wth-bar" style="flex:1"><div :style="{width: r.share + '%'}"></div></div><span class="r">{{r.share}}%</span></div></td>
                    <td class="r">{{r.items}}</td>
                  </tr>
                  <tr v-if="!rows.length"><td colspan="4" class="wth-empty">{{store.searchQuery ? 'No matches.' : 'No stock.'}}</td></tr>
                </tbody>
              </table></div>
            </template>
          </template>
        </div>
      </div>`,
  });

  ext.views.push({ id: 'health', icon: '📊', label: 'Health', component: HealthView });
  ext.preSetup = HealthView;
  core.health = { state, load };
});

})();
