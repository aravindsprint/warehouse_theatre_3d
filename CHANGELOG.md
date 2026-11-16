# Changelog

## Unreleased

Upgrading: run `bench migrate` (new Pick List and Sales Invoice fields, new settings) and `bench build`.

### Pack and Dispatch in Warehouse Scan

Two new modes finish the order flow on the floor: pick → **pack** → **dispatch**.

- **Pack:** a list of picked orders waiting to be packed, oldest first. Open one, or scan its Pick List, Delivery Note or Sales Invoice. If no dispatch document exists yet, the app creates the draft in the flow set in Warehouse Theatre Settings: a Delivery Note (ERPNext's own *Create Delivery Note*) or a Sales Invoice with Update Stock on, built from the Sales Orders with only what was picked, from the shelves it was picked from (ERPNext v16 uses its own Pick List → Sales Invoice). Scan items into a carton: each scan adds one, a box barcode adds the whole box, tap a line to type a quantity. Wrong items and wrong batches are caught. **Close carton** asks for an optional weight. In the Delivery Note flow each carton is a submitted Packing Slip, so ERPNext's packed quantities stay right; in the Sales Invoice flow cartons are kept on the invoice. A carton closed by mistake can be unpacked.
- **Carton labels:** 4×6 inch (100×150 mm) shipping labels with the customer and shipping address, carton *n of N*, units, weight, LR number and a QR code (`<document>/<carton no>`).
- **Dispatch:** a list of orders ready to go. Scan a carton label to open its order; scanning each carton onto the vehicle ticks it off, and a carton from another order is caught. Enter the transporter, LR / AWB and vehicle number (the last transporter and vehicle are remembered) and **Dispatch** submits the Delivery Note or Sales Invoice. Unpacked lines, unscanned cartons and a missing LR number are flagged before submitting. Sales Invoices without transport fields keep them in Remarks.
- After submitting a Pick List in Pick, **Pack it now** goes straight to packing it.
- New settings: **Dispatch with** (Delivery Note or Sales Invoice) and **Scan every carton before dispatch**.
- New buttons in ERPNext: **Pack with scanner** on submitted delivery Pick Lists and draft Delivery Notes / stock Sales Invoices, and **Dispatch with scanner** on the latter.
- Warehouse Scan modes can now live in their own files (`public/js/scan/*.js`) and register with the scanner before it starts.

### Operations view

A new **📦 Operations** view beside 3D / 2D / Health that shows where every delivery order is and gives each role its own dashboard.

- **Order status in both ERPNext flows.** Each delivery Pick List is *Pending* (draft), *Picked* (submitted), *Packed* or *Dispatched*. With Delivery Notes: packed = a submitted Packing Slip on a draft Delivery Note, dispatched = Delivery Note submitted. With Sales Invoices that update stock: packed = draft invoice, dispatched = submitted. Partial dispatches and billing % (Delivery Note flow) are shown too.
- **My work** (every role): Pick Lists waiting and assigned to me, what I picked and packed today and this week, lines picked in full, and my recent orders with where they are now.
- **Orders** (every role): every open order with its stage, time in stage, who picked and packed it, and its Delivery Note / Sales Invoice; filter by stage, open a pending list's walking route.
- **Team** (Stock Manager, System Manager): orders per stage, how long each stage takes (median and average), stuck orders (over 24 hours in a stage), dispatched and picked per day, pick accuracy, scanner use, a pickers and packers table, and Delivery Notes still to bill.
- **System** (System Manager): mapping coverage, bins and zones without a capacity, warehouses holding stock that aren't on the map, pick lines from unmapped warehouses, and users per role.
- New read-only **Picked By / Picked At** fields on Pick List, filled when a Pick List is submitted (from Warehouse Scan or the desk) and cleared on cancel. Lists submitted before this version show the picker as unknown.

## v2.0.0 (2026-10-24)

- **Get updates (opt-in):** after a System Manager's second visit, the 3D app offers a small card to sign up for updates and help from the developer. Nothing is sent unless they tick the consent box and press Send. The card shows exactly what goes (name, email, optional company and phone, and the site's address), and never any stock or business data. *Not now* hides it for 30 days; *Don't ask again* hides it for good. Sign-ups arrive as Leads in the publisher's ERPNext through a public Web Form.

## v1.0.0 (2026-10-23)

