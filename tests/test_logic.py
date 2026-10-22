"""Unit tests for the pure (database-free) logic in the feature APIs.

Run from the repository root:  python -m unittest discover -s tests
These live outside the app package so `bench run-tests` doesn't pick them up;
when Frappe isn't installed a minimal stub is used so they run anywhere.
"""

import sys
import types
import unittest
from datetime import date, datetime


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
	utils.get_url = lambda p="": "https://example.test" + p
	utils.escape_html = lambda s: s
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


if __name__ == "__main__":
	unittest.main()
