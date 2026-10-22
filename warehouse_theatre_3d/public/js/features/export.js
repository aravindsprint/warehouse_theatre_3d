/* Warehouse Theatre 3D — export.
   3D view as PNG, a printable floor plan (PNG or PDF) drawn from the slot grid in the
   current colouring (fill %, heatmap mode or replayed date), and a CSV of every bin. */
(function () {
'use strict';

WarehouseTheatre3D.register(core => {
  const { Vue, store, ext, hooks, engine, addCSS, ui } = core;
  const { defineComponent, reactive } = Vue;
  const { lvFill, fmtK, levelColorCss } = core.helpers;

  addCSS('wtf-export-style', `
.wtf-exp-opt{display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;padding:8px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--wt-text);cursor:pointer}
.wtf-exp-opt:hover{background:var(--wt-pill);border-color:var(--wt-pillb)}
.wtf-exp-opt:disabled{opacity:.45;cursor:not-allowed}
.wtf-exp-ico{font-size:16px;line-height:1}
.wtf-exp-t{font-size:11px;font-weight:700}
.wtf-exp-d{font-size:9px;color:var(--wt-text3);margin-top:1px}
`);

  const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const state = reactive({ busy: '' });

  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const fileBase = () => ((store.curGrp && store.curGrp.name) || 'floor').replace(/[^\w-]+/g, '_') + '_' + (store.replayDate || stamp());

  function download(href, name) {
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function legendItems() {
    const l = hooks.legend ? hooks.legend() : null;
    return l || [
      { color: '#4ade80', label: 'Low' }, { color: '#facc15', label: 'Mid' },
      { color: '#fb923c', label: 'High' }, { color: '#f87171', label: 'Full' }, { color: '#e2e8f0', label: 'Empty' },
    ];
  }
  function modeName() {
    if (store.replayDate) return 'Fill % on ' + store.replayDate;
    const m = core.heatmap && core.heatmap.state.mode;
    return m && m !== 'fill' && hooks.lvColor ? core.heatmap.MODES[m].label : 'Fill %';
  }

  /* Floor plan from the slot grid (rows × columns, with row gaps), each slot showing
     its levels as colour bars. Always drawn on white so it prints well. */
  function drawPlan() {
    const slots = store.slots;
    const CW = 132, CH = 30 + 18 * Math.max(1, ...slots.map(s => s.levels.length)), PAD = 40, GAPX = 14, GAPY = 16, HEAD = 92;
    // Every row a slot or zone occupies (zones can span several rows).
    const rows = [...new Set(slots.flatMap(s => Array.from({ length: s.kind === 'zone' ? Math.max(1, s.d || 1) : 1 }, (_, i) => s.row + i)))]
      .sort((a, b) => a - b);
    const cols = Math.max(1, ...slots.map(s => s.col + (s.kind === 'zone' ? (s.w || 1) : 1)));
    const rowY = {};
    let y = HEAD;
    rows.forEach(r => {
      rowY[r] = y;
      const gap = parseFloat((slots.find(s => s.row === r) || {}).row_gap) || 0;
      y += CH + GAPY + gap * 22;
    });
    const W = Math.max(720, PAD * 2 + cols * (CW + GAPX) - GAPX);
    const H = y + 70;
    const c = document.createElement('canvas');
    const scale = 2;
    c.width = W * scale; c.height = H * scale;
    const g = c.getContext('2d');
    g.scale(scale, scale);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#1a202c'; g.font = 'bold 20px -apple-system,Inter,Arial,sans-serif';
    g.fillText((store.curGrp && store.curGrp.name) || 'Floor', PAD, 40);
    g.font = '12px -apple-system,Inter,Arial,sans-serif'; g.fillStyle = '#718096';
    g.fillText(`Colour: ${modeName()} · ${new Date().toLocaleString()} · Warehouse Theatre 3D`, PAD, 62);
    const dock = ui.floor && ui.floor.dockSlot;

    slots.forEach(sl => {
      const x = PAD + sl.col * (CW + GAPX), y0 = rowY[sl.row];
      if (sl.kind === 'zone') { drawZone(g, sl, x, y0, rowY, CW, CH, GAPX, dock); return; }
      g.fillStyle = '#f7fafc'; g.strokeStyle = sl.wh === dock ? '#2563eb' : '#cbd5e0'; g.lineWidth = sl.wh === dock ? 2.5 : 1;
      g.beginPath(); g.roundRect ? g.roundRect(x, y0, CW, CH, 8) : g.rect(x, y0, CW, CH); g.fill(); g.stroke();
      g.fillStyle = '#1a202c'; g.font = 'bold 12px -apple-system,Inter,Arial,sans-serif';
      g.fillText(sl.label + (sl.wh === dock ? '  (dock)' : ''), x + 8, y0 + 17);
      [...sl.levels].reverse().forEach((lv, i) => {
        const ly = y0 + 26 + i * 18;
        const col = levelColorCss(lv, sl) || '#e2e8f0';
        g.fillStyle = col; g.fillRect(x + 8, ly, 10, 12);
        g.fillStyle = '#4a5568'; g.font = '10px -apple-system,Inter,Arial,sans-serif';
        g.fillText(lv.label.split('/').pop().slice(0, 10), x + 24, ly + 10);
        const q = (lv.uoms || []).reduce((s, u) => s + (u.qty || 0), 0);
        g.textAlign = 'right';
        g.fillText(q ? fmtK(q) + ((lv.uoms || []).some(u => u.cap > 0) ? ` · ${lvFill(lv)}%` : '') : '—', x + CW - 8, ly + 10);
        g.textAlign = 'left';
      });
    });

    let lx = PAD; const ly = H - 34;
    g.font = '11px -apple-system,Inter,Arial,sans-serif';
    legendItems().forEach(l => {
      g.fillStyle = l.color; g.fillRect(lx, ly, 12, 12);
      g.strokeStyle = '#cbd5e0'; g.strokeRect(lx, ly, 12, 12);
      g.fillStyle = '#4a5568'; g.fillText(l.label, lx + 17, ly + 10);
      lx += 26 + g.measureText(l.label).width;
    });
    return { canvas: c, W, H };
  }

  /* Floor zone on the plan: a hatched area spanning its grid cells, with fill and quantity. */
  function drawZone(g, sl, x, y0, rowY, CW, CH, GAPX, dock) {
    const w = Math.max(1, sl.w || 1), d = Math.max(1, sl.d || 1);
    const lastRow = sl.row + d - 1;
    const W = w * CW + (w - 1) * GAPX;
    const H = (rowY[lastRow] !== undefined ? rowY[lastRow] : y0 + (d - 1) * (CH + 16)) + CH - y0;
    const lv = sl.levels[0];
    const col = levelColorCss(lv, sl) || '#e2e8f0';
    g.save();
    g.fillStyle = '#fffbeb'; g.fillRect(x, y0, W, H);
    g.beginPath(); g.rect(x, y0, W, H); g.clip();
    g.strokeStyle = col; g.globalAlpha = .55; g.lineWidth = 6;
    for (let k = -H; k < W; k += 16) { g.beginPath(); g.moveTo(x + k, y0 + H); g.lineTo(x + k + H, y0); g.stroke(); }
    g.restore();
    g.setLineDash([6, 4]); g.strokeStyle = sl.wh === dock ? '#2563eb' : '#d97706'; g.lineWidth = sl.wh === dock ? 2.5 : 1.5;
    g.strokeRect(x, y0, W, H); g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,.88)'; g.fillRect(x + 4, y0 + 4, Math.min(W - 8, 150), Math.min(H - 8, 48));
    g.fillStyle = '#1a202c'; g.font = 'bold 12px -apple-system,Inter,Arial,sans-serif';
    g.fillText(sl.label + (sl.wh === dock ? '  (dock)' : ''), x + 8, y0 + 17);
    g.font = '10px -apple-system,Inter,Arial,sans-serif'; g.fillStyle = '#92400e';
    g.fillText('Floor storage', x + 8, y0 + 31);
    const q = (lv.uoms || []).reduce((s, u) => s + (u.qty || 0), 0);
    g.fillStyle = '#4a5568';
    g.fillText(q ? fmtK(q) + ((lv.uoms || []).some(u => u.cap > 0) ? ` · ${lvFill(lv)}%` : '') : 'Empty', x + 8, y0 + 45);
  }

  function loadJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = JSPDF;
      s.onload = () => (window.jspdf && window.jspdf.jsPDF) ? res(window.jspdf.jsPDF) : rej(new Error('PDF library missing'));
      s.onerror = () => rej(new Error('Could not load the PDF library'));
      document.head.appendChild(s);
    });
  }

  /* Without the PDF library (offline, blocked CDN): open the image in a print window. */
  function printFallback(dataUrl, title) {
    const w = window.open('', '_blank');
    if (!w) { download(dataUrl, fileBase() + '_floor-plan.png'); return; }
    w.document.write(`<!doctype html><title>${title.replace(/</g, '&lt;')}</title>
      <style>@page{size:landscape;margin:10mm}body{margin:0}img{width:100%}</style>
      <img src="${dataUrl}" onload="setTimeout(()=>print(),200)">`);
    w.document.close();
  }

  async function run(kind) {
    state.busy = kind;
    try {
      if (kind === '3d') {
        download(engine.screenshot(), fileBase() + '_3d.png');
      } else if (kind === 'png') {
        download(drawPlan().canvas.toDataURL('image/png'), fileBase() + '_floor-plan.png');
      } else if (kind === 'pdf') {
        const { canvas, W, H } = drawPlan();
        // JPEG on the white background: jsPDF stores PNGs uncompressed (~10 MB), JPEG is a few hundred KB.
        const url = canvas.toDataURL('image/jpeg', 0.92);
        try {
          const JsPDF = await loadJsPDF();
          const landscape = W >= H;
          const doc = new JsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
          const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), m = 24;
          const k = Math.min((pw - 2 * m) / W, (ph - 2 * m) / H);
          doc.addImage(url, 'JPEG', m, m, W * k, H * k);
          doc.save(fileBase() + '_floor-plan.pdf');
        } catch (e) {
          printFallback(url, (store.curGrp && store.curGrp.name) || 'Floor plan');
        }
      } else if (kind === 'csv') {
        const metricCol = hooks.tooltipLines && !store.replayDate;
        const head = ['Floor', 'Slot', 'Level', 'Warehouse', 'UOM', 'Quantity', 'Capacity', 'Fill %'];
        if (metricCol) head.push(modeName());
        const lines = [head];
        store.slots.forEach(sl => sl.levels.forEach(lv => {
          const extra = metricCol ? [(hooks.tooltipLines(lv, sl) || []).join(' ')] : [];
          const us = (lv.uoms || []).length ? lv.uoms : [{ u: '', qty: 0, cap: 0 }];
          us.forEach(u => lines.push([store.curGrp.name, sl.label, lv.label, lv.wh, u.u, u.qty, u.cap || '',
            (lv.uoms || []).some(x => x.cap > 0) ? lvFill(lv) : '', ...extra]));
        }));
        const esc = v => { const s = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const csv = '﻿' + lines.map(r => r.map(esc).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        download(url, fileBase() + '_bins.csv');
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      ui.closePanel('export');
    } catch (e) {
      core.alert('Export failed: ' + e.message, 'red');
    } finally { state.busy = ''; }
  }

  const ExportMenu = defineComponent({
    name: 'WtfExportMenu',
    setup() { return { state, store, ui, run, left: () => ui.popLeft('wt-tool-export', 250) }; },
    template: `
      <div v-if="ui.state.panel==='export'" class="wtf-pop" :style="{left:left()+'px'}" role="menu" aria-label="Export">
        <button class="wtf-exp-opt" role="menuitem" :disabled="store.curView!=='3d' || !!state.busy" @click="run('3d')">
          <span class="wtf-exp-ico">🖼</span><span><div class="wtf-exp-t">3D view (PNG)</div><div class="wtf-exp-d">{{store.curView==='3d' ? 'Exactly what is on screen now' : 'Switch to 3D first'}}</div></span></button>
        <button class="wtf-exp-opt" role="menuitem" :disabled="!!state.busy" @click="run('png')">
          <span class="wtf-exp-ico">🗺</span><span><div class="wtf-exp-t">Floor plan (PNG)</div><div class="wtf-exp-d">Top-down grid in the current colours</div></span></button>
        <button class="wtf-exp-opt" role="menuitem" :disabled="!!state.busy" @click="run('pdf')">
          <span class="wtf-exp-ico">📄</span><span><div class="wtf-exp-t">Floor plan (PDF)</div><div class="wtf-exp-d">A4, ready to print or email</div></span></button>
        <button class="wtf-exp-opt" role="menuitem" :disabled="!!state.busy" @click="run('csv')">
          <span class="wtf-exp-ico">📊</span><span><div class="wtf-exp-t">Bin list (CSV)</div><div class="wtf-exp-d">Every bin with quantity, capacity and fill</div></span></button>
        <div v-if="state.busy" class="wtf-muted" style="padding:4px 8px"><span class="wtf-spin"></span> Preparing…</div>
      </div>`,
  });
  ext.overlays.push(ExportMenu);

  ext.tools.push({
    id: 'export', icon: '⤓', label: 'Export', title: 'Export image, PDF or CSV',
    active: () => ui.state.panel === 'export',
    onClick: () => ui.togglePanel('export'),
  });

  core.exporter = { drawPlan, run };
});

})();