First stable release. Three big additions since v0.3.1: **Warehouse Scan**, a phone app for the people on the floor; the warehouse map **inside ERPNext forms**; and **Stock Health**, a report that works the moment the app is installed.

Upgrading: run `bench migrate` (two new Warehouse fields) and `bench build`.

### Warehouse Scan

A phone app at `/warehouse-scan`.

- **Put away:** scan a receipt (or one item), go to the suggested location, scan its label, confirm the quantity. Posts one Material Transfer, submitted unless batch/serial numbers are needed.
- **Pick:** walk a draft Pick List stop by stop in walking order. Scan the shelf, then the items; wrong items and wrong batches are caught; short picks and picking from another shelf are recorded. Save, or save and submit.
- **Count:** a *Due for counting* list (never counted first, then oldest, then highest value), scan-to-count with pack barcodes, blind count, and a check before posting. Differences go to a draft Stock Reconciliation; the count date is recorded on the location even when nothing differs (new *Last Counted On / By* fields).
- **Look up:** scan a location to see what's in it, or an item to see where it is.
- **Location labels:** print QR labels for every shelf and floor area on a floor, 24 or 8 per A4 sheet.
- Works with the phone camera (built-in barcode reader, or ZXing where the browser has none), hand-held scanners that type and press Enter, or typing. Beeps and vibrates on each scan; installable to the home screen.
- Picks saved from the scanner turn on the Pick List's *Pick Manually* and *Scan Mode*, so ERPNext keeps the recorded warehouses and doesn't mark skipped lines as fully picked on submit.
- Fix: saving an optimised order from **Spot the bottleneck** now turns on *Pick Manually*; before, ERPNext could rebuild the lines on save and lose the new order.
- Proper home-screen icons (PNG 192/512, maskable, and Apple touch icons) for both Warehouse Scan and the 3D app, so both install cleanly on Android and show an icon on iPhone. Warehouse Scan has its own icon and `/apps` tile.
- New buttons in ERPNext: **Pick with scanner** (draft Pick List), **Put away with scanner** (submitted receipts), **Count with scanner** (mapped Bin/Zone warehouses), and a **Warehouse Scan** tile on `/apps`.

### Inside ERPNext forms

The warehouse map from the screens people already work in.

