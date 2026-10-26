"""Unit tests for the pure (database-free) logic in the feature APIs.

Run from the repository root:  python -m unittest discover -s tests
These live outside the app package so `bench run-tests` doesn't pick them up;
when Frappe isn't installed a minimal stub is used so they run anywhere.
"""

import sys
import types
import unittest
from datetime import date, datetime, timedelta


def _install_frappe_stub():
	try:
		import frappe  # noqa: F401
		return
	except ImportError:
		pass

	frappe = types.ModuleType("frappe")
	frappe.whitelist = lambda *a, **k: (lambda f: f)
	frappe.PermissionError = PermissionError
	frappe.throw = lambda msg, exc=Exception: (_ for _ in ()).throw(exc(msg))
	frappe.scrub = lambda s: s.lower().replace(" ", "_")
	frappe._ = lambda s: s
	frappe.db = types.SimpleNamespace()

	utils = types.ModuleType("frappe.utils")

	def getdate(v):
		if isinstance(v, datetime):
			return v.date()
		if isinstance(v, date):
			return v
		return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()

	utils.getdate = getdate
	utils.nowdate = lambda: date.today().isoformat()
	utils.add_days = lambda d, n: (getdate(d).toordinal() + n) and date.fromordinal(getdate(d).toordinal() + n).isoformat()
	utils.cint = lambda v: int(v or 0)
	utils.now_datetime = datetime.now
	utils.get_url = lambda p="": "https://example.test" + p
	utils.escape_html = lambda s: s
	utils.validate_email_address = lambda e, throw=False: e if "@" in (e or "") else ""
	frappe.utils = utils

	model = types.ModuleType("frappe.model")
	document = types.ModuleType("frappe.model.document")
	document.Document = object
	sys.modules.update({
		"frappe": frappe, "frappe.utils": utils, "frappe.model": model, "frappe.model.document": document,
	})


_install_frappe_stub()
sys.path.insert(0, ".")

from warehouse_theatre_3d.warehouse_theatre_3d.api.common import bin_fill_percent  # noqa: E402
from warehouse_theatre_3d.warehouse_theatre_3d.api.insights import (  # noqa: E402
	daily_change_lists,
	fifo_age_days,
)
from warehouse_theatre_3d.warehouse_theatre_3d.api.operations import plan_putaway  # noqa: E402
from warehouse_theatre_3d.warehouse_theatre_3d.api.routes import reorder_rows  # noqa: E402
from warehouse_theatre_3d.warehouse_theatre_3d.api.setup import refine_roles  # noqa: E402
from warehouse_theatre_3d.warehouse_theatre_3d.api.links import document_lines, place_of  # noqa: E402
from warehouse_theatre_3d.warehouse_theatre_3d.api.updates import lead_payload, should_show  # noqa: E402
from warehouse_theatre_3d.warehouse_theatre_3d.api.scan import (  # noqa: E402
	apply_picks,
	clean_scan,
	count_queue,
	place_path,
	walk_order,
)
from warehouse_theatre_3d.warehouse_theatre_3d.api.fulfillment import (  # noqa: E402
	billing_percent,
	build_order,
	daily_counts,
	line_stats,
	my_work,
	order_flow,
	order_stage,
	posting_datetime,
	summarise_hours,
	team_view,
)
from warehouse_theatre_3d.warehouse_theatre_3d.api.packing import (  # noqa: E402
	carton_code,
	check_carton,
	invoice_lines_from_picks,
	next_carton_no,
	pack_progress,
	packed_by_line,
	parse_carton,
)
from warehouse_theatre_3d.warehouse_theatre_3d.api import access  # noqa: E402
from warehouse_theatre_3d.warehouse_theatre_3d.api.health import (  # noqa: E402
	bucket_index,
	classify_movement,
	fifo_layers,
)


class TestFillPercent(unittest.TestCase):
	def test_matches_frontend_average(self):
		# lvFill(): average of min(100, round(qty/cap*100)) over capped UOMs
		self.assertEqual(bin_fill_percent({"Nos": 100, "Kg": 50}, {"Nos": 50, "Kg": 100}), 75)

	def test_no_capacity_returns_none(self):
		self.assertIsNone(bin_fill_percent({}, {"Nos": 5}))

	def test_negative_stock_counts_as_empty(self):
		self.assertEqual(bin_fill_percent({"Nos": 10}, {"Nos": -4}), 0)


