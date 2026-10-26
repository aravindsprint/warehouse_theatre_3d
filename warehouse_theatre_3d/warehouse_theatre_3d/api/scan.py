"""Warehouse Scan: the phone app for putaway, picking and cycle counts (/warehouse-scan).

Every scan goes through resolve_code(), which turns a barcode or QR into a location,
an item (with the barcode's pack size), a batch or a document. Writes use the
user's own ERPNext permissions, like the rest of the app.
"""

import re

import frappe
from frappe import _
from frappe.utils import now_datetime

from warehouse_theatre_3d.warehouse_theatre_3d.api import access
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import (
	_flt,
	_int,
	_require_view_permission,
	get_floor_bins,
	parse_json,
)
from warehouse_theatre_3d.warehouse_theatre_3d.api.links import resolve_locations
from warehouse_theatre_3d.warehouse_theatre_3d.api.operations import (
	_build_transfer,
	_doc_url,
	create_stock_reconciliation,
)

# Documents a scan can open, and what the app does with them.
SCAN_DOCS = {
	"Pick List": "pick",
	"Purchase Receipt": "putaway",
	"Stock Entry": "putaway",
	"Subcontracting Receipt": "putaway",
}
MAPPED_TYPES = ("Bin", "Zone", "Slot", "Floor")

# Hand-held scanners may prefix the symbology (AIM identifier, e.g. "]C1", "]Q1")
# and add a line ending; neither is part of the code.
_AIM = re.compile(r"^\][A-Za-z][0-9A-Za-z]")


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def clean_scan(raw):
	"""The code itself from what a camera or hand-held scanner delivered."""
	code = str(raw or "").strip().strip("\x00")
	code = _AIM.sub("", code, count=1)
	return code.strip()


def walk_order(stops):
	"""A sensible walking order on one floor without the 3D layout: row by row,
	snaking (left to right, then back), lowest shelf first at each rack. Stops
	that aren't on the map keep their order and come last.

	stops: [{"key", "idx", "mapped", "row", "col", "level"}]. Returns the keys in order.
	"""
	mapped = [s for s in stops if s.get("mapped")]
	others = sorted((s for s in stops if not s.get("mapped")), key=lambda s: _int(s.get("idx")))
	rows = sorted({_int(s.get("row")) for s in mapped})
	rank = {r: i for i, r in enumerate(rows)}

	def key(s):
		i = rank[_int(s.get("row"))]
		col = _int(s.get("col"))
		return (i, col if i % 2 == 0 else -col, _int(s.get("level")), _int(s.get("idx")))

	return [s["key"] for s in sorted(mapped, key=key)] + [s["key"] for s in others]


def count_queue(locations, today=None):
	"""Which locations to count next: never counted first, then the longest since a
	count; ties go to the location holding the most stock value. Empty locations are
	left out. locations: [{"wh", "items", "value", "last_counted"}] (last_counted a
	date string or None). Returns warehouse names in order."""
	held = [loc for loc in locations if _int(loc.get("items")) > 0]
	held.sort(key=lambda loc: (
		loc.get("last_counted") is not None,
		str(loc.get("last_counted") or ""),
		-_flt(loc.get("value")),
		loc["wh"],
	))
	return [loc["wh"] for loc in held]


def apply_picks(rows, picks):
	"""Check picked quantities against a Pick List's rows before saving.

	rows: [{"name", "stock_qty"}]; picks: [{"row_name", "picked_qty", "warehouse"?}].
	Returns {row_name: {"picked_qty", "warehouse"}}. Raises ValueError on an unknown
	row, a negative quantity or more than the row asks for."""
	by_name = {r["name"]: r for r in rows}
	out = {}
	for p in picks or []:
		name = p.get("row_name")
		if name not in by_name:
			raise ValueError(f"Row {name} is not on this Pick List.")
		qty = _flt(p.get("picked_qty"))
		need = _flt(by_name[name].get("stock_qty"))
		if qty < 0:
			raise ValueError("Picked quantity cannot be negative.")
		if qty > need + 1e-9:
			raise ValueError(f"Picked {qty} but row {by_name[name].get('idx') or name} asks for {need}.")
		out[name] = {"picked_qty": qty, "warehouse": p.get("warehouse") or None}
	return out


