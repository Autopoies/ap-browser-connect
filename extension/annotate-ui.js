// annotate-ui.js — in-page element annotation panel.
//
// Injected into the active tab by background.js (keyboard shortcut or
// popup). Lets the user check one or more interactive elements; the checked
// refs are what the agent sees as `annotated` in `state` output and as green
// boxes in `screenshot --annotate` (red = state refs, green = user picks).
//
// The element enumeration is intentionally the same as state-snapshot.mjs
// (same selector, same data-ap-ref numbering, same viewport filter), so the
// ref the user checks is exactly the ref the agent gets from `state`.
//
// Idempotent: re-injecting (shortcut pressed again) toggles the panel
// instead of stacking a second copy. All styles live in a shadow root, so
// the host page is never affected.

(() => {
	const REF_ATTR = "data-ap-ref";
	const dbg = (err) =>
		console.error("[ap-annotate]", err?.stack || err);
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
				r.width < 2 || r.height < 2 ||
				r.bottom < 0 || r.right < 0 ||
				r.top > window.innerHeight || r.left > window.innerWidth
			) continue;
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

	// ─── highlight helpers (outline + corner badge on the live element) ───
	function highlight(el, checked) {
		el.style.outline = checked
			? "3px solid #22c55e"
			: "2px dashed #3b82f6";
		el.style.outlineOffset = "2px";
	}
	function unhighlight(el) {
		el.style.outline = "";
		el.style.outlineOffset = "";
	}
	function badge(el, ref, checked) {
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
				background: checked ? "#22c55e" : "#3b82f6",
				borderRadius: "4px",
				pointerEvents: "none",
				zIndex: "2147483646",
			});
			el.appendChild(b);
		}
		b.style.background = checked ? "#22c55e" : "#3b82f6";
	}
	function clearElementMarks(el) {
		unhighlight(el);
		const b = el.querySelector(`[${REF_ATTR}-badge]`);
		if (b) b.remove();
	}

	// ─── shadow-DOM UI (built with DOM APIs; no innerHTML) ───
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
		.list { overflow-y: auto; padding: 3px 0; }
		.item {
			display: flex; align-items: center; gap: 7px; padding: 3px 9px;
			cursor: pointer; user-select: none;
		}
		.item:hover { background: rgba(255,255,255,.06); }
		.item input { margin: 0; accent-color: #22c55e; flex-shrink: 0; width: 13px; height: 13px; }
		.item .ref {
			flex-shrink: 0; min-width: 24px; text-align: center;
			background: rgba(255,255,255,.1); color: #9aa4b0;
			border-radius: 4px; font: 600 9px/1.6 ui-monospace, Menlo, monospace;
		}
		.item .name {
			white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #e6edf3;
		}
		.empty { padding: 10px; color: #9aa4b0; text-align: center; }
	`;
	shadow.appendChild(css);
	const fab = document.createElement("button");
	fab.className = "fab";
	fab.title = "Toggle annotation panel (Alt+Shift+A)";
	fab.setAttribute("aria-label", "Toggle annotation panel");
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
	title.title = "Check elements for the agent (green box in state/screenshot)";
	const clearBtn = document.createElement("button");
	clearBtn.setAttribute("data-act", "clear");
	clearBtn.textContent = "✕";
	clearBtn.title = "Clear all annotations";
	const shrinkBtn = document.createElement("button");
	shrinkBtn.setAttribute("data-act", "shrink");
	shrinkBtn.textContent = "▾";
	shrinkBtn.title = "Collapse panel";
	head.append(title, clearBtn, shrinkBtn);
	const listEl = document.createElement("div");
	listEl.className = "list";
	panel.append(head, listEl);
	shadow.append(fab, panel);
	document.documentElement.appendChild(host);

	const items = enumerate();

	async function refresh() {
		try {
			const tabId = await tabIdOf();
			if (tabId == null) return;
			const stored = await loadAnnotations(tabId);
			const checked = new Set(stored.map((a) => String(a.ref)));
			listEl.replaceChildren();
			for (const it of items) {
				const row = document.createElement("label");
				row.className = "item";
				const cb = document.createElement("input");
				cb.type = "checkbox";
				cb.checked = checked.has(String(it.ref));
				cb.addEventListener("change", async () => {
					try {
						const cur = await loadAnnotations(tabId);
						const next = cur.filter((a) => String(a.ref) !== String(it.ref));
						if (cb.checked) {
							next.push({ ref: it.ref, name: it.name, ts: Date.now() });
							highlight(it.el, true);
							badge(it.el, it.ref, true);
						} else {
							clearElementMarks(it.el);
						}
						await saveAnnotations(tabId, next);
						updateCount(next.length);
					} catch (e) {
						dbg(e);
					}
				});
			const refSpan = document.createElement("span");
			refSpan.className = "ref";
			refSpan.textContent = String(it.ref);
			const nameSpan = document.createElement("span");
			nameSpan.className = "name";
			nameSpan.textContent = it.name;
			row.append(cb, refSpan, nameSpan);
			row.addEventListener("mouseenter", () => {
				if (!cb.checked) highlight(it.el, false);
			});
			row.addEventListener("mouseleave", () => {
				if (!cb.checked) unhighlight(it.el);
			});
			listEl.appendChild(row);
		}
		if (items.length === 0) {
			const empty = document.createElement("div");
			empty.className = "empty";
			empty.textContent = "No interactive elements found on this page.";
			listEl.appendChild(empty);
		}
		updateCount(checked.size);
		} catch (e) {
			dbg(e);
		}
	}

	function updateCount(n) {
		countEl.textContent = String(n);
		countEl.hidden = n === 0;
		fab.style.background = n > 0 ? "#22c55e" : "#3b82f6";
	}

	async function clearAll() {
		const tabId = await tabIdOf();
		if (tabId != null) await saveAnnotations(tabId, []);
		for (const it of items) clearElementMarks(it.el);
		updateCount(0);
		await refresh();
	}

	window.__apAnnotatePanel = {
		toggle() {
			panel.hidden = !panel.hidden;
			if (!panel.hidden) refresh();
		},
	};

	fab.addEventListener("click", () => window.__apAnnotatePanel.toggle());
	shrinkBtn.addEventListener("click", () => window.__apAnnotatePanel.toggle());
	clearBtn.addEventListener("click", clearAll);

	// Opening state: panel visible on first inject (the shortcut means "start
	// annotating"), collapsed when the page already carries annotations.
	refresh().then(() => {
		panel.hidden = !countEl.hidden;
	});
})();
