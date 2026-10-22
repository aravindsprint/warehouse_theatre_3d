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
	_require_view_permission()
	return frappe.db.get_all('Company', fields=['name', 'abbr'], order_by='name asc')


@frappe.whitelist()
def get_warehouse_groups(company=None):
	"""Return all Floor warehouses grouped under their Building."""
	_require_view_permission()
	# Filters on Warehouse.company rather than the "- ABBR" name suffix, which breaks
	# for warehouses that were renamed or created without the suffix.
	params = {"company": company or None}
	floors = frappe.db.sql(
		"""
		SELECT w.name AS id, w.warehouse_name AS name, w.parent_warehouse AS parent_id,
		       pw.warehouse_name AS parent_name, COUNT(child.name) AS slot_count, 0 AS standalone
		FROM `tabWarehouse` w
		LEFT JOIN `tabWarehouse` pw ON pw.name = w.parent_warehouse
		LEFT JOIN `tabWarehouse` child
		       ON child.parent_warehouse = w.name
		      AND child.wt_warehouse_type IN ('Slot', 'Zone') AND child.disabled = 0
		WHERE w.wt_warehouse_type = 'Floor' AND w.disabled = 0
		  AND (%(company)s IS NULL OR w.company = %(company)s)
		GROUP BY w.name
		""",
		params,
		as_dict=True,
	)
	# A godown kept as a single warehouse (floor storage) has no Floor above it:
	# it shows as its own floor holding one zone.
	standalone = frappe.db.sql(
		"""
		SELECT z.name AS id, z.warehouse_name AS name, z.parent_warehouse AS parent_id,
		       pw.warehouse_name AS parent_name, 1 AS slot_count, 1 AS standalone
		FROM `tabWarehouse` z
		LEFT JOIN `tabWarehouse` pw ON pw.name = z.parent_warehouse
		WHERE z.wt_warehouse_type = 'Zone' AND z.disabled = 0
		  AND (pw.name IS NULL OR IFNULL(pw.wt_warehouse_type, '') != 'Floor')
		  AND (%(company)s IS NULL OR z.company = %(company)s)
		""",
		params,
		as_dict=True,
	)
	return sorted(floors + standalone, key=lambda g: ((g.parent_name or ''), (g.name or '')))


WT_TYPES = ('Building', 'Floor', 'Slot', 'Bin', 'Zone')
ZONE_LEVEL_LABEL = 'Floor stack'


@frappe.whitelist()
def get_slots(group_warehouse):
	"""Racks (Slot warehouses with their Bin levels) and floor-storage Zones on a Floor.

	A Zone is drawn as a floor stack and carries a single "level": itself, since the
	stock sits in the Zone warehouse directly. A standalone Zone (a godown kept as one
	warehouse) is its own floor holding just that Zone.
	"""
	_require_view_permission()
	slots = [] if _is_zone(group_warehouse) else _slot_rows(group_warehouse)
	for sl in slots:
		sl['kind'] = 'rack'
		sl['levels'] = _get_levels(sl['wh'])
	zones = _zone_rows(group_warehouse)
	for z in zones:
		z['levels'] = [{
			'wh': z['wh'], 'label': ZONE_LEVEL_LABEL,
			'uoms': _get_uom_data(z['wh']), 'items': _get_items(z['wh']),
		}]
	return sorted(slots + zones, key=lambda r: (r['row'], r['col'], r['label'] or ''))


@frappe.whitelist()
def get_all_slots(group_warehouse):
	"""All Slots and Zones on a Floor, for the floor plan editor."""
	_require_view_permission()
	return sorted(_slot_rows(group_warehouse) + _zone_rows(group_warehouse),
		key=lambda r: (r['row'], r['col'], r['label'] or ''))


def _is_zone(warehouse):
	return frappe.db.get_value('Warehouse', warehouse, 'wt_warehouse_type') == 'Zone'


