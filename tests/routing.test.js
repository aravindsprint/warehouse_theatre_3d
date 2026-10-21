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

// Zones: same grid maths, with ox/cols like engine.layout and zone footprints.
function makeZoneFloor(cells, cols, rows) {
  const SW = 2.2, SD = 2.2, GAP = 0.6;
  const ox = -(cols * (SW + GAP) - GAP) / 2;
  const oz = -(rows * (SD + GAP) - GAP) / 2;
  const layout = { SW, SD, GAP, ox, cols };
  const slotPos = {};
  cells.forEach(([wh, r, c, kind, w = 1, d = 1]) => {
    const width = w * (SW + GAP) - GAP, depth = d * (SD + GAP) - GAP;
    slotPos[wh] = { x: ox + c * (SW + GAP) + width / 2, z: oz + r * (SD + GAP) + depth / 2, row: r, col: c,
      kind, halfW: width / 2, halfD: depth / 2 };
  });
  return { layout, slotPos };
}

test('floor zones: gaps between piles are walkways even when narrow', () => {
  const { layout, slotPos } = makeZoneFloor([['Z1', 0, 0, 'zone'], ['Z2', 1, 0, 'zone']], 1, 2);
  const f = R.buildFloor(layout, slotPos);
  assert.equal(f.lanes.length, 3);                 // front, between the piles, back
  assert.deepEqual(f.accessBySlot.Z1, [0, 1]);
});

test('floor zones: people cut through the gap between piles instead of going round the ends', () => {
  // 2 rows x 5 columns of single-cell zones; walk from lane 0 to lane 2 at the middle column
  const cells = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) cells.push([`Z${r}${c}`, r, c, 'zone']);
  const { layout, slotPos } = makeZoneFloor(cells, 5, 2);
  const f = R.buildFloor(layout, slotPos);
  const x = slotPos.Z02.x;
  const dz = Math.abs(f.lanes[0].z - f.lanes[2].z);
  const viaGap = R.legDist(f, x, 0, x, 2);
  assert.ok(viaGap < dz + 3, `expected a short cut, got ${viaGap}`);
  assert.ok(viaGap < Math.abs(x - f.xL) * 2 + dz, 'should beat walking round the end');
});

test('mixed floor: a rack row still blocks crossing along its length', () => {
  // row 0: racks across all 5 columns; row 1: zones
  const cells = [];
  for (let c = 0; c < 5; c++) cells.push([`R${c}`, 0, c, 'rack'], [`Z${c}`, 1, c, 'zone']);
  const { layout, slotPos } = makeZoneFloor(cells, 5, 2);
  const f = R.buildFloor(layout, slotPos);
  const front = 0, between = 1;
  assert.deepEqual(f.cross[front][between], [f.xL, f.xR]);   // only round the rack row's ends
  assert.ok(f.cross[between][2].length > 2);                  // between the zones you can cut through
});

test('a zone spanning two rows merges them into one block', () => {
  const { layout, slotPos } = makeZoneFloor([['BIG', 0, 0, 'zone', 2, 2], ['Z', 0, 2, 'zone'], ['Z2', 1, 2, 'zone']], 3, 2);
  const f = R.buildFloor(layout, slotPos);
  assert.equal(f.strips.length, 1);
  const r = R.compare(f, null, [{ s: 'BIG' }, { s: 'Z2' }, { s: 'Z' }], x => x.s);
  assert.ok(r.optimized.distance <= r.current.distance + 1e-9 && r.stops === 3);
});

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
