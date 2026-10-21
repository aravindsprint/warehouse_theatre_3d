"""Actions taken from inside the theatre: material transfers, stock counts and putaway.

Documents are created with the user's own ERPNext permissions (no ignore_permissions),
and saved as drafts unless the user explicitly asks to submit a simple transfer.
"""

import copy

import frappe
from frappe.utils import nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api.common import (
	_flt,
	_int,
	_require_edit_permission,
	_require_view_permission,
	get_floor_bins,
	get_uom_capacities,
	get_uom_quantities,
	parse_json,
)

# Rough metres per grid step, matching the 3D layout (2.2 m bay + 0.6 m gap).
ROW_STEP = 2.8
COL_STEP = 2.8
LEVEL_COST = 1.5          # higher shelves are slower to reach
SAME_ITEM_BONUS = -4      # consolidate with stock of the same item
MIXED_PENALTY = 6         # bin already holds other items
PARTIAL_PENALTY = 8       # bin can take only part of the quantity
UNKNOWN_CAP_PENALTY = 5   # no capacity set for this UOM, so fit is a guess


def _doc_url(doctype, name):
	return f"/app/{frappe.scrub(doctype).replace('_', '-')}/{name}"


def _item_flags(item_code):
	item = frappe.db.get_value(
		"Item", item_code, ["name", "stock_uom", "has_batch_no", "has_serial_no", "is_stock_item"], as_dict=True
	)
	if not item:
		frappe.throw(f"Item {item_code} not found")
	return item


def _company_of(*warehouses):
	companies = {frappe.db.get_value("Warehouse", w, "company") for w in warehouses if w}
	companies.discard(None)
	if len(companies) != 1:
		frappe.throw("Both warehouses must belong to the same company.")
	return companies.pop()


@frappe.whitelist()
def get_bin_stock(warehouse):
	"""Every item in one Bin (the floor view only carries the top 20 per level),
	with batch/serial flags so the UI can say which items need finishing in desk."""
	_require_view_permission()
	if not frappe.db.exists("Warehouse", warehouse):
		frappe.throw(f"Warehouse {warehouse} not found")
	items = frappe.db.sql(
		"""
		SELECT b.item_code, i.item_name, i.stock_uom, b.actual_qty, b.reserved_qty,
		       b.valuation_rate, i.has_batch_no, i.has_serial_no
		FROM `tabBin` b INNER JOIN `tabItem` i ON i.name = b.item_code
		WHERE b.warehouse = %s AND b.actual_qty != 0
		ORDER BY b.item_code
		""",
		(warehouse,),
		as_dict=True,
	)
	return {
		"warehouse": warehouse,
		"company": frappe.db.get_value("Warehouse", warehouse, "company"),
		"items": items,
	}


# ─────────────────────────────────────────────────────────────
# Material transfer
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(methods=["POST"])
def create_material_transfer(item_code, qty, s_warehouse, t_warehouse, submit=0):
	"""Create a Material Transfer Stock Entry between two Bins.

	Saved as a draft by default. `submit=1` is honoured only for items without batch or
	serial tracking, because those need a batch/serial selection the theatre doesn't ask for.
	"""
	_require_view_permission()
	se, tracked = _build_transfer(
		[{"item_code": item_code, "qty": qty, "s_warehouse": s_warehouse, "t_warehouse": t_warehouse}]
	)
	se.insert()
	submitted = False
	if _int(submit) and not tracked:
		se.submit()
		submitted = True
	return {
		"name": se.name,
		"docstatus": se.docstatus,
		"submitted": submitted,
		"needs_batch_or_serial": tracked,
		"url": _doc_url("Stock Entry", se.name),
	}