def _slot_rows(floor):
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
	""", (floor,), as_dict=True)


def _zone_rows(floor):
	"""Zones on a Floor, or the standalone Zone itself when `floor` is one."""
	rows = frappe.db.sql("""
		SELECT
			w.name             AS wh,
			w.warehouse_name   AS label,
			COALESCE(w.wt_row, 0)     AS `row`,
			COALESCE(w.wt_col, 0)     AS col,
			COALESCE(w.wt_row_gap, 0) AS row_gap,
			COALESCE(w.wt_zone_w, 1)  AS zone_w,
			COALESCE(w.wt_zone_d, 1)  AS zone_d
		FROM `tabWarehouse` w
		WHERE (w.parent_warehouse = %(floor)s OR w.name = %(floor)s)
		  AND w.wt_warehouse_type = 'Zone'
		  AND w.disabled = 0
		ORDER BY w.wt_row, w.wt_col, w.warehouse_name
	""", {'floor': floor}, as_dict=True)
	for z in rows:
		z['kind'] = 'zone'
		z['w'] = max(1, _int(z.pop('zone_w')))
		z['d'] = max(1, _int(z.pop('zone_d')))
		if z['wh'] == floor:
			z['row'] = z['col'] = 0   # standalone: alone on its floor
	return rows


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


@frappe.whitelist(methods=["POST"])
def save_slot_position(warehouse, row, col, row_gap=0, span=None):
	_require_edit_permission()
	values = {
		'wt_row':     _int(row),
		'wt_col':     _int(col),
		'wt_row_gap': _flt(row_gap),
	}
	# For a Zone, the editor cell's column span is the zone's width.
	if span and _is_zone(warehouse):
		values['wt_zone_w'] = max(1, _int(span))
	frappe.db.set_value('Warehouse', warehouse, values)
	return {'ok': True}


@frappe.whitelist()
def get_floor_layout(group_warehouse):
	"""Return the saved Floor Plan editor grid (rows/cells incl. span & aisle flags) for a Floor.

	This is purely editor metadata - it does not drive the 3D scene (which reads
	wt_row/wt_col/wt_row_gap off each Slot warehouse). It exists so aisle markers,
	column spans, and custom row labels survive closing and reopening the editor,
	since aisle cells have no underlying Slot warehouse to store that state on.
	"""
	_require_view_permission()
	raw = frappe.db.get_value('Warehouse', group_warehouse, 'wt_floor_layout')
	if not raw:
		return {}
	try:
		return json.loads(raw)
	except Exception:
		return {}


@frappe.whitelist(methods=["POST"])
def save_floor_layout(group_warehouse, layout):
	"""Persist the Floor Plan editor grid as JSON on the Floor warehouse."""
	_require_edit_permission()
	if not isinstance(layout, str):
		layout = json.dumps(layout)
	frappe.db.set_value('Warehouse', group_warehouse, 'wt_floor_layout', layout)
	return {'ok': True}


@frappe.whitelist(methods=["POST"])
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
	return {'ok': True}


@frappe.whitelist(methods=["POST"])
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
	return {'ok': True}


@frappe.whitelist()
def get_summary():
	data = frappe.db.sql("""
		SELECT COUNT(DISTINCT w.name)          AS total,
		       COALESCE(SUM(b.actual_qty), 0)  AS total_qty,
		       COALESCE(SUM(b.stock_value), 0) AS total_value
		FROM `tabWarehouse` w
		LEFT JOIN `tabBin` b ON b.warehouse = w.name
		WHERE w.wt_warehouse_type IN ('Bin', 'Zone') AND w.disabled = 0
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


# ─────────────────────────────────────────────────────────────
# WAREHOUSE CRUD  (Manage Warehouses panel)
# ─────────────────────────────────────────────────────────────

def _default_is_group(wt_warehouse_type):
	"""Building/Floor/Slot are containers by convention; Bin and Zone hold stock."""
	return 0 if wt_warehouse_type in ('Bin', 'Zone') else 1


@frappe.whitelist()
def get_uom_list():
	"""UOM options for the WT UOM Capacities table in the warehouse form."""
	_require_view_permission()
	return frappe.get_all('UOM', fields=['name'], order_by='name asc', pluck='name')


@frappe.whitelist()
def get_parent_warehouse_options(wt_warehouse_type, company=None):
	"""Valid parents for a given Warehouse Type (Theatre): one theatre level up.
	Building's valid parent is the company's root warehouse (e.g. 'All Warehouses - ABBR')."""
	_require_view_permission()

	parent_role = {'Floor': 'Building', 'Slot': 'Floor', 'Bin': 'Slot', 'Zone': 'Floor'}.get(wt_warehouse_type)
	if parent_role:
		filters = {'wt_warehouse_type': parent_role, 'disabled': 0}
		if company:
			filters['company'] = company
		return frappe.get_all(
			'Warehouse', filters=filters,
			fields=['name', 'warehouse_name'], order_by='warehouse_name asc'
		)

	if wt_warehouse_type == 'Building':
		filters = {'is_group': 1, 'parent_warehouse': ['in', ['', None]]}
		if company:
			filters['company'] = company
		return frappe.get_all(
			'Warehouse', filters=filters,
			fields=['name', 'warehouse_name'], order_by='warehouse_name asc'
		)

	return []


@frappe.whitelist()
def get_warehouse_manage_list(company=None):
	"""Full warehouse list (all theatre roles, incl. disabled) for the Manage Warehouses panel."""
	_require_edit_permission()
	filters = {}
	if company:
		filters['company'] = company
	return frappe.get_all(
		'Warehouse',
		filters=filters,
		fields=['name', 'warehouse_name', 'wt_warehouse_type', 'parent_warehouse',
				'is_group', 'disabled', 'company'],
		order_by='disabled asc, wt_warehouse_type asc, warehouse_name asc',
	)


