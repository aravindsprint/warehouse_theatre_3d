"""Picker work queue and batch picking for Warehouse Scan.

Work queue: the draft Pick Lists on a floor, mine first, then by the earliest Sales
Order delivery date, then oldest. "Next job" assigns the top unassigned list to the
picker with ERPNext's own Assign To (a ToDo), so supervisors see who has what in the
form, the list view and the Operations view.

Batch picking: walk several Pick Lists in one route. Each list gets a tote number; at
each shelf the picker takes the total for all lists and the app says how many go into
which tote. Picks are saved back to each Pick List as usual (scan.save_picks).
"""

import frappe
from frappe import _

from warehouse_theatre_3d.warehouse_theatre_3d.api.common import _flt, _int, _require_view_permission, parse_json
from warehouse_theatre_3d.warehouse_theatre_3d.api.routes import _floor_whs
from warehouse_theatre_3d.warehouse_theatre_3d.api.scan import get_pick_list, walk_order

MAX_BATCH = 8
EPS = 1e-9


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def queue_order(lists, user):
	"""Work queue order: lists assigned to me, then unassigned, then others'; within each,
	earliest delivery date (none last), then oldest."""
	def rank(pl):
		who = pl.get("assigned") or []
		group = 0 if user in who else (1 if not who else 2)
		due = str(pl.get("due") or "9999-12-31")
		return (group, due, str(pl.get("creation") or ""))
	return sorted(lists, key=rank)


def split_pick(total, demands):
	"""Share a picked quantity between the lines that asked for it, in tote order.

	demands: [(key, qty_asked)]. Returns {key: qty}; a short pick fills the first totes
	first, and anything over the total asked is refused (ValueError)."""
	asked = sum(_flt(q) for _k, q in demands)
	total = _flt(total)
	if total < -EPS:
		raise ValueError("Quantity can't be negative.")
	if total > asked + EPS:
		raise ValueError(f"Only {asked:g} asked for across these orders.")
	out, left = {}, total
	for key, qty in demands:
		take = min(_flt(qty), max(0.0, left))
		out[key] = round(take, 6)
		left -= take
	return out


def combine_walk(rows):
	"""One walking order for rows from several Pick Lists. rows carry "grid" ([row, col,
	level] or None) and "floor"; floors are walked one after another, the floor with most
	lines first. Returns row keys ("row_name") in order."""
	counts = {}
	for r in rows:
		if r.get("floor"):
			counts[r["floor"]] = counts.get(r["floor"], 0) + 1
	rank = {f: i for i, (f, _n) in enumerate(sorted(counts.items(), key=lambda x: (-x[1], x[0])))}
	stops = []
	for i, r in enumerate(rows):
		g = r.get("grid")
		stops.append({
			"key": r["row_name"], "idx": i, "mapped": bool(g),
			"row": (rank.get(r.get("floor"), 99) * 10000 + _int(g[0])) if g else 0,
			"col": _int(g[1]) if g else 0, "level": _int(g[2]) if g else 0,
		})
	return walk_order(stops)


# ─────────────────────────────────────────────────────────────
# Work queue
# ─────────────────────────────────────────────────────────────

def _queue(floor):
	whs = _floor_whs(floor)
	if not whs:
		return []
	lists = frappe.db.sql(
		"""
		SELECT pl.name, pl.customer, pl.purpose, pl.creation, pl._assign,
		       COUNT(pli.name) AS floor_rows,
		       MIN(so.delivery_date) AS due
		FROM `tabPick List` pl
		INNER JOIN `tabPick List Item` pli ON pli.parent = pl.name AND pli.warehouse IN %(whs)s
		LEFT JOIN `tabSales Order` so ON so.name = pli.sales_order
		WHERE pl.docstatus = 0
		GROUP BY pl.name
		ORDER BY pl.creation
		LIMIT 300
		""",
		{"whs": tuple(whs)},
		as_dict=True,
	)
	out = []
	for pl in lists:
		if not frappe.has_permission("Pick List", "read", pl.name):
			continue
		assigned = [u for u in (parse_json(pl._assign, []) or []) if isinstance(u, str)]
		out.append({"name": pl.name, "customer": pl.customer, "purpose": pl.purpose, "creation": str(pl.creation),
		            "floor_rows": _int(pl.floor_rows), "due": str(pl.due) if pl.due else None, "assigned": assigned})
	return queue_order(out, frappe.session.user)


