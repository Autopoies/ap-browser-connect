const geometryError = () => Object.assign(new Error("Ambiguous or changed screenshot mapping"), { code: "RECORD_GEOMETRY_CHANGED" });
export function snapshotExpression(selector) {
	// Element bounds are read once, only at final selection; never scroll/focus/write.
	return `(() => { const v = window.visualViewport, d = document.documentElement; const e = ${selector == null ? "null" : `document.querySelector(${JSON.stringify(selector)})`}; const r = e && e.getBoundingClientRect(); return {dom:{inner_width:innerWidth,inner_height:innerHeight,client_width:d.clientWidth,client_height:d.clientHeight,device_scale_factor:devicePixelRatio,scroll_x:scrollX,scroll_y:scrollY,document_width:d.scrollWidth,document_height:d.scrollHeight,visual:v?{width:v.width,height:v.height,offset_x:v.offsetLeft,offset_y:v.offsetTop,page_x:v.pageLeft,page_y:v.pageTop,scale:v.scale}:null},element:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null}; })()`;
}
export function viewportObservation(value, metrics, emulation) {
	const l = metrics?.cssLayoutViewport, v = metrics?.cssVisualViewport, c = metrics?.cssContentSize;
	if (!value?.dom || !l || !v || !c) throw geometryError();
	const observation = { dom: value.dom, cdp: {
		layout_width: l.clientWidth, layout_height: l.clientHeight, page_x: l.pageX, page_y: l.pageY,
		visual: { width: v.clientWidth, height: v.clientHeight, offset_x: v.offsetX, offset_y: v.offsetY, page_x: v.pageX, page_y: v.pageY, scale: v.scale },
		zoom: v.zoom, content_width: c.width, content_height: c.height,
	}, emulation };
	mappingKey(observation);
	return observation;
}
export function mappingKey(o) {
	const d = o?.dom, c = o?.cdp;
	if (!d?.visual || !c?.visual || o.emulation !== "fresh_known_unemulated") throw geometryError();
	const positive = [d.inner_width,d.inner_height,d.client_width,d.client_height,d.device_scale_factor,d.document_width,d.document_height,c.layout_width,c.layout_height,c.zoom,c.content_width,c.content_height];
	const finite = [d.scroll_x,d.scroll_y,c.page_x,c.page_y];
	function visual(v) {
		positive.push(v.width,v.height,v.scale); finite.push(v.offset_x,v.offset_y,v.page_x,v.page_y);
		return [v.width,v.height,v.offset_x,v.offset_y,v.scale];
	}
	const dv = visual(d.visual), cv = visual(c.visual);
	if (!positive.every((n) => Number.isFinite(n) && n > 0) || !finite.every(Number.isFinite) ||
		Math.abs(d.client_width - c.layout_width) > 1 || Math.abs(d.client_height - c.layout_height) > 1 || d.client_width > d.inner_width || d.client_height > d.inner_height ||
		JSON.stringify(dv) !== JSON.stringify(cv) || dv[0] !== d.client_width || dv[1] !== d.client_height || dv[2] !== 0 || dv[3] !== 0 || dv[4] !== 1 || c.zoom !== 1) throw geometryError();
	return JSON.stringify([d.inner_width,d.inner_height,d.client_width,d.client_height,d.device_scale_factor,c.zoom,...dv,...cv]);
}
export function imageMapping(before, after, image) {
	const key = mappingKey(before);
	if (key !== mappingKey(after)) throw geometryError();
	return { observation: after, key: JSON.stringify([key, image.width, image.height]), viewport: { x: 0, y: 0, width: before.dom.inner_width, height: before.dom.inner_height },
		transform: { scale_x: image.width / before.dom.inner_width, scale_y: image.height / before.dom.inner_height, offset_x: 0, offset_y: 0 } };
}