@frappe.whitelist(methods=["POST"])
def create_putaway_transfer(rows):
	"""One draft Material Transfer covering every line of a putaway plan.

	rows: [{"item_code", "qty", "s_warehouse", "t_warehouse"}]. Always a draft, so the
	receiver can adjust quantities on the floor before submitting.
	"""
	_require_view_permission()
	rows = parse_json(rows, []) or []
	se, tracked = _build_transfer(rows, remarks="Putaway created from Warehouse Theatre 3D")
	se.insert()
	return {
		"name": se.name,
		"rows": len(se.items),
		"needs_batch_or_serial": tracked,
		"url": _doc_url("Stock Entry", se.name),
	}


def _build_transfer(rows, remarks="Created from Warehouse Theatre 3D"):
	"""Unsaved Material Transfer Stock Entry for the given rows.
	Returns (doc, any_item_is_batch_or_serial_tracked)."""
	if not rows:
		frappe.throw("Nothing to transfer.")
	companies = set()
	tracked = False
	se = frappe.new_doc("Stock Entry")
	se.stock_entry_type = "Material Transfer"
	se.purpose = "Material Transfer"
	se.remarks = remarks
	for r in rows:
		qty = _flt(r.get("qty"))
		s_wh, t_wh = r.get("s_warehouse"), r.get("t_warehouse")
		if qty <= 0:
			frappe.throw("Quantity must be greater than zero.")
		if not s_wh or not t_wh:
			frappe.throw("Every line needs a source and a target warehouse.")
		if s_wh == t_wh:
			frappe.throw("Source and target bin are the same.")
		for wh in (s_wh, t_wh):
			if not frappe.db.exists("Warehouse", wh):
				frappe.throw(f"Warehouse {wh} not found")
		companies.add(_company_of(s_wh, t_wh))
		item = _item_flags(r.get("item_code"))
		tracked = tracked or bool(item.has_batch_no or item.has_serial_no)
		se.append("items", {
			"item_code": item.name,
			"qty": qty,
			"uom": item.stock_uom,
			"stock_uom": item.stock_uom,
			"conversion_factor": 1,
			"s_warehouse": s_wh,
			"t_warehouse": t_wh,
		})
	if len(companies) != 1:
		frappe.throw("All lines must belong to the same company.")
	se.company = companies.pop()
	return se, tracked


# ─────────────────────────────────────────────────────────────
# Stock count (Stock Reconciliation)
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(methods=["POST"])
def create_stock_reconciliation(warehouse, rows):
	"""Draft Stock Reconciliation for one Bin from counted quantities.

	rows: [{"item_code": ..., "qty": counted_qty}]. Only rows whose count differs from
	the system quantity are added. Batch/serial items are skipped and reported back,
	since reconciling them needs batch/serial detail.
	"""
	_require_view_permission()
	rows = parse_json(rows, []) or []
	if not frappe.db.exists("Warehouse", warehouse):
		frappe.throw(f"Warehouse {warehouse} not found")
	company = frappe.db.get_value("Warehouse", warehouse, "company")

	current = {
		r.item_code: r
		for r in frappe.db.sql(
			"SELECT item_code, actual_qty, valuation_rate FROM `tabBin` WHERE warehouse = %s",
			(warehouse,),
			as_dict=True,
		)
	}

	doc = frappe.new_doc("Stock Reconciliation")
	doc.company = company
	doc.purpose = "Stock Reconciliation"
	doc.posting_date = nowdate()
	skipped, unchanged = [], []
	for r in rows:
		code = r.get("item_code")
		if not code or r.get("qty") in (None, ""):
			continue
		counted = _flt(r.get("qty"))
		if counted < 0:
			frappe.throw(f"Counted quantity for {code} cannot be negative.")
		item = _item_flags(code)
		if item.has_batch_no or item.has_serial_no:
			skipped.append(code)
			continue
		system = current.get(code)
		if system and abs(_flt(system.actual_qty) - counted) < 1e-9:
			unchanged.append(code)
			continue
		doc.append(
			"items",
			{
				"item_code": code,
				"warehouse": warehouse,
				"qty": counted,
				"valuation_rate": _flt(system.valuation_rate) if system else 0,
			},
		)

	if not doc.get("items"):
		return {"name": None, "skipped": skipped, "unchanged": unchanged,
		        "message": "No differences to record."}

	doc.insert()
	return {
		"name": doc.name,
		"url": _doc_url("Stock Reconciliation", doc.name),
		"rows": len(doc.items),
		"skipped": skipped,
		"unchanged": unchanged,
	}