class TestFifoAge(unittest.TestCase):
	today = date(2026, 10, 21)

	def test_newest_receipts_cover_stock(self):
		rows = [(date(2026, 10, 11), 10), (date(2026, 9, 21), 100)]  # newest first
		# 10 units 10 days old + 10 units 30 days old -> 20 days average
		self.assertEqual(fifo_age_days(20, rows, self.today), 20)

	def test_uncovered_stock_gets_cap(self):
		self.assertEqual(fifo_age_days(10, [(date(2026, 10, 21), 5)], self.today, cap_days=100), 50)

	def test_zero_stock(self):
		self.assertIsNone(fifo_age_days(0, [], self.today))


class TestTimeline(unittest.TestCase):
	def test_one_entry_per_day_including_quiet_days(self):
		dates, changes = daily_change_lists(
			{"2026-10-01": {"B1": {"Nos": 5}}, "2026-10-03": {"B1": {"Nos": -2}, "B2": {"Kg": 0}}},
			"2026-10-01", "2026-10-03",
		)
		self.assertEqual(dates, ["2026-10-01", "2026-10-02", "2026-10-03"])
		self.assertEqual(changes, [[["B1", "Nos", 5.0]], [], [["B1", "Nos", -2.0]]])  # zero deltas dropped


def _bin(wh, row, col, level=0):
	return {"wh": wh, "label": wh, "slot": "S-" + wh, "slot_label": "S" + wh, "row": row, "col": col, "level": level}


class TestPutaway(unittest.TestCase):
	def test_prefers_near_empty_bin_that_fits(self):
		bins = [_bin("FAR", 5, 5), _bin("NEAR", 0, 1)]
		caps = {"FAR": {"Nos": 100}, "NEAR": {"Nos": 100}}
		plan = plan_putaway(bins, caps, {}, {}, (0, 0), [{"item_code": "A", "qty": 40, "uom": "Nos"}])
		self.assertEqual([a["wh"] for a in plan[0]["allocations"]], ["NEAR"])
		self.assertEqual(plan[0]["unplaced"], 0)

	def test_splits_when_capacity_runs_out_and_reports_unplaced(self):
		bins = [_bin("B1", 0, 0), _bin("B2", 0, 1)]
		caps = {"B1": {"Nos": 30}, "B2": {"Nos": 20}}
		used = {"B1": {"Nos": 10}}
		plan = plan_putaway(bins, caps, used, {"B1": {"A"}}, (0, 0), [{"item_code": "A", "qty": 50, "uom": "Nos"}])
		alloc = {a["wh"]: a["qty"] for a in plan[0]["allocations"]}
		self.assertEqual(alloc, {"B1": 20, "B2": 20})
		self.assertEqual(plan[0]["unplaced"], 10)

	def test_second_item_does_not_reuse_promised_space(self):
		bins = [_bin("B1", 0, 0), _bin("B2", 3, 3)]
		caps = {"B1": {"Nos": 10}, "B2": {"Nos": 10}}
		reqs = [{"item_code": "A", "qty": 10, "uom": "Nos"}, {"item_code": "B", "qty": 10, "uom": "Nos"}]
		plan = plan_putaway(bins, caps, {}, {}, (0, 0), reqs)
		self.assertEqual(plan[0]["allocations"][0]["wh"], "B1")
		self.assertEqual(plan[1]["allocations"][0]["wh"], "B2")

	def test_same_item_beats_slightly_nearer_mixed_bin(self):
		bins = [_bin("MIXED", 0, 0), _bin("SAME", 0, 1)]
		caps = {"MIXED": {"Nos": 100}, "SAME": {"Nos": 100}}
		plan = plan_putaway(bins, caps, {}, {"MIXED": {"X"}, "SAME": {"A"}}, (0, 0),
		                    [{"item_code": "A", "qty": 5, "uom": "Nos"}])
		self.assertEqual(plan[0]["allocations"][0]["wh"], "SAME")

	def test_unknown_capacity_used_but_ranked_after_known_fit(self):
		bins = [_bin("NOCAP", 0, 0), _bin("CAP", 0, 1)]
		plan = plan_putaway(bins, {"CAP": {"Nos": 50}}, {}, {}, (0, 0), [{"item_code": "A", "qty": 5, "uom": "Nos"}])
		self.assertEqual(plan[0]["allocations"][0]["wh"], "CAP")


