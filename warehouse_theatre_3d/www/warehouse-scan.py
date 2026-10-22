no_cache = 1


def get_context(context):
    import frappe
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/warehouse-scan"
        raise frappe.Redirect
    context.no_cache = 1
    # Posting moves, picks and counts are POST requests from a page without desk JS.
    from frappe.sessions import get_csrf_token
    context.csrf_token = get_csrf_token()
