/* Warehouse Scan — phone app for putaway, picking and cycle counts.
   Page: /warehouse-scan (www/warehouse-scan.html). Vue 3 from the CDN, no build step.
   Scans come from a hand-held scanner (keyboard input ending in Enter), the phone
   camera (BarcodeDetector, or ZXing loaded on demand), or typing. Every scan is
   resolved on the server by api/scan.resolve_code. */
(function () {
'use strict';

const { createApp, reactive, computed, ref, watch, nextTick, onMounted, onBeforeUnmount } = Vue;
const API = 'warehouse_theatre_3d.warehouse_theatre_3d.api.';
const ZXING_URL = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
const QR_URL = 'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js';

// ── Server calls ──────────────────────────────────────────────
function serverError(r) {
  if (r && r._server_messages) {
    try {
      const msgs = JSON.parse(r._server_messages).map(m => { try { return JSON.parse(m).message; } catch (e) { return m; } });
      if (msgs.length) return msgs.join(' ').replace(/<[^>]+>/g, '');
    } catch (e) {}
  }
  if (r && r.exception) return String(r.exception).replace(/^[\w.]+Error:\s*/, '');
  return 'Something went wrong on the server';
}

function rpc(method, args, post) {
  const params = new URLSearchParams();
  Object.entries(args || {}).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
  const headers = { Accept: 'application/json' };
  let url = '/api/method/' + method, init;
  if (post) {
    headers['X-Frappe-CSRF-Token'] = window.csrf_token || '';
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init = { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, body: params.toString() };
  } else {
    if (params.toString()) url += '?' + params.toString();
    init = { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers };
  }
  return fetch(url, init)
    .catch(() => { throw new Error('No connection. Check Wi-Fi and try again.'); })
    .then(resp => resp.json().catch(() => ({})).then(r => ({ ok: resp.ok, status: resp.status, r })))
    .then(({ ok, status, r }) => {
      if (ok && !r.exc && !r.exception) return r.message;
      if (status === 403 && !r._server_messages) throw new Error('Your session has expired. Reload the page to sign in again.');
      throw new Error(serverError(r));
    });
}
const api = (mod, fn, args, post) => rpc(API + mod + '.' + fn, args, post);

// ── Small helpers ─────────────────────────────────────────────
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('wt-scan:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('wt-scan:' + k, JSON.stringify(v)); } catch (e) {} },
};

function fmt(n) {
  const v = Number(n) || 0;
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function daysAgo(d) {
  if (!d) return null;
  const t = new Date(String(d).slice(0, 10) + 'T00:00:00');
  return Math.max(0, Math.round((Date.now() - t.getTime()) / 864e5));
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

let audio = null;
function feedback(kind) {
  try { if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 35 : kind === 'warn' ? [40, 50, 40] : [90, 60, 90]); } catch (e) {}
  if (!S.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const tones = kind === 'ok' ? [[1320, 0.07]] : kind === 'warn' ? [[880, 0.08], [880, 0.08]] : [[300, 0.12], [220, 0.16]];
    let t = audio.currentTime;
    tones.forEach(([f, d]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = 'square'; g.gain.value = 0.05;
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + d); t += d + 0.05;
    });
  } catch (e) {}
}

const ICONS = {
  putaway: '<path d="M12 3v11m0 0-4-4m4 4 4-4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  pick: '<path d="M6 7h12l-1 13H7L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  count: '<path d="M4 6h16M4 12h16M4 18h10"/><path d="M18 16l2 2 3-4"/>',
  lookup: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  labels: '<path d="M3 12V4h8l10 10-8 8L3 12Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  pack: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  dispatch: '<path d="M2 6h11v10H2z"/><path d="M13 9h4l3 3v4h-7"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  replenish: '<path d="M4 20h16"/><path d="M6 20V9h5v11M13 20V4h5v16"/><path d="m8 6 2-2 2 2"/>',
};
const icon = (name, size) => `<svg viewBox="0 0 24 24" width="${size || 22}" height="${size || 22}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// ── App state ─────────────────────────────────────────────────
const S = reactive({
  screen: 'home',
  floors: [], floor: prefs.get('floor', null), floorsLoaded: false,
  sound: prefs.get('sound', true),
  flash: null, busy: false, sheet: null, confirm: null, camera: false,
  keyboard: false, notice: '',
});
// Modes in their own files (scan/*.js) register here before mount: home tiles, screens,
// what a scanned document or other code kind opens, and ?query links.
const EXT = { tiles: [], screens: {}, docActions: {}, kinds: {}, links: {} };

const floorLabel = computed(() => (S.floors.find(f => f.id === S.floor) || {}).name || 'Choose floor');

let flashTimer = null;
function flash(kind, text) {
  S.flash = { kind, text, at: Date.now() };
  feedback(kind);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { S.flash = null; }, kind === 'err' ? 4500 : 2600);
}

function ask(opts) {         // number sheet → Promise<number|null>
  return new Promise(res => { S.sheet = Object.assign({ value: '', unit: '', ok: 'Done' }, opts, { resolve: res }); });
}
function confirmSheet(title, text, ok, danger) {
  return new Promise(res => { S.confirm = { title, text, ok: ok || 'OK', danger: !!danger, resolve: res }; });
}

const cache = new Map();     // code → resolved item/location, for fast repeat scans
async function resolve(code) {
  const key = String(code).trim();
  if (cache.has(key)) return cache.get(key);
  const r = await api('scan', 'resolve_code', { code: key });
  if (r && (r.kind === 'item' || r.kind === 'location')) cache.set(key, r);
  return r;
}

// Each screen sets the handler for scans while it is shown.
const handler = { fn: null };
async function onScan(code) {
  code = String(code || '').trim();
  if (!code || S.busy) return;
  S.busy = true;
  try {
    const r = await resolve(code);
    if (r.kind === 'unknown') { flash('err', `“${r.code}” isn't a location, item, batch or document`); return; }
    if (handler.fn) await handler.fn(r);
  } catch (e) {
    flash('err', e.message);
  } finally {
    S.busy = false;
  }
}

function go(screen) { S.screen = screen; window.scrollTo(0, 0); }

// ── Shared components ─────────────────────────────────────────
const Icon = {
  props: { name: String, size: Number },
  template: `<span class="ws-ic" v-html="svg"></span>`,
  computed: { svg() { return icon(this.name, this.size); } },
};

const TopBar = {
  components: { Icon },
  props: { title: String, sub: String, back: { type: Boolean, default: true } },
  emits: ['back'],
  setup() { return { S, floorLabel }; },
  template: `
    <header class="ws-top">
      <button v-if="back" class="ws-icbtn" aria-label="Back" @click="$emit('back')"><Icon name="back"/></button>
      <div class="ws-top-t">
        <h1>{{title}}</h1>
        <div v-if="sub" class="ws-top-s">{{sub}}</div>
      </div>
      <button class="ws-floor" @click="S.screen==='home' ? $root.pickFloor() : null" :disabled="S.screen!=='home'">{{floorLabel}}</button>
    </header>`,
};

const Prompt = {   // the big "what to scan next" line
  props: { text: String, hint: String, tone: String },
  template: `<div class="ws-prompt" :class="tone"><div class="ws-prompt-t">{{text}}</div><div v-if="hint" class="ws-prompt-h">{{hint}}</div></div>`,
};

