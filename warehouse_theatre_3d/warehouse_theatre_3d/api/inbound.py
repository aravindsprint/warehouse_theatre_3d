"""Receiving against Purchase Orders, quality hold, and customer returns (Warehouse Scan).

Receive: open a Purchase Order, scan what arrived (good and damaged counted apart),
and post a Purchase Receipt made with ERPNext's own make_purchase_receipt. Damaged
goods use ERPNext's rejected quantity and rejected warehouse. Items that need checking
(the Item's "Inspection Required before Purchase", or every receipt when Warehouse
Theatre Settings says so) are received into the Quality hold warehouse instead of the
PO's warehouse.

Quality hold: stock waiting in the Quality hold warehouse. Release sends it to putaway
(api.operations planning, from the hold warehouse); reject moves it to the Rejected
warehouse with a Material Transfer.

Returns: open a submitted Delivery Note or Sales Invoice, scan what came back, mark
each line good (back to stock) or damaged (to the Rejected warehouse), and make the
return with ERPNext's own make_sales_return. Delivery Note returns can be submitted
here; Sales Invoice returns are credit notes, so they stay drafts for accounts.

Every write uses the user's own ERPNext permissions.
"""

import frappe
from frappe import _

from warehouse_theatre_3d.warehouse_theatre_3d.api import access
from warehouse_theatre_3d.warehouse_theatre_3d.api.common import _flt, _int, _require_view_permission, parse_json
from warehouse_theatre_3d.warehouse_theatre_3d.api.operations import _build_transfer, _doc_url

EPS = 1e-9
RETURN_SOURCES = ("Delivery Note", "Sales Invoice")


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def receipt_plan(lines, counts, hold_all=False):
	"""Which PO lines to receive and how. lines: [{"line", "pending", "inspect"}];
	counts: [{"line", "good", "damaged"}] (PO UOM). Returns [{"line", "qty", "rejected",
	"hold", "over"}] for lines with anything counted. Raises ValueError on bad input."""
	by_line = {ln["line"]: ln for ln in lines}
	out = []
	for c in counts or []:
		key = c.get("line")
		good, bad = _flt(c.get("good")), _flt(c.get("damaged"))
		if good < -EPS or bad < -EPS:
			raise ValueError("Counts can't be negative.")
		if good + bad <= EPS:
			continue
		ln = by_line.get(key)
		if not ln:
			raise ValueError(f"Line {key} isn't on this Purchase Order.")
		out.append({"line": key, "qty": round(good, 6), "rejected": round(bad, 6),
		            "hold": bool(hold_all or ln.get("inspect")) and good > EPS,
		            "over": good + bad > _flt(ln.get("pending")) + EPS})
	if not out:
		raise ValueError("Nothing was counted.")
	return out


def return_plan(lines, counts):
	"""Which delivered lines come back. lines: [{"line", "returnable"}]; counts:
	[{"line", "good", "damaged"}]. A line returned in both conditions becomes two rows.
	Returns [{"line", "qty", "condition"}]. Raises ValueError when more than returnable."""
	by_line = {ln["line"]: ln for ln in lines}
	out = []
	for c in counts or []:
		key = c.get("line")
		good, bad = _flt(c.get("good")), _flt(c.get("damaged"))
		if good < -EPS or bad < -EPS:
			raise ValueError("Counts can't be negative.")
		if good + bad <= EPS:
			continue
		ln = by_line.get(key)
		if not ln:
			raise ValueError(f"Line {key} isn't on this document.")
		if good + bad > _flt(ln.get("returnable")) + EPS:
			raise ValueError(f"Only {_flt(ln.get('returnable')):g} of that line can still be returned.")
		if good > EPS:
			out.append({"line": key, "qty": round(good, 6), "condition": "good"})
		if bad > EPS:
			out.append({"line": key, "qty": round(bad, 6), "condition": "damaged"})
	if not out:
		raise ValueError("Nothing was counted.")
	return out


# ─────────────────────────────────────────────────────────────
# Settings
# ─────────────────────────────────────────────────────────────

def settings():
	try:
		s = frappe.get_cached_doc("Warehouse Theatre Settings")
		get = s.get
	except Exception:
		get = {}.get
	return {"qc_warehouse": get("qc_warehouse"), "rejected_warehouse": get("rejected_warehouse"),
	        "returns_warehouse": get("returns_warehouse"), "hold_all_receipts": _int(get("hold_all_receipts"))}