class TestReorder(unittest.TestCase):
	def test_given_order_first_then_rest(self):
		rows = [{"name": "r1", "idx": 1}, {"name": "r2", "idx": 2}, {"name": "r3", "idx": 3}]
		self.assertEqual(reorder_rows(rows, ["r3", "r1", "ghost"]), {"r3": 1, "r1": 2, "r2": 3})


def _wh(name, parent=None, group=0):
	return {"name": name, "parent_warehouse": parent, "is_group": group}


class TestZoneDetection(unittest.TestCase):
	"""refine_roles: floor storage becomes Zone without touching racked branches."""

	def test_racked_branch_unchanged(self):
		whs = [_wh("B", None, 1), _wh("F", "B", 1), _wh("S", "F", 1), _wh("L1", "S")]
		roles = {"B": "Building", "F": "Floor", "S": "Slot", "L1": "Bin"}
		self.assertEqual(refine_roles(whs, roles), roles)

	def test_godown_with_areas_areas_become_zones(self):
		# Godown (Floor depth) split into areas at the Slot depth, no shelves under them
		whs = [_wh("B", None, 1), _wh("G", "B", 1), _wh("Area 1", "G"), _wh("Near Gate", "G")]
		out = refine_roles(whs, {"B": "Building", "G": "Floor", "Area 1": "Slot", "Near Gate": "Slot"})
		self.assertEqual((out["G"], out["Area 1"], out["Near Gate"]), ("Floor", "Zone", "Zone"))

	def test_single_warehouse_godown_becomes_standalone_zone(self):
		whs = [_wh("B", None, 1), _wh("Fabric Godown", "B")]
		out = refine_roles(whs, {"B": "Building", "Fabric Godown": "Floor"})
		self.assertEqual(out["Fabric Godown"], "Zone")

	def test_mixed_floor_racks_stay_and_floor_area_becomes_zone(self):
		whs = [_wh("F", None, 1), _wh("Rack A", "F", 1), _wh("A-L1", "Rack A"), _wh("Bulk area", "F")]
		out = refine_roles(whs, {"F": "Floor", "Rack A": "Slot", "A-L1": "Bin", "Bulk area": "Slot"})
		self.assertEqual((out["Rack A"], out["A-L1"], out["Bulk area"]), ("Slot", "Bin", "Zone"))

	def test_flat_two_level_tree_godowns_become_zones(self):
		# Wizard seeds Slot/Bin for a 2-level tree; without refinement nothing would show.
		whs = [_wh("All Warehouses", None, 1), _wh("Yarn Godown", "All Warehouses"), _wh("Stores", "All Warehouses")]
		out = refine_roles(whs, {"All Warehouses": "Slot", "Yarn Godown": "Bin", "Stores": "Bin"})
		self.assertEqual((out["Yarn Godown"], out["Stores"]), ("Zone", "Zone"))

	def test_empty_group_is_not_a_zone(self):
		# A group warehouse can't hold stock in ERPNext, even with no children yet
		out = refine_roles([_wh("F", None, 1), _wh("New rack", "F", 1)], {"F": "Floor", "New rack": "Slot"})
		self.assertEqual(out["New rack"], "Slot")


