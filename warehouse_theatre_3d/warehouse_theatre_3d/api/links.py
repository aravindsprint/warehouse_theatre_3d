"""Links from ERPNext forms into the warehouse map.

Resolves warehouses to their place in the theatre (Floor › Slot › Bin, or a floor
Zone) and reads the lines of stock documents, so a Stock Entry, Purchase Receipt,
Delivery Note, Pick List or Material Request can be shown on the map. Read-only.
"""

import frappe

from warehouse_theatre_3d.warehouse_theatre_3d.api.common import _flt, _require_view_permission

# doctype: (child table, qty field in stock UOM, source warehouse field, target warehouse field)
DOC_LINES = {
	"Stock Entry": ("items", "transfer_qty", "s_warehouse", "t_warehouse"),
	"Purchase Receipt": ("items", "stock_qty", None, "warehouse"),
	"Purchase Invoice": ("items", "stock_qty", None, "warehouse"),
	"Subcontracting Receipt": ("items", "received_qty", None, "warehouse"),
	"Delivery Note": ("items", "stock_qty", "warehouse", None),
	"Sales Invoice": ("items", "stock_qty", "warehouse", None),
	"Pick List": ("locations", "stock_qty", "warehouse", None),
	"Material Request": ("items", "stock_qty", "from_warehouse", "warehouse"),
}


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def document_lines(doctype, rows):
	"""Normalise a document's child rows to [{idx, item_code, item_name, qty, uom, source, target}].

	rows: child-table rows as dicts. Falls back to qty × conversion_factor when the
	stock-UOM field is empty, and skips rows with no item or no warehouse at all.
	"""
	_child, qty_field, src_field, tgt_field = DOC_LINES[doctype]
	out = []
	for r in rows or []:
		src = r.get(src_field) if src_field else None
		tgt = r.get(tgt_field) if tgt_field else None
		if not r.get("item_code") or not (src or tgt):
			continue
		qty = _flt(r.get(qty_field)) or _flt(r.get("qty")) * (_flt(r.get("conversion_factor")) or 1)
		out.append({
			"idx": r.get("idx"), "item_code": r.get("item_code"), "item_name": r.get("item_name"),
			"qty": qty, "uom": r.get("stock_uom") or r.get("uom"), "source": src or None, "target": tgt or None,
		})
	return out


def place_of(row):
	"""Map position for a warehouse row from resolve_locations' query."""
	t = row.get("wt_type")
	if t == "Bin" and row.get("slot") and row.get("floor"):
		return {"floor": row["floor"], "floor_label": row.get("floor_label"), "slot": row["slot"],
		        "slot_label": row.get("slot_label"), "label": row.get("label"), "mapped": True}
	if t == "Zone":
		floor = row.get("zone_floor") or row["wh"]
		return {"floor": floor, "floor_label": row.get("zone_floor_label") or row.get("label"), "slot": row["wh"],
		        "slot_label": row.get("label"), "label": "Floor stack", "mapped": True}
	if t == "Slot" and row.get("zone_floor"):
		# A rack itself (e.g. a Pick List row pointing at a rack, not a shelf level)
		return {"floor": row["zone_floor"], "floor_label": row.get("zone_floor_label"), "slot": row["wh"],
		        "slot_label": row.get("label"), "label": None, "mapped": True}
	if t == "Floor":
		return {"floor": row["wh"], "floor_label": row.get("label"), "slot": None, "slot_label": None,
		        "label": None, "mapped": True}
	return {"floor": None, "floor_label": None, "slot": None, "slot_label": None, "label": row.get("label"), "mapped": False}


# ─────────────────────────────────────────────────────────────
# Lookups
# ─────────────────────────────────────────────────────────────

def resolve_locations(warehouses):
	"""{warehouse: place} for the given warehouses (see place_of)."""
	whs = sorted({w for w in warehouses if w})
	if not whs:
		return {}
	rows = frappe.db.sql(
		"""
		SELECT w.name AS wh, w.warehouse_name AS label, w.wt_warehouse_type AS wt_type,
		       s.name AS slot, s.warehouse_name AS slot_label,
		       f.name AS floor, f.warehouse_name AS floor_label,
		       pf.name AS zone_floor, pf.warehouse_name AS zone_floor_label
		FROM `tabWarehouse` w
		LEFT JOIN `tabWarehouse` s ON s.name = w.parent_warehouse AND s.wt_warehouse_type = 'Slot'
		LEFT JOIN `tabWarehouse` f ON f.name = s.parent_warehouse AND f.wt_warehouse_type = 'Floor'
		LEFT JOIN `tabWarehouse` pf ON pf.name = w.parent_warehouse AND pf.wt_warehouse_type = 'Floor'
		WHERE w.name IN %(whs)s
		""",
		{"whs": tuple(whs)},
		as_dict=True,
	)
	out = {r.wh: dict(place_of(r), warehouse=r.wh, warehouse_label=r.label) for r in rows}
	for w in whs:
		out.setdefault(w, {"warehouse": w, "warehouse_label": w, "mapped": False, "floor": None, "slot": None})
	return out


@frappe.whitelist()
def find_warehouse(warehouse: str):
	"""Where one warehouse is on the map (for the Warehouse form's "Open in 3D" button)."""
	_require_view_permission()
	if not frappe.db.exists("Warehouse", warehouse):
		frappe.throw(f"Warehouse {warehouse} not found")
	return resolve_locations([warehouse])[warehouse]


@frappe.whitelist()
def get_document_locations(doctype: str, name: str):
	"""A stock document's lines with where each item comes from and goes to on the map."""
	_require_view_permission()
	if doctype not in DOC_LINES:
		frappe.throw(f"{doctype} can't be shown on the warehouse map.")
	doc = frappe.get_doc(doctype, name)
	doc.check_permission("read")
	child = DOC_LINES[doctype][0]
	lines = document_lines(doctype, [r.as_dict() for r in doc.get(child) or []])
	places = resolve_locations([w for ln in lines for w in (ln["source"], ln["target"])])
	for ln in lines:
		ln["from"] = places.get(ln["source"]) if ln["source"] else None
		ln["to"] = places.get(ln["target"]) if ln["target"] else None
	return {
		"doctype": doctype, "name": doc.name, "docstatus": doc.docstatus,
		"title": doc.get("title") or doc.name,
		"purpose": doc.get("purpose") or doc.get("stock_entry_type"),
		"lines": lines,
	}


@frappe.whitelist()
def get_item_locations(item_code: str):
	"""Compact "where is this item" for the Item form: mapped places plus other warehouses."""
	_require_view_permission()
	rows = frappe.db.sql(
		"""
		SELECT b.warehouse, b.actual_qty AS qty, b.reserved_qty AS reserved, i.stock_uom AS uom
		FROM `tabBin` b INNER JOIN `tabItem` i ON i.name = b.item_code
		WHERE b.item_code = %s AND b.actual_qty != 0
		ORDER BY b.actual_qty DESC
		""",
		(item_code,),
		as_dict=True,
	)
	places = resolve_locations([r.warehouse for r in rows])
	return [dict(r, **{k: v for k, v in places[r.warehouse].items() if k != "warehouse"}) for r in rows]