# ─────────────────────────────────────────────────────────────
# Putaway
# ─────────────────────────────────────────────────────────────

def score_bin(b, item_code, uom, qty, caps, used, bin_items, dock):
	"""Score one Bin for one item (lower is better). Returns None if the bin is full."""
	cap = _flt((caps.get(b["wh"]) or {}).get(uom))
	free = None
	if cap > 0:
		free = cap - _flt((used.get(b["wh"]) or {}).get(uom))
		if free <= 1e-9:
			return None

	distance = abs(_int(b["row"]) - dock[0]) * ROW_STEP + abs(_int(b["col"]) - dock[1]) * COL_STEP
	score = distance + _int(b.get("level")) * LEVEL_COST
	reasons = [f"{round(distance)} m from dock"]
	if _int(b.get("level")):
		reasons.append(f"level {_int(b['level']) + 1}")

	held = bin_items.get(b["wh"]) or set()
	if item_code in held:
		score += SAME_ITEM_BONUS
		reasons.append("already holds this item")
	elif held:
		score += MIXED_PENALTY
		reasons.append(f"shares with {len(held)} other item{'s' if len(held) != 1 else ''}")
	else:
		reasons.append("empty")

	if free is None:
		score += UNKNOWN_CAP_PENALTY
		reasons.append(f"no {uom} capacity set")
	elif free + 1e-9 < qty:
		score += PARTIAL_PENALTY
		reasons.append(f"fits {round(free, 3)} of {round(qty, 3)}")
	else:
		reasons.append(f"fits all ({round(free, 3)} {uom} free)")

	return {
		"wh": b["wh"], "label": b.get("label"), "slot": b.get("slot"), "slot_label": b.get("slot_label"),
		"row": b["row"], "col": b["col"], "level": b.get("level", 0),
		"score": round(score, 2), "distance": round(distance, 1), "free": free, "reasons": reasons,
	}


def plan_putaway(bins, caps, used, bin_items, dock, requests, alternatives=3):
	"""Greedy putaway plan. Items are placed in request order; each placement reduces
	free capacity so later items don't get promised the same space. Quantity that
	doesn't fit anywhere with known capacity is reported as unplaced."""
	used = copy.deepcopy(used)
	bin_items = {k: set(v) for k, v in bin_items.items()}
	plan = []
	for req in requests:
		item_code, uom = req["item_code"], req["uom"]
		remaining = _flt(req["qty"])
		allocations = []
		first_candidates = None
		guard = 0
		while remaining > 1e-9 and guard < 50:
			guard += 1
			cands = [
				c for c in (score_bin(b, item_code, uom, remaining, caps, used, bin_items, dock) for b in bins) if c
			]
			cands.sort(key=lambda c: (c["score"], c["wh"]))
			if first_candidates is None:
				first_candidates = cands[: alternatives + 1]
			if not cands:
				break
			best = cands[0]
			take = remaining if best["free"] is None else min(remaining, best["free"])
			allocations.append(dict(best, qty=round(take, 6)))
			used.setdefault(best["wh"], {})[uom] = _flt(used.get(best["wh"], {}).get(uom)) + take
			bin_items.setdefault(best["wh"], set()).add(item_code)
			remaining -= take
		chosen = {a["wh"] for a in allocations}
		plan.append(
			{
				"item_code": item_code,
				"item_name": req.get("item_name"),
				"qty": _flt(req["qty"]),
				"uom": uom,
				"from_warehouse": req.get("from_warehouse"),
				"allocations": allocations,
				"alternatives": [c for c in (first_candidates or []) if c["wh"] not in chosen][:alternatives],
				"unplaced": round(max(0.0, remaining), 6),
			}
		)
	return plan


