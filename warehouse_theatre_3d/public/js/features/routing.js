/* Warehouse Theatre 3D — pick-route geometry (pure functions, no DOM or Three.js).
   Used by routes.js; also loadable in Node for tests: require('./routing.js').

   Model: racks sit in rows along X. People walk along aisles ("lanes") that run
   between rows, and switch lanes only via the cross-aisles at the two ends of the
   rows. A gap narrower than MIN_AISLE between two rows is treated as back-to-back
   racking with no walkway, unless the floor has no wider gaps at all.
   Units are scene units, which match metres closely (a rack bay is 2.2 wide). */
(function (root) {
'use strict';

const MIN_AISLE = 1.0;   // narrowest gap someone can walk down
const EDGE = 0.9;        // perimeter aisle offset from the outer racks
const WALK_SPEED = 1.2;  // m/s
const PICK_SECONDS = 20; // per stop, identical for both routes so savings are pure walking

function buildFloor(layout, slotPos) {
  const pos = Object.entries(slotPos).map(([wh, p]) => Object.assign({ wh }, p));
  if (!pos.length) return null;
  const bands = {};
  pos.forEach(p => {
    const z0 = p.z - layout.SD / 2, z1 = p.z + layout.SD / 2;
    const b = bands[p.row];
    bands[p.row] = b ? [Math.min(b[0], z0), Math.max(b[1], z1)] : [z0, z1];
  });
  const rows = Object.keys(bands).map(Number).sort((a, b) => bands[a][0] - bands[b][0]);
  const xs = pos.map(p => p.x);
  const xL = Math.min(...xs) - layout.SW / 2 - EDGE;
  const xR = Math.max(...xs) + layout.SW / 2 + EDGE;

  const gaps = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const g0 = bands[rows[i]][1], g1 = bands[rows[i + 1]][0];
    gaps.push({ z: (g0 + g1) / 2, width: g1 - g0, between: [rows[i], rows[i + 1]] });
  }
  const wide = gaps.filter(g => g.width >= MIN_AISLE);
  const walk = wide.length ? wide : gaps;
  const lanes = [
    { z: bands[rows[0]][0] - EDGE, kind: 'front', between: [null, rows[0]] },
    ...walk.map(g => ({ z: g.z, kind: 'aisle', between: g.between })),
    { z: bands[rows[rows.length - 1]][1] + EDGE, kind: 'back', between: [rows[rows.length - 1], null] },
  ].sort((a, b) => a.z - b.z);

  // Lanes a row's pick face opens onto: the nearest lane on each side, provided no
  // other rack row stands between the row and that lane.
  const access = {};
  rows.forEach(r => {
    const [z0, z1] = bands[r];
    const blocked = (za, zb) => rows.some(o => o !== r && bands[o][0] >= za - 1e-6 && bands[o][1] <= zb + 1e-6);
    const opts = [];
    let above = -1, below = -1;
    lanes.forEach((l, i) => { if (l.z < z0) above = i; if (l.z > z1 && below < 0) below = i; });
    if (above >= 0 && !blocked(lanes[above].z, z0)) opts.push(above);
    if (below >= 0 && !blocked(z1, lanes[below].z)) opts.push(below);
    if (!opts.length) {
      // Fully enclosed row (rare): fall back to the nearest lane so routes still draw.
      let best = 0;
      lanes.forEach((l, i) => { if (Math.abs(l.z - (z0 + z1) / 2) < Math.abs(lanes[best].z - (z0 + z1) / 2)) best = i; });
      opts.push(best);
    }
    access[r] = opts;
  });

  return { lanes, xL, xR, bands, rows, access, slotPos };
}

/* A visit point: where to stand for a slot, with the lanes it can be picked from. */
function stopFor(floor, slotWh) {
  const p = floor.slotPos[slotWh];
  if (!p) return null;
  return { slot: slotWh, x: p.x, opts: floor.access[p.row] || [0] };
}
function dockStop(floor, dockSlot) {
  const s = dockSlot && stopFor(floor, dockSlot);
  if (s) return Object.assign(s, { dock: true });
  return { slot: null, x: floor.xL, opts: [0], dock: true };   // front-left corner
}

/* Walking distance between two points standing on lanes li and lj. */
function legDist(floor, x1, li, x2, lj) {
  if (li === lj) return Math.abs(x1 - x2);
  const dz = Math.abs(floor.lanes[li].z - floor.lanes[lj].z);
  return Math.min(Math.abs(x1 - floor.xL) + Math.abs(x2 - floor.xL),
                  Math.abs(x1 - floor.xR) + Math.abs(x2 - floor.xR)) + dz;
}
function legPath(floor, x1, li, x2, lj) {
  const z1 = floor.lanes[li].z, z2 = floor.lanes[lj].z;
  if (li === lj) return [[x2, z2]];
  const viaL = Math.abs(x1 - floor.xL) + Math.abs(x2 - floor.xL);
  const viaR = Math.abs(x1 - floor.xR) + Math.abs(x2 - floor.xR);
  const E = viaL <= viaR ? floor.xL : floor.xR;
  return [[E, z1], [E, z2], [x2, z2]];
}

/* Best lane choice for a fixed visiting order (dynamic programming over each stop's
   1-2 lane options). seq includes the dock at both ends. */
function evaluate(floor, seq) {
  const n = seq.length;
  if (!n) return { distance: 0, lanes: [], path: [] };
  const cost = seq.map(s => s.opts.map(() => Infinity));
  const from = seq.map(s => s.opts.map(() => -1));
  seq[0].opts.forEach((_, o) => { cost[0][o] = 0; });
  for (let k = 1; k < n; k++) {
    seq[k].opts.forEach((lj, o) => {
      seq[k - 1].opts.forEach((li, p) => {
        const c = cost[k - 1][p] + legDist(floor, seq[k - 1].x, li, seq[k].x, lj);
        if (c < cost[k][o]) { cost[k][o] = c; from[k][o] = p; }
      });
    });
  }
  let o = 0;
  cost[n - 1].forEach((c, i) => { if (c < cost[n - 1][o]) o = i; });
  const distance = cost[n - 1][o];
  const chosen = new Array(n);
  for (let k = n - 1; k >= 0; k--) { chosen[k] = seq[k].opts[o]; o = from[k][o]; }
  const path = [[seq[0].x, floor.lanes[chosen[0]].z]];
  for (let k = 1; k < n; k++) path.push(...legPath(floor, seq[k - 1].x, chosen[k - 1], seq[k].x, chosen[k]));
  return { distance, lanes: chosen, path };
}

function pairDist(floor, a, b) {
  let best = Infinity;
  a.opts.forEach(li => b.opts.forEach(lj => { best = Math.min(best, legDist(floor, a.x, li, b.x, lj)); }));
  return best;
}

/* Shortest visiting order found by nearest-neighbour + 2-opt, compared against an
   S-shape (aisle-by-aisle, alternating direction) order; the shorter one wins. */
function optimize(floor, dock, stops) {
  if (stops.length <= 1) return stops.slice();
  const all = [dock, ...stops];
  const D = all.map(a => all.map(b => pairDist(floor, a, b)));
  // nearest neighbour from the dock
  const left = new Set(stops.map((_, i) => i + 1));
  const order = [];
  let cur = 0;
  while (left.size) {
    let best = -1;
    left.forEach(i => { if (best < 0 || D[cur][i] < D[cur][best]) best = i; });
    order.push(best); left.delete(best); cur = best;
  }
  // 2-opt on the closed tour dock → order → dock
  const tour = [0, ...order, 0];
  const len = t => t.reduce((s, v, i) => i ? s + D[t[i - 1]][v] : 0, 0);
  let improved = true, guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 1; i < tour.length - 2; i++) {
      for (let j = i + 1; j < tour.length - 1; j++) {
        const d = D[tour[i - 1]][tour[j]] + D[tour[i]][tour[j + 1]] - D[tour[i - 1]][tour[i]] - D[tour[j]][tour[j + 1]];
        if (d < -1e-9) { tour.splice(i, j - i + 1, ...tour.slice(i, j + 1).reverse()); improved = true; }
      }
    }
  }
  const twoOpt = tour.slice(1, -1).map(i => all[i]);

  // S-shape: group by the stop's first lane, sweep lanes front to back, alternate direction
  const byLane = {};
  stops.forEach(s => { (byLane[s.opts[0]] = byLane[s.opts[0]] || []).push(s); });
  const sShape = [];
  Object.keys(byLane).map(Number).sort((a, b) => a - b).forEach((l, i) => {
    sShape.push(...byLane[l].sort((a, b) => i % 2 ? b.x - a.x : a.x - b.x));
  });

  const cost = seq => evaluate(floor, [dock, ...seq, dock]).distance;
  return cost(sShape) < cost(twoOpt) ? sShape : twoOpt;
}

