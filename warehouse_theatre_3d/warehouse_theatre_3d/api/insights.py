"""Read-only analytics for Warehouse Theatre: heatmap metrics, item locator, timeline replay
and capacity alerts. Every endpoint here only reads data.
"""

from datetime import timedelta

import frappe
from frappe import _
from frappe.utils import add_days, getdate, nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api import access
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import (
	_flt,
	_int,
	_require_view_permission,
	bin_fill_percent,
	get_floor_bins,
	get_uom_capacities,
	get_uom_quantities,
)

AGEING_WINDOW_DAYS = 730   # inward history scanned for FIFO age; older stock counts as this age
MAX_TIMELINE_DAYS = 366


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def fifo_age_days(current_qty, inward_rows, today, cap_days=AGEING_WINDOW_DAYS):
	"""Quantity-weighted age of the stock on hand, assuming first-in-first-out.

	inward_rows: [(posting_date, qty)] newest first. The newest receipts are the ones
	still on the shelf under FIFO, so we walk back until current_qty is covered.
	Anything not covered by the scanned window is treated as `cap_days` old.
	"""
	current_qty = _flt(current_qty)
	if current_qty <= 0:
		return None
	remaining = current_qty
	weighted = 0.0
	for posting_date, qty in inward_rows:
		qty = _flt(qty)
		if qty <= 0:
			continue
		take = min(qty, remaining)
		weighted += take * max(0, (today - getdate(posting_date)).days)
		remaining -= take
		if remaining <= 0:
			break
	if remaining > 0:
		weighted += remaining * cap_days
	return round(weighted / current_qty)


def daily_change_lists(deltas, from_date, to_date):
	"""One entry per calendar day (including days with no movement) so the replay
	slider moves at a constant pace.

	deltas: {date_iso: {wh: {uom: delta}}}
	Returns (dates, changes) where changes[i] = [[wh, uom, delta], ...] for dates[i].
	The browser adds these onto the opening balance, which keeps the payload to one
	row per actual movement instead of a full copy of every bin per day.
	"""
	dates, changes = [], []
	d = getdate(from_date)
	end = getdate(to_date)
	while d <= end:
		key = d.isoformat()
		day = []
		for wh, uoms in sorted((deltas.get(key) or {}).items()):
			for uom, delta in sorted(uoms.items()):
				if _flt(delta):
					day.append([wh, uom, round(_flt(delta), 6)])
		dates.append(key)
		changes.append(day)
		d += timedelta(days=1)
	return dates, changes


