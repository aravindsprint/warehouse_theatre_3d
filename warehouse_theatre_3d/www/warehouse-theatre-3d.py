no_cache = 1

def get_context(context):
    import frappe
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/warehouse-theatre-3d"
        raise frappe.Redirect
    context.no_cache = 1
    # The standalone page has no desk JS, so feature actions that write (stock transfers,
    # counts, saving a dock or pick order) send this token with their POST requests.
    from frappe.sessions import get_csrf_token
    context.csrf_token = get_csrf_token()