/* Merge rows that share a slot into one visit (you pick them all while standing there). */
function visitsFromRows(floor, rows, keyOf) {
  const visits = [], bySlot = {};
  rows.forEach(r => {
    const slot = keyOf(r);
    if (!slot || !floor.slotPos[slot]) return;
    if (!bySlot[slot]) { bySlot[slot] = Object.assign(stopFor(floor, slot), { rows: [] }); visits.push(bySlot[slot]); }
    bySlot[slot].rows.push(r);
  });
  return visits;
}
/* Stops in the given order, one per row; consecutive rows in the same slot cost nothing. */
function stopsInOrder(floor, rows, keyOf) {
  return rows.map(r => { const s = stopFor(floor, keyOf(r)); return s ? Object.assign(s, { rows: [r] }) : null; }).filter(Boolean);
}

function seconds(distance, stops) { return distance / WALK_SPEED + stops * PICK_SECONDS; }

/* Compare the saved order with the optimised one. */
function compare(floor, dockSlot, rows, keyOf) {
  const dock = dockStop(floor, dockSlot);
  const current = stopsInOrder(floor, rows, keyOf);
  const visits = visitsFromRows(floor, rows, keyOf);
  const opt = optimize(floor, dock, visits);
  const cur = evaluate(floor, [dock, ...current, dock]);
  const best = evaluate(floor, [dock, ...opt, dock]);
  const stops = visits.length;
  return {
    dock,
    current: { order: current, distance: cur.distance, path: cur.path, seconds: seconds(cur.distance, stops) },
    optimized: { order: opt, distance: best.distance, path: best.path, seconds: seconds(best.distance, stops) },
    saving: cur.distance > 0 ? Math.max(0, 1 - best.distance / cur.distance) : 0,
    stops,
  };
}

