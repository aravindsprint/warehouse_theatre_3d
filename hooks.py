from . import __version__ as app_version

app_name        = "warehouse_theatre_3d"
app_title       = "Warehouse Theatre 3D"
app_publisher   = "Aravind G"
app_description = "Free 3D & 2D warehouse storage visualization for any ERPNext warehouse hierarchy"
app_email       = "aravindsprint@gmail.com"
app_license     = "MIT"
app_version     = "0.1.0"

add_to_apps_screen = [
    {
        "name": "warehouse_theatre_3d",
        "logo": "/assets/warehouse_theatre_3d/images/logo.svg",
        "title": "Warehouse Theatre 3D",
        "route": "/warehouse-theatre-3d",
        "has_permission": "warehouse_theatre_3d.warehouse_theatre_3d.api.api.check_app_permission",
    }
]

website_route_rules = [
    {"from_route": "/warehouse-theatre-3d/<path:app_path>", "to_route": "warehouse-theatre-3d"},
]

fixtures = ["Custom Field"]
