// Annotation overlay: persistent geometry, optimistic pins, and a session-bound thread.
(() => {
	const PIN_UI_VERSION = "2026-10-20-selection-controls";
	const previousHost = document.querySelector("#ap-annotate-root");
	if (window.__apAnnotatePanel && previousHost) {
		// Refresh an outdated Pin Mode panel without replacing any live Connect thread.
		if (
			previousHost.shadowRoot?.querySelector(".dock.bound") ||
			previousHost.dataset.apPinUi === PIN_UI_VERSION
		) {
			window.__apAnnotatePanel.toggle();
			return;
		}
	}
	window.__apAnnotateCleanup?.();
	document.querySelector("#ap-annotate-root")?.remove();
	document.querySelector("#__ap_annotate_host")?.remove();

	const REF_ATTR = "data-ap-ref";
	const TARGETS =
		'button, input, select, textarea, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [contenteditable], [tabindex], pre, code';
	const marks = new Map(); // Element or Range -> { item, el, range, boxEls, capsuleEl, ... }
	let localAnnotations = [];
	let savedBinding = null;
	let currentBinding = null; // Interactive layout: ready/checking/unknown, never definitively offline.
	let currentBindings = [];
	let healthExpiryTimer = null;
	let refreshInFlight = false;
	const drafts = new Map();

	function canSendTo(sessionId, epoch) {
		return currentBindings.some(
			(b) =>
				b.session_id === sessionId &&
				(!epoch || b.receiver_epoch === epoch) &&
				b.health?.state === "ready" &&
				b.receiver_epoch &&
				b.health.valid_until > Date.now(),
		);
	}
	function relayButton(text, action, className = "", icon = "", target = null, epoch = null) {
		const btn = button(
			text,
			() => {
				const id = target || currentBinding?.session_id;
				if (canSendTo(id, epoch)) action();
				else showBanner("Receiver not ready — your draft and pins are preserved");
			},
			className,
			icon,
		);
		btn.dataset.relayTarget = target || "";
		btn.dataset.relayEpoch = epoch || "";
		btn.disabled = !canSendTo(target || currentBinding?.session_id, epoch);
		return btn;
	}
	function syncCapabilities() {
		for (const btn of shadow.querySelectorAll("[data-relay-target]"))
			btn.disabled = !canSendTo(
				btn.dataset.relayTarget || currentBinding?.session_id,
				btn.dataset.relayEpoch,
			);
		for (const form of shadow.querySelectorAll("form")) {
			const submit = form.querySelector('button[type="submit"]');
			if (submit && form.canSubmit) submit.disabled = !!form.pending || !form.canSubmit();
		}
	}

	let sessionMenuOpen = false;
	let bindingRevision = 0;
	let tabId = null;
	let windowId = null;
	let nextRef = 250; // Snapshot enumeration owns 0..249; assign other refs only on pin.
	let visible = true;
	let pickerActive = true;
	let altHeld = false;
	let minimized = true;
	let lastPointer = null;
	let pointerDown = null;
	let pinDragStyles = [];
	let marksFrame = 0;
	let previewFrame = 0;
	let selectionFrame = 0;
	let selectionContext = null;
	let dockPosition = null;
	let dockSize = null;
	let drag = null;
	let resizeState = null;
	let shortcut = { key: "e", metaKey: true, shiftKey: true };
	let saveChain = Promise.resolve();
	let pinsEdited = false;
	let initialized = false;
	let clearedBeforeLoad = false;
	const editedSelectors = new Set();
	let currentThreadId = null;
	let activity = "";
	let activityTimer = 0;
	let activeCapsule = null;
	const cards = [];
	const listeners = [];

	function node(tag, className = "", text = "") {
		const el = document.createElement(tag);
		el.className = className;
		el.textContent = text;
		return el;
	}
	function createSvgIcon(kind) {
		const paths = {
			crosshair: ["M12 3v4m0 10v4M3 12h4m10 0h4", "M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0"],
			play: ["m8 5 11 7-11 7Z"],
			terminal: ["m5 7 5 5-5 5m8 0h6"],
			sparkle: ["m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"],
			"arrow-up": ["M12 19V5m-6 6 6-6 6 6"],
			pin: ["m9 3 12 12-4 1-4 5-2-2 5-4 1-4M3 21l7-7"],
			unlink: ["m3 3 18 18M8 7 6 9a4 4 0 0 0 6 6l1-1m3-3 2-2a4 4 0 0 0-6-6l-1 1"],
			copy: ["M9 9h11v12H9ZM5 15H3V3h11v3"],
			check: ["m5 12 4 4L19 6"],
			refresh: ["M20 7v5h-5", "M19 12a7 7 0 1 0-2 5"],
			chevron: ["m8 5 7 7-7 7"],
			minus: ["M5 12h14"],
			close: ["m6 6 12 12M6 18 18 6"],
			reply: ["m9 15-5-5 5-5", "M4 10h11a4 4 0 0 1 4 4v2"],
			"chevron-up": ["m18 15-6-6-6 6"],
		};
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		for (const [key, value] of Object.entries({
			viewBox: "0 0 24 24",
			width: "14",
			height: "14",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "1.5",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"aria-hidden": "true",
		}))
			svg.setAttribute(key, value);
		for (const d of paths[kind] || paths.sparkle) {
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("d", d);
			svg.append(path);
		}
		return svg;
	}
	function button(text, action, className = "", icon = "") {
		const el = node("button", className);
		const glyph =
			icon ||
			(text.startsWith("Ask")
				? "sparkle"
				: {
						Run: "play",
						Pick: "crosshair",
						Pin: "pin",
						Disconnect: "unlink",
						Copy: "copy",
						Approve: "check",
						Cancel: "close",
						Send: "arrow-up",
					}[text]);
		if (glyph) el.append(createSvgIcon(glyph));
		if (text) el.append(node("span", "", text));
		else {
			el.setAttribute("aria-label", icon);
			el.title = icon;
		}
		el.type = "button";
		el.addEventListener("click", action);
		return el;
	}
	function statusText(el, text, state) {
		el.replaceChildren(node("span", `status-dot ${state}`), node("span", "status-label", text));
	}
	function listen(target, type, handler, options) {
		target.addEventListener(type, handler, options);
		listeners.push(() => target.removeEventListener(type, handler, options));
	}
	function ownEvent(e) {
		return e.composedPath().includes(host);
	}
	function clamp(n, min, max) {
		return Math.max(min, Math.min(n, Math.max(min, max)));
	}
	function viewportRect() {
		const vv = window.visualViewport;
		const left = vv ? vv.offsetLeft : 0;
		const top = vv ? vv.offsetTop : 0;
		const width = vv ? vv.width : document.documentElement.clientWidth || window.innerWidth;
		const height = vv ? vv.height : document.documentElement.clientHeight || window.innerHeight;
		return {
			left,
			top,
			width,
			height,
			right: left + width,
			bottom: top + height,
			zoomed: Boolean(
				vv && (vv.offsetLeft > 0.5 || vv.offsetTop > 0.5 || Math.abs((vv.scale || 1) - 1) > 0.01),
			),
		};
	}
	function label() {
		return currentBinding?.label || "Agent";
	}
	const LAYOUT_STORAGE_KEY = "__ap_annotate_layout_v1";
	function siteKey(hostName = location.hostname) {
		const clean = String(hostName || "")
			.trim()
			.toLowerCase()
			.replace(/^www\./, "");
		if (!clean || clean === "localhost" || /^\d+(?:\.\d+){3}$/.test(clean) || clean.includes(":"))
			return clean || "local";
		const parts = clean.split(".");
		if (parts.length <= 2) return clean;
		const twoPartTlds = new Set([
			"co.uk",
			"org.uk",
			"ac.uk",
			"gov.uk",
			"com.cn",
			"net.cn",
			"org.cn",
			"gov.cn",
			"edu.cn",
			"co.jp",
			"ne.jp",
			"or.jp",
			"com.au",
			"net.au",
			"org.au",
			"com.hk",
			"com.tw",
			"com.sg",
			"com.br",
			"co.kr",
			"co.in",
		]);
		const tail2 = parts.slice(-2).join(".");
		return twoPartTlds.has(tail2) && parts.length >= 3 ? parts.slice(-3).join(".") : tail2;
	}
	function fuzzyMatchSiteLayout(map, key) {
		if (!map || typeof map !== "object") return null;
		if (map[key]) return map[key];
		const base = key.split(".")[0];
		for (const [savedKey, val] of Object.entries(map)) {
			if (!val || typeof val !== "object") continue;
			const savedBase = savedKey.split(".")[0];
			if (
				savedKey.includes(key) ||
				key.includes(savedKey) ||
				(base.length >= 3 && savedBase === base)
			) {
				return val;
			}
		}
		return null;
	}
	function applySavedLayout(saved) {
		if (!saved || typeof saved !== "object") return;
		const vp = viewportRect();
		if (typeof saved.minimized === "boolean") {
			minimized = saved.minimized;
		}
		if (Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
			dockSize = {
				w: clamp(Math.round(saved.w), 280, vp.width - 16),
				h: clamp(Math.round(saved.h), 220, vp.height - 16),
			};
			dock.classList.add("resized");
			dock.style.width = `${dockSize.w}px`;
			dock.style.height = `${dockSize.h}px`;
		}
		if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
			const r = dock.getBoundingClientRect();
			const w = dockSize?.w || r.width || 340;
			const h = dockSize?.h || r.height || 260;
			dockPosition = {
				x: clamp(Math.round(saved.x), vp.left + 8, vp.right - w - 8),
				y: clamp(Math.round(saved.y), vp.top + 8, vp.bottom - h - 8),
			};
			dock.style.left = "0";
			dock.style.top = "0";
			dock.style.right = "auto";
			dock.style.bottom = "auto";
			dock.style.transform = `translate3d(${dockPosition.x}px, ${dockPosition.y}px, 0)`;
		}
		renderMode();
	}
	function saveSiteLayout() {
		const key = siteKey();
		const entry = {
			site: key,
			minimized,
			...(dockPosition ? { x: Math.round(dockPosition.x), y: Math.round(dockPosition.y) } : {}),
			...(dockSize ? { w: Math.round(dockSize.w), h: Math.round(dockSize.h) } : {}),
			ts: Date.now(),
		};
		try {
			const raw = window.localStorage?.getItem(LAYOUT_STORAGE_KEY);
			const map = raw ? JSON.parse(raw) : {};
			map[key] = entry;
			window.localStorage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(map));
		} catch (_) {}
		try {
			chrome.storage?.local
				?.get(["annotate_site_layouts"])
				.then((res) => {
					const layouts =
						res?.annotate_site_layouts && typeof res.annotate_site_layouts === "object"
							? { ...res.annotate_site_layouts }
							: {};
					layouts[key] = entry;
					return chrome.storage.local.set({ annotate_site_layouts: layouts });
				})
				.catch(() => {});
		} catch (_) {}
	}
	function loadSiteLayout() {
		const key = siteKey();
		let localHit = null;
		try {
			const raw = window.localStorage?.getItem(LAYOUT_STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				localHit = fuzzyMatchSiteLayout(parsed, key);
				if (localHit) applySavedLayout(localHit);
			}
		} catch (_) {}
		try {
			chrome.storage?.local
				?.get(["annotate_site_layouts"])
				.then((res) => {
					const remoteHit = fuzzyMatchSiteLayout(res?.annotate_site_layouts, key);
					if (remoteHit && (!localHit || (remoteHit.ts || 0) > (localHit.ts || 0))) {
						if (!drag && !resizeState) applySavedLayout(remoteHit);
					}
				})
				.catch(() => {});
		} catch (_) {}
	}
	function commandText(text) {
		return /^(?:[$#]\s+)?(?:npm|npx|pnpm|yarn|cargo|pip3?|brew|curl|wget|git|docker(?:-compose)?|bun|pi|claude|codex|gemini|dsh|agent|opencode|aider|sh|bash|zsh|make|apt|dnf|pacman)\b/.test(
			text.trim(),
		);
	}
	function isCodeOrCommand(el) {
		return Boolean(
			el.closest(
				"pre, code, samp, kbd, .highlight, .snippet, [class*='code'], [class*='terminal']",
			) ||
				el.querySelector?.("pre, code") ||
				commandText(el.textContent || ""),
		);
	}
	function cssPath(el) {
		const parts = [];
		for (let cur = el; cur?.nodeType === 1; cur = cur.parentElement) {
			if (cur.id) {
				parts.unshift(`#${CSS.escape(cur.id)}`);
				break;
			}
			let index = 1;
			for (
				let sibling = cur.previousElementSibling;
				sibling;
				sibling = sibling.previousElementSibling
			)
				index++;
			parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${index})`);
		}
		return parts.join(" > ");
	}
	function shadowHosts(el) {
		const selectors = [];
		for (let root = el.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode())
			selectors.unshift(cssPath(root.host));
		return selectors;
	}
	function annotationKey(item) {
		return JSON.stringify([
			...(item.shadow_hosts || []),
			item.selector,
			...(item.selection ? [item.selection] : []),
		]);
	}
	function resolveElement(item) {
		try {
			let root = document;
			for (const selector of item.shadow_hosts || []) {
				root = root.querySelector(selector)?.shadowRoot;
				if (!root) return null;
			}
			return item.selector
				? root.querySelector(item.selector)
				: item.ref != null
					? root.querySelector(`[${REF_ATTR}="${Number(item.ref)}"]`)
					: null;
		} catch {
			return null;
		}
	}
	function selectionBoundary(container, offset) {
		const el = container instanceof Element ? container : container.parentElement;
		if (!el) return null;
		const path = [];
		for (let cur = container; cur !== el; cur = cur.parentNode)
			path.unshift(Array.prototype.indexOf.call(cur.parentNode.childNodes, cur));
		return { selector: cssPath(el), shadow_hosts: shadowHosts(el), path, offset };
	}
	function rangeFor(item) {
		try {
			const boundaryNode = (boundary) => {
				let target = resolveElement(boundary);
				for (const index of boundary.path) target = target?.childNodes[index];
				return target;
			};
			const { start, end, quote } = item.selection;
			const first = boundaryNode(start);
			const last = boundaryNode(end);
			if (!first || !last || first.getRootNode() !== last.getRootNode()) return null;
			const range = document.createRange();
			range.setStart(first, start.offset);
			range.setEnd(last, end.offset);
			// DOM drift must not silently turn a text pin into an unrelated selection.
			return !range.collapsed && range.toString() === quote ? range : null;
		} catch {
			return null;
		}
	}
	function lazyRef(el = null) {
		const existing = el?.getAttribute(REF_ATTR);
		if (
			existing != null &&
			/^\d+$/.test(existing) &&
			!localAnnotations.some((item) => item.ref === Number(existing))
		)
			return Number(existing);
		while (
			document.querySelector(`[${REF_ATTR}="${nextRef}"]`) ||
			localAnnotations.some((item) => item.ref === nextRef)
		)
			nextRef++;
		const ref = nextRef++;
		el?.setAttribute(REF_ATTR, String(ref));
		return ref;
	}

	const host = node("div");
	host.id = "ap-annotate-root";
	host.dataset.apPinUi = PIN_UI_VERSION;
	host.setAttribute("data-ap-annotate", "");
	host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
	const shadow = host.attachShadow({ mode: "open" });
	const css = node("style");
	css.textContent = `
		:host { all: initial; color-scheme: dark; }
		* { box-sizing: border-box; -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
		[hidden] { display: none !important; }
		button, input { font: inherit; }
		button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid transparent; border-radius: 6px; color: #D7DCE2; background: transparent; padding: 4px 7px; font-size: 11px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: background .12s ease, color .12s ease, border-color .12s ease; }
		button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); color: #fff; }
		button:disabled { opacity: .45; cursor: not-allowed; }
		button:focus-visible, input:focus-visible { outline: none; border-color: rgba(90, 167, 136, 0.65); }
		button svg { flex-shrink: 0; width: 12px; height: 12px; }
		.icon-button { flex-shrink: 0; width: 22px; height: 22px; padding: 3px; color: #8B939E; }
		input { min-width: 0; color: #E8EBEF; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 7px; padding: 5px 8px; font-size: 11.5px; }
		input::placeholder { color: #7E8691; }
		.overlay, .layer { position: fixed; inset: 0; pointer-events: none; }
		.box { position: absolute; top: 0; left: 0; border: 1.5px solid rgba(90, 167, 136, 0.85); border-radius: 4px; background: rgba(90, 167, 136, 0.03); pointer-events: none; }
		.preview { border: 1.5px dashed #3B82F6; background: rgba(59, 130, 246, 0.04); }
		.selection-highlight { position: absolute; top: 0; left: 0; background: rgba(90, 167, 136, 0.24); border-bottom: 1.5px solid rgba(90, 167, 136, 0.78); border-radius: 2px; pointer-events: none; }
		.capsule { position: absolute; top: 0; left: 0; display: flex; align-items: center; gap: 4px; height: 20px; width: 20px; border-radius: 6px; border: 1px solid rgba(90, 167, 136, 0.45); background: #141619; color: #78C4A4; box-shadow: 0 2px 6px rgba(0,0,0,.35); font: 500 11px/1.3 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; pointer-events: auto; overflow: hidden; transition: width .16s ease, height .16s ease; }
		.capsule.open, .capsule:focus-within { width: max-content; height: 28px; padding-right: 5px; border-radius: 7px; color: #E8EBEF; }
		.capsule.asking { width: 320px; height: 32px; }
		.capsule.unbound.open, .capsule.unbound:focus-within { width: 56px; height: 26px; }
		.capsule.active, .dock { background: rgba(20, 22, 25, 0.94); backdrop-filter: blur(20px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.10); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 16px 40px -8px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.35); }
		.ref { flex-shrink: 0; min-width: 18px; text-align: center; color: #78C4A4; font: 600 9px/18px "SF Mono", ui-monospace, Menlo, monospace; }
		.actions { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
		.capsule:not(.open):not(.selection):not(:focus-within) .actions { visibility: hidden; }
		.inline { display: flex; gap: 4px; min-width: 0; flex: 1; }
		.inline input { width: 100%; padding: 3px 6px; }
		.run { background: rgba(90, 167, 136, 0.14); color: #78C4A4; border-color: rgba(90, 167, 136, 0.25); }
		.run:hover { background: rgba(90, 167, 136, 0.22); color: #9CE0C2; }
		.selection { position: fixed; width: max-content; height: 32px; padding: 3px 5px; border-radius: 8px; max-width: calc(100vw - 16px); overflow: hidden; }
		.selection.open, .selection:focus-within { width: max-content; height: 32px; padding: 3px 5px; }
		.selection.asking { width: 320px; height: 32px; }
		.dock { position: fixed; right: 16px; bottom: 16px; width: 270px; max-width: calc(100vw - 16px); max-height: min(480px, calc(100vh - 16px)); display: flex; flex-direction: column; pointer-events: auto; color: #D7DCE2; border-radius: 14px; font: 12px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; overflow: hidden; container-type: inline-size; container-name: dock; }
		.dock.bound { width: 340px; }
		.dock.resized { max-height: calc(100vh - 16px); }
		.dock.narrow .head .pick span,
		.dock.narrow .head .disconnect span { display: none; }
		.dock.narrow .head .pick,
		.dock.narrow .head .disconnect { padding: 4px; width: 24px; height: 24px; }
		@container dock (max-width: 350px) {
			.head .pick span,
			.head .disconnect span { display: none; }
			.head .pick,
			.head .disconnect { padding: 4px; width: 24px; height: 24px; }
		}
		.dock:not(.bound) .head .pick { width: auto; padding: 3px 6px; }
		.dock:not(.bound) .head .pick span { display: inline; }
		.resizer { position: absolute; z-index: 6; touch-action: none; }
		.dock.minimized .resizer { display: none; }
		.resizer-n { top: 0; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
		.resizer-s { bottom: 0; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
		.resizer-w { left: 0; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
		.resizer-e { right: 0; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
		.resizer-nw { top: 0; left: 0; width: 14px; height: 14px; cursor: nwse-resize; }
		.resizer-ne { top: 0; right: 0; width: 14px; height: 14px; cursor: nesw-resize; }
		.resizer-sw { bottom: 0; left: 0; width: 14px; height: 14px; cursor: nesw-resize; }
		.resizer-se { bottom: 0; right: 0; width: 14px; height: 14px; cursor: nwse-resize; }
		.resizer-nw::after { content: ""; position: absolute; top: 4px; left: 4px; width: 6px; height: 6px; border-top: 1.5px solid rgba(255, 255, 255, 0.22); border-left: 1.5px solid rgba(255, 255, 255, 0.22); border-top-left-radius: 2px; pointer-events: none; }
		.resizer-se::after { content: ""; position: absolute; bottom: 4px; right: 4px; width: 6px; height: 6px; border-bottom: 1.5px solid rgba(255, 255, 255, 0.22); border-right: 1.5px solid rgba(255, 255, 255, 0.22); border-bottom-right-radius: 2px; pointer-events: none; }
		.head { display: flex; align-items: center; gap: 4px; padding: 6px 8px 6px 10px; min-height: 36px; cursor: grab; touch-action: none; flex-shrink: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.07); background: rgba(255, 255, 255, 0.025); user-select: none; }
		.head button { font-size: 10.5px; padding: 3px 6px; flex-shrink: 0; }
		.title { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; white-space: nowrap; font-size: 11.5px; font-weight: 600; color: #F3F4F6; letter-spacing: -0.01em; overflow: hidden; }
		.status-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.pick { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.03); }
		.pick.active { background: rgba(59, 130, 246, .18); color: #93B9F9; border-color: rgba(59, 130, 246, .35); }
		.dock.minimized { height: 34px !important; }
		.dock.minimized .head { height: 32px; min-height: 32px; border-bottom: none; }
		.body { display: flex; flex-direction: column; flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.16) transparent; }
		.dock.bound .body { overflow: hidden; }
		.status, .banner, .activity { display: flex; align-items: center; gap: 7px; padding: 5px 10px; font-size: 11px; color: #8B939E; border-bottom: 1px solid rgba(255, 255, 255, 0.05); background: rgba(0, 0, 0, 0.14); overflow-wrap: anywhere; flex-shrink: 0; }
		.dock.bound .status { display: none; }
		.dock.bound.picking .status { display: flex; color: #93B9F9; background: rgba(59, 130, 246, 0.08); }
		.status .status-dot { display: none; }
		.status .status-label { white-space: normal; overflow: visible; }
		.banner { color: #E7BC6E; background: rgba(245, 158, 11, 0.08); }
		.activity { color: #93B9F9; background: rgba(59, 130, 246, 0.08); font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 10.5px; }
		.status-dot { display: inline-block; flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: #6B7280; }
		.status-dot.bound { background: #5AA788; box-shadow: 0 0 0 3px rgba(90, 167, 136, 0.18); }
		.status-dot.working { background: #3B82F6; animation: pulse 1.5s ease-in-out infinite alternate; }
		.status-dot.warning { background: #F59E0B; }
		.status-dot.error { background: #EF4444; }
		.thread-section { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
		.threads { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.16) transparent; }
		.empty-stage { padding: 10px 4px 6px; display: flex; flex-direction: column; gap: 8px; }
		.empty-title { font-size: 12.5px; font-weight: 600; color: #E8EBEF; letter-spacing: -0.01em; }
		.empty-sub { font-size: 11px; color: #8B939E; line-height: 1.45; }
		.quick-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
		.quick-chip { font-size: 11px; padding: 4px 8px; border-radius: 7px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.08); color: #D7DCE2; }
		.quick-chip:hover { background: rgba(90, 167, 136, 0.14); border-color: rgba(90, 167, 136, 0.35); color: #9CE0C2; }
		.card { position: relative; margin: 0; padding: 8px 10px; background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.07); border-radius: 10px; word-break: break-word; overflow-wrap: break-word; flex-shrink: 0; }
		.user-note { margin: 5px 0 6px; font-size: 12.5px; color: #F8FAFC; font-weight: 600; line-height: 1.42; word-break: break-word; overflow-wrap: break-word; }
		.context, summary { color: #7E8691; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
		.context { flex: 1; min-width: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-size: 11px; line-height: 1.35; color: #94A3B8; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.07); border-left: 2.5px solid rgba(90, 167, 136, 0.75); border-radius: 4px; padding: 3px 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: none; letter-spacing: normal; transition: color .12s ease, background .12s ease; }
		.context:hover { color: #E2E8F0; background: rgba(255, 255, 255, 0.06); }
		.session-switcher { max-width: 100%; min-width: 0; gap: 5px; padding: 3px 6px; border: 1px solid rgba(255,255,255,.09); background: rgba(255,255,255,.04); border-radius: 6px; font-weight: 600; color: #F3F4F6; overflow: hidden; }
		.session-switcher .status-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.session-count, .scope, .session-badge { font: 500 10px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #9DA5B0; white-space: nowrap; }
		.dock:not(.multi) .card:not(.foreign) .session-badge { display: none; }
		.sessions { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(15, 17, 20, 0.96); max-height: 150px; overflow: auto; flex-shrink: 0; }
		.session-row { display: flex; align-items: center; gap: 6px; padding: 3px 2px; font-size: 11px; }
		.session-row .session-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #E8EBEF; font-weight: 500; }
		.session-row button { font-size: 10px; padding: 2px 5px; border: 1px solid rgba(255,255,255,0.07); background: rgba(255,255,255,0.03); }
		.scope { padding: 1px 4px; border-radius: 4px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.05); font-family: "SF Mono", ui-monospace, Menlo, monospace; }
		.session-badge { flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 7px; border-radius: 9999px; background: rgba(90, 167, 136, 0.12); border: 1px solid rgba(90, 167, 136, 0.22); color: #78C4A4; }
		.card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; margin-bottom: 6px; }
		.card-actions { display: flex; justify-content: flex-end; margin-top: 6px; padding-top: 5px; border-top: 1px solid rgba(255, 255, 255, 0.05); }
		.card-reply-btn { font-size: 10.5px; padding: 2px 7px; border-radius: 6px; background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.07); color: #94A3B8; }
		.card-reply-btn:hover { background: rgba(90, 167, 136, 0.14); border-color: rgba(90, 167, 136, 0.3); color: #9CE0C2; }
		.card-follow { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; pointer-events: none; opacity: 0; }
		.card-follow input { flex: 1; width: 0; padding: 3px 6px; font-size: 11px; }
		.progress { display: flex; align-items: center; gap: 6px; color: #88C0A6; transition: color .2s ease; margin: 4px 0 5px; font-size: 11px; font-weight: 500; }
		.progress.busy { color: #93B9F9; }
		@keyframes pulse { to { opacity: .35; } }
		.reply { line-height: 1.56; color: #E5E7EB; font-size: 12px; margin-top: 3px; display: flex; flex-direction: column; gap: 6px; word-break: break-word; overflow-wrap: break-word; }
		.reply .md-p { margin: 0; white-space: pre-wrap; }
		.reply .md-h1, .reply .md-h2, .reply .md-h3, .reply .md-h4 { margin: 4px 0 1px; font-weight: 600; color: #F9FAFB; line-height: 1.35; }
		.reply .md-h1 { font-size: 14px; }
		.reply .md-h2 { font-size: 13px; }
		.reply .md-h3, .reply .md-h4 { font-size: 12.5px; }
		.reply .md-list { margin: 2px 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
		.reply .md-list li { line-height: 1.52; }
		.reply .md-quote { margin: 2px 0; padding: 4px 8px; border-left: 2px solid rgba(90, 167, 136, 0.55); background: rgba(255, 255, 255, 0.03); color: #CBD5E1; border-radius: 0 4px 4px 0; }
		.reply .md-code { font: 11px/1.35 "SF Mono", ui-monospace, Menlo, monospace; padding: 1px 4px; border-radius: 4px; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.08); color: #9CE0C2; }
		.reply .md-link { color: #78C4A4; text-decoration: underline; text-underline-offset: 2px; }
		.reply .md-hr { border: none; border-top: 1px solid rgba(255, 255, 255, 0.08); margin: 4px 0; }
		.reply strong { color: #FFFFFF; font-weight: 600; }
		pre { position: relative; margin: 4px 0 2px; padding: 8px 58px 8px 10px; background: rgba(0, 0, 0, .35); border: 1px solid rgba(255,255,255,.07); border-radius: 7px; overflow: auto; white-space: pre-wrap; word-break: break-all; font: 11px/1.5 "SF Mono", ui-monospace, Menlo, monospace; color: #D1D5DB; }
		.reply pre button { position: absolute; top: 5px; right: 5px; font-size: 10px; padding: 2px 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); }
		.confirm-bar { display: flex; gap: 6px; margin-top: 6px; }
		.confirm-bar button:first-child { background: rgba(90, 167, 136, 0.2); border-color: rgba(90, 167, 136, 0.4); color: #9CE0C2; }
		.reply-bar { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 10px; background: rgba(90, 167, 136, 0.1); border-top: 1px solid rgba(90, 167, 136, 0.2); font-size: 11px; color: #88C0A6; flex-shrink: 0; }
		.reply-bar-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.reply-bar-text b { color: #B5EAD4; font-weight: 600; }
		.reply-bar-cancel { flex-shrink: 0; width: 18px; height: 18px; padding: 2px; color: #88C0A6; border-radius: 4px; }
		.reply-bar-cancel:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }
		.follow { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid rgba(255, 255, 255, 0.07); background: rgba(14, 16, 19, 0.85); flex-shrink: 0; }
		.follow input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; font-size: 12px; line-height: 32px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 8px; color: #E8EBEF; outline: none; transition: border-color .15s ease, background .15s ease, box-shadow .15s ease; }
		.follow input:focus { background: rgba(255, 255, 255, 0.075); border-color: rgba(90, 167, 136, 0.65); box-shadow: 0 0 0 1px rgba(90, 167, 136, 0.2); }
		.follow button[type="submit"] { flex-shrink: 0; width: 32px; height: 32px; padding: 0; border-radius: 8px; background: #5AA788; color: #0B1410; font-weight: 600; border: none; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35); transition: background .15s ease, transform .1s ease, filter .15s ease; }
		.follow button[type="submit"]:hover { background: #6BC09D; color: #07100C; filter: brightness(1.06); }
		.follow button[type="submit"]:active { transform: scale(0.95); }
		.follow button[type="submit"] span { display: none; }
		.follow button[type="submit"] svg { width: 14px; height: 14px; stroke-width: 2.2; }
		details { border-top: 1px solid rgba(255, 255, 255, .06); background: rgba(0, 0, 0, 0.12); flex-shrink: 0; }
		summary { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; list-style: none; user-select: none; }
		summary::-webkit-details-marker { display: none; }
		summary svg { transition: transform .16s; width: 11px; height: 11px; }
		details[open] summary svg { transform: rotate(90deg); }
		.pins-list { max-height: 96px; overflow-y: auto; }
		.dock:not(.bound) .body { overflow: hidden; }
		.dock:not(.bound) details[open] { display: flex; flex-direction: column; flex: 1; min-height: 0; }
		.dock:not(.bound) details[open]::details-content { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
		.dock:not(.bound) summary, .dock:not(.bound) .footer { flex-shrink: 0; }
		.dock:not(.bound) .pins-list { flex: 1; min-height: 0; max-height: none; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.16) transparent; }
		.item { display: flex; align-items: center; gap: 4px; padding: 2px 8px; }
		.item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; justify-content: flex-start; background: transparent; gap: 5px; padding: 2px 4px; }
		.item .name span:last-child { overflow: hidden; text-overflow: ellipsis; color: #D7DCE2; }
		.empty { padding: 6px 10px; color: #7E8691; font-size: 11px; }
		.footer { display: flex; justify-content: flex-end; padding: 4px 8px; border-top: 1px solid rgba(255, 255, 255, 0.05); }
		@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
	`;
	const overlay = node("div", "overlay");
	const previewLayer = node("div", "layer");
	const selectionLayer = node("div", "layer");
	const marksLayer = node("div", "layer");
	const previewBox = node("div", "box preview");
	previewBox.style.display = "none";
	previewLayer.append(previewBox);
	overlay.append(previewLayer, selectionLayer, marksLayer);
	const selectionCapsule = node("div", "capsule selection");
	selectionCapsule.hidden = true;
	const selectionActions = node("div", "actions");
	const selectionAsk = relayButton("Ask", () => {
		selectionActions.hidden = true;
		selectionForm.hidden = false;
		selectionCapsule.classList.add("asking");
		selectionForm.input.focus();
	});
	const selectionRun = relayButton("Run", () => sendRelay("run", selectionContext));
	const selectionPin = button("Pin", () => {
		// Connect Mode keeps its existing element-pin action; range pins are Pin Mode only.
		if (selectionContext?.el) setPinned(selectionContext.el, true);
		hideSelection();
	});
	selectionActions.append(selectionAsk, selectionRun, selectionPin);
	const selectionForm = askForm(
		"Ask about selection… ↵",
		async (question) => {
			const sent = await sendRelay("ask", selectionContext, question);
			if (sent) hideSelection();
			return sent;
		},
		hideSelection,
	);
	selectionCapsule.append(selectionActions, selectionForm);

	const dock = node("section", "dock");
	dock.setAttribute("aria-label", "Annotate");
	const head = node("div", "head");
	const title = node("span", "title");
	const disconnectButton = button("Disconnect", () => disconnect(savedBinding), "disconnect");
	const recheckButton = button("", () => refreshBinding(), "icon-button", "refresh");
	recheckButton.setAttribute("aria-label", "Check connection");
	recheckButton.title = "Check connection";
	disconnectButton.title = "Disconnect active session";
	const pickButton = button("Pick", togglePick, "pick");
	pickButton.title = "Pick element (Alt+Click / Cmd+Shift+E)";
	const minimizeButton = button(
		"",
		() => {
			minimized = !minimized;
			renderMode();
			saveSiteLayout();
		},
		"icon-button",
		"minus",
	);
	minimizeButton.title = "Minimize or expand dock";
	const closeButton = button("", closePanel, "icon-button", "close");
	closeButton.title = "Hide annotation overlay";
	closeButton.setAttribute("aria-label", "Hide annotation overlay");
	head.append(title, recheckButton, disconnectButton, pickButton, minimizeButton, closeButton);
	const body = node("div", "body");
	const sessionMenu = node("div", "sessions");
	sessionMenu.hidden = true;
	sessionMenu.setAttribute("aria-label", "Bound sessions");
	const banner = node("div", "banner");
	banner.hidden = true;
	banner.setAttribute("role", "status");
	const status = node("div", "status");
	const activityBanner = node("div", "activity");
	activityBanner.hidden = true;
	const threadSection = node("section", "thread-section");
	threadSection.setAttribute("aria-label", "Live Thread");
	const emptyStage = node("div", "empty-stage");
	const emptyTitle = node("div", "empty-title", "Ask or run commands on this page");
	const emptySub = node(
		"div",
		"empty-sub",
		"Select any text on the page to ask or run inline, hold Alt + Click to pin an element, or type below.",
	);
	const quickChips = node("div", "quick-chips");
	quickChips.append(
		button("Target an element", togglePick, "quick-chip", "crosshair"),
		relayButton(
			"Summarize page",
			() => sendRelay("ask", null, "Summarize the key points on this page."),
			"quick-chip",
			"sparkle",
		),
	);
	emptyStage.append(emptyTitle, emptySub, quickChips);
	const threads = node("div", "threads");
	threads.setAttribute("aria-live", "polite");
	threads.append(emptyStage);
	let replyTargetSession = null;
	const replyBar = node("div", "reply-bar");
	replyBar.hidden = true;
	const replyBarText = node("span", "reply-bar-text");
	const replyBarCancel = button(
		"",
		() => {
			replyTargetSession = null;
			currentThreadId = null;
			replyBar.hidden = true;
			updateFollowPlaceholder();
		},
		"icon-button reply-bar-cancel",
		"close",
	);
	replyBarCancel.title = "Cancel thread reply";
	replyBar.append(replyBarText, replyBarCancel);

	function updateFollowPlaceholder() {
		const isNarrow = dock.classList.contains("narrow");
		if (replyTargetSession) {
			followForm.input.placeholder = "Type a reply… (↵)";
		} else if (cards.length) {
			followForm.input.placeholder = isNarrow ? "Reply… (↵)" : `Reply to ${label()}… (↵)`;
		} else {
			followForm.input.placeholder = isNarrow
				? `Ask ${label()}…`
				: `Ask ${label()} about this page… (↵)`;
		}
	}

	function setReplyTarget(card) {
		followForm.generation = (followForm.generation || 0) + 1;
		replyTargetSession = card.session_id;
		currentThreadId = card.threadId;
		replyBarText.replaceChildren(
			document.createTextNode("Replying to "),
			node("b", "", card.session_label || label()),
		);
		replyBar.hidden = false;
		updateFollowPlaceholder();
		syncCapabilities();
		followForm.input.focus();
	}

	const followForm = askForm(
		"Ask anything about this page… (↵)",
		async (question) => {
			const generation = followForm.generation || 0;
			const sent = await sendRelay("ask", null, question, currentThreadId, replyTargetSession);
			if (sent && generation === (followForm.generation || 0)) {
				replyTargetSession = null;
				replyBar.hidden = true;
				updateFollowPlaceholder();
			}
			return sent;
		},
		() => followForm.input.blur(),
		() => {
			const owner = cards.findLast((c) => currentThreadId && c.threadId === currentThreadId);
			return {
				sessionId: replyTargetSession || owner?.session_id || currentBinding?.session_id,
				epoch: owner?.receiver_epoch,
			};
		},
	);
	followForm.className = "follow";
	followForm.hidden = false;
	const pinnedSection = node("details");
	pinnedSection.open = true;
	const pinnedSummary = node("summary");
	const list = node("div", "pins-list");
	const footer = node("div", "footer");
	footer.append(button("Clear", clearAll));
	pinnedSection.append(pinnedSummary, list, footer);
	threadSection.append(activityBanner, threads);
	body.append(sessionMenu, banner, status, threadSection, pinnedSection, replyBar, followForm);
	dock.append(head, body);
	for (const dir of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
		const handle = node("div", `resizer resizer-${dir}`);
		handle.dataset.dir = dir;
		dock.append(handle);
	}
	shadow.append(css, overlay, selectionCapsule, dock);
	document.documentElement.append(host);
	const dockObserver = new ResizeObserver(clampDock);
	dockObserver.observe(dock);
	listeners.push(() => dockObserver.disconnect());

	// Every editable surface keeps composition state locally. Scroll never rebuilds it.
	function askForm(
		placeholder,
		submit,
		cancel,
		target = () => ({ sessionId: currentBinding?.session_id }),
	) {
		const form = node("form", "inline");
		form.hidden = true;
		const input = node("input");
		input.type = "text";
		input.placeholder = placeholder;
		input.setAttribute("aria-label", placeholder);
		form.input = input;
		form.canSubmit = () => {
			const { sessionId, epoch } = target();
			return canSendTo(sessionId, epoch);
		};
		let composing = false;
		input.addEventListener("compositionstart", () => {
			composing = true;
		});
		input.addEventListener("compositionend", () => {
			composing = false;
		});
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.isComposing || composing || e.keyCode === 229) return;
			if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			} else if (e.key === "Enter") {
				e.preventDefault();
				form.requestSubmit();
			}
		});
		const send = button("Send", () => {});
		send.type = "submit";
		form.append(input, send);
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			if (composing || form.pending || !input.value.trim() || !form.canSubmit()) return;
			const draft = input.value;
			const generation = form.generation || 0;
			form.pending = true;
			send.disabled = true;
			try {
				const sent = await submit(draft.trim());
				if (sent && input.value === draft && generation === (form.generation || 0))
					input.value = "";
			} finally {
				form.pending = false;
				syncCapabilities();
			}
		});
		return form;
	}

	function markFor(item) {
		return Array.from(marks.values()).find((entry) => entry.item === item);
	}
	function contextOf(item) {
		const entry = markFor(item);
		return {
			raw_text: entry?.rawText ?? item.text ?? item.name,
			is_command: item.is_command,
			element: item,
		};
	}
	function activateCapsule(capsule, force = false) {
		if (activeCapsule && activeCapsule !== capsule) {
			if (!force && activeCapsule.contains(shadow.activeElement)) return;
			activeCapsule.classList.remove("open", "active", "asking");
			for (const entry of marks.values())
				if (entry.capsuleEl === activeCapsule) {
					entry.form.hidden = true;
					entry.actionsEl.hidden = false;
				}
		}
		activeCapsule = capsule;
		capsule.classList.add("open", "active");
	}
	function createMarkActions(entry) {
		const { capsuleEl, actionsEl, item } = entry;
		// Only a binding transition changes action nodes, never a geometry update.
		actionsEl.replaceChildren();
		capsuleEl.classList.toggle("unbound", !currentBinding);
		capsuleEl.classList.remove("asking");
		if (currentBinding) {
			if (entry.isCommand)
				actionsEl.append(relayButton("Run", () => sendRelay("run", contextOf(item)), "run"));
			const ask = relayButton(`Ask ${label()}`, () => {
				activateCapsule(capsuleEl, true);
				entry.form.hidden = false;
				actionsEl.hidden = true;
				capsuleEl.classList.add("open", "asking");
				entry.form.input.focus();
			});
			actionsEl.append(ask);
		}
		actionsEl.append(button("", () => removePin(item), "icon-button", "close"));
		entry.form.hidden = true;
		actionsEl.hidden = false;
	}
	function mark(el, item, expand = false, range = item.selection ? rangeFor(item) : null) {
		if (item.selection && !range) return;
		const target = range || el;
		if (marks.has(target) || markFor(item)) return;
		const isCommand = item.selection
			? (item.is_command ?? commandText(item.text || ""))
			: isCodeOrCommand(el); // Exactly once for this pinned element or selection.
		if (item.ref == null) item.ref = lazyRef(range ? null : el);
		item.is_command = isCommand;
		const boxEl = node("div", "box");
		const capsuleEl = node("div", "capsule");
		capsuleEl.append(node("span", "ref", String(item.ref ?? "·")));
		const actionsEl = node("div", "actions");
		const collapse = () => {
			form.hidden = true;
			actionsEl.hidden = false;
			capsuleEl.classList.remove("open", "active", "asking");
			if (activeCapsule === capsuleEl) activeCapsule = null;
		};
		const form = askForm(
			"Ask question… ↵",
			async (question) => {
				const sent = await sendRelay("ask", contextOf(item), question);
				if (sent) collapse();
				return sent;
			},
			collapse,
		);
		const entry = {
			item,
			el,
			range,
			startNode: range?.startContainer,
			endNode: range?.endContainer,
			boxEls: [boxEl],
			capsuleEl,
			actionsEl,
			form,
			isCommand,
			rawText: range ? item.text : (el.textContent || "").trim(),
		};
		capsuleEl.append(actionsEl, form);
		marks.set(target, entry);
		if (range) {
			entry.selectionValid = true;
			entry.observer = new MutationObserver(() => {
				entry.selectionValid = range.toString() === item.selection.quote;
				scheduleDrawMarks();
			});
			const ancestor = range.commonAncestorContainer;
			entry.observer.observe(
				ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor,
				{
					childList: true,
					characterData: true,
					subtree: true,
				},
			);
		}
		createMarkActions(entry);
		if (expand && currentBinding) activateCapsule(capsuleEl, true);
		capsuleEl.addEventListener("pointerenter", () => activateCapsule(capsuleEl));
		capsuleEl.addEventListener("pointerleave", () => {
			if (form.hidden) {
				capsuleEl.classList.remove("open", "active");
				if (activeCapsule === capsuleEl) activeCapsule = null;
			}
		});
		marksLayer.append(boxEl, capsuleEl);
	}
	function unmark(el) {
		const entry = marks.get(el);
		if (!entry) return;
		entry.observer?.disconnect();
		for (const box of entry.boxEls) box.remove();
		entry.capsuleEl.remove();
		if (activeCapsule === entry.capsuleEl) activeCapsule = null;
		marks.delete(el);
	}
	function positionBox(box, r) {
		box.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
		box.style.width = `${r.width}px`;
		box.style.height = `${r.height}px`;
	}
	function drawMarks() {
		// Batch all layout reads before writes. No node creation, text reads or IPC here.
		const geometry = Array.from(marks.values(), (entry) => ({
			entry,
			connected: entry.range
				? entry.selectionValid &&
					entry.startNode.isConnected &&
					entry.endNode.isConnected &&
					!entry.range.collapsed
				: entry.el.isConnected,
			r: (entry.range || entry.el).getBoundingClientRect(),
		}));
		for (const { entry, connected, r } of geometry) {
			const offscreen =
				!connected ||
				r.width <= 0 ||
				r.height <= 0 ||
				r.bottom < 0 ||
				r.top > window.innerHeight ||
				r.right < 0 ||
				r.left > window.innerWidth;
			entry.capsuleEl.style.display = offscreen ? "none" : "flex";
			for (const box of entry.boxEls) {
				box.style.display = offscreen ? "none" : "block";
				if (!offscreen) positionBox(box, r);
			}
			if (offscreen) continue;
			const x = clamp(r.left, 4, window.innerWidth - 24);
			const y = clamp(r.top >= 26 ? r.top - 22 : r.bottom + 4, 4, window.innerHeight - 32);
			entry.capsuleEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
			entry.capsuleEl.style.maxWidth = `${Math.max(20, window.innerWidth - x - 4)}px`;
		}
	}
	function scheduleDrawMarks() {
		if (!visible || marksFrame) return;
		marksFrame = requestAnimationFrame(() => {
			marksFrame = 0;
			drawMarks();
		});
	}
	function hidePreview() {
		previewBox.style.display = "none";
	}
	function canPick(e = {}) {
		return visible && (pickerActive || (currentBinding && (e.altKey || altHeld)));
	}
	function eventElement(event) {
		// Document listeners see a retargeted shadow host in event.target.
		return event.composedPath().find((node) => node instanceof Element) || event.target;
	}
	function pickerTarget(target) {
		if (
			!(target instanceof Element) ||
			target === document.body ||
			target === document.documentElement
		)
			return null;
		return target.closest(TARGETS) || target;
	}
	function schedulePreview() {
		if (previewFrame) return;
		previewFrame = requestAnimationFrame(() => {
			previewFrame = 0;
			if (!canPick() || !lastPointer || lastPointer.own) return hidePreview();
			if (pointerDown?.pinMode && pointerDown.moved && !pointerDown.released) {
				const range = !pointerDown.canceled && !pointerDown.editable && selectedRange();
				if (!range) return hidePreview();
				positionBox(previewBox, range.getBoundingClientRect());
				previewBox.style.display = "block";
				return;
			}
			const el = pickerTarget(lastPointer.target);
			if (!el || marks.has(el)) return hidePreview();
			const r = el.getBoundingClientRect();
			if (
				(r.width * r.height > window.innerWidth * window.innerHeight * 0.6 &&
					!el.matches("pre, code")) ||
				r.width < 2 ||
				r.height < 2
			)
				return hidePreview();
			positionBox(previewBox, r);
			previewBox.style.display = "block";
		});
	}

	async function saveAnnotations(id, refs) {
		const response = await chrome.runtime.sendMessage({
			method: "annotations.set",
			tab_id: id,
			refs,
		});
		if (!response?.ok) throw new Error(response?.error || "Could not save pins");
	}
	function persistPins() {
		pinsEdited = true;
		if (tabId == null || !initialized) return; // Initialization merges early optimistic edits.
		const snapshot = localAnnotations.map((item) => ({ ...item }));
		saveChain = saveChain
			.then(() => saveAnnotations(tabId, snapshot))
			.catch((error) => {
				showBanner(`Pins remain local: ${error.message}`);
			});
	}
	function setPinned(el, pinned) {
		if (!pinned) return removePin(marks.get(el)?.item);
		if (marks.has(el)) return;
		const r = el.getBoundingClientRect();
		const text = (el.textContent || "").trim();
		const item = {
			ref: lazyRef(el),
			selector: cssPath(el),
			shadow_hosts: shadowHosts(el),
			name: (
				el.getAttribute("aria-label") ||
				el.getAttribute("placeholder") ||
				text ||
				`<${el.tagName.toLowerCase()}>`
			)
				.replace(/\s+/g, " ")
				.slice(0, 120),
			text: text.slice(0, 1000),
			ts: Date.now(),
			x: Math.round(r.left),
			y: Math.round(r.top),
			w: Math.round(r.width),
			h: Math.round(r.height),
		};
		editedSelectors.add(annotationKey(item));
		localAnnotations.push(item);
		mark(el, item, true);
		drawMarks();
		hidePreview();
		renderPins();
		persistPins();
	}
	function setSelectionPinned(context) {
		const range = context?.range;
		const text = context?.raw_text?.trim();
		if (
			!range ||
			!text ||
			range.collapsed ||
			!range.startContainer.isConnected ||
			!range.endContainer.isConnected
		)
			return;
		const r = range.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return;
		const selection = {
			start: selectionBoundary(range.startContainer, range.startOffset),
			end: selectionBoundary(range.endContainer, range.endOffset),
			quote: range.toString(),
		};
		if (!selection.start || !selection.end) return;
		const item = {
			selector: selection.start.selector,
			shadow_hosts: selection.start.shadow_hosts,
			selection,
			name: text.replace(/\s+/g, " ").slice(0, 120),
			text,
			is_command: context.is_command,
			ts: Date.now(),
			x: Math.round(r.left),
			y: Math.round(r.top),
			w: Math.round(r.width),
			h: Math.round(r.height),
		};
		const key = annotationKey(item);
		if (localAnnotations.some((existing) => annotationKey(existing) === key)) return;
		item.ref = lazyRef(); // A text range is not an interactive ref on its ancestor element.
		editedSelectors.add(key);
		localAnnotations.push(item);
		mark(resolveElement(selection.start), item, true, range.cloneRange());
		drawMarks();
		hidePreview();
		renderPins();
		persistPins();
	}
	function removePin(item) {
		if (!item) return;
		editedSelectors.add(annotationKey(item));
		localAnnotations = localAnnotations.filter((a) => a !== item);
		for (const [el, entry] of marks) if (entry.item === item) unmark(el);
		renderPins();
		persistPins();
	}
	function clearAll() {
		if (!initialized) clearedBeforeLoad = true;
		localAnnotations = [];
		for (const el of marks.keys()) unmark(el);
		renderPins();
		persistPins();
	}
	function elementFor(item) {
		return markFor(item)?.el || resolveElement(item);
	}
	function renderPins() {
		pinnedSummary.replaceChildren(
			createSvgIcon("chevron"),
			node("span", "", `Pinned Elements (${localAnnotations.length})`),
		);
		list.replaceChildren();
		for (const item of localAnnotations) {
			const row = node("div", "item");
			const name = button(
				`[${item.ref ?? "·"}] ${item.name}`,
				() => {
					elementFor(item)?.scrollIntoView({ behavior: "smooth", block: "center" });
					scheduleDrawMarks();
				},
				"name",
			);
			name.replaceChildren(
				node("span", "ref", String(item.ref ?? "·")),
				node("span", "", item.name),
			);
			row.append(name);
			if (currentBinding) {
				if (item.is_command)
					row.append(relayButton("Run", () => sendRelay("run", contextOf(item)), "run"));
				row.append(
					relayButton("Ask", () => {
						const el = elementFor(item);
						const entry = markFor(item);
						if (entry) {
							el.scrollIntoView({ behavior: "smooth", block: "center" });
							activateCapsule(entry.capsuleEl, true);
							entry.actionsEl.hidden = true;
							entry.form.hidden = false;
							entry.form.input.focus({ preventScroll: true });
						} else sendRelay("ask", contextOf(item));
					}),
				);
			}
			row.append(button("", () => removePin(item), "icon-button", "close"));
			list.append(row);
		}
		if (!localAnnotations.length) list.append(node("div", "empty", "No elements pinned yet."));
		footer.hidden = localAnnotations.length === 0;
		renderTitle();
	}

	function showBanner(text) {
		statusText(banner, text, "warning");
		banner.hidden = false;
	}
	function setBinding(binding, disconnected = false, bindings = binding ? [binding] : []) {
		const previous = savedBinding;
		const hadInteractiveLayout = !!currentBinding;
		const signature = (pool) =>
			JSON.stringify(
				pool.map((b) => [
					b.session_id,
					b.receiver_epoch,
					b.scope,
					b.label,
					b.active,
					b.health?.state,
					b.health?.reason,
				]),
			);
		const presentationChanged = signature(currentBindings) !== signature(bindings || []);
		const key = (b) => (b ? `${b.session_id}:${b.receiver_epoch || ""}` : "unbound");
		const changed =
			previous?.session_id !== binding?.session_id ||
			(previous?.receiver_epoch && previous.receiver_epoch !== binding?.receiver_epoch);
		if (changed) {
			followForm.generation = (followForm.generation || 0) + 1;
			drafts.set(key(previous), {
				text: followForm.input.value,
				currentThreadId,
				replyTargetSession,
			});
			const draft = drafts.get(key(binding));
			followForm.input.value = draft?.text || "";
			currentThreadId = draft?.currentThreadId || null;
			replyTargetSession = draft?.replyTargetSession || null;
		}
		savedBinding = binding || null;
		currentBinding = binding?.health?.state === "offline" ? null : binding || null;
		currentBindings = Array.isArray(bindings) ? bindings : [];
		// Unknown keeps the layout stable; only definitive offline changes click-to-pin behavior.
		if (hadInteractiveLayout !== !!currentBinding) {
			cancelTextDrag();
			pickerActive = !currentBinding;
			pinnedSection.open = !currentBinding;
			altHeld = false;
			hideSelection();
			hidePreview();
		}
		if (changed || hadInteractiveLayout !== !!currentBinding) {
			activity = "";
			for (const entry of marks.values()) createMarkActions(entry);
		}
		if (!currentBinding || currentBindings.length < 2) sessionMenuOpen = false;
		if ((disconnected || savedBinding) && !currentBinding)
			showBanner("Session disconnected — switched to Pin-Only mode. Drafts and pins preserved.");
		else if (currentBinding && !canSendTo(currentBinding.session_id))
			showBanner(
				`Connection unverified (${currentBinding.health?.reason || "checking"}) — sending paused`,
			);
		else banner.hidden = true;
		clearTimeout(healthExpiryTimer);
		const expiries = currentBindings
			.filter((b) => b.health?.state === "ready")
			.map((b) => b.health.valid_until);
		if (expiries.length)
			healthExpiryTimer = setTimeout(
				() => {
					const next = currentBindings.map((b) =>
						b.health?.state === "ready" && b.health.valid_until <= Date.now()
							? { ...b, health: { ...b.health, state: "unknown", reason: "LEASE_EXPIRED" } }
							: b,
					);
					const selected = next.find(
						(b) => b.session_id === savedBinding?.session_id && b.scope === savedBinding?.scope,
					);
					setBinding(selected || savedBinding, false, next);
					refreshBinding();
				},
				Math.max(0, Math.min(...expiries) - Date.now()),
			);
		if (presentationChanged || changed || hadInteractiveLayout !== !!currentBinding) {
			renderSessionMenu();
			renderMode();
			renderPins();
		}
		syncCapabilities();
	}

	async function refreshBinding() {
		if (refreshInFlight || tabId == null) return;
		refreshInFlight = true;
		const revision = bindingRevision;
		try {
			const res = await chrome.runtime.sendMessage({
				method: "session.get_binding",
				tab_id: tabId,
				window_id: windowId,
				force: true,
			});
			if (!res?.ok) throw new Error(res?.error || "Connection check unavailable");
			if (revision === bindingRevision) setBinding(res.binding, false, res.bindings);
		} catch (_) {
			if (revision === bindingRevision && savedBinding) {
				const next = currentBindings.map((b) =>
					b.health?.state === "offline"
						? b
						: { ...b, health: { state: "unknown", reason: "CHECK_UNAVAILABLE" } },
				);
				setBinding(
					next.find(
						(b) => b.session_id === savedBinding.session_id && b.scope === savedBinding.scope,
					),
					false,
					next,
				);
			}
		} finally {
			refreshInFlight = false;
		}
	}
	function bindingParams(binding) {
		return {
			session_id: binding.session_id,
			...(binding.scope === "tab"
				? { tab_id: binding.tab_id ?? tabId }
				: { window_id: binding.window_id ?? windowId }),
		};
	}
	function renderSessionMenu() {
		sessionMenu.replaceChildren();
		for (const binding of currentBindings) {
			const active =
				binding === currentBinding ||
				(binding.session_id === currentBinding?.session_id &&
					binding.scope === currentBinding?.scope);
			const row = node("div", "session-row");
			row.append(
				node(
					"span",
					`status-dot ${canSendTo(binding.session_id, binding.receiver_epoch) ? "bound" : "unbound"}`,
				),
				node("span", "session-name", binding.label || binding.session_id),
				node(
					"span",
					"scope",
					`${binding.scope === "tab" ? "Tab" : "Win"} · ${binding.health?.state || "unknown"}`,
				),
			);
			if (!active) row.append(button("Set Active", () => selectSession(binding)));
			row.append(button("Disconnect", () => disconnect(binding)));
			sessionMenu.append(row);
		}
		sessionMenu.append(button("Disconnect All", disconnectAll));
		sessionMenu.hidden = !sessionMenuOpen;
	}
	async function selectSession(binding) {
		const revision = bindingRevision;
		try {
			const response = await chrome.runtime.sendMessage({
				method: "session.select_binding",
				session_id: binding.session_id,
				tab_id: tabId,
				window_id: windowId,
			});
			if (!response?.ok) throw new Error(response?.error || "Could not select session");
			if (revision === bindingRevision) setBinding(response.binding, false, response.bindings);
		} catch (error) {
			showBanner(error.message);
		}
	}
	function renderTitle() {
		const text = currentBinding
			? minimized && activity
				? `${label()} working…`
				: label()
			: "Pin Mode";
		if (currentBindings.length >= 2) {
			const switcher = button(
				"",
				() => {
					sessionMenuOpen = !sessionMenuOpen;
					if (sessionMenuOpen) minimized = false;
					renderMode();
				},
				"session-switcher",
			);
			switcher.setAttribute("aria-label", "Select active session");
			switcher.setAttribute("aria-expanded", String(sessionMenuOpen));
			statusText(
				switcher,
				text,
				!canSendTo(currentBinding?.session_id) ? "warning" : activity ? "working" : "bound",
			);
			switcher.append(
				node("span", "session-count", `+${currentBindings.length - 1}`),
				createSvgIcon("chevron"),
			);
			title.replaceChildren(switcher);
		} else
			statusText(
				title,
				text,
				currentBinding
					? !canSendTo(currentBinding.session_id)
						? "warning"
						: activity
							? "working"
							: "bound"
					: "unbound",
			);
		if (currentBinding) title.title = text;
		else title.removeAttribute("title");
	}
	function renderMode() {
		host.style.display = visible ? "block" : "none";
		dock.classList.toggle("bound", Boolean(currentBinding));
		dock.classList.toggle("multi", currentBindings.length >= 2);
		dock.classList.toggle("picking", Boolean(currentBinding && pickerActive));
		dock.classList.toggle("minimized", minimized);
		body.hidden = minimized;
		disconnectButton.hidden = !savedBinding || currentBindings.length !== 1 || minimized;
		recheckButton.hidden = !savedBinding || canSendTo(savedBinding.session_id) || minimized;
		sessionMenu.hidden = !sessionMenuOpen || minimized;
		pickButton.hidden = false;
		pickButton.lastChild.textContent = currentBinding
			? "Pick"
			: `Select ${pickerActive ? "On" : "Off"}`;
		pickButton.title = currentBinding
			? "Pick element (Alt+Click / Cmd+Shift+E)"
			: pickerActive
				? "Turn selection off — browse the page normally"
				: "Turn selection on — click elements or drag-select text";
		if (currentBinding) pickButton.removeAttribute("aria-label");
		else
			pickButton.setAttribute(
				"aria-label",
				pickerActive ? "Turn selection off" : "Turn selection on",
			);
		pickButton.classList.toggle("active", pickerActive);
		pickButton.setAttribute("aria-pressed", String(pickerActive));
		minimizeButton.replaceChildren(createSvgIcon(minimized ? "chevron-up" : "minus"));
		minimizeButton.setAttribute("aria-label", minimized ? "Expand dock" : "Minimize dock");
		minimizeButton.title = minimized ? "Expand dock" : "Minimize dock";
		threadSection.hidden = !currentBinding && !cards.length;
		followForm.hidden = !currentBinding;
		replyBar.hidden = !currentBinding || !replyTargetSession;
		if (currentBinding) {
			emptyTitle.textContent = canSendTo(currentBinding.session_id)
				? `Connected to ${label()}`
				: `Connection unverified · ${label()}`;
			updateFollowPlaceholder();
		}
		for (const card of cards) {
			if (card.el) {
				card.el.classList.toggle(
					"foreign",
					Boolean(currentBinding && card.session_id !== currentBinding.session_id),
				);
			}
		}
		emptyStage.hidden = cards.length > 0;
		statusText(
			status,
			currentBinding
				? pickerActive
					? "Target mode active — Click an element to pin · Esc to return"
					: "Browse freely · Hold Alt to pin · Select text to ask"
				: pickerActive
					? "Click to pin elements; keep clicking to add more. Drag-select text for one combined pin. Click a pinned element to remove it."
					: "Selection is off. Browse normally; existing pins stay saved. Turn Select On to pin again.",
			currentBinding ? (canSendTo(currentBinding.session_id) ? "bound" : "warning") : "unbound",
		);
		statusText(activityBanner, activity ? `Agent: ${activity}` : "", "working");
		activityBanner.hidden = !activity;
		renderTitle();
		syncCapabilities();
		clampDock();
		scheduleDrawMarks();
	}
	function closePanel() {
		cancelTextDrag();
		visible = false;
		pickerActive = false;
		altHeld = false;
		hidePreview();
		hideSelection();
		renderMode(); // Keep root and shortcut listeners alive.
	}
	function toggle() {
		if (visible) closePanel();
		else {
			visible = true;
			pickerActive = !currentBinding;
			renderMode();
			refreshBinding();
		}
	}
	function togglePick() {
		if (!currentBinding) cancelTextDrag();
		pickerActive = !pickerActive;
		hidePreview();
		hideSelection();
		renderMode();
	}
	async function disconnect(binding) {
		if (!binding) return;
		const revision = bindingRevision;
		try {
			const response = await chrome.runtime.sendMessage({
				method: "session.unbind",
				...bindingParams(binding),
			});
			if (!response?.ok) throw new Error(response?.error || "Disconnect failed");
			if (revision === bindingRevision) {
				const pool = await chrome.runtime.sendMessage({
					method: "session.get_binding",
					tab_id: tabId,
					window_id: windowId,
				});
				if (!pool?.ok) throw new Error(pool?.error || "Could not refresh session pool");
				if (revision === bindingRevision) setBinding(pool.binding, !pool.binding, pool.bindings);
			}
		} catch (error) {
			showBanner(error.message);
		}
	}
	async function disconnectAll() {
		await Promise.all(currentBindings.map((binding) => disconnect(binding)));
	}

	function hideSelection() {
		selectionCapsule.classList.remove("open", "active", "asking");
		if (activeCapsule === selectionCapsule) activeCapsule = null;
		selectionCapsule.hidden = true;
		selectionContext = null;
		selectionLayer.replaceChildren();
		selectionForm.hidden = true;
		selectionActions.hidden = false;
	}
	function drawSelectionHighlights(range) {
		selectionLayer.replaceChildren();
		if (!range) return;
		for (const rect of range.getClientRects()) {
			if (rect.width < 1 || rect.height < 1) continue;
			const hl = node("div", "selection-highlight");
			positionBox(hl, rect);
			selectionLayer.append(hl);
		}
	}
	function selectedRange() {
		const selected = window.getSelection();
		if (
			selected?.rangeCount !== 1 ||
			!selected.toString().trim() ||
			(currentBinding && selected.isCollapsed)
		)
			return null;
		let range = selected.getRangeAt(0);
		if (!currentBinding && selected.getComposedRanges) {
			// Reveal only roots reached by this gesture, not every shadow tree on the page.
			const roots = new Set();
			for (const target of [
				pointerDown?.target,
				lastPointer?.target,
				range.startContainer,
				range.endContainer,
			])
				for (
					let root = target?.getRootNode();
					root instanceof ShadowRoot;
					root = root.host.getRootNode()
				)
					if (root !== shadow) roots.add(root);
			const [composed] = selected.getComposedRanges({ shadowRoots: Array.from(roots) });
			if (
				!composed ||
				composed.startContainer.getRootNode() !== composed.endContainer.getRootNode()
			)
				return null; // A DOM Range cannot represent endpoints in different trees.
			range = document.createRange();
			range.setStart(composed.startContainer, composed.startOffset);
			range.setEnd(composed.endContainer, composed.endOffset);
		}
		if (range.collapsed) return null;
		for (const container of [range.startContainer, range.endContainer])
			if (host.contains(container) || shadow.contains(container)) return null;
		return range;
	}
	function selectionFromPage() {
		const range = selectedRange();
		if (!range) return null;
		const text = window.getSelection().toString().trim();
		const anchor = range.commonAncestorContainer;
		const el = anchor instanceof Element ? anchor : anchor.parentElement;
		const isCommand = Boolean(
			el?.closest(
				"pre, code, samp, kbd, .highlight, .snippet, [class*='code'], [class*='terminal']",
			) ||
				range.cloneContents().querySelector?.("pre, code") ||
				commandText(text),
		);
		return { raw_text: text, is_command: isCommand, el, range: range.cloneRange() };
	}
	function restorePinDragStyles() {
		for (const { el, hadStyle, properties } of pinDragStyles) {
			for (const { name, value, priority, applied } of properties) {
				if (
					el.style.getPropertyValue(name) !== applied ||
					el.style.getPropertyPriority(name) !== "important"
				)
					continue;
				if (value) el.style.setProperty(name, value, priority);
				else el.style.removeProperty(name);
			}
			if (!hadStyle && !el.getAttribute("style")) el.removeAttribute("style");
		}
		pinDragStyles = [];
	}
	function preparePinTextDrag(event) {
		// Links are draggable, not ordinary selectable text in Chromium. Override only
		// this gesture's elements; never change page styles in Connect Mode or when off.
		const targets = new Set([eventElement(event)]);
		for (const el of event.composedPath())
			if (el instanceof Element && el.matches('a[href], img, [draggable="true"]')) targets.add(el);
		for (const el of targets) {
			if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
			const properties = [
				["user-select", "text"],
				["-webkit-user-drag", "none"],
			].map(([name, applied]) => ({
				name,
				applied,
				value: el.style.getPropertyValue(name),
				priority: el.style.getPropertyPriority(name),
			}));
			pinDragStyles.push({ el, hadStyle: el.hasAttribute("style"), properties });
			for (const { name, applied } of properties) el.style.setProperty(name, applied, "important");
		}
	}
	function cancelTextDrag() {
		restorePinDragStyles();
		if (pointerDown) pointerDown.canceled = true;
		cancelAnimationFrame(selectionFrame);
		selectionFrame = 0;
		hidePreview();
	}
	function showSelection() {
		if (!visible || !currentBinding) return hideSelection();
		selectionContext = selectionFromPage();
		if (!selectionContext || selectionContext.raw_text.length <= 2) return hideSelection();
		const r = selectionContext.range.getBoundingClientRect();
		const isCmd = selectionContext.is_command;
		drawSelectionHighlights(selectionContext.range);
		selectionAsk.lastChild.textContent = `Ask ${label()}`;
		selectionRun.hidden = !isCmd;
		selectionRun.classList.toggle("run", isCmd);
		selectionForm.hidden = true;
		selectionActions.hidden = false;
		selectionCapsule.hidden = false;
		activateCapsule(selectionCapsule, true);
		// Selection geometry is measured only when it changes, not during scroll.
		const vp = viewportRect();
		const width = selectionCapsule.getBoundingClientRect().width;
		const x = clamp(r.left + (r.width - width) / 2, vp.left + 8, vp.right - width - 8);
		const y = clamp(r.top - vp.top >= 42 ? r.top - 42 : r.bottom + 8, vp.top + 8, vp.bottom - 42);
		selectionCapsule.style.transform = `translate3d(${x}px, ${y}px, 0)`;
	}

	function appendInlineMarkdown(parent, text) {
		const tokenRe =
			/`([^`\n]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g;
		let last = 0;
		for (const match of text.matchAll(tokenRe)) {
			if (match.index > last) {
				parent.append(document.createTextNode(text.slice(last, match.index)));
			}
			if (match[1] != null) {
				parent.append(node("code", "md-code", match[1]));
			} else if (match[2] != null && match[3] != null) {
				const a = node("a", "md-link", match[2]);
				a.href = match[3];
				a.target = "_blank";
				a.rel = "noopener noreferrer";
				parent.append(a);
			} else if (match[4] != null || match[5] != null) {
				const strong = node("strong");
				appendInlineMarkdown(strong, match[4] ?? match[5]);
				parent.append(strong);
			} else if (match[6] != null || match[7] != null) {
				const em = node("em");
				appendInlineMarkdown(em, match[6] ?? match[7]);
				parent.append(em);
			}
			last = match.index + match[0].length;
		}
		if (last < text.length) {
			parent.append(document.createTextNode(text.slice(last)));
		}
	}
	function renderMarkdownProse(container, raw) {
		const lines = raw.replace(/\r\n/g, "\n").split("\n");
		let listEl = null;
		let listType = "";
		let quoteEl = null;
		let paraLines = [];
		const flushPara = () => {
			if (!paraLines.length) return;
			const p = node("p", "md-p");
			paraLines.forEach((line, idx) => {
				if (idx > 0) p.append(node("br"));
				appendInlineMarkdown(p, line);
			});
			container.append(p);
			paraLines = [];
		};
		const flushList = () => {
			listEl = null;
			listType = "";
		};
		const flushQuote = () => {
			quoteEl = null;
		};
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				flushPara();
				flushList();
				flushQuote();
				continue;
			}
			const headingMatch = line.match(/^\s*(#{1,4})\s+(.+)$/);
			if (headingMatch) {
				flushPara();
				flushList();
				flushQuote();
				const level = Math.min(4, headingMatch[1].length);
				const h = node("div", `md-h${level}`);
				appendInlineMarkdown(h, headingMatch[2].trim());
				container.append(h);
				continue;
			}
			if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
				flushPara();
				flushList();
				flushQuote();
				container.append(node("hr", "md-hr"));
				continue;
			}
			const ulMatch = line.match(/^\s*[-*•]\s+(.+)$/);
			if (ulMatch) {
				flushPara();
				flushQuote();
				if (listType !== "ul") {
					listEl = node("ul", "md-list");
					listType = "ul";
					container.append(listEl);
				}
				const li = node("li");
				appendInlineMarkdown(li, ulMatch[1]);
				listEl.append(li);
				continue;
			}
			const olMatch = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
			if (olMatch) {
				flushPara();
				flushQuote();
				if (listType !== "ol") {
					listEl = node("ol", "md-list");
					listType = "ol";
					container.append(listEl);
				}
				const li = node("li");
				li.value = Number(olMatch[1]);
				appendInlineMarkdown(li, olMatch[2]);
				listEl.append(li);
				continue;
			}
			const quoteMatch = line.match(/^\s*>\s?(.*)$/);
			if (quoteMatch) {
				flushPara();
				flushList();
				if (!quoteEl) {
					quoteEl = node("blockquote", "md-quote");
					container.append(quoteEl);
				} else {
					quoteEl.append(node("br"));
				}
				appendInlineMarkdown(quoteEl, quoteMatch[1]);
				continue;
			}
			flushList();
			flushQuote();
			paraLines.push(line);
		}
		flushPara();
	}
	function renderReply(container, message) {
		container.replaceChildren();
		const text = typeof message === "string" ? message : JSON.stringify(message ?? "");
		const chunks = text.split(/```[^\n`]*\n([\s\S]*?)```/g);
		chunks.forEach((chunk, index) => {
			if (index % 2 === 0) {
				if (chunk.trim()) renderMarkdownProse(container, chunk);
			} else {
				const pre = node("pre");
				const copy = button("Copy", () => {
					if (!navigator.clipboard?.writeText) {
						copy.textContent = "Copy unavailable";
						return;
					}
					navigator.clipboard
						.writeText(chunk)
						.then(() => {
							copy.replaceChildren(createSvgIcon("check"), node("span", "", "Copied"));
						})
						.catch(() => {
							copy.textContent = "Copy failed";
						});
				});
				pre.append(copy, node("code", "", chunk));
				container.append(pre);
			}
		});
	}
	function renderCard(card) {
		emptyStage.hidden = true;
		if (!card.el) {
			card.el = node("article", "card");
			card.contextEl = node("div", "context", card.context);
			card.contextEl.title = card.context || "";
			card.sessionEl = node("span", "session-badge", card.session_label || "Agent");
			card.sessionEl.title = card.session_label || "Agent";
			const header = node("div", "card-head");
			header.append(card.contextEl, card.sessionEl);
			card.noteEl = node("div", "user-note");
			card.progressEl = node("div", "progress");
			card.replyEl = node("div", "reply");
			card.confirmEl = node("div", "confirm-bar");
			card.actionsBar = node("div", "card-actions");
			const replyBtn = button("Reply", () => setReplyTarget(card), "card-reply-btn", "reply");
			replyBtn.title = `Reply in thread with ${card.session_label || "agent"}`;
			card.actionsBar.append(replyBtn);
			card.followForm = askForm(
				"Follow up… (↵)",
				(question) => sendRelay("ask", null, question, card.threadId, card.session_id),
				() => card.followForm.input.blur(),
				() => ({ sessionId: card.session_id, epoch: card.receiver_epoch }),
			);
			card.followForm.className = "card-follow";
			card.followForm.hidden = false;
			card.el.append(
				header,
				card.noteEl,
				card.progressEl,
				card.replyEl,
				card.confirmEl,
				card.actionsBar,
				card.followForm,
			);
			threads.append(card.el);
		}
		card.el.classList.toggle(
			"foreign",
			Boolean(currentBinding && card.session_id !== currentBinding.session_id),
		);
		card.contextEl.textContent = card.context || "";
		card.contextEl.title = card.context || "";
		card.sessionEl.textContent = card.session_label || label();
		card.sessionEl.title = card.session_label || label();
		card.actionsBar.hidden =
			!["done", "replied"].includes(card.status) && !card.el.classList.contains("foreign");
		card.followForm.input.placeholder = `Reply to ${card.session_label || "session"}… (↵)`;
		card.noteEl.textContent = card.userNote || "";
		card.noteEl.hidden = !card.userNote || card.userNote === card.context;
		const states = {
			sending: "Sending…",
			queued: "Queued — awaiting receiver",
			accepted: "Accepted — awaiting execution",
			unconfirmed: "Unconfirmed — outcome unknown",
			rejected: "Rejected",
			expired: "Expired",
			running: "Thinking / Running…",
			done: "Completed",
			replied: "Completed",
			confirm: "Confirm",
			error: "Error",
		};
		const dotState =
			{
				sending: "unbound",
				queued: "unbound",
				accepted: "bound",
				unconfirmed: "warning",
				rejected: "error",
				expired: "error",
				running: "working",
				confirm: "warning",
				error: "error",
			}[card.status] || "bound";
		statusText(
			card.progressEl,
			`${states[card.status] || "Completed"}${card.fromLabel ? ` · ${card.fromLabel}` : ""}`,
			dotState,
		);
		card.progressEl.classList.toggle("busy", card.status === "running");
		if (card.message != null) renderReply(card.replyEl, card.message);
		card.confirmEl.replaceChildren();
		if (card.status === "confirm") {
			for (const [action, text] of [
				["approve", "Approve"],
				["cancel", "Cancel"],
			]) {
				card.confirmEl.append(
					relayButton(
						text,
						() => {
							sendRelay(
								action,
								null,
								action === "approve" ? "Approve" : "Cancel",
								card.threadId,
								card.session_id,
							);
						},
						"",
						"",
						card.session_id,
						card.receiver_epoch,
					),
				);
			}
		}
		syncCapabilities();
		threads.scrollTop = threads.scrollHeight;
	}
	async function sendRelay(
		action,
		context = null,
		userNote = "",
		threadId = null,
		targetSessionId = null,
	) {
		minimized = false;
		const owner = cards.findLast((card) => threadId && card.threadId === threadId);
		const sessionId =
			owner?.session_id || targetSessionId || replyTargetSession || currentBinding?.session_id;
		const binding = currentBindings.find(
			(b) =>
				b.session_id === sessionId &&
				(!owner?.receiver_epoch || b.receiver_epoch === owner.receiver_epoch),
		);
		if (!canSendTo(sessionId, owner?.receiver_epoch)) {
			showBanner("Target session is unavailable — draft preserved; nothing sent");
			syncCapabilities();
			return false;
		}
		const revision = bindingRevision;
		const card = {
			session_id: sessionId,
			receiver_epoch: binding.receiver_epoch,
			session_label: binding?.label || owner?.session_label || sessionId,
			threadId: threadId || `ap-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`,
			status: "sending",
			userNote: userNote || (action === "run" ? "Run command" : ""),
			context: context?.element
				? `[${context.element.ref ?? "·"}] ${context.element.name.slice(0, 48)}`
				: context
					? `Selection · ${context.raw_text.slice(0, 48)}`
					: userNote.slice(0, 60) || "Page",
		};
		cards.push(card);
		if (sessionId === currentBinding?.session_id) currentThreadId = card.threadId;
		renderCard(card);
		try {
			const response = await chrome.runtime.sendMessage({
				method: "relay.send",
				action,
				raw_text: context?.raw_text || "",
				user_note: userNote,
				is_command: action === "run",
				url: location.href,
				title: document.title,
				element: context?.element,
				thread_id: card.threadId,
				session_id: sessionId,
				receiver_epoch: binding.receiver_epoch,
			});
			if (["BINDING_OFFLINE", "BINDING_UNVERIFIED"].includes(response?.code)) {
				card.status = "error";
				card.message = `${card.session_label}: ${response.error || "connection unavailable"}`;
				renderCard(card);
				if (revision === bindingRevision) {
					const remaining =
						response.bindings ||
						currentBindings.map((b) =>
							b.session_id === sessionId
								? {
										...b,
										health: { state: response.code === "BINDING_OFFLINE" ? "offline" : "unknown" },
									}
								: b,
						);
					const selected =
						"binding" in response
							? response.binding
							: remaining.find(
									(b) =>
										b.session_id === savedBinding?.session_id && b.scope === savedBinding?.scope,
								);
					setBinding(selected || null, response.code === "BINDING_OFFLINE", remaining);
				}
				if (currentBinding) showBanner(`${card.session_label}: sending paused; draft preserved`);
				return false;
			}
			if (!response?.ok) throw new Error(response?.error || "Delivery failed");
			const delivered = response.data?.result;
			if (!delivered?.event_id || !delivered.thread_id) throw new Error("Invalid relay receipt");
			card.eventId = delivered.event_id;
			card.threadId = delivered.thread_id;
			if (card.status === "sending") card.status = "queued";
			renderCard(card);
			return true;
		} catch (error) {
			card.status = "unconfirmed";
			card.message = `${error.message}. Outcome unknown; do not automatically retry.`;
			renderCard(card);
			return false;
		}
	}
	function runtimeMessage(msg) {
		if (msg?.method === "annotate.binding_changed") {
			bindingRevision++;
			setBinding(msg.binding, !msg.binding, msg.bindings);
		} else if (msg?.method === "annotate.relay_event") {
			let card =
				cards.find((c) => msg.event_id && c.eventId === msg.event_id) ||
				cards.findLast((c) => msg.thread_id && c.threadId === msg.thread_id) ||
				cards.findLast((c) => !c.eventId && c.status === "sending");
			if (!card) {
				if (!currentBinding) return;
				card = {
					threadId: msg.thread_id,
					context: "Session reply",
					session_id: msg.session_id || currentBinding.session_id,
					receiver_epoch: msg.receiver_epoch,
					session_label: msg.session_label || msg.from_label || label(),
				};
				cards.push(card);
			}
			if (msg.event_id) card.eventId = msg.event_id;
			if (msg.thread_id) {
				card.threadId = msg.thread_id;
				if (card.session_id === currentBinding?.session_id) currentThreadId = msg.thread_id;
			}
			if (
				["accepted", "unconfirmed"].includes(msg.status) &&
				!["sending", "queued", "unconfirmed"].includes(card.status)
			)
				return;
			card.status = msg.status || "done";
			if (msg.message != null) card.message = msg.message;
			if (msg.from_label) card.fromLabel = msg.from_label;
			card.ts = msg.ts;
			if (card.session_id === currentBinding?.session_id && card.status !== "running")
				activity = "";
			renderCard(card);
			renderMode();
		} else if (msg?.method === "annotate.agent_activity" && currentBinding) {
			activity = String(msg.command || "");
			clearTimeout(activityTimer);
			activityTimer = setTimeout(() => {
				activity = "";
				renderMode();
			}, 2500);
			renderMode();
		}
	}

	function clampDock() {
		if (!visible) return;
		const vp = viewportRect();
		if (dockSize && !minimized) {
			dockSize.w = clamp(dockSize.w, 280, vp.width - 16);
			dockSize.h = clamp(dockSize.h, 220, vp.height - 16);
			dock.style.width = `${dockSize.w}px`;
			dock.style.height = `${dockSize.h}px`;
		}
		const r = dock.getBoundingClientRect();
		dock.classList.toggle("narrow", (dockSize?.w || r.width || 340) <= 350);
		if (!dockPosition) {
			if (vp.zoomed) {
				const x = Math.round(clamp(vp.right - r.width - 16, vp.left + 8, vp.right - r.width - 8));
				const y = Math.round(
					clamp(vp.bottom - r.height - 16, vp.top + 8, vp.bottom - r.height - 8),
				);
				dock.style.left = "0";
				dock.style.top = "0";
				dock.style.right = "auto";
				dock.style.bottom = "auto";
				dock.style.transform = `translate3d(${x}px, ${y}px, 0)`;
			} else {
				dock.style.left = "auto";
				dock.style.top = "auto";
				dock.style.right = "16px";
				dock.style.bottom = "16px";
				dock.style.transform = "";
			}
			return;
		}
		dockPosition.x = clamp(dockPosition.x, vp.left + 8, vp.right - r.width - 8);
		dockPosition.y = clamp(dockPosition.y, vp.top + 8, vp.bottom - r.height - 8);
		dock.style.transform = `translate3d(${dockPosition.x}px, ${dockPosition.y}px, 0)`;
	}
	listen(dock, "pointerdown", (e) => {
		const handle = e.target.closest(".resizer");
		if (!handle || e.button !== 0 || minimized) return;
		e.preventDefault();
		e.stopPropagation();
		const r = dock.getBoundingClientRect();
		resizeState = {
			id: e.pointerId,
			dir: handle.dataset.dir || "nw",
			x: e.clientX,
			y: e.clientY,
			left: r.left,
			top: r.top,
			right: r.right,
			bottom: r.bottom,
			width: r.width,
			height: r.height,
			handle,
		};
		handle.setPointerCapture(e.pointerId);
	});
	listen(dock, "pointermove", (e) => {
		if (!resizeState || e.pointerId !== resizeState.id) return;
		const vp = viewportRect();
		const dx = e.clientX - resizeState.x;
		const dy = e.clientY - resizeState.y;
		const minW = 280;
		const minH = 220;
		let left = resizeState.left;
		let top = resizeState.top;
		let width = resizeState.width;
		let height = resizeState.height;
		if (resizeState.dir.includes("w")) {
			left = clamp(resizeState.left + dx, vp.left + 8, resizeState.right - minW);
			width = resizeState.right - left;
		} else if (resizeState.dir.includes("e")) {
			width = clamp(resizeState.width + dx, minW, vp.right - resizeState.left - 8);
		}
		if (resizeState.dir.includes("n")) {
			top = clamp(resizeState.top + dy, vp.top + 8, resizeState.bottom - minH);
			height = resizeState.bottom - top;
		} else if (resizeState.dir.includes("s")) {
			height = clamp(resizeState.height + dy, minH, vp.bottom - resizeState.top - 8);
		}
		dockPosition = { x: left, y: top };
		dockSize = { w: width, h: height };
		dock.classList.add("resized");
		dock.style.left = "0";
		dock.style.top = "0";
		dock.style.right = "auto";
		dock.style.bottom = "auto";
		dock.style.width = `${width}px`;
		dock.style.height = `${height}px`;
		dock.style.transform = `translate3d(${left}px, ${top}px, 0)`;
	});
	listen(dock, "pointerup", (e) => {
		if (resizeState && e.pointerId === resizeState.id) {
			resizeState = null;
			saveSiteLayout();
		}
	});
	listen(dock, "pointercancel", () => {
		resizeState = null;
	});
	listen(head, "pointerdown", (e) => {
		if (e.button !== 0 || e.target.closest("button, input")) return;
		const r = dock.getBoundingClientRect();
		drag = {
			id: e.pointerId,
			x: e.clientX,
			y: e.clientY,
			left: r.left,
			top: r.top,
			width: r.width,
			height: r.height,
			moved: false,
		};
		head.setPointerCapture(e.pointerId);
	});
	listen(head, "pointermove", (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		const dx = e.clientX - drag.x;
		const dy = e.clientY - drag.y;
		if (Math.hypot(dx, dy) > 4) drag.moved = true;
		if (!drag.moved) return;
		const vp = viewportRect();
		dockPosition = {
			x: clamp(drag.left + dx, vp.left + 8, vp.right - drag.width - 8),
			y: clamp(drag.top + dy, vp.top + 8, vp.bottom - drag.height - 8),
		};
		dock.style.left = "0";
		dock.style.top = "0";
		dock.style.right = "auto";
		dock.style.bottom = "auto";
		dock.style.transform = `translate3d(${dockPosition.x}px, ${dockPosition.y}px, 0)`;
	});
	listen(head, "pointerup", (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		const wasMoved = drag.moved;
		if (!drag.moved && minimized && !e.target.closest("button")) {
			minimized = false;
			renderMode();
			saveSiteLayout();
		}
		drag = null;
		if (wasMoved) saveSiteLayout();
	});
	listen(head, "pointercancel", () => {
		drag = null;
	});

	listen(
		document,
		"mousemove",
		(e) => {
			altHeld = e.altKey;
			lastPointer = { target: eventElement(e), own: ownEvent(e) };
			if (canPick(e)) schedulePreview();
			else hidePreview();
		},
		{ capture: true, passive: true },
	);
	listen(
		document,
		"pointerdown",
		(e) => {
			restorePinDragStyles();
			cancelAnimationFrame(selectionFrame);
			const el = eventElement(e);
			pointerDown = {
				x: e.clientX,
				y: e.clientY,
				button: e.button,
				id: e.pointerId,
				moved: false,
				target: el,
				own: ownEvent(e),
				pinMode: visible && !currentBinding && pickerActive,
				editable: Boolean(el.closest?.("input, textarea, select") || el.isContentEditable),
			};
			if (pointerDown.pinMode && !pointerDown.own && !pointerDown.editable && e.button === 0)
				preparePinTextDrag(e);
			if (!e.composedPath().includes(selectionCapsule)) hideSelection();
		},
		true,
	);
	listen(
		document,
		"pointermove",
		(e) => {
			if (
				pointerDown &&
				e.pointerId === pointerDown.id &&
				Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 4
			)
				pointerDown.moved = true;
		},
		{ capture: true, passive: true },
	);
	listen(
		document,
		"click",
		(e) => {
			if (ownEvent(e) || !canPick(e) || e.button !== 0) return;
			if (currentBinding && window.getSelection()?.isCollapsed === false) return;
			if (pointerDown?.pinMode && pointerDown.moved && !pointerDown.editable) {
				// Selecting text must not also activate a file link or a framework row click.
				e.preventDefault();
				e.stopImmediatePropagation();
				return;
			}
			if (
				pointerDown &&
				(pointerDown.moved ||
					pointerDown.canceled ||
					pointerDown.button !== 0 ||
					Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 4)
			)
				return;
			const el = pickerTarget(eventElement(e));
			if (!el) return;
			const r = el.getBoundingClientRect();
			if (
				r.width * r.height > window.innerWidth * window.innerHeight * 0.6 &&
				!el.matches("pre, code")
			)
				return;
			e.preventDefault();
			e.stopImmediatePropagation();
			setPinned(el, !marks.has(el));
		},
		true,
	);
	listen(
		document,
		"pointerup",
		(e) => {
			const gesture = pointerDown;
			if (gesture?.id === e.pointerId) gesture.released = true;
			if (ownEvent(e) || !visible || e.button !== 0) {
				if (gesture?.id === e.pointerId) restorePinDragStyles();
				return;
			}
			cancelAnimationFrame(selectionFrame);
			if (!currentBinding) {
				if (
					!gesture?.pinMode ||
					!pickerActive ||
					gesture.id !== e.pointerId ||
					gesture.own ||
					gesture.editable ||
					gesture.canceled ||
					gesture.button !== 0 ||
					!gesture.moved
				) {
					restorePinDragStyles();
					return;
				}
				selectionFrame = requestAnimationFrame(() => {
					selectionFrame = 0;
					try {
						if (
							!visible ||
							currentBinding ||
							!pickerActive ||
							gesture.canceled ||
							pointerDown !== gesture
						)
							return;
						setSelectionPinned(selectionFromPage());
						hidePreview();
					} finally {
						restorePinDragStyles();
					}
				});
			} else selectionFrame = requestAnimationFrame(showSelection);
		},
		true,
	);
	listen(
		document,
		"pointercancel",
		(e) => {
			if (pointerDown?.id === e.pointerId) cancelTextDrag();
		},
		true,
	);
	listen(document, "selectionchange", () => {
		if (selectionCapsule.contains(shadow.activeElement)) return;
		if (pointerDown?.pinMode && pointerDown.moved && !pointerDown.released) schedulePreview();
		if (window.getSelection()?.isCollapsed) hideSelection();
	});
	listen(
		window,
		"scroll",
		() => {
			hidePreview();
			hideSelection();
			scheduleDrawMarks();
		},
		{ capture: true, passive: true },
	);
	listen(
		window,
		"resize",
		() => {
			hidePreview();
			hideSelection();
			scheduleDrawMarks();
			clampDock();
		},
		{ passive: true },
	);
	if (window.visualViewport) {
		listen(window.visualViewport, "resize", clampDock, { passive: true });
		listen(window.visualViewport, "scroll", clampDock, { passive: true });
	}
	function shortcutHandler(e) {
		if (e.isComposing) return;
		if (e.key === "Escape") cancelTextDrag();
		if (e.key === "Escape" && visible && currentBinding && pickerActive) {
			pickerActive = false;
			hidePreview();
			renderMode();
		}
		if (ownEvent(e) && shadow.activeElement?.matches("input, textarea, [contenteditable]")) return;
		if (
			e.key?.toLowerCase() === shortcut.key?.toLowerCase() &&
			["altKey", "shiftKey", "ctrlKey", "metaKey"].every(
				(key) => Boolean(e[key]) === Boolean(shortcut[key]),
			)
		) {
			e.preventDefault();
			if (visible && currentBinding) togglePick();
			else toggle();
		} else if (e.key === "Escape" && visible) {
			if (currentBinding && pickerActive) {
				pickerActive = false;
				renderMode();
			}
			hidePreview();
			hideSelection();
		} else if (e.key === "Alt") {
			altHeld = true;
			schedulePreview();
		}
	}
	listen(window, "keydown", shortcutHandler, true);
	listen(
		window,
		"keyup",
		(e) => {
			if (e.key === "Alt") {
				altHeld = false;
				if (!pickerActive) hidePreview();
			}
		},
		true,
	);
	listen(window, "blur", () => {
		altHeld = false;
		cancelTextDrag();
	});
	for (const type of [
		"pointerdown",
		"pointerup",
		"mousedown",
		"mouseup",
		"click",
		"dblclick",
		"contextmenu",
		"keydown",
		"keyup",
		"keypress",
		"copy",
		"cut",
		"paste",
		"input",
		"beforeinput",
		"compositionstart",
		"compositionupdate",
		"compositionend",
	]) {
		listen(shadow, type, (e) => e.stopPropagation());
	}
	listen(document, "visibilitychange", () => {
		if (document.visibilityState === "visible") refreshBinding();
	});
	chrome.runtime.onMessage.addListener(runtimeMessage);
	window.__apAnnotatePanel = { toggle };
	window.__apAnnotateCleanup = () => {
		restorePinDragStyles();
		for (const entry of marks.values()) entry.observer?.disconnect();
		for (const remove of listeners) remove();
		chrome.runtime.onMessage.removeListener(runtimeMessage);
		cancelAnimationFrame(marksFrame);
		cancelAnimationFrame(previewFrame);
		cancelAnimationFrame(selectionFrame);
		clearTimeout(activityTimer);
		clearTimeout(healthExpiryTimer);
		host.remove();
		window.__apAnnotatePanel = null;
		window.__apAnnotateCleanup = null;
	};

	loadSiteLayout();
	renderMode();
	renderPins();
	chrome.storage.local
		.get(["custom_annotate_shortcut"])
		.then((settings) => {
			if (settings?.custom_annotate_shortcut?.key) shortcut = settings.custom_annotate_shortcut;
		})
		.catch(() => {});
	async function initialize() {
		try {
			const tab = await chrome.runtime.sendMessage({ method: "annotations.tab" });
			tabId = tab?.tab_id ?? null;
			windowId = tab?.window_id ?? null;
			const revision = bindingRevision;
			const bindingRequest = chrome.runtime.sendMessage({
				method: "session.get_binding",
				tab_id: tabId,
				window_id: windowId,
			});
			const annotationsRequest = chrome.runtime.sendMessage({
				method: "annotations.get",
				tab_id: tabId,
			});
			const [binding, stored] = await Promise.all([bindingRequest, annotationsRequest]);
			if (revision === bindingRevision) setBinding(binding?.binding, false, binding?.bindings);
			const loaded = Array.isArray(stored?.refs) ? stored.refs : [];
			localAnnotations = pinsEdited
				? [
						...(clearedBeforeLoad
							? []
							: loaded.filter((item) => !editedSelectors.has(annotationKey(item)))),
						...localAnnotations,
					]
				: loaded;
			for (const item of localAnnotations) {
				const el = elementFor(item);
				if (el) mark(el, item);
			}
			initialized = true;
			editedSelectors.clear();
			renderPins();
			scheduleDrawMarks();
			if (pinsEdited) persistPins();
		} catch (error) {
			showBanner(`Annotation initialization: ${error.message}`);
		}
	}
	initialize();
})();
