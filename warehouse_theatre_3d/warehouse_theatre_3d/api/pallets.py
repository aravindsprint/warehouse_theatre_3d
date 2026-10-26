"""Pallets (handling units) for Warehouse Scan.

A Warehouse Pallet is a labelled group of stock at one location. Build one by scanning
the location and the items on it; print its label; later scan the label and a target
location to move everything on it with one Material Transfer. The pallet only groups
stock: ERPNext's ledger still holds the quantities per warehouse, so a move checks
there is enough at the pallet's location first.
"""

import frappe
from frappe import _

from warehouse_theatre_3d.warehouse_theatre_3d.api import access
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import _flt, _require_view_permission, parse_json
from warehouse_theatre_3d.warehouse_theatre_3d.api.links import resolve_locations
from warehouse_theatre_3d.warehouse_theatre_3d.api.operations import _build_transfer, _doc_url
from warehouse_theatre_3d.warehouse_theatre_3d.api.scan import place_path

EPS = 1e-9


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def merge_contents(rows):
	"""Merge scanned rows by item and batch; drop empty ones. rows: [{"item_code", "qty", "batch_no"}]."""
	out = {}
	for r in rows or []:
		qty = _flt(r.get("qty"))
		if qty < -EPS:
			raise ValueError("Quantities can't be negative.")
		if qty <= EPS or not r.get("item_code"):
			continue
		key = (r["item_code"], r.get("batch_no") or None)
		out[key] = round(out.get(key, 0) + qty, 6)
	return [{"item_code": k[0], "batch_no": k[1], "qty": v} for k, v in out.items()]


def shortfalls(contents, on_hand):
	"""Items the location no longer holds enough of. on_hand: {item_code: qty}.
	Batches of the same item are summed, as ERPNext's Bin is per item."""
	need = {}
	for c in contents:
		need[c["item_code"]] = need.get(c["item_code"], 0) + _flt(c["qty"])
	return [{"item_code": i, "need": round(q, 6), "have": round(_flt(on_hand.get(i)), 6)}
	        for i, q in need.items() if _flt(on_hand.get(i)) + EPS < q]


# ─────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────

def _on_hand(warehouse, items):
	if not items:
		return {}
	return {r.item_code: _flt(r.actual_qty) for r in frappe.get_all(
		"Bin", filters={"warehouse": warehouse, "item_code": ["in", list(items)]}, fields=["item_code", "actual_qty"])}


def _state(doc):
	place = resolve_locations([doc.warehouse]).get(doc.warehouse) or {}
	contents = [{"item_code": r.item_code, "item_name": r.item_name, "qty": _flt(r.qty), "uom": r.stock_uom,
	             "batch_no": r.batch_no} for r in doc.items]
	return {"name": doc.name, "warehouse": doc.warehouse, "path": place_path(place) if place else doc.warehouse,
	        "floor_label": place.get("floor_label"), "status": doc.status, "note": doc.note, "contents": contents,
	        "short": shortfalls(contents, _on_hand(doc.warehouse, {c["item_code"] for c in contents})),
	        "can_write": bool(frappe.has_permission("Warehouse Pallet", "write", doc.name)),
	        "url": _doc_url("Warehouse Pallet", doc.name)}


@frappe.whitelist(allow_guest=False)
def get_pallet(name: str):
	_require_view_permission()
	doc = frappe.get_doc("Warehouse Pallet", name)
	doc.check_permission("read")
	access.require(doc.warehouse)
	return _state(doc)


@frappe.whitelist(allow_guest=False, methods=["POST"])
def save_pallet(warehouse: str, contents: str | list, name: str | None = None, note: str | None = None):
	"""Create a pallet at a location (or replace an existing pallet's contents)."""
	_require_view_permission()
	access.require(warehouse)
	try:
		rows = merge_contents(parse_json(contents, []))
	except ValueError as e:
		frappe.throw(str(e))
	if not rows:
		frappe.throw(_("Scan what's on the pallet first."))
	short = shortfalls(rows, _on_hand(warehouse, {r["item_code"] for r in rows}))
	if short:
		s = short[0]
		frappe.throw(_("{0} has only {1} of {2} here, not {3}.").format(warehouse, s["have"], s["item_code"], s["need"]))
	doc = frappe.get_doc("Warehouse Pallet", name) if name else frappe.new_doc("Warehouse Pallet")
	doc.warehouse = warehouse
	doc.status = "Active"
	if note is not None:
		doc.note = note
	doc.set("items", [])
	for r in rows:
		doc.append("items", r)
	doc.save()
	return _state(doc)


@frappe.whitelist(allow_guest=False, methods=["POST"])
def move_pallet(name: str, target: str, submit: int | str = 1):
	"""Move everything on a pallet to another location with one Material Transfer."""
	_require_view_permission()
	doc = frappe.get_doc("Warehouse Pallet", name)
	doc.check_permission("write")
	access.require(doc.warehouse)
	access.require(target)
	if doc.status != "Active" or not doc.items:
		frappe.throw(_("{0} is empty.").format(name))
	if target == doc.warehouse:
		frappe.throw(_("{0} is already at {1}.").format(name, target))
	if frappe.db.get_value("Warehouse", target, "is_group"):
		frappe.throw(_("Scan a shelf or floor area, not a group warehouse."))
	contents = [{"item_code": r.item_code, "qty": _flt(r.qty)} for r in doc.items]
	short = shortfalls(contents, _on_hand(doc.warehouse, {c["item_code"] for c in contents}))
	if short:
		s = short[0]
		frappe.throw(_("The pallet says {0} {1}, but {2} has only {3}. Fix the pallet first.").format(
			s["need"], s["item_code"], doc.warehouse, s["have"]))
	se, tracked = _build_transfer([dict(c, s_warehouse=doc.warehouse, t_warehouse=target) for c in contents],
	                              remarks=_("Pallet {0} moved with Warehouse Scan").format(name))
	for row, r in zip(se.items, doc.items):
		if r.batch_no:
			row.batch_no = r.batch_no
			row.use_serial_batch_fields = 1
	se.insert()
	submitted = False
	if int(submit or 0) and not any(frappe.db.get_value("Item", r.item_code, "has_serial_no") for r in doc.items):
		se.submit()
		submitted = True
		doc.warehouse = target
		doc.save()
	return {"pallet": _state(doc), "stock_entry": se.name, "submitted": submitted, "tracked": tracked,
	        "url": _doc_url("Stock Entry", se.name)}


@frappe.whitelist(allow_guest=False, methods=["POST"])
def empty_pallet(name: str):
	"""The pallet was broken up: keep the record, clear its contents."""
	_require_view_permission()
	doc = frappe.get_doc("Warehouse Pallet", name)
	doc.check_permission("write")
	doc.set("items", [])
	doc.status = "Empty"
	doc.save()
	return _state(doc)
