from . import __version__ as app_version

app_name        = "warehouse_theatre_3d"
app_title       = "Warehouse Theatre 3D"
app_publisher   = "Aravind G"
app_description = "Free 3D & 2D warehouse storage visualization for any ERPNext warehouse hierarchy"
app_email       = "aravindsprint@gmail.com"
app_license     = "MIT"
app_version     = "2.0.0"

add_to_apps_screen = [
    {
        "name": "warehouse_theatre_3d",
        "logo": "/assets/warehouse_theatre_3d/images/logo.svg",
        "title": "Warehouse Theatre 3D",
        "route": "/warehouse-theatre-3d",
        "has_permission": "warehouse_theatre_3d.warehouse_theatre_3d.api.api.check_app_permission",
    },
    {
        "name": "warehouse_scan",
        "logo": "/assets/warehouse_theatre_3d/images/scan-logo.svg",
        "title": "Warehouse Scan",
        "route": "/warehouse-scan",
        "has_permission": "warehouse_theatre_3d.warehouse_theatre_3d.api.api.check_app_permission",
    },
]

website_route_rules = [
    {"from_route": "/warehouse-theatre-3d/<path:app_path>", "to_route": "warehouse-theatre-3d"},
]

fixtures = ["Custom Field"]

# "Show on warehouse map" buttons and the Item form's locations panel.
# One file for all of them; it guards itself against loading twice.
doctype_js = {
    dt: "public/js/wt3d_forms.js"
    for dt in (
        "Item", "Warehouse", "Stock Entry", "Purchase Receipt", "Purchase Invoice",
        "Subcontracting Receipt", "Delivery Note", "Sales Invoice", "Pick List", "Material Request",
    )
}

# Who picked a Pick List, for the Operations view (api/fulfillment.py).
doc_events = {
    "Pick List": {
        "on_submit": "warehouse_theatre_3d.warehouse_theatre_3d.api.fulfillment.stamp_picker",
        "on_cancel": "warehouse_theatre_3d.warehouse_theatre_3d.api.fulfillment.clear_picker",
    },
}

scheduler_events = {
    "daily": [
        "warehouse_theatre_3d.alerts.send_capacity_alerts",
    ],
}
