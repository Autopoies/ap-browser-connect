// annotate-ui.js — in-page element annotation panel (inspect-style picker).
//
// Injected into the active tab by background.js (keyboard shortcut or
// popup). Enters a DevTools-inspect-like picker: hovering an interactive
// element previews it with a blue dashed outline; clicking it pins a green
// box + ref badge (the same look as `screenshot --annotate`); clicking a
// pinned element unpins it. Multiple elements can be pinned.
//
// Pinned refs are what the agent sees as `annotated` in `state` output and
// as green boxes in `screenshot --annotate` (red = state refs, green =
// user picks). The element enumeration mirrors state-snapshot.mjs (same
// selector, same data-ap-ref numbering), so a pinned ref is exactly the
// ref the agent gets from `state`.
//
// Idempotent: re-injecting (shortcut pressed again) toggles the panel —
// expanded = picker active, collapsed = picker off, page clickable again.
// All styles live in a shadow root, so the host page is never affected.

(() => {
	const REF_ATTR = "data-ap-ref";
	const SEL =
		'button, input, select, textarea, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [contenteditable], [tabindex]';
	const MAX = 250;

	if (window.__apAnnotatePanel) {
		window.__apAnnotatePanel.toggle();
		return;
	}

	// ─── storage (via background: content scripts have no chrome.tabs, and
	// the background sees sender.tab.id for this tab) ───
	async function tabIdOf() {
		const r = await chrome.runtime.sendMessage({ method: "annotations.tab" });
		return r?.tab_id ?? null;
	}
	async function loadAnnotations(tabId) {
		const r = await chrome.runtime.sendMessage({
			method: "annotations.get",
			tab_id: tabId,
		});
		return Array.isArray(r?.refs) ? r.refs : [];
	}
	async function saveAnnotations(tabId, refs) {
		await chrome.runtime.sendMessage({
			method: "annotations.set",
			tab_id: tabId,
			refs,
		});
	}

	// ─── element enumeration (mirrors state-snapshot.mjs) ───
	function enumerate() {
		let n = 0;
		const out = [];
		for (const el of document.querySelectorAll(SEL)) {
			if (n >= MAX) break;
			if (el.getAttribute("tabindex") === "-1") continue;
			if (el.getAttribute("role") === "presentation") continue;
			const r = el.getBoundingClientRect();
			if (
				r.width < 2 ||
				r.height < 2 ||
				r.bottom < 0 ||
				r.right < 0 ||
				r.top > window.innerHeight ||
				r.left > window.innerWidth
			)
				continue;
			const tag = el.tagName.toLowerCase();
			const isField = tag === "input" || tag === "textarea" || tag === "select";
			const raw =
				el.getAttribute("aria-label") ||
				el.getAttribute("placeholder") ||
				(isField ? el.value : el.textContent) ||
				"";
			const name = raw.replace(/\s+/g, " ").trim().slice(0, 120);
			el.setAttribute(REF_ATTR, String(n));
			out.push({ el, ref: n, name: name || `<${tag}>` });
			n++;
		}
		return out;
	}

	// ─── highlight overlay ───
	// CSS outline breaks on multi-line inline elements (missing edges,
	// ladder shapes) and badges pinned to inline elements drift (absolute
	// positioning resolves against a positioned ancestor). Instead we draw
	// boxes in a fixed overlay inside our shadow root: getClientRects()
	// yields one rect per line, so multi-line elements get closed per-line
	// boxes, and badges are positioned from the union rect. Redrawn on
	// scroll/resize/reflow.
	const overlay = document.createElement("div");
	overlay.style.cssText =
		"position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
	const marks = new Map(); // el -> { ref }
	let previewEl = null;

	function rectsOf(el) {
		const rects = [...el.getClientRects()].filter(
			(r) => r.width > 1 && r.height > 1,
		);
		if (rects.length) return rects;
		const r = el.getBoundingClientRect();
		return r.width > 1 && r.height > 1 ? [r] : [];
	}
	function unionRect(rects) {
		// DOMRect left/top/right/bottom are prototype getters — a `{...r}`
		// spread only copies x/y/width/height, so build the union explicitly.
		let u = null;
		for (const r of rects) {
			if (!u) {
				u = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
			} else {
				u.left = Math.min(u.left, r.left);
				u.top = Math.min(u.top, r.top);
				u.right = Math.max(u.right, r.right);
				u.bottom = Math.max(u.bottom, r.bottom);
			}
		}
		return u;
	}
	function overlayBox(r, border) {
		const d = document.createElement("div");
		d.style.cssText =
			`position:absolute;left:${r.left}px;top:${r.top}px;` +
			`width:${r.width}px;height:${r.height}px;` +
			`border:${border};border-radius:2px;`;
		overlay.appendChild(d);
	}
	function overlayBadge(union, ref) {
		const b = document.createElement("div");
		b.textContent = ref != null ? String(ref) : "·";
		b.style.cssText =
			`position:absolute;left:${union.right - 1}px;top:${union.top - 1}px;` +
			"transform:translateY(-100%);padding:1px 4px;" +
			"font:700 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;" +
			"color:#fff;background:#22c55e;border-radius:4px;";
		overlay.appendChild(b);
	}
	function drawOverlay() {
		overlay.replaceChildren();
		if (previewEl && !marks.has(previewEl)) {
			for (const r of rectsOf(previewEl)) {
				overlayBox(r, "2px dashed #3b82f6");
			}
		}
		for (const [el, info] of marks) {
			const rects = rectsOf(el);
			const union = unionRect(rects);
			for (const r of rects) overlayBox(r, "3px solid #22c55e");
			if (union) overlayBadge(union, info.ref);
		}
	}
	function mark(el, ref) {
		marks.set(el, { ref });
		drawOverlay();
	}
	function unmark(el) {
		marks.delete(el);
		drawOverlay();
	}
	function isMarked(el) {
		return marks.has(el);
	}
	function clearPreview() {
		if (previewEl) {
			previewEl = null;
			drawOverlay();
		}
	}
	window.addEventListener("scroll", drawOverlay, true);
	window.addEventListener("resize", drawOverlay);
	const ro = new ResizeObserver(drawOverlay);
	ro.observe(document.documentElement);

	// ─── any-element support ───
	// Interactive elements get a state ref; any other visible element gets a
	// CSS path so the agent can still locate it (state `annotated` entries
	// carry `selector` for these).
	function cssPath(el) {
		if (el.id) {
			const s = `#${CSS.escape(el.id)}`;
			if (document.querySelectorAll(s).length === 1) return s;
		}
		const parts = [];
		let node = el;
		while (node && node.nodeType === 1 && node !== document.body) {
			let sel = node.tagName.toLowerCase();
			if (node.id) {
				sel += `#${CSS.escape(node.id)}`;
			} else {
				const cls = [...node.classList].slice(0, 3).map((c) => CSS.escape(c));
				if (cls.length) sel += "." + cls.join(".");
				const parent = node.parentElement;
				if (parent) {
					const same = [...parent.children].filter(
						(c) => c.tagName === node.tagName,
					);
					if (same.length > 1) {
						sel += `:nth-of-type(${same.indexOf(node) + 1})`;
					}
				}
			}
			parts.unshift(sel);
			const cand = parts.join(" > ");
			if (document.querySelectorAll(cand).length === 1) break;
			node = node.parentElement;
		}
		return parts.join(" > ");
	}

	function pinInfo(el) {
		const it = byEl.get(el);
		if (it) {
			return { ref: it.ref, name: it.name, selector: cssPath(el) };
		}
		const tag = el.tagName.toLowerCase();
		const text = (el.textContent || "").replace(/\s+/g, " ").trim();
		const name = (el.getAttribute("aria-label") || text || `<${tag}>`).slice(
			0,
			120,
		);
		return { ref: null, name, selector: cssPath(el) };
	}

	// ─── shadow-DOM UI: small icon button + compact panel ───
	const host = document.createElement("div");
	host.id = "ap-annotate-root";
	host.setAttribute("data-ap-annotate", "");
	// Host must own the top stacking layer itself: z-index inside the shadow
	// tree only orders elements within the shadow root; the host's own
	// position/z-index decides whether page modals (blurred backdrops with
	// their own z-index) can cover the whole UI.
	host.style.cssText = "position:fixed;z-index:2147483647;";
	const shadow = host.attachShadow({ mode: "open" });
	const css = document.createElement("style");
	css.textContent = `
		* { box-sizing: border-box; }
		.fab {
			position: fixed; right: 14px; bottom: 14px; z-index: 2147483647;
			width: 34px; height: 34px; border-radius: 9px;
			background: #3b82f6; color: #fff; border: none; cursor: pointer;
			font-size: 15px; line-height: 1; box-shadow: 0 2px 8px rgba(0,0,0,.35);
			display: flex; align-items: center; justify-content: center;
		}
		.fab:hover { filter: brightness(1.12); }
		.fab .count {
			position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px;
			padding: 0 3px; border-radius: 8px; background: #ef4444; color: #fff;
			font: 700 10px/16px ui-monospace, Menlo, monospace; text-align: center;
		}
		.panel {
			position: fixed; right: 14px; bottom: 56px; z-index: 2147483647;
			width: 250px; max-height: 330px; display: flex; flex-direction: column;
			background: #1e242b; color: #e6edf3; border-radius: 10px;
			box-shadow: 0 4px 24px rgba(0,0,0,.45); font: 12px/1.5 -apple-system, system-ui, sans-serif;
			overflow: hidden;
		}
		.head {
			display: flex; align-items: center; gap: 4px; padding: 6px 8px;
			border-bottom: 1px solid rgba(255,255,255,.1); font-weight: 600; font-size: 11px;
		}
		.head .title { flex: 1; }
		.head button {
			width: 24px; height: 24px; padding: 0;
			background: transparent; color: #9aa4b0; border: none; cursor: pointer;
			font-size: 13px; line-height: 1; border-radius: 5px;
		}
		.head button.wide {
			width: auto; padding: 0 6px; font-size: 11px; font-weight: 500;
		}
		.head button:hover { background: rgba(255,255,255,.08); color: #fff; }
		.hint {
			padding: 6px 9px; color: #9aa4b0; font-size: 11px;
			border-bottom: 1px solid rgba(255,255,255,.08);
		}
		.list { overflow-y: auto; padding: 3px 0; }
		.item {
			display: flex; align-items: center; gap: 7px; padding: 3px 9px;
			font-size: 11px; color: #c8d1da;
		}
		.item .ref {
			flex-shrink: 0; min-width: 24px; text-align: center;
			background: rgba(34,197,94,.25); color: #4ade80;
			border-radius: 4px; font: 600 9px/1.6 ui-monospace, Menlo, monospace;
		}
		.item .name {
			white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
		}
		.empty { padding: 10px; color: #9aa4b0; text-align: center; font-size: 11px; }
	`;
	shadow.appendChild(css);
	const fab = document.createElement("button");
	fab.className = "fab";
	// Shortcut differs by platform (see manifest suggested_key): mac =
	// Command+Shift+A, elsewhere Alt+Shift+A.
	// Pencil button toggles collapse/expand. Collapsed = not annotating
	// (picker off); expanded = annotating. While collapsed the badge on the
	// button's top-right corner becomes a round ✕ that exits the mode.
	fab.title = /Mac|iPhone|iPad/.test(navigator.platform)
		? "Toggle annotation picker (⌘⇧A)"
		: "Toggle annotation picker (Alt+Shift+A)";
	fab.setAttribute("aria-label", "Toggle annotation picker");
	fab.append("✎");
	const countEl = document.createElement("span");
	countEl.className = "count";
	countEl.hidden = true;
	fab.appendChild(countEl);
	const panel = document.createElement("div");
	panel.className = "panel";
	panel.hidden = true;
	const head = document.createElement("div");
	head.className = "head";
	const title = document.createElement("span");
	title.className = "title";
	title.textContent = "Annotate";
	title.title = "Hover to preview, click to pin/unpin elements (green boxes)";
	const clearBtn = document.createElement("button");
	clearBtn.setAttribute("data-act", "clear");
	clearBtn.className = "wide";
	clearBtn.textContent = "Clear";
	clearBtn.title = "Clear all annotations";
	const shrinkBtn = document.createElement("button");
	shrinkBtn.setAttribute("data-act", "shrink");
	shrinkBtn.textContent = "▾";
	shrinkBtn.title = "Collapse panel (picker off, button stays)";
	const exitBtn = document.createElement("button");
	exitBtn.setAttribute("data-act", "exit");
	exitBtn.textContent = "×";
	exitBtn.title = "Exit annotate mode (remove this UI; pinned elements stay)";
	head.append(title, clearBtn, shrinkBtn, exitBtn);
	const hint = document.createElement("div");
	hint.className = "hint";
	hint.textContent =
		"Hover to preview · click to pin (green) · click pinned to unpin";
	const listEl = document.createElement("div");
	listEl.className = "list";
	panel.append(head, hint, listEl);
	shadow.append(fab, panel, overlay);
	document.documentElement.appendChild(host);

	// ─── picker state ───
	const items = enumerate();
	const byEl = new Map(items.map((it) => [it.el, it]));
	let tabId = null;

	async function setTabId() {
		tabId = await tabIdOf();
	}

	// Pinned set = storage truth; page marks mirror it.

	// Serialize pin writes: rapid clicks otherwise race read-modify-write on
	// storage and one pin overwrites the other.
	let writeChain = Promise.resolve();

	function setPinned(el, pinned) {
		writeChain = writeChain.then(() => doSetPinned(el, pinned));
		return writeChain;
	}

	async function doSetPinned(el, pinned) {
		if (tabId == null) return;
		const info = pinInfo(el);
		const cur = await loadAnnotations(tabId);
		const next = cur.filter(
			(a) =>
				!(a.ref != null && info.ref != null && a.ref === info.ref) &&
				!(a.ref == null && a.selector === info.selector),
		);
		if (pinned) {
			const r = el.getBoundingClientRect();
			next.push({
				ref: info.ref,
				selector: info.selector,
				name: info.name,
				ts: Date.now(),
				x: Math.round(r.x),
				y: Math.round(r.y),
				w: Math.round(r.width),
				h: Math.round(r.height),
			});
			mark(el, info.ref);
		} else {
			unmark(el);
		}
		await saveAnnotations(tabId, next);
		updateCount(next.length);
		renderList();
	}

	async function renderList() {
		if (tabId == null) return;
		const stored = await loadAnnotations(tabId);
		listEl.replaceChildren();
		for (const a of stored) {
			const row = document.createElement("div");
			row.className = "item";
			const refSpan = document.createElement("span");
			refSpan.className = "ref";
			refSpan.textContent = a.ref != null ? String(a.ref) : "·";
			const nameSpan = document.createElement("span");
			nameSpan.className = "name";
			nameSpan.textContent = a.name;
			row.append(refSpan, nameSpan);
			listEl.appendChild(row);
		}
		if (stored.length === 0) {
			const empty = document.createElement("div");
			empty.className = "empty";
			empty.textContent = "No elements pinned yet.";
			listEl.appendChild(empty);
		}
		updateCount(stored.length);
	}

	let pinCount = 0;

	function updateCount(n) {
		pinCount = n;
		if (panel.hidden) return; // collapsed: badge shows the exit ✕ instead
		countEl.textContent = String(n);
		countEl.hidden = n === 0;
		fab.style.background = n > 0 ? "#22c55e" : "#3b82f6";
	}

	function syncFabBadge() {
		if (panel.hidden) {
			countEl.hidden = false;
			countEl.textContent = "✕";
			countEl.style.background = "#ef4444";
			countEl.title = "Exit annotation mode";
			countEl.style.cursor = "pointer";
		} else {
			countEl.title = "";
			countEl.style.cursor = "default";
			countEl.style.background = "";
			updateCount(pinCount);
		}
	}

	// ─── picker events ───
	function pickerTarget(e) {
		// Ignore events inside our own shadow UI (fab/panel clicks).
		if (e.composedPath().some((n) => n === host)) return null;
		const el = e.target instanceof Element ? e.target : null;
		if (!el) return null;
		// Interactive element wins (state-ref aligned); otherwise any visible
		// element can be pinned (located by CSS path instead of ref).
		const inter = el.closest(SEL);
		if (inter) return inter;
		if (
			el === document.documentElement ||
			el === document.body ||
			el.getAttribute("data-ap-annotate") != null
		)
			return null;
		return el;
	}

	function onMove(e) {
		const el = pickerTarget(e);
		if (el === previewEl) return;
		previewEl = el;
		drawOverlay();
	}

	function onClick(e) {
		const el = pickerTarget(e);
		if (!el) return; // blank area: let the page behave normally
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		previewEl = null;
		setPinned(el, !isMarked(el));
	}

	function pickerOn_() {
		document.addEventListener("mousemove", onMove, true);
		document.addEventListener("click", onClick, true);
	}

	function pickerOff_() {
		document.removeEventListener("mousemove", onMove, true);
		document.removeEventListener("click", onClick, true);
		clearPreview();
	}

	async function clearAll() {
		if (tabId != null) await saveAnnotations(tabId, []);
		marks.clear();
		drawOverlay();
		updateCount(0);
		renderList();
	}

	// ─── exit: remove UI entirely, keep pins in storage (agent still sees
	// them via state/screenshot; re-injecting with the shortcut restores) ───
	function exitMode() {
		pickerOff_();
		window.__apAnnotatePanel = null;
		host.remove();
	}

	window.__apAnnotatePanel = {
		async toggle() {
			panel.hidden = !panel.hidden;
			if (panel.hidden) {
				pickerOff_();
			} else {
				await setTabId();
				await renderList();
				// restore pinned marks from storage (page may have re-rendered)
				const stored = await loadAnnotations(tabId);
				for (const a of stored) {
					let el = null;
					if (a.ref != null) {
						el = document.querySelector(refSelector(a.ref));
					} else if (a.selector) {
						try {
							el = document.querySelector(a.selector);
						} catch (_) {}
					}
					if (el) mark(el, a.ref);
				}
				pickerOn_();
			}
			syncFabBadge();
		},
	};

	// The pencil button toggles collapse/expand (collapsed = picker off,
	// expanded = picker on).
	fab.addEventListener("click", () => window.__apAnnotatePanel.toggle());
	// The round ✕ badge (shown only while collapsed) exits annotation mode.
	countEl.addEventListener("click", (e) => {
		e.stopPropagation();
		if (panel.hidden) exitMode();
	});
	shrinkBtn.addEventListener("click", () => window.__apAnnotatePanel.toggle());
	clearBtn.addEventListener("click", clearAll);
	exitBtn.addEventListener("click", exitMode);

	// Opening state: expanded (the shortcut means "start annotating").
	setTabId()
		.then(renderList)
		.then(() => {
			panel.hidden = false;
			pickerOn_();
		});
})();
