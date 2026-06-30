import frappe
import json

# Roles allowed to VIEW the app (read-only access)
VIEW_ROLES = {"System Manager", "Stock Manager", "Stock User"}
# Roles allowed to EDIT (floor plan, configure slot, UOM capacity, setup wizard)
EDIT_ROLES = {"System Manager"}


def _require_view_permission():
	user_roles = set(frappe.get_roles())
	if not (user_roles & VIEW_ROLES):
		frappe.throw("You do not have permission to view Warehouse Theatre 3D.", frappe.PermissionError)


def _require_edit_permission():
	user_roles = set(frappe.get_roles())
	if not (user_roles & EDIT_ROLES):
		frappe.throw(
			"You do not have permission to edit Warehouse Theatre 3D. Only System Manager can run setup or edit configuration.",
			frappe.PermissionError
		)


@frappe.whitelist()
def is_setup_complete():
	"""True if at least one warehouse already has wt_warehouse_type assigned."""
	_require_view_permission()
	return bool(frappe.db.exists("Warehouse", {"wt_warehouse_type": ["is", "set"]}))


@frappe.whitelist()
def scan_warehouse_tree(company=None):
	"""
	Walk the existing Warehouse parent_warehouse tree (no relabeling) and
	return a summary grouped by depth, so the setup wizard can ask the
	admin to assign a role (Building/Floor/Slot/Bin/Skip) per depth.
	"""
	_require_edit_permission()

	filters = {}
	if company:
		filters["company"] = company

	warehouses = frappe.get_all(
		"Warehouse",
		filters=filters,
		fields=["name", "warehouse_name", "parent_warehouse", "is_group", "disabled"],
	)
	if not warehouses:
		return {"depths": [], "total_warehouses": 0, "uniform": True}

	by_name = {w.name: w for w in warehouses}

	def _depth(wh_name, _seen=None):
		_seen = _seen or set()
		if wh_name in _seen:
			return 0  # cycle guard
		_seen.add(wh_name)
		w = by_name.get(wh_name)
		if not w or not w.parent_warehouse or w.parent_warehouse not in by_name:
			return 1
		return 1 + _depth(w.parent_warehouse, _seen)

	depth_map = {}
	for w in warehouses:
		if w.disabled:
			continue
		d = _depth(w.name)
		depth_map.setdefault(d, []).append(w)

	depths = []
	for d in sorted(depth_map.keys()):
		items = depth_map[d]
		sample = sorted(items, key=lambda x: x.warehouse_name)[:5]
		depths.append({
			"depth": d,
			"count": len(items),
			"sample_names": [i.warehouse_name for i in sample],
			"is_leaf": all(
				not any(o.parent_warehouse == i.name for o in warehouses)
				for i in items
			),
			"all_group": all(i.is_group for i in items),
			"all_leaf_wh": all(not i.is_group for i in items),
		})

	max_depth = max(depth_map.keys()) if depth_map else 0
	min_depth_with_items = min(depth_map.keys()) if depth_map else 0

	return {
		"depths": depths,
		"total_warehouses": len(warehouses),
		"max_depth": max_depth,
		"min_depth": min_depth_with_items,
	}


@frappe.whitelist()
def apply_depth_mapping(mapping, company=None):
	"""
	mapping: JSON list like [{"depth": 1, "role": "Building"}, {"depth": 2, "role": "Floor"}, ...]
	role is one of: Building, Floor, Slot, Bin, Skip
	Writes wt_warehouse_type to every warehouse at each mapped depth.
	Does not rename, move, or otherwise alter the warehouse tree.
	"""
	_require_edit_permission()

	if isinstance(mapping, str):
		mapping = json.loads(mapping)

	valid_roles = {"Building", "Floor", "Slot", "Bin"}
	depth_to_role = {
		int(m["depth"]): m["role"]
		for m in mapping
		if m.get("role") in valid_roles
	}
	if not depth_to_role:
		frappe.throw("No valid role mapping provided.")

	filters = {}
	if company:
		filters["company"] = company

	warehouses = frappe.get_all(
		"Warehouse",
		filters=filters,
		fields=["name", "parent_warehouse", "disabled"],
	)
	by_name = {w.name: w for w in warehouses}

	def _depth(wh_name, _seen=None):
		_seen = _seen or set()
		if wh_name in _seen:
			return 0
		_seen.add(wh_name)
		w = by_name.get(wh_name)
		if not w or not w.parent_warehouse or w.parent_warehouse not in by_name:
			return 1
		return 1 + _depth(w.parent_warehouse, _seen)

	updated = 0
	for w in warehouses:
		if w.disabled:
			continue
		d = _depth(w.name)
		role = depth_to_role.get(d)
		if role:
			frappe.db.set_value("Warehouse", w.name, "wt_warehouse_type", role, update_modified=False)
			updated += 1

	frappe.db.commit()
	return {"ok": True, "updated": updated}


@frappe.whitelist()
def get_setup_summary():
	"""Returns counts per wt_warehouse_type, for the wizard's review/preview step."""
	_require_edit_permission()
	rows = frappe.db.sql("""
		SELECT wt_warehouse_type AS role, COUNT(*) AS count
		FROM `tabWarehouse`
		WHERE wt_warehouse_type IS NOT NULL AND disabled = 0
		GROUP BY wt_warehouse_type
	""", as_dict=True)
	return {r.role: r.count for r in rows}