def _barcodes(item_codes):
	if not item_codes:
		return {}
	return {r.barcode: [r.parent, r.uom] for r in frappe.get_all(
		"Item Barcode", filters={"parent": ["in", list(item_codes)]}, fields=["barcode", "parent", "uom"])}


# ─────────────────────────────────────────────────────────────
# Receive
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_open_purchase_orders(company: str | None = None, txt: str | None = None):
	"""Submitted Purchase Orders still to receive, oldest due first."""
	_require_view_permission()
	filters = {"docstatus": 1, "per_received": ["<", 100], "status": ["not in", ["Closed", "On Hold", "Completed"]]}
	if company:
		filters["company"] = company
	or_filters = {"name": ["like", f"%{txt}%"], "supplier_name": ["like", f"%{txt}%"]} if txt else None
	cos = access.allowed_companies()
	rows = frappe.get_list("Purchase Order", filters=filters, or_filters=or_filters,
	                       fields=["name", "supplier", "supplier_name", "schedule_date", "per_received", "company"],
	                       order_by="schedule_date asc, creation asc", limit_page_length=50)
	return [r for r in rows if cos is None or r.company in cos]


def _po_lines(doc):
	return [{
		"line": it.name, "idx": it.idx, "item_code": it.item_code, "item_name": it.item_name,
		"qty": _flt(it.qty), "received": _flt(it.received_qty), "pending": max(0.0, _flt(it.qty) - _flt(it.received_qty)),
		"uom": it.uom, "stock_uom": it.stock_uom, "factor": _flt(it.conversion_factor) or 1, "warehouse": it.warehouse,
		"inspect": bool(frappe.db.get_value("Item", it.item_code, "inspection_required_before_purchase")),
	} for it in doc.items]


@frappe.whitelist(allow_guest=False)
def get_purchase_order(name: str):
	_require_view_permission()
	doc = frappe.get_doc("Purchase Order", name)
	doc.check_permission("read")
	lines = _po_lines(doc)
	st = settings()
	return {"name": doc.name, "supplier": doc.supplier, "supplier_name": doc.supplier_name, "company": doc.company,
	        "docstatus": doc.docstatus, "status": doc.status, "schedule_date": str(doc.schedule_date or ""),
	        "lines": lines, "barcodes": _barcodes({ln["item_code"] for ln in lines}),
	        "hold_all": st["hold_all_receipts"], "qc_warehouse": st["qc_warehouse"], "rejected_warehouse": st["rejected_warehouse"],
	        "can_receive": bool(doc.docstatus == 1 and frappe.has_permission("Purchase Receipt", "create")),
	        "url": _doc_url("Purchase Order", doc.name)}


@frappe.whitelist(allow_guest=False, methods=["POST"])
def receive(purchase_order: str, counts: str | list, supplier_delivery_note: str | None = None, submit: int | str = 1):
	"""Post a Purchase Receipt for what was counted against a Purchase Order."""
	_require_view_permission()
	from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_receipt

	po = frappe.get_doc("Purchase Order", purchase_order)
	po.check_permission("read")
	st = settings()
	try:
		plan = receipt_plan(_po_lines(po), parse_json(counts, []), st["hold_all_receipts"])
	except ValueError as e:
		frappe.throw(str(e))
	if any(p["hold"] for p in plan) and not st["qc_warehouse"]:
		frappe.throw(_("Set a Quality hold warehouse in Warehouse Theatre Settings to hold receipts for checking."))
	if any(p["rejected"] for p in plan) and not st["rejected_warehouse"]:
		frappe.throw(_("Set a Rejected warehouse in Warehouse Theatre Settings to receive damaged goods."))
	by_line = {p["line"]: p for p in plan}
	pr = make_purchase_receipt(po.name)
	keep = []
	for it in pr.items:
		p = by_line.get(it.purchase_order_item)
		if not p:
			continue
		it.qty = p["qty"]
		it.rejected_qty = p["rejected"]
		it.received_qty = p["qty"] + p["rejected"]
		if p["hold"]:
			it.warehouse = st["qc_warehouse"]
		if p["rejected"]:
			it.rejected_warehouse = st["rejected_warehouse"]
		keep.append(it)
	pr.set("items", keep)
	if supplier_delivery_note:
		pr.supplier_delivery_note = supplier_delivery_note
	pr.remarks = _("Received with Warehouse Scan")
	pr.run_method("set_missing_values")
	pr.run_method("calculate_taxes_and_totals")
	pr.insert()
	submitted, note = False, None
	needs_qi = [it.item_code for it in pr.items if frappe.db.get_value("Item", it.item_code, "inspection_required_before_purchase")
	            and not it.get("quality_inspection")]
	tracked = any(frappe.db.get_value("Item", it.item_code, "has_batch_no") or frappe.db.get_value("Item", it.item_code, "has_serial_no")
	              for it in pr.items)
	if needs_qi:
		note = _("Saved as a draft: ERPNext needs a Quality Inspection for {0} before it can be submitted.").format(", ".join(needs_qi))
	elif tracked:
		note = _("Saved as a draft: add batch or serial numbers in ERPNext, then submit.")
	elif _int(submit):
		pr.submit()
		submitted = True
	held = sorted({it.item_code for it in pr.items if it.warehouse == st["qc_warehouse"]}) if st["qc_warehouse"] else []
	return {"name": pr.name, "docstatus": pr.docstatus, "submitted": submitted, "note": note, "held": held,
	        "over": [p["line"] for p in plan if p["over"]], "url": _doc_url("Purchase Receipt", pr.name),
	        "putaway_ready": submitted and len(held) < len({it.item_code for it in pr.items})}


