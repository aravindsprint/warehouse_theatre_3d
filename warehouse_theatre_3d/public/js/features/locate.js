/* Warehouse Theatre 3D — item locator.
   Find every bin holding an item (typed or scanned), fly the camera there and mark
   each bin with a beacon. Data: api/insights.locate_item, resolve_scan. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, bus, engine, actions, addCSS, ui } = core;
  const { defineComponent, reactive, ref, computed, onUnmounted, nextTick } = Vue;
  const { fmt } = core.helpers;

  addCSS('wtf-locate-style', `
.wtf-loc-scan{flex:0 0 auto!important;width:34px;padding:0}
.wtf-loc-floor{display:flex;justify-content:space-between;align-items:center;margin:10px 0 5px}
.wtf-loc-floor b{font-size:11px;color:var(--wt-text)}
.wtf-loc-row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.wtf-loc-bin{font-size:11px;font-weight:700;color:var(--wt-text)}
.wtf-loc-meta{font-size:9px;color:var(--wt-text3)}
.wtf-loc-qty{font-size:12px;font-weight:800;color:#22d3ee;white-space:nowrap}
.wtf-scan-video{width:100%;aspect-ratio:4/3;background:#000;border-radius:8px;object-fit:cover;display:block}
.wtf-scan-frame{position:relative}
.wtf-scan-frame::after{content:'';position:absolute;left:12%;right:12%;top:30%;bottom:30%;border:2px solid #22d3ee;border-radius:8px;box-shadow:0 0 0 999px rgba(0,0,0,.25);pointer-events:none}
#wtf-qr-reader{width:100%}
`);

  const BEACON = 0x22d3ee;
  const state = reactive({
    query: '', loading: false, error: '', result: null, scanOpen: false, scanError: '', scanStatus: '',
    serialWh: null,
  });

  const onFloor = computed(() => {
    if (!state.result || !store.curGrp) return [];
    return state.result.locations.filter(l => l.mapped && l.floor === store.curGrp.id && (!state.serialWh || l.wh === state.serialWh));
  });
  const otherFloors = computed(() => {
    if (!state.result) return [];
    const by = {};
    state.result.locations.filter(l => l.mapped && (!store.curGrp || l.floor !== store.curGrp.id)).forEach(l => {
      (by[l.floor] = by[l.floor] || { floor: l.floor, floor_label: l.floor_label, qty: 0, bins: 0 });
      by[l.floor].qty += l.qty; by[l.floor].bins += 1;
    });
    return Object.values(by);
  });
  const unmapped = computed(() => state.result ? state.result.locations.filter(l => !l.mapped) : []);

  function draw(fly) {
    const rows = onFloor.value;
    const targets = rows.map(l => {
      const f = ui.findLevel(l.wh);
      return { slot: l.slot, level: f ? f.level : null, color: BEACON, label: null };
    });
    const drawn = ui.drawBeacons('locate', targets);
    ui.highlight2D('wtf-locate-2d', [...new Set(rows.map(l => l.slot))], '#22d3ee');
    if (fly && drawn) ui.frameSlots(rows.map(l => l.slot));
  }

  function clear() {
    engine.clearOverlay('locate');
    ui.highlight2D('wtf-locate-2d', []);
  }

  async function locate(code, opts) {
    code = (code || '').trim();
    if (!code) return;
    state.query = code; state.loading = true; state.error = '';
    state.serialWh = (opts && opts.warehouse) || null;
    ui.openPanel('locate');
    try {
      const r = await core.api('insights', 'locate_item', { item_code: code, company: store.company || undefined });
      state.result = r;
      // Nothing on this floor but stock elsewhere in the theatre: jump to the floor holding the most.
      if (!onFloor.value.length && otherFloors.value.length) {
        const best = otherFloors.value.slice().sort((a, b) => b.qty - a.qty)[0];
        const g = store.groups.find(x => x.id === best.floor);
        if (g) { await actions.selectGroup(g); }
      }
      draw(true);
    } catch (e) {
      state.result = null; state.error = e.message; clear();
    } finally {
      state.loading = false;
    }
  }

  async function goFloor(floor) {
    const g = store.groups.find(x => x.id === floor);
    if (!g) { core.alert('That floor is not in the current company filter.', 'orange'); return; }
    await actions.selectGroup(g);
    draw(true);
  }

  function focusBin(l) {
    ui.frameSlots([l.slot]);
    const f = ui.findLevel(l.wh);
    if (f) {
      const key = core.helpers.lvKey(f.slot, f.lv);
      engine.highlight(key);
      actions.openDP({ slot: f.slot, lv: f.lv });
    }
  }

  function close() {
    ui.closePanel('locate');
    state.result = null; state.query = ''; state.error = ''; state.serialWh = null;
    clear();
  }

  bus.on('scene-built', () => { if (state.result) draw(false); });
  bus.on('escape', () => { if (ui.state.panel === 'locate') close(); });

  /* ── Barcode / QR scanning ──
     BarcodeDetector where the browser has it (Chrome/Android); otherwise the
     html5-qrcode library is loaded on demand (needed for iOS Safari). */
  const SCAN_LIB = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
  let stream = null, rafId = null, qr = null;

  function loadLib() {
    if (window.Html5Qrcode) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = SCAN_LIB; s.onload = res; s.onerror = () => rej(new Error('Could not load the scanner library.'));
      document.head.appendChild(s);
    });
  }

  async function onScanned(code) {
    stopScan();
    state.scanStatus = 'Looking up ' + code + '…';
    try {
      const r = await core.api('insights', 'resolve_scan', { code });
      if (!r || !r.item_code) { state.scanError = `No item, batch or serial number matches "${code}".`; state.scanOpen = true; return; }
      state.scanOpen = false;
      await locate(r.item_code, { warehouse: r.via === 'serial_no' ? r.warehouse : null });
    } catch (e) {
      state.scanError = e.message;
    } finally { state.scanStatus = ''; }
  }

  async function startScan() {
    state.scanOpen = true; state.scanError = ''; state.scanStatus = 'Starting camera…';
    await nextTick();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.scanError = 'Camera access is not available in this browser. Type the code instead.'; state.scanStatus = '';
      return;
    }
    try {
      if ('BarcodeDetector' in window) {
        const formats = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
        const detector = new window.BarcodeDetector(formats.length ? { formats } : undefined);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const video = document.getElementById('wtf-scan-video');
        if (!video) { stopScan(); return; }
        video.srcObject = stream;
        await video.play();
        state.scanStatus = 'Point the camera at a barcode or QR code';
        const tick = async () => {
          if (!stream) return;
          try {
            const codes = await detector.detect(video);
            if (codes && codes.length) { onScanned(codes[0].rawValue); return; }
          } catch (e) {}
          rafId = requestAnimationFrame(tick);
        };
        tick();
      } else {
        await loadLib();
        qr = new window.Html5Qrcode('wtf-qr-reader');
        state.scanStatus = 'Point the camera at a barcode or QR code';
        await qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 140 } },
          text => onScanned(text), () => {});
      }
    } catch (e) {
      state.scanError = (e && e.name === 'NotAllowedError')
        ? 'Camera permission was denied. Allow camera access for this site, or type the code.'
        : 'Could not start the camera: ' + (e.message || e);
      state.scanStatus = '';
      stopScan();
    }
  }

  function stopScan() {
    if (rafId) cancelAnimationFrame(rafId); rafId = null;
    if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
    if (qr) {
      // html5-qrcode throws if stop() is called when the camera never started.
      const q = qr; qr = null;
      try {
        if (q.isScanning) q.stop().catch(() => {}).finally(() => { try { q.clear(); } catch (e) {} });
        else q.clear();
      } catch (e) {}
    }
  }
  function closeScan() { stopScan(); state.scanOpen = false; state.scanStatus = ''; }

  const LocatePanel = defineComponent({
    name: 'WtfLocatePanel',
    components: { WtfPanel: ui.Panel, WtfItemPicker: ui.ItemPicker, WtfDialog: ui.Dialog },
    setup() {
      const typed = ref('');
      const hasDetector = 'BarcodeDetector' in window;
      onUnmounted(stopScan);
      return { state, ui, store, onFloor, otherFloors, unmapped, locate, goFloor, focusBin, close, fmt, typed,
        startScan, closeScan, hasDetector, manual: () => onScanned(typed.value.trim()) };
    },
    template: `
      <WtfPanel v-if="ui.state.panel==='locate'" title="📍 Locate item"
        sub="Every bin holding the item is marked on the map." @close="close()">
        <div class="wtf-row" style="margin-bottom:10px">
          <WtfItemPicker :modelValue="state.query" @pick="o => locate(o.item_code)" autofocus/>
          <button class="wtf-btn wtf-loc-scan" title="Scan a barcode or QR code" aria-label="Scan a barcode or QR code" @click="startScan()">📷</button>
        </div>
        <div v-if="state.loading" class="wtf-muted"><span class="wtf-spin"></span> Searching…</div>
        <div v-else-if="state.error" class="wtf-err">{{state.error}}</div>
        <template v-else-if="state.result">
          <div class="wtf-card">
            <div class="wtf-loc-bin">{{state.result.item.name}}</div>
            <div class="wtf-loc-meta">{{state.result.item.item_name}} · {{state.result.item.stock_uom}}</div>
            <div v-if="state.serialWh" class="wtf-loc-meta" style="margin-top:3px">Scanned serial number — showing its exact bin.</div>
          </div>
          <div class="wtf-loc-floor"><b>{{store.curGrp && store.curGrp.name}}</b><span class="wtf-chip">{{onFloor.length}} bin{{onFloor.length===1?'':'s'}}</span></div>
          <div v-if="!onFloor.length" class="wtf-muted">Not on this floor.</div>
          <div v-for="l in onFloor" :key="l.wh" class="wtf-card clickable" @click="focusBin(l)" tabindex="0" @keydown.enter="focusBin(l)">
            <div class="wtf-loc-row">
              <div><div class="wtf-loc-bin">{{l.slot_label}} · {{l.label}}</div><div class="wtf-loc-meta">{{l.wh}}<span v-if="l.reserved>0"> · {{fmt(l.reserved)}} reserved</span></div></div>
              <div class="wtf-loc-qty">{{fmt(l.qty)}}</div>
            </div>
          </div>
          <template v-if="otherFloors.length">
            <div class="wtf-sec">Other floors</div>
            <div v-for="f in otherFloors" :key="f.floor" class="wtf-card clickable" @click="goFloor(f.floor)" tabindex="0" @keydown.enter="goFloor(f.floor)">
              <div class="wtf-loc-row">
                <div><div class="wtf-loc-bin">{{f.floor_label}}</div><div class="wtf-loc-meta">{{f.bins}} bin{{f.bins===1?'':'s'}} · click to go there</div></div>
                <div class="wtf-loc-qty">{{fmt(f.qty)}}</div>
              </div>
            </div>
          </template>
          <template v-if="unmapped.length">
            <div class="wtf-sec">Outside the theatre</div>
            <div class="wtf-muted" style="margin-bottom:5px">Warehouses not mapped to a Floor/Slot/Bin.</div>
            <div v-for="l in unmapped" :key="l.wh" class="wtf-card"><div class="wtf-loc-row">
              <div class="wtf-loc-bin">{{l.label || l.wh}}</div><div class="wtf-loc-qty" style="color:var(--wt-text2)">{{fmt(l.qty)}}</div>
            </div></div>
          </template>
          <div v-if="!state.result.locations.length" class="wtf-muted">No stock of this item anywhere.</div>
        </template>
        <div v-else class="wtf-muted">Type an item code or name, or tap 📷 to scan its barcode. Batch and serial numbers work too.</div>
      </WtfPanel>
      <WtfDialog v-if="state.scanOpen" title="Scan barcode or QR" width="380px" @close="closeScan()">
        <div v-if="state.scanError" class="wtf-err">{{state.scanError}}</div>
        <div v-if="hasDetector" class="wtf-scan-frame"><video id="wtf-scan-video" class="wtf-scan-video" playsinline muted></video></div>
        <div v-else id="wtf-qr-reader"></div>
        <div class="wtf-muted" style="margin:8px 0" role="status">{{state.scanStatus}}</div>
        <div class="wtf-row">
          <input class="wtf-inp" v-model="typed" placeholder="…or type the code" @keydown.enter="manual()" aria-label="Code"/>
          <button class="wtf-btn" style="flex:0 0 auto" @click="manual()" :disabled="!typed.trim()">Find</button>
        </div>
      </WtfDialog>`,
  });
  ext.overlays.push(LocatePanel);

  ext.tools.push({
    id: 'locate', icon: '📍', label: 'Locate', title: 'Find an item on the map',
    show: () => !store.replayDate,   // finds today's stock, so it would contradict a replayed date
    active: () => ui.state.panel === 'locate',
    onClick: () => { if (ui.state.panel === 'locate') close(); else ui.openPanel('locate'); },
  });

  /* Other features can ask "where is this item?" */
  core.locate = { locate, clear };
  // Panel switched away: drop the beacons so they don't linger under another tool.
  Vue.watch(() => ui.state.panel, p => { if (p !== 'locate' && state.result) { state.result = null; clear(); } });
});

})();
