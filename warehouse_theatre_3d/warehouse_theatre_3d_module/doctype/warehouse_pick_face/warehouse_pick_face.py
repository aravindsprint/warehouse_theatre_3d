import frappe
from frappe import _
from frappe.model.document import Document


class WarehousePickFace(Document):
	def validate(self):
		if self.min_qty < 0 or self.max_qty <= 0:
			frappe.throw(_("Refill levels must be positive."))
		if self.max_qty <= self.min_qty:
			frappe.throw(_("“Fill up to” must be more than “Refill at or below”."))
		if frappe.db.get_value("Warehouse", self.warehouse, "is_group"):
			frappe.throw(_("{0} is a group warehouse. Choose the shelf or floor area itself.").format(self.warehouse))
		clash = frappe.db.exists("Warehouse Pick Face", {
			"item_code": self.item_code, "warehouse": self.warehouse, "name": ["!=", self.name]})
		if clash:
			frappe.throw(_("{0} already has refill levels at {1} ({2}).").format(self.item_code, self.warehouse, clash))
