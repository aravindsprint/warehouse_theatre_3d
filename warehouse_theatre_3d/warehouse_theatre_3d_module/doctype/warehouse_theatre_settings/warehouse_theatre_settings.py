import frappe
from frappe.model.document import Document


class WarehouseTheatreSettings(Document):
	def validate(self):
		for field in ("bin_threshold", "floor_threshold"):
			value = self.get(field)
			if value is not None and not (0 < value <= 100):
				frappe.throw(f"{self.meta.get_label(field)} must be between 1 and 100.")
