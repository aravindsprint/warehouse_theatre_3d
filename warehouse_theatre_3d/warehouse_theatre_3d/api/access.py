"""Which warehouses the current user may see, from ERPNext User Permissions.

Most of this app reads stock with SQL, which bypasses Frappe's permission engine, so
every read path filters through here. A user restricted to some Warehouses (Frappe
already expands a group warehouse to everything under it) and/or some Companies sees
only those warehouses: floors, racks, bins, stock, alerts, reports and orders.
Unrestricted users (and Administrator) get None, meaning "no filter".

Writes don't need this: moves, counts, picks and packing all go through ERPNext
documents, which check User Permissions on their warehouse and company links.
"""

import frappe

# User Permission rows that limit what a user sees here: those for every doctype
# (blank "Applicable For"), or for Warehouse itself.
APPLIES_TO = {None, "", "Warehouse"}


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def restricted_values(perms, doctype):
	"""Values of one doctype a user is limited to, or None when not limited.
	perms: frappe's get_user_permissions() result."""
	rows = [p for p in (perms or {}).get(doctype) or [] if p.get("applicable_for") in APPLIES_TO]
	return {p.get("doc") for p in rows} if rows else None


def combine(warehouses, company_of, allowed_wh, allowed_co):
	"""Warehouses visible under both limits. company_of: {warehouse: company}."""
	out = set()
	for wh in warehouses:
		if allowed_wh is not None and wh not in allowed_wh:
			continue
		if allowed_co is not None and company_of.get(wh) not in allowed_co:
			continue
		out.add(wh)
	return out


def keep(rows, allowed, key="warehouse"):
	"""Rows whose `key` is visible (all rows when allowed is None). Works on dicts and frappe._dicts."""
	if allowed is None:
		return list(rows)
	return [r for r in rows if r.get(key) in allowed]


def sql_params(allowed):
	"""Parameters for the fixed SQL filter `(%(wh_all)s = 1 OR <col> IN %(wh_list)s)`."""
	if allowed is None:
		return {"wh_all": 1, "wh_list": ("",)}
	return {"wh_all": 0, "wh_list": tuple(sorted(allowed)) or ("",)}


# ─────────────────────────────────────────────────────────────
# Site
# ─────────────────────────────────────────────────────────────

def allowed_warehouses():
	"""Set of warehouse names the session user may see, or None for no restriction.
	Cached for the request."""
	cached = getattr(frappe.local, "wt3d_allowed_wh", "unset")
	if cached != "unset":
		return cached
	result = None
	user = frappe.session.user
	if user not in ("Administrator", "Guest"):
		from frappe.core.doctype.user_permission.user_permission import get_user_permissions
		perms = get_user_permissions(user)
		wh, co = restricted_values(perms, "Warehouse"), restricted_values(perms, "Company")
		if wh is not None or co is not None:
			rows = frappe.db.sql(
				"""
				SELECT name, company FROM `tabWarehouse`
				WHERE (%(any_wh)s = 1 OR name IN %(whs)s) AND (%(any_co)s = 1 OR company IN %(cos)s)
				""",
				{"any_wh": 1 if wh is None else 0, "whs": tuple(wh or ("",)),
				 "any_co": 1 if co is None else 0, "cos": tuple(co or ("",))},
				as_dict=True,
			)
			result = combine([r.name for r in rows], {r.name: r.company for r in rows}, wh, co)
	frappe.local.wt3d_allowed_wh = result
	return result


def allowed_companies():
	"""Companies the user may see, or None for no restriction."""
	from frappe.core.doctype.user_permission.user_permission import get_user_permissions
	if frappe.session.user in ("Administrator", "Guest"):
		return None
	co = restricted_values(get_user_permissions(frappe.session.user), "Company")
	allowed = allowed_warehouses()
	if allowed is None:
		return co
	from_wh = {r.company for r in frappe.get_all("Warehouse", filters={"name": ["in", list(allowed) or [""]]}, fields=["company"])}
	return from_wh if co is None else (co & from_wh)


def can_see(warehouse):
	allowed = allowed_warehouses()
	return allowed is None or warehouse in allowed


def require(warehouse):
	"""Throw PermissionError unless the user may see this warehouse."""
	if warehouse and not can_see(warehouse):
		frappe.throw(frappe._("You don't have access to warehouse {0}.").format(warehouse), frappe.PermissionError)


def navigable():
	"""Allowed warehouses plus every warehouse above them (Building, Floor, rack), so a user
	limited to one rack can still open its floor. None for no restriction. Cached per request."""
	cached = getattr(frappe.local, "wt3d_navigable_wh", "unset")
	if cached != "unset":
		return cached
	allowed = allowed_warehouses()
	result = None
	if allowed is not None:
		result = set(allowed)
		if allowed:
			result |= {r[0] for r in frappe.db.sql(
				"""
				SELECT DISTINCT a.name FROM `tabWarehouse` a
				INNER JOIN `tabWarehouse` w ON w.lft >= a.lft AND w.rgt <= a.rgt
				WHERE w.name IN %(whs)s
				""",
				{"whs": tuple(allowed)},
			)}
	frappe.local.wt3d_navigable_wh = result
	return result


def floor_visible(floor):
	"""A Floor (or standalone Zone) is visible when it, or anything stored on it, is."""
	nav = navigable()
	return nav is None or floor in nav


def require_floor(floor):
	if floor and not floor_visible(floor):
		frappe.throw(frappe._("You don't have access to {0}.").format(floor), frappe.PermissionError)


def wh_filter():
	"""sql_params() for the session user."""
	return sql_params(allowed_warehouses())


def describe():
	"""What the frontend shows: whether the view is limited, and to how many warehouses."""
	allowed = allowed_warehouses()
	return {"restricted": allowed is not None, "warehouses": None if allowed is None else len(allowed)}
