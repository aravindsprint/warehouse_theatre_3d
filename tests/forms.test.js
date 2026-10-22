/* Tests for public/js/wt3d_forms.js against a minimal stand-in for Frappe's form API.
   Run: node --test tests/forms.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../warehouse_theatre_3d/public/js/wt3d_forms.js'), 'utf8');

function load(roles = ['Stock User']) {
  const handlers = {};
  const opened = [];
  const calls = [];
  const ctx = {
    __: (s, args) => (args ? s.replace(/\{(\d+)\}/g, (m, i) => args[i]) : s),
    format_number: n => String(n),
    URLSearchParams,
    $: () => ({ find: () => ({ on: () => {} }) }),
    frappe: {
      user: { has_role: r => roles.includes(r) },
      utils: { escape_html: s => String(s).replace(/</g, '&lt;') },
      ui: { form: { on: (dt, h) => { (handlers[dt] = handlers[dt] || []).push(h); } } },
      call: o => calls.push(o),
    },
  };
  ctx.window = ctx;
  ctx.window.open = (url) => opened.push(url);
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(SRC, ctx);   // a second doctype_js load must not double-register
  return { ctx, handlers, opened, calls };
}

function form(doctype, doc, isNew = false) {
  const buttons = [];
  const sections = [];
  return {
    doctype, doc, buttons, sections,
    is_new: () => isNew,
    add_custom_button: (label, fn, group) => buttons.push({ label, fn, group }),
    dashboard: {
      wrapper: { find: () => ({ closest: () => ({ remove: () => {} }) }) },
      add_section: (html, title) => { sections.push({ html, title }); return {}; },
    },
  };
}

function refresh(env, frm) { (env.handlers[frm.doctype] || []).forEach(h => h.refresh && h.refresh(frm)); }

test('registers once even when the script is loaded for several doctypes', () => {
  const env = load();
  assert.equal(env.handlers['Stock Entry'].length, 1);
  assert.equal(env.handlers.Item.length, 1);
});

test('draft Stock Entry: map button only; submitted: putaway too', () => {
  const env = load();
  const draft = form('Stock Entry', { name: 'STE-1', docstatus: 0 });
  refresh(env, draft);
  assert.deepEqual(draft.buttons.map(b => b.label), ['Show on warehouse map']);
  draft.buttons[0].fn();
  assert.equal(env.opened[0], '/warehouse-theatre-3d?doc=Stock+Entry&name=STE-1');
  const sub = form('Stock Entry', { name: 'STE-2', docstatus: 1 });
  refresh(env, sub);
  assert.deepEqual(sub.buttons.map(b => b.label), ['Show on warehouse map', 'Suggest putaway bins']);
  sub.buttons[1].fn();
  assert.equal(env.opened[1], '/warehouse-theatre-3d?putaway=Stock+Entry&name=STE-2');
});

test('Pick List gets the route button', () => {
  const env = load();
  const f = form('Pick List', { name: 'PICK-1', docstatus: 0 });
  refresh(env, f);
  const route = f.buttons.find(b => b.label === 'Optimise pick route');
  route.fn();
  assert.equal(env.opened[0], '/warehouse-theatre-3d?route=PICK-1');
});

test('invoices only when they update stock; new documents never', () => {
  const env = load();
  const noStock = form('Sales Invoice', { name: 'SI-1', docstatus: 1, update_stock: 0 });
  refresh(env, noStock);
  assert.equal(noStock.buttons.length, 0);
  const withStock = form('Sales Invoice', { name: 'SI-2', docstatus: 1, update_stock: 1 });
  refresh(env, withStock);
  assert.equal(withStock.buttons.length, 1);
  const fresh = form('Stock Entry', { name: 'new-stock-entry-1', docstatus: 0 }, true);
  refresh(env, fresh);
  assert.equal(fresh.buttons.length, 0);
});

test('users without a stock role see nothing', () => {
  const env = load(['Accounts User']);
  const f = form('Item', { name: 'FAB-005', is_stock_item: 1 });
  refresh(env, f);
  assert.equal(f.buttons.length, 0);
  assert.equal(env.calls.length, 0);
});

test('Item: button, and a locations panel with mapped places and other warehouses', () => {
  const env = load();
  const f = form('Item', { name: 'FAB-005', is_stock_item: 1 });
  refresh(env, f);
  assert.deepEqual(f.buttons.map(b => b.label), ['Show on warehouse map']);
  assert.equal(env.calls[0].method, 'warehouse_theatre_3d.warehouse_theatre_3d.api.links.get_item_locations');
  env.calls[0].callback({ message: [
    { warehouse: 'A3-L1 - PD', qty: 495, reserved: 0, uom: 'Kg', mapped: true, floor_label: 'Ground Floor', slot_label: 'A3', label: 'L1' },
    { warehouse: 'Stores - PD', warehouse_label: 'Stores', qty: 12, reserved: 2, uom: 'Kg', mapped: false },
  ] });
  assert.equal(f.sections.length, 1);
  const html = f.sections[0].html;
  assert.match(html, /Ground Floor › A3 › L1/);
  assert.match(html, /Stores <span class="text-muted small">\(not on the map\)/);
  assert.equal((html.match(/wt3d-loc-open/g) || []).length, 1);   // "View" only for mapped rows
});

test('non-stock Items and unmapped Warehouses get no button', () => {
  const env = load();
  const svc = form('Item', { name: 'SERVICE', is_stock_item: 0 });
  refresh(env, svc);
  assert.equal(svc.buttons.length, 0);
  const wh = form('Warehouse', { name: 'Stores - PD', wt_warehouse_type: '' });
  refresh(env, wh);
  assert.equal(wh.buttons.length, 0);
  const bin = form('Warehouse', { name: 'A3-L1 - PD', wt_warehouse_type: 'Bin' });
  refresh(env, bin);
  bin.buttons[0].fn();
  assert.equal(env.opened[0], '/warehouse-theatre-3d?focus=A3-L1+-+PD');
});
