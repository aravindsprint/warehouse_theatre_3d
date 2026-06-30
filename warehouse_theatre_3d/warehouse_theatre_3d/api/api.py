import frappe
import json

# Roles allowed to VIEW the app (read-only access)
VIEW_ROLES = {"System Manager", "Stock Manager", "Stock User"}
# Roles allowed to EDIT (floor plan, configure slot, UOM capacity)
EDIT_ROLES = {"System Manager"}


def _require_view_permission():
	"""Raise PermissionError unless the current user has a view role."""
	user_roles = set(frappe.get_roles())
	if not (user_roles & VIEW_ROLES):
		frappe.throw(
			"You do not have permission to view Warehouse Theatre 3D.",
			frappe.PermissionError
		)


def _require_edit_permission():
	"""Raise PermissionError unless the current user has an edit role."""
	user_roles = set(frappe.get_roles())
	if not (user_roles & EDIT_ROLES):
		frappe.throw(
			"You do not have permission to edit Warehouse Theatre 3D. "
			"Only System Manager can edit floor plans, slot configuration, or UOM capacities.",
			frappe.PermissionError
		)


def _flt(v):
	try: return float(v)
	except: return 0.0

def _int(v):
	try: return int(v)
	except: return 0


@frappe.whitelist()
def get_companies():
	return frappe.db.get_all('Company', fields=['name', 'abbr'], order_by='name asc')


@frappe.whitelist()
def get_warehouse_groups(company=None):
	"""Return all Floor warehouses grouped under their Building."""
	_require_view_permission()
	cf = ''
	if company:
		abbr = frappe.db.get_value('Company', company, 'abbr')
		if abbr:
			cf = f"AND w.name LIKE '%%- {abbr}'"
	return frappe.db.sql(f"""
		SELECT
			w.name              AS id,
			w.warehouse_name    AS name,
			w.parent_warehouse  AS parent_id,
			pw.warehouse_name   AS parent_name,
			COUNT(slot.name)    AS slot_count
		FROM `tabWarehouse` w
		LEFT JOIN `tabWarehouse` pw
			ON pw.name = w.parent_warehouse
		LEFT JOIN `tabWarehouse` slot
			ON slot.parent_warehouse = w.name
			AND slot.wt_warehouse_type = 'Slot'
			AND slot.disabled = 0
		WHERE w.wt_warehouse_type = 'Floor'
		  AND w.disabled = 0
		  {cf}
		GROUP BY w.name
		ORDER BY pw.warehouse_name, w.warehouse_name
	""", as_dict=True)


@frappe.whitelist()
def get_slots(group_warehouse):
	"""Return all Slot warehouses under a Floor, with their Bin levels."""
	_require_view_permission()
	slots = frappe.db.sql("""
		SELECT
			w.name             AS wh,
			w.warehouse_name   AS label,
			COALESCE(w.wt_row, 0)     AS `row`,
			COALESCE(w.wt_col, 0)     AS col,
			COALESCE(w.wt_row_gap, 0) AS row_gap
		FROM `tabWarehouse` w
		WHERE w.parent_warehouse = %s
		  AND w.wt_warehouse_type = 'Slot'
		  AND w.disabled = 0
		ORDER BY w.wt_row, w.wt_col, w.warehouse_name
	""", (group_warehouse,), as_dict=True)

	for sl in slots:
		sl['levels'] = _get_levels(sl['wh'])

	return slots


@frappe.whitelist()
def get_all_slots(group_warehouse):
	"""All Slot warehouses under a Floor for floor plan editor."""
	return frappe.db.sql("""
		SELECT
			w.name             AS wh,
			w.warehouse_name   AS label,
			COALESCE(w.wt_row, 0)     AS `row`,
			COALESCE(w.wt_col, 0)     AS col,
			COALESCE(w.wt_row_gap, 0) AS row_gap
		FROM `tabWarehouse` w
		WHERE w.parent_warehouse = %s
		  AND w.wt_warehouse_type = 'Slot'
		  AND w.disabled = 0
		ORDER BY w.wt_row, w.wt_col, w.warehouse_name
	""", (group_warehouse,), as_dict=True)


def _get_levels(slot_wh):
	"""Bin warehouses under a Slot."""
	levels = frappe.db.sql("""
		SELECT w.name AS wh, w.warehouse_name AS label
		FROM `tabWarehouse` w
		WHERE w.parent_warehouse = %s
		  AND w.wt_warehouse_type = 'Bin'
		  AND w.disabled = 0
		ORDER BY w.warehouse_name ASC
	""", (slot_wh,), as_dict=True)

	for lv in levels:
		lv['uoms']  = _get_uom_data(lv['wh'])
		lv['items'] = _get_items(lv['wh'])

	return levels


