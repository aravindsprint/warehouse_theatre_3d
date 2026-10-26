"""Stock Health: inventory problems found from data every ERPNext site already has.

Works without the warehouse mapping (no Floor/Slot/Bin roles needed), so it's useful
the moment the app is installed. Read-only.
"""

import frappe
from frappe.utils import add_days, getdate, nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api import access
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import _flt, _int, _require_view_permission

HISTORY_DAYS = 730          # how far back movements are scanned; older counts as "over 2 years"
SLOW_COVER_DAYS = 180       # stock that would last longer than this at the current outward rate is slow
AGE_BUCKETS = [(30, "0–30 days"), (90, "31–90 days"), (180, "91–180 days"), (365, "181–365 days"), (None, "Over a year")]
LIST_LIMIT = 50
CACHE_SECONDS = 600


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def fifo_layers(current_qty, inward_rows, today, cap_days=HISTORY_DAYS):
	"""Split the stock on hand into (qty, age_days) layers, assuming first-in-first-out.

	inward_rows: [(posting_date, qty)] newest first. Stock not covered by the scanned
	receipts is returned as one layer aged `cap_days`.
	"""
	remaining = _flt(current_qty)
	layers = []
	if remaining <= 0:
		return layers
	for posting_date, qty in inward_rows:
		qty = _flt(qty)
		if qty <= 0:
			continue
		take = min(qty, remaining)
		layers.append((take, max(0, (today - getdate(posting_date)).days)))
		remaining -= take
		if remaining <= 1e-9:
			break
	if remaining > 1e-9:
		layers.append((remaining, cap_days))
	return layers


def bucket_index(age_days):
	for i, (limit, _label) in enumerate(AGE_BUCKETS):
		if limit is None or age_days <= limit:
			return i
	return len(AGE_BUCKETS) - 1


def classify_movement(items, moves, days, today, slow_cover_days=SLOW_COVER_DAYS):
	"""Split items in stock into dead stock (no outward movement in `days`) and slow
	movers (would take longer than `slow_cover_days` to use up at the current rate).

	items: {item_code: {"qty", "value", ...}}; moves: {item_code: {"last_out", "out_qty"}}
	Returns (dead, slow), each sorted by stock value, highest first.
	"""
	dead, slow = [], []
	for code, it in items.items():
		if _flt(it.get("qty")) <= 0:
			continue
		mv = moves.get(code) or {}
		out_qty = _flt(mv.get("out_qty"))
		last_out = mv.get("last_out")
		idle = (today - getdate(last_out)).days if last_out else None
		row = dict(it, item_code=code, last_out=str(last_out) if last_out else None, idle_days=idle, out_qty=out_qty)
		if out_qty <= 0:
			dead.append(row)
		else:
			cover = _flt(it["qty"]) / (out_qty / days)
			if cover > slow_cover_days:
				slow.append(dict(row, cover_days=round(cover)))
	dead.sort(key=lambda r: -_flt(r.get("value")))
	slow.sort(key=lambda r: -_flt(r.get("value")))
	return dead, slow


# ─────────────────────────────────────────────────────────────
# Endpoint
# ─────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_stock_health(company: str | None = None, days: int | str = 90, expiry_days: int | str = 60, refresh: int | str = 0):
	"""Everything the Stock Health page shows, for one company or all.

	days: period for dead stock / slow movers. expiry_days: how far ahead to look for
	expiring batches. Results are cached for 10 minutes per user and filter.
	"""
	_require_view_permission()
	days = max(7, min(_int(days) or 90, HISTORY_DAYS))
	expiry_days = max(0, min(_int(expiry_days) or 60, 365))
	key = f"wt3d:stock_health:{frappe.session.user}:{company or ''}:{days}:{expiry_days}"
	cache = frappe.cache()
	if not _int(refresh):
		hit = cache.get_value(key, expires=True)
		if hit:
			return hit
	result = _compute(company or None, days, expiry_days)
	cache.set_value(key, result, expires_in_sec=CACHE_SECONDS)
	return result