// Camera scanning: BarcodeDetector where the browser has it, otherwise ZXing.
const Camera = {
  components: { Icon },
  props: { continuous: Boolean },
  emits: ['code', 'close'],
  setup(props, { emit }) {
    const video = ref(null);
    const state = reactive({ error: '', starting: true, last: '', lastAt: 0, engine: '' });
    let stream = null, timer = null, reader = null, stopped = false;

    function hit(code) {
      const now = Date.now();
      if (code === state.last && now - state.lastAt < 1800) return;   // same label still in view
      state.last = code; state.lastAt = now;
      emit('code', code);
      if (!props.continuous) close();
    }

    async function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        state.error = 'The camera needs a secure (https) connection. Use a hand-held scanner or type the code.';
        state.starting = false; return;
      }
      try {
        if ('BarcodeDetector' in window) {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (formats && formats.length) {
            const detector = new window.BarcodeDetector({ formats });
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
            if (stopped) return stopStream();
            video.value.srcObject = stream;
            await video.value.play();
            state.engine = 'native'; state.starting = false;
            const loop = async () => {
              if (stopped) return;
              try {
                const codes = await detector.detect(video.value);
                if (codes && codes.length) hit(codes[0].rawValue);
              } catch (e) {}
              timer = setTimeout(loop, 160);
            };
            loop();
            return;
          }
        }
        await loadScript(ZXING_URL);
        if (stopped) return;
        reader = new window.ZXing.BrowserMultiFormatReader();
        state.engine = 'zxing'; state.starting = false;
        await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video.value, (res) => {
          if (res && !stopped) hit(res.getText());
        });
      } catch (e) {
        state.starting = false;
        state.error = e && e.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow the camera for this site in the browser settings.'
          : e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')
            ? 'No camera found on this device. Use a hand-held scanner or type the code.'
            : 'The camera could not start: ' + (e.message || e.name || e);
      }
    }
    function stopStream() {
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    function close() {
      stopped = true; clearTimeout(timer);
      try { if (reader) reader.reset(); } catch (e) {}
      stopStream();
      emit('close');
    }
    onMounted(start);
    onBeforeUnmount(() => { stopped = true; clearTimeout(timer); try { if (reader) reader.reset(); } catch (e) {} stopStream(); });
    return { video, state, close, S };
  },
  template: `
    <div class="ws-cam" role="dialog" aria-label="Camera scanner">
      <video ref="video" playsinline muted></video>
      <div class="ws-cam-frame" aria-hidden="true"></div>
      <div class="ws-cam-top">
        <span>{{ state.starting ? 'Starting camera…' : (continuous ? 'Keep scanning. Each code counts once.' : 'Point at a barcode or QR label') }}</span>
        <button class="ws-icbtn light" aria-label="Close camera" @click="close"><Icon name="close"/></button>
      </div>
      <div v-if="state.error" class="ws-cam-err">{{state.error}}</div>
      <div v-if="S.flash && continuous" class="ws-cam-flash" :class="S.flash.kind">{{S.flash.text}}</div>
      <button v-if="continuous" class="ws-btn primary ws-cam-done" @click="close">Done</button>
    </div>`,
};

