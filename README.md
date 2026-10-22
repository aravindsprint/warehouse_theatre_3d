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
| **Warehouse Scan (phone app)** | `/warehouse-scan`: put away receipts, walk Pick Lists and cycle count locations with the phone camera or a hand-held scanner. Prints QR location labels for every shelf and floor area |
| **Inside ERPNext forms** | Item shows where it's stored; Stock Entry, receipts, Delivery Note, Pick List and Material Request get "Show on warehouse map"; receipts get "Suggest putaway bins"; Pick List gets "Optimise pick route"; Warehouse gets "Open in 3D view" |
| **Stock Health** | Works right after install, no setup: dead stock, slow movers, stock age, expiring batches, items below reorder level, negative stock and value by warehouse |
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
| **Heatmap modes** | Recolour bins by movement, pick frequency, stock value, stock age (FIFO estimate) or batch expiry instead of fill % — in 3D, 2D, tooltips and the legend |
| **Item locator** | Type or scan (barcode/QR, batch or serial no.) an item; every bin holding it gets a beacon and the camera flies there. Other floors and unmapped warehouses are listed too |
| **Stock actions** | Move stock between bins (Material Transfer), count a bin (Stock Reconciliation) and open the Stock Ledger, straight from the detail panel. Pick the target bin by clicking it on the map |
| **Putaway suggestions** | For a Purchase Receipt, Stock Entry or Subcontracting Receipt (or typed items), rank bins by free capacity, distance from the dock, shelf height and what they already hold; one click makes a draft transfer |
| **Spot the bottleneck** | Draw a Pick List's walking route in its saved order next to the shortest order, with metres and minutes saved; save the better order to a draft Pick List. "Aisle traffic" overlays every pick trip in a period to show congested walkways |
| **Timeline replay** | Rebuild each bin's quantity day by day from the Stock Ledger and play it back (up to a year) |
| **Export** | 3D view as PNG, printable floor plan as PNG or A4 PDF, bin list as CSV — in whatever colouring is active |
| **Capacity alerts** | Toolbar badge for bins over the limit across all floors, plus an optional daily email (Warehouse Theatre Settings) |
| **Company switcher** | Filter floors by company on multi-company sites |
| **Floor storage (zones)** | Godowns without racks: areas of the floor drawn as stacked bales by fill %, spanning several grid cells. Works for a godown split into area warehouses, a godown kept as one warehouse, and floors that mix racks and floor areas |

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

**Godowns without racks** use a fifth role, **Zone**: an area of the floor where stock is stacked. Setup assigns it automatically to any warehouse that holds stock with no shelves under it:

```
Fabric Godown (Floor)            Yarn Godown (single warehouse)
 ├─ Area 1      → Zone            → Zone, shown as its own floor
 ├─ Near Gate   → Zone
 └─ Rack A      → Slot → Bins     (racks and zones can share a floor)
```

Set each zone's size (grid columns × rows) in **Manage warehouses**, or by its cell span in **Edit floor plan**, and give it a UOM capacity so its fill % and pile height mean something.

If your tree is only 3 levels deep, skip Building. If a level doesn't map cleanly, mark it "Skip" — the wizard handles uneven trees by letting you review every depth before committing.

> Stock is tracked at the **Bin** level, same as standard ERPNext. The app reads `tabBin` directly — no data migration.

---

## 📦 Installation

Available on the **Frappe Cloud Marketplace** — install it directly from your site's Marketplace Apps page, no manual setup required.

For self-hosted benches, install it the same way you install any other Frappe app for your bench/site.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

Then open the app from the **/apps** screen, or go directly to `/warehouse-theatre-3d`.

---

## 🚀 First-time setup

1. Open the app — if no warehouse has been mapped yet, it opens on **Stock Health** (which needs no setup) with a button to set up the 3D map
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

## 🧰 Using the tools

The toolbar under the top bar holds the newer tools. A few things worth knowing:

- **Set the dock first.** Open **Putaway** → *Set dock* and click the slot next to your receiving dock. Putaway distances and pick routes start there (otherwise the front-left corner).
- **Mark aisles for accurate routes.** Routes walk along the gaps between rows. Gaps under 1 m are treated as back-to-back racking with no walkway, so set row gaps (or aisle rows) in **Edit floor plan** to match the real floor.
- **Fill %, putaway and alerts need UOM capacities.** Bins without a capacity for a UOM are still suggested, but ranked lower and flagged "no capacity set".
- **Stock actions create drafts by default.** "Submit now" on a move only applies to items without batch or serial numbers; tracked items are saved as drafts to finish in ERPNext. Counts always create a draft Stock Reconciliation.
- **Replay is read-only.** While replaying, stock actions, putaway, routes and the locator are hidden, and heatmaps fall back to fill %.
- **Capacity email:** turn it on in **Warehouse Theatre Settings** (`/app/warehouse-theatre-settings`) with thresholds and recipients. It runs daily.

---

## 📱 Warehouse Scan (phone app)