# ─────────────────────────────────────────────────────────────
# Heatmap metrics
# ─────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_bin_metrics(group_warehouse: str, days: int | str = 90):
	"""Per-Bin metrics for the heatmap modes on one Floor.

	velocity: outward movements in the last `days` days
	value:    current stock value
	ageing:   FIFO-estimated age of the stock on hand (days)
	expiry:   days until the earliest batch expiry among batches still in the bin
	picks:    Pick List rows pointing at the bin in the last `days` days
	"""
	_require_view_permission()
	days = max(1, min(_int(days) or 90, 730))
	access.require_floor(group_warehouse)
	bins = access.keep(get_floor_bins(group_warehouse), access.allowed_warehouses(), "wh")
	whs = [b.wh for b in bins]
	metrics = {wh: {} for wh in whs}
	if not whs:
		return {"metrics": metrics, "days": days, "as_of": nowdate()}

	params = {"whs": tuple(whs), "from": add_days(nowdate(), -days)}
	today = getdate(nowdate())

	for r in frappe.db.sql(
		"""
		SELECT warehouse, SUM(stock_value) AS value, SUM(actual_qty) AS qty
		FROM `tabBin` WHERE warehouse IN %(whs)s GROUP BY warehouse
		""",
		params,
		as_dict=True,
	):
		metrics[r.warehouse].update(value=_flt(r.value), qty=_flt(r.qty))

	for r in frappe.db.sql(
		"""
		SELECT warehouse, COUNT(*) AS out_txn, SUM(-actual_qty) AS out_qty
		FROM `tabStock Ledger Entry`
		WHERE warehouse IN %(whs)s AND is_cancelled = 0
		  AND actual_qty < 0 AND posting_date >= %(from)s
		GROUP BY warehouse
		""",
		params,
		as_dict=True,
	):
		metrics[r.warehouse].update(out_txn=_int(r.out_txn), out_qty=_flt(r.out_qty))

	for r in frappe.db.sql(
		"""
		SELECT warehouse, MAX(posting_date) AS last_move
		FROM `tabStock Ledger Entry`
		WHERE warehouse IN %(whs)s AND is_cancelled = 0
		GROUP BY warehouse
		""",
		params,
		as_dict=True,
	):
		if r.last_move:
			metrics[r.warehouse]["last_move"] = str(r.last_move)
			metrics[r.warehouse]["idle_days"] = (today - getdate(r.last_move)).days

	_add_ageing(metrics, params, today)
	_add_expiry(metrics, params, today)

	try:
		for r in frappe.db.sql(
			"""
			SELECT pli.warehouse, COUNT(*) AS picks
			FROM `tabPick List Item` pli
			INNER JOIN `tabPick List` pl ON pl.name = pli.parent
			WHERE pli.warehouse IN %(whs)s AND pl.docstatus < 2 AND pl.creation >= %(from)s
			GROUP BY pli.warehouse
			""",
			params,
			as_dict=True,
		):
			metrics[r.warehouse]["picks"] = _int(r.picks)
	except Exception:
		frappe.log_error(title="Warehouse Theatre: pick counts failed")

	return {"metrics": metrics, "days": days, "as_of": nowdate()}


def _add_ageing(metrics, params, today):
	bin_qty = {}
	for r in frappe.db.sql(
		"""
		SELECT warehouse, item_code, actual_qty FROM `tabBin`
		WHERE warehouse IN %(whs)s AND actual_qty > 0
		""",
		params,
		as_dict=True,
	):
		bin_qty[(r.warehouse, r.item_code)] = _flt(r.actual_qty)
	if not bin_qty:
		return

	inward = {}
	for r in frappe.db.sql(
		"""
		SELECT warehouse, item_code, posting_date, actual_qty
		FROM `tabStock Ledger Entry`
		WHERE warehouse IN %(whs)s AND is_cancelled = 0 AND actual_qty > 0
		  AND posting_date >= %(age_from)s
		ORDER BY posting_date DESC, creation DESC
		""",
		dict(params, age_from=add_days(nowdate(), -AGEING_WINDOW_DAYS)),
		as_dict=True,
	):
		inward.setdefault((r.warehouse, r.item_code), []).append((r.posting_date, r.actual_qty))

	per_bin = {}
	for (wh, item), qty in bin_qty.items():
		age = fifo_age_days(qty, inward.get((wh, item), []), today)
		if age is None:
			continue
		agg = per_bin.setdefault(wh, {"qty": 0.0, "weighted": 0.0, "oldest": None, "oldest_age": -1})
		agg["qty"] += qty
		agg["weighted"] += qty * age
		if age > agg["oldest_age"]:
			agg["oldest"], agg["oldest_age"] = item, age
	for wh, agg in per_bin.items():
		if agg["qty"] > 0:
			metrics[wh].update(
				age_days=round(agg["weighted"] / agg["qty"]),
				oldest_item=agg["oldest"],
				oldest_age=agg["oldest_age"],
			)


