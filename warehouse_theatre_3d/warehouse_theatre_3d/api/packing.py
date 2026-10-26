"""Pack and Dispatch for Warehouse Scan.

Pack: open a picked order, scan its items into cartons, print carton labels.
Dispatch: scan an order (or its carton labels), enter the transporter and LR number,
and submit the outward document.

The outward document is ERPNext's own, in either flow (see api/fulfillment.py):

  Delivery Note flow   each carton is a submitted Packing Slip on the draft Delivery Note
                       (ERPNext's packed_qty on the Delivery Note lines tracks progress)
  Sales Invoice flow   a Sales Invoice with Update Stock on; Packing Slips can't point at an
                       invoice, so cartons are kept as JSON in the invoice's wt_cartons field

A carton label's code is "<document>/<carton no>", e.g. "MAT-DN-2026-00012/2".
Every write uses the user's own ERPNext permissions.
"""

import json
import re

import frappe
from frappe import _
from frappe.utils import getdate, now_datetime, nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api.common import _flt, _int, _require_view_permission, parse_json
from warehouse_theatre_3d.warehouse_theatre_3d.api.fulfillment import load_orders
from warehouse_theatre_3d.warehouse_theatre_3d.api.operations import _doc_url

FLOWS = ("Delivery Note", "Sales Invoice")
EPS = 1e-6
_CARTON = re.compile(r"^(?P<name>.+)/(?P<no>\d{1,4})$")


# ─────────────────────────────────────────────────────────────
# Pure helpers (unit-tested without a site)
# ─────────────────────────────────────────────────────────────

def carton_code(name, no):
	return f"{name}/{_int(no)}"


def parse_carton(code):
	"""("MAT-DN-0001", 2) for "MAT-DN-0001/2", else None."""
	m = _CARTON.match((code or "").strip())
	if not m or _int(m.group("no")) < 1:
		return None
	return m.group("name"), _int(m.group("no"))


def next_carton_no(cartons):
	return max((_int(c.get("no")) for c in cartons), default=0) + 1


def packed_by_line(cartons):
	out = {}
	for c in cartons:
		for ln in c.get("lines") or []:
			out[ln["line"]] = out.get(ln["line"], 0) + _flt(ln.get("qty"))
	return out


def check_carton(lines, remaining):
	"""Validate one carton's lines against what is left to pack on each document line.

	lines: [{"line", "qty"}]; remaining: {line: qty left}. Returns the cleaned lines
	(zero rows dropped, the same line merged). Raises ValueError with a readable message.
	"""
	merged = {}
	for ln in lines or []:
		key, qty = ln.get("line"), _flt(ln.get("qty"))
		if qty < 0:
			raise ValueError("A carton can't hold a negative quantity.")
		if qty <= EPS:
			continue
		if key not in remaining:
			raise ValueError(f"Line {key} isn't on this document.")
		merged[key] = merged.get(key, 0) + qty
	if not merged:
		raise ValueError("The carton is empty.")
	for key, qty in merged.items():
		if qty > remaining[key] + EPS:
			raise ValueError(f"Only {remaining[key]:g} left to pack on that line, not {qty:g}.")
	return [{"line": k, "qty": v} for k, v in merged.items()]


def invoice_lines_from_picks(pick_rows, so_items):
	"""Sales Invoice lines for what was actually picked.

	pick_rows: Pick List rows [{"name", "sales_order_item", "picked_qty" (stock UOM),
	"warehouse", "batch_no", "serial_no"}]. so_items: invoice lines mapped from the Sales
	Orders [{"so_detail", "conversion_factor", ...}]. A Sales Order line picked from two
	shelves becomes two invoice lines. Lines with nothing picked are dropped.
	"""
	by_so = {}
	for it in so_items:
		by_so.setdefault(it.get("so_detail"), it)
	out = []
	for r in pick_rows:
		base = by_so.get(r.get("sales_order_item"))
		picked = _flt(r.get("picked_qty"))
		if not base or picked <= EPS:
			continue
		line = dict(base)
		cf = _flt(base.get("conversion_factor")) or 1
		line.update(qty=round(picked / cf, 6), stock_qty=picked, warehouse=r.get("warehouse"), pick_list_row=r.get("name"))
		if r.get("batch_no") or r.get("serial_no"):
			line.update(batch_no=r.get("batch_no"), serial_no=r.get("serial_no"), use_serial_batch_fields=1)
		out.append(line)
	return out