Open **`/warehouse-scan`** on a phone (or the **Warehouse Scan** tile on `/apps`) and add it to the home screen. It works with the phone camera, with hand-held / ring scanners that type the code and press Enter, or by typing.

1. **Print location labels first.** *Print location labels* makes an A4 sheet of QR labels (24 small or 8 large per page) for every shelf and floor area on the floor. Stick one on each. Item barcodes come from the Item's *Barcodes* table; a barcode with a UOM (e.g. a box of 12) counts as that many.
2. **Put away:** scan a Purchase Receipt, Stock Entry or Subcontracting Receipt (or one item). The app shows the best location for each item; scan that shelf's label and confirm the quantity. *Post* makes one Material Transfer, submitted straight away unless an item needs batch or serial numbers.
3. **Pick:** scan or choose a draft Pick List. It walks you stop by stop in walking order: scan the shelf, then each item, and confirm the quantity (short picks are fine). Picking from a different shelf updates that line's warehouse. *Save & submit* writes picked quantities to the Pick List.
4. **Count:** start from the *Due for counting* list (never counted first, then oldest, then highest value) or scan any location. Scan every item (each scan adds one, or a pack), tap a line to type a total, and turn on *Blind count* to hide ERPNext's quantities. Differences become a **draft** Stock Reconciliation for a Stock Manager to submit; the location's last-counted date is recorded even when nothing differs.
5. **Scan anything** on the home screen: a location shows what's in it, an item shows where it is, a Pick List or receipt opens the right job.

ERPNext forms link here too: **Pick with scanner** on draft Pick Lists, **Put away with scanner** on submitted receipts, and **Count with scanner** on mapped Bin and Zone warehouses.

The camera needs the site on **https**. Batch and serial items can be counted and moved, but their batch/serial numbers are finished in ERPNext.

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
| `insights` | `get_bin_metrics` | Per-bin movement, value, FIFO age, batch expiry and pick counts for a Floor |
| `insights` | `search_items` / `resolve_scan` / `locate_item` | Item search, barcode/batch/serial lookup, and every bin holding an item |
| `insights` | `get_timeline` | Opening balance + daily changes per bin from the Stock Ledger |
| `insights` | `get_capacity_alerts` | Bins and floors at or above the thresholds |
| `operations` | `get_bin_stock` | Every item in one bin, with batch/serial flags |
| `operations` | `create_material_transfer` *(POST)* | Draft (or, for untracked items, submitted) Material Transfer between two bins |
| `operations` | `create_stock_reconciliation` *(POST)* | Draft Stock Reconciliation from counted quantities |
| `operations` | `get_receipt_items` / `get_putaway_plan` / `create_putaway_transfer` *(POST)* | Putaway suggestions and one draft transfer for the whole plan |
| `operations` | `get_floor_meta` / `save_dock` *(POST)* | The Floor's dock slot |
| `health` | `get_stock_health` | Dead/slow stock, ageing, expiring batches, below reorder, negative stock, value by warehouse (cached 10 min) |
| `links` | `get_document_locations` / `get_item_locations` / `find_warehouse` | A stock document's lines, an item's locations, or one warehouse, placed on the map (used by the form buttons) |
| `scan` | `resolve_code` | What a scanned code is: location, item (with pack size), batch, serial no., Pick List or receipt |
| `scan` | `get_floor_locations` / `get_pick_list` | A floor's locations with the count queue; a Pick List's rows in walking order |
| `scan` | `post_transfer` / `save_picks` / `finish_count` *(POST)* | Moves from the phone, picked quantities on a draft Pick List, and a location count |
| `routes` | `get_pick_lists` / `get_pick_rows` / `get_period_pick_rows` | Pick List rows on a Floor |
| `routes` | `reorder_pick_list` *(POST)* | Save a new row order to a draft Pick List |

Methods marked *(POST)* write data. They run with the user's own ERPNext permissions (no `ignore_permissions`), so a user who can't create Stock Entries in ERPNext can't create them here either.

---

## 🛠️ Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vue 3 via CDN — no build step |
| 3D engine | Three.js r128 |
| Backend | Frappe / ERPNext v15 |
| PWA | Web App Manifest + Service Worker |
| Feature modules | `public/js/features/*.js`, each registering with `WarehouseTheatre3D.register()` before the app mounts |
| On demand | html5-qrcode (scanning on browsers without `BarcodeDetector`), jsPDF (PDF export) |

### Tests

```bash
python -m unittest discover -s tests        # putaway ranking, FIFO age, timeline, fill %, pick reordering
node --test tests/routing.test.js           # aisle-aware route distances and optimisation
```

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
| Camera button says it needs https | Browsers only allow the camera on https sites. Use a hand-held scanner, or serve the site over https |
| A label scans as "isn't a location" | Reprint it from *Print location labels*; labels hold the warehouse name, so renaming a warehouse needs a new label |
| App not on /apps screen | Confirm your role is System Manager, Stock Manager, or Stock User |

---

## 🏢 Publisher

**Aravind G**
**GitHub:** [aravindsprint/warehouse_theatre_3d](https://github.com/aravindsprint/warehouse_theatre_3d)

## 📄 License

MIT
