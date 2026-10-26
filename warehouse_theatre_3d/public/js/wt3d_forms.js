/* Warehouse Theatre 3D — buttons and a locations panel inside ERPNext forms.
   Loaded through hooks.doctype_js for each doctype listed below; the guard keeps it
   from registering twice when several of those forms are opened in one session. */
(function () {
	if (window.__wt3d_forms_loaded) return;
	window.__wt3d_forms_loaded = true;

	const ROLES = ['System Manager', 'Stock Manager', 'Stock User'];
	const APP = '/warehouse-theatre-3d';
	const SCAN = '/warehouse-scan';
	const API = 'warehouse_theatre_3d.warehouse_theatre_3d.api.links.';
	const GROUP = __('Warehouse map');

	const DOC_TYPES = ['Stock Entry', 'Purchase Receipt', 'Purchase Invoice', 'Subcontracting Receipt',
		'Delivery Note', 'Sales Invoice', 'Pick List', 'Material Request'];
	// Documents that bring stock in, where putaway suggestions make sense once submitted
	const RECEIVING = ['Purchase Receipt', 'Stock Entry', 'Subcontracting Receipt'];
	// Documents that only touch stock when "Update Stock" is ticked
	const UPDATE_STOCK = ['Purchase Invoice', 'Sales Invoice'];

	function allowed() {
		return !!(frappe.user && ROLES.some(r => frappe.user.has_role(r)));
	}

	function openMap(params) {
		window.open(APP + '?' + new URLSearchParams(params).toString(), '_blank', 'noopener');
	}

	// The phone app (/warehouse-scan): opened here too, so a desk user can start a job
	// or copy the link to a phone.
	function openScan(params) {
		window.open(SCAN + '?' + new URLSearchParams(params).toString(), '_blank', 'noopener');
	}

	function docButtons(frm) {
		if (frm.is_new() || !allowed()) return;
		if (UPDATE_STOCK.includes(frm.doctype) && !frm.doc.update_stock) return;
		frm.add_custom_button(__('Show on warehouse map'), () => openMap({ doc: frm.doctype, name: frm.doc.name }), GROUP);
		if (RECEIVING.includes(frm.doctype) && frm.doc.docstatus === 1) {
			frm.add_custom_button(__('Suggest putaway bins'), () => openMap({ putaway: frm.doctype, name: frm.doc.name }), GROUP);
			frm.add_custom_button(__('Put away with scanner'), () => openScan({ putaway: frm.doctype, name: frm.doc.name }), GROUP);
		}
		if (frm.doctype === 'Pick List' && frm.doc.docstatus < 2) {
			frm.add_custom_button(__('Optimise pick route'), () => openMap({ route: frm.doc.name }), GROUP);
		}
		if (frm.doctype === 'Pick List' && frm.doc.docstatus === 1 && frm.doc.purpose === 'Delivery') {
			frm.add_custom_button(__('Pack with scanner'), () => openScan({ pack: frm.doc.name }), GROUP);
		}
		const outward = frm.doctype === 'Delivery Note' || (frm.doctype === 'Sales Invoice' && frm.doc.update_stock);
		if (outward && frm.doc.docstatus === 0 && !frm.doc.is_return && !frm.is_new()) {
			frm.add_custom_button(__('Pack with scanner'), () => openScan({ pack: frm.doc.name, doctype: frm.doctype }), GROUP);
			frm.add_custom_button(__('Dispatch with scanner'), () => openScan({ dispatch: frm.doc.name, doctype: frm.doctype }), GROUP);
		}
		const delivered = frm.doctype === 'Delivery Note' || (frm.doctype === 'Sales Invoice' && frm.doc.update_stock);
		if (delivered && frm.doc.docstatus === 1 && !frm.doc.is_return) {
			frm.add_custom_button(__('Return with scanner'), () => openScan({ return: frm.doc.name, doctype: frm.doctype }), GROUP);
		}
		if (frm.doctype === 'Pick List' && frm.doc.docstatus === 0) {
			frm.add_custom_button(__('Pick with scanner'), () => openScan({ pick: frm.doc.name }), GROUP);
		}
	}

	DOC_TYPES.forEach(dt => frappe.ui.form.on(dt, { refresh: docButtons }));
	// Purchase Order: receive it on the phone (it isn't shown on the map itself).
	frappe.ui.form.on('Purchase Order', {
		refresh(frm) {
			if (!allowed() || frm.doc.docstatus !== 1 || (frm.doc.per_received || 0) >= 100) return;
			frm.add_custom_button(__('Receive with scanner'), () => openScan({ receive: frm.doc.name }), GROUP);
		},
	});

	// ── Item: where it's stored, right on the form ──
	function placeText(r) {
		if (!r.mapped) return frappe.utils.escape_html(r.warehouse_label || r.warehouse);
		// A floor zone's only "level" is the zone itself, so its label adds nothing.
		const level = r.label && r.label !== r.slot_label && r.label !== 'Floor stack' ? r.label : null;
		const parts = [r.floor_label, r.slot_label, level].filter(Boolean);
		return parts.map(p => frappe.utils.escape_html(p)).join(' › ');
	}

	function renderLocations(frm, rows) {
		frm.dashboard.wrapper.find('.wt3d-locations').closest('.form-dashboard-section').remove();
		if (!rows || !rows.length) return;
		const shown = rows.slice(0, 8);
		const body = `
			<div class="wt3d-locations">
				<table class="table table-sm" style="margin:0">
					<thead><tr><th>${__('Location')}</th><th class="text-right">${__('Qty')}</th><th></th></tr></thead>
					<tbody>
						${shown.map(r => `
							<tr>
								<td>${placeText(r)}${r.mapped ? '' : ` <span class="text-muted small">(${__('not on the map')})</span>`}</td>
								<td class="text-right">${format_number(r.qty, null, 2)} ${frappe.utils.escape_html(r.uom || '')}
									${r.reserved > 0 ? `<span class="text-muted small"> · ${format_number(r.reserved, null, 2)} ${__('reserved')}</span>` : ''}</td>
								<td class="text-right">${r.mapped ? `<a href="#" class="wt3d-loc-open" data-wh="${frappe.utils.escape_html(r.warehouse)}">${__('View')} ↗</a>` : ''}</td>
							</tr>`).join('')}
					</tbody>
				</table>
				${rows.length > shown.length ? `<div class="text-muted small" style="margin-top:6px">${__('and {0} more warehouses', [rows.length - shown.length])}</div>` : ''}
			</div>`;
		const section = frm.dashboard.add_section(body, __('Warehouse locations'));
		$(section).find('.wt3d-loc-open').on('click', function (e) {
			e.preventDefault();
			openMap({ locate: frm.doc.name, focus: $(this).attr('data-wh') });
		});
	}

	frappe.ui.form.on('Item', {
		refresh(frm) {
			if (frm.is_new() || !frm.doc.is_stock_item || !allowed()) return;
			frm.add_custom_button(__('Show on warehouse map'), () => openMap({ locate: frm.doc.name }), GROUP);
			frappe.call({
				method: API + 'get_item_locations',
				args: { item_code: frm.doc.name },
				callback: r => renderLocations(frm, r.message || []),
				error: () => {},   // no stock or no permission: just don't show the panel
			});
		},
	});

	// ── Warehouse: jump to it on the map ──
	frappe.ui.form.on('Warehouse', {
		refresh(frm) {
			if (frm.is_new() || !frm.doc.wt_warehouse_type || !allowed()) return;
			frm.add_custom_button(__('Open in 3D view'), () => openMap({ focus: frm.doc.name }), GROUP);
			if (['Bin', 'Zone'].includes(frm.doc.wt_warehouse_type)) {
				frm.add_custom_button(__('Count with scanner'), () => openScan({ count: frm.doc.name }), GROUP);
			}
		},
	});
})();
