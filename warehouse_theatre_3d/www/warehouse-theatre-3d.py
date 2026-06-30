no_cache = 1

def get_context(context):
    import frappe
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/warehouse-theatre-3d"
        raise frappe.Redirect
    context.no_cache = 1