@frappe.whitelist()
def get_warehouse_detail(warehouse):
	"""Full field set for the edit form, incl. the WT UOM Capacities child table."""
	_require_edit_permission()
	doc = frappe.get_doc('Warehouse', warehouse)
	return {
		'name': doc.name,
		'warehouse_name': doc.warehouse_name,
		'company': doc.company,
		'wt_warehouse_type': doc.get('wt_warehouse_type'),
		'parent_warehouse': doc.parent_warehouse,
		'is_group': doc.is_group,
		'disabled': doc.disabled,
		'wt_row': doc.get('wt_row') or 0,
		'wt_col': doc.get('wt_col') or 0,
		'wt_row_gap': doc.get('wt_row_gap') or 0,
		'wt_zone_w': doc.get('wt_zone_w') or 1,
		'wt_zone_d': doc.get('wt_zone_d') or 1,
		'uom_capacities': [
			{'uom': r.uom, 'capacity': r.capacity}
			for r in (doc.get('wt_uom_capacities') or [])
		],
	}


@frappe.whitelist(methods=["POST"])
def create_warehouse(data):
	_require_edit_permission()
	if isinstance(data, str):
		data = json.loads(data)

	warehouse_name = (data.get('warehouse_name') or '').strip()
	if not warehouse_name:
		frappe.throw('Warehouse Name is required.')

	wt_type = data.get('wt_warehouse_type')
	if wt_type not in WT_TYPES:
		frappe.throw('A valid Warehouse Type (Theatre) is required: Building, Floor, Slot, Bin or Zone.')

	is_group = data.get('is_group')
	is_group = _int(is_group) if is_group is not None else _default_is_group(wt_type)

	doc = frappe.new_doc('Warehouse')
	doc.warehouse_name = warehouse_name
	doc.company = data.get('company')
	doc.wt_warehouse_type = wt_type
	doc.parent_warehouse = data.get('parent_warehouse') or None
	doc.is_group = is_group
	doc.wt_row = _int(data.get('wt_row'))
	doc.wt_col = _int(data.get('wt_col'))
	doc.wt_row_gap = _flt(data.get('wt_row_gap'))
	doc.wt_zone_w = max(1, _int(data.get('wt_zone_w') or 1))
	doc.wt_zone_d = max(1, _int(data.get('wt_zone_d') or 1))
	for row in (data.get('uom_capacities') or []):
		if not row.get('uom'):
			continue
		doc.append('wt_uom_capacities', {
			'uom': row.get('uom'),
			'capacity': _flt(row.get('capacity')),
		})

	doc.insert(ignore_permissions=True)
	return {'ok': True, 'name': doc.name}


@frappe.whitelist(methods=["POST"])
def update_warehouse(warehouse, data):
	_require_edit_permission()
	if isinstance(data, str):
		data = json.loads(data)

	doc = frappe.get_doc('Warehouse', warehouse)

	if (data.get('warehouse_name') or '').strip():
		doc.warehouse_name = data['warehouse_name'].strip()
	if data.get('wt_warehouse_type') in WT_TYPES:
		doc.wt_warehouse_type = data['wt_warehouse_type']
	if 'parent_warehouse' in data:
		doc.parent_warehouse = data.get('parent_warehouse') or None
	if 'is_group' in data and data.get('is_group') is not None:
		doc.is_group = _int(data.get('is_group'))
	if 'company' in data and data.get('company'):
		doc.company = data.get('company')

	doc.wt_row = _int(data.get('wt_row'))
	doc.wt_col = _int(data.get('wt_col'))
	doc.wt_row_gap = _flt(data.get('wt_row_gap'))
	doc.wt_zone_w = max(1, _int(data.get('wt_zone_w') or 1))
	doc.wt_zone_d = max(1, _int(data.get('wt_zone_d') or 1))

	doc.set('wt_uom_capacities', [])
	for row in (data.get('uom_capacities') or []):
		if not row.get('uom'):
			continue
		doc.append('wt_uom_capacities', {
			'uom': row.get('uom'),
			'capacity': _flt(row.get('capacity')),
		})

	doc.save(ignore_permissions=True)
	return {'ok': True, 'name': doc.name}


@frappe.whitelist(methods=["POST"])
def delete_warehouse(warehouse):
	"""Hard-delete when safe; falls back to disabling when the warehouse has
	stock/transaction history (Frappe would raise LinkExistsError on delete)."""
	_require_edit_permission()

	if frappe.db.exists('Warehouse', {'parent_warehouse': warehouse}):
		frappe.throw('This warehouse has child warehouses. Delete or reassign them first.')

	# Undo only the failed delete (savepoint), not the whole request.
	frappe.db.savepoint("wt_delete_warehouse")
	try:
		frappe.delete_doc('Warehouse', warehouse, ignore_permissions=True)
		return {'ok': True, 'disabled': False, 'message': 'Warehouse deleted.'}
	except Exception:
		frappe.db.rollback(save_point="wt_delete_warehouse")
		frappe.db.set_value('Warehouse', warehouse, 'disabled', 1)
		return {
			'ok': True, 'disabled': True,
			'message': 'This warehouse has transaction history, so it was disabled instead of permanently deleted.',
		}