def _batch_balances(params):
	"""{(warehouse, batch_no): qty} from v15 Serial and Batch Bundles plus legacy SLE.batch_no."""
	balances = {}
	queries = [
		"""
		SELECT sbb.warehouse, sbe.batch_no, SUM(sbe.qty) AS qty
		FROM `tabSerial and Batch Entry` sbe
		INNER JOIN `tabSerial and Batch Bundle` sbb ON sbb.name = sbe.parent
		WHERE sbb.warehouse IN %(whs)s AND sbb.docstatus = 1 AND sbb.is_cancelled = 0
		  AND IFNULL(sbe.batch_no, '') != ''
		GROUP BY sbb.warehouse, sbe.batch_no
		""",
		"""
		SELECT warehouse, batch_no, SUM(actual_qty) AS qty
		FROM `tabStock Ledger Entry`
		WHERE warehouse IN %(whs)s AND is_cancelled = 0
		  AND IFNULL(batch_no, '') != '' AND IFNULL(serial_and_batch_bundle, '') = ''
		GROUP BY warehouse, batch_no
		""",
	]
	for q in queries:
		try:
			for r in frappe.db.sql(q, params, as_dict=True):
				key = (r.warehouse, r.batch_no)
				balances[key] = balances.get(key, 0.0) + _flt(r.qty)
		except Exception:
			# Table/column missing on this ERPNext version - the other source still counts.
			pass
	return {k: v for k, v in balances.items() if v > 0}


def _add_expiry(metrics, params, today):
	balances = _batch_balances(params)
	if not balances:
		return
	batches = list({b for _wh, b in balances})
	expiry = {
		r.name: r.expiry_date
		for r in frappe.db.sql(
			"SELECT name, expiry_date FROM `tabBatch` WHERE name IN %(b)s AND expiry_date IS NOT NULL",
			{"b": tuple(batches)},
			as_dict=True,
		)
	}
	for (wh, batch), _qty in balances.items():
		exp = expiry.get(batch)
		if not exp:
			continue
		days_left = (getdate(exp) - today).days
		m = metrics[wh]
		if m.get("expiry_days") is None or days_left < m["expiry_days"]:
			m.update(expiry_days=days_left, expiry_batch=batch, expiry_date=str(exp))
		if days_left < 0:
			m["expired_batches"] = m.get("expired_batches", 0) + 1


# ─────────────────────────────────────────────────────────────
# Item locator
# ─────────────────────────────────────────────────────────────

@frappe.whitelist()
def search_items(txt: str = "", limit: int | str = 15):
	_require_view_permission()
	txt = (txt or "").strip()
	if not txt:
		return []
	like = f"%{txt}%"
	return frappe.db.sql(
		"""
		SELECT name AS item_code, item_name, stock_uom
		FROM `tabItem`
		WHERE disabled = 0 AND (name LIKE %(like)s OR item_name LIKE %(like)s)
		ORDER BY (name = %(txt)s) DESC, (name LIKE %(start)s) DESC, name
		LIMIT %(limit)s
		""",
		{"like": like, "txt": txt, "start": f"{txt}%", "limit": min(_int(limit) or 15, 50)},
		as_dict=True,
	)


@frappe.whitelist()
def resolve_scan(code: str):
	"""Turn a scanned barcode/QR value into an item (and an exact bin for serial numbers)."""
	_require_view_permission()
	code = (code or "").strip()
	if not code:
		return None

	item = frappe.db.get_value("Item Barcode", {"barcode": code}, "parent")
	if item:
		return {"item_code": item, "via": "barcode"}
	if frappe.db.exists("Item", code):
		return {"item_code": code, "via": "item_code"}
	batch_item = frappe.db.get_value("Batch", code, "item")
	if batch_item:
		return {"item_code": batch_item, "via": "batch", "batch_no": code}
	serial = frappe.db.get_value("Serial No", code, ["item_code", "warehouse"], as_dict=True)
	if serial:
		return {"item_code": serial.item_code, "via": "serial_no",
		        "warehouse": serial.warehouse if access.can_see(serial.warehouse) else None}
	return None