# ─────────────────────────────────────────────────────────────
# Quality hold
# ─────────────────────────────────────────────────────────────

@frappe.whitelist(allow_guest=False)
def get_quality_hold():
	"""Stock waiting in the Quality hold warehouse."""
	_require_view_permission()
	st = settings()
	qc = st["qc_warehouse"]
	if not qc:
		return {"warehouse": None, "items": [], "rejected_warehouse": st["rejected_warehouse"]}
	access.require(qc)
	items = frappe.db.sql(
		"""
		SELECT b.item_code, i.item_name, i.stock_uom AS uom, b.actual_qty AS qty,
		       i.has_batch_no, i.has_serial_no,
		       (SELECT MAX(sle.posting_date) FROM `tabStock Ledger Entry` sle
		        WHERE sle.item_code = b.item_code AND sle.warehouse = b.warehouse
		          AND sle.actual_qty > 0 AND sle.is_cancelled = 0) AS since
		FROM `tabBin` b INNER JOIN `tabItem` i ON i.name = b.item_code
		WHERE b.warehouse = %(wh)s AND b.actual_qty > 0
		ORDER BY since, b.item_code
		""",
		{"wh": qc},
		as_dict=True,
	)
	for r in items:
		r["since"] = str(r.since) if r.since else None
	return {"warehouse": qc, "items": items, "rejected_warehouse": st["rejected_warehouse"]}


@frappe.whitelist(allow_guest=False, methods=["POST"])
def reject_held(item_code: str, qty: float, reason: str | None = None):
	"""Move stock that failed checking from the Quality hold to the Rejected warehouse."""
	_require_view_permission()
	st = settings()
	if not st["qc_warehouse"] or not st["rejected_warehouse"]:
		frappe.throw(_("Set the Quality hold and Rejected warehouses in Warehouse Theatre Settings."))
	access.require(st["qc_warehouse"])
	access.require(st["rejected_warehouse"])
	se, tracked = _build_transfer([{"item_code": item_code, "qty": _flt(qty), "s_warehouse": st["qc_warehouse"],
	                                "t_warehouse": st["rejected_warehouse"]}],
	                              remarks=_("Rejected at quality check") + (f": {reason}" if reason else ""))
	se.insert()
	if not tracked:
		se.submit()
	return {"name": se.name, "docstatus": se.docstatus, "url": _doc_url("Stock Entry", se.name),
	        "needs_batch_or_serial": tracked}


# ─────────────────────────────────────────────────────────────
# Customer returns
# ─────────────────────────────────────────────────────────────

def _returned(doctype, name):
	"""{source line: qty already returned}, counting submitted and draft returns."""
	if doctype == "Delivery Note":
		rows = frappe.db.sql(
			"""
			SELECT ri.dn_detail AS line, SUM(-ri.qty) AS qty
			FROM `tabDelivery Note Item` ri INNER JOIN `tabDelivery Note` r ON r.name = ri.parent
			WHERE r.is_return = 1 AND r.return_against = %(name)s AND r.docstatus < 2
			GROUP BY ri.dn_detail
			""", {"name": name}, as_dict=True)
	else:
		rows = frappe.db.sql(
			"""
			SELECT ri.sales_invoice_item AS line, SUM(-ri.qty) AS qty
			FROM `tabSales Invoice Item` ri INNER JOIN `tabSales Invoice` r ON r.name = ri.parent
			WHERE r.is_return = 1 AND r.return_against = %(name)s AND r.docstatus < 2
			GROUP BY ri.sales_invoice_item
			""", {"name": name}, as_dict=True)
	return {r.line: _flt(r.qty) for r in rows}