def pack_progress(lines):
	"""{"lines", "done", "qty", "packed"} for lines [{"qty", "packed"}]."""
	qty = sum(_flt(x.get("qty")) for x in lines)
	packed = sum(min(_flt(x.get("packed")), _flt(x.get("qty"))) for x in lines)
	done = sum(1 for x in lines if _flt(x.get("packed")) + EPS >= _flt(x.get("qty")))
	return {"lines": len(lines), "done": done, "qty": round(qty, 6), "packed": round(packed, 6)}


# ─────────────────────────────────────────────────────────────
# Documents
# ─────────────────────────────────────────────────────────────

def _settings():
	try:
		s = frappe.get_cached_doc("Warehouse Theatre Settings")
		return {"flow": s.get("dispatch_document") if s.get("dispatch_document") in FLOWS else "Delivery Note",
		        "require_carton_scan": _int(s.get("require_carton_scan"))}
	except Exception:
		return {"flow": "Delivery Note", "require_carton_scan": 0}


def _check(doctype):
	if doctype not in FLOWS:
		frappe.throw(_("Only Delivery Notes and Sales Invoices can be packed here."))


def _cartons(doc):
	"""Cartons already packed on this document: [{"no", "lines": [{"line", "qty"}], "weight", "ref"}]."""
	if doc.doctype == "Delivery Note":
		slips = frappe.get_all("Packing Slip", filters={"delivery_note": doc.name, "docstatus": 1},
		                       fields=["name", "from_case_no", "to_case_no", "gross_weight_pkg"], order_by="from_case_no")
		items = {}
		if slips:
			for r in frappe.get_all("Packing Slip Item", filters={"parent": ["in", [s.name for s in slips]]},
			                        fields=["parent", "dn_detail", "qty"]):
				items.setdefault(r.parent, []).append({"line": r.dn_detail, "qty": _flt(r.qty)})
		return [{"no": _int(s.from_case_no), "to": _int(s.to_case_no or s.from_case_no), "ref": s.name,
		         "weight": _flt(s.gross_weight_pkg), "lines": items.get(s.name, [])} for s in slips]
	raw = doc.get("wt_cartons") if doc.meta.has_field("wt_cartons") else None
	return parse_json(raw, []) or []


def _lines(doc, cartons):
	packed = packed_by_line(cartons)
	return [{
		"line": it.name, "idx": it.idx, "item_code": it.item_code, "item_name": it.item_name,
		"qty": _flt(it.qty), "uom": it.uom, "stock_uom": it.stock_uom, "factor": _flt(it.conversion_factor) or 1,
		"packed": _flt(it.get("packed_qty")) if doc.doctype == "Delivery Note" else packed.get(it.name, 0),
		"warehouse": it.warehouse, "batch_no": it.get("batch_no"),
	} for it in doc.items]


def _barcodes(item_codes):
	"""{barcode: (item_code, uom)} so the phone can match scans without a round trip."""
	if not item_codes:
		return {}
	return {r.barcode: [r.parent, r.uom] for r in frappe.get_all(
		"Item Barcode", filters={"parent": ["in", list(item_codes)]}, fields=["barcode", "parent", "uom"])}


def pack_state(doctype, name):
	_check(doctype)
	doc = frappe.get_doc(doctype, name)
	doc.check_permission("read")
	cartons = _cartons(doc)
	lines = _lines(doc, cartons)
	pick_lists = sorted({it.get("against_pick_list") for it in doc.items if it.get("against_pick_list")})
	return {
		"doctype": doctype, "name": doc.name, "docstatus": doc.docstatus,
		"customer": doc.customer, "customer_name": doc.get("customer_name") or doc.customer,
		"address": (doc.get("shipping_address") or doc.get("address_display") or "").strip(),
		"company": doc.company, "posting_date": str(doc.posting_date) if doc.get("posting_date") else None,
		"pick_lists": pick_lists,
		"can_pack": bool(doc.docstatus == 0 and frappe.has_permission(doctype, "write", doc.name)
		                 and (doctype == "Sales Invoice" or frappe.has_permission("Packing Slip", "create"))),
		"can_dispatch": bool(doc.docstatus == 0 and frappe.has_permission(doctype, "submit", doc.name)),
		"lines": lines, "cartons": cartons, "progress": pack_progress(lines),
		"barcodes": _barcodes({ln["item_code"] for ln in lines}),
		"transport": {k: doc.get(k) for k in ("transporter_name", "lr_no", "lr_date", "vehicle_no") if doc.meta.has_field(k)},
		"require_carton_scan": _settings()["require_carton_scan"],
		"url": _doc_url(doctype, doc.name),
	}


