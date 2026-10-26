"""Store-and-forward support for Warehouse Scan.

When the phone loses Wi-Fi in the middle of a save, the scanner keeps the request in an
outbox on the phone and sends it again later. A retry must never post twice, including
when the first attempt did reach the server and only the reply was lost. So every write
the scanner makes carries a client id (header X-WT-Client-Id), and the writes below are
wrapped with @replay_safe: the result of a finished request is remembered for a week
(after the database commit), a repeat of the same id gets that result back instead of
running again, and a repeat that arrives while the first is still running is refused so
the phone tries again a little later.
"""

import functools
import re

import frappe
from frappe import _

ONCE_SECONDS = 7 * 86400
RUNNING_SECONDS = 180
_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def client_id():
	"""The scanner's id for this request, or None (desk calls, old clients)."""
	try:
		cid = frappe.get_request_header("X-WT-Client-Id")
	except Exception:
		return None
	return cid if cid and _ID.match(cid) else None


def replay_safe(fn):
	"""Run a whitelisted write at most once per client id. Place under @frappe.whitelist."""
	@functools.wraps(fn)
	def wrapper(*args, **kwargs):
		cid = client_id()
		if not cid:
			return fn(*args, **kwargs)
		cache = frappe.cache()
		key = f"wt3d:once:{frappe.session.user}:{cid}"
		done = cache.get_value(key)
		if done is not None:
			return done.get("result")
		if cache.get_value(key + ":running"):
			frappe.throw(_("This is still being saved. It will be checked again shortly."))
		cache.set_value(key + ":running", 1, expires_in_sec=RUNNING_SECONDS)
		try:
			result = fn(*args, **kwargs)
		except Exception:
			cache.delete_value(key + ":running")
			raise

		def remember():
			cache.set_value(key, {"result": result}, expires_in_sec=ONCE_SECONDS)
			cache.delete_value(key + ":running")

		def forget():
			cache.delete_value(key + ":running")

		callbacks = getattr(frappe.db, "after_commit", None)
		if callbacks is not None and hasattr(callbacks, "add"):
			callbacks.add(remember)
			rollback = getattr(frappe.db, "after_rollback", None)
			if rollback is not None and hasattr(rollback, "add"):
				rollback.add(forget)
		else:
			remember()
		return result

	return wrapper
