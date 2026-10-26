"""Replenishment and first-expiry-first-out (FEFO) picking.

Replenishment: each Warehouse Pick Face sets refill levels for one item at one pick
location. A face is due when what's on the shelf, less what draft Pick Lists will take
from it, is at or below its "refill at" level; the refill brings it back up to "fill up
to", taking stock from other locations of the same company: same floor first, then
the batch that expires first, then the location holding the most. Moves are posted as
a Material Transfer with the user's own ERPNext permissions.

FEFO: for batch items, which batches are on a shelf and when each expires, so the
scanner can point pickers at the batch that expires first.
"""

from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api import access
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import (
	_flt,
	_int,
	_require_view_permission,
	get_floor_bins,
	parse_json,
)
from warehouse_theatre_3d.warehouse_theatre_3d.api.links import resolve_locations
from warehouse_theatre_3d.warehouse_theatre_3d.api.operations import _build_transfer, _doc_url
from warehouse_theatre_3d.warehouse_theatre_3d.api.scan import place_path

EPS = 1e-9


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def refill_needs(faces, on_hand, pending):
	"""Pick faces due for a refill, most urgent first.

	faces: [{"name", "item_code", "warehouse", "min_qty", "max_qty"}]
	on_hand / pending: {(item_code, warehouse): qty}; pending is what draft Pick Lists
	will still take from the face. Urgent: draft picks already need more than is there.
	"""
	out = []
	for f in faces:
		key = (f["item_code"], f["warehouse"])
		have, owed = _flt(on_hand.get(key)), _flt(pending.get(key))
		available = have - owed
		if available > _flt(f["min_qty"]) + EPS:
			continue
		need = round(_flt(f["max_qty"]) - available, 6)
		if need <= EPS:
			continue
		out.append(dict(f, on_hand=have, pending=owed, available=round(available, 6), need=need,
		                urgent=available < -EPS or (have <= EPS and owed > EPS),
		                fill=round(100 * max(0.0, have) / _flt(f["max_qty"])) if _flt(f["max_qty"]) else 0))
	out.sort(key=lambda r: (not r["urgent"], r["fill"], -r["need"]))
	return out


def allocate_sources(need, sources, floor=None):
	"""Take `need` from source locations: same floor first, then earliest expiry (no
	expiry last), then the location holding the most. sources: [{"warehouse", "qty",
	"floor", "expiry"}]. Returns (picks [{"warehouse", "qty", ...}], short)."""
	def rank(s):
		exp = s.get("expiry")
		return (0 if floor and s.get("floor") == floor else 1, 0 if exp else 1, str(exp or ""), -_flt(s.get("qty")))
	left = _flt(need)
	picks = []
	for s in sorted(sources, key=rank):
		if left <= EPS:
			break
		take = min(left, _flt(s.get("qty")))
		if take <= EPS:
			continue
		picks.append(dict(s, qty=round(take, 6)))
		left -= take
	return picks, round(max(0.0, left), 6)


def fefo_order(batches):
	"""Batches with stock, expiring first (no expiry date last)."""
	live = [b for b in batches if _flt(b.get("qty")) > EPS]
	return sorted(live, key=lambda b: (b.get("expiry") is None, str(b.get("expiry") or ""), b.get("batch_no") or ""))


def fefo_advice(scanned, batches):
	"""None when the scanned batch is fine to pick; else the batch to pick first:
	{"batch_no", "expiry", "scanned_expiry"}. A batch with no expiry never beats one with."""
	order = fefo_order(batches)
	if not order or not scanned:
		return None
	mine = next((b for b in order if b.get("batch_no") == scanned), None)
	first = order[0]
	if first.get("batch_no") == scanned or first.get("expiry") is None:
		return None
	mine_exp = mine.get("expiry") if mine else None
	if mine_exp is not None and str(mine_exp) <= str(first["expiry"]):
		return None
	return {"batch_no": first["batch_no"], "expiry": str(first["expiry"]), "scanned_expiry": str(mine_exp) if mine_exp else None}


# ─────────────────────────────────────────────────────────────
# Stock queries
# ─────────────────────────────────────────────────────────────