class TestStockHealth(unittest.TestCase):
	today = date(2026, 10, 22)

	def test_fifo_layers_newest_first_then_uncovered_at_cap(self):
		rows = [(date(2026, 10, 12), 10), (date(2026, 7, 24), 5)]   # 10 and 90 days old
		self.assertEqual(fifo_layers(25, rows, self.today, cap_days=730), [(10, 10), (5, 90), (10, 730)])

	def test_fifo_layers_ignore_extra_receipts(self):
		self.assertEqual(fifo_layers(4, [(date(2026, 10, 21), 10)], self.today), [(4, 1)])

	def test_bucket_edges(self):
		self.assertEqual([bucket_index(d) for d in (0, 30, 31, 90, 91, 180, 181, 365, 366, 5000)],
		                 [0, 0, 1, 1, 2, 2, 3, 3, 4, 4])

	def test_dead_and_slow(self):
		items = {
			"DEAD": {"qty": 100, "value": 5000},
			"SLOW": {"qty": 1000, "value": 9000},   # 30 out in 90 days -> 3000 days of cover
			"FAST": {"qty": 10, "value": 900},      # 90 out in 90 days -> 10 days of cover
			"EMPTY": {"qty": 0, "value": 0},
		}
		moves = {
			"DEAD": {"last_out": date(2026, 3, 1), "out_qty": 0},
			"SLOW": {"last_out": date(2026, 10, 1), "out_qty": 30},
			"FAST": {"last_out": date(2026, 10, 20), "out_qty": 90},
		}
		dead, slow = classify_movement(items, moves, 90, self.today)
		self.assertEqual([r["item_code"] for r in dead], ["DEAD"])
		self.assertEqual(dead[0]["idle_days"], 235)
		self.assertEqual([(r["item_code"], r["cover_days"]) for r in slow], [("SLOW", 3000)])

	def test_never_moved_item_is_dead_with_no_last_date(self):
		dead, _ = classify_movement({"NEW": {"qty": 5, "value": 50}}, {}, 90, self.today)
		self.assertEqual((dead[0]["item_code"], dead[0]["idle_days"], dead[0]["last_out"]), ("NEW", None, None))


class TestFormLinks(unittest.TestCase):
	def test_stock_entry_lines_source_and_target(self):
		rows = [
			{"idx": 1, "item_code": "A", "transfer_qty": 12, "s_warehouse": "S1", "t_warehouse": "T1", "stock_uom": "Nos"},
			{"idx": 2, "item_code": "B", "transfer_qty": 0, "qty": 2, "conversion_factor": 10, "t_warehouse": "T2"},
			{"idx": 3, "item_code": "", "transfer_qty": 5, "s_warehouse": "S1"},          # no item
			{"idx": 4, "item_code": "C", "transfer_qty": 5},                               # no warehouse
		]
		out = document_lines("Stock Entry", rows)
		self.assertEqual([(r["item_code"], r["qty"], r["source"], r["target"]) for r in out],
		                 [("A", 12, "S1", "T1"), ("B", 20, None, "T2")])

	def test_delivery_note_is_outward_only(self):
		out = document_lines("Delivery Note", [{"idx": 1, "item_code": "A", "stock_qty": 3, "warehouse": "W"}])
		self.assertEqual((out[0]["source"], out[0]["target"]), ("W", None))

	def test_place_of_bin_zone_standalone_and_unmapped(self):
		b = place_of({"wh": "L1", "wt_type": "Bin", "slot": "A1", "slot_label": "A1", "floor": "F", "floor_label": "Ground", "label": "L1"})
		self.assertEqual((b["floor"], b["slot"], b["mapped"]), ("F", "A1", True))
		z = place_of({"wh": "Area 1", "wt_type": "Zone", "zone_floor": "G", "zone_floor_label": "Godown", "label": "Area 1"})
		self.assertEqual((z["floor"], z["slot"], z["label"]), ("G", "Area 1", "Floor stack"))
		sz = place_of({"wh": "Yarn Godown", "wt_type": "Zone", "label": "Yarn Godown"})
		self.assertEqual((sz["floor"], sz["slot"]), ("Yarn Godown", "Yarn Godown"))
		self.assertFalse(place_of({"wh": "Stores", "wt_type": None, "label": "Stores"})["mapped"])


