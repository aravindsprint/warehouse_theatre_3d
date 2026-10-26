"""Order fulfillment status and the role dashboards (the Operations view).

An order here is a Pick List for delivery. Its stage comes from documents ERPNext
already has, in either of two flows:

  Delivery Note flow:  Pick List → Delivery Note (+ Packing Slip) → Sales Invoice
  Sales Invoice flow:  Pick List → Sales Invoice with "Update Stock" on

  Stage        Delivery Note flow                          Sales Invoice flow
  pending      Pick List is a draft                        same
  picked       Pick List submitted, nothing after it       same
  packed       draft Delivery Note with a submitted        draft Sales Invoice (Update Stock)
               Packing Slip
  dispatched   Delivery Note submitted                     Sales Invoice (Update Stock) submitted

Billing is tracked beside the stage: in the Delivery Note flow by the Delivery Note's
% billed; in the Sales Invoice flow the dispatching document is the bill.

Links: Delivery Note lines carry `against_pick_list`. Sales Invoice lines have no Pick
List link in v15, so they are matched through the Sales Order line they share with the
Pick List row (`so_detail` = `sales_order_item`), or `pick_list_item` where it exists (v16).

Who picked a list is stamped on submit (stamp_picker, a doc event) into two read-only
Pick List fields; packers are the owners of Packing Slips (or of the Sales Invoice in
the SI flow). Read-only apart from that stamp.
"""

import json
from collections import defaultdict
from datetime import date, datetime, time, timedelta

import frappe
from frappe import _
from frappe.utils import add_days, getdate, now_datetime, nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api import access
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import (
	EDIT_ROLES,
	_flt,
	_int,
	_require_view_permission,
	get_floor_bins,
)

STAGES = ("pending", "picked", "packed", "dispatched")
MANAGER_ROLES = {"Stock Manager"} | EDIT_ROLES
MAX_ORDERS = 500
STUCK_HOURS = 24
SERIES_DAYS = 14
CACHE_SECONDS = 120
EPS = 1e-6


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def order_stage(pick_docstatus, outward):
	"""Stage of one order.

	outward: the Delivery Notes and stock-updating Sales Invoices made from it, as
	[{"kind": "dn" | "si", "docstatus": 0 | 1, "packed": bool}] (cancelled ones left out;
	`packed` = a submitted Packing Slip exists, Delivery Notes only).
	"""
	if _int(pick_docstatus) == 0:
		return "pending"
	if any(_int(d.get("docstatus")) == 1 for d in outward):
		return "dispatched"
	if any(_int(d.get("docstatus")) == 0 and (d.get("kind") == "si" or d.get("packed")) for d in outward):
		return "packed"
	return "picked"


def order_flow(outward):
	"""'Sales Invoice' when a stock-updating invoice is the outward document,
	'Delivery Note' when a Delivery Note is, None before either exists."""
	kinds = {d.get("kind") for d in outward}
	if "dn" in kinds:
		return "Delivery Note"
	if "si" in kinds:
		return "Sales Invoice"
	return None


def billing_percent(flow, outward):
	"""How much of the dispatched goods is billed, 0–100, or None before dispatch."""
	sent = [d for d in outward if _int(d.get("docstatus")) == 1]
	if not sent:
		return None
	if flow == "Sales Invoice":
		return 100
	return round(sum(_flt(d.get("per_billed")) for d in sent) / len(sent))


def line_stats(rows):
	"""Lines, short lines (picked less than asked) and untouched lines (nothing picked)
	on one Pick List. rows: [{"stock_qty", "picked_qty"}]."""
	lines = short = untouched = 0
	for r in rows:
		need, got = _flt(r.get("stock_qty")), _flt(r.get("picked_qty"))
		lines += 1
		if got <= EPS:
			untouched += 1
		if got + EPS < need:
			short += 1
	return {"lines": lines, "short": short, "untouched": untouched}


def hours_between(start, end):
	if not start or not end:
		return None
	return max(0.0, round((_dt(end) - _dt(start)).total_seconds() / 3600, 1))