def place_path(place):
	"""Short human label for a place: "A3 › L1", "Area 1" or the warehouse name."""
	if not place or not place.get("mapped"):
		return (place or {}).get("warehouse_label") or (place or {}).get("warehouse") or ""
	level = place.get("label")
	if level in (None, "Floor stack") or level == place.get("slot_label"):
		level = None
	parts = [p for p in (place.get("slot_label"), level) if p]
	return " › ".join(parts) or place.get("floor_label") or place.get("warehouse")


# ─────────────────────────────────────────────────────────────
# Scans
# ─────────────────────────────────────────────────────────────

def _item_info(item_code, uom=None):
	item = frappe.db.get_value(
		"Item", item_code,
		["name", "item_name", "stock_uom", "has_batch_no", "has_serial_no", "is_stock_item", "image", "disabled"],
		as_dict=True,
	)
	if not item:
		return None
	factor = 1.0
	if uom and uom != item.stock_uom:
		factor = _flt(frappe.db.get_value("UOM Conversion Detail", {"parent": item.name, "uom": uom}, "conversion_factor")) or 1.0
	return {
		"item_code": item.name, "item_name": item.item_name, "stock_uom": item.stock_uom,
		"scan_uom": uom or item.stock_uom, "factor": factor, "image": item.image,
		"has_batch_no": item.has_batch_no, "has_serial_no": item.has_serial_no,
		"is_stock_item": item.is_stock_item, "disabled": item.disabled,
	}


def _location(wh):
	place = resolve_locations([wh])[wh]
	return dict(place, kind="location", path=place_path(place),
	            company=frappe.db.get_value("Warehouse", wh, "company"),
	            is_group=frappe.db.get_value("Warehouse", wh, "is_group"))


@frappe.whitelist()
def resolve_code(code: str):
	"""What a scanned code is: a location, an item, a batch, a serial number or a document."""
	_require_view_permission()
	code = clean_scan(code)
	if not code:
		frappe.throw(_("Nothing was scanned."))

	if frappe.db.exists("Warehouse", code):
		access.require_floor(code)
		return _location(code)

	barcode = frappe.db.get_value("Item Barcode", {"barcode": code}, ["parent", "uom"], as_dict=True)
	if barcode:
		info = _item_info(barcode.parent, barcode.uom)
		if info:
			return dict(info, kind="item", code=code)

	if frappe.db.exists("Item", code):
		return dict(_item_info(code), kind="item", code=code)

	batch = frappe.db.get_value("Batch", code, ["name", "item"], as_dict=True)
	if batch:
		return dict(_item_info(batch.item), kind="item", code=code, batch_no=batch.name)

	serial = frappe.db.get_value("Serial No", code, ["name", "item_code", "warehouse"], as_dict=True)
	if serial:
		return dict(_item_info(serial.item_code), kind="item", code=code, serial_no=serial.name,
		            serial_warehouse=serial.warehouse)

	for doctype, action in SCAN_DOCS.items():
		if frappe.db.exists(doctype, code):
			if not frappe.has_permission(doctype, "read", code):
				frappe.throw(_("You can't open {0} {1}.").format(doctype, code), frappe.PermissionError)
			return {"kind": "document", "doctype": doctype, "name": code, "action": action,
			        "docstatus": frappe.db.get_value(doctype, code, "docstatus")}

	# A label typed by hand, e.g. "A3-L1": accept it when exactly one mapped warehouse has that name.
	named = frappe.get_all(
		"Warehouse",
		filters={"warehouse_name": code, "wt_warehouse_type": ["in", MAPPED_TYPES], "disabled": 0},
		pluck="name", limit=2,
	)
	if len(named) == 1:
		access.require_floor(named[0])
		return _location(named[0])

	return {"kind": "unknown", "code": code}


# ─────────────────────────────────────────────────────────────
# Floors: locations, labels and the count queue
# ─────────────────────────────────────────────────────────────

