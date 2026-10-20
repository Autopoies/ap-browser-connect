export const LIMIT = 4194304;
export const fault = (code, message) => Object.assign(new Error(message), { code });
export const invalid = (message) => fault("RECORD_INVALID_PARAMS", message);
export const id = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
export const bytes = (s) => new TextEncoder().encode(s).length;
export const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
export function canonical(v) {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
	return JSON.stringify(v);
}
export const equal = (a, b) => canonical(a) === canonical(b);
export function identity(v) {
	if (!v || !id(v.host_epoch) || !id(v.record_id) || Object.keys(v).length !== 2) throw invalid("Invalid recording identity");
	return { host_epoch: v.host_epoch, record_id: v.record_id };
}
export function credit(c, i, seq) {
	if (!c || !equal(c.identity, i) || c.next_seq !== seq || c.max_frame_bytes !== LIMIT) throw fault("RECORD_SEQUENCE", "Invalid recording credit");
}
export function validateRect(r) {
	if (!r || ![r.x,r.y,r.width,r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0) throw invalid("Invalid CSS rectangle");
}
export function startParams(p) {
	if (p?.protocol_version !== 2) throw fault("RECORD_UNSUPPORTED_VERSION", "Recording requires protocol v2; upgrade host and extension");
	if (typeof p.backend !== "string") throw invalid("Missing or malformed screenshot backend");
	if (p.backend !== "cdp_capture_screenshot") throw fault("RECORD_UNSUPPORTED_BACKEND", "Recording requires cdp_capture_screenshot");
	identity(p.identity);
	if (!id(p.operation_id) || (p.tab_id != null && !integer(p.tab_id,0,Number.MAX_SAFE_INTEGER))) throw invalid("Invalid operation or tab");
	const c = p.config;
	if (!c || !integer(c.max_duration_ms,1,60000) || !integer(c.capture_fps,1,30) || !integer(c.jpeg_quality,1,100)) throw invalid("Invalid capture configuration");
	if (!c.region || !["viewport","rect","element"].includes(c.region.kind)) throw invalid("Invalid region");
	if (c.region.kind === "rect") validateRect(c.region.rect);
	if (c.region.kind === "element" && (typeof c.region.selector !== "string" || !bytes(c.region.selector) || bytes(c.region.selector) > 1024)) throw invalid("Invalid selector");
	if (!c.labels || typeof c.labels !== "object" || Array.isArray(c.labels) || Object.keys(c.labels).length > 16) throw invalid("Invalid labels");
	let total = 0;
	for (const [k,v] of Object.entries(c.labels)) {
		if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k) || typeof v !== "string" || bytes(v) > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(v)) throw invalid("Invalid label");
		total += bytes(k) + bytes(v);
	}
	if (total > 4096 || (c.run_id != null && !id(c.run_id))) throw invalid("Invalid labels or run ID");
	credit(p.initial_credit,p.identity,1);
}
// Never clamp, round or backdate an owned observation, even on clock anomalies.
export function validateObservation(o,hard,t,previous=0) {
	const {request_started_ms:a,response_received_ms:b,geometry_validated_ms:c}=o;
	if (![a,b,c].every(n=>Number.isFinite(n) && n>=0 && n<=hard) || a>=hard || a>b || b>c || b!==t || a<previous) throw invalid("Invalid screenshot observation interval");
}
// Shared v2 event semantics (including byte bounds, literal text and safe duration).
export function validateEvent(method,p) {
	if (!id(p.operation_id) || typeof p.text !== "string" || bytes(p.text) > 512 || p.text.split("\n").length > 8 || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(p.text) ||
		(method === "record.mark" && (!p.text.length || !integer(p.duration_ms,1,10000)))) throw invalid("Invalid recording event");
}
// Strict bounded padded base64 and actual JPEG SOF; at most one bounded decode.
export function jpegDimensions(data) {
	if (typeof data !== "string" || !data.length || data.length > 4 * Math.ceil(LIMIT / 3) || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw invalid("Invalid JPEG base64");
	const decodedLength = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
	if (decodedLength > LIMIT) throw invalid("JPEG exceeds byte limit");
	let raw;
	try { raw = atob(data); } catch (_) { throw invalid("Invalid JPEG base64"); }
	if (raw.length > LIMIT || btoa(raw) !== data || raw.charCodeAt(0) !== 255 || raw.charCodeAt(1) !== 216 || raw.charCodeAt(raw.length-2) !== 255 || raw.charCodeAt(raw.length-1) !== 217) throw invalid("Invalid JPEG data");
	const u8 = (i) => raw.charCodeAt(i), u16 = (i) => u8(i)*256+u8(i+1);
	for (let pos=2; pos+3<raw.length;) {
		if (u8(pos++) !== 255) break;
		while (u8(pos) === 255) pos++;
		const marker = u8(pos++);
		if (marker === 218 || marker === 217) break;
		if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
		const length = u16(pos);
		if (length < 2 || pos+length > raw.length) break;
		if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
			if (length < 8) break;
			const height=u16(pos+3), width=u16(pos+5);
			if (!integer(width,1,16384) || !integer(height,1,16384) || width*height>64000000) break;
			return { width,height };
		}
		pos+=length;
	}
	throw invalid("Missing or invalid JPEG dimensions");
}
export function resolveRegion(region,v,element) {
	let r = { ...v };
	if (region.kind === "rect") r = { ...region.rect };
	if (region.kind === "element") {
		const e=element;
		if (!e || ![e.x,e.y,e.width,e.height].every(Number.isFinite)) throw invalid("Element has no visible bounds");
		const x=Math.max(0,e.x), y=Math.max(0,e.y);
		r={x,y,width:Math.min(v.width,e.x+e.width)-x,height:Math.min(v.height,e.y+e.height)-y};
	}
	validateRect(r);
	if (r.x+r.width>v.width || r.y+r.height>v.height) throw invalid("Region outside initial viewport");
	return r;
}