const ScanBar = {
  components: { Icon },
  setup() {
    const input = ref(null);
    const code = ref('');
    const touch = matchMedia('(pointer: coarse)').matches;
    function submit() { const c = code.value; code.value = ''; onScan(c); }
    function refocus() {
      // Keep the field ready for a hand-held scanner, unless the user is typing elsewhere.
      const a = document.activeElement;
      if (S.sheet || S.confirm || S.camera) return;
      if (a && a !== document.body && a !== input.value && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
      if (input.value) input.value.focus({ preventScroll: true });
    }
    onMounted(() => { refocus(); document.addEventListener('click', () => setTimeout(refocus, 0)); });
    watch(() => [S.screen, S.sheet, S.confirm, S.camera], () => nextTick(refocus));
    function toggleKeyboard() { S.keyboard = !S.keyboard; nextTick(() => { input.value.blur(); input.value.focus(); }); }
    return { S, input, code, submit, touch, toggleKeyboard };
  },
  template: `
    <form class="ws-scanbar" @submit.prevent="submit" role="search">
      <button type="button" class="ws-cambtn" aria-label="Scan with camera" @click="S.camera=true"><Icon name="camera" :size="24"/><span>Camera</span></button>
      <input ref="input" v-model="code" class="ws-scaninput" :inputmode="touch && !S.keyboard ? 'none' : 'text'"
        autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"
        :placeholder="S.busy ? 'Checking…' : (touch && !S.keyboard ? 'Ready to scan' : 'Scan or type a code')" aria-label="Scanned code"/>
      <button v-if="touch" type="button" class="ws-icbtn" :class="{on:S.keyboard}" aria-label="Type a code" @click="toggleKeyboard"><Icon name="keyboard"/></button>
      <button v-if="code" type="submit" class="ws-go">Go</button>
    </form>`,
};

const Sheet = {   // number entry
  setup() {
    const input = ref(null);
    watch(() => S.sheet, s => { if (s) nextTick(() => { input.value && (input.value.focus(), input.value.select()); }); });
    function done(v) {
      const s = S.sheet; S.sheet = null;
      if (v === null) return s.resolve(null);
      const n = parseFloat(String(v).replace(',', '.'));
      s.resolve(isNaN(n) ? null : n);
    }
    function step(d) { const n = (parseFloat(S.sheet.value) || 0) + d; S.sheet.value = String(Math.max(0, +n.toFixed(6))); }
    return { S, input, done, step, fmt };
  },
  template: `
    <div v-if="S.sheet" class="ws-scrim" @click.self="done(null)">
      <form class="ws-sheet" @submit.prevent="done(S.sheet.value)" role="dialog" :aria-label="S.sheet.title">
        <div class="ws-sheet-t">{{S.sheet.title}}</div>
        <div v-if="S.sheet.sub" class="ws-sheet-s">{{S.sheet.sub}}</div>
        <div class="ws-qty">
          <button type="button" class="ws-step" aria-label="Less" @click="step(-1)">−</button>
          <div class="ws-qty-in"><input ref="input" v-model="S.sheet.value" inputmode="decimal" aria-label="Quantity"/><span>{{S.sheet.unit}}</span></div>
          <button type="button" class="ws-step" aria-label="More" @click="step(1)">+</button>
        </div>
        <div v-if="S.sheet.quick && S.sheet.quick.length" class="ws-quick">
          <button v-for="q in S.sheet.quick" :key="q.label" type="button" class="ws-chip" @click="S.sheet.value=String(q.value)">{{q.label}}</button>
        </div>
        <div class="ws-sheet-b">
          <button type="button" class="ws-btn" @click="done(null)">Cancel</button>
          <button type="submit" class="ws-btn primary">{{S.sheet.ok}}</button>
        </div>
      </form>
    </div>`,
};

const Confirm = {
  setup() {
    function done(v) { const c = S.confirm; S.confirm = null; c.resolve(v); }
    return { S, done };
  },
  template: `
    <div v-if="S.confirm" class="ws-scrim" @click.self="done(false)">
      <div class="ws-sheet" role="alertdialog" :aria-label="S.confirm.title">
        <div class="ws-sheet-t">{{S.confirm.title}}</div>
        <div class="ws-sheet-s">{{S.confirm.text}}</div>
        <div class="ws-sheet-b">
          <button class="ws-btn" @click="done(false)">Cancel</button>
          <button class="ws-btn" :class="S.confirm.danger ? 'danger' : 'primary'" @click="done(true)">{{S.confirm.ok}}</button>
        </div>
      </div>
    </div>`,
};

const Done = {   // result card after posting
  components: { Icon },
  props: { result: Object },
  emits: ['again', 'home'],
  setup(props, { emit }) { return { again: () => { S.flash = null; emit('again'); }, home: () => { S.flash = null; emit('home'); } }; },
  template: `
    <div class="ws-done">
      <div class="ws-done-ic" :class="result.tone || 'ok'"><Icon name="check" :size="34"/></div>
      <h2>{{result.title}}</h2>
      <p v-for="(l, i) in result.lines" :key="i">{{l}}</p>
      <button v-if="result.next" class="ws-btn primary" @click="result.next.fn()">{{result.next.label}}</button>
      <a v-if="result.url" class="ws-btn" :href="result.url" target="_blank" rel="noopener">Open in ERPNext ↗</a>
      <button class="ws-btn" :class="result.next ? '' : 'primary'" @click="again">{{result.again}}</button>
      <button class="ws-btn ghost" @click="home">Home</button>
    </div>`,
};

// ── Home ──────────────────────────────────────────────────────
const Home = {
  components: { TopBar, Icon, Prompt },
  setup() {
    handler.fn = async r => {
      if (r.kind === 'document') {
        if (r.action === 'pick') { Pick.open(r.name); return; }
        if (r.action === 'putaway') { Putaway.fromDocument(r.doctype, r.name, r.docstatus); return; }
        if (EXT.docActions[r.action]) { EXT.docActions[r.action](r); return; }
      }
      if (EXT.kinds[r.kind]) { EXT.kinds[r.kind](r); return; }
      Lookup.show(r);
    };
    const tiles = [
      { id: 'putaway', title: 'Put away', sub: 'Receipts to locations' },
      { id: 'pick', title: 'Pick', sub: 'Walk a Pick List' },
      { id: 'count', title: 'Count', sub: 'Cycle count a location' },
      { id: 'lookup', title: 'Look up', sub: 'What is where' },
    ].concat(EXT.tiles.filter(t => !t.show || t.show()));
    function open(id) {
      const ext = EXT.tiles.find(t => t.id === id);
      if (ext) { if (ext.needsFloor !== false && !S.floor) { flash('warn', 'Choose a floor first'); return; } ext.open(); return; }
      if (id !== 'lookup' && !S.floor) { flash('warn', 'Choose a floor first'); return; }
      if (id === 'pick') Pick.reset();
      if (id === 'putaway') Putaway.reset();
      if (id === 'count') Count.reset();
      if (id === 'lookup') Lookup.reset();
      go(id);
    }
    return { S, tiles, open, labels: () => { if (!S.floor) { flash('warn', 'Choose a floor first'); return; } Labels.reset(); go('labels'); } };
  },
  template: `
    <div>
      <TopBar title="Warehouse Scan" :back="false"/>
      <main class="ws-main">
        <Prompt text="Scan anything" hint="A location label, an item, a Pick List or a receipt. The app opens the right job."/>
        <div v-if="S.floorsLoaded && !S.floors.length" class="ws-note">No floors are set up yet. Map your warehouse in the 3D app first, then print location labels from here.</div>
        <div class="ws-tiles">
          <button v-for="t in tiles" :key="t.id" class="ws-tile" :class="'t-'+t.id" @click="open(t.id)">
            <Icon :name="t.id" :size="28"/>
            <span class="ws-tile-t">{{t.title}}</span>
            <span class="ws-tile-s">{{t.sub}}</span>
          </button>
        </div>
        <button class="ws-row-btn" @click="labels"><Icon name="labels"/><span><b>Print location labels</b><small>QR labels for every rack shelf and floor area</small></span></button>
        <a class="ws-row-btn" href="/warehouse-theatre-3d"><Icon name="map"/><span><b>Open the 3D view</b><small>The full warehouse map</small></span></a>
        <label class="ws-toggle"><input type="checkbox" v-model="S.sound"/> Beep on scan</label>
      </main>
    </div>`,
};

// ── Look up ───────────────────────────────────────────────────
const L = reactive({ result: null, data: null, loading: false });
const Lookup = {
  components: { TopBar, Prompt, Icon },
  reset() { L.result = null; L.data = null; },
  async show(r) {
    if (r.kind === 'document') {
      if (r.action === 'pick') return Pick.open(r.name);
      if (EXT.docActions[r.action]) return EXT.docActions[r.action](r);
      return Putaway.fromDocument(r.doctype, r.name, r.docstatus);
    }
    if (EXT.kinds[r.kind]) return EXT.kinds[r.kind](r);
    L.result = r; L.data = null; L.loading = true; go('lookup');
    flash('ok', r.kind === 'item' ? r.item_code : r.path);
    try {
      if (r.kind === 'location') L.data = await api('operations', 'get_bin_stock', { warehouse: r.warehouse });
      else L.data = await api('links', 'get_item_locations', { item_code: r.item_code });
    } catch (e) { flash('err', e.message); }
    finally { L.loading = false; }
  },
  setup() {
    handler.fn = r => Lookup.show(r);
    const mapUrl = computed(() => !L.result ? '#' : L.result.kind === 'item'
      ? '/warehouse-theatre-3d?locate=' + encodeURIComponent(L.result.item_code)
      : '/warehouse-theatre-3d?focus=' + encodeURIComponent(L.result.warehouse));
    function countHere() { Count.reset(); go('count'); Count.start(L.result); }
    function putAway() { Putaway.reset(); go('putaway'); Putaway.addItem(L.result); }
    function path(row) {
      if (!row.mapped) return row.warehouse_label || row.warehouse;
      const lvl = row.label && row.label !== 'Floor stack' && row.label !== row.slot_label ? row.label : null;
      return [row.floor_label, row.slot_label, lvl].filter(Boolean).join(' › ');
    }
    return { S, L, mapUrl, countHere, putAway, fmt, path, back: () => go('home') };
  },
  template: `
    <div>
      <TopBar title="Look up" @back="back"/>
      <main class="ws-main">
        <Prompt v-if="!L.result" text="Scan a location or an item"/>
        <template v-else-if="L.result.kind==='location'">
          <div class="ws-card hero">
            <div class="ws-kicker">Location · {{L.result.floor_label || 'not on the map'}}</div>
            <div class="ws-big">{{L.result.path}}</div>
            <div class="ws-mono">{{L.result.warehouse}}</div>
          </div>
          <div v-if="L.loading" class="ws-muted">Loading…</div>
          <template v-else-if="L.data">
            <div class="ws-h">{{L.data.items.length}} item{{L.data.items.length===1?'':'s'}} here</div>
            <div v-for="it in L.data.items" :key="it.item_code" class="ws-line">
              <div><b>{{it.item_code}}</b><small>{{it.item_name}}</small></div>
              <div class="ws-num">{{fmt(it.actual_qty)}} <small>{{it.stock_uom}}</small></div>
            </div>
            <div v-if="!L.data.items.length" class="ws-muted">Empty.</div>
          </template>
          <div class="ws-actions">
            <button v-if="!L.result.is_group" class="ws-btn primary" @click="countHere">Count this location</button>
            <a class="ws-btn" :href="mapUrl" target="_blank" rel="noopener">Show in 3D ↗</a>
          </div>
        </template>
        <template v-else>
          <div class="ws-card hero">
            <div class="ws-kicker">Item<span v-if="L.result.batch_no"> · batch {{L.result.batch_no}}</span><span v-if="L.result.factor>1"> · barcode is a {{L.result.scan_uom}} of {{fmt(L.result.factor)}}</span></div>
            <div class="ws-big">{{L.result.item_code}}</div>
            <div class="ws-muted">{{L.result.item_name}}</div>
          </div>
          <div v-if="L.loading" class="ws-muted">Loading…</div>
          <template v-else-if="L.data">
            <div class="ws-h">In {{L.data.length}} place{{L.data.length===1?'':'s'}}</div>
            <div v-for="r in L.data" :key="r.warehouse" class="ws-line">
              <div><b>{{path(r)}}</b><small v-if="!r.mapped">not on the map</small><small v-else-if="r.reserved>0">{{fmt(r.reserved)}} reserved</small></div>
              <div class="ws-num">{{fmt(r.qty)}} <small>{{r.uom}}</small></div>
            </div>
            <div v-if="!L.data.length" class="ws-muted">No stock anywhere.</div>
          </template>
          <div class="ws-actions">
            <button class="ws-btn primary" @click="putAway">Put this item away</button>
            <a class="ws-btn" :href="mapUrl" target="_blank" rel="noopener">Show in 3D ↗</a>
          </div>
        </template>
      </main>
    </div>`,
};

// ── Put away ──────────────────────────────────────────────────
const P = reactive({ source: null, tasks: [], cur: 0, moves: [], loading: false, result: null, draft: false });
function curTask() { return P.tasks[P.cur] || null; }
function taskLeft(t) { return Math.max(0, +(t.qty - t.placed).toFixed(6)); }

const Putaway = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(P, { source: null, tasks: [], cur: 0, moves: [], loading: false, result: null, draft: false }); },
  async plan(items) {
    const res = await api('operations', 'get_putaway_plan', { group_warehouse: S.floor, items });
    res.plan.forEach(p => P.tasks.push({
      item_code: p.item_code, item_name: p.item_name, uom: p.uom, qty: p.qty, placed: 0,
      from_warehouse: p.from_warehouse, allocations: p.allocations, alternatives: p.alternatives, unplaced: p.unplaced,
    }));
  },
  async fromDocument(doctype, name, docstatus) {
    if (!S.floor) { flash('warn', 'Choose a floor first'); go('home'); return; }
    if (P.moves.length) { flash('warn', 'Post or clear the moves you scanned first'); return; }
    Putaway.reset(); go('putaway');
    P.loading = true;
    try {
      const items = await api('operations', 'get_receipt_items', { doctype, name });
      if (!items.length) { flash('warn', `${name} has nothing to put away`); return; }
      P.source = { doctype, name, draft: docstatus === 0 };
      await Putaway.plan(items);
      flash(docstatus === 0 ? 'warn' : 'ok', docstatus === 0 ? `${name} isn't submitted yet, so the stock isn't in ${items[0].from_warehouse} yet` : `${items.length} item${items.length === 1 ? '' : 's'} from ${name}`);
    } catch (e) { flash('err', e.message); }
    finally { P.loading = false; }
  },
  async addItem(r) {
    // A single item scanned without a receipt: where is it now, and how much moves?
    const locs = await api('links', 'get_item_locations', { item_code: r.item_code });
    const sources = locs.filter(l => l.qty > 0).sort((a, b) => (a.mapped - b.mapped) || (b.qty - a.qty));
    if (!sources.length) { flash('err', `No stock of ${r.item_code} to put away`); return; }
    const src = (r.serial_warehouse && sources.find(s => s.warehouse === r.serial_warehouse)) || sources[0];
    const qty = await ask({
      title: `Put away ${r.item_code}`, sub: `From ${src.mapped ? src.slot_label : (src.warehouse_label || src.warehouse)} (${fmt(src.qty)} ${src.uom} there)`,
      value: String(r.factor || 1), unit: src.uom, ok: 'Find a location',
      quick: [{ label: 'All ' + fmt(src.qty), value: src.qty }],
    });
    if (!qty || qty <= 0) return;
    P.loading = true;
    try {
      await Putaway.plan([{ item_code: r.item_code, item_name: r.item_name, qty, from_warehouse: src.warehouse }]);
      P.cur = P.tasks.length - 1;
    } catch (e) { flash('err', e.message); }
    finally { P.loading = false; }
  },
  setup() {
    async function onLocation(r) {
      const t = curTask();
      if (!t) { flash('warn', 'Scan an item or a receipt first'); return; }
      if (r.is_group) { flash('err', `${r.path} is a group warehouse. Scan a shelf or floor area label.`); return; }
      if (r.warehouse === t.from_warehouse) { flash('err', 'That is where the stock is now. Scan the location you are putting it in.'); return; }
      const left = taskLeft(t);
      const alloc = t.allocations.find(a => a.wh === r.warehouse);
      const suggested = t.allocations[0] || {};
      const qty = await ask({
        title: `${t.item_code} into ${r.path}`, sub: alloc ? 'Suggested location' : (suggested.wh ? `Not the suggestion (${suggested.slot_label || ''}${suggested.label && suggested.label !== 'Floor stack' ? ' › ' + suggested.label : ''}), that's fine` : ''),
        value: String(alloc ? Math.min(alloc.qty, left) : left), unit: t.uom, ok: 'Put here',
        quick: [{ label: 'All ' + fmt(left), value: left }],
      });
      if (!qty || qty <= 0) return;
      if (qty > left + 1e-9) { flash('err', `Only ${fmt(left)} ${t.uom} left to put away`); return; }
      P.moves.push({ item_code: t.item_code, qty, s_warehouse: t.from_warehouse, t_warehouse: r.warehouse, path: r.path, uom: t.uom });
      t.placed = +(t.placed + qty).toFixed(6);
      flash(alloc ? 'ok' : 'warn', `${fmt(qty)} ${t.uom} → ${r.path}`);
      if (taskLeft(t) <= 1e-9) nextTask();
    }
    function nextTask() {
      const i = P.tasks.findIndex(x => taskLeft(x) > 1e-9 && !x.skipped);
      P.cur = i < 0 ? P.tasks.length : i;
    }
    handler.fn = async r => {
      if (r.kind === 'location') return onLocation(r);
      if (r.kind === 'item') {
        const i = P.tasks.findIndex(t => t.item_code === r.item_code && taskLeft(t) > 1e-9);
        if (i >= 0) { P.cur = i; flash('ok', r.item_code); return; }
        if (!S.floor) { flash('warn', 'Choose a floor first'); return; }
        return Putaway.addItem(r);
      }
      if (r.kind === 'document' && r.action === 'putaway') return Putaway.fromDocument(r.doctype, r.name, r.docstatus);
      if (r.kind === 'document') { flash('err', `${r.doctype} ${r.name} isn't a receipt`); }
    };
    const task = computed(curTask);
    const left = computed(() => task.value ? taskLeft(task.value) : 0);
    const best = computed(() => {
      const t = task.value;
      if (!t) return null;
      return t.allocations.find(a => !P.moves.some(m => m.item_code === t.item_code && m.t_warehouse === a.wh)) || t.allocations[0] || null;
    });
    const allDone = computed(() => P.tasks.length > 0 && P.cur >= P.tasks.length);
    function where(a) { return a ? [a.slot_label, a.label && a.label !== 'Floor stack' && a.label !== a.slot_label ? a.label : null].filter(Boolean).join(' › ') : ''; }
    function skip() { const t = curTask(); if (t) t.skipped = true; nextTask(); }
    function undo(i) {
      const m = P.moves.splice(i, 1)[0];
      const t = P.tasks.find(x => x.item_code === m.item_code && x.from_warehouse === m.s_warehouse);
      if (t) { t.placed = Math.max(0, +(t.placed - m.qty).toFixed(6)); t.skipped = false; }
      nextTask();
    }
    async function post() {
      if (!P.moves.length) return;
      const ok = await confirmSheet('Post these moves?', `${P.moves.length} move${P.moves.length === 1 ? '' : 's'} as one Material Transfer. Items with batch or serial numbers are saved as a draft to finish in ERPNext.`, 'Post transfer');
      if (!ok) return;
      P.loading = true;
      try {
        const r = await api('scan', 'post_transfer', { rows: P.moves.map(m => ({ item_code: m.item_code, qty: m.qty, s_warehouse: m.s_warehouse, t_warehouse: m.t_warehouse })), submit: 1 }, true);
        P.result = {
          title: r.submitted ? 'Stock moved' : 'Saved as a draft',
          lines: [`Stock Entry ${r.name} · ${r.rows} line${r.rows === 1 ? '' : 's'}`,
            r.needs_batch_or_serial ? 'Some items need batch or serial numbers. Open it in ERPNext, add them and submit.' : (r.submitted ? 'Submitted. Stock levels are updated.' : '')].filter(Boolean),
          url: r.url, doc: 'Stock Entry', again: 'Put away more', tone: r.submitted ? 'ok' : 'warn',
        };
        feedback('ok');
        cache.clear();
      } catch (e) { flash('err', e.message); }
      finally { P.loading = false; }
    }
    async function back() {
      if (P.moves.length && !P.result && !(await confirmSheet('Leave put away?', `${P.moves.length} scanned move${P.moves.length === 1 ? '' : 's'} haven't been posted and will be lost.`, 'Leave', true))) return;
      Putaway.reset(); go('home');
    }
    return { S, P, task, left, best, allDone, where, skip, undo, post, back, fmt, again: () => Putaway.reset(), home: () => { Putaway.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Put away" :sub="P.source ? P.source.doctype + ' ' + P.source.name : ''" @back="back"/>
      <main class="ws-main">
        <Done v-if="P.result" :result="P.result" @again="again" @home="home"/>
        <template v-else>
          <div v-if="P.loading" class="ws-muted">Working…</div>
          <Prompt v-else-if="!P.tasks.length" text="Scan a receipt or an item" hint="A Purchase Receipt, Stock Entry or Subcontracting Receipt brings all its items. One item asks how many."/>
          <template v-else-if="task">
            <div class="ws-progress"><span :style="{width: (P.tasks.filter(t=>t.placed>=t.qty).length / P.tasks.length * 100) + '%'}"></span></div>
            <div class="ws-card hero">
              <div class="ws-kicker">Item {{P.cur+1}} of {{P.tasks.length}} · from {{task.from_warehouse}}</div>
              <div class="ws-big">{{task.item_code}}</div>
              <div class="ws-muted">{{task.item_name}}</div>
              <div class="ws-qtyline"><b>{{fmt(left)}}</b> {{task.uom}} to put away<span v-if="task.placed"> · {{fmt(task.placed)}} done</span></div>
            </div>
            <Prompt v-if="best" :text="'Take it to ' + where(best)" :hint="best.reasons.join(' · ')" tone="go"/>
            <Prompt v-else text="Scan any location" hint="No location on this floor has room listed for it. Pick one yourself." tone="warn"/>
            <div v-if="task.alternatives.length" class="ws-alts">
              <span class="ws-muted">Also good:</span>
              <span v-for="a in task.alternatives" :key="a.wh" class="ws-chip static">{{where(a)}}</span>
            </div>
            <div class="ws-actions"><button class="ws-btn ghost" @click="skip">Skip this item</button></div>
          </template>
          <Prompt v-else-if="allDone" text="Everything is placed" hint="Post the transfer below, or scan another item." tone="go"/>

          <template v-if="P.moves.length">
            <div class="ws-h">Scanned moves</div>
            <div v-for="(m,i) in P.moves" :key="i" class="ws-line">
              <div><b>{{m.item_code}}</b><small>→ {{m.path}}</small></div>
              <div class="ws-num">{{fmt(m.qty)}} <small>{{m.uom}}</small></div>
              <button class="ws-x" aria-label="Remove move" @click="undo(i)">×</button>
            </div>
          </template>
        </template>
      </main>
      <div v-if="P.moves.length && !P.result" class="ws-footer">
        <button class="ws-btn primary wide" :disabled="P.loading" @click="post">Post {{P.moves.length}} move{{P.moves.length===1?'':'s'}}</button>
      </div>
    </div>`,
};

// ── Pick ──────────────────────────────────────────────────────
const K = reactive({ lists: null, pl: null, order: prefs.get('pickOrder', 'walk'), picks: {}, skipped: {}, at: null, loading: false, result: null });
const Pick = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(K, { lists: null, pl: null, picks: {}, skipped: {}, at: null, loading: false, result: null }); },
  async open(name) {
    if (K.pl && Object.keys(K.picks).length && K.pl.name !== name) { flash('warn', 'Save the picks on the open Pick List first'); return; }
    Pick.reset(); go('pick'); K.loading = true;
    try {
      K.pl = await api('scan', 'get_pick_list', { name });
      K.pl.rows.forEach(r => { if (r.picked_qty > 0) K.picks[r.row_name] = { picked_qty: r.picked_qty, warehouse: null, saved: true }; });
      if (!K.pl.can_write) flash('warn', K.pl.docstatus === 0 ? "You can't change this Pick List" : `${name} is already submitted`);
      else flash('ok', name);
    } catch (e) { flash('err', e.message); K.pl = null; }
    finally { K.loading = false; }
  },
  async loadLists() {
    K.loading = true;
    try { K.lists = (await api('routes', 'get_pick_lists', { group_warehouse: S.floor, days: 30, limit: 50 })).filter(l => l.docstatus === 0); }
    catch (e) { flash('err', e.message); K.lists = []; }
    finally { K.loading = false; }
  },
  setup() {
    if (!K.pl && !K.lists) Pick.loadLists();
    const rows = computed(() => !K.pl ? [] : K.pl.rows.slice().sort((a, b) => K.order === 'walk' ? a.walk - b.walk : a.idx - b.idx));
    const isDone = r => !!K.picks[r.row_name] || !!K.skipped[r.row_name];
    // A stop is a run of consecutive rows at the same warehouse.
    const stops = computed(() => {
      const out = [];
      rows.value.forEach(r => {
        const last = out[out.length - 1];
        if (last && last.warehouse === r.warehouse) last.rows.push(r);
        else out.push({ warehouse: r.warehouse, path: r.path, floor_label: r.floor_label, mapped: r.mapped, rows: [r] });
      });
      return out;
    });
    const stopIdx = computed(() => stops.value.findIndex(s => s.rows.some(r => !isDone(r))));
    const stop = computed(() => stops.value[stopIdx.value] || null);
    const doneCount = computed(() => rows.value.filter(isDone).length);
    const pending = computed(() => Object.values(K.picks).filter(p => !p.saved).length);
    watch(stop, (a, b) => { if (!a || !b || a.warehouse !== b.warehouse) K.at = null; });

    async function pickRow(r, scanned) {
      if (!K.pl.can_write) { flash('warn', 'This Pick List is read-only here'); return; }
      const have = K.picks[r.row_name];
      const qty = await ask({
        title: `Pick ${r.item_code}`, sub: `Line ${r.idx} · from ${K.at && K.at.warehouse !== r.warehouse ? K.at.path : r.path}${r.batch_no ? ' · batch ' + r.batch_no : ''}`,
        // A pack barcode (box of 12) starts at one pack; anything else at the full line.
        value: String(have ? have.picked_qty : (scanned && scanned.factor > 1 && scanned.factor < r.qty ? scanned.factor : r.qty)),
        unit: r.uom, ok: 'Picked', quick: [{ label: 'All ' + fmt(r.qty), value: r.qty }, { label: 'None', value: 0 }],
      });
      if (qty === null) return;
      if (qty > r.qty + 1e-9) { flash('err', `Line ${r.idx} asks for ${fmt(r.qty)} ${r.uom}`); return; }
      K.picks[r.row_name] = { picked_qty: qty, warehouse: K.at && K.at.warehouse !== r.warehouse ? K.at.warehouse : null, saved: false };
      delete K.skipped[r.row_name];
      flash(qty + 1e-9 < r.qty ? 'warn' : 'ok', qty + 1e-9 < r.qty ? `Short: ${fmt(qty)} of ${fmt(r.qty)} ${r.uom}` : `${fmt(qty)} ${r.uom} ${r.item_code}`);
    }

    handler.fn = async r => {
      if (r.kind === 'document' && r.action === 'pick') return Pick.open(r.name);
      if (!K.pl) { flash('warn', 'Scan or choose a Pick List first'); return; }
      const st = stop.value;
      if (r.kind === 'location') {
        if (!st) { flash('warn', 'All lines are done'); return; }
        if (r.warehouse === st.warehouse) { K.at = r; flash('ok', `At ${r.path}`); return; }
        const elsewhere = stops.value.find(s => s.warehouse === r.warehouse && s.rows.some(x => !isDone(x)));
        if (elsewhere) { flash('warn', `${r.path} comes later. Go to ${st.path} first, or pick here anyway.`); K.at = r; return; }
        K.at = r;
        flash('warn', `Picking from ${r.path} instead of ${st.path}`);
        return;
      }
      if (r.kind === 'item') {
        if (!st) { flash('warn', 'All lines are done'); return; }
        if (!K.at) { flash('warn', `Scan the location ${st.path} first`); return; }
        const row = st.rows.find(x => x.item_code === r.item_code && !isDone(x));
        if (!row) {
          const later = rows.value.find(x => x.item_code === r.item_code && !isDone(x));
          flash('err', later ? `${r.item_code} is picked at ${later.path} (line ${later.idx})` : `${r.item_code} isn't on this Pick List`);
          return;
        }
        if (r.batch_no && row.batch_no && r.batch_no !== row.batch_no) { flash('err', `Wrong batch: line ${row.idx} needs ${row.batch_no}`); return; }
        // First expiry, first out: a line with no batch set should take the batch expiring first.
        const first = !row.batch_no && r.batch_no ? fefoFirst(row, r.batch_no) : null;
        if (first && !(await confirmSheet('Pick the older batch?', `Batch ${first.batch_no} on this shelf expires ${first.expiry}, before ${r.batch_no}${first.mine ? ' (' + first.mine + ')' : ''}. Pick ${first.batch_no} first.`, 'Pick ' + r.batch_no + ' anyway', true))) return;
        return pickRow(row, r);
      }
      flash('err', 'Scan a location or an item');
    };

    function fefoFirst(row, scanned) {
      const live = (row.batches || []).filter(b => b.qty > 0);
      const top = live[0], mine = live.find(b => b.batch_no === scanned);
      if (!top || !top.expiry || top.batch_no === scanned) return null;
      if (mine && mine.expiry && mine.expiry <= top.expiry) return null;
      return { batch_no: top.batch_no, expiry: top.expiry, mine: mine && mine.expiry ? 'expires ' + mine.expiry : '' };
    }
    function skipStop() { if (stop.value) stop.value.rows.forEach(r => { if (!K.picks[r.row_name]) K.skipped[r.row_name] = true; }); }
    function setOrder(o) { K.order = o; prefs.set('pickOrder', o); }
    async function save(submit) {
      const picks = Object.entries(K.picks).filter(([, p]) => !p.saved || submit).map(([row_name, p]) => ({ row_name, picked_qty: p.picked_qty, warehouse: p.warehouse }));
      const short = rows.value.filter(r => !K.picks[r.row_name] || K.picks[r.row_name].picked_qty + 1e-9 < r.qty).length;
      if (submit) {
        const ok = await confirmSheet('Submit the Pick List?', short ? `${short} line${short === 1 ? ' is' : 's are'} short or not picked. Submit anyway?` : 'Every line is picked in full.', 'Save & submit', !!short);
        if (!ok) return;
      }
      K.loading = true;
      try {
        const r = await api('scan', 'save_picks', { name: K.pl.name, picks, submit: submit ? 1 : 0 }, true);
        Object.values(K.picks).forEach(p => { p.saved = true; p.warehouse = null; });
        if (submit) {
          K.result = { title: 'Pick List submitted', lines: [`${r.name}`, short ? `${short} line${short === 1 ? '' : 's'} short` : 'All lines picked'], url: r.url, doc: 'Pick List', again: 'Pick another list', tone: short ? 'warn' : 'ok',
            next: EXT.afterPick ? EXT.afterPick(r.name) : null };
          feedback('ok');
        } else flash('ok', 'Picks saved');
        cache.clear();
      } catch (e) { flash('err', e.message); }
      finally { K.loading = false; }
    }
    async function back() {
      if (pending.value && !(await confirmSheet('Leave this Pick List?', `${pending.value} pick${pending.value === 1 ? '' : 's'} haven't been saved.`, 'Leave', true))) return;
      if (K.pl && !K.result) { Pick.reset(); Pick.loadLists(); return; }
      Pick.reset(); go('home');
    }
    return { S, K, rows, stops, stop, stopIdx, doneCount, pending, isDone, pickRow, skipStop, setOrder, save, back, fmt, daysAgo,
      open: n => Pick.open(n), again: () => { Pick.reset(); Pick.loadLists(); }, home: () => { Pick.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Pick" :sub="K.pl ? K.pl.name + (K.pl.customer ? ' · ' + K.pl.customer : '') : ''" @back="back"/>
      <main class="ws-main">
        <Done v-if="K.result" :result="K.result" @again="again" @home="home"/>
        <template v-else-if="!K.pl">
          <Prompt text="Scan a Pick List" hint="Or choose one of the draft Pick Lists for this floor."/>
          <div v-if="K.loading" class="ws-muted">Loading…</div>
          <button v-for="l in K.lists || []" :key="l.name" class="ws-line btn" @click="open(l.name)">
            <div><b>{{l.name}}</b><small>{{l.customer || l.purpose}} · {{daysAgo(l.creation) === 0 ? 'today' : daysAgo(l.creation) + ' days ago'}}</small></div>
            <div class="ws-num">{{l.floor_rows}} <small>line{{l.floor_rows==1?'':'s'}}</small></div>
          </button>
          <div v-if="K.lists && !K.lists.length" class="ws-muted">No draft Pick Lists on this floor in the last 30 days.</div>
        </template>
        <template v-else>
          <div class="ws-seg" role="group" aria-label="Order">
            <button :class="{on:K.order==='walk'}" @click="setOrder('walk')">Walking order</button>
            <button :class="{on:K.order==='saved'}" @click="setOrder('saved')">Pick List order</button>
          </div>
          <div class="ws-progress"><span :style="{width: (doneCount / Math.max(1, rows.length) * 100) + '%'}"></span></div>
          <div class="ws-muted small">{{doneCount}} of {{rows.length}} lines done</div>
          <template v-if="stop">
            <div class="ws-card hero">
              <div class="ws-kicker">Stop {{stopIdx+1}} of {{stops.length}}<span v-if="stop.floor_label"> · {{stop.floor_label}}</span></div>
              <div class="ws-big">{{stop.path}}</div>
              <div v-if="!stop.mapped" class="ws-muted">This warehouse isn't on the map.</div>
            </div>
            <Prompt v-if="!K.at" :text="'Scan the location ' + stop.path" hint="Confirms you're at the right shelf." tone="go"/>
            <Prompt v-else :text="'Scan each item'" :hint="K.at.warehouse===stop.warehouse ? 'Or tap a line to enter it without scanning.' : 'Picking from ' + K.at.path + ' instead.'" :tone="K.at.warehouse===stop.warehouse ? 'go' : 'warn'"/>
            <button v-for="r in stop.rows" :key="r.row_name" class="ws-line btn" :class="{done:isDone(r)}" @click="pickRow(r)">
              <div><b>{{r.item_code}}</b><small>Line {{r.idx}} · {{r.item_name}}<span v-if="r.batch_no"> · batch {{r.batch_no}}<template v-if="r.batch_expiry"> (exp {{r.batch_expiry}})</template></span></small>
                <small v-if="r.fefo" class="ws-fefo">Batch {{r.fefo.batch_no}} here expires sooner ({{r.fefo.expiry}})</small>
                <small v-else-if="!r.batch_no && r.batches && r.batches.length && r.batches[0].expiry" class="ws-fefo ok">Take batch {{r.batches[0].batch_no}} first · exp {{r.batches[0].expiry}}</small></div>
              <div class="ws-num">
                <template v-if="K.picks[r.row_name]">{{fmt(K.picks[r.row_name].picked_qty)}}<small>/{{fmt(r.qty)}} {{r.uom}}</small></template>
                <template v-else>{{fmt(r.qty)}} <small>{{r.uom}}</small></template>
              </div>
            </button>
            <div class="ws-actions"><button class="ws-btn ghost" @click="skipStop">Skip this stop</button></div>
          </template>
          <Prompt v-else text="All lines done" :hint="K.pl.can_write ? 'Save & submit below, or go back to fix a line.' : ''" tone="go"/>
          <details class="ws-all">
            <summary>All lines</summary>
            <button v-for="r in rows" :key="r.row_name" class="ws-line btn" :class="{done:isDone(r)}" @click="pickRow(r)">
              <div><b>{{r.item_code}}</b><small>{{r.path}} · line {{r.idx}}</small></div>
              <div class="ws-num">{{K.picks[r.row_name] ? fmt(K.picks[r.row_name].picked_qty) + '/' : ''}}{{fmt(r.qty)}} <small>{{r.uom}}</small></div>
            </button>
          </details>
        </template>
      </main>
      <div v-if="K.pl && !K.result && K.pl.can_write" class="ws-footer two">
        <button class="ws-btn" :disabled="K.loading || !pending" @click="save(false)">Save{{pending ? ' ' + pending : ''}}</button>
        <button class="ws-btn primary" :disabled="K.loading" @click="save(true)">Save & submit</button>
      </div>
    </div>`,
};

// ── Count ─────────────────────────────────────────────────────
const C = reactive({ loc: null, lines: [], blind: prefs.get('blind', false), queue: null, locs: {}, loading: false, result: null, zeroUncounted: false, review: false, lastHit: null });
const Count = {
  components: { TopBar, Prompt, Icon, Done },
  reset() { Object.assign(C, { loc: null, lines: [], loading: false, result: null, review: false, zeroUncounted: false, lastHit: null }); },
  async loadQueue() {
    C.loading = true;
    try {
      const r = await api('scan', 'get_floor_locations', { floor: S.floor });
      C.locs = Object.fromEntries(r.locations.map(l => [l.wh, l]));
      C.queue = r.queue.map(w => C.locs[w]);
    } catch (e) { flash('err', e.message); C.queue = []; }
    finally { C.loading = false; }
  },
  async start(loc) {
    if (loc.is_group) { flash('err', `${loc.path} is a group. Scan a shelf or floor area.`); return; }
    C.loc = loc; C.lines = []; C.loading = true; C.review = false;
    try {
      const r = await api('operations', 'get_bin_stock', { warehouse: loc.warehouse });
      C.lines = r.items.map(it => ({ item_code: it.item_code, item_name: it.item_name, uom: it.stock_uom, system: it.actual_qty, counted: null, tracked: !!(it.has_batch_no || it.has_serial_no) }));
      flash('ok', `Counting ${loc.path}`);
    } catch (e) { flash('err', e.message); C.loc = null; }
    finally { C.loading = false; }
  },
  setup() {
    if (!C.queue) Count.loadQueue();
    const counted = computed(() => C.lines.filter(l => l.counted !== null));
    const diffs = computed(() => C.lines.filter(l => l.counted !== null && Math.abs(l.counted - l.system) > 1e-9));
    const uncounted = computed(() => C.lines.filter(l => l.counted === null && l.system > 0));

    function bump(line, by) {
      line.counted = +((line.counted || 0) + by).toFixed(6);
      C.lastHit = line.item_code + ':' + Date.now();
      nextTick(() => { const el = document.querySelector(`[data-line="${CSS.escape(line.item_code)}"]`); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    }
    handler.fn = async r => {
      if (r.kind === 'location') {
        if (C.loc && counted.value.length) { flash('warn', `Finish or cancel the count of ${C.loc.path} first`); return; }
        return Count.start(r);
      }
      if (r.kind === 'item') {
        if (!C.loc) { flash('warn', 'Scan the location label first'); return; }
        let line = C.lines.find(l => l.item_code === r.item_code);
        if (!line) {
          line = { item_code: r.item_code, item_name: r.item_name, uom: r.stock_uom, system: 0, counted: null, tracked: !!(r.has_batch_no || r.has_serial_no), extra: true };
          C.lines.push(line);
          flash('warn', `${r.item_code} wasn't expected here. Added.`);
        } else flash('ok', `${r.item_code} +${fmt(r.factor || 1)}`);
        bump(line, r.factor || 1);
        return;
      }
      flash('err', 'Scan a location or an item');
    };
    async function edit(line) {
      const v = await ask({ title: line.item_code, sub: (C.blind ? '' : `System: ${fmt(line.system)} ${line.uom} · `) + 'Enter the total you counted', value: line.counted === null ? '' : String(line.counted), unit: line.uom, ok: 'Set count', quick: [{ label: 'None here', value: 0 }] });
      if (v === null) return;
      if (v < 0) { flash('err', "A count can't be negative"); return; }
      line.counted = v;
    }
    function setBlind(v) { C.blind = v; prefs.set('blind', v); }
    async function post() {
      const rows = C.lines.filter(l => !l.tracked && (l.counted !== null || (C.zeroUncounted && l.system > 0)))
        .map(l => ({ item_code: l.item_code, qty: l.counted === null ? 0 : l.counted }));
      C.loading = true;
      try {
        const r = await api('scan', 'finish_count', { warehouse: C.loc.warehouse, rows }, true);
        const tracked = C.lines.filter(l => l.tracked && l.counted !== null).length;
        if (C.locs[C.loc.warehouse]) C.locs[C.loc.warehouse].last_counted = new Date().toISOString().slice(0, 10);
        C.queue = (C.queue || []).filter(q => q.wh !== C.loc.warehouse);
        C.result = r.name ? {
          title: 'Count recorded', tone: 'warn', url: r.url, doc: 'Stock Reconciliation', again: 'Count the next location',
          lines: [`${r.rows} difference${r.rows === 1 ? '' : 's'} in draft Stock Reconciliation ${r.name}.`, 'A Stock Manager reviews and submits it in ERPNext.',
            tracked ? `${tracked} batch or serial item${tracked === 1 ? '' : 's'} must be reconciled in ERPNext.` : ''].filter(Boolean),
        } : {
          title: 'Count matches', tone: 'ok', again: 'Count the next location',
          lines: [`${C.loc.path}: no differences.`, tracked ? `${tracked} batch or serial item${tracked === 1 ? '' : 's'} weren't checked against batches.` : ''].filter(Boolean),
        };
        feedback('ok');
        cache.clear();
      } catch (e) { flash('err', e.message); }
      finally { C.loading = false; }
    }
    async function cancel() {
      if (counted.value.length && !(await confirmSheet('Cancel this count?', `${counted.value.length} counted item${counted.value.length === 1 ? '' : 's'} will be thrown away.`, 'Cancel count', true))) return;
      Count.reset();
    }
    async function back() {
      if (C.loc && !C.result) return cancel();
      Count.reset(); go('home');
    }
    function lastText(l) { const d = daysAgo(l.last_counted); return d === null ? 'Never counted' : d === 0 ? 'Counted today' : `Counted ${d} day${d === 1 ? '' : 's'} ago`; }
    function startLoc(l) { Count.start({ kind: 'location', warehouse: l.wh, path: l.path, floor_label: floorLabel.value, is_group: 0 }); }
    function next() { Count.reset(); const n = (C.queue || [])[0]; if (n) startLoc(n); }
    return { S, C, counted, diffs, uncounted, edit, setBlind, post, cancel, back, fmt, lastText, startLoc, next, home: () => { Count.reset(); go('home'); } };
  },
  template: `
    <div>
      <TopBar title="Count" :sub="C.loc ? C.loc.path : ''" @back="back"/>
      <main class="ws-main">
        <Done v-if="C.result" :result="C.result" @again="next" @home="home"/>
        <template v-else-if="!C.loc">
          <Prompt text="Scan a location label" hint="Or start with the locations due for a count."/>
          <div v-if="C.loading" class="ws-muted">Loading…</div>
          <template v-else-if="C.queue">
            <div class="ws-h">Due for counting</div>
            <button v-for="l in C.queue.slice(0, 25)" :key="l.wh" class="ws-line btn" @click="startLoc(l)">
              <div><b>{{l.path}}</b><small :class="{warn: !l.last_counted}">{{lastText(l)}}</small></div>
              <div class="ws-num">{{l.items}} <small>item{{l.items===1?'':'s'}}</small></div>
            </button>
            <div v-if="!C.queue.length" class="ws-muted">No locations with stock on this floor.</div>
          </template>
        </template>
        <template v-else-if="C.review">
          <div class="ws-card">
            <div class="ws-h0">Check before posting</div>
            <div class="ws-stat"><span>Counted</span><b>{{counted.length}}</b></div>
            <div class="ws-stat"><span>Different from ERPNext</span><b :class="{warn: diffs.length}">{{diffs.length}}</b></div>
            <div class="ws-stat"><span>Not counted</span><b>{{uncounted.length}}</b></div>
          </div>
          <div v-for="l in diffs" :key="l.item_code" class="ws-line">
            <div><b>{{l.item_code}}</b><small>ERPNext {{fmt(l.system)}} → counted {{fmt(l.counted)}}</small></div>
            <div class="ws-num" :class="l.counted > l.system ? 'pos' : 'neg'">{{l.counted > l.system ? '+' : ''}}{{fmt(l.counted - l.system)}}</div>
          </div>
          <fieldset v-if="uncounted.length" class="ws-radio">
            <legend>{{uncounted.length}} item{{uncounted.length===1?'':'s'}} not counted</legend>
            <label><input type="radio" :value="false" v-model="C.zeroUncounted"/> Leave them as they are</label>
            <label><input type="radio" :value="true" v-model="C.zeroUncounted"/> They aren't here: set to 0</label>
          </fieldset>
          <div v-if="C.lines.some(l => l.tracked && l.counted !== null)" class="ws-note">Batch and serial items are listed for the count but must be reconciled in ERPNext.</div>
        </template>
        <template v-else>
          <div v-if="C.loading" class="ws-muted">Loading…</div>
          <template v-else>
            <Prompt :text="counted.length ? 'Keep scanning items' : 'Scan each item'" hint="Each scan adds one (or a whole pack for a pack barcode). Tap a line to type a total." tone="go"/>
            <label class="ws-toggle"><input type="checkbox" :checked="C.blind" @change="setBlind($event.target.checked)"/> Blind count (hide ERPNext quantities)</label>
            <div v-for="l in C.lines" :key="l.item_code" class="ws-line btn" role="button" tabindex="0" :data-line="l.item_code"
              :class="{hit: C.lastHit && C.lastHit.startsWith(l.item_code + ':'), done: l.counted !== null}" @click="edit(l)" @keydown.enter="edit(l)">
              <div><b>{{l.item_code}}</b><small>{{l.item_name}}<span v-if="l.extra"> · not expected here</span><span v-if="l.tracked"> · batch/serial</span></small></div>
              <div class="ws-num">
                <span v-if="l.counted===null" class="ws-muted">–</span><template v-else>{{fmt(l.counted)}}</template>
                <small v-if="!C.blind"> / {{fmt(l.system)}}</small> <small>{{l.uom}}</small>
              </div>
            </div>
            <div v-if="!C.lines.length" class="ws-muted">ERPNext shows nothing here. Scan anything you find.</div>
          </template>
        </template>
      </main>
      <div v-if="C.loc && !C.result" class="ws-footer two">
        <button v-if="!C.review" class="ws-btn" @click="cancel">Cancel</button>
        <button v-else class="ws-btn" @click="C.review=false">Keep counting</button>
        <button v-if="!C.review" class="ws-btn primary" :disabled="C.loading || (!counted.length && !C.lines.length)" @click="C.review=true">Finish</button>
        <button v-else class="ws-btn primary" :disabled="C.loading" @click="post">Post count</button>
      </div>
    </div>`,
};

