# 🏭 Warehouse Theatre 3D

> Free 3D & 2D warehouse storage visualization for ERPNext — works with the warehouse hierarchy you already have

![ERPNext](https://img.shields.io/badge/ERPNext-v15-blue) ![Vue 3](https://img.shields.io/badge/Vue-3.x_CDN-brightgreen) ![Three.js](https://img.shields.io/badge/Three.js-r128-orange) ![License](https://img.shields.io/badge/License-MIT-green) ![Price](https://img.shields.io/badge/Price-Free-success)

---

## What it does

Most ERPNext warehouse setups are just a flat list of names in the Warehouse tree. Warehouse Theatre 3D turns that tree into a navigable 3D and 2D warehouse you can walk through, search, and inspect — stock levels, fill percentage, and item detail, all live from your existing Bin data.

No relabeling required. A one-time setup wizard reads the warehouse hierarchy you already have and asks you to assign a role (Building, Floor, Slot, Bin) to each level it finds — it never renames or moves anything.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Setup wizard** | Scans your existing warehouse tree by depth, lets you assign Building/Floor/Slot/Bin roles, and is done in under two minutes |
| **3D view** | Interactive Three.js rack visualization — orbit, pan, zoom |
| **2D floor view** | Section grid with slot tiles and per-level fill indicators |
| **Aisle walk-through** | First-person view — stand inside any aisle gap and walk it with WASD or on-screen controls |
| **Live stock data** | Real-time quantity, UOM fill percentage, and stock value straight from ERPNext Bins |
| **Item search** | Filter by item code or item name across all views |
| **Detail panel & item modal** | Single click for a quick side panel, double click for the full item table |
| **Configure stack levels** | Add or remove Bin levels per Slot without touching the Warehouse list view |
| **Floor plan editor** | Drag-and-place row/column layout with adjustable aisle gaps |
| **Dark / light theme** | One click |
| **PWA support** | Installable, works offline with cached data |
| **Mobile responsive** | Touch orbit/zoom, collapsible sidebar, on-screen aisle controls |
| **Role-based access** | System Manager can edit; Stock Manager and Stock User get full view-only access |

---

## 🏗️ How the hierarchy works

The app uses a generic 4-role model — Building → Floor → Slot → Bin — but it adapts to *your* existing tree depth instead of requiring a specific naming convention:

```
Whatever you already have          →  Role you assign in the wizard
─────────────────────────────────────────────────────────────────
Depth 1 (e.g. "Main Campus")       →  Building   (optional)
Depth 2 (e.g. "Ground Floor")      →  Floor
Depth 3 (e.g. "A1", "A2", "B1")    →  Slot       (renders as a rack)
Depth 4 (e.g. "L1", "L2", "L3")    →  Bin        (renders as a shelf level)
```

If your tree is only 3 levels deep, skip Building. If a level doesn't map cleanly, mark it "Skip" — the wizard handles uneven trees by letting you review every depth before committing.

> Stock is tracked at the **Bin** level, same as standard ERPNext. The app reads `tabBin` directly — no data migration.

---

## 📦 Installation

Available on the **Frappe Cloud Marketplace** — install it directly from your site's Marketplace Apps page, no manual setup required.

For self-hosted benches, install it the same way you install any other Frappe app for your bench/site.

Then open the app from the **/apps** screen, or go directly to `/warehouse-theatre-3d`.

---

## 🚀 First-time setup

1. Open the app — if no warehouse has been mapped yet, the setup wizard launches automatically
2. **Step 1 — Scan**: the app reads your existing `Warehouse` tree and groups warehouses by depth
3. **Step 2 — Map levels**: assign Building / Floor / Slot / Bin (or Skip) to each depth shown
4. **Step 3 — Done**: review the counts, then jump straight into the 3D view

No SQL, no manual custom field setup, no need to rename any warehouse.

---

## 🎮 Controls

### 3D view
| Action | Control |
|---|---|
| Orbit | Left mouse drag |
| Pan | Right mouse drag |
| Zoom | Scroll wheel |
| Highlight + side panel | Single click |
| Full stock details | Double click |

### Aisle walk-through
| Action | Control |
|---|---|
| Enter | Click **👁 Aisle View**, choose an aisle from the picker |
| Look around | Mouse drag |
| Walk | W/S or ▲▼ buttons |
| Strafe | A/D or ◄► buttons |
| Exit | **✕ Exit Aisle** or Escape |

### 2D view
| Action | Control |
|---|---|
| Open stock details | Click a slot tile |
| View a specific level | Click the level row inside the tile |

---

## 🔌 API reference

All methods are under `warehouse_theatre_3d.warehouse_theatre_3d.api`:

| Module | Method | Description |
|---|---|---|
| `setup` | `scan_warehouse_tree` | Groups existing warehouses by tree depth |
| `setup` | `apply_depth_mapping` | Writes the role assigned to each depth |
| `setup` | `get_setup_summary` | Returns counts per role for the wizard's review step |
| `api` | `get_warehouse_groups` | Floor warehouses for the sidebar |
| `api` | `get_slots` | Slot warehouses with levels and live stock data |
| `api` | `save_slot_position` | Updates floor plan row/col/gap |
| `api` | `save_stack_config` | Adds/disables Bin levels for a Slot |
| `api` | `save_uom_capacity` | Sets per-UOM capacity for fill % |
| `api` | `check_app_permission` | Controls visibility on the /apps screen |
| `api` | `get_user_access` | Returns the current user's view/edit/setup status |

---

## 🛠️ Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vue 3 via CDN — no build step |
| 3D engine | Three.js r128 |
| Backend | Frappe / ERPNext v15 |
| PWA | Web App Manifest + Service Worker |

---

## 💸 Pricing

Free. Always. Listed on the Frappe Cloud Marketplace under Frappe's [revenue-sharing program for free apps](https://frappe.io/blog/announcements/revenue-sharing-with-3rd-party-apps-on-frappe-cloud-marketplace) — install it, use it, no license keys.

---

## 🐛 Troubleshooting

| Problem | Fix |
|---|---|
| Setup wizard shows no warehouses | Create at least one `Warehouse` in Stock settings first |
| Slots overlapping in 3D | Use **Edit floor plan** to set row/column positions if the wizard's defaults need adjusting |
| Bins not appearing as levels | Confirm the Bin-role depth in setup actually contains the warehouses meant to be shelf levels |
| App not on /apps screen | Confirm your role is System Manager, Stock Manager, or Stock User |

---

## 🏢 Publisher

**Aravind G**
**GitHub:** [aravindsprint/warehouse_theatre_3d](https://github.com/aravindsprint/warehouse_theatre_3d)

## 📄 License

MIT
