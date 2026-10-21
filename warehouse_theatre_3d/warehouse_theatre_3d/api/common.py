"""Shared helpers for the Warehouse Theatre feature APIs (insights, operations, routes).

Kept free of whitelisted endpoints so the pure functions here can be unit-tested
without a Frappe site.
"""

import json

import frappe

from warehouse_theatre_3d.warehouse_theatre_3d.api.api import (  # noqa: F401  (re-exported)
	EDIT_ROLES,
	VIEW_ROLES,
	_flt,
	_int,
	_require_edit_permission,
	_require_view_permission,
)


def parse_json(value, default=None):
	"""Accept a JSON string (www/GET callers) or an already-decoded value (desk callers)."""
	if value is None or value == "":
		return default
	if isinstance(value, str):
		try:
			return json.loads(value)
		except ValueError:
			return default
	return value


def get_floor_bins(floor):
	"""Every stock location on one Floor: Bins under its Slots (racks) and its Zones
	(floor storage), with grid position.

	`level` is the Bin's index inside its Slot, using the same ordering as
	api._get_levels() so it matches the shelf order drawn in 3D. A Zone is its own
	slot at level 0.
	"""
	rows = frappe.db.sql(
		"""
		SELECT b.name AS wh, b.warehouse_name AS label,
		       s.name AS slot, s.warehouse_name AS slot_label,
		       COALESCE(s.wt_row, 0) AS `row`, COALESCE(s.wt_col, 0) AS col,
		       COALESCE(s.wt_row_gap, 0) AS row_gap, b.company AS company
		FROM `tabWarehouse` b
		INNER JOIN `tabWarehouse` s ON s.name = b.parent_warehouse
		WHERE s.parent_warehouse = %s
		  AND s.wt_warehouse_type = 'Slot' AND s.disabled = 0
		  AND b.wt_warehouse_type = 'Bin' AND b.disabled = 0
		ORDER BY s.wt_row, s.wt_col, s.warehouse_name, b.warehouse_name ASC
		""",
		(floor,),
		as_dict=True,
	)
	level_by_slot = {}
	for r in rows:
		r["level"] = level_by_slot.get(r["slot"], 0)
		level_by_slot[r["slot"]] = r["level"] + 1

	# Floor-storage Zones hold stock themselves: each is its own "slot" with one level.
	# `floor` may also be a standalone Zone (a godown kept as a single warehouse).
	zones = frappe.db.sql(
		"""
		SELECT z.name AS wh, %(label)s AS label, z.name AS slot, z.warehouse_name AS slot_label,
		       COALESCE(z.wt_row, 0) AS `row`, COALESCE(z.wt_col, 0) AS col,
		       COALESCE(z.wt_row_gap, 0) AS row_gap, z.company AS company, 0 AS level
		FROM `tabWarehouse` z
		WHERE (z.parent_warehouse = %(floor)s OR z.name = %(floor)s)
		  AND z.wt_warehouse_type = 'Zone' AND z.disabled = 0
		ORDER BY z.wt_row, z.wt_col, z.warehouse_name
		""",
		{"floor": floor, "label": "Floor stack"},
		as_dict=True,
	)
	return rows + zones


def get_uom_capacities(warehouses):
	"""{warehouse: {uom: capacity}} for the given warehouses (only capacities > 0)."""
	if not warehouses:
		return {}
	out = {}
	for r in frappe.db.sql(
		"""
		SELECT parent, uom, capacity FROM `tabWarehouse UOM Capacity`
		WHERE parent IN %(whs)s AND capacity > 0
		""",
		{"whs": tuple(warehouses)},
		as_dict=True,
	):
		out.setdefault(r.parent, {})[r.uom] = _flt(r.capacity)
	return out


def get_uom_quantities(warehouses):
	"""{warehouse: {stock_uom: qty}} from tabBin, same grouping api._get_uom_data() uses."""
	if not warehouses:
		return {}
	out = {}
	for r in frappe.db.sql(
		"""
		SELECT b.warehouse, i.stock_uom AS uom, SUM(b.actual_qty) AS qty
		FROM `tabBin` b INNER JOIN `tabItem` i ON i.name = b.item_code
		WHERE b.warehouse IN %(whs)s AND b.actual_qty != 0
		GROUP BY b.warehouse, i.stock_uom
		""",
		{"whs": tuple(warehouses)},
		as_dict=True,
	):
		out.setdefault(r.warehouse, {})[r.uom] = _flt(r.qty)
	return out


def bin_fill_percent(caps, qtys):
	"""Fill % of one Bin, matching lvFill() in the frontend for bins that have capacities.

	Averages min(100, qty/cap) over every UOM that has a capacity set. Returns None
	when no capacity is configured, because a percentage would be made up.
	"""
	capped = [(u, c) for u, c in (caps or {}).items() if c and c > 0]
	if not capped:
		return None
	total = 0
	for uom, cap in capped:
		qty = max(0.0, _flt((qtys or {}).get(uom)))
		total += min(100, round(qty / cap * 100))
	return round(total / len(capped))
