"""Opt-in "Get updates" sign-up.

Nothing is sent unless a user fills in the card in the app, ticks the consent box and
presses Send. The details go to the publisher's ERPNext as a Lead, through a public
Web Form on that site. Nothing else (no stock data, no usage) is ever sent.
"""

import json
from datetime import date, timedelta

import frappe
from frappe import _
from frappe.utils import get_url, validate_email_address

from warehouse_theatre_3d import __version__
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import _require_view_permission

# The publisher's ERPNext site that receives sign-ups, e.g. "https://erp.example.com".
# Empty switches the sign-up card off everywhere.
UPDATES_SITE = ""
# Web Form on that site (Doctype: Lead, "Login Required" off). See README → Updates sign-up.
UPDATES_WEB_FORM = "warehouse-theatre-signup"
SNOOZE_DAYS = 30
STATE_KEY = "wt_signup_state"   # per-user default: "sent", "never" or "snooze:YYYY-MM-DD"


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def should_show(state, today=None):
	"""Whether to offer the card, given the user's saved state."""
	if not state:
		return True
	if state in ("sent", "never"):
		return False
	if state.startswith("snooze:"):
		return (today or date.today()).isoformat() >= state.split(":", 1)[1]
	return True


def lead_payload(form, site_url, app_version, web_form=UPDATES_WEB_FORM):
	"""The Web Form submission for one sign-up: only what the user typed, plus the site
	address (shown to the user on the card before sending)."""
	clean = {k: (str(form.get(k) or "").strip())[:140] for k in ("name", "email", "company", "phone")}
	return {
		"web_form": web_form,
		"data": json.dumps({
			"doctype": "Lead",
			"web_form_name": web_form,
			"first_name": clean["name"],
			"email_id": clean["email"],
			"company_name": clean["company"],
			"mobile_no": clean["phone"],
			"website": site_url,
		}),
	}


# ─────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────

def _state():
	return frappe.defaults.get_user_default(STATE_KEY) or ""


def _set_state(value):
	frappe.defaults.set_user_default(STATE_KEY, value)


@frappe.whitelist()
def get_signup_state():
	"""Whether the card should appear for this user. Only System Managers (who usually
	installed the app) are asked, and only when sign-ups are switched on."""
	_require_view_permission()
	enabled = bool(UPDATES_SITE)
	is_admin = "System Manager" in frappe.get_roles()
	return {
		"enabled": enabled,
		"show": enabled and is_admin and should_show(_state()),
		"site_url": get_url(),
		"app_version": __version__,
		"prefill": {
			"name": frappe.db.get_value("User", frappe.session.user, "full_name") or "",
			"email": frappe.session.user if "@" in (frappe.session.user or "") else "",
			"company": frappe.defaults.get_user_default("Company") or "",
		},
	}


@frappe.whitelist(methods=["POST"])
def submit_signup(name: str, email: str, consent: int | str, company: str = "", phone: str = ""):
	"""Send the sign-up the user filled in and agreed to send."""
	_require_view_permission()
	if not UPDATES_SITE:
		frappe.throw(_("Sign-ups are switched off in this version."))
	if str(consent) not in ("1", "true", "True"):
		frappe.throw(_("Please tick the box to agree before sending."))
	if not (name or "").strip():
		frappe.throw(_("Please enter your name."))
	email = (email or "").strip()
	if not validate_email_address(email):
		frappe.throw(_("Please enter a valid email address."))

	import requests

	payload = lead_payload({"name": name, "email": email, "company": company, "phone": phone},
	                       get_url(), __version__)
	try:
		resp = requests.post(
			UPDATES_SITE.rstrip("/") + "/api/method/frappe.website.doctype.web_form.web_form.accept",
			data=payload, timeout=10,
		)
		resp.raise_for_status()
	except Exception:
		frappe.log_error(title="Warehouse Theatre: updates sign-up failed")
		frappe.throw(_("Couldn't send right now. Please check the internet connection and try again later."))
	_set_state("sent")
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
def dismiss_signup(never: int | str = 0):
	"""Hide the card: for SNOOZE_DAYS, or for good."""
	_require_view_permission()
	if str(never) in ("1", "true", "True"):
		_set_state("never")
	else:
		_set_state("snooze:" + (date.today() + timedelta(days=SNOOZE_DAYS)).isoformat())
	return {"ok": True}