def _last_counted(whs):
	"""{warehouse: date of the last count} from the app's own stamp, or failing that the
	last submitted Stock Reconciliation touching the warehouse."""
	out = {}
	if not whs:
		return out
	for r in frappe.db.sql(
		"""
		SELECT sri.warehouse, MAX(sr.posting_date) AS last
		FROM `tabStock Reconciliation Item` sri
		INNER JOIN `tabStock Reconciliation` sr ON sr.name = sri.parent
		WHERE sr.docstatus = 1 AND sri.warehouse IN %(whs)s
		GROUP BY sri.warehouse
		""",
		{"whs": tuple(whs)},
		as_dict=True,
	):
		out[r.warehouse] = str(r.last)
	if frappe.get_meta("Warehouse").has_field("wt_last_counted_on"):
		for r in frappe.get_all("Warehouse", filters={"name": ["in", whs], "wt_last_counted_on": ["is", "set"]},
		                        fields=["name", "wt_last_counted_on"]):
			d = str(r.wt_last_counted_on)[:10]
			out[r.name] = max(out.get(r.name) or "", d)
	return out


@frappe.whitelist()
def get_floor_locations(floor: str):
	"""Every Bin and Zone on a floor with its stock, when it was last counted, and the
	order to count them in."""
	_require_view_permission()
	access.require_floor(floor)
	bins = access.keep(get_floor_bins(floor), access.allowed_warehouses(), "wh")
	whs = [b.wh for b in bins]
	stock = {}
	if whs:
		for r in frappe.db.sql(
			"""
			SELECT warehouse, COUNT(*) AS items, SUM(stock_value) AS value
			FROM `tabBin` WHERE warehouse IN %(whs)s AND actual_qty > 0
			GROUP BY warehouse
			""",
			{"whs": tuple(whs)},
			as_dict=True,
		):
			stock[r.warehouse] = r
	last = _last_counted(whs)
	floor_label = frappe.db.get_value("Warehouse", floor, "warehouse_name")
	locations = []
	for b in bins:
		s = stock.get(b.wh) or {}
		place = {"mapped": True, "slot_label": b.slot_label, "label": b.label, "floor_label": floor_label}
		locations.append({
			"wh": b.wh, "slot": b.slot, "slot_label": b.slot_label, "label": b.label,
			"row": b.row, "col": b.col, "level": b.level, "path": place_path(place),
			"items": _int(s.get("items")), "value": _flt(s.get("value")), "last_counted": last.get(b.wh),
		})
	return {"floor": floor, "floor_label": floor_label, "locations": locations, "queue": count_queue(locations)}


# ─────────────────────────────────────────────────────────────
# Picking
# ─────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_pick_list(name: str):
	"""A Pick List's rows with where each is, in walking order."""
	_require_view_permission()
	doc = frappe.get_doc("Pick List", name)
	doc.check_permission("read")
	rows = doc.get("locations") or []
	places = resolve_locations([r.warehouse for r in rows])

	# Grid positions for the walking order, per floor (most rows' floor first).
	positions = {}
	for floor in {p.get("floor") for p in places.values() if p.get("floor")}:
		for b in get_floor_bins(floor):
			positions[b.wh] = b
	floors = {}
	for r in rows:
		f = (places.get(r.warehouse) or {}).get("floor")
		if f:
			floors[f] = floors.get(f, 0) + 1
	floor_rank = {f: i for i, (f, _n) in enumerate(sorted(floors.items(), key=lambda x: -x[1]))}

	stops = []
	for r in rows:
		pos = positions.get(r.warehouse)
		place = places.get(r.warehouse) or {}
		stops.append({
			"key": r.name, "idx": r.idx, "mapped": bool(pos),
			# Floors one after another: offset rows so each floor is walked as a block.
			"row": (floor_rank.get(place.get("floor"), 99) * 10000 + _int(pos.row)) if pos else 0,
			"col": _int(pos.col) if pos else 0, "level": _int(pos.level) if pos else 0,
		})
	order = {k: i for i, k in enumerate(walk_order(stops))}

	out = []
	for r in rows:
		place = places.get(r.warehouse) or {"mapped": False, "warehouse": r.warehouse}
		out.append({
			"row_name": r.name, "idx": r.idx, "walk": order.get(r.name, r.idx),
			"item_code": r.item_code, "item_name": r.item_name,
			"qty": _flt(r.get("stock_qty")) or _flt(r.qty), "uom": r.get("stock_uom") or r.uom,
			"picked_qty": _flt(r.get("picked_qty")), "warehouse": r.warehouse,
			"batch_no": r.get("batch_no"), "path": place_path(place),
			"floor": place.get("floor"), "floor_label": place.get("floor_label"), "mapped": place.get("mapped"),
		})
	return {
		"name": doc.name, "docstatus": doc.docstatus, "status": doc.get("status"),
		"customer": doc.get("customer"), "purpose": doc.get("purpose"),
		"can_write": bool(doc.docstatus == 0 and frappe.has_permission("Pick List", "write", doc.name)),
		"rows": out, "url": _doc_url("Pick List", doc.name),
	}