def _drafts_for(pick_list):
	"""Draft and submitted outward documents already made from a Pick List."""
	dns = frappe.db.sql(
		"""
		SELECT DISTINCT dn.name, dn.docstatus FROM `tabDelivery Note Item` dni
		INNER JOIN `tabDelivery Note` dn ON dn.name = dni.parent
		WHERE dni.against_pick_list = %(pl)s AND dn.docstatus < 2 AND IFNULL(dn.is_return, 0) = 0
		""", {"pl": pick_list}, as_dict=True)
	sis = frappe.db.sql(
		"""
		SELECT DISTINCT si.name, si.docstatus FROM `tabSales Invoice Item` sii
		INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
		INNER JOIN `tabPick List Item` pli ON pli.parent = %(pl)s AND pli.sales_order_item = sii.so_detail
		WHERE si.update_stock = 1 AND si.docstatus < 2 AND IFNULL(si.is_return, 0) = 0
		""", {"pl": pick_list}, as_dict=True)
	return [("Delivery Note", d.name, d.docstatus) for d in dns] + [("Sales Invoice", s.name, s.docstatus) for s in sis]


def _make_delivery_note(pick_list):
	from erpnext.stock.doctype.pick_list.pick_list import create_delivery_note
	create_delivery_note(pick_list)
	frappe.clear_messages()   # ERPNext's "Delivery Note(s) created" popup means nothing on the phone
	made = [n for dt, n, ds in _drafts_for(pick_list) if dt == "Delivery Note" and ds == 0]
	if not made:
		frappe.throw(_("ERPNext didn't create a Delivery Note for {0}.").format(pick_list))
	return made[0]


def _make_sales_invoice(pick_list):
	pl = frappe.get_doc("Pick List", pick_list)
	pl.check_permission("read")
	if pl.docstatus != 1:
		frappe.throw(_("Submit the Pick List before packing it."))
	# ERPNext v16 builds stock invoices from a Pick List itself.
	try:
		from erpnext.stock.doctype.pick_list.pick_list import create_delivery
	except ImportError:
		create_delivery = None
	if create_delivery:
		create_delivery(pick_list, target="Sales Invoice")
		frappe.clear_messages()
	else:
		_make_sales_invoice_v15(pl)
	made = [n for dt, n, ds in _drafts_for(pick_list) if dt == "Sales Invoice" and ds == 0]
	if not made:
		frappe.throw(_("Couldn't create a Sales Invoice for {0}.").format(pick_list))
	return made[0]


def _make_sales_invoice_v15(pl):
	"""Map the Pick List's Sales Orders to one stock-updating invoice, then keep only what
	was picked, from the shelves it was picked from."""
	from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice

	sales_orders = []
	for r in pl.locations:
		if not r.sales_order:
			frappe.throw(_("Line {0} has no Sales Order. Use the Delivery Note flow for this Pick List.").format(r.idx))
		if r.sales_order not in sales_orders:
			sales_orders.append(r.sales_order)
	si = None
	for so in sales_orders:
		si = make_sales_invoice(so, target_doc=si)
	mapped = [it.as_dict() for it in si.items]
	lines = invoice_lines_from_picks([r.as_dict() for r in pl.locations], mapped)
	if not lines:
		frappe.throw(_("Nothing was picked on {0}.").format(pl.name))
	si.set("items", [])
	for ln in lines:
		ln.pop("pick_list_row", None)
		for k in ("name", "idx", "parent", "parenttype", "parentfield", "docstatus"):
			ln.pop(k, None)
		si.append("items", ln)
	si.update_stock = 1
	si.run_method("set_missing_values")
	si.run_method("calculate_taxes_and_totals")
	si.insert()
	return si.name