@frappe.whitelist(allow_guest=False)
def get_work_queue(floor: str):
	"""Draft Pick Lists on a floor in the order to pick them, with who has each."""
	_require_view_permission()
	q = _queue(floor)
	users = {u for pl in q for u in pl["assigned"]}
	names = {r.name: r.full_name or r.name for r in frappe.get_all(
		"User", filters={"name": ["in", list(users) or [""]]}, fields=["name", "full_name"])}
	me = frappe.session.user
	for pl in q:
		pl["mine"] = me in pl["assigned"]
		pl["assigned_names"] = [names.get(u, u) for u in pl["assigned"]]
	return {"user": me, "lists": q}


def _assign(name, user):
	from frappe.desk.form.assign_to import add
	doc = frappe.get_doc("Pick List", name)
	doc.check_permission("write")
	if doc.docstatus != 0:
		frappe.throw(_("{0} is already submitted.").format(name))
	current = [u for u in (parse_json(doc.get("_assign"), []) or []) if isinstance(u, str)]
	if user in current:
		return False
	if current:
		frappe.throw(_("{0} is already assigned to {1}.").format(name, ", ".join(current)))
	add({"assign_to": [user], "doctype": "Pick List", "name": name,
	     "description": _("Pick with Warehouse Scan")})
	frappe.clear_messages()
	return True


@frappe.whitelist(allow_guest=False, methods=["POST"])
def claim(names: str | list):
	"""Assign these Pick Lists to me (skips ones someone else already has)."""
	_require_view_permission()
	names = parse_json(names, []) or []
	if isinstance(names, str):
		names = [names]
	taken, skipped = [], []
	for n in names[:MAX_BATCH]:
		try:
			_assign(n, frappe.session.user)
			taken.append(n)
		except frappe.ValidationError as e:
			skipped.append({"name": n, "reason": str(e)})
	return {"claimed": taken, "skipped": skipped}


@frappe.whitelist(allow_guest=False, methods=["POST"])
def claim_next(floor: str, count: int = 1):
	"""Take the next job(s): my own open lists first, else the top unassigned ones."""
	_require_view_permission()
	count = max(1, min(_int(count) or 1, MAX_BATCH))
	me = frappe.session.user
	q = _queue(floor)
	mine = [pl["name"] for pl in q if me in pl["assigned"]]
	free = [pl["name"] for pl in q if not pl["assigned"]]
	picked = (mine + free)[:count]
	for n in picked:
		if n not in mine:
			_assign(n, me)
	return {"names": picked}


@frappe.whitelist(allow_guest=False, methods=["POST"])
def release(name: str):
	"""Give a Pick List back to the queue (removes my assignment)."""
	_require_view_permission()
	from frappe.desk.form.assign_to import remove
	remove("Pick List", name, frappe.session.user)
	frappe.clear_messages()
	return {"ok": True}


# ─────────────────────────────────────────────────────────────
# Batch
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_batch(names: str | list):
	"""Several draft Pick Lists as one walk: each list's rows (with its tote number) in a
	combined walking order."""
	_require_view_permission()
	names = parse_json(names, []) or []
	if isinstance(names, str):
		names = [names]
	names = list(dict.fromkeys(names))[:MAX_BATCH]
	if not names:
		frappe.throw(_("Choose at least one Pick List."))
	lists, rows = [], []
	for tote, n in enumerate(names, start=1):
		pl = get_pick_list(n)
		lists.append({"name": pl["name"], "customer": pl.get("customer"), "tote": tote, "can_write": pl["can_write"],
		              "docstatus": pl["docstatus"], "url": pl["url"], "lines": len(pl["rows"])})
		for r in pl["rows"]:
			rows.append(dict(r, pick_list=pl["name"], tote=tote))
	order = {k: i for i, k in enumerate(combine_walk(rows))}
	for r in rows:
		r["walk"] = order.get(r["row_name"], 0)
	rows.sort(key=lambda r: r["walk"])
	return {"lists": lists, "rows": rows}