class TestScan(unittest.TestCase):
	def test_clean_scan_drops_symbology_prefix_and_line_end(self):
		self.assertEqual(clean_scan("]C1FAB-005\r\n"), "FAB-005")
		self.assertEqual(clean_scan("  ]Q1A3-L1 - Ground Floor - PD "), "A3-L1 - Ground Floor - PD")
		self.assertEqual(clean_scan("FAB-005"), "FAB-005")
		self.assertEqual(clean_scan(None), "")

	def test_walk_order_snakes_rows_and_puts_unmapped_last(self):
		stops = [
			{"key": "a", "idx": 1, "mapped": True, "row": 0, "col": 3, "level": 0},
			{"key": "b", "idx": 2, "mapped": False},
			{"key": "c", "idx": 3, "mapped": True, "row": 0, "col": 1, "level": 2},
			{"key": "d", "idx": 4, "mapped": True, "row": 2, "col": 1, "level": 0},
			{"key": "e", "idx": 5, "mapped": True, "row": 2, "col": 4, "level": 0},
			{"key": "f", "idx": 6, "mapped": True, "row": 0, "col": 1, "level": 0},
		]
		# Row 0 left to right (lowest shelf first at col 1), row 2 right to left.
		self.assertEqual(walk_order(stops), ["f", "c", "a", "e", "d", "b"])

	def test_count_queue_never_counted_then_oldest_then_value(self):
		locs = [
			{"wh": "A", "items": 2, "value": 10, "last_counted": "2026-09-01"},
			{"wh": "B", "items": 1, "value": 5, "last_counted": None},
			{"wh": "C", "items": 0, "value": 0, "last_counted": None},
			{"wh": "D", "items": 3, "value": 90, "last_counted": None},
			{"wh": "E", "items": 1, "value": 1, "last_counted": "2026-08-01"},
		]
		self.assertEqual(count_queue(locs), ["D", "B", "E", "A"])

	def test_apply_picks_validates(self):
		rows = [{"name": "r1", "idx": 1, "stock_qty": 10}, {"name": "r2", "idx": 2, "stock_qty": 4}]
		out = apply_picks(rows, [{"row_name": "r1", "picked_qty": 7}, {"row_name": "r2", "picked_qty": 4, "warehouse": "X"}])
		self.assertEqual(out["r1"], {"picked_qty": 7.0, "warehouse": None})
		self.assertEqual(out["r2"]["warehouse"], "X")
		with self.assertRaises(ValueError):
			apply_picks(rows, [{"row_name": "r2", "picked_qty": 5}])
		with self.assertRaises(ValueError):
			apply_picks(rows, [{"row_name": "zz", "picked_qty": 1}])
		with self.assertRaises(ValueError):
			apply_picks(rows, [{"row_name": "r1", "picked_qty": -1}])

	def test_place_path(self):
		self.assertEqual(place_path({"mapped": True, "slot_label": "A3", "label": "L1"}), "A3 › L1")
		self.assertEqual(place_path({"mapped": True, "slot_label": "Area 1", "label": "Floor stack"}), "Area 1")
		self.assertEqual(place_path({"mapped": False, "warehouse": "Stores - PD", "warehouse_label": "Stores"}), "Stores")


class TestUpdatesSignup(unittest.TestCase):
	def test_should_show(self):
		today = date(2026, 10, 24)
		self.assertTrue(should_show("", today))
		self.assertFalse(should_show("sent", today))
		self.assertFalse(should_show("never", today))
		self.assertFalse(should_show("snooze:2026-11-23", today))
		self.assertTrue(should_show("snooze:2026-10-24", today))

	def test_lead_payload_sends_only_what_was_typed(self):
		import json
		p = lead_payload({"name": " Ravi ", "email": "ravi@example.com", "company": "", "phone": None, "stock": "x"},
		                 "https://erp.client.in", "1.0.0", web_form="wf")
		self.assertEqual(p["web_form"], "wf")
		d = json.loads(p["data"])
		self.assertEqual(d, {"doctype": "Lead", "web_form_name": "wf", "first_name": "Ravi", "email_id": "ravi@example.com",
		                     "company_name": "", "mobile_no": "", "website": "https://erp.client.in"})


