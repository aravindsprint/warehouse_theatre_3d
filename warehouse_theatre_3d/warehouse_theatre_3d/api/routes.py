"""Pick List data for the "Spot the Bottleneck" route view.

Route geometry and optimisation run in the browser, where the 3D layout already
lives; the server only supplies pick rows and saves a new row order on request.
"""

import frappe
from frappe.utils import add_days, nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api.common import (
	_flt,
	_int,
	_require_view_permission,
	get_floor_bins,
	parse_json,
)

MAX_LISTS = 300


def _floor_whs(floor):
	return [b.wh for b in get_floor_bins(floor)]


@frappe.whitelist()
def get_pick_lists(group_warehouse, days=30, limit=50):
	"""Recent Pick Lists with at least one row on this Floor."""
	_require_view_permission()
	whs = _floor_whs(group_warehouse)
	if not whs:
		return []
	return frappe.db.sql(
		"""
		SELECT pl.name, pl.status, pl.docstatus, pl.creation, pl.purpose, pl.customer,
		       COUNT(pli.name) AS floor_rows,
		       (SELECT COUNT(*) FROM `tabPick List Item` x WHERE x.parent = pl.name) AS total_rows
		FROM `tabPick List` pl
		INNER JOIN `tabPick List Item` pli ON pli.parent = pl.name AND pli.warehouse IN %(whs)s
		WHERE pl.docstatus < 2 AND pl.creation >= %(from)s
		GROUP BY pl.name
		ORDER BY pl.creation DESC
		LIMIT %(limit)s
		""",
		{"whs": tuple(whs), "from": add_days(nowdate(), -max(1, _int(days) or 30)),
		 "limit": max(1, min(_int(limit) or 50, MAX_LISTS))},
		as_dict=True,
	)


def _rows_for(names):
	rows = frappe.db.sql(
		"""
		SELECT pli.parent, pli.name AS row_name, pli.idx, pli.item_code, pli.item_name,
		       pli.warehouse, pli.stock_qty AS qty, pli.stock_uom AS uom, pli.picked_qty
		FROM `tabPick List Item` pli
		WHERE pli.parent IN %(names)s
		ORDER BY pli.parent, pli.idx
		""",
		{"names": tuple(names)},
		as_dict=True,
	)
	meta = {
		r.name: r
		for r in frappe.db.sql(
			"SELECT name, docstatus, status, creation FROM `tabPick List` WHERE name IN %(names)s",
			{"names": tuple(names)},
			as_dict=True,
		)
	}
	out = {}
	for r in rows:
		m = meta.get(r.parent)
		pl = out.setdefault(r.parent, {
			"name": r.parent,
			"docstatus": m.docstatus if m else None,
			"status": m.status if m else None,
			"creation": str(m.creation) if m else None,
			"rows": [],
		})
		pl["rows"].append({
			"row_name": r.row_name, "idx": r.idx, "item_code": r.item_code, "item_name": r.item_name,
			"warehouse": r.warehouse, "qty": _flt(r.qty), "uom": r.uom, "picked_qty": _flt(r.picked_qty),
		})
	return [out[n] for n in names if n in out]


@frappe.whitelist()
def get_pick_rows(names):
	"""Rows (in their saved order) for the given Pick Lists."""
	_require_view_permission()
	names = [n for n in (parse_json(names, []) or []) if n][:MAX_LISTS]
	if not names:
		return []
	for n in names:
		if not frappe.has_permission("Pick List", "read", n):
			frappe.throw(f"Not permitted to read Pick List {n}", frappe.PermissionError)
	return _rows_for(names)


@frappe.whitelist()
def get_period_pick_rows(group_warehouse, days=30):
	"""All Pick Lists touching this Floor in the period, for the aisle-traffic overlay."""
	_require_view_permission()
	lists = get_pick_lists(group_warehouse, days=days, limit=MAX_LISTS)
	names = [pl.name for pl in lists if frappe.has_permission("Pick List", "read", pl.name)]
	return _rows_for(names) if names else []


def reorder_rows(rows, order):
	"""New idx for each row: rows named in `order` first, in that order, then the rest in
	their current order. Returns {row_name: new_idx}."""
	by_name = {r["name"]: r for r in rows}
	sequence = [n for n in order if n in by_name]
	seen = set(sequence)
	sequence += [r["name"] for r in sorted(rows, key=lambda r: r["idx"]) if r["name"] not in seen]
	return {name: i + 1 for i, name in enumerate(sequence)}


@frappe.whitelist(methods=["POST"])
def reorder_pick_list(name, order):
	"""Save the optimised walking order onto a draft Pick List."""
	_require_view_permission()
	order = parse_json(order, []) or []
	doc = frappe.get_doc("Pick List", name)
	if doc.docstatus != 0:
		frappe.throw("Only draft Pick Lists can be reordered.")
	doc.check_permission("write")
	new_idx = reorder_rows([{"name": r.name, "idx": r.idx} for r in doc.locations], order)
	for r in doc.locations:
		r.idx = new_idx[r.name]
	doc.locations.sort(key=lambda r: r.idx)
	doc.save()
	return {"ok": True, "name": doc.name}