def _compute(company, days, expiry_days):
	today = getdate(nowdate())
	p = {
		"company": company,
		"from": add_days(today, -days),
		"history_from": add_days(today, -HISTORY_DAYS),
		"expiry_to": add_days(today, expiry_days),
		"today": today,
		**access.wh_filter(),   # the user's User Permissions on Warehouse / Company
	}

	bins = frappe.db.sql(
		"""
		SELECT b.item_code, b.warehouse, b.actual_qty, b.projected_qty, b.stock_value,
		       i.item_name, i.stock_uom, i.item_group
		FROM `tabBin` b
		INNER JOIN `tabItem` i ON i.name = b.item_code
		INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
		WHERE b.actual_qty != 0
		  AND (%(company)s IS NULL OR w.company = %(company)s)
		  AND (%(wh_all)s = 1 OR b.warehouse IN %(wh_list)s)
		""",
		p,
		as_dict=True,
	)

	items, by_wh, negative = {}, {}, []
	for b in bins:
		qty = _flt(b.actual_qty)
		if qty < 0:
			negative.append({
				"item_code": b.item_code, "item_name": b.item_name, "warehouse": b.warehouse,
				"qty": qty, "uom": b.stock_uom,
			})
			continue
		it = items.setdefault(b.item_code, {
			"item_name": b.item_name, "uom": b.stock_uom, "item_group": b.item_group,
			"qty": 0.0, "value": 0.0, "warehouses": 0,
		})
		it["qty"] += qty
		it["value"] += _flt(b.stock_value)
		it["warehouses"] += 1
		w = by_wh.setdefault(b.warehouse, {"warehouse": b.warehouse, "value": 0.0, "items": 0})
		w["value"] += _flt(b.stock_value)
		w["items"] += 1

	moves = {
		r.item_code: r
		for r in frappe.db.sql(
			"""
			SELECT item_code,
			       MAX(CASE WHEN actual_qty < 0 THEN posting_date END) AS last_out,
			       SUM(CASE WHEN actual_qty < 0 AND posting_date >= %(from)s THEN -actual_qty ELSE 0 END) AS out_qty
			FROM `tabStock Ledger Entry`
			WHERE is_cancelled = 0 AND posting_date >= %(history_from)s
			  AND (%(company)s IS NULL OR company = %(company)s)
			  AND (%(wh_all)s = 1 OR warehouse IN %(wh_list)s)
			GROUP BY item_code
			""",
			p,
			as_dict=True,
		)
	}
	dead, slow = classify_movement(items, moves, days, today)

	ageing = _ageing(items, p, today)
	expiring = _expiring_batches(p, today)
	reorder = _below_reorder(p)

	total_value = sum(_flt(it["value"]) for it in items.values())
	warehouses = sorted(by_wh.values(), key=lambda w: -w["value"])
	for w in warehouses:
		w["share"] = round(100 * w["value"] / total_value, 1) if total_value else 0
	negative.sort(key=lambda r: r["qty"])

	currency = (frappe.db.get_value("Company", company, "default_currency") if company else None) \
		or frappe.defaults.get_global_default("currency") or "INR"

	return {
		"as_of": str(today),
		"company": company,
		"currency": currency,
		"days": days,
		"expiry_days": expiry_days,
		"summary": {
			"total_value": round(total_value, 2),
			"items_in_stock": len(items),
			"warehouses_with_stock": len(by_wh),
			"dead_count": len(dead),
			"dead_value": round(sum(_flt(r["value"]) for r in dead), 2),
			"slow_count": len(slow),
			"slow_value": round(sum(_flt(r["value"]) for r in slow), 2),
			"aged_value": round(sum(b["value"] for b in ageing["buckets"][2:]), 2),   # older than 90 days
			"expiring_count": len(expiring),
			"expired_count": sum(1 for b in expiring if b["days_left"] < 0),
			"negative_count": len(negative),
			"reorder_count": len(reorder),
		},
		"dead": dead[:LIST_LIMIT],
		"slow": slow[:LIST_LIMIT],
		"ageing": ageing,
		"expiring": expiring[:LIST_LIMIT],
		"negative": negative[:LIST_LIMIT],
		"reorder": reorder[:LIST_LIMIT],
		"warehouses": warehouses[:15],
	}


def _ageing(items, p, today):
	"""Stock value by age bucket (FIFO from receipts), plus the oldest stock by value.

	Receipts are netted per voucher, so an internal transfer (out of one warehouse and
	into another in the same entry) doesn't make stock look new.
	"""
	inward = {}
	for r in frappe.db.sql(
		"""
		SELECT item_code, posting_date, SUM(actual_qty) AS qty
		FROM `tabStock Ledger Entry`
		WHERE is_cancelled = 0 AND posting_date >= %(history_from)s
		  AND (%(company)s IS NULL OR company = %(company)s)
		  AND (%(wh_all)s = 1 OR warehouse IN %(wh_list)s)
		GROUP BY item_code, voucher_type, voucher_no, posting_date
		HAVING SUM(actual_qty) > 0
		ORDER BY item_code, posting_date DESC
		""",
		p,
		as_dict=True,
	):
		inward.setdefault(r.item_code, []).append((r.posting_date, r.qty))

	buckets = [{"label": label, "value": 0.0, "qty_items": 0} for _limit, label in AGE_BUCKETS]
	oldest = []
	for code, it in items.items():
		qty = _flt(it["qty"])
		if qty <= 0:
			continue
		rate = _flt(it["value"]) / qty
		layers = fifo_layers(qty, inward.get(code, []), today)
		weighted = 0.0
		seen = set()
		for lqty, age in layers:
			i = bucket_index(age)
			buckets[i]["value"] += lqty * rate
			if i not in seen:
				buckets[i]["qty_items"] += 1
				seen.add(i)
			weighted += lqty * age
		avg = round(weighted / qty)
		old_value = sum(lq * rate for lq, age in layers if age > 180)
		if old_value > 0:
			oldest.append(dict(it, item_code=code, avg_age=avg, old_value=round(old_value, 2),
			                   max_age=max(a for _q, a in layers)))
	for b in buckets:
		b["value"] = round(b["value"], 2)
	oldest.sort(key=lambda r: -r["old_value"])
	return {"buckets": buckets, "oldest": oldest[:LIST_LIMIT], "history_days": HISTORY_DAYS}