def _get_uom_data(level_wh):
	bins = frappe.db.sql("""
		SELECT i.stock_uom AS uom,
		       SUM(b.actual_qty)   AS qty,
		       SUM(b.reserved_qty) AS reserved
		FROM `tabBin` b
		INNER JOIN `tabItem` i ON i.name = b.item_code
		WHERE b.warehouse = %s AND b.actual_qty != 0
		GROUP BY i.stock_uom
	""", (level_wh,), as_dict=True)

	try:
		caps = {r.uom: _flt(r.capacity) for r in frappe.db.sql("""
			SELECT uom, capacity FROM `tabWarehouse UOM Capacity`
			WHERE parent = %s
		""", (level_wh,), as_dict=True)}
	except Exception:
		caps = {}

	result = []
	for b in bins:
		result.append({
			'u': b.uom, 'qty': _flt(b.qty),
			'reserved': _flt(b.reserved), 'cap': caps.get(b.uom, 0)
		})
	for uom, cap in caps.items():
		if not any(r['u'] == uom for r in result):
			result.append({'u': uom, 'qty': 0, 'reserved': 0, 'cap': cap})
	return result


def _get_items(level_wh):
	return frappe.db.sql("""
		SELECT b.item_code AS c, i.item_name AS n,
		       i.stock_uom AS u, i.item_group AS g,
		       b.actual_qty AS a, b.reserved_qty AS r,
		       b.valuation_rate AS rate, b.stock_value
		FROM `tabBin` b
		INNER JOIN `tabItem` i ON i.name = b.item_code
		WHERE b.warehouse = %s AND b.actual_qty != 0
		ORDER BY b.actual_qty DESC LIMIT 20
	""", (level_wh,), as_dict=True)


@frappe.whitelist()
def save_slot_position(warehouse, row, col, row_gap=0):
	_require_edit_permission()
	frappe.db.set_value('Warehouse', warehouse, {
		'wt_row':     _int(row),
		'wt_col':     _int(col),
		'wt_row_gap': _flt(row_gap),
	})
	frappe.db.commit()
	return {'ok': True}


@frappe.whitelist()
def save_stack_config(slot_warehouse, levels):
	_require_edit_permission()
	if isinstance(levels, str):
		levels = json.loads(levels)

	slot_doc = frappe.get_doc('Warehouse', slot_warehouse)
	existing = {
		r.name: r for r in frappe.get_all(
			'Warehouse',
			filters={'parent_warehouse': slot_warehouse, 'wt_warehouse_type': 'Bin'},
			fields=['name', 'warehouse_name', 'disabled']
		)
	}
	wanted = {lv['wh'] for lv in levels}
	for name in existing:
		if name not in wanted:
			frappe.db.set_value('Warehouse', name, 'disabled', 1)
	for lv in levels:
		if lv['wh'] in existing:
			frappe.db.set_value('Warehouse', lv['wh'], 'disabled', 0)
		else:
			new_wh = frappe.new_doc('Warehouse')
			new_wh.warehouse_name = lv['label']
			new_wh.parent_warehouse = slot_warehouse
			new_wh.is_group = 0
			new_wh.wt_warehouse_type = 'Bin'
			new_wh.company = slot_doc.company
			new_wh.insert(ignore_permissions=True)
	frappe.db.commit()
	return {'ok': True}


@frappe.whitelist()
def save_uom_capacity(warehouse, uom, capacity):
	_require_edit_permission()
	# Check if row already exists
	existing = frappe.db.get_value(
		'Warehouse UOM Capacity',
		{'parent': warehouse, 'uom': uom},
		'name'
	)
	if existing:
		frappe.db.set_value('Warehouse UOM Capacity', existing, 'capacity', _flt(capacity))
	else:
		doc = frappe.get_doc({
			'doctype': 'Warehouse UOM Capacity',
			'parent': warehouse,
			'parenttype': 'Warehouse',
			'parentfield': 'wt_uom_capacities',
			'uom': uom,
			'capacity': _flt(capacity),
		})
		doc.insert(ignore_permissions=True)
	frappe.db.commit()
	return {'ok': True}


@frappe.whitelist()
def get_summary():
	data = frappe.db.sql("""
		SELECT COUNT(DISTINCT w.name)          AS total,
		       COALESCE(SUM(b.actual_qty), 0)  AS total_qty,
		       COALESCE(SUM(b.stock_value), 0) AS total_value
		FROM `tabWarehouse` w
		LEFT JOIN `tabBin` b ON b.warehouse = w.name
		WHERE w.wt_warehouse_type = 'Bin' AND w.disabled = 0
	""", as_dict=True)
	return data[0] if data else {}


@frappe.whitelist()
def check_app_permission():
	"""Used by Frappe to decide whether to show the app icon on /apps screen."""
	user_roles = set(frappe.get_roles())
	return bool(user_roles & VIEW_ROLES)


@frappe.whitelist()
def get_user_access():
	"""Returns the current user's access level for the frontend to adapt UI."""
	user_roles = set(frappe.get_roles())
	return {
		"can_view": bool(user_roles & VIEW_ROLES),
		"can_edit": bool(user_roles & EDIT_ROLES),
		"setup_complete": bool(frappe.db.exists("Warehouse", {"wt_warehouse_type": ["is", "set"]})),
	}
