"""Alerts for supervisors and pickers, in Frappe's notification bell (and by email
when a user's notification settings say so).

Hourly: orders stuck in a stage longer than the limit (Stock Managers), and pick shelves
that need an urgent refill because draft picks already want more than they hold (Stock
Users and Stock Managers). Daily: batches about to expire (Stock Managers). Each order,
shelf or batch is reported once a day, not every hour. Optional daily email digest to
the Alert Recipients in Warehouse Theatre Settings. Assignments from the work queue use
ERPNext's Assign To, which already notifies the picker.
"""

import frappe
from frappe.utils import add_days, cint, escape_html, get_url, getdate, nowdate

SEEN_SECONDS = 20 * 3600


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def stuck_orders(orders, hours):
	"""Orders not dispatched that have sat in their stage at least `hours`, longest first."""
	out = [o for o in orders if o.get("stage") != "dispatched" and (o.get("hours_in_stage") or 0) >= hours]
	return sorted(out, key=lambda o: -(o.get("hours_in_stage") or 0))


def fresh(items, key, seen):
	"""Items not reported yet. key(item) -> str; seen(str) -> bool."""
	return [i for i in items if not seen(key(i))]


def describe(kind, items, limit=5):
	"""(subject, body lines) for one alert."""
	n = len(items)
	if kind == "stuck":
		subject = f"{n} order{'s' if n != 1 else ''} stuck in picking, packing or dispatch"
		lines = [f"{o['name']}{' · ' + o['customer'] if o.get('customer') else ''}: {o['stage']} for {round(o.get('hours_in_stage') or 0)} h"
		         for o in items[:limit]]
	elif kind == "refill":
		subject = f"{n} pick shel{'f needs' if n == 1 else 'ves need'} an urgent refill"
		lines = [f"{t['item_code']} at {t.get('path') or t['warehouse']}: {t['on_hand']:g} on the shelf, {t['pending']:g} to pick"
		         for t in items[:limit]]
	else:
		subject = f"{n} batch{' expires' if n == 1 else 'es expire'} soon"
		lines = [f"{b['batch_no']} ({b['item_code']}): {'expired' if b['days_left'] < 0 else 'expires'} {b['expiry_date']}"
		         for b in items[:limit]]
	if n > limit:
		lines.append(f"…and {n - limit} more")
	return subject, lines


# ─────────────────────────────────────────────────────────────
# Site
# ─────────────────────────────────────────────────────────────

def _settings():
	try:
		s = frappe.get_single("Warehouse Theatre Settings")
	except Exception:
		return None
	if not s.meta.has_field("enable_ops_alerts") or not cint(s.get("enable_ops_alerts")):
		return None
	return s


def _users(roles):
	return frappe.db.sql_list(
		"""
		SELECT DISTINCT u.name FROM `tabUser` u INNER JOIN `tabHas Role` hr ON hr.parent = u.name AND hr.parenttype = 'User'
		WHERE u.enabled = 1 AND u.user_type = 'System User' AND u.name NOT IN ('Administrator', 'Guest')
		  AND hr.role IN %(roles)s
		""",
		{"roles": tuple(roles)},
	)


def _seen(key):
	return bool(frappe.cache().get_value("wt3d:notified:" + key))


def _mark(keys):
	for k in keys:
		frappe.cache().set_value("wt3d:notified:" + k, 1, expires_in_sec=SEEN_SECONDS)


def _notify(users, subject, lines, doctype=None, name=None):
	if not users:
		return
	from frappe.desk.doctype.notification_log.notification_log import enqueue_create_notification
	body = "<br>".join(escape_html(line) for line in lines) + f"<br><br><a href='{get_url('/warehouse-theatre-3d')}'>Open Warehouse Theatre 3D</a>"
	enqueue_create_notification(users, {
		"type": "Alert", "subject": escape_html(subject), "email_content": body,
		"document_type": doctype, "document_name": name, "from_user": "Administrator",
	})


def hourly():
	s = _settings()
	if not s:
		return
	from warehouse_theatre_3d.warehouse_theatre_3d.api.fulfillment import load_orders
	managers = _users(["Stock Manager"])
	hours = cint(s.get("stuck_hours")) or 24
	stuck = fresh(stuck_orders(load_orders(None, 30, None), hours), lambda o: f"stuck:{o['name']}:{o['stage']}", _seen)
	if stuck:
		subject, lines = describe("stuck", stuck)
		_notify(managers, subject, lines, "Pick List", stuck[0]["name"])
		_mark(f"stuck:{o['name']}:{o['stage']}" for o in stuck)

	if cint(s.get("notify_urgent_refills")):
		from warehouse_theatre_3d.warehouse_theatre_3d.api.replenish import plan
		today = nowdate()
		urgent = fresh([t for t in plan() if t["urgent"]], lambda t: f"refill:{t['name']}:{today}", _seen)
		if urgent:
			subject, lines = describe("refill", urgent)
			_notify(_users(["Stock User", "Stock Manager"]), subject, lines, "Warehouse Pick Face", urgent[0]["name"])
			_mark(f"refill:{t['name']}:{today}" for t in urgent)


def daily():
	s = _settings()
	if not s:
		return
	days = cint(s.get("notify_expiring_days"))
	digest = []
	if days > 0:
		from warehouse_theatre_3d.warehouse_theatre_3d.api.access import sql_params
		from warehouse_theatre_3d.warehouse_theatre_3d.api.health import _expiring_batches
		today = getdate(nowdate())
		batches = _expiring_batches({"company": None, "expiry_to": add_days(today, days), **sql_params(None)}, today)
		batches = fresh(batches, lambda b: f"batch:{b['batch_no']}:{today}", _seen)
		if batches:
			subject, lines = describe("expiry", batches)
			_notify(_users(["Stock Manager"]), subject, lines, "Batch", batches[0]["batch_no"])
			_mark(f"batch:{b['batch_no']}:{today}" for b in batches)
			digest.append((subject, lines))
	if cint(s.get("ops_alert_email")) and s.get("alert_recipients"):
		from warehouse_theatre_3d.warehouse_theatre_3d.api.fulfillment import load_orders
		stuck = stuck_orders(load_orders(None, 30, None), cint(s.get("stuck_hours")) or 24)
		if stuck:
			digest.insert(0, describe("stuck", stuck, limit=20))
		if digest:
			from warehouse_theatre_3d.alerts import _recipients
			html = "".join(f"<p><b>{escape_html(subj)}</b></p><ul>" + "".join(f"<li>{escape_html(line)}</li>" for line in lines) + "</ul>"
			               for subj, lines in digest)
			frappe.sendmail(recipients=_recipients(s.alert_recipients), subject=f"Warehouse Theatre: daily operations {nowdate()}",
			                message=html + f"<p><a href='{get_url('/warehouse-theatre-3d')}'>Open Warehouse Theatre 3D</a></p>")