@frappe.whitelist()
def locate_item(item_code: str, company: str | None = None):
	"""Every warehouse holding the item, resolved to Floor/Slot/Bin where it is mapped."""
	_require_view_permission()
	if not item_code:
		return {"item": None, "locations": []}
	item = frappe.db.get_value("Item", item_code, ["name", "item_name", "stock_uom"], as_dict=True)
	if not item:
		frappe.throw(_("Item {0} not found").format(item_code))

	rows = frappe.db.sql(
		"""
		SELECT b.warehouse AS wh, w.warehouse_name AS label, w.wt_warehouse_type AS wt_type,
		       b.actual_qty AS qty, b.reserved_qty AS reserved, b.stock_value AS value,
		       s.name AS slot, s.warehouse_name AS slot_label,
		       f.name AS floor, f.warehouse_name AS floor_label,
		       zf.name AS zone_floor, zf.warehouse_name AS zone_floor_label
		FROM `tabBin` b
		INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
		LEFT JOIN `tabWarehouse` s ON s.name = w.parent_warehouse AND s.wt_warehouse_type = 'Slot'
		LEFT JOIN `tabWarehouse` f ON f.name = s.parent_warehouse AND f.wt_warehouse_type = 'Floor'
		LEFT JOIN `tabWarehouse` zf ON zf.name = w.parent_warehouse AND zf.wt_warehouse_type = 'Floor'
		WHERE b.item_code = %(item)s AND b.actual_qty != 0
		  AND (%(company)s IS NULL OR w.company = %(company)s)
		ORDER BY b.actual_qty DESC
		""",
		{"item": item_code, "company": company or None},
		as_dict=True,
	)
	for r in rows:
		if r.wt_type == "Zone":
			# Floor storage: the Zone is the slot; its floor is the parent Floor, or the
			# Zone itself for a godown kept as a single warehouse.
			r.update(slot=r.wh, slot_label=r.label, label="Floor stack",
			         floor=r.zone_floor or r.wh, floor_label=r.zone_floor_label or r.label)
		r["mapped"] = bool(r.wt_type in ("Bin", "Zone") and r.slot and r.floor)
		r.pop("zone_floor", None)
		r.pop("zone_floor_label", None)
	return {"item": item, "locations": access.keep(rows, access.allowed_warehouses(), "wh")}


# ─────────────────────────────────────────────────────────────
# Timeline replay
# ─────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_timeline(group_warehouse: str, from_date: str | None = None, to_date: str | None = None):
	"""Daily per-Bin, per-UOM balances on one Floor, rebuilt from the Stock Ledger."""
	_require_view_permission()
	to_date = getdate(to_date or nowdate())
	from_date = getdate(from_date or add_days(to_date, -30))
	if from_date > to_date:
		from_date, to_date = to_date, from_date
	if (to_date - from_date).days > MAX_TIMELINE_DAYS:
		from_date = to_date - timedelta(days=MAX_TIMELINE_DAYS)

	access.require_floor(group_warehouse)
	whs = [b.wh for b in access.keep(get_floor_bins(group_warehouse), access.allowed_warehouses(), "wh")]
	if not whs:
		return {"dates": [], "start": {}, "changes": [], "from_date": str(from_date), "to_date": str(to_date)}
	params = {"whs": tuple(whs), "from": from_date, "to": to_date}

	start = {}
	for r in frappe.db.sql(
		"""
		SELECT sle.warehouse, i.stock_uom AS uom, SUM(sle.actual_qty) AS qty
		FROM `tabStock Ledger Entry` sle INNER JOIN `tabItem` i ON i.name = sle.item_code
		WHERE sle.warehouse IN %(whs)s AND sle.is_cancelled = 0 AND sle.posting_date < %(from)s
		GROUP BY sle.warehouse, i.stock_uom
		""",
		params,
		as_dict=True,
	):
		start.setdefault(r.warehouse, {})[r.uom] = _flt(r.qty)

	deltas = {}
	for r in frappe.db.sql(
		"""
		SELECT sle.posting_date, sle.warehouse, i.stock_uom AS uom, SUM(sle.actual_qty) AS qty
		FROM `tabStock Ledger Entry` sle INNER JOIN `tabItem` i ON i.name = sle.item_code
		WHERE sle.warehouse IN %(whs)s AND sle.is_cancelled = 0
		  AND sle.posting_date BETWEEN %(from)s AND %(to)s
		GROUP BY sle.posting_date, sle.warehouse, i.stock_uom
		""",
		params,
		as_dict=True,
	):
		key = getdate(r.posting_date).isoformat()
		deltas.setdefault(key, {}).setdefault(r.warehouse, {})[r.uom] = _flt(r.qty)

	dates, changes = daily_change_lists(deltas, from_date, to_date)
	return {
		"dates": dates,
		"start": start,
		"changes": changes,
		"from_date": str(from_date),
		"to_date": str(to_date),
	}


