/* Warehouse Theatre 3D — pick-route geometry (pure functions, no DOM or Three.js).
   Used by routes.js; also loadable in Node for tests: require('./routing.js').

   Model: racks sit in rows along X and floor-storage zones occupy blocks of the grid.
   People walk along aisles ("lanes") between rows and switch lanes at the floor's two
   ends or through any gap between columns that no rack row or zone blocks. A gap
   narrower than MIN_AISLE between two rack rows is back-to-back racking with no
   walkway (unless the floor has no wider gaps); gaps next to floor zones are always
   walkable, since people walk between piles.
   Units are scene units, which match metres closely (a rack bay is 2.2 wide). */
(function (root) {
'use strict';

const MIN_AISLE = 1.0;   // narrowest gap someone can walk down
const EDGE = 0.9;        // perimeter aisle offset from the outer racks
const WALK_SPEED = 1.2;  // m/s
const PICK_SECONDS = 20; // per stop, identical for both routes so savings are pure walking

function buildFloor(layout, slotPos) {
  const pos = Object.entries(slotPos).map(([wh, p]) => Object.assign({ wh }, p, {
    halfW: p.halfW || layout.SW / 2, halfD: p.halfD || layout.SD / 2, zone: p.kind === 'zone',
  }));
  if (!pos.length) return null;

  // Strips: z-ranges occupied by racks or floor zones, merged where they overlap
  // (a zone spanning two rows joins both rows into one strip).
  const spans = pos.map(p => ({ z0: p.z - p.halfD, z1: p.z + p.halfD, p })).sort((a, b) => a.z0 - b.z0);
  const strips = [];
  spans.forEach(sp => {
    const last = strips[strips.length - 1];
    if (last && sp.z0 < last.z1 - 1e-6) { last.z1 = Math.max(last.z1, sp.z1); last.members.push(sp.p); }
    else strips.push({ z0: sp.z0, z1: sp.z1, members: [sp.p] });
  });
  strips.forEach(st => {
    const racks = st.members.filter(m => !m.zone);
    st.hasRack = racks.length > 0;
    // Bays in a rack row stand back to back, so the row blocks crossing along its whole length.
    st.rackX = st.hasRack ? [Math.min(...racks.map(m => m.x - m.halfW)), Math.max(...racks.map(m => m.x + m.halfW))] : null;
  });

  const xs0 = pos.map(p => p.x - p.halfW), xs1 = pos.map(p => p.x + p.halfW);
  const xL = Math.min(...xs0) - EDGE;
  const xR = Math.max(...xs1) + EDGE;

  // Walkways between strips: wide gaps, or any gap next to floor storage (people walk
  // between piles). Back-to-back rack rows (narrow gap, racks both sides) have none.
  const gaps = [];
  for (let i = 0; i < strips.length - 1; i++) {
    const a = strips[i], b = strips[i + 1];
    gaps.push({ z: (a.z1 + b.z0) / 2, width: b.z0 - a.z1, between: [i, i + 1], soft: !a.hasRack || !b.hasRack });
  }
  const walkable = gaps.filter(g => g.width >= MIN_AISLE || g.soft);
  const walk = walkable.length ? walkable : gaps;
  const rowOf = st => st.members[0].row;
  const lanes = [
    { z: strips[0].z0 - EDGE, kind: 'front', between: [null, rowOf(strips[0])] },
    ...walk.map(g => ({ z: g.z, kind: 'aisle', between: [rowOf(strips[g.between[0]]), rowOf(strips[g.between[1]])] })),
    { z: strips[strips.length - 1].z1 + EDGE, kind: 'back', between: [rowOf(strips[strips.length - 1]), null] },
  ].sort((a, b) => a.z - b.z);

  // Lanes each strip's goods can be picked from: the nearest lane on each side,
  // provided no other strip stands in between.
  const accessBySlot = {};
  const access = {};
  strips.forEach(st => {
    const blocked = (za, zb) => strips.some(o => o !== st && o.z0 >= za - 1e-6 && o.z1 <= zb + 1e-6);
    const opts = [];
    let above = -1, below = -1;
    lanes.forEach((l, i) => { if (l.z < st.z0) above = i; if (l.z > st.z1 && below < 0) below = i; });
    if (above >= 0 && !blocked(lanes[above].z, st.z0)) opts.push(above);
    if (below >= 0 && !blocked(st.z1, lanes[below].z)) opts.push(below);
    if (!opts.length) {
      let best = 0;
      const mid = (st.z0 + st.z1) / 2;
      lanes.forEach((l, i) => { if (Math.abs(l.z - mid) < Math.abs(lanes[best].z - mid)) best = i; });
      opts.push(best);
    }
    st.members.forEach(m => { accessBySlot[m.wh] = opts; if (access[m.row] === undefined) access[m.row] = opts; });
  });

  // Where you can switch between two lanes: the floor's two ends, plus any column gap
  // that no rack row or zone blocks between those lanes.
  const colGaps = [];
  if (layout.ox !== undefined && layout.cols > 1) {
    for (let c = 1; c < layout.cols; c++) colGaps.push(layout.ox + c * (layout.SW + layout.GAP) - layout.GAP / 2);
  }
  const blocksAt = (st, E) => (st.rackX && E >= st.rackX[0] - .05 && E <= st.rackX[1] + .05) ||
    st.members.some(m => Math.abs(E - m.x) < m.halfW + .05);
  const cross = lanes.map((li, i) => lanes.map((lj, j) => {
    if (i === j) return [];
    const za = Math.min(li.z, lj.z), zb = Math.max(li.z, lj.z);
    const between = strips.filter(st => st.z0 > za - 1e-6 && st.z1 < zb + 1e-6);
    return [xL, xR, ...colGaps.filter(E => !between.some(st => blocksAt(st, E)))];
  }));

  return { lanes, xL, xR, strips, access, accessBySlot, cross, slotPos };
}

/* A visit point: where to stand for a slot, with the lanes it can be picked from. */
function stopFor(floor, slotWh) {
  const p = floor.slotPos[slotWh];
  if (!p) return null;
  return { slot: slotWh, x: p.x, opts: floor.accessBySlot[slotWh] || [0] };
}
function dockStop(floor, dockSlot) {
  const s = dockSlot && stopFor(floor, dockSlot);
  if (s) return Object.assign(s, { dock: true });
  return { slot: null, x: floor.xL, opts: [0], dock: true };   // front-left corner
}

/* Walking distance between two points standing on lanes li and lj, crossing between
   lanes at the best open crossing point. */
function bestCross(floor, x1, li, x2, lj) {
  let best = null, bd = Infinity;
  (floor.cross[li][lj] || [floor.xL, floor.xR]).forEach(E => {
    const d = Math.abs(x1 - E) + Math.abs(x2 - E);
    if (d < bd) { bd = d; best = E; }
  });
  return { E: best, d: bd };
}
function legDist(floor, x1, li, x2, lj) {
  if (li === lj) return Math.abs(x1 - x2);
  return bestCross(floor, x1, li, x2, lj).d + Math.abs(floor.lanes[li].z - floor.lanes[lj].z);
}
function legPath(floor, x1, li, x2, lj) {
  const z1 = floor.lanes[li].z, z2 = floor.lanes[lj].z;
  if (li === lj) return [[x2, z2]];
  const E = bestCross(floor, x1, li, x2, lj).E;
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
