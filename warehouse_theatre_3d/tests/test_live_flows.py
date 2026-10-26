"""Integration tests on a real site with ERPNext: every flow of the Operations view and
Warehouse Scan, end to end, through the same endpoints the apps call.

Run on a bench:  bench --site <site> run-tests --app warehouse_theatre_3d
(CI: .github/workflows/server-tests.yml). The pure logic is unit-tested separately in
the repository's tests/ folder, without a site.
"""

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, nowdate

from warehouse_theatre_3d.warehouse_theatre_3d.api import (
	api,
	fulfillment,
	health,
	inbound,
	insights,
	operations,
	packing,
	pallets,
	picking,
	replenish,
	routes,
	scan,
	slotting,
)

PREFIX = "WTT"


class TestLiveFlows(FrappeTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		if not frappe.db.a_row_exists("Company"):
			# `run-tests --app` runs only this app's before_tests; ERPNext's sets up a company.
			from erpnext.setup.utils import before_tests
			before_tests()
		cls.company = frappe.db.get_single_value("Global Defaults", "default_company") or frappe.get_all("Company", pluck="name")[0]
		cls.abbr = frappe.db.get_value("Company", cls.company, "abbr")
		root = frappe.db.get_value("Warehouse", {"warehouse_name": "All Warehouses", "company": cls.company}) \
			or frappe.db.get_value("Warehouse", {"company": cls.company, "is_group": 1, "parent_warehouse": ("is", "not set")})
		cls.building = cls.wh("WT Building", root, 1, "Building")
		cls.floor = cls.wh("WT Floor", cls.building, 1, "Floor")
		cls.rack_a = cls.wh("WT Rack A", cls.floor, 1, "Slot", 0, 0)
		cls.rack_b = cls.wh("WT Rack B", cls.floor, 1, "Slot", 0, 3)
		cls.a1 = cls.wh("WT A-L1", cls.rack_a, 0, "Bin")
		cls.a2 = cls.wh("WT A-L2", cls.rack_a, 0, "Bin")
		cls.b1 = cls.wh("WT B-L1", cls.rack_b, 0, "Bin")
		cls.zone = cls.wh("WT Floor Area", cls.floor, 0, "Zone", 2, 0)
		cls.qc = cls.wh("WT QC Hold", root, 0)
		cls.rejected = cls.wh("WT Rejected", root, 0)
		cls.returns = cls.wh("WT Returns", root, 0)
		frappe.db.set_value("Warehouse", cls.floor, "wt_dock_slot", cls.rack_a)

		cls.item = cls.make_item(f"{PREFIX}-ITEM-1")
		cls.item2 = cls.make_item(f"{PREFIX}-ITEM-2")
		cls.receive_item(cls.item, cls.a1, 60)
		cls.receive_item(cls.item2, cls.b1, 80)

		cls.customer = cls.ensure("Customer", f"{PREFIX} Customer", {
			"customer_name": f"{PREFIX} Customer", "customer_type": "Company",
			"customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}) or "All Customer Groups",
			"territory": frappe.db.get_value("Territory", {"is_group": 0}) or "All Territories"})
		cls.supplier = cls.ensure("Supplier", f"{PREFIX} Supplier", {
			"supplier_name": f"{PREFIX} Supplier",
			"supplier_group": frappe.db.get_value("Supplier Group", {"is_group": 0}) or "All Supplier Groups"})
		cls.settings({"dispatch_document": "Delivery Note", "qc_warehouse": cls.qc, "rejected_warehouse": cls.rejected,
		              "returns_warehouse": cls.returns, "hold_all_receipts": 0, "require_carton_scan": 0})

	# ── helpers ─────────────────────────────────────────────

	@classmethod
	def wh(cls, name, parent, is_group, wt=None, row=0, col=0):
		full = f"{name} - {cls.abbr}"
		if not frappe.db.exists("Warehouse", full):
			frappe.get_doc({"doctype": "Warehouse", "warehouse_name": name, "company": cls.company, "parent_warehouse": parent,
			                "is_group": is_group, "wt_warehouse_type": wt, "wt_row": row, "wt_col": col}).insert()
		return full

	@classmethod
	def make_item(cls, code):
		if not frappe.db.exists("Item", code):
			frappe.get_doc({"doctype": "Item", "item_code": code, "item_name": code, "is_stock_item": 1, "stock_uom": "Nos",
			                "item_group": frappe.db.get_value("Item Group", {"is_group": 0}) or "All Item Groups"}).insert()
		return code

	@classmethod
	def receive_item(cls, item, warehouse, qty):
		se = frappe.get_doc({"doctype": "Stock Entry", "stock_entry_type": "Material Receipt", "purpose": "Material Receipt",
		                     "company": cls.company,
		                     "items": [{"item_code": item, "qty": qty, "t_warehouse": warehouse, "basic_rate": 10,
		                                "uom": "Nos", "stock_uom": "Nos", "conversion_factor": 1}]})
		se.insert()
		se.submit()

	@classmethod
	def ensure(cls, doctype, name, values):
		if not frappe.db.exists(doctype, name):
			frappe.get_doc(dict(values, doctype=doctype)).insert()
		return name

	@classmethod
	def settings(cls, values):
		s = frappe.get_single("Warehouse Theatre Settings")
		for k, v in values.items():
			if s.meta.has_field(k):
				s.set(k, v)
		s.save()
		frappe.clear_document_cache("Warehouse Theatre Settings", "Warehouse Theatre Settings")

	def sales_order(self, item, qty, warehouse):
		so = frappe.get_doc({"doctype": "Sales Order", "customer": self.customer, "company": self.company,
		                     "transaction_date": nowdate(), "delivery_date": add_days(nowdate(), 3),
		                     "items": [{"item_code": item, "qty": qty, "rate": 100, "warehouse": warehouse,
		                                "delivery_date": add_days(nowdate(), 3)}]})
		so.insert()
		so.submit()
		return so

	def pick_list(self, item, qty, warehouse):
		from erpnext.selling.doctype.sales_order.sales_order import create_pick_list
		so = self.sales_order(item, qty, warehouse)
		pl = create_pick_list(so.name)
		pl.purpose = "Delivery"
		pl.save()
		return pl

	def picked(self, item, qty, warehouse):
		pl = self.pick_list(item, qty, warehouse)
		picks = [{"row_name": r.name, "picked_qty": r.stock_qty or r.qty} for r in pl.locations]
		res = scan.save_picks(pl.name, picks, submit=1)
		self.assertEqual(res["docstatus"], 1)
		return frappe.get_doc("Pick List", pl.name)

	def stage(self, pick_list):
		ops = fulfillment.get_operations(refresh=1)
		order = next((o for o in ops["orders"] if o["name"] == pick_list), None)
		self.assertIsNotNone(order, f"{pick_list} missing from Operations")
		return order

	def qty(self, item, warehouse):
		return frappe.db.get_value("Bin", {"item_code": item, "warehouse": warehouse}, "actual_qty") or 0

	# ── map and reports ─────────────────────────────────────

	def test_01_map_and_reports(self):
		groups = api.get_warehouse_groups()
		self.assertIn(self.floor, [g.id for g in groups])
		slots = api.get_slots(self.floor)
		self.assertEqual({s["wh"] for s in slots}, {self.rack_a, self.rack_b, self.zone})
		self.assertTrue(api.get_summary())
		health_data = health.get_stock_health(refresh=1)
		self.assertIn("summary", health_data)
		self.assertIn("metrics", insights.get_bin_metrics(self.floor))
		self.assertIn("dates", insights.get_timeline(self.floor))
		self.assertIn("bins", insights.get_capacity_alerts())
		self.assertTrue(insights.locate_item(self.item)["locations"])
		self.assertIsInstance(routes.get_pick_lists(self.floor), list)

	# ── pick → pack → dispatch, Delivery Note flow ─────────

	def test_02_delivery_note_flow(self):
		self.settings({"dispatch_document": "Delivery Note"})
		pl = self.picked(self.item, 4, self.a1)
		self.assertEqual(self.stage(pl.name)["stage"], "picked")
		self.assertEqual(frappe.db.get_value("Pick List", pl.name, "wt_picked_by"), "Administrator")

		st = packing.start_pack(pick_list=pl.name)
		self.assertEqual(st["doctype"], "Delivery Note")
		lines = [{"line": ln["line"], "qty": ln["qty"]} for ln in st["lines"]]
		st = packing.save_carton("Delivery Note", st["name"], lines, weight=3.5)
		self.assertEqual(st["progress"]["done"], st["progress"]["lines"])
		self.assertEqual(len(st["cartons"]), 1)
		self.assertEqual(self.stage(pl.name)["stage"], "packed")
		self.assertEqual(len(packing.get_carton_labels("Delivery Note", st["name"])["cartons"]), 1)
		self.assertEqual(scan.resolve_code(f"{st['name']}/1")["kind"], "carton")

		before = self.qty(self.item, self.a1)
		res = packing.dispatch("Delivery Note", st["name"], transporter_name="VRL", lr_no="LR-1", vehicle_no="TN 63 AB 1")
		self.assertEqual(res["docstatus"], 1)
		self.assertEqual(frappe.db.get_value("Delivery Note", st["name"], "lr_no"), "LR-1")
		self.assertEqual(self.stage(pl.name)["stage"], "dispatched")
		self.assertAlmostEqual(self.qty(self.item, self.a1), before - 4)

		# Customer returns one, good, into the Returns warehouse.
		src = inbound.get_return_source("Delivery Note", st["name"])
		ret = inbound.make_return("Delivery Note", st["name"], [{"line": src["lines"][0]["line"], "good": 1}], reason="test", submit=1)
		self.assertEqual(ret["docstatus"], 1)
		self.assertAlmostEqual(self.qty(self.item, self.returns), 1)
		self.assertAlmostEqual(inbound.get_return_source("Delivery Note", st["name"])["lines"][0]["returnable"], 3)

	# ── pick → pack → dispatch, Sales Invoice flow ─────────

	def test_03_sales_invoice_flow(self):
		self.settings({"dispatch_document": "Sales Invoice"})
		try:
			pl = self.picked(self.item, 2, self.a1)
			st = packing.start_pack(pick_list=pl.name)
			self.assertEqual(st["doctype"], "Sales Invoice")
			self.assertTrue(frappe.db.get_value("Sales Invoice", st["name"], "update_stock"))
			self.assertEqual(self.stage(pl.name)["stage"], "packed")
			lines = [{"line": ln["line"], "qty": ln["qty"]} for ln in st["lines"]]
			st = packing.save_carton("Sales Invoice", st["name"], lines)
			self.assertEqual(len(st["cartons"]), 1)
			res = packing.dispatch("Sales Invoice", st["name"], lr_no="LR-2")
			self.assertEqual(res["docstatus"], 1)
			order = self.stage(pl.name)
			self.assertEqual((order["stage"], order["flow"], order["billed"]), ("dispatched", "Sales Invoice", 100))
		finally:
			self.settings({"dispatch_document": "Delivery Note"})

	# ── work queue and batch picking ───────────────────────

	def test_04_work_queue_and_batch(self):
		pl1 = self.pick_list(self.item, 1, self.a1)
		pl2 = self.pick_list(self.item2, 2, self.b1)
		queue = picking.get_work_queue(self.floor)["lists"]
		self.assertTrue({pl1.name, pl2.name} <= {q["name"] for q in queue})
		claimed = picking.claim([pl1.name, pl2.name])
		self.assertEqual(set(claimed["claimed"]), {pl1.name, pl2.name})
		self.assertIn("Administrator", frappe.parse_json(frappe.db.get_value("Pick List", pl1.name, "_assign")))
		batch = picking.get_batch([pl1.name, pl2.name])
		self.assertEqual([lst["tote"] for lst in batch["lists"]], [1, 2])
		self.assertEqual(len(batch["rows"]), 2)
		picking.release(pl2.name)
		self.assertNotIn("Administrator", frappe.parse_json(frappe.db.get_value("Pick List", pl2.name, "_assign") or "[]"))

	# ── receiving, damaged goods, quality hold ─────────────

	def purchase_order(self, item, qty, warehouse):
		po = frappe.get_doc({"doctype": "Purchase Order", "supplier": self.supplier, "company": self.company,
		                     "transaction_date": nowdate(), "schedule_date": add_days(nowdate(), 1),
		                     "items": [{"item_code": item, "qty": qty, "rate": 50, "warehouse": warehouse,
		                                "schedule_date": add_days(nowdate(), 1)}]})
		po.insert()
		po.submit()
		return po

	def test_05_receive_and_quality_hold(self):
		po = self.purchase_order(self.item2, 10, self.b1)
		data = inbound.get_purchase_order(po.name)
		self.assertEqual(data["lines"][0]["pending"], 10)
		before = self.qty(self.item2, self.b1)
		res = inbound.receive(po.name, [{"line": data["lines"][0]["line"], "good": 8, "damaged": 2}], supplier_delivery_note="DC-9")
		self.assertTrue(res["submitted"], res.get("note"))
		self.assertAlmostEqual(self.qty(self.item2, self.b1), before + 8)
		self.assertAlmostEqual(self.qty(self.item2, self.rejected), 2)
		self.assertEqual(scan.resolve_code(po.name)["action"], "receive")

		self.settings({"hold_all_receipts": 1})
		try:
			po2 = self.purchase_order(self.item2, 5, self.b1)
			line = inbound.get_purchase_order(po2.name)["lines"][0]["line"]
			res = inbound.receive(po2.name, [{"line": line, "good": 5}])
			self.assertTrue(res["submitted"], res.get("note"))
			self.assertEqual(res["held"], [self.item2])
			held = inbound.get_quality_hold()
			self.assertIn(self.item2, [i.item_code for i in held["items"]])
			rej = inbound.reject_held(self.item2, 2, reason="torn")
			self.assertEqual(rej["docstatus"], 1)
			self.assertAlmostEqual(self.qty(self.item2, self.qc), 3)
		finally:
			self.settings({"hold_all_receipts": 0})

	# ── replenishment ──────────────────────────────────────

	def test_06_replenishment(self):
		face = f"{PREFIX}-ITEM-R"
		self.make_item(face)
		self.receive_item(face, self.a2, 2)
		self.receive_item(face, self.b1, 50)
		frappe.get_doc({"doctype": "Warehouse Pick Face", "item_code": face, "warehouse": self.a2,
		                "min_qty": 5, "max_qty": 20, "enabled": 1}).insert()
		tasks = [t for t in replenish.get_replenishment(floor=self.floor)["tasks"] if t["item_code"] == face]
		self.assertEqual(len(tasks), 1)
		t = tasks[0]
		self.assertEqual((t["need"], t["sources"][0]["warehouse"]), (18, self.b1))
		res = replenish.create_replenishment([{"item_code": face, "qty": 18, "s_warehouse": self.b1, "t_warehouse": self.a2}], submit=1)
		self.assertTrue(res["submitted"])
		self.assertAlmostEqual(self.qty(face, self.a2), 20)
		self.assertFalse([t for t in replenish.get_replenishment(floor=self.floor)["tasks"] if t["item_code"] == face])

	# ── slotting and pallets ───────────────────────────────

	def test_07_slotting(self):
		data = slotting.get_slotting(self.floor, days=30)
		self.assertIn("moves", data)
		self.assertEqual(set(data["summary"]), {"A", "B", "C"})

	def test_08_pallets(self):
		item = f"{PREFIX}-ITEM-P"
		self.make_item(item)
		self.receive_item(item, self.b1, 12)
		p = pallets.save_pallet(self.b1, [{"item_code": item, "qty": 12}])
		self.assertEqual(scan.resolve_code(p["name"])["kind"], "pallet")
		res = pallets.move_pallet(p["name"], self.zone)
		self.assertTrue(res["submitted"])
		self.assertEqual(frappe.db.get_value("Warehouse Pallet", p["name"], "warehouse"), self.zone)
		self.assertAlmostEqual(self.qty(item, self.zone), 12)

	# ── User Permissions ───────────────────────────────────

	def test_09_user_permissions(self):
		email = "wt-picker@example.com"
		if not frappe.db.exists("User", email):
			u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "Picker", "send_welcome_email": 0})
			u.append("roles", {"role": "Stock User"})
			u.insert(ignore_permissions=True)
		if not frappe.db.exists("User Permission", {"user": email, "allow": "Warehouse", "for_value": self.a1}):
			frappe.get_doc({"doctype": "User Permission", "user": email, "allow": "Warehouse", "for_value": self.a1,
			                "apply_to_all_doctypes": 1}).insert(ignore_permissions=True)
		frappe.cache().hdel("user_permissions", email)
		frappe.set_user(email)
		try:
			frappe.local.wt3d_allowed_wh = "unset"
			frappe.local.wt3d_navigable_wh = "unset"
			self.assertEqual([g.id for g in api.get_warehouse_groups()], [self.floor])
			slots = api.get_slots(self.floor)
			self.assertEqual([s["wh"] for s in slots], [self.rack_a])
			self.assertEqual([lv["wh"] for lv in slots[0]["levels"]], [self.a1])
			with self.assertRaises(frappe.PermissionError):
				operations.get_bin_stock(self.b1)
			stock = health.get_stock_health(refresh=1)
			self.assertTrue(all(w["warehouse"] == self.a1 for w in stock["warehouses"]))
			self.assertTrue(api.get_user_access()["access"]["restricted"])
		finally:
			frappe.set_user("Administrator")
			frappe.local.wt3d_allowed_wh = "unset"
			frappe.local.wt3d_navigable_wh = "unset"

	# ── offline replay ─────────────────────────────────────

	def test_10_replay_is_safe(self):
		from unittest.mock import patch

		from warehouse_theatre_3d.warehouse_theatre_3d.api import offline
		item = f"{PREFIX}-ITEM-O"
		self.make_item(item)
		self.receive_item(item, self.b1, 10)
		rows = [{"item_code": item, "qty": 3, "s_warehouse": self.b1, "t_warehouse": self.a2}]
		with patch.object(offline, "client_id", return_value="testreplay0001"):
			first = scan.post_transfer(rows, submit=1)
			frappe.db.commit()   # the remembered result is stored after commit
			again = scan.post_transfer(rows, submit=1)
		self.assertEqual(first["name"], again["name"])
		self.assertAlmostEqual(self.qty(item, self.a2), 3)
		self.assertAlmostEqual(self.qty(item, self.b1), 7)