// ── Labels ────────────────────────────────────────────────────
const LB = reactive({ data: null, chosen: {}, size: prefs.get('labelSize', 'small'), loading: false, qrReady: false });
const Labels = {
  components: { TopBar, Prompt, Icon },
  reset() { LB.data = null; LB.chosen = {}; },
  setup() {
    handler.fn = r => Lookup.show(r);
    async function load() {
      LB.loading = true;
      try {
        LB.data = await api('scan', 'get_floor_locations', { floor: S.floor });
        LB.chosen = Object.fromEntries(LB.data.locations.map(l => [l.wh, true]));
        await loadScript(QR_URL); LB.qrReady = true;
      } catch (e) { flash('err', e.message); }
      finally { LB.loading = false; }
    }
    if (!LB.data) load(); else loadScript(QR_URL).then(() => { LB.qrReady = true; });
    const racks = computed(() => {
      const out = [];
      (LB.data ? LB.data.locations : []).forEach(l => {
        const last = out[out.length - 1];
        if (last && last.slot === l.slot) last.locs.push(l); else out.push({ slot: l.slot, label: l.slot_label, locs: [l] });
      });
      return out;
    });
    const chosenList = computed(() => (LB.data ? LB.data.locations : []).filter(l => LB.chosen[l.wh]));
    function qr(text) {
      if (!LB.qrReady || !window.qrcode) return '';
      const q = window.qrcode(0, 'M'); q.addData(text, 'Byte'); q.make();
      return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    }
    function toggleRack(rk) { const on = !rk.locs.every(l => LB.chosen[l.wh]); rk.locs.forEach(l => { LB.chosen[l.wh] = on; }); }
    function all(on) { Object.keys(LB.chosen).forEach(k => { LB.chosen[k] = on; }); }
    function setSize(s) { LB.size = s; prefs.set('labelSize', s); }
    function print() { if (!chosenList.value.length) { flash('warn', 'Choose at least one location'); return; } window.print(); }
    return { S, LB, racks, chosenList, qr, toggleRack, all, setSize, print, back: () => go('home') };
  },
  template: `
    <div>
      <TopBar title="Location labels" :sub="LB.data ? LB.data.floor_label : ''" @back="back"/>
      <main class="ws-main no-print">
        <div v-if="LB.loading" class="ws-muted">Loading…</div>
        <template v-else-if="LB.data">
          <div class="ws-note">Stick one on each shelf or floor area. Scanning it tells the app exactly where you are.</div>
          <div class="ws-seg" role="group" aria-label="Label size">
            <button :class="{on:LB.size==='small'}" @click="setSize('small')">Small · 24 per A4</button>
            <button :class="{on:LB.size==='large'}" @click="setSize('large')">Large · 8 per A4</button>
          </div>
          <div class="ws-row2"><button class="ws-chip" @click="all(true)">Select all</button><button class="ws-chip" @click="all(false)">Clear</button></div>
          <div v-for="rk in racks" :key="rk.slot" class="ws-rack">
            <button class="ws-rack-h" @click="toggleRack(rk)">{{rk.label}} <small>{{rk.locs.filter(l=>LB.chosen[l.wh]).length}}/{{rk.locs.length}}</small></button>
            <label v-for="l in rk.locs" :key="l.wh" class="ws-chip" :class="{on:LB.chosen[l.wh]}"><input type="checkbox" v-model="LB.chosen[l.wh]"/>{{l.label === 'Floor stack' ? 'Floor area' : l.label}}</label>
          </div>
        </template>
      </main>
      <div v-if="LB.data" class="ws-footer no-print">
        <button class="ws-btn primary wide" :disabled="!LB.qrReady" @click="print">Print {{chosenList.length}} label{{chosenList.length===1?'':'s'}}</button>
      </div>
      <div class="ws-print" :class="LB.size" aria-hidden="true">
        <div v-for="l in chosenList" :key="l.wh" class="ws-label">
          <div class="ws-label-qr" v-html="qr(l.wh)"></div>
          <div class="ws-label-t">
            <div class="ws-label-big">{{l.path}}</div>
            <div class="ws-label-floor">{{LB.data.floor_label}}</div>
            <div class="ws-label-wh">{{l.wh}}</div>
          </div>
        </div>
      </div>
    </div>`,
};