def batch_balances(item_codes, warehouses):
	"""{(item_code, warehouse): [{"batch_no", "qty", "expiry"}]} for batches with stock."""
	items, whs = tuple(sorted({i for i in item_codes if i})), tuple(sorted({w for w in warehouses if w}))
	if not items or not whs:
		return {}
	sums = defaultdict(float)
	queries = [
		# v15+: Serial and Batch Bundles
		"""
		SELECT sbe.batch_no, sbb.item_code, sbb.warehouse, SUM(sbe.qty) AS qty
		FROM `tabSerial and Batch Entry` sbe
		INNER JOIN `tabSerial and Batch Bundle` sbb ON sbb.name = sbe.parent
		WHERE sbb.docstatus = 1 AND sbb.is_cancelled = 0 AND IFNULL(sbe.batch_no, '') != ''
		  AND sbb.item_code IN %(items)s AND sbb.warehouse IN %(whs)s
		GROUP BY sbe.batch_no, sbb.item_code, sbb.warehouse
		""",
		# ledger rows that carry the batch themselves
		"""
		SELECT batch_no, item_code, warehouse, SUM(actual_qty) AS qty
		FROM `tabStock Ledger Entry`
		WHERE is_cancelled = 0 AND IFNULL(batch_no, '') != '' AND IFNULL(serial_and_batch_bundle, '') = ''
		  AND item_code IN %(items)s AND warehouse IN %(whs)s
		GROUP BY batch_no, item_code, warehouse
		""",
	]
	for q in queries:
		try:
			for r in frappe.db.sql(q, {"items": items, "whs": whs}, as_dict=True):
				sums[(r.item_code, r.warehouse, r.batch_no)] += _flt(r.qty)
		except Exception:
			pass   # table or column missing on this ERPNext version
	live = {k: v for k, v in sums.items() if v > EPS}
	if not live:
		return {}
	expiry = {r.name: r.expiry_date for r in frappe.get_all(
		"Batch", filters={"name": ["in", list({k[2] for k in live})]}, fields=["name", "expiry_date"])}
	out = defaultdict(list)
	for (item, wh, batch), qty in live.items():
		exp = expiry.get(batch)
		out[(item, wh)].append({"batch_no": batch, "qty": round(qty, 6), "expiry": str(exp) if exp else None})
	return {k: fefo_order(v) for k, v in out.items()}


def _faces(company, floor):
	faces = frappe.get_all(
		"Warehouse Pick Face",
		filters={"enabled": 1, **({"company": company} if company else {})},
		fields=["name", "item_code", "item_name", "warehouse", "min_qty", "max_qty", "stock_uom", "company"],
	)
	faces = access.keep(faces, access.allowed_warehouses())
	if floor:
		on_floor = {b.wh for b in get_floor_bins(floor)}
		faces = [f for f in faces if f.warehouse in on_floor]
	return faces


def _on_hand(pairs):
	if not pairs:
		return {}
	items, whs = tuple({p[0] for p in pairs}), tuple({p[1] for p in pairs})
	return {(r.item_code, r.warehouse): _flt(r.qty) for r in frappe.db.sql(
		"""
		SELECT item_code, warehouse, actual_qty AS qty FROM `tabBin`
		WHERE item_code IN %(items)s AND warehouse IN %(whs)s
		""", {"items": items, "whs": whs}, as_dict=True)}


def _pending_picks(pairs):
	"""What draft delivery Pick Lists will still take from each face."""
	if not pairs:
		return {}
	items, whs = tuple({p[0] for p in pairs}), tuple({p[1] for p in pairs})
	return {(r.item_code, r.warehouse): _flt(r.qty) for r in frappe.db.sql(
		"""
		SELECT pli.item_code, pli.warehouse,
		       SUM(GREATEST(IFNULL(pli.stock_qty, pli.qty) - IFNULL(pli.picked_qty, 0), 0)) AS qty
		FROM `tabPick List Item` pli
		INNER JOIN `tabPick List` pl ON pl.name = pli.parent
		WHERE pl.docstatus = 0 AND pli.item_code IN %(items)s AND pli.warehouse IN %(whs)s
		GROUP BY pli.item_code, pli.warehouse
		""", {"items": items, "whs": whs}, as_dict=True)}