/* How many trips pass over each 1×1 cell of walkway. */
function traffic(floor, paths, cell) {
  cell = cell || 1;
  const counts = new Map();
  paths.forEach(path => {
    const seen = new Set();
    for (let i = 1; i < path.length; i++) {
      const [x1, z1] = path[i - 1], [x2, z2] = path[i];
      const len = Math.hypot(x2 - x1, z2 - z1);
      const steps = Math.max(1, Math.ceil(len / (cell / 2)));
      for (let s = 0; s <= steps; s++) {
        const x = x1 + (x2 - x1) * s / steps, z = z1 + (z2 - z1) * s / steps;
        seen.add(Math.round(x / cell) + ',' + Math.round(z / cell));
      }
    }
    seen.forEach(k => counts.set(k, (counts.get(k) || 0) + 1));
  });
  return [...counts.entries()].map(([k, n]) => {
    const [cx, cz] = k.split(',').map(Number);
    return { x: cx * cell, z: cz * cell, n };
  });
}

/* Nearest lane to a point, for describing hotspots in words. */
function laneAt(floor, z) {
  let best = 0;
  floor.lanes.forEach((l, i) => { if (Math.abs(l.z - z) < Math.abs(floor.lanes[best].z - z)) best = i; });
  return floor.lanes[best];
}

const api = { MIN_AISLE, WALK_SPEED, PICK_SECONDS, buildFloor, stopFor, dockStop, legDist, evaluate, optimize,
  visitsFromRows, stopsInOrder, compare, traffic, laneAt, seconds };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.WT3DRouting = api;

})(typeof window !== 'undefined' ? window : globalThis);