// ── Floor picker and root ─────────────────────────────────────
const FloorSheet = {
  setup() {
    const open = ref(false);
    const groups = computed(() => {
      const out = {};
      S.floors.forEach(f => { (out[f.parent_name || 'Other'] = out[f.parent_name || 'Other'] || []).push(f); });
      return out;
    });
    function choose(f) { S.floor = f.id; prefs.set('floor', f.id); open.value = false; Count.reset(); C.queue = null; K.lists = null; LB.data = null; }
    return { S, open, groups, choose };
  },
  template: `
    <div v-if="open" class="ws-scrim" @click.self="open=false">
      <div class="ws-sheet tall" role="dialog" aria-label="Choose floor">
        <div class="ws-sheet-t">Which floor are you on?</div>
        <div v-for="(fl, b) in groups" :key="b">
          <div class="ws-h">{{b}}</div>
          <button v-for="f in fl" :key="f.id" class="ws-line btn" :class="{on: f.id===S.floor}" @click="choose(f)">
            <div><b>{{f.name}}</b><small>{{f.slot_count}} rack{{f.slot_count==1?'':'s'}} and areas</small></div>
          </button>
        </div>
        <div v-if="!S.floors.length" class="ws-muted">No floors set up yet.</div>
      </div>
    </div>`,
};