@frappe.whitelist(allow_guest=False, methods=["POST"])
def start_pack(pick_list: str | None = None, doctype: str | None = None, name: str | None = None,
               flow: str | None = None):
	"""Open an order for packing: an existing draft Delivery Note / Sales Invoice, or the
	draft made from a Pick List (created in the configured flow if there is none yet)."""
	_require_view_permission()
	if doctype and name:
		_check(doctype)
		return pack_state(doctype, name)
	if not pick_list:
		frappe.throw(_("Scan a Pick List, Delivery Note or Sales Invoice."))
	if not frappe.has_permission("Pick List", "read", pick_list):
		frappe.throw(_("You can't open Pick List {0}.").format(pick_list), frappe.PermissionError)
	docs = _drafts_for(pick_list)
	drafts = [(dt, n) for dt, n, ds in docs if ds == 0]
	if drafts:
		return pack_state(*drafts[0])
	if docs:
		frappe.throw(_("{0} is already dispatched ({1}).").format(pick_list, ", ".join(n for _dt, n, _ds in docs)))
	if frappe.db.get_value("Pick List", pick_list, "docstatus") != 1:
		frappe.throw(_("Submit {0} before packing it.").format(pick_list))
	flow = flow if flow in FLOWS else _settings()["flow"]
	name = _make_sales_invoice(pick_list) if flow == "Sales Invoice" else _make_delivery_note(pick_list)
	return pack_state(flow, name)


@frappe.whitelist(allow_guest=False)
def get_pack_state(doctype: str, name: str):
	_require_view_permission()
	return pack_state(doctype, name)


@frappe.whitelist(allow_guest=False, methods=["POST"])
def save_carton(doctype: str, name: str, lines: str | list, weight: float | None = None):
	"""Close one carton: a submitted Packing Slip (Delivery Note flow) or a carton entry on
	the draft invoice (Sales Invoice flow)."""
	_require_view_permission()
	_check(doctype)
	doc = frappe.get_doc(doctype, name)
	if doc.docstatus != 0:
		frappe.throw(_("{0} is already submitted, so it can't be packed any more.").format(name))
	doc.check_permission("write")
	cartons = _cartons(doc)
	state = _lines(doc, cartons)
	remaining = {ln["line"]: max(0.0, ln["qty"] - ln["packed"]) for ln in state}
	try:
		clean = check_carton(parse_json(lines, []), remaining)
	except ValueError as e:
		frappe.throw(str(e))
	no = next_carton_no(cartons)

	if doctype == "Delivery Note":
		by_line = {it.name: it for it in doc.items}
		slip = frappe.new_doc("Packing Slip")
		slip.delivery_note = doc.name
		slip.from_case_no = no
		slip.to_case_no = no
		if weight:
			slip.gross_weight_pkg = _flt(weight)
		for ln in clean:
			it = by_line[ln["line"]]
			slip.append("items", {"item_code": it.item_code, "item_name": it.item_name, "qty": ln["qty"],
			                      "stock_uom": it.uom, "dn_detail": it.name, "batch_no": it.get("batch_no")})
		slip.insert()
		slip.submit()
	else:
		if not doc.meta.has_field("wt_cartons"):
			frappe.throw(_("Run bench migrate to pack Sales Invoices (adds the Cartons field)."))
		cartons.append({"no": no, "lines": clean, "weight": _flt(weight) or None, "by": frappe.session.user,
		                "at": str(now_datetime())[:16]})
		doc.db_set("wt_cartons", json.dumps(cartons), update_modified=True)
	return pack_state(doctype, name)


@frappe.whitelist(allow_guest=False, methods=["POST"])
def remove_carton(doctype: str, name: str, no: int):
	"""Undo a carton packed by mistake (cancels its Packing Slip in the Delivery Note flow)."""
	_require_view_permission()
	_check(doctype)
	doc = frappe.get_doc(doctype, name)
	if doc.docstatus != 0:
		frappe.throw(_("{0} is already submitted.").format(name))
	doc.check_permission("write")
	no = _int(no)
	if doctype == "Delivery Note":
		slip = frappe.db.get_value("Packing Slip", {"delivery_note": name, "docstatus": 1, "from_case_no": no}, "name")
		if not slip:
			frappe.throw(_("Carton {0} not found.").format(no))
		frappe.get_doc("Packing Slip", slip).cancel()
	else:
		cartons = [c for c in _cartons(doc) if _int(c.get("no")) != no]
		doc.db_set("wt_cartons", json.dumps(cartons), update_modified=True)
	return pack_state(doctype, name)