def stage_times(o):
	"""Hours spent between stages for one order (None where a stage hasn't happened).

	wait: created → picked; pack: picked → packed; ship: packed (or picked) → dispatched;
	total: created → dispatched.
	"""
	return {
		"wait": hours_between(o.get("created"), o.get("picked_at")),
		"pack": hours_between(o.get("picked_at"), o.get("packed_at")),
		"ship": hours_between(o.get("packed_at") or o.get("picked_at"), o.get("dispatched_at")),
		"total": hours_between(o.get("created"), o.get("dispatched_at")),
	}


def summarise_hours(values):
	"""{"n", "median", "avg"} of a list of hours, ignoring None."""
	v = sorted(x for x in values if x is not None)
	if not v:
		return {"n": 0, "median": None, "avg": None}
	mid = len(v) // 2
	median = v[mid] if len(v) % 2 else (v[mid - 1] + v[mid]) / 2
	return {"n": len(v), "median": round(median, 1), "avg": round(sum(v) / len(v), 1)}


def daily_counts(stamps, to_date, days=SERIES_DAYS):
	"""Counts per day for the `days` days ending `to_date`, oldest first:
	[{"date": "YYYY-MM-DD", "n": count}]."""
	to_date = getdate(to_date)
	first = to_date - timedelta(days=days - 1)
	counts = defaultdict(int)
	for s in stamps:
		if not s:
			continue
		d = getdate(s)
		if first <= d <= to_date:
			counts[d] += 1
	return [{"date": (first + timedelta(days=i)).isoformat(), "n": counts[first + timedelta(days=i)]}
	        for i in range(days)]


def assigned_users(raw):
	"""Users in a document's `_assign` JSON list."""
	if not raw:
		return []
	try:
		v = json.loads(raw)
	except (TypeError, ValueError):
		return []
	return [u for u in (v or []) if isinstance(u, str)]


