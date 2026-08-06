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

	// ─── highlight helpers ───
	// preview: hover outline (picker preview), mark: pinned green box + badge
	function preview(el, on) {
		if (!el) return;
		el.style.outline = on
			? "2px dashed #3b82f6"
			: "";
		el.style.outlineOffset = on ? "2px" : "";
	}
	function mark(el, ref) {
		el.style.outline = "3px solid #22c55e";
		el.style.outlineOffset = "2px";
		let b = el.querySelector(`[${REF_ATTR}-badge]`);
		if (!b) {
			b = document.createElement("span");
			b.setAttribute(REF_ATTR + "-badge", "");
			b.textContent = String(ref);
			Object.assign(b.style, {
				position: "absolute",
				top: "-2px",
				right: "-2px",
				padding: "1px 4px",
				font: "700 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
				color: "#fff",
				background: "#22c55e",
				borderRadius: "4px",
				pointerEvents: "none",
				zIndex: "2147483646",
			});
			el.appendChild(b);
		}
		b.textContent = String(ref);
	}
	function unmark(el) {
		el.style.outline = "";
		el.style.outlineOffset = "";
		const b = el.querySelector(`[${REF_ATTR}-badge]`);
		if (b) b.remove();
	}
	function isMarked(el) {
		// badge presence is the reliable marker (outline color serializes to rgb())
		return !!el.querySelector(`[${REF_ATTR}-badge]`);
	}

	// ─── shadow-DOM UI: small icon button + compact panel ───
	const host = document.createElement("div");
	host.id = "ap-annotate-root";
	host.setAttribute("data-ap-annotate", "");
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
	fab.title = "Toggle annotation picker (Alt+Shift+A)";
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
	clearBtn.textContent = "✕";
	clearBtn.title = "Clear all annotations";
	const shrinkBtn = document.createElement("button");
	shrinkBtn.setAttribute("data-act", "shrink");
	shrinkBtn.textContent = "▾";
	shrinkBtn.title = "Collapse panel (picker off)";
	head.append(title, clearBtn, shrinkBtn);
	const hint = document.createElement("div");
	hint.className = "hint";
	hint.textContent = "Hover to preview · click to pin (green) · click pinned to unpin";
	const listEl = document.createElement("div");
	listEl.className = "list";
	panel.append(head, hint, listEl);
	shadow.append(fab, panel);
	document.documentElement.appendChild(host);

	// ─── picker state ───
	const items = enumerate();
	const byEl = new Map(items.map((it) => [it.el, it]));
	let previewEl = null;
	let tabId = null;

	async function setTabId() {
		tabId = await tabIdOf();
	}

	function clearPreview() {
		if (previewEl) {
			preview(previewEl, false);
			previewEl = null;
		}
	}

	// Pinned set = storage truth; page marks mirror it.
	async function loadChecked() {
		if (tabId == null) return new Set();
		const stored = await loadAnnotations(tabId);
		return new Set(stored.map((a) => String(a.ref)));
	}

	async function setPinned(el, pinned) {
		if (tabId == null) return;
		const it = byEl.get(el);
		if (!it) return;
		const cur = await loadAnnotations(tabId);
		const next = cur.filter((a) => String(a.ref) !== String(it.ref));
		if (pinned) {
			next.push({ ref: it.ref, name: it.name, ts: Date.now() });
			mark(el, it.ref);
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
			refSpan.textContent = String(a.ref);
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

	function updateCount(n) {
		countEl.textContent = String(n);
		countEl.hidden = n === 0;
		fab.style.background = n > 0 ? "#22c55e" : "#3b82f6";
	}

	// ─── picker events ───
	function pickerTarget(e) {
		// Ignore events inside our own shadow UI (fab/panel clicks).
		if (e.composedPath().some((n) => n === host)) return null;
		const el = e.target instanceof Element ? e.target : null;
		return el ? el.closest(SEL) : null;
	}

	function onMove(e) {
		const el = pickerTarget(e);
		if (el === previewEl) return;
		clearPreview();
		if (el && !isMarked(el)) {
			preview(el, true);
			previewEl = el;
		}
	}

	function onClick(e) {
		const el = pickerTarget(e);
		if (!el) return; // blank area: let the page behave normally
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		clearPreview();
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
		for (const it of items) unmark(it.el);
		updateCount(0);
		renderList();
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
				const checked = await loadChecked();
				for (const it of items) {
					if (checked.has(String(it.ref))) mark(it.el, it.ref);
				}
				pickerOn_();
			}
		},
	};

	fab.addEventListener("click", () => window.__apAnnotatePanel.toggle());
	shrinkBtn.addEventListener("click", () => window.__apAnnotatePanel.toggle());
	clearBtn.addEventListener("click", clearAll);

	// Opening state: expanded (the shortcut means "start annotating").
	setTabId().then(renderList).then(() => {
		panel.hidden = false;
		pickerOn_();
	});
})();
