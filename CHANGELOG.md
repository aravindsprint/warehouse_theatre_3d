# Changelog

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