def _sources(item_codes, companies, exclude):
	"""Stock of these items anywhere else in the same companies, that the user may see."""
	if not item_codes:
		return defaultdict(list)
	rows = frappe.db.sql(
		"""
		SELECT b.item_code, b.warehouse, b.actual_qty - IFNULL(b.reserved_qty, 0) AS qty, w.company
		FROM `tabBin` b INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
		WHERE b.item_code IN %(items)s AND b.actual_qty > 0 AND w.is_group = 0 AND w.disabled = 0
		  AND w.company IN %(cos)s
		  AND (%(wh_all)s = 1 OR b.warehouse IN %(wh_list)s)
		""",
		{"items": tuple(item_codes), "cos": tuple(companies) or ("",), **access.wh_filter()},
		as_dict=True,
	)
	out = defaultdict(list)
	for r in rows:
		if (r.item_code, r.warehouse) in exclude or _flt(r.qty) <= EPS:
			continue
		out[r.item_code].append(r)
	return out


def plan(company=None, floor=None):
	faces = _faces(company, floor)
	pairs = [(f.item_code, f.warehouse) for f in faces]
	needs = refill_needs([dict(f) for f in faces], _on_hand(pairs), _pending_picks(pairs))
	if not needs:
		return []
	src = _sources({n["item_code"] for n in needs}, {n["company"] for n in needs}, set(pairs))
	src_whs = {s.warehouse for lst in src.values() for s in lst}
	places = resolve_locations([n["warehouse"] for n in needs] + list(src_whs))
	expiry = batch_balances({n["item_code"] for n in needs}, src_whs)
	tasks = []
	for n in needs:
		face_place = places.get(n["warehouse"]) or {}
		cands = []
		for s in src.get(n["item_code"], []):
			if s.company != n["company"]:
				continue
			p = places.get(s.warehouse) or {}
			batches = expiry.get((n["item_code"], s.warehouse)) or []
			cands.append({"warehouse": s.warehouse, "qty": _flt(s.qty), "floor": p.get("floor"),
			              "floor_label": p.get("floor_label"), "path": place_path(p) if p else s.warehouse,
			              "mapped": bool(p.get("mapped")), "expiry": batches[0]["expiry"] if batches else None})
		picks, short = allocate_sources(n["need"], cands, face_place.get("floor"))
		tasks.append(dict(n, path=place_path(face_place) if face_place else n["warehouse"],
		                  floor=face_place.get("floor"), floor_label=face_place.get("floor_label"),
		                  sources=picks, short=short))
	return tasks


# ─────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_replenishment(company: str | None = None, floor: str | None = None):
	"""Pick faces due for a refill and where to take the stock from."""
	_require_view_permission()
	if floor:
		access.require_floor(floor)
	tasks = plan(company or None, floor or None)
	return {
		"as_of": nowdate(), "tasks": tasks,
		"urgent": sum(1 for t in tasks if t["urgent"]),
		"faces": frappe.db.count("Warehouse Pick Face", {"enabled": 1}),
		"can_setup": bool(frappe.has_permission("Warehouse Pick Face", "create")),
	}


@frappe.whitelist(allow_guest=False, methods=["POST"])
def create_replenishment(rows: str | list, submit: int | str = 0):
	"""One Material Transfer for the chosen refills. rows: [{"item_code", "qty",
	"s_warehouse", "t_warehouse"}]. Submitted when asked and nothing needs a batch or
	serial number; otherwise a draft to finish in ERPNext."""
	_require_view_permission()
	rows = parse_json(rows, []) or []
	for r in rows:
		access.require(r.get("s_warehouse"))
		access.require(r.get("t_warehouse"))
	se, tracked = _build_transfer(rows, remarks=_("Replenishment from Warehouse Theatre"))
	se.insert()
	submitted = False
	if _int(submit) and not tracked:
		se.submit()
		submitted = True
	return {"name": se.name, "docstatus": se.docstatus, "submitted": submitted, "needs_batch_or_serial": tracked,
	        "rows": len(se.items), "url": _doc_url("Stock Entry", se.name)}


@frappe.whitelist(allow_guest=False)
def get_fefo(item_code: str, warehouse: str):
	"""Batches of one item on one shelf, expiring first."""
	_require_view_permission()
	access.require(warehouse)
	return batch_balances([item_code], [warehouse]).get((item_code, warehouse), [])

