"""Daily capacity alert email (scheduled from hooks.scheduler_events)."""

import frappe
from frappe.utils import cint, get_url, nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api.insights import compute_capacity_alerts


def _recipients(raw):
	parts = (raw or "").replace(";", ",").replace("\n", ",").split(",")
	return [p.strip() for p in parts if p.strip() and "@" in p]


def build_alert_html(alerts, bin_threshold, floor_threshold, max_rows=50):
	rows = "".join(
		f"<tr><td>{frappe.utils.escape_html(b['floor_label'] or b['floor'])}</td>"
		f"<td>{frappe.utils.escape_html(b['slot_label'] or b['slot'])}</td>"
		f"<td>{frappe.utils.escape_html(b['label'] or b['wh'])}</td>"
		f"<td style='text-align:right'><b>{b['fill']}%</b></td></tr>"
		for b in alerts["bins"][:max_rows]
	)
	floors = "".join(
		f"<li>{frappe.utils.escape_html(f['floor_label'] or f['floor'])}: <b>{f['fill']}%</b> average across {f['bins']} bins</li>"
		for f in alerts["floors"]
	)
	more = len(alerts["bins"]) - max_rows
	link = get_url("/warehouse-theatre-3d")
	return (
		f"<p>Warehouse Theatre 3D capacity check for {nowdate()}.</p>"
		+ (f"<p><b>Floors at or above {floor_threshold:g}%</b></p><ul>{floors}</ul>" if floors else "")
		+ (
			f"<p><b>Bins at or above {bin_threshold:g}%</b></p>"
			"<table border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse'>"
			"<tr><th>Floor</th><th>Slot</th><th>Bin</th><th>Fill</th></tr>"
			f"{rows}</table>"
			if rows else ""
		)
		+ (f"<p>…and {more} more.</p>" if more > 0 else "")
		+ f"<p><a href='{link}'>Open Warehouse Theatre 3D</a></p>"
	)


def send_capacity_alerts():
	try:
		settings = frappe.get_single("Warehouse Theatre Settings")
	except Exception:
		return
	if not cint(settings.enable_capacity_alerts):
		return
	recipients = _recipients(settings.alert_recipients)
	if not recipients:
		return

	bin_t = settings.bin_threshold or 95
	floor_t = settings.floor_threshold or 85
	alerts = compute_capacity_alerts(None, bin_t, floor_t)
	if not alerts["bins"] and not alerts["floors"]:
		return

	frappe.sendmail(
		recipients=recipients,
		subject=f"Warehouse capacity alert: {len(alerts['bins'])} bins, {len(alerts['floors'])} floors over limit",
		message=build_alert_html(alerts, bin_t, floor_t),
	)
