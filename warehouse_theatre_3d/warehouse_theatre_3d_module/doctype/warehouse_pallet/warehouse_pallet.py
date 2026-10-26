import frappe
from frappe import _
from frappe.model.document import Document


class WarehousePallet(Document):
	def validate(self):
		if frappe.db.get_value("Warehouse", self.warehouse, "is_group"):
			frappe.throw(_("{0} is a group warehouse. A pallet sits in a shelf or floor area.").format(self.warehouse))
		self.items = [r for r in self.items if (r.qty or 0) > 0]
		if self.status == "Active" and not self.items:
			self.status = "Empty"