class TestFulfillment(unittest.TestCase):
	NOW = datetime(2026, 10, 26, 18, 0)

	def pl(self, name="PL-1", docstatus=1, **kw):
		d = {"name": name, "docstatus": docstatus, "customer": "C1", "company": "Co",
		     "creation": datetime(2026, 10, 26, 9, 0), "modified": datetime(2026, 10, 26, 11, 0),
		     "wt_picked_by": "picker@x.com" if docstatus == 1 else None,
		     "wt_picked_at": datetime(2026, 10, 26, 10, 0) if docstatus == 1 else None,
		     "_assign": None, "scan_mode": 1}
		d.update(kw)
		return d

	ROWS = [{"stock_qty": 5, "picked_qty": 5}, {"stock_qty": 3, "picked_qty": 2}]

	def test_stage_delivery_note_flow(self):
		self.assertEqual(order_stage(0, []), "pending")
		self.assertEqual(order_stage(1, []), "picked")
		self.assertEqual(order_stage(1, [{"kind": "dn", "docstatus": 0, "packed": False}]), "picked")
		self.assertEqual(order_stage(1, [{"kind": "dn", "docstatus": 0, "packed": True}]), "packed")
		self.assertEqual(order_stage(1, [{"kind": "dn", "docstatus": 1, "packed": False}]), "dispatched")

	def test_stage_sales_invoice_flow(self):
		self.assertEqual(order_stage(1, [{"kind": "si", "docstatus": 0}]), "packed")
		self.assertEqual(order_stage(1, [{"kind": "si", "docstatus": 1}]), "dispatched")
		# A draft Pick List is pending whatever else exists.
		self.assertEqual(order_stage(0, [{"kind": "si", "docstatus": 1}]), "pending")

	def test_flow_and_billing(self):
		dn = [{"kind": "dn", "docstatus": 1, "per_billed": 40}]
		si = [{"kind": "si", "docstatus": 1}]
		self.assertEqual(order_flow([]), None)
		self.assertEqual(order_flow(dn), "Delivery Note")
		self.assertEqual(order_flow(si), "Sales Invoice")
		self.assertEqual(billing_percent("Delivery Note", dn), 40)
		self.assertEqual(billing_percent("Sales Invoice", si), 100)
		self.assertIsNone(billing_percent("Delivery Note", [{"kind": "dn", "docstatus": 0}]))

	def test_line_stats(self):
		self.assertEqual(line_stats(self.ROWS + [{"stock_qty": 1, "picked_qty": 0}]),
		                 {"lines": 3, "short": 2, "untouched": 1})

	def test_posting_datetime(self):
		self.assertEqual(posting_datetime(date(2026, 10, 26), timedelta(hours=14, minutes=5)), datetime(2026, 10, 26, 14, 5))
		self.assertEqual(posting_datetime("2026-10-26", "09:30:15.123"), datetime(2026, 10, 26, 9, 30, 15))
		self.assertIsNone(posting_datetime(None, None))

	def test_build_order_delivery_note_packed_then_dispatched(self):
		dn = {"name": "DN-1", "docstatus": 0, "per_billed": 0, "qty": 7, "creation": datetime(2026, 10, 26, 12, 0),
		      "owner": "clerk@x.com", "posting_date": date(2026, 10, 26), "posting_time": timedelta(hours=12)}
		slips = {"DN-1": [{"name": "PS-1", "creation": datetime(2026, 10, 26, 13, 0), "owner": "packer@x.com"}]}
		o = build_order(self.pl(), self.ROWS, [dn], slips, [], self.NOW)
		self.assertEqual((o["stage"], o["flow"], o["packed_by"]), ("packed", "Delivery Note", "packer@x.com"))
		self.assertEqual(o["short"], 1)
		self.assertEqual(o["hours_in_stage"], 5.0)
		self.assertEqual(o["times"]["wait"], 1.0)
		self.assertEqual(o["times"]["pack"], 3.0)
		dn.update(docstatus=1, posting_time=timedelta(hours=15))
		o = build_order(self.pl(), self.ROWS, [dn], slips, [], self.NOW)
		self.assertEqual(o["stage"], "dispatched")
		self.assertEqual(o["times"]["ship"], 2.0)
		self.assertEqual(o["times"]["total"], 6.0)
		self.assertFalse(o["partial"])
		self.assertEqual(o["billed"], 0)

	def test_build_order_sales_invoice_and_partial(self):
		si = {"name": "SI-1", "docstatus": 1, "qty": 4, "creation": datetime(2026, 10, 26, 14, 0), "owner": "acc@x.com",
		      "posting_date": date(2026, 10, 26), "posting_time": timedelta(hours=14, minutes=30)}
		o = build_order(self.pl(), self.ROWS, [], {}, [si], self.NOW)
		self.assertEqual((o["stage"], o["flow"], o["billed"]), ("dispatched", "Sales Invoice", 100))
		self.assertTrue(o["partial"])  # 4 of 7 picked units went out
		self.assertEqual(o["packed_by"], "acc@x.com")

	def test_build_order_pending_and_unstamped(self):
		o = build_order(self.pl(docstatus=0, _assign='["picker@x.com"]'), [{"stock_qty": 2, "picked_qty": 1}, {"stock_qty": 1, "picked_qty": 0}],
		                [], {}, [], self.NOW)
		self.assertEqual((o["stage"], o["progress"], o["short"], o["assigned"]), ("pending", 1, 0, ["picker@x.com"]))
		o = build_order(self.pl(wt_picked_by=None, wt_picked_at=None), self.ROWS, [], {}, [], self.NOW)
		self.assertFalse(o["picked_by_known"])
		self.assertEqual(o["picked_at"], datetime(2026, 10, 26, 11, 0))  # falls back to modified

	def test_summaries(self):
		self.assertEqual(summarise_hours([None, 4, 1, 3]), {"n": 3, "median": 3, "avg": 2.7})
		self.assertEqual(summarise_hours([1, 2, 3, 4])["median"], 2.5)
		s = daily_counts([datetime(2026, 10, 26, 9), "2026-10-25", None, "2026-09-01"], date(2026, 10, 26), days=3)
		self.assertEqual([x["n"] for x in s], [0, 1, 1])
		self.assertEqual(s[-1]["date"], "2026-10-26")

	def test_my_work_and_team(self):
		today = date(2026, 10, 26)
		picked = build_order(self.pl("PL-1"), self.ROWS, [], {}, [], self.NOW)
		pending = build_order(self.pl("PL-2", docstatus=0, _assign='["picker@x.com"]'), self.ROWS, [], {}, [], self.NOW)
		old = build_order(self.pl("PL-3", docstatus=0, creation=datetime(2026, 10, 24, 9)), self.ROWS, [], {}, [], self.NOW)
		orders = [picked, pending, old]
		me = my_work(orders, "picker@x.com", today)
		self.assertEqual((me["waiting"], me["assigned"]), (2, ["PL-2"]))
		self.assertEqual(me["picked_today"], {"orders": 1, "lines": 2, "short": 1, "accuracy": 50})
		team = team_view(orders, today, 30)
		self.assertEqual(team["funnel"], {"pending": 2, "picked": 1, "packed": 0, "dispatched": 0})
		self.assertEqual(team["stuck"], ["PL-3"])
		self.assertEqual(team["pickers"][0]["user"], "picker@x.com")
		self.assertEqual(team["accuracy"]["percent"], 50)


