/* Tests for public/js/features/routing.js — run: node --test tests/routing.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../warehouse_theatre_3d/public/js/features/routing.js');

// Mirror of ThreeEngine.buildScene's grid maths.
function makeFloor(rows, cols, rowGaps = {}) {
  const SW = 2.2, SD = 2.2, GAP = 0.6;
  const layout = { SW, SD, GAP };
  const slotPos = {};
  const maxRow = Math.max(...rows);
  const rowZ = {};
  let cum = 0;
  for (let r = 0; r <= maxRow; r++) { rowZ[r] = cum; cum += SD + GAP + (rowGaps[r] || 0); }
  const ox = -(cols * (SW + GAP) - GAP) / 2, oz = -(cum - GAP) / 2;
  rows.forEach(r => {
    for (let c = 0; c < cols; c++) {
      slotPos[`R${r}C${c}`] = { x: ox + c * (SW + GAP) + SW / 2, z: oz + rowZ[r] + SD / 2, row: r, col: c };
    }
  });
  return { layout, slotPos };
}

test('rows with wide gaps get an aisle between each pair; slots open onto both sides', () => {
  const { layout, slotPos } = makeFloor([0, 1, 2], 4, { 0: 1.5, 1: 1.5 });
  const f = R.buildFloor(layout, slotPos);
  assert.equal(f.lanes.length, 4);            // front, two aisles, back
  assert.deepEqual(f.access[1].length, 2);
});

test('back-to-back rows (narrow gap) share no walkway when wider aisles exist', () => {
  // rows 0,1 back to back; wide aisle after row 1; rows 2,3 back to back
  const { layout, slotPos } = makeFloor([0, 1, 2, 3], 3, { 1: 2.0 });
  const f = R.buildFloor(layout, slotPos);
  assert.equal(f.lanes.length, 3);            // front, the one real aisle, back
  assert.deepEqual(f.access[0], [0]);         // row 0 faces the front lane only
  assert.deepEqual(f.access[1], [1]);         // row 1 faces the aisle
  assert.deepEqual(f.access[2], [1]);
  assert.deepEqual(f.access[3], [2]);
});

test('same-lane distance is straight; changing lanes goes round the row end', () => {
  const { layout, slotPos } = makeFloor([0, 1], 5, { 0: 2.0 });
  const f = R.buildFloor(layout, slotPos);
  assert.equal(R.legDist(f, 0, 1, 3, 1), 3);
  const z = Math.abs(f.lanes[0].z - f.lanes[1].z);
  const d = R.legDist(f, 0, 0, 0, 1);
  assert.ok(Math.abs(d - (2 * Math.abs(0 - f.xL) + z)) < 1e-9);
});

test('optimised route is never longer than the saved order', () => {
  const { layout, slotPos } = makeFloor([0, 1, 3, 4], 7, { 1: 1.6, 2: 0 });
  const f = R.buildFloor(layout, slotPos);
  const keys = Object.keys(slotPos);
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let t = 0; t < 30; t++) {
    const rows = Array.from({ length: 4 + Math.floor(rnd() * 12) }, (_, i) => ({ slot: keys[Math.floor(rnd() * keys.length)], i }));
    const r = R.compare(f, null, rows, x => x.slot);
    assert.ok(r.optimized.distance <= r.current.distance + 1e-9, `trial ${t}: ${r.optimized.distance} > ${r.current.distance}`);
    assert.ok(r.saving >= 0 && r.saving <= 1);
    assert.equal(r.optimized.order.length, new Set(rows.map(x => x.slot)).size);
  }
});

test('route starts and ends at the dock slot when one is set', () => {
  const { layout, slotPos } = makeFloor([0, 1], 4, { 0: 2.0 });
  const f = R.buildFloor(layout, slotPos);
  const r = R.compare(f, 'R1C3', [{ s: 'R0C0' }, { s: 'R1C1' }], x => x.s);
  const p = r.optimized.path;
  assert.equal(p[0][0], slotPos.R1C3.x);
  assert.equal(p[p.length - 1][0], slotPos.R1C3.x);
});

test('rows on other floors / unknown slots are ignored', () => {
  const { layout, slotPos } = makeFloor([0], 3);
  const f = R.buildFloor(layout, slotPos);
  const r = R.compare(f, null, [{ s: 'R0C1' }, { s: 'NOPE' }], x => x.s);
  assert.equal(r.stops, 1);
});

test('traffic counts each trip once per cell', () => {
  const { layout, slotPos } = makeFloor([0, 1], 4, { 0: 2.0 });
  const f = R.buildFloor(layout, slotPos);
  const path = [[0, 0], [3, 0]];
  const cells = R.traffic(f, [path, path, [[0, 0], [0, 0.1]]]);
  const origin = cells.find(c => c.x === 0 && c.z === 0);
  assert.equal(origin.n, 3);
  assert.equal(cells.find(c => c.x === 3 && c.z === 0).n, 2);
});