const Root = {
  components: { Home, Lookup, Putaway, Pick, Count, Labels, ScanBar, Sheet, Confirm, Camera, FloorSheet },
  setup() {
    const floorSheet = ref(null);
    async function boot() {
      try {
        const access = await api('api', 'get_user_access', {});
        if (!access.can_view) { S.notice = 'Warehouse Scan is for Stock Users, Stock Managers and System Managers.'; return; }
        S.floors = await api('api', 'get_warehouse_groups', {});
        S.floorsLoaded = true;
        if (S.floor && !S.floors.some(f => f.id === S.floor)) S.floor = null;
        if (!S.floor && S.floors.length === 1) S.floor = S.floors[0].id;
      } catch (e) { S.notice = e.message; return; }
      // Links from ERPNext forms: ?pick=, ?putaway=DOCTYPE&name=, ?count=WAREHOUSE, ?floor=
      const q = new URLSearchParams(location.search);
      if (q.get('floor') && S.floors.some(f => f.id === q.get('floor'))) S.floor = q.get('floor');
      if ([...q.keys()].length) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
      if (q.get('pick')) Pick.open(q.get('pick'));
      else if (q.get('putaway') && q.get('name')) Putaway.fromDocument(q.get('putaway'), q.get('name'), 1);
      else if (Object.keys(EXT.links).some(k => q.get(k))) { const k = Object.keys(EXT.links).find(x => q.get(x)); EXT.links[k](q.get(k), q); }
      else if (q.get('count')) { try { const r = await resolve(q.get('count')); if (r.kind === 'location') { go('count'); Count.start(r); } } catch (e) { flash('err', e.message); } }
    }
    onMounted(boot);
    watch(() => S.sound, v => prefs.set('sound', v));
    watch(() => S.floor, v => { if (v) prefs.set('floor', v); });
    const view = computed(() => ({ home: Home, lookup: Lookup, putaway: Putaway, pick: Pick, count: Count, labels: Labels, ...EXT.screens }[S.screen] || Home));
    return { S, C, view, floorSheet, onScan, pickFloor: () => { floorSheet.value.open = true; } };
  },
  template: `
    <div class="ws-app" :class="{busy:S.busy}">
      <div v-if="S.notice" class="ws-main"><div class="ws-note">{{S.notice}}</div></div>
      <template v-else>
        <component :is="view" :key="S.screen"/>
        <div v-if="S.flash" class="ws-flash" :class="S.flash.kind" role="status" aria-live="polite">{{S.flash.text}}</div>
        <ScanBar/>
      </template>
      <Sheet/><Confirm/><FloorSheet ref="floorSheet"/>
      <Camera v-if="S.camera" :continuous="S.screen==='count' && !!C.loc" @code="onScan" @close="S.camera=false"/>
    </div>`,
};

window.WarehouseScan = {
  mount(el) { const app = createApp(Root); app.mount(el); return app; },
  /* For mode files in scan/: shared state, server calls, sheets and components. */
  core: { S, EXT, ICONS, api, flash, feedback, ask, confirmSheet, go, handler, resolve, cache, prefs, fmt, daysAgo, loadScript, QR_URL,
    components: { TopBar, Prompt, Icon, Done } },
  _test: { S, P, K, C, L, LB, onScan, cache },
};
})();
