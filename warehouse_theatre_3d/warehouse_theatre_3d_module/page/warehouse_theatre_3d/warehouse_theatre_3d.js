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

	function loadScript(src, cb) {
		const s = document.createElement('script');
		s.src = src; s.onload = cb;
		document.head.appendChild(s);
	}

	loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', function () {
		loadScript('https://unpkg.com/vue@3/dist/vue.global.prod.js', function () {
			loadScript('/assets/warehouse_theatre_3d/js/wt3d-vue.js?v=' + Date.now(), function () {
				if (window.WarehouseTheatre3D) window.WarehouseTheatre3D.init('wt3d-root');
			});
		});
	});
};
