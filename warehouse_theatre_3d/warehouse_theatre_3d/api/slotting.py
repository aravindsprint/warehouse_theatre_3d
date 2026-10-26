"""Slotting advice: put the items picked most often where they are quickest to reach.

Items on a floor are ranked by how often they were picked (Pick List lines over the
period): A items make up the first 80% of picks, B the next 15%, C the rest. Each
location's cost is its walking distance from the dock plus a penalty for higher
shelves, the same model putaway uses (api/operations.py). An A item in a location in
the costlier half is moved to the cheapest location that is empty, or swapped with a
C item sitting in one. The estimate is the round trip saved per pick, times picks.
"""

import frappe
from frappe import _
from frappe.utils import add_days, nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api.offline import replay_safe
from warehouse_theatre_3d.warehouse_theatre_3d.api import access
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import _flt, _int, _require_view_permission, get_floor_bins, parse_json
from warehouse_theatre_3d.warehouse_theatre_3d.api.operations import (
	COL_STEP,
	LEVEL_COST,
	ROW_STEP,
	_build_transfer,
	_doc_url,
	_dock_position,
)

A_SHARE, B_SHARE = 80, 95
MAX_MOVES = 25


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def abc_classes(picks):
	"""{item: "A" | "B" | "C"} by cumulative share of picks. picks: {item: count}."""
	total = sum(v for v in picks.values() if v > 0)
	out, running = {}, 0
	for item, n in sorted(picks.items(), key=lambda x: (-x[1], x[0])):
		if n <= 0 or not total:
			out[item] = "C"
			continue
		before = 100 * running / total
		out[item] = "A" if before < A_SHARE else "B" if before < B_SHARE else "C"
		running += n
	return out


def location_cost(b, dock):
	"""Metres from the dock plus the reach penalty for higher shelves."""
	return round(abs(_int(b["row"]) - dock[0]) * ROW_STEP + abs(_int(b["col"]) - dock[1]) * COL_STEP
	             + _int(b.get("level")) * LEVEL_COST, 2)