@frappe.whitelist(allow_guest=False)
def get_return_source(doctype: str, name: str):
	"""A submitted Delivery Note / Sales Invoice with what can still come back."""
	_require_view_permission()
	if doctype not in RETURN_SOURCES:
		frappe.throw(_("Returns can be taken against a Delivery Note or Sales Invoice."))
	doc = frappe.get_doc(doctype, name)
	doc.check_permission("read")
	if doc.docstatus != 1 or doc.get("is_return"):
		frappe.throw(_("{0} isn't a submitted delivery.").format(name))
	if doctype == "Sales Invoice" and not doc.get("update_stock"):
		frappe.throw(_("{0} didn't move stock. Return against its Delivery Note.").format(name))
	done = _returned(doctype, name)
	lines = [{"line": it.name, "idx": it.idx, "item_code": it.item_code, "item_name": it.item_name, "uom": it.uom,
	          "factor": _flt(it.get("conversion_factor")) or 1,
	          "qty": _flt(it.qty), "returned": done.get(it.name, 0),
	          "returnable": max(0.0, _flt(it.qty) - done.get(it.name, 0)), "warehouse": it.warehouse,
	          "batch_no": it.get("batch_no")} for it in doc.items]
	st = settings()
	return {"doctype": doctype, "name": doc.name, "customer": doc.customer, "customer_name": doc.get("customer_name"),
	        "posting_date": str(doc.posting_date), "lines": lines, "barcodes": _barcodes({ln["item_code"] for ln in lines}),
	        "returns_warehouse": st["returns_warehouse"], "rejected_warehouse": st["rejected_warehouse"],
	        "can_submit": doctype == "Delivery Note" and bool(frappe.has_permission("Delivery Note", "submit")),
	        "url": _doc_url(doctype, doc.name)}


@frappe.whitelist(allow_guest=False, methods=["POST"])
def make_return(doctype: str, name: str, counts: str | list, reason: str | None = None, submit: int | str = 0):
	"""Make the return with ERPNext's make_sales_return, keeping only what was counted.
	Good goods go back to the Returns warehouse (or where they came from); damaged ones
	to the Rejected warehouse."""
	_require_view_permission()
	if doctype not in RETURN_SOURCES:
		frappe.throw(_("Returns can be taken against a Delivery Note or Sales Invoice."))
	src = get_return_source(doctype, name)
	try:
		plan = return_plan(src["lines"], parse_json(counts, []))
	except ValueError as e:
		frappe.throw(str(e))
	st = settings()
	if any(p["condition"] == "damaged" for p in plan) and not st["rejected_warehouse"]:
		frappe.throw(_("Set a Rejected warehouse in Warehouse Theatre Settings to take back damaged goods."))
	if doctype == "Delivery Note":
		from erpnext.stock.doctype.delivery_note.delivery_note import make_sales_return
		ref = "dn_detail"
	else:
		from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_sales_return
		ref = "sales_invoice_item"
	ret = make_sales_return(name)
	mapped = {it.get(ref): it for it in ret.items}
	rows = []
	for p in plan:
		base = mapped.get(p["line"])
		if not base:
			continue
		row = dict(base.as_dict())
		for k in ("name", "idx", "parent", "parenttype", "parentfield", "docstatus"):
			row.pop(k, None)
		row["qty"] = -p["qty"]
		row["stock_qty"] = -p["qty"] * (_flt(row.get("conversion_factor")) or 1)
		if p["condition"] == "damaged":
			row["warehouse"] = st["rejected_warehouse"]
		elif st["returns_warehouse"]:
			row["warehouse"] = st["returns_warehouse"]
		rows.append(row)
	if not rows:
		frappe.throw(_("Nothing to return."))
	ret.set("items", [])
	for row in rows:
		ret.append("items", row)
	if reason:
		ret.remarks = _("Customer return: {0}").format(reason)
	ret.run_method("set_missing_values")
	ret.run_method("calculate_taxes_and_totals")
	ret.insert()
	submitted = False
	if _int(submit) and doctype == "Delivery Note":
		ret.submit()
		submitted = True
	return {"doctype": doctype, "name": ret.name, "docstatus": ret.docstatus, "submitted": submitted,
	        "good": sum(p["qty"] for p in plan if p["condition"] == "good"),
	        "damaged": sum(p["qty"] for p in plan if p["condition"] == "damaged"),
	        "to_warehouse": st["returns_warehouse"], "url": _doc_url(doctype, ret.name)}