def _dock_position(floor, bins):
	dock_slot = frappe.db.get_value("Warehouse", floor, "wt_dock_slot")
	for b in bins:
		if b["slot"] == dock_slot:
			return (_int(b["row"]), _int(b["col"])), dock_slot
	return (0, 0), None


@frappe.whitelist()
def get_floor_meta(group_warehouse):
	_require_view_permission()
	return {"dock_slot": frappe.db.get_value("Warehouse", group_warehouse, "wt_dock_slot")}


@frappe.whitelist(methods=["POST"])
def save_dock(group_warehouse, slot_warehouse=None):
	"""Remember which Slot is next to the receiving dock (used by putaway and routes)."""
	_require_edit_permission()
	if slot_warehouse and frappe.db.get_value("Warehouse", slot_warehouse, "parent_warehouse") != group_warehouse:
		frappe.throw("The dock slot must be on this floor.")
	frappe.db.set_value("Warehouse", group_warehouse, "wt_dock_slot", slot_warehouse or None)
	return {"ok": True, "dock_slot": slot_warehouse}


RECEIPT_SOURCES = {
	# doctype: (child field, qty field in stock UOM, warehouse field)
	"Purchase Receipt": ("items", "stock_qty", "warehouse"),
	"Stock Entry": ("items", "transfer_qty", "t_warehouse"),
	"Subcontracting Receipt": ("items", "received_qty", "warehouse"),
}


@frappe.whitelist()
def get_receipt_items(doctype, name):
	"""Items received on a document, as putaway requests in stock UOM."""
	_require_view_permission()
	if doctype not in RECEIPT_SOURCES:
		frappe.throw(f"Putaway from {doctype} is not supported.")
	doc = frappe.get_doc(doctype, name)
	doc.check_permission("read")
	child, qty_field, wh_field = RECEIPT_SOURCES[doctype]
	merged = {}
	for row in doc.get(child) or []:
		qty = _flt(row.get(qty_field)) or _flt(row.get("qty")) * (_flt(row.get("conversion_factor")) or 1)
		if qty <= 0 or not row.get(wh_field):
			continue
		key = (row.item_code, row.get(wh_field))
		m = merged.setdefault(key, {
			"item_code": row.item_code, "item_name": row.get("item_name"),
			"qty": 0.0, "from_warehouse": row.get(wh_field),
		})
		m["qty"] += qty
	return list(merged.values())


@frappe.whitelist()
def get_putaway_plan(group_warehouse, items):
	"""Rank Bins on one Floor for each item to put away. See plan_putaway()."""
	_require_view_permission()
	items = parse_json(items, []) or []
	requests = []
	for it in items:
		if not it.get("item_code") or _flt(it.get("qty")) <= 0:
			continue
		info = _item_flags(it["item_code"])
		requests.append({
			"item_code": info.name,
			"item_name": it.get("item_name") or frappe.db.get_value("Item", info.name, "item_name"),
			"qty": _flt(it["qty"]),
			"uom": info.stock_uom,
			"from_warehouse": it.get("from_warehouse"),
		})
	if not requests:
		frappe.throw("Add at least one item with a quantity.")

	bins = get_floor_bins(group_warehouse)
	whs = [b.wh for b in bins]
	caps = get_uom_capacities(whs)
	used = get_uom_quantities(whs)
	bin_items = {}
	if whs:
		for r in frappe.db.sql(
			"SELECT warehouse, item_code FROM `tabBin` WHERE warehouse IN %(whs)s AND actual_qty > 0",
			{"whs": tuple(whs)},
			as_dict=True,
		):
			bin_items.setdefault(r.warehouse, set()).add(r.item_code)

	dock, dock_slot = _dock_position(group_warehouse, bins)
	plan = plan_putaway([dict(b) for b in bins], caps, used, bin_items, dock, requests)
	return {"plan": plan, "dock_slot": dock_slot, "dock": list(dock)}