def suggest_moves(bins, stock, picks, dock, limit=MAX_MOVES):
	"""Moves that bring fast movers closer.

	bins: [{"wh", "row", "col", "level", ...}]; stock: {wh: {item: qty}};
	picks: {item: count}. Returns [{"item_code", "from", "to", "qty", "swap", "picks",
	"saving"}] best first; saving is metres walked less over the period.
	"""
	if not bins:
		return []
	cost = {b["wh"]: location_cost(b, dock) for b in bins}
	classes = abc_classes(picks)
	ordered = sorted(bins, key=lambda b: cost[b["wh"]])
	median = cost[ordered[len(ordered) // 2]["wh"]]
	home = {}   # each item's main location: where most of it is
	for wh, items in stock.items():
		for item, qty in items.items():
			if qty > 0 and (item not in home or qty > stock[home[item]][item]):
				home[item] = wh
	used = set()
	movers = sorted((i for i, c in classes.items() if c == "A" and i in home and cost.get(home[i], 0) > median),
	                key=lambda i: -picks.get(i, 0))
	out = []
	for item in movers:
		src = home[item]
		best = None
		for b in ordered:
			wh = b["wh"]
			if cost[wh] >= cost[src] or wh in used or wh == src:
				continue
			held = {i for i, q in (stock.get(wh) or {}).items() if q > 0}
			if not held:
				best = (wh, None)
				break
			if len(held) == 1 and classes.get(next(iter(held))) == "C":
				best = (wh, next(iter(held)))
				break
		if not best:
			continue
		to, swap = best
		used.update({to, src})
		saving = round(2 * (cost[src] - cost[to]) * picks.get(item, 0), 1)
		out.append({"item_code": item, "from": src, "to": to, "qty": stock[src][item], "swap": swap,
		            "swap_qty": (stock.get(to) or {}).get(swap) if swap else None,
		            "picks": picks.get(item, 0), "saving": saving,
		            "from_cost": cost[src], "to_cost": cost[to]})
	out.sort(key=lambda m: -m["saving"])
	return out[:limit]


# ─────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_slotting(floor: str, days: int = 90):
	"""ABC classes and suggested moves for one floor."""
	_require_view_permission()
	access.require_floor(floor)
	days = max(7, min(_int(days) or 90, 365))
	bins = [dict(b) for b in access.keep(get_floor_bins(floor), access.allowed_warehouses(), "wh")]
	whs = [b["wh"] for b in bins]
	if not whs:
		return {"floor": floor, "days": days, "items": [], "moves": [], "summary": {}}
	picks = {r.item_code: _int(r.n) for r in frappe.db.sql(
		"""
		SELECT pli.item_code, COUNT(*) AS n
		FROM `tabPick List Item` pli INNER JOIN `tabPick List` pl ON pl.name = pli.parent
		WHERE pl.docstatus < 2 AND pl.creation >= %(from)s AND pli.warehouse IN %(whs)s
		GROUP BY pli.item_code
		""", {"from": add_days(nowdate(), -days), "whs": tuple(whs)}, as_dict=True)}
	stock = {}
	names = {}
	for r in frappe.db.sql(
		"""
		SELECT b.warehouse, b.item_code, b.actual_qty, i.item_name, i.stock_uom
		FROM `tabBin` b INNER JOIN `tabItem` i ON i.name = b.item_code
		WHERE b.warehouse IN %(whs)s AND b.actual_qty > 0
		""", {"whs": tuple(whs)}, as_dict=True):
		stock.setdefault(r.warehouse, {})[r.item_code] = _flt(r.actual_qty)
		names[r.item_code] = (r.item_name, r.stock_uom)
	for item in picks:
		names.setdefault(item, (frappe.db.get_value("Item", item, "item_name"), frappe.db.get_value("Item", item, "stock_uom")))
	dock, dock_slot = _dock_position(floor, bins)
	moves = suggest_moves(bins, stock, picks, dock)
	classes = abc_classes(picks)
	label = {b["wh"]: (b["slot_label"] + (" › " + b["label"] if b["label"] and b["label"] != "Floor stack" else "")) for b in bins}
	cost = {b["wh"]: location_cost(b, dock) for b in bins}
	for m in moves:
		m.update(item_name=names.get(m["item_code"], (None, None))[0], uom=names.get(m["item_code"], (None, None))[1],
		         from_label=label.get(m["from"]), to_label=label.get(m["to"]),
		         swap_name=names.get(m["swap"], (None, None))[0] if m["swap"] else None)
	items = []
	for item, n in sorted(picks.items(), key=lambda x: -x[1])[:100]:
		locs = [wh for wh, its in stock.items() if its.get(item)]
		items.append({"item_code": item, "item_name": names.get(item, (None,))[0], "picks": n, "class": classes.get(item, "C"),
		              "locations": [label.get(wh, wh) for wh in sorted(locs, key=lambda w: cost.get(w, 0))][:3],
		              "best_cost": min((cost[w] for w in locs if w in cost), default=None)})
	total = sum(picks.values())
	summary = {k: {"items": sum(1 for c in classes.values() if c == k),
	               "picks": sum(n for i, n in picks.items() if classes.get(i) == k)} for k in "ABC"}
	return {"floor": floor, "days": days, "dock_slot": dock_slot, "total_picks": total, "summary": summary,
	        "saving": round(sum(m["saving"] for m in moves)), "moves": moves, "items": items}


@frappe.whitelist(allow_guest=False, methods=["POST"])
@replay_safe
def create_moves(moves: str | list):
	"""One draft Material Transfer for the chosen moves (both directions for a swap)."""
	_require_view_permission()
	moves = parse_json(moves, []) or []
	rows = []
	for m in moves:
		access.require(m.get("from"))
		access.require(m.get("to"))
		rows.append({"item_code": m["item_code"], "qty": _flt(m["qty"]), "s_warehouse": m["from"], "t_warehouse": m["to"]})
		if m.get("swap") and _flt(m.get("swap_qty")) > 0:
			rows.append({"item_code": m["swap"], "qty": _flt(m["swap_qty"]), "s_warehouse": m["to"], "t_warehouse": m["from"]})
	if not rows:
		frappe.throw(_("Choose at least one move."))
	se, _tracked = _build_transfer(rows, remarks=_("Re-slotting from Warehouse Theatre"))
	se.insert()
	return {"name": se.name, "rows": len(se.items), "url": _doc_url("Stock Entry", se.name)}