class TestPacking(unittest.TestCase):
	def test_carton_codes(self):
		self.assertEqual(carton_code("MAT-DN-2026-00012", 2), "MAT-DN-2026-00012/2")
		self.assertEqual(parse_carton("MAT-DN-2026-00012/2"), ("MAT-DN-2026-00012", 2))
		self.assertEqual(parse_carton(" ACC-SINV/2026/0001/10 "), ("ACC-SINV/2026/0001", 10))
		self.assertIsNone(parse_carton("A3-L1"))
		self.assertIsNone(parse_carton("DN-1/0"))
		self.assertIsNone(parse_carton(""))

	def test_cartons_and_progress(self):
		cartons = [{"no": 1, "lines": [{"line": "a", "qty": 2}]}, {"no": 3, "lines": [{"line": "a", "qty": 1}, {"line": "b", "qty": 4}]}]
		self.assertEqual(next_carton_no(cartons), 4)
		self.assertEqual(next_carton_no([]), 1)
		self.assertEqual(packed_by_line(cartons), {"a": 3, "b": 4})
		self.assertEqual(pack_progress([{"qty": 3, "packed": 3}, {"qty": 5, "packed": 4}]),
		                 {"lines": 2, "done": 1, "qty": 8, "packed": 7})

	def test_check_carton(self):
		rem = {"a": 2, "b": 5}
		self.assertEqual(check_carton([{"line": "a", "qty": 1}, {"line": "a", "qty": 1}, {"line": "b", "qty": 0}], rem),
		                 [{"line": "a", "qty": 2}])
		for bad in ([{"line": "a", "qty": 3}], [{"line": "z", "qty": 1}], [{"line": "b", "qty": 0}], [{"line": "a", "qty": -1}], []):
			with self.assertRaises(ValueError):
				check_carton(bad, rem)

	def test_invoice_lines_from_picks(self):
		so_items = [{"so_detail": "soi-1", "item_code": "X", "conversion_factor": 12, "rate": 100},
		            {"so_detail": "soi-2", "item_code": "Y", "conversion_factor": 1}]
		picks = [
			{"name": "p1", "sales_order_item": "soi-1", "picked_qty": 24, "warehouse": "A1", "batch_no": "B1"},
			{"name": "p2", "sales_order_item": "soi-1", "picked_qty": 6, "warehouse": "A2"},
			{"name": "p3", "sales_order_item": "soi-2", "picked_qty": 0, "warehouse": "A3"},
			{"name": "p4", "sales_order_item": "soi-9", "picked_qty": 5, "warehouse": "A4"},
		]
		out = invoice_lines_from_picks(picks, so_items)
		self.assertEqual([(x["warehouse"], x["qty"], x["stock_qty"]) for x in out], [("A1", 2, 24), ("A2", 0.5, 6)])
		self.assertEqual((out[0]["batch_no"], out[0]["use_serial_batch_fields"], out[0]["rate"]), ("B1", 1, 100))
		self.assertNotIn("use_serial_batch_fields", out[1])