def posting_datetime(posting_date, posting_time):
	"""A document's posting date and time as one datetime (time may be a timedelta from MariaDB)."""
	if not posting_date:
		return None
	d = getdate(posting_date)
	if isinstance(posting_time, timedelta):
		secs = int(posting_time.total_seconds()) % 86400
		t = time(secs // 3600, (secs % 3600) // 60, secs % 60)
	elif isinstance(posting_time, time):
		t = posting_time
	elif posting_time:
		try:
			parts = [int(float(p)) for p in str(posting_time).split(":")[:3]]
			parts += [0] * (3 - len(parts))
			t = time(*parts)
		except ValueError:
			t = time(0, 0)
	else:
		t = time(0, 0)
	return datetime.combine(d, t)


def _dt(v):
	if isinstance(v, datetime):
		return v
	if isinstance(v, date):
		return datetime.combine(v, time(0, 0))
	return datetime.fromisoformat(str(v).replace("T", " ")[:19])


def build_order(pl, rows, dns, slips, sis, now):
	"""One order's status from its Pick List and the documents made from it.

	pl: Pick List header; rows: its lines; dns: [Delivery Note summaries for it];
	slips: {delivery_note: [submitted Packing Slips]}; sis: [stock-updating Sales Invoices
	matched to it]. Returns the dict the Operations view shows.
	"""
	outward = []
	for dn in dns:
		ps = slips.get(dn["name"]) or []
		outward.append({"kind": "dn", "doctype": "Delivery Note", "name": dn["name"], "docstatus": _int(dn["docstatus"]),
		                "packed": bool(ps), "per_billed": _flt(dn.get("per_billed")), "qty": _flt(dn.get("qty")),
		                "created": dn.get("creation"), "owner": dn.get("owner"),
		                "posted": posting_datetime(dn.get("posting_date"), dn.get("posting_time")),
		                "packed_at": min((p["creation"] for p in ps), default=None),
		                "packed_by": ps[0]["owner"] if ps else None})
	for si in sis:
		outward.append({"kind": "si", "doctype": "Sales Invoice", "name": si["name"], "docstatus": _int(si["docstatus"]),
		                "qty": _flt(si.get("qty")), "created": si.get("creation"), "owner": si.get("owner"),
		                "posted": posting_datetime(si.get("posting_date"), si.get("posting_time")),
		                "packed_at": si.get("creation"), "packed_by": si.get("owner")})

	stage = order_stage(pl["docstatus"], outward)
	flow = order_flow(outward)
	stats = line_stats(rows)
	picked_qty = sum(_flt(r.get("picked_qty")) for r in rows)

	picked_at = pl.get("wt_picked_at") or (pl.get("modified") if _int(pl["docstatus"]) == 1 else None)
	packing = [d for d in outward if d.get("packed_at") and (d["kind"] == "si" or d.get("packed"))]
	packed_at = min((d["packed_at"] for d in packing), default=None) if stage in ("packed", "dispatched") else None
	sent = [d for d in outward if d["docstatus"] == 1]
	dispatched_at = min((d["posted"] for d in sent if d["posted"]), default=None)
	sent_qty = sum(d["qty"] for d in sent)

	since = {"pending": pl.get("creation"), "picked": picked_at, "packed": packed_at, "dispatched": dispatched_at}[stage]
	o = {
		"name": pl["name"], "customer": pl.get("customer"), "company": pl.get("company"),
		"stage": stage, "flow": flow, "status": pl.get("status"),
		"created": pl.get("creation"), "picked_at": picked_at, "packed_at": packed_at, "dispatched_at": dispatched_at,
		"picked_by": pl.get("wt_picked_by") or None, "picked_by_known": bool(pl.get("wt_picked_by")),
		"packed_by": packing[0]["packed_by"] if packing else None,
		"assigned": assigned_users(pl.get("_assign")),
		"lines": stats["lines"], "short": stats["short"] if _int(pl["docstatus"]) == 1 else 0,
		"progress": (stats["lines"] - stats["untouched"]) if _int(pl["docstatus"]) == 0 else stats["lines"],
		"partial": bool(sent) and picked_qty > EPS and sent_qty + EPS < picked_qty,
		"billed": billing_percent(flow, outward),
		"scan_mode": _int(pl.get("scan_mode")),
		"docs": [{"doctype": d["doctype"], "name": d["name"], "docstatus": d["docstatus"]} for d in outward],
		"hours_in_stage": hours_between(since, now) if since else None,
	}
	o["times"] = stage_times(o)
	return o


def people_table(orders, key, today, week_from):
	"""Per person: orders handled in the period, today and this week, with lines and short lines."""
	by = {}
	for o in orders:
		u = o.get(key)
		if not u:
			continue
		stamp = o["picked_at"] if key == "picked_by" else o["packed_at"]
		p = by.setdefault(u, {"user": u, "orders": 0, "today": 0, "week": 0, "lines": 0, "short": 0})
		p["orders"] += 1
		p["lines"] += o["lines"]
		p["short"] += o["short"]
		if stamp:
			d = getdate(stamp)
			p["today"] += d == today
			p["week"] += d >= week_from
	for p in by.values():
		p["accuracy"] = round(100 * (p["lines"] - p["short"]) / p["lines"]) if p["lines"] else None
	return sorted(by.values(), key=lambda p: (-p["week"], -p["orders"]))


def my_work(orders, user, today):
	"""The picker's own numbers: what's waiting, what they did today and this week."""
	week_from = today - timedelta(days=6)
	pending = [o for o in orders if o["stage"] == "pending"]
	mine = [o for o in orders if o["picked_by"] == user and o["picked_at"]]
	packed = [o for o in orders if o["packed_by"] == user and o["packed_at"]]

	def window(lst, stamp, frm):
		return [o for o in lst if getdate(o[stamp]) >= frm]

	def totals(lst):
		lines = sum(o["lines"] for o in lst)
		short = sum(o["short"] for o in lst)
		return {"orders": len(lst), "lines": lines, "short": short,
		        "accuracy": round(100 * (lines - short) / lines) if lines else None}

	return {
		"waiting": len(pending),
		"assigned": [o["name"] for o in pending if user in o["assigned"]],
		"oldest_pending_hours": max((o["hours_in_stage"] or 0 for o in pending), default=None),
		"picked_today": totals(window(mine, "picked_at", today)),
		"picked_week": totals(window(mine, "picked_at", week_from)),
		"packed_today": len(window(packed, "packed_at", today)),
		"packed_week": len(window(packed, "packed_at", week_from)),
		"daily": daily_counts([o["picked_at"] for o in mine], today),
		"recent": [o["name"] for o in sorted(mine, key=lambda o: _dt(o["picked_at"]), reverse=True)[:10]],
	}


def team_view(orders, today, days, stuck_hours=STUCK_HOURS):
	"""The supervisor's view: pipeline, how long each stage takes, what's stuck, people."""
	week_from = today - timedelta(days=6)
	period_from = today - timedelta(days=days - 1)
	open_by_stage = {s: 0 for s in STAGES}
	for o in orders:
		if o["stage"] != "dispatched":
			open_by_stage[o["stage"]] += 1
	sent = [o for o in orders if o["dispatched_at"] and getdate(o["dispatched_at"]) >= period_from]
	open_by_stage["dispatched"] = len(sent)

	stuck = sorted((o for o in orders if o["stage"] != "dispatched" and (o["hours_in_stage"] or 0) >= stuck_hours),
	               key=lambda o: -(o["hours_in_stage"] or 0))
	submitted = [o for o in orders if o["stage"] != "pending"]
	lines = sum(o["lines"] for o in submitted)
	short = sum(o["short"] for o in submitted)
	unbilled = [o for o in orders if o["flow"] == "Delivery Note" and o["billed"] is not None and o["billed"] < 100]
	return {
		"funnel": open_by_stage,
		"dispatched_today": sum(1 for o in sent if getdate(o["dispatched_at"]) == today),
		"times": {k: summarise_hours([o["times"][k] for o in orders]) for k in ("wait", "pack", "ship", "total")},
		"stuck": [o["name"] for o in stuck[:25]],
		"stuck_count": len(stuck),
		"stuck_hours": stuck_hours,
		"series": {
			"picked": daily_counts([o["picked_at"] for o in submitted], today),
			"dispatched": daily_counts([o["dispatched_at"] for o in orders], today),
		},
		"accuracy": {"lines": lines, "short": short,
		             "percent": round(100 * (lines - short) / lines) if lines else None},
		"scanner_share": round(100 * sum(o["scan_mode"] for o in submitted) / len(submitted)) if submitted else None,
		"unknown_picker": sum(1 for o in submitted if not o["picked_by_known"]),
		"pickers": people_table(orders, "picked_by", today, week_from),
		"packers": people_table(orders, "packed_by", today, week_from),
		"unbilled": [o["name"] for o in unbilled[:25]],
		"unbilled_count": len(unbilled),
		"flows": {
			"Delivery Note": sum(1 for o in orders if o["flow"] == "Delivery Note"),
			"Sales Invoice": sum(1 for o in orders if o["flow"] == "Sales Invoice"),
		},
	}


# ─────────────────────────────────────────────────────────────
# Doc event: stamp who picked a Pick List
# ─────────────────────────────────────────────────────────────

def stamp_picker(doc, method=None):
	"""Pick List on_submit: record who submitted it and when (the picker, whether from
	Warehouse Scan or the desk). Older lists without a stamp fall back to `modified`."""
	if not doc.meta.has_field("wt_picked_by"):
		return
	doc.db_set({"wt_picked_by": frappe.session.user, "wt_picked_at": now_datetime()}, update_modified=False)


def clear_picker(doc, method=None):
	"""Pick List on_cancel: a cancelled list wasn't picked."""
	if doc.meta.has_field("wt_picked_by"):
		doc.db_set({"wt_picked_by": None, "wt_picked_at": None}, update_modified=False)


# ─────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────

def _has(doctype, field):
	try:
		return frappe.get_meta(doctype).has_field(field)
	except Exception:
		return False


def _pick_lists(company, days, floor):
	p = {"company": company or None, "from": add_days(nowdate(), -days), "limit": MAX_ORDERS,
	     "any_floor": 1, "whs": ("",), **access.wh_filter()}
	if floor:
		whs = [b.wh for b in get_floor_bins(floor)]
		if not whs:
			return []
		p.update(any_floor=0, whs=tuple(whs))
	lists = frappe.db.sql(
		"""
		SELECT pl.name, pl.docstatus, pl.status, pl.customer, pl.company, pl.creation, pl.modified,
		       pl.owner, pl._assign, IFNULL(pl.scan_mode, 0) AS scan_mode
		FROM `tabPick List` pl
		WHERE pl.purpose = 'Delivery' AND pl.docstatus < 2
		  AND (pl.docstatus = 0 OR pl.creation >= %(from)s)
		  AND (%(company)s IS NULL OR pl.company = %(company)s)
		  AND (%(any_floor)s = 1 OR EXISTS (
		        SELECT 1 FROM `tabPick List Item` f WHERE f.parent = pl.name AND f.warehouse IN %(whs)s))
		  AND (%(wh_all)s = 1 OR EXISTS (
		        SELECT 1 FROM `tabPick List Item` a WHERE a.parent = pl.name AND a.warehouse IN %(wh_list)s))
		ORDER BY pl.creation DESC
		LIMIT %(limit)s
		""",
		p,
		as_dict=True,
	)
	# Picker stamps are custom fields; read them only once `bench migrate` has added them.
	if lists and _has("Pick List", "wt_picked_by") and _has("Pick List", "wt_picked_at"):
		stamps = {r.name: r for r in frappe.db.sql(
			"SELECT name, wt_picked_by, wt_picked_at FROM `tabPick List` WHERE name IN %(names)s",
			{"names": tuple(pl.name for pl in lists)}, as_dict=True)}
		for pl in lists:
			st = stamps.get(pl.name)
			if st:
				pl.update(wt_picked_by=st.wt_picked_by, wt_picked_at=st.wt_picked_at)
	return lists


def _pick_rows(names):
	return frappe.db.sql(
		"""
		SELECT name, parent, sales_order, sales_order_item, IFNULL(stock_qty, qty) AS stock_qty,
		       IFNULL(picked_qty, 0) AS picked_qty
		FROM `tabPick List Item` WHERE parent IN %(names)s
		""",
		{"names": tuple(names)},
		as_dict=True,
	)


def _delivery_notes(names):
	"""Delivery Notes (not returns, not cancelled) made from these Pick Lists."""
	return frappe.db.sql(
		"""
		SELECT dni.against_pick_list AS pick_list, dn.name, dn.docstatus, dn.posting_date, dn.posting_time,
		       dn.creation, dn.owner, IFNULL(dn.per_billed, 0) AS per_billed, SUM(dni.stock_qty) AS qty
		FROM `tabDelivery Note Item` dni
		INNER JOIN `tabDelivery Note` dn ON dn.name = dni.parent
		WHERE dni.against_pick_list IN %(names)s AND dn.docstatus < 2 AND IFNULL(dn.is_return, 0) = 0
		GROUP BY dni.against_pick_list, dn.name
		""",
		{"names": tuple(names)},
		as_dict=True,
	)


def _packing_slips(dn_names):
	if not dn_names:
		return {}
	out = defaultdict(list)
	for r in frappe.db.sql(
		"""
		SELECT name, delivery_note, creation, owner FROM `tabPacking Slip`
		WHERE delivery_note IN %(dns)s AND docstatus = 1 ORDER BY creation
		""",
		{"dns": tuple(dn_names)},
		as_dict=True,
	):
		out[r.delivery_note].append(r)
	return out


def _stock_invoices(rows):
	"""Stock-updating Sales Invoices (not returns, not cancelled) for these Pick List rows,
	keyed by Pick List. Matched by pick_list_item where ERPNext has it, else by Sales Order line."""
	by_row = {r.name: r.parent for r in rows}
	by_so_line = defaultdict(set)
	for r in rows:
		if r.sales_order_item:
			by_so_line[r.sales_order_item].add(r.parent)
	if not by_so_line and not by_row:
		return {}
	# Two fixed queries rather than one built from parts: by Sales Order line (v15 and v16),
	# and by pick_list_item where Sales Invoice Item has it (v16). A line found by both counts once.
	found = {}
	if by_so_line:
		for r in frappe.db.sql(
			"""
			SELECT sii.name AS row_name, si.name, si.docstatus, si.posting_date, si.posting_time, si.creation,
			       si.owner, sii.so_detail, sii.stock_qty
			FROM `tabSales Invoice Item` sii
			INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
			WHERE sii.so_detail IN %(so_lines)s
			  AND si.update_stock = 1 AND si.docstatus < 2 AND IFNULL(si.is_return, 0) = 0
			""",
			{"so_lines": tuple(by_so_line)},
			as_dict=True,
		):
			r["pick_list_item"] = None
			found[r.row_name] = r
	if by_row and _has("Sales Invoice Item", "pick_list_item"):
		for r in frappe.db.sql(
			"""
			SELECT sii.name AS row_name, si.name, si.docstatus, si.posting_date, si.posting_time, si.creation,
			       si.owner, sii.so_detail, sii.pick_list_item, sii.stock_qty
			FROM `tabSales Invoice Item` sii
			INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
			WHERE sii.pick_list_item IN %(pl_rows)s
			  AND si.update_stock = 1 AND si.docstatus < 2 AND IFNULL(si.is_return, 0) = 0
			""",
			{"pl_rows": tuple(by_row)},
			as_dict=True,
		):
			found[r.row_name] = r
	found = list(found.values())
	out = defaultdict(dict)
	for r in found:
		lists = {by_row[r.pick_list_item]} if r.pick_list_item in by_row else by_so_line.get(r.so_detail, set())
		for pl in lists:
			inv = out[pl].setdefault(r.name, dict(r, qty=0))
			inv["qty"] += _flt(r.stock_qty)
	return {pl: list(v.values()) for pl, v in out.items()}


def load_orders(company=None, days=30, floor=None):
	"""Every delivery Pick List still open, or created in the last `days`, with its stage."""
	lists = _pick_lists(company, days, floor)
	if not lists:
		return []
	names = [pl.name for pl in lists]
	rows = _pick_rows(names)
	rows_by = defaultdict(list)
	for r in rows:
		rows_by[r.parent].append(r)
	dns = _delivery_notes(names)
	dns_by = defaultdict(list)
	for d in dns:
		dns_by[d.pick_list].append(d)
	slips = _packing_slips(list({d.name for d in dns}))
	sis = _stock_invoices(rows)
	now = now_datetime()
	return [build_order(pl, rows_by[pl.name], dns_by[pl.name], slips, sis.get(pl.name, []), now) for pl in lists]


def _full_names(users):
	users = [u for u in users if u]
	if not users:
		return {}
	return {r.name: r.full_name or r.name for r in frappe.db.sql(
		"SELECT name, full_name FROM `tabUser` WHERE name IN %(u)s", {"u": tuple(set(users))}, as_dict=True)}


def _system_view(company, orders):
	"""Setup and data quality for System Managers."""
	p = {"company": company or None, **access.wh_filter()}
	mapped = {r.t: _int(r.n) for r in frappe.db.sql(
		"""
		SELECT wt_warehouse_type AS t, COUNT(*) AS n FROM `tabWarehouse`
		WHERE IFNULL(wt_warehouse_type, '') != '' AND disabled = 0
		  AND (%(company)s IS NULL OR company = %(company)s)
		  AND (%(wh_all)s = 1 OR name IN %(wh_list)s)
		GROUP BY wt_warehouse_type
		""", p, as_dict=True)}
	unmapped = frappe.db.sql(
		"""
		SELECT w.name AS warehouse, SUM(b.stock_value) AS value, COUNT(DISTINCT b.item_code) AS items
		FROM `tabBin` b INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
		WHERE b.actual_qty > 0 AND IFNULL(w.wt_warehouse_type, '') = '' AND w.is_group = 0
		  AND (%(company)s IS NULL OR w.company = %(company)s)
		  AND (%(wh_all)s = 1 OR w.name IN %(wh_list)s)
		GROUP BY w.name ORDER BY value DESC
		""", p, as_dict=True)
	no_capacity = _int(frappe.db.sql(
		"""
		SELECT COUNT(*) FROM `tabWarehouse` w
		WHERE w.wt_warehouse_type IN ('Bin', 'Zone') AND w.disabled = 0
		  AND (%(company)s IS NULL OR w.company = %(company)s)
		  AND (%(wh_all)s = 1 OR w.name IN %(wh_list)s)
		  AND NOT EXISTS (SELECT 1 FROM `tabWarehouse UOM Capacity` c WHERE c.parent = w.name AND c.capacity > 0)
		""", p)[0][0])
	stock_whs = frappe.db.sql(
		"""
		SELECT COUNT(DISTINCT w.name) FROM `tabWarehouse` w
		WHERE w.wt_warehouse_type IN ('Bin', 'Zone') AND w.disabled = 0
		  AND (%(company)s IS NULL OR w.company = %(company)s)
		  AND (%(wh_all)s = 1 OR w.name IN %(wh_list)s)
		""", p)[0][0]
	roles = {r.role: _int(r.n) for r in frappe.db.sql(
		"""
		SELECT hr.role, COUNT(DISTINCT u.name) AS n FROM `tabHas Role` hr
		INNER JOIN `tabUser` u ON u.name = hr.parent
		WHERE hr.parenttype = 'User' AND u.enabled = 1 AND u.user_type = 'System User'
		  AND hr.role IN ('Stock User', 'Stock Manager', 'System Manager')
		  AND u.name NOT IN ('Administrator', 'Guest')
		GROUP BY hr.role
		""", as_dict=True)}
	names = [o["name"] for o in orders]
	off_map = {"rows": 0, "unmapped": 0}
	if names:
		r = frappe.db.sql(
			"""
			SELECT COUNT(*) AS n_rows, SUM(IFNULL(w.wt_warehouse_type, '') NOT IN ('Bin', 'Zone')) AS n_off
			FROM `tabPick List Item` pli LEFT JOIN `tabWarehouse` w ON w.name = pli.warehouse
			WHERE pli.parent IN %(names)s
			""", {"names": tuple(names)}, as_dict=True)[0]
		off_map = {"rows": _int(r.n_rows), "unmapped": _int(r.n_off)}
	return {
		"mapped": mapped,
		"unmapped_with_stock": len(unmapped),
		"unmapped_top": [dict(r, value=_flt(r.value)) for r in unmapped[:10]],
		"locations": _int(stock_whs),
		"no_capacity": no_capacity,
		"users": roles,
		"pick_rows_off_map": off_map,
	}


def _capacity_alert_count(company):
	try:
		from warehouse_theatre_3d.warehouse_theatre_3d.api.insights import compute_capacity_alerts, get_alert_thresholds
		bin_t, floor_t = get_alert_thresholds()
		from warehouse_theatre_3d.warehouse_theatre_3d.api import access
		return len(compute_capacity_alerts(company, bin_t, floor_t, access.allowed_warehouses())["bins"])
	except Exception:
		return None


def _serialise(o, can_see):
	o = dict(o)
	for k in ("created", "picked_at", "packed_at", "dispatched_at"):
		if o.get(k):
			o[k] = _dt(o[k]).isoformat(sep=" ", timespec="minutes")
	o["docs"] = [d for d in o["docs"] if can_see.get(d["doctype"])]
	return o


# ─────────────────────────────────────────────────────────────
# Endpoint
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_operations(company: str | None = None, days: int | str = 30, floor: str | None = None, refresh: int | str = 0):
	"""Everything the Operations view shows. Every view role gets Orders and My work;
	Stock Managers and System Managers also get Team; System Managers also get System.
	Cached for two minutes per user and filter."""
	_require_view_permission()
	if not frappe.has_permission("Pick List", "read"):
		frappe.throw(_("You need read access to Pick Lists to see fulfillment status."), frappe.PermissionError)
	days = max(1, min(_int(days) or 30, 180))
	user = frappe.session.user
	key = f"wt3d:operations:{user}:{company or ''}:{days}:{floor or ''}"
	cache = frappe.cache()
	if not _int(refresh):
		hit = cache.get_value(key)
		if hit:
			return hit

	roles = set(frappe.get_roles())
	is_manager = bool(roles & MANAGER_ROLES)
	is_admin = bool(roles & EDIT_ROLES)
	today = getdate(nowdate())
	orders = load_orders(company or None, days, floor or None)

	result = {
		"as_of": now_datetime().isoformat(sep=" ", timespec="minutes"),
		"user": user, "days": days, "company": company or None, "floor": floor or None,
		"access": {"manager": is_manager, "admin": is_admin},
		"stages": list(STAGES),
		"me": my_work(orders, user, today),
	}
	if is_manager:
		team = team_view(orders, today, days)
		team["capacity_alerts"] = _capacity_alert_count(company or None)
		result["team"] = team
	if is_admin:
		result["system"] = _system_view(company or None, orders)

	people = {o.get("picked_by") for o in orders} | {o.get("packed_by") for o in orders}
	for o in orders:
		people.update(o["assigned"])
	result["names"] = _full_names(people | {user})
	can_see = {dt: bool(frappe.has_permission(dt, "read")) for dt in ("Delivery Note", "Sales Invoice")}
	result["orders"] = [_serialise(o, can_see) for o in orders]
	cache.set_value(key, result, expires_in_sec=CACHE_SECONDS)
	return result