@frappe.whitelist(allow_guest=False, methods=["POST"])
def dispatch(doctype: str, name: str, transporter_name: str | None = None, lr_no: str | None = None,
             vehicle_no: str | None = None, lr_date: str | None = None):
	"""Record the transport details and submit the Delivery Note / Sales Invoice."""
	_require_view_permission()
	_check(doctype)
	doc = frappe.get_doc(doctype, name)
	if doc.docstatus != 0:
		frappe.throw(_("{0} is already dispatched.").format(name))
	doc.check_permission("submit")
	given = {"transporter_name": transporter_name, "lr_no": lr_no, "vehicle_no": vehicle_no,
	         "lr_date": getdate(lr_date) if lr_date else (getdate(nowdate()) if lr_no else None)}
	missing = []
	for field, value in given.items():
		if not value:
			continue
		if doc.meta.has_field(field):
			doc.set(field, value)
		else:
			missing.append(f"{field.replace('_', ' ').title()}: {value}")
	if missing:
		# Sales Invoices have no transport fields without a localisation app: keep them in Remarks.
		note = "Dispatch — " + "; ".join(missing)
		doc.remarks = (doc.remarks + "\n" + note) if doc.get("remarks") and doc.remarks != "No Remarks" else note
	doc.save()
	doc.submit()
	return {"doctype": doctype, "name": doc.name, "docstatus": doc.docstatus, "url": _doc_url(doctype, doc.name),
	        "cartons": len(_cartons(doc)), "customer_name": doc.get("customer_name") or doc.customer}


def _queue(stages, company, floor):
	orders = load_orders(company or None, 30, floor or None)
	out = []
	for o in orders:
		if o["stage"] not in stages:
			continue
		drafts = [d for d in o["docs"] if d["docstatus"] == 0]
		out.append({"pick_list": o["name"], "customer": o["customer"], "stage": o["stage"], "lines": o["lines"],
		            "hours": o["hours_in_stage"], "docs": drafts, "flow": o["flow"]})
	out.sort(key=lambda o: -(o["hours"] or 0))
	return out


@frappe.whitelist(allow_guest=False)
def get_pack_queue(company: str | None = None, floor: str | None = None):
	"""Picked orders waiting to be packed (and packed ones still open), oldest first."""
	_require_view_permission()
	return _queue({"picked", "packed"}, company, floor)


@frappe.whitelist(allow_guest=False)
def get_dispatch_queue(company: str | None = None, floor: str | None = None):
	"""Orders ready to go out: packed, or picked with a draft Delivery Note / invoice."""
	_require_view_permission()
	return [o for o in _queue({"packed", "picked"}, company, floor) if o["docs"]]


@frappe.whitelist(allow_guest=False)
def get_carton_labels(doctype: str, name: str):
	"""What goes on each carton label."""
	_require_view_permission()
	st = pack_state(doctype, name)
	total = len(st["cartons"])
	items = {ln["line"]: ln for ln in st["lines"]}
	company_name = frappe.db.get_value("Company", st["company"], "company_name") or st["company"]
	return {
		"name": name, "doctype": doctype, "customer_name": st["customer_name"], "address": st["address"],
		"company": company_name, "date": st["posting_date"], "lr_no": st["transport"].get("lr_no"),
		"cartons": [{
			"code": carton_code(name, c["no"]), "no": c["no"], "of": total, "weight": c.get("weight"),
			"units": round(sum(_flt(ln["qty"]) for ln in c["lines"]), 3),
			"items": [{"item_code": items[ln["line"]]["item_code"], "qty": ln["qty"], "uom": items[ln["line"]]["uom"]}
			          for ln in c["lines"] if ln["line"] in items][:6],
		} for c in st["cartons"]],
	}