@frappe.whitelist(methods=["POST"])
def save_picks(name: str, picks: str | list, submit: int | str = 0):
	"""Record what was picked on a draft Pick List, and optionally submit it.

	picks: [{"row_name", "picked_qty", "warehouse"?}]. A different warehouse means the
	picker took the stock from another location than planned.
	"""
	_require_view_permission()
	picks = parse_json(picks, []) or []
	doc = frappe.get_doc("Pick List", name)
	if doc.docstatus != 0:
		frappe.throw(_("{0} is already submitted, so picks can't be changed from the scanner.").format(name))
	doc.check_permission("write")
	try:
		changes = apply_picks([{"name": r.name, "idx": r.idx, "stock_qty": _flt(r.get("stock_qty")) or _flt(r.qty)}
		                       for r in doc.locations], picks)
	except ValueError as e:
		frappe.throw(str(e))
	for r in doc.locations:
		c = changes.get(r.name)
		if not c:
			continue
		r.picked_qty = c["picked_qty"]
		if c["warehouse"] and c["warehouse"] != r.warehouse:
			if not frappe.db.exists("Warehouse", c["warehouse"]):
				frappe.throw(_("Warehouse {0} not found").format(c["warehouse"]))
			r.warehouse = c["warehouse"]
	# Without "Pick Manually", saving a Pick List rebuilds its lines from stock and would
	# undo a changed warehouse. Without "Scan Mode", submitting fills every line left at
	# 0 with its full quantity, so a line the picker skipped would count as picked.
	if doc.meta.has_field("pick_manually"):
		doc.pick_manually = 1
	if doc.meta.has_field("scan_mode"):
		doc.scan_mode = 1
	doc.save()
	submitted = False
	if _int(submit):
		doc.submit()
		submitted = True
	return {"name": doc.name, "docstatus": doc.docstatus, "submitted": submitted, "url": _doc_url("Pick List", doc.name)}


# ─────────────────────────────────────────────────────────────
# Putaway and moves
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(methods=["POST"])
def post_transfer(rows: str | list, submit: int | str = 0):
	"""One Material Transfer for the moves scanned on the phone.

	Submitted when asked and no item needs a batch or serial number; otherwise saved
	as a draft to finish in ERPNext.
	"""
	_require_view_permission()
	rows = parse_json(rows, []) or []
	se, tracked = _build_transfer(rows, remarks=_("Scanned with Warehouse Scan"))
	se.insert()
	submitted = False
	if _int(submit) and not tracked:
		se.submit()
		submitted = True
	return {"name": se.name, "docstatus": se.docstatus, "submitted": submitted,
	        "needs_batch_or_serial": tracked, "rows": len(se.items), "url": _doc_url("Stock Entry", se.name)}


# ─────────────────────────────────────────────────────────────
# Counting
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(methods=["POST"])
def finish_count(warehouse: str, rows: str | list):
	"""Record a count of one location: a draft Stock Reconciliation for any differences,
	and the date it was counted (also when nothing differed)."""
	access.require(warehouse)
	result = create_stock_reconciliation(warehouse, rows)
	if frappe.get_meta("Warehouse").has_field("wt_last_counted_on"):
		frappe.db.set_value("Warehouse", warehouse, {
			"wt_last_counted_on": now_datetime(),
			"wt_last_counted_by": frappe.session.user,
		}, update_modified=False)
	return result