def _expiring_batches(p, today):
	"""Batches with stock that have expired or expire within the window."""
	balances = {}
	queries = [
		# v15+: Serial and Batch Bundles
		"""
		SELECT sbe.batch_no, sbb.warehouse, SUM(sbe.qty) AS qty
		FROM `tabSerial and Batch Entry` sbe
		INNER JOIN `tabSerial and Batch Bundle` sbb ON sbb.name = sbe.parent
		INNER JOIN `tabWarehouse` w ON w.name = sbb.warehouse
		WHERE sbb.docstatus = 1 AND sbb.is_cancelled = 0 AND IFNULL(sbe.batch_no, '') != ''
		  AND (%(company)s IS NULL OR w.company = %(company)s)
		  AND (%(wh_all)s = 1 OR sbb.warehouse IN %(wh_list)s)
		GROUP BY sbe.batch_no, sbb.warehouse
		""",
		# older entries that carry batch_no on the ledger row itself
		"""
		SELECT batch_no, warehouse, SUM(actual_qty) AS qty
		FROM `tabStock Ledger Entry`
		WHERE is_cancelled = 0 AND IFNULL(batch_no, '') != '' AND IFNULL(serial_and_batch_bundle, '') = ''
		  AND (%(company)s IS NULL OR company = %(company)s)
		  AND (%(wh_all)s = 1 OR warehouse IN %(wh_list)s)
		GROUP BY batch_no, warehouse
		""",
	]
	for q in queries:
		try:
			for r in frappe.db.sql(q, p, as_dict=True):
				key = (r.batch_no, r.warehouse)
				balances[key] = balances.get(key, 0.0) + _flt(r.qty)
		except Exception:
			pass   # table or column missing on this ERPNext version; the other source still counts

	by_batch = {}
	for (batch, wh), qty in balances.items():
		if qty > 1e-9:
			b = by_batch.setdefault(batch, {"qty": 0.0, "warehouses": []})
			b["qty"] += qty
			b["warehouses"].append(wh)
	if not by_batch:
		return []

	rows = frappe.db.sql(
		"""
		SELECT b.name AS batch_no, b.item, b.expiry_date, i.item_name, i.stock_uom
		FROM `tabBatch` b INNER JOIN `tabItem` i ON i.name = b.item
		WHERE b.name IN %(batches)s AND b.expiry_date IS NOT NULL AND b.expiry_date <= %(expiry_to)s
		""",
		dict(p, batches=tuple(by_batch)),
		as_dict=True,
	)
	out = []
	for r in rows:
		b = by_batch[r.batch_no]
		out.append({
			"batch_no": r.batch_no, "item_code": r.item, "item_name": r.item_name, "uom": r.stock_uom,
			"expiry_date": str(r.expiry_date), "days_left": (getdate(r.expiry_date) - today).days,
			"qty": round(b["qty"], 3), "warehouses": sorted(b["warehouses"]),
		})
	out.sort(key=lambda r: r["days_left"])
	return out


def _below_reorder(p):
	"""Item Reorder rules whose warehouse is at or below the reorder level (projected qty,
	the same figure ERPNext's auto re-order uses)."""
	try:
		rules = frappe.db.sql(
			"""
			SELECT ir.parent AS item_code, ir.warehouse, ir.warehouse_reorder_level AS level,
			       ir.warehouse_reorder_qty AS reorder_qty, ir.material_request_type AS request_type,
			       i.item_name, i.stock_uom AS uom,
			       COALESCE(b.projected_qty, 0) AS projected, COALESCE(b.actual_qty, 0) AS actual
			FROM `tabItem Reorder` ir
			INNER JOIN `tabItem` i ON i.name = ir.parent AND i.disabled = 0
			INNER JOIN `tabWarehouse` w ON w.name = ir.warehouse
			LEFT JOIN `tabBin` b ON b.item_code = ir.parent AND b.warehouse = ir.warehouse
			WHERE ir.parenttype = 'Item' AND ir.warehouse_reorder_level > 0
			  AND (%(company)s IS NULL OR w.company = %(company)s)
			  AND (%(wh_all)s = 1 OR ir.warehouse IN %(wh_list)s)
			""",
			p,
			as_dict=True,
		)
	except Exception:
		return []
	out = [dict(r, shortfall=round(_flt(r.level) - _flt(r.projected), 3))
	       for r in rules if _flt(r.projected) <= _flt(r.level)]
	out.sort(key=lambda r: -r["shortfall"])
	return out
