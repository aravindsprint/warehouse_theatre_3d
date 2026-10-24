/* Warehouse Theatre 3D — Frappe Page v0.1.0 */
frappe.pages['warehouse-theatre-3d'].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Warehouse Theatre 3D',
		single_column: true,
	});

	$('<style id="wt3d-layout">').text(`
		.layout-main-section-wrapper,.layout-main-section,.page-content {
			padding:0!important;margin:0!important;max-width:none!important;
		}
		.layout-side-section{display:none!important;}
		.layout-main-section{padding:0!important;box-shadow:none!important;}
		.page-body .container{max-width:none!important;padding:0!important;}
	`).appendTo('head');

	const mount = document.createElement('div');
	mount.id = 'wt3d-root';
	mount.style.cssText = 'width:100%;height:calc(100vh - 57px);';
	$(wrapper).find('.layout-main-section')[0].appendChild(mount);

	function loadScript(src) {
		return new Promise(function (resolve, reject) {
			const s = document.createElement('script');
			s.src = src; s.onload = resolve;
			s.onerror = function () { reject(new Error('Failed to load ' + src)); };
			document.head.appendChild(s);
		});
	}

	// Feature modules register themselves with WarehouseTheatre3D before init(); ui.js first.
	const FEATURES = ['ui', 'heatmap', 'locate', 'stock-actions', 'putaway', 'routing', 'routes', 'timeline', 'export', 'alerts', 'health', 'deeplink', 'updates'];
	const bust = '?v=' + Date.now();

	loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js')
		.then(function () { return loadScript('https://unpkg.com/vue@3/dist/vue.global.prod.js'); })
		.then(function () { return loadScript('/assets/warehouse_theatre_3d/js/wt3d-vue.js' + bust); })
		.then(function () {
			// Sequential so registration order is stable; a failed feature doesn't block the app.
			return FEATURES.reduce(function (p, f) {
				return p.then(function () {
					return loadScript('/assets/warehouse_theatre_3d/js/features/' + f + '.js' + bust)
						.catch(function (e) { console.error('WT3D:', e.message); });
				});
			}, Promise.resolve());
		})
		.then(function () {
			if (window.WarehouseTheatre3D) window.WarehouseTheatre3D.init('wt3d-root');
		})
		.catch(function (e) { console.error('WT3D:', e.message); });
};