- **Item:** a "Warehouse locations" panel on the form showing where the item is stored (Floor › Rack › Shelf, or the warehouse when it isn't mapped), with a link to each spot on the map, and a **Show on warehouse map** button.
- **Stock Entry, Purchase Receipt, Subcontracting Receipt, Delivery Note, Pick List, Material Request** (and Purchase / Sales Invoices that update stock): **Show on warehouse map** opens the document with every line's source (orange) and target (green) marked, numbered like the document's lines. Lines on other floors and warehouses not on the map are listed too.
- Submitted receipts: **Suggest putaway bins** opens putaway for that document.
- Pick List: **Optimise pick route** opens its route, on the floor where its items are.
- Warehouse: **Open in 3D view** jumps to that floor, rack, shelf or zone.
- Buttons appear under a "Warehouse map" menu, only for System Manager, Stock Manager and Stock User.
- The app also accepts these links directly: `?locate=ITEM`, `?focus=WAREHOUSE`, `?doc=DOCTYPE&name=NAME`, `?putaway=DOCTYPE&name=NAME`, `?route=PICK_LIST`.

### Stock Health

A report that works the moment the app is installed, from data every ERPNext site already has. No warehouse mapping needed.

- **Dead stock:** items with no outward movement in 30 / 90 / 180 / 365 days, by value.
- **Slow movers:** items that would take more than 6 months to use up at the current rate.
- **Stock age:** stock value by age (0–30 days up to over a year), estimated first-in-first-out; transfers between warehouses don't reset the age.
- **Expiring batches:** expired or expiring within 60 days.
- **Below reorder level:** Item Reorder rules at or under their level (projected qty, as ERPNext's auto re-order uses).
- **Negative stock** and **value by warehouse**.
- Opens as a **Health** tab next to 3D / 2D, and as the first screen before setup with a button to set up the 3D map, so new installs see value straight away.
- Filters by company, uses the top-bar search, and "Locate" jumps to the item on the 3D map.

## v0.3.1 (2026-10-22)

- Switching floors resets the camera. Before, after the camera flew to a bin (from Locate, Putaway, Alerts or Routes), the next floor opened with that pan and zoom and could appear off-screen.
- The v0.3.0 notes now mention that a godown's floor zones show as one block in 2D, laid out like the real floor.

## v0.3.0 (2026-10-21)

Support for godowns without racks, where stock sits on the floor.

- **Floor zones:** a new warehouse type, **Zone**, for an area of the floor where stock is stacked. It's drawn as a painted area with bales piled to its fill %, and can span several grid cells (width × depth).
- **Works with how godowns are already set up in ERPNext:**
  - a godown split into area warehouses: the godown is the floor and each area is a zone
  - a godown kept as a single warehouse: it shows as its own floor
  - a floor with racks and floor areas: both on the same floor
- **Setup detects floor storage automatically:** any warehouse that holds stock with no shelves under it becomes a zone. Existing sites can re-run setup, or set the type to Zone in Manage Warehouses.
- **Every tool works on zones:** heatmaps, locate, move/count stock, putaway, replay, export, capacity alerts.
- **Pick routes:** people walk between piles and cut through gaps between floor areas, while rack rows still block crossing along their length.
- Floor-plan editor: a zone's cell span sets its width.
- 2D view: a godown's floor zones show as one block laid out like the real floor; racks keep their row groups.

## v0.2.1 (2026-10-21)

Fixes the Frappe Cloud Marketplace audit findings.

- Saving from the floor plan editor, slot configuration, UOM capacities, warehouse management and the setup wizard now uses POST requests. Frappe commits these automatically, so the manual `frappe.db.commit()` calls are removed, and these methods no longer accept GET.
- Deleting a warehouse that has transactions rolls back only the failed delete (savepoint) before disabling it.
- SQL queries with an optional company filter no longer build the query text at runtime.

## v0.2.0 (2026-10-21)

Warehouse Theatre 3D now goes beyond showing where stock is: it helps you move it, put it away, pick it faster and see how it changed.

### New
- **🎨 Heatmap modes**: colour bins by movement, pick frequency, stock value, stock age (first-in-first-out estimate) or batch expiry, in 3D, 2D, tooltips and the legend.
- **📍 Item locator**: type or scan an item, barcode, batch or serial number. Every bin holding it gets a beacon and the camera flies there. Other floors and unmapped warehouses are listed too.
- **⇄ Stock actions**: move stock between bins (Material Transfer), count a bin (Stock Reconciliation) and open the Stock Ledger, from the detail panel. Pick the target bin by clicking it on the map.
- **📥 Putaway suggestions**: for a Purchase Receipt, Stock Entry or Subcontracting Receipt, rank bins by free capacity, distance from the dock, shelf height and current contents, then create one draft transfer.
- **🧭 Spot the bottleneck**: compare a Pick List's saved walking route with the shortest one, see metres and minutes saved, and save the better order to a draft Pick List. "Aisle traffic" shows the busiest walkways over a period.
- **⏱ Timeline replay**: watch each bin's quantity change day by day from the Stock Ledger, up to a year back.
- **⤓ Export**: 3D view as PNG, floor plan as PNG or A4 PDF, bin list as CSV.
- **⚠ Capacity alerts**: toolbar badge for bins over the limit, plus an optional daily email (new **Warehouse Theatre Settings** page).
- **Company switcher** for multi-company sites.

### Fixed
- The service worker no longer caches the rest of the ERPNext site, and new releases now show up without users clearing their cache.
- The company filter uses the warehouse's company instead of its name suffix.
- Editing a warehouse no longer jumps the view back to the first floor.
- GPU memory no longer grows when switching floors.

### Safety
Every new action runs with the user's own ERPNext permissions. Documents are created as drafts by default, and batch/serial-tracked items are always drafts.

### Upgrading
```bash
bench update --apps warehouse_theatre_3d   # or git pull in apps/warehouse_theatre_3d
bench --site <site> migrate
bench build --app warehouse_theatre_3d
```
`migrate` adds the Warehouse Theatre Settings page and a Dock Slot field on Floor warehouses. Set the dock once (Putaway → Set dock) so putaway and pick routes start from the right place.


## v0.1.0

First release on the Frappe Cloud Marketplace: setup wizard, 3D and 2D views, aisle walk-through, live stock, item search, floor plan editor, stack level configuration, dark/light theme, PWA, role-based access.