# ─────────────────────────────────────────────────────────────
# Capacity alerts (UI badge; the daily email lives in warehouse_theatre_3d.alerts)
# ─────────────────────────────────────────────────────────────

def compute_capacity_alerts(company=None, bin_threshold=95, floor_threshold=85, allowed=None):
	"""Bins and Floors whose fill % is at or above the thresholds. Only bins with a UOM
	capacity configured are considered, since fill % is meaningless without one.
	allowed: only these warehouses (a user's User Permissions); None for all."""
	bins = frappe.db.sql(
		"""
		SELECT b.name AS wh, b.warehouse_name AS label, s.name AS slot, s.warehouse_name AS slot_label,
		       f.name AS floor, f.warehouse_name AS floor_label
		FROM `tabWarehouse` b
		INNER JOIN `tabWarehouse` s ON s.name = b.parent_warehouse AND s.wt_warehouse_type = 'Slot' AND s.disabled = 0
		INNER JOIN `tabWarehouse` f ON f.name = s.parent_warehouse AND f.wt_warehouse_type = 'Floor' AND f.disabled = 0
		WHERE b.wt_warehouse_type = 'Bin' AND b.disabled = 0
		  AND (%(company)s IS NULL OR b.company = %(company)s)
		""",
		{"company": company or None},
		as_dict=True,
	)
	zones = frappe.db.sql(
		"""
		SELECT z.name AS wh, 'Floor stack' AS label, z.name AS slot, z.warehouse_name AS slot_label,
		       IF(IFNULL(p.wt_warehouse_type, '') = 'Floor', p.name, z.name) AS floor,
		       IF(IFNULL(p.wt_warehouse_type, '') = 'Floor', p.warehouse_name, z.warehouse_name) AS floor_label
		FROM `tabWarehouse` z
		LEFT JOIN `tabWarehouse` p ON p.name = z.parent_warehouse
		WHERE z.wt_warehouse_type = 'Zone' AND z.disabled = 0
		  AND (p.name IS NULL OR p.disabled = 0)
		  AND (%(company)s IS NULL OR z.company = %(company)s)
		""",
		{"company": company or None},
		as_dict=True,
	)
	bins = access.keep(list(bins) + list(zones), allowed, "wh")
	whs = [b.wh for b in bins]
	caps = get_uom_capacities(whs)
	qtys = get_uom_quantities(whs)

	bin_alerts, floors = [], {}
	for b in bins:
		fill = bin_fill_percent(caps.get(b.wh), qtys.get(b.wh))
		if fill is None:
			continue
		f = floors.setdefault(b.floor, {"floor": b.floor, "floor_label": b.floor_label, "total": 0, "n": 0})
		f["total"] += fill
		f["n"] += 1
		if fill >= _flt(bin_threshold):
			bin_alerts.append(dict(b, fill=fill))

	floor_alerts = []
	for f in floors.values():
		avg = round(f["total"] / f["n"])
		if avg >= _flt(floor_threshold):
			floor_alerts.append({"floor": f["floor"], "floor_label": f["floor_label"], "fill": avg, "bins": f["n"]})

	bin_alerts.sort(key=lambda r: -r["fill"])
	floor_alerts.sort(key=lambda r: -r["fill"])
	return {"bins": bin_alerts, "floors": floor_alerts}


def get_alert_thresholds():
	try:
		s = frappe.get_cached_doc("Warehouse Theatre Settings")
		return _flt(s.bin_threshold) or 95, _flt(s.floor_threshold) or 85
	except Exception:
		return 95, 85


@frappe.whitelist()
def get_capacity_alerts(company: str | None = None):
	_require_view_permission()
	bin_t, floor_t = get_alert_thresholds()
	out = compute_capacity_alerts(company, bin_t, floor_t, access.allowed_warehouses())
	out.update(bin_threshold=bin_t, floor_threshold=floor_t)
	return out