class TestAccess(unittest.TestCase):
	PERMS = {
		"Warehouse": [{"doc": "Main - P", "applicable_for": None}, {"doc": "Rack A - P", "applicable_for": None},
		              {"doc": "Shop - P", "applicable_for": "Sales Invoice"}],
		"Company": [{"doc": "Pranera", "applicable_for": ""}],
		"Customer": [{"doc": "C1", "applicable_for": None}],
	}

	def test_restricted_values(self):
		self.assertEqual(access.restricted_values(self.PERMS, "Warehouse"), {"Main - P", "Rack A - P"})
		self.assertEqual(access.restricted_values(self.PERMS, "Company"), {"Pranera"})
		self.assertIsNone(access.restricted_values(self.PERMS, "Item"))
		# Only "for Sales Invoice": doesn't limit what the map shows.
		self.assertIsNone(access.restricted_values({"Warehouse": [{"doc": "X", "applicable_for": "Sales Invoice"}]}, "Warehouse"))
		self.assertIsNone(access.restricted_values({}, "Warehouse"))

	def test_combine_and_keep(self):
		company = {"A": "Pranera", "B": "Other", "C": "Pranera"}
		self.assertEqual(access.combine(["A", "B", "C"], company, {"A", "B"}, None), {"A", "B"})
		self.assertEqual(access.combine(["A", "B", "C"], company, None, {"Pranera"}), {"A", "C"})
		self.assertEqual(access.combine(["A", "B", "C"], company, {"A", "B"}, {"Pranera"}), {"A"})
		rows = [{"warehouse": "A"}, {"warehouse": "B"}]
		self.assertEqual(access.keep(rows, None), rows)
		self.assertEqual(access.keep(rows, {"B"}), [{"warehouse": "B"}])
		self.assertEqual(access.keep([{"wh": "A"}], set(), "wh"), [])

	def test_sql_params(self):
		self.assertEqual(access.sql_params(None), {"wh_all": 1, "wh_list": ("",)})
		self.assertEqual(access.sql_params({"B", "A"}), {"wh_all": 0, "wh_list": ("A", "B")})
		self.assertEqual(access.sql_params(set()), {"wh_all": 0, "wh_list": ("",)})

	def test_allowed_warehouses_with_site(self):
		import frappe
		mod = types.ModuleType("frappe.core.doctype.user_permission.user_permission")
		mod.get_user_permissions = lambda user: self.PERMS
		saved = {k: getattr(frappe, k, None) for k in ("session", "local")}
		saved_sql = getattr(frappe.db, "sql", None)
		sys.modules["frappe.core.doctype.user_permission.user_permission"] = mod
		try:
			frappe.session = types.SimpleNamespace(user="picker@x.com")
			frappe.local = types.SimpleNamespace()
			frappe.db.sql = lambda q, p=None, as_dict=False: [
				types.SimpleNamespace(name="Main - P", company="Pranera"),
				types.SimpleNamespace(name="Rack A - P", company="Other")]
			self.assertEqual(access.allowed_warehouses(), {"Main - P"})
			self.assertTrue(access.can_see("Main - P"))
			self.assertFalse(access.can_see("Rack A - P"))
			with self.assertRaises(PermissionError):
				access.require("Rack A - P")
			frappe.session.user, frappe.local = "Administrator", types.SimpleNamespace()
			self.assertIsNone(access.allowed_warehouses())
		finally:
			for k, v in saved.items():
				setattr(frappe, k, v)
			frappe.db.sql = saved_sql
			sys.modules.pop("frappe.core.doctype.user_permission.user_permission", None)


if __name__ == "__main__":
	unittest.main()
