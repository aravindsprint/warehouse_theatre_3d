# Privacy Policy — Warehouse Theatre 3D

_Last updated: 30 June 2026_

## Summary

Warehouse Theatre 3D does not collect, store, or transmit any of your
data outside your own ERPNext site. There is no analytics, no telemetry,
and no third-party tracking built into the App.

## What data the App accesses

The App reads and writes data that already exists in your ERPNext site,
specifically:

- The `Warehouse` doctype (name, parent warehouse, and the App's own
  custom fields: warehouse type, row, column, row gap)
- The `Bin` doctype (quantity, reserved quantity, valuation rate, stock
  value) for displaying live stock levels
- The `Warehouse UOM Capacity` child table (added by the App) for
  calculating fill percentage
- The current user's assigned roles, to determine view/edit access

All of this data stays within your own ERPNext database. The App does
not copy, export, or send this data to the Publisher or to any external
service.

## Third-party content delivery networks

The App's frontend is built with Vue 3 and Three.js. To avoid bundling
large libraries into the app itself, these two files are loaded directly
in the browser from public CDNs:

- `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`
- `https://unpkg.com/vue@3/dist/vue.global.prod.js`

These are static JavaScript library files, not API endpoints. Loading
them may expose your browser's IP address and standard request headers
to Cloudflare (cdnjs) and unpkg's infrastructure, in the same way loading
any public CDN resource does. No data from your ERPNext site is sent to
these CDNs. If your organization's policy prohibits loading external
scripts, you can self-host these two libraries and update the App's page
loader and standalone HTML file to point at your own copies — see the
README for the exact file locations.

## Cookies and local storage

The App does not set its own cookies. It relies on the same session
cookie your ERPNext site already uses for authentication. The optional
PWA mode uses a browser service worker and cache storage purely to cache
static assets (scripts, the app shell) for offline use — no personal
data is stored there.

## Data retention

Since the App does not collect or store data outside your own site,
there is nothing for the Publisher to retain or delete. Uninstalling the
App removes its custom fields and the `Warehouse UOM Capacity` table
from your site in the normal way an ERPNext app uninstall works.

## Children's privacy

The App is a business inventory tool and is not directed at children.

## Changes to this policy

This policy may be updated from time to time. The current version is
always available at the URL where you found this document.

## Contact

Questions about this privacy policy can be sent to: aravindsprint@gmail.com
