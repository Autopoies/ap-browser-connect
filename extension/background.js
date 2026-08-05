// AP Browser Connect — Service Worker
// Drives user's Chrome via JSON-RPC over chrome.runtime.connectNative.

import {
	buildDomReadExpression,
	buildNativeClickResolveExpression,
	buildNativeFillResolveExpression,
	buildNativeSelectExpression,
	domDropRules,
	hasFilterDiagnostics,
	interactionDenyRules,
	interactionOutcome,
	matchingPolicies,
	mergeFilterMetadata,
	redactResult,
	resolveBatchStepTab,
	resolveFilterOperationTab,
	shouldFilterOuterResponse,
} from "./filter-enforcement.mjs";
import {
	buildBatchStepParams,
	clearTabRuntimeState,
	ensureAttachedOnce,
	isCurrentPort,
	nextReconnectDelay,
	runtimeEvaluateValue,
	scheduleExtensionReload,
	settleWithin,
	waitForMediaEnd,
	waitForUrlChange,
	withFocusEmulation,
} from "./runtime-helpers.mjs";
import { buildSnapshotExpression, refSelector } from "./state-snapshot.mjs";

// ── Autopoies brand favicon swap (inlined, no module import) ──
const AP_ICON_SVG = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0" y1="0" x2="16" y2="16" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#313B42"/><stop offset="1" stop-color="#242B30"/></linearGradient></defs><rect width="16" height="16" rx="3" fill="url(#bg)"/><g transform="translate(2.88 3.00) scale(0.020)"><path d="M 237.4 310 L 258.2 310 Q 274.6 310 283.5 323.8 L 296.3 343.8 Q 326 390 271.1 390 L 130.9 390 Q 76 390 105.7 343.8 L 230.8 149.3 Q 256 110 281.2 149.3 L 436 390" fill="none" stroke="#5AA788" stroke-width="70" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
const AP_ICON_URL = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(AP_ICON_SVG)))}`;

async function swapFaviconToSparkle(tabId) {
	try {
		await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
			expression: `(function(){const I=${JSON.stringify(AP_ICON_URL)};if(!window.__apSwapped){window.__apSwapped=true;window.__apOrigLinks=Array.from(document.querySelectorAll('link[rel*="icon"]')).map(l=>({el:l,rel:l.rel,href:l.href}))}document.querySelectorAll('link[rel*="icon"]').forEach(l=>l.remove());const n=document.createElement('link');n.rel='icon';n.href=I;document.head.appendChild(n);})()`,
			returnByValue: true,
		});
	} catch (_) {}
}

async function restoreFavicon(tabId) {
	try {
		await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
			expression: `(function(){if(!window.__apSwapped)return;document.querySelectorAll('link[rel*="icon"]').forEach(l=>l.remove());if(window.__apOrigLinks){window.__apOrigLinks.forEach(o=>{o.el.rel=o.rel;o.el.href=o.href;document.head.appendChild(o.el)})}delete window.__apSwapped;delete window.__apOrigLinks})()`,
			returnByValue: true,
		});
	} catch (_) {}
}

const NATIVE_HOST_NAME = "com.apbrowser.connect";
const KEEPALIVE_ALARM = "ap-keepalive";
// 0.5 = 30s, the minimum period Chrome honors in ALL contexts (packed +
// unpacked). An open connectNative port already keeps the SW alive; this
// alarm is the wake-net for when the port dies (SW disposed → port closed
// → host exits → CLI loses the socket).
const KEEPALIVE_PERIOD_MIN = 0.5;

async function ensureKeepaliveAlarm() {
	try {
		const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
		if (!existing) {
			await chrome.alarms.create(KEEPALIVE_ALARM, {
				periodInMinutes: KEEPALIVE_PERIOD_MIN,
			});
		}
	} catch (e) {
		console.warn("[ap-browser] keepalive alarm ensure failed:", e);
	}
}

// ─── State ──────────────────────────────────────────────────────────────
let nativePort = null;
let nativeReconnectTimer = null;
let nativeReconnectDelayMs = 1000;
let labelCache = "";

function scheduleNativeReconnect() {
	if (nativeReconnectTimer) return;
	const delayMs = nativeReconnectDelayMs;
	nativeReconnectDelayMs = nextReconnectDelay(delayMs);
	nativeReconnectTimer = setTimeout(() => {
		nativeReconnectTimer = null;
		connectNativePort();
	}, delayMs);
}

// Post to the port this message arrived on. The global `nativePort` can be
// null (port just disconnected) or already replaced by a newer connection —
// responding on the captured port is always correct, and a dead port just
// logs (onDisconnect drives reconnection).
function postToNative(port, payload) {
	try {
		port.postMessage(payload);
	} catch (e) {
		console.warn("[ap-browser] postMessage failed:", e);
	}
}

// ─── instance_id bootstrap ───────────────────────────────────────────────
async function ensureInstanceId() {
	const { instance_id, label } = await chrome.storage.local.get([
		"instance_id",
		"label",
	]);
	if (!instance_id) {
		const newId = crypto.randomUUID();
		await chrome.storage.local.set({ instance_id: newId, label: "" });
		console.log(`[ap-browser] generated instance_id=${newId}`);
		return { instance_id: newId, label: "" };
	}
	labelCache = label || "";
	return { instance_id, label: labelCache };
}

// ─── Native port lifecycle ───────────────────────────────────────────────
async function buildHelloWithTabs(instance_id, label) {
	const [activeTab, allTabs] = await Promise.all([
		chrome.tabs
			.query({ active: true, currentWindow: true })
			.then((t) => t[0] || null),
		chrome.tabs.query({}),
	]);
	const mapTab = (t) => ({
		id: t.id,
		url: t.url,
		title: t.title,
	});
	return {
		instance_id,
		label,
		extension_version: chrome.runtime.getManifest().version,
		chrome_version: navigator.userAgent,
		active_tab: activeTab ? mapTab(activeTab) : null,
		open_tabs: allTabs.map(mapTab),
	};
}

async function connectNativePort() {
	if (nativePort) return nativePort;
	const { instance_id, label } = await ensureInstanceId();
	if (nativePort) return nativePort;
	if (nativeReconnectTimer) {
		clearTimeout(nativeReconnectTimer);
		nativeReconnectTimer = null;
	}
	try {
		const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
		nativePort = port;
		port.onMessage.addListener((msg) => handleNativeMessage(msg, port));
		port.onDisconnect.addListener(() => {
			if (!isCurrentPort(nativePort, port)) return;
			console.warn("[ap-browser] native port disconnected");
			nativePort = null;
			scheduleNativeReconnect();
		});
		// Minimal hello FIRST, no awaits. SW may be torn down before async work completes.
		port.postMessage({
			jsonrpc: "2.0",
			method: "hello",
			params: {
				instance_id,
				label: labelCache || label || "",
				extension_version: chrome.runtime.getManifest().version,
				chrome_version: navigator.userAgent,
				active_tab: null,
				open_tabs: [],
			},
		});
		// Follow up with full tab info once async resolves.
		buildHelloWithTabs(instance_id, labelCache || label)
			.then((hello) => {
				if (nativePort === port) {
					port.postMessage({ jsonrpc: "2.0", method: "hello", params: hello });
				}
			})
			.catch((e) => console.warn("[ap-browser] tab info follow-up failed:", e));
		setTimeout(() => {
			if (isCurrentPort(nativePort, port)) nativeReconnectDelayMs = 1000;
		}, 30_000);
		console.log("[ap-browser] native port connected, hello pushed");
		return port;
	} catch (e) {
		console.error("[ap-browser] connectNative failed:", e);
		nativePort = null;
		scheduleNativeReconnect();
	}
}

// ─── Message dispatch (JSON-RPC) ─────────────────────────────────────────
async function handleNativeMessage(msg, port) {
	if (!msg || typeof msg !== "object") return;
	if (msg.jsonrpc !== "2.0") return;
	if (!("id" in msg)) return;

	const id = msg.id;
	const method = msg.method;
	const params = msg.params || {};
	const lockedTab = params.tab_id != null;
	const META_METHODS = new Set(["ping", "info", "keepalive", "hello"]);
	const NO_TAB_METHODS = new Set(["download.browser"]);
	const NO_RESTORE_PREFIX = "dev.";
	let operatedTab = null;
	try {
		if (!META_METHODS.has(method) && !NO_TAB_METHODS.has(method)) {
			// dev.* without explicit tab_id skips attach: avoids throwing on chrome:// active tab
			const isDevNoTarget = method.startsWith("dev.") && params.tab_id == null;
			if (!isDevNoTarget) {
				try {
					operatedTab = await resolveTab(params);
				} catch (_) {}
			}
		}
		if (NO_TAB_METHODS.has(method)) {
			try {
				operatedTab = await resolveTab(params);
			} catch (_) {}
		}

		if (operatedTab) {
			if (!lockedTab) {
				await unlockAllTabs();
			} else {
				await unlockOtherTabs(operatedTab.id);
				lockedTabs.add(operatedTab.id);
			}
			cancelPendingRestore(operatedTab.id);
			try {
				await ensureDebugger(operatedTab.id);
			} catch (e) {
				// chrome:// pages reject attach; skip silently (debugger cmds will error per-command if needed)
				if (operatedTab.url && operatedTab.url.startsWith("chrome://")) {
					operatedTab = null;
				} else {
					throw e;
				}
			}
			try {
				await swapFaviconToSparkle(operatedTab?.id);
			} catch (_) {}
			chrome.action.setIcon({ path: "icons/active-128.png" }).catch(() => {});
		}

		const result = await dispatch(method, params, operatedTab);
		postToNative(port, { jsonrpc: "2.0", id, result });
	} catch (e) {
		const error = {
			code: e.code || "INTERNAL",
			message: e.message || String(e),
		};
		if (e.filterMeta) error.data = { filters: e.filterMeta };
		if (e.data) error.data = { ...(error.data || {}), ...e.data };
		postToNative(port, { jsonrpc: "2.0", id, error });
	} finally {
		if (operatedTab) {
			if (!method.startsWith(NO_RESTORE_PREFIX)) {
				scheduleRestore(operatedTab.id, 3000);
				chrome.action.setIcon({ path: "icons/idle-128.png" }).catch(() => {});
			}
		}
	}
}

// ─── Method handlers ─────────────────────────────────────────────────────
async function dispatch(method, params, operatedTab) {
	if (!shouldFilterOuterResponse(method)) {
		return dispatchUnfiltered(method, params, operatedTab);
	}
	const activePolicies = await activeFilterPolicies(
		method,
		params,
		operatedTab,
	);
	const response = await dispatchUnfiltered(method, params, operatedTab);
	if (activePolicies.length === 0 || !response?.data) return response;

	const filtered = redactResult(response.data, activePolicies);
	response.data = filtered.value;
	return attachFilterMetadata(response, filtered.metadata);
}

async function dispatchUnfiltered(method, params, operatedTab) {
	switch (method) {
		case "ping":
			return { ok: true, data: { pong: true }, meta: await buildMeta(null) };

		case "info": {
			const { instance_id, label } = await ensureInstanceId();
			const hello = await buildHelloWithTabs(instance_id, label);
			return {
				ok: true,
				data: {
					instance_id: hello.instance_id,
					label: hello.label,
					active_tab: hello.active_tab,
					open_tabs: hello.open_tabs,
				},
				meta: await buildMeta(null),
			};
		}

		case "tabs.list": {
			const query = {};
			if (params.window_id != null) query.windowId = params.window_id;
			let tabs = await chrome.tabs.query(query);
			if (params.filter) {
				const re = new RegExp(params.filter, "i");
				tabs = tabs.filter(
					(t) => re.test(t.url || "") || re.test(t.title || ""),
				);
			}
			let groups = [];
			try {
				const q = {};
				if (params.window_id != null) q.windowId = params.window_id;
				groups = await chrome.tabGroups.query(q);
			} catch (_) {}
			const groupMap = new Map();
			for (const g of groups)
				groupMap.set(`${g.windowId}:${g.id}`, g.title || null);
			if (params.group) {
				const want = params.group;
				tabs = tabs.filter((t) => {
					const title = groupMap.get(`${t.windowId}:${t.groupId}`);
					return title === want;
				});
			}
			const data = tabs.map((t) => {
				const o = { id: t.id, title: t.title, url: t.url };
				if (t.active) o.active = true;
				if (t.pinned) o.pinned = true;
				if (t.groupId && t.groupId !== -1) {
					o.group = groupMap.get(`${t.windowId}:${t.groupId}`) || null;
				}
				return o;
			});
			return { ok: true, data: { tabs: data }, meta: await buildMeta(null) };
		}

		case "tabs.activate": {
			const tab = await chrome.tabs.update(params.tab_id, { active: true });
			return {
				ok: true,
				data: { id: tab.id, url: tab.url, title: tab.title },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "goto": {
			const tab = await resolveTab(params);
			await chrome.tabs.update(tab.id, { url: params.url });
			try {
				await new Promise((resolve) => {
					const listener = (tabId, info) => {
						if (tabId === tab.id && info.status === "complete") {
							chrome.tabs.onUpdated.removeListener(listener);
							resolve();
						}
					};
					chrome.tabs.onUpdated.addListener(listener);
					setTimeout(() => {
						chrome.tabs.onUpdated.removeListener(listener);
						resolve();
					}, 10000);
				});
			} catch (_) {}
			return {
				ok: true,
				data: { tab_id: tab.id, url: params.url },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "text": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const selector = params.selector || "body";
			const policies = await activeFilterPolicies("text", params, tab);
			const dropRules = domDropRules(policies);
			const expression =
				dropRules.length > 0
					? buildDomReadExpression(selector, "text", dropRules)
					: `String(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`;
			const evaluated = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Runtime.evaluate",
				{
					expression,
					returnByValue: true,
				},
			);
			const value = runtimeEvaluateValue(evaluated);
			const filteredRead =
				dropRules.length > 0
					? value || { value: "", metadata: null }
					: { value: value || "", metadata: null };
			const full = filteredRead.value || "";
			const cap = params.full ? full.length : params.range ? null : 50000;
			let text = full;
			let range = [0, full.length];
			let truncated = false;
			if (cap !== null) {
				text = full.slice(0, cap);
				range = [0, text.length];
				truncated = text.length < full.length;
			} else if (params.range) {
				const [s, e] = params.range;
				text = full.slice(s, e);
				range = [s, s + text.length];
				truncated = s + text.length < full.length;
			}
			return attachFilterMetadata(
				{
					ok: true,
					data: {
						text,
						truncated,
						total_chars: full.length,
						returned_chars: text.length,
						range,
					},
					meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
				},
				filteredRead.metadata,
			);
		}

		case "screenshot": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			// Annotate: snapshot rects first; the CLI composites boxes/badges
			// onto the PNG (DOM overlays don't survive background-tab
			// captures — see state-snapshot.mjs note).
			let annotation = null;
			if (params.annotate) {
				const evaluated = await chrome.debugger
					.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
						expression: buildSnapshotExpression(),
						returnByValue: true,
					})
					.catch(() => null);
				if (evaluated) {
					try {
						annotation = JSON.parse(runtimeEvaluateValue(evaluated) || "null");
					} catch (_) {}
				}
			}
			const opts = { format: "png" };
			if (params.full) opts.captureBeyondViewport = true;
			const { data } = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Page.captureScreenshot",
				opts,
			);
			const out = {
				tab_id: tab.id,
				data_url: `data:image/png;base64,${data}`,
				bytes: data.length,
				annotated: !!params.annotate,
			};
			if (annotation) out.annotation = annotation;
			return {
				ok: true,
				data: out,
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "state.snapshot": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const evaluated = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Runtime.evaluate",
				{ expression: buildSnapshotExpression(), returnByValue: true },
			);
			const value = runtimeEvaluateValue(evaluated);
			let data = {};
			try {
				data = JSON.parse(value || "{}");
			} catch (_) {}
			return {
				ok: true,
				data,
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "click": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const policies = await activeFilterPolicies("click", params, tab);
			const denyRules = interactionDenyRules(policies);
			const query =
				params.ref != null ? refSelector(params.ref) : params.selector;
			// Phase 1: resolve + filter guard + scrollIntoView, returning the
			// element's viewport rect (see resolveForNativeClick).
			const evaluated = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Runtime.evaluate",
				{
					expression: buildNativeClickResolveExpression(query, denyRules),
					returnByValue: true,
				},
			);
			const interaction = runtimeEvaluateValue(evaluated);
			const outcome = interactionOutcome(interaction, denyRules.length > 0);
			if (outcome === "denied") {
				throw filterDeniedError(interaction.metadata);
			}
			if (outcome !== "ok") {
				if (params.ref != null) {
					throw Object.assign(
						new Error(
							`ref ${params.ref} not found — page changed? run state again`,
						),
						{ code: "STALE_REF" },
					);
				}
				throw Object.assign(
					new Error(`selector not found: ${params.selector}`),
					{ code: "SELECTOR_NO_MATCH" },
				);
			}
			// Phase 2: real input events at the element center — SPA custom
			// controls (Reddit, Radix/MUI) react to pointer/mouse events that
			// el.click() never synthesizes. el.click() remains the fallback
			// when the center is covered (hitOk=false: wrapper cards,
			// overlays, zero-size elements).
			const cx = interaction.x + interaction.w / 2;
			const cy = interaction.y + interaction.h / 2;
			let method = "native-input";
			if (!interaction.hitOk) {
				await chrome.debugger.sendCommand(
					{ tabId: tab.id },
					"Runtime.evaluate",
					{
						expression: `(() => { const el = document.querySelector(${JSON.stringify(query)}); if (!el) return false; el.click(); return true; })()`,
						returnByValue: true,
					},
				);
				method = "js-click";
			} else {
				const events = [
					{ type: "mouseMoved", x: cx, y: cy },
					{
						type: "mousePressed",
						x: cx,
						y: cy,
						button: "left",
						buttons: 1,
						clickCount: 1,
					},
					{
						type: "mouseReleased",
						x: cx,
						y: cy,
						button: "left",
						buttons: 0,
						clickCount: 1,
					},
				];
				// CDP input events don't route to background tabs; focus
				// emulation makes the page accept them without stealing focus.
				await withFocusEmulation(
					tab.id,
					chrome.debugger.sendCommand,
					async () => {
						for (const ev of events) {
							await chrome.debugger.sendCommand(
								{ tabId: tab.id },
								"Input.dispatchMouseEvent",
								ev,
							);
						}
					},
				);
			}
			return attachFilterMetadata(
				{
					ok: true,
					data: { clicked: true, method },
					meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
				},
				denyRules.length > 0 ? interaction?.metadata : null,
			);
		}

		case "fill": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const policies = await activeFilterPolicies("fill", params, tab);
			const denyRules = interactionDenyRules(policies);
			const query =
				params.ref != null ? refSelector(params.ref) : params.selector;
			// Phase 1: resolve + filter guard + scrollIntoView + focus + select
			// existing content (see resolveForNativeFill).
			const evaluated = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Runtime.evaluate",
				{
					expression: buildNativeFillResolveExpression(query, denyRules),
					returnByValue: true,
				},
			);
			const interaction = runtimeEvaluateValue(evaluated);
			const outcome = interactionOutcome(interaction, denyRules.length > 0);
			if (outcome === "denied") {
				throw filterDeniedError(interaction.metadata);
			}
			if (outcome !== "ok") {
				if (params.ref != null) {
					throw Object.assign(
						new Error(
							`ref ${params.ref} not found — page changed? run state again`,
						),
						{ code: "STALE_REF" },
					);
				}
				throw Object.assign(
					new Error(`selector not found: ${params.selector}`),
					{ code: "SELECTOR_NO_MATCH" },
				);
			}
			// Phase 2: real keystrokes — Backspace clears the selection, then
			// insertText types the value. Works for <input>/<textarea> AND
			// contenteditable (Reddit comment boxes, rich editors), which
			// el.value assignment can't touch.
			await withFocusEmulation(
				tab.id,
				chrome.debugger.sendCommand,
				async () => {
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.dispatchKeyEvent",
						{
							type: "keyDown",
							key: "Backspace",
							code: "Backspace",
							windowsVirtualKeyCode: 8,
						},
					);
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.dispatchKeyEvent",
						{
							type: "keyUp",
							key: "Backspace",
							code: "Backspace",
							windowsVirtualKeyCode: 8,
						},
					);
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.insertText",
						{ text: params.value },
					);
				},
			);
			// Phase 3: read back what landed — React controlled inputs and
			// masked fields can silently eat characters (opencli rule).
			const verify = await chrome.debugger
				.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
					expression: `(() => { const el = document.querySelector(${JSON.stringify(query)}); if (!el) return ""; return el.value ?? el.textContent ?? ""; })()`,
					returnByValue: true,
				})
				.catch(() => null);
			const actual = verify ? (runtimeEvaluateValue(verify) ?? "") : "";
			return attachFilterMetadata(
				{
					ok: true,
					data: { filled: true, method: "native-insert", value: actual },
					meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
				},
				denyRules.length > 0 ? interaction?.metadata : null,
			);
		}

		case "select": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const policies = await activeFilterPolicies("select", params, tab);
			const denyRules = interactionDenyRules(policies);
			const query =
				params.ref != null ? refSelector(params.ref) : params.selector;
			const evaluated = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Runtime.evaluate",
				{
					expression: buildNativeSelectExpression(
						query,
						denyRules,
						params.option,
					),
					returnByValue: true,
				},
			);
			const interaction = runtimeEvaluateValue(evaluated);
			const status = interaction?.status;
			if (status === "denied") {
				throw filterDeniedError(interaction.metadata);
			}
			if (status === "option_not_found") {
				const err = new Error(`no option matches '${params.option}'`);
				err.code = "OPTION_NOT_FOUND";
				err.data = { available: interaction.available || [] };
				throw err;
			}
			if (status === "not_a_select") {
				throw Object.assign(
					new Error(
						"target is not a <select> — custom dropdowns need click/eval",
					),
					{ code: "NOT_A_SELECT" },
				);
			}
			if (status !== "ok") {
				if (params.ref != null) {
					throw Object.assign(
						new Error(
							`ref ${params.ref} not found — page changed? run state again`,
						),
						{ code: "STALE_REF" },
					);
				}
				throw Object.assign(
					new Error(`selector not found: ${params.selector}`),
					{ code: "SELECTOR_NO_MATCH" },
				);
			}
			return attachFilterMetadata(
				{
					ok: true,
					data: {
						selected: interaction.selected,
						method: "dom-select",
					},
					meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
				},
				denyRules.length > 0 ? interaction?.metadata : null,
			);
		}

		case "tabs.new": {
			const props = { active: params.active !== false };
			if (params.url) props.url = params.url;
			const tab = await chrome.tabs.create(props);
			return {
				ok: true,
				data: {
					id: tab.id,
					url: tab.url,
					title: tab.title,
					window_id: tab.windowId,
				},
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "tabs.close":
			await chrome.tabs.remove(params.tab_id);
			return {
				ok: true,
				data: { closed: params.tab_id },
				meta: await buildMeta(null),
			};

		case "tabs.get": {
			const tab = await chrome.tabs.get(params.tab_id);
			return {
				ok: true,
				data: {
					id: tab.id,
					url: tab.url,
					title: tab.title,
					window_id: tab.windowId,
					active: tab.active,
					pinned: tab.pinned,
				},
				meta: await buildMeta(null),
			};
		}

		case "back": {
			const tab = await resolveTab(params);
			await chrome.tabs.goBack(tab.id);
			return {
				ok: true,
				data: { tab_id: tab.id },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "forward": {
			const tab = await resolveTab(params);
			await chrome.tabs.goForward(tab.id);
			return {
				ok: true,
				data: { tab_id: tab.id },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "reload": {
			const tab = await resolveTab(params);
			await chrome.tabs.reload(tab.id);
			return {
				ok: true,
				data: { tab_id: tab.id },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "html": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const selector = params.selector || "html";
			const policies = await activeFilterPolicies("html", params, tab);
			const dropRules = domDropRules(policies);
			const expression =
				dropRules.length > 0
					? buildDomReadExpression(selector, "html", dropRules)
					: `String(document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? "")`;
			const evaluated = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Runtime.evaluate",
				{ expression, returnByValue: true },
			);
			const value = runtimeEvaluateValue(evaluated);
			const filteredRead =
				dropRules.length > 0
					? value || { value: "", metadata: null }
					: { value: value || "", metadata: null };
			const response = await truncateOutput(
				filteredRead.value || "",
				params,
				tab,
				"html",
			);
			return attachFilterMetadata(response, filteredRead.metadata);
		}

		case "press": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const keyInput = params.keys || params.key || "";
			// CDP input events don't route to background tabs; focus emulation
			// makes the page accept them without stealing focus.
			await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Emulation.setFocusEmulationEnabled",
				{ enabled: true },
			);
			try {
				const SPECIAL_KEYS = {
					Enter: { code: "Enter", key: "Enter", vk: 13, text: "\r" },
					Tab: { code: "Tab", key: "Tab", vk: 9, text: "\t" },
					Escape: { code: "Escape", key: "Escape", vk: 27, text: "\x1b" },
					Backspace: { code: "Backspace", key: "Backspace", vk: 8, text: "\b" },
					Delete: { code: "Delete", key: "Delete", vk: 46, text: "" },
					ArrowUp: { code: "ArrowUp", key: "ArrowUp", vk: 38, text: "" },
					ArrowDown: { code: "ArrowDown", key: "ArrowDown", vk: 40, text: "" },
					ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", vk: 37, text: "" },
					ArrowRight: {
						code: "ArrowRight",
						key: "ArrowRight",
						vk: 39,
						text: "",
					},
					Home: { code: "Home", key: "Home", vk: 36, text: "" },
					End: { code: "End", key: "End", vk: 35, text: "" },
					PageUp: { code: "PageUp", key: "PageUp", vk: 33, text: "" },
					PageDown: { code: "PageDown", key: "PageDown", vk: 34, text: "" },
					Space: { code: "Space", key: " ", vk: 32, text: " " },
				};

				const MODIFIER_VK = { Control: 17, Shift: 16, Alt: 18, Meta: 91 };

				if (SPECIAL_KEYS[keyInput]) {
					const k = SPECIAL_KEYS[keyInput];
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.dispatchKeyEvent",
						{
							type: "keyDown",
							code: k.code,
							key: k.key,
							windowsVirtualKeyCode: k.vk,
							text: k.text || undefined,
						},
					);
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.dispatchKeyEvent",
						{
							type: "keyUp",
							code: k.code,
							key: k.key,
							windowsVirtualKeyCode: k.vk,
						},
					);
				} else if (keyInput.includes("+")) {
					const parts = keyInput.split("+").map((s) => s.trim());
					const mainKey = parts[parts.length - 1];
					const modifiers = parts.slice(0, -1);
					const mainVK =
						mainKey.length === 1
							? mainKey.toUpperCase().charCodeAt(0)
							: MODIFIER_VK[mainKey] || 0;

					const modParams = {};
					for (const m of modifiers) {
						if (m === "Control") modParams.controlKey = true;
						else if (m === "Shift") modParams.shiftKey = true;
						else if (m === "Alt") modParams.altKey = true;
						else if (m === "Meta") modParams.metaKey = true;
					}

					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.dispatchKeyEvent",
						{
							type: "keyDown",
							code: "Key" + mainKey.toUpperCase()[0],
							key: mainKey,
							windowsVirtualKeyCode: mainVK,
							...modParams,
						},
					);
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.dispatchKeyEvent",
						{
							type: "keyUp",
							code: "Key" + mainKey.toUpperCase()[0],
							key: mainKey,
							windowsVirtualKeyCode: mainVK,
							...modParams,
						},
					);
				} else if (keyInput.length === 1) {
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.dispatchKeyEvent",
						{
							type: "keyDown",
							key: keyInput,
							text: keyInput,
						},
					);
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.dispatchKeyEvent",
						{
							type: "keyUp",
							key: keyInput,
						},
					);
				} else {
					await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Input.insertText",
						{ text: keyInput },
					);
				}
			} finally {
				await chrome.debugger
					.sendCommand(
						{ tabId: tab.id },
						"Emulation.setFocusEmulationEnabled",
						{ enabled: false },
					)
					.catch(() => {});
			}
			return {
				ok: true,
				data: { pressed: keyInput },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "wait": {
			const tab = await resolveTab(params);
			const timeout = params.timeout_ms || 5000;
			let data;
			if (params.url_change_from != null) {
				data = await waitForUrlChange(
					tab.id,
					params.url_change_from,
					timeout,
					chrome.tabs,
				);
			} else if (params.media_ended) {
				await ensureDebugger(tab.id);
				const evaluate = async (expression) =>
					runtimeEvaluateValue(
						await chrome.debugger.sendCommand(
							{ tabId: tab.id },
							"Runtime.evaluate",
							{ expression, returnByValue: true, awaitPromise: true },
						),
					);
				data = await waitForMediaEnd(
					tab,
					params.selector || "video",
					timeout,
					evaluate,
					() => chrome.tabs.get(tab.id),
				);
			} else if (params.xhr) {
				// Match an XHR/fetch by URL substring. First check resource timing
				// history (covers requests that already completed, e.g. a click in
				// an earlier batch step), then watch Network events for new ones.
				await ensureDebugger(tab.id);
				const evaluated = await chrome.debugger.sendCommand(
					{ tabId: tab.id },
					"Runtime.evaluate",
					{
						expression: `performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes(${JSON.stringify(params.xhr)}))`,
						returnByValue: true,
					},
				);
				const hits = runtimeEvaluateValue(evaluated);
				if (Array.isArray(hits) && hits.length > 0) {
					data = { matched: true, url: hits[0], waited_ms: 0, source: "history" };
				} else {
					await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable");
					data = await waitForXhr(tab.id, params.xhr, timeout);
				}
			} else {
				const query =
					params.ref != null ? refSelector(params.ref) : params.selector;
				const start = Date.now();
				while (Date.now() - start < timeout) {
					await ensureDebugger(tab.id);
					const evaluated = await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Runtime.evaluate",
						{
							expression: `!!document.querySelector(${JSON.stringify(query)})`,
							returnByValue: true,
						},
					);
					if (runtimeEvaluateValue(evaluated) === true) {
						data = { matched: true, waited_ms: Date.now() - start };
						break;
					}
					await new Promise((r) => setTimeout(r, 200));
				}
				if (!data)
					throw Object.assign(new Error(`timeout waiting for ${query}`), {
						code: "TIMEOUT",
					});
			}
			return {
				ok: true,
				data,
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "scroll": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const count = Math.max(1, Math.min(params.count || 1, 50));
			const pauseMs = Math.max(200, Math.min(params.pause_ms || 800, 5000));
			const target = params.selector || null;
			const scrolled = [];
			for (let i = 0; i < count; i++) {
				let moved = false;
				if (target) {
					const evaluated = await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Runtime.evaluate",
						{
							expression: `(() => { const el = document.querySelector(${JSON.stringify(target)}); if (el) el.scrollIntoView({behavior:'auto', block:'end'}); return !!el; })()`,
							returnByValue: true,
						},
					);
					moved = runtimeEvaluateValue(evaluated) === true;
				} else {
					const before = await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Runtime.evaluate",
						{
							expression:
								"JSON.stringify({y: window.scrollY, h: document.body.scrollHeight})",
							returnByValue: true,
						},
					);
					const beforeState = safeJsonParse(runtimeEvaluateValue(before));
					await withFocusEmulation(tab.id, chrome.debugger.sendCommand, () =>
						chrome.debugger.sendCommand(
							{ tabId: tab.id },
							"Input.dispatchMouseEvent",
							{
								type: "mouseWheel",
								x: 400,
								y: 300,
								deltaX: 0,
								deltaY: 5000,
							},
						),
					);
					await new Promise((r) => setTimeout(r, 100));
					const after = await chrome.debugger.sendCommand(
						{ tabId: tab.id },
						"Runtime.evaluate",
						{
							expression:
								"JSON.stringify({y: window.scrollY, h: document.body.scrollHeight})",
							returnByValue: true,
						},
					);
					const afterState = safeJsonParse(runtimeEvaluateValue(after));
					moved = afterState.y > beforeState.y || afterState.h > beforeState.h;
				}
				scrolled.push(moved);
				await new Promise((r) => setTimeout(r, pauseMs));
			}
			return {
				ok: true,
				data: { scrolled_count: count, scrolled },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "cdp": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const result = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				params.method,
				params.params || {},
			);
			return {
				ok: true,
				data: { result },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "eval": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const { result, exceptionDetails } = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Runtime.evaluate",
				{
					expression: params.expression,
					returnByValue: true,
					awaitPromise: true,
				},
			);
			if (exceptionDetails) {
				throw Object.assign(
					new Error(exceptionDetails.text || "JS exception"),
					{ code: "JS_EXCEPTION" },
				);
			}
			return {
				ok: true,
				data: { result: result?.value },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "batch": {
			const steps = params.steps || [];
			// Adapter auto-tab: adapter commands send _auto_tab = {domain} when
			// no explicit --tab was given. If the operated tab is unscriptable
			// (chrome://) or on a different host, silently open a tab on the
			// adapter's canonical domain and run the steps there. Same-host
			// tabs keep the "adapter reads the current page" contract.
			if (params._auto_tab && params.tab_id == null) {
				const current = operatedTab || (await resolveTab(params).catch(() => null));
				const host = current?.url ? safeHostOf(current.url) : null;
				const want = normalizeHost(params._auto_tab.domain || "");
				if (!host || !want || host !== want) {
					const created = await chrome.tabs.create({
						url: `https://${params._auto_tab.domain}`,
						active: false,
					});
					operatedTab = created;
					params.tab_id = created.id;
				}
			}
			const results = [];
			let lastTab = null;
			let batchFilterMetadata = null;
			// CLI-style aliases → extension method names (agents write `state`,
			// the extension dispatches `state.snapshot`).
			const METHOD_ALIASES = {
				state: "state.snapshot",
				download: "download.browser",
			};
			for (const step of steps) {
				const stepMethod =
					METHOD_ALIASES[step.method || step.cmd] || step.method || step.cmd;
				var stepParams = buildBatchStepParams(step, params.tab_id);
				if (Array.isArray(params._filters))
					stepParams._filters = params._filters;
				try {
					const isMeta = stepMethod === "ping" || stepMethod === "info";
					if (!isMeta) {
						lastTab = null;
						lastTab = await resolveBatchStepTab(
							stepMethod,
							stepParams,
							resolveTab,
						);
						if (lastTab) {
							cancelPendingRestore(lastTab.id);
							await ensureDebugger(lastTab.id);
							try {
								await swapFaviconToSparkle(lastTab.id);
							} catch (_) {}
						}
					}
					const r = await dispatch(
						stepMethod,
						stepParams,
						lastTab || operatedTab,
					);
					const stepResult = { ok: true, data: r.data };
					if (r.meta?.filters) {
						stepResult.meta = { filters: r.meta.filters };
						batchFilterMetadata = mergeFilterMetadata(
							batchFilterMetadata,
							r.meta.filters,
						);
					}
					results.push(stepResult);
				} catch (e) {
					const stepResult = {
						ok: false,
						error: {
							code: e.code || "INTERNAL",
							message: e.message || String(e),
						},
					};
					if (e.filterMeta) {
						stepResult.meta = { filters: e.filterMeta };
						batchFilterMetadata = mergeFilterMetadata(
							batchFilterMetadata,
							e.filterMeta,
						);
					}
					results.push(stepResult);
					if (params.stop_on_error !== false) break;
				}
			}
			const meta = lastTab
				? await buildMeta({ window_id: lastTab.windowId, tab_id: lastTab.id })
				: await buildMeta(null);
			return attachFilterMetadata(
				{ ok: true, data: { results }, meta },
				batchFilterMetadata,
			);
		}

		case "dev.console.list": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			let msgs = consoleBuffers.get(tab.id) || [];
			if (params.type) msgs = msgs.filter((m) => m.type === params.type);
			if (params.since) {
				const sinceMs =
					typeof params.since === "number"
						? params.since
						: Date.parse(params.since);
				msgs = msgs.filter((m) => m.ts >= sinceMs);
			}
			return {
				ok: true,
				data: { messages: msgs.slice().reverse() },
				meta: await buildMeta({ tab_id: tab.id }),
			};
		}

		case "dev.console.clear": {
			const tab = await resolveTab(params);
			consoleBuffers.delete(tab.id);
			return {
				ok: true,
				data: { cleared: true },
				meta: await buildMeta({ tab_id: tab.id }),
			};
		}

		case "dev.network.list": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const buf = networkBuffers.get(tab.id) || new Map();
			let reqs = [...buf.values()].reverse();
			if (params.failed) reqs = reqs.filter((r) => r.failed || r.status >= 400);
			if (params.type) reqs = reqs.filter((r) => r.type === params.type);
			if (params.filter) {
				const re = new RegExp(params.filter, "i");
				reqs = reqs.filter((r) => re.test(r.url || ""));
			}
			return {
				ok: true,
				data: { requests: reqs },
				meta: await buildMeta({ tab_id: tab.id }),
			};
		}

		case "dev.network.get": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const buf = networkBuffers.get(tab.id) || new Map();
			const entry = buf.get(params.request_id);
			if (!entry) {
				throw Object.assign(
					new Error(`no network request with id ${params.request_id}`),
					{ code: "NOT_FOUND" },
				);
			}
			let body = null;
			try {
				const r = await chrome.debugger.sendCommand(
					{ tabId: tab.id },
					"Network.getResponseBody",
					{ requestId: params.request_id },
				);
				body = r.body ?? null;
			} catch (_) {}
			return {
				ok: true,
				data: { ...entry, body },
				meta: await buildMeta({ tab_id: tab.id }),
			};
		}

		case "dev.errors": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const cBuf = consoleBuffers.get(tab.id) || [];
			const nBuf = networkBuffers.get(tab.id) || new Map();
			const errors = [];
			for (const m of cBuf) {
				if (m.type === "error")
					errors.push({
						source: "console-error",
						text: m.text,
						url: m.url,
						ts: m.ts,
					});
			}
			for (const r of nBuf.values()) {
				if (r.failed || r.status >= 400) {
					errors.push({
						source: "network",
						text: `${r.method} ${r.url} → ${r.status ?? r.error_text}`,
						url: r.url,
						ts: r.ts,
					});
				}
			}
			errors.sort((a, b) => b.ts - a.ts);
			return {
				ok: true,
				data: { errors },
				meta: await buildMeta({ tab_id: tab.id }),
			};
		}

		case "dev.cookies.list": {
			const details = {};
			if (params.domain) details.domain = params.domain;
			if (params.url) details.url = params.url;
			if (params.name) details.name = params.name;
			const cookies = await chrome.cookies.getAll(details);
			const trimmed = cookies.map((c) => ({
				name: c.name,
				value: c.value.slice(0, 200),
				domain: c.domain,
				path: c.path,
				secure: c.secure,
				httpOnly: c.httpOnly,
				sameSite: c.sameSite,
				hostOnly: c.hostOnly,
				session: c.session,
				expirationDate: c.expirationDate || null,
			}));
			return { ok: true, data: { cookies: trimmed, total: trimmed.length } };
		}

		case "dev.cookies.get": {
			const url = params.url;
			const name = params.name;
			if (!url || !name)
				throw Object.assign(new Error("dev.cookies.get requires url + name"), {
					code: "BAD_PARAMS",
				});
			const cookie = await chrome.cookies.get({ url, name });
			return {
				ok: true,
				data: cookie
					? {
							name: cookie.name,
							value: cookie.value,
							domain: cookie.domain,
							path: cookie.path,
							secure: cookie.secure,
							httpOnly: cookie.httpOnly,
							sameSite: cookie.sameSite,
							hostOnly: cookie.hostOnly,
							session: cookie.session,
							expirationDate: cookie.expirationDate || null,
						}
					: null,
			};
		}

		case "dev.cookies.set": {
			const url = params.url;
			if (!url)
				throw Object.assign(
					new Error("dev.cookies.set requires url + name + value"),
					{ code: "BAD_PARAMS" },
				);
			const details = {
				url,
				name: params.name || "",
				value: params.value || "",
			};
			if (params.domain) details.domain = params.domain;
			if (params.path) details.path = params.path;
			if (params.secure != null) details.secure = params.secure;
			if (params.httpOnly != null) details.httpOnly = params.httpOnly;
			if (params.sameSite) details.sameSite = params.sameSite;
			if (params.expirationDate != null)
				details.expirationDate = params.expirationDate;
			const cookie = await chrome.cookies.set(details);
			return {
				ok: true,
				data: {
					set: !!cookie,
					name: details.name,
					domain: details.domain || null,
				},
			};
		}

		case "dev.cookies.delete": {
			const url = params.url;
			const name = params.name;
			if (!url || !name)
				throw Object.assign(
					new Error("dev.cookies.delete requires url + name"),
					{ code: "BAD_PARAMS" },
				);
			const result = await chrome.cookies.remove({ url, name });
			return { ok: true, data: { deleted: !!result, url, name } };
		}

		case "dev.extension.list": {
			const all = await chrome.management.getAll();
			const exts = all
				.filter((e) => e.type === "extension")
				.map((e) => ({
					id: e.id,
					name: e.name,
					version: e.version,
					enabled: e.enabled,
					installType: e.installType,
					description: (e.description || "").slice(0, 120),
					mayDisable: e.mayDisable,
				}));
			return { ok: true, data: { extensions: exts, total: exts.length } };
		}

		case "dev.extension.get": {
			const id = params.id;
			if (!id)
				throw Object.assign(new Error("dev.extension.get requires id"), {
					code: "BAD_PARAMS",
				});
			const e = await chrome.management.get(id);
			return {
				ok: true,
				data: {
					id: e.id,
					name: e.name,
					shortName: e.shortName,
					version: e.version,
					versionName: e.versionName || null,
					description: e.description || "",
					enabled: e.enabled,
					installType: e.installType,
					type: e.type,
					mayDisable: e.mayDisable,
					homepageUrl: e.homepageUrl || null,
					optionsUrl: e.optionsUrl || null,
					permissions: e.permissions || [],
					hostPermissions: e.hostPermissions || [],
					icons: (e.icons || []).map((i) => ({ size: i.size, url: i.url })),
				},
			};
		}

		case "dev.extension.reload": {
			const targetId = params.id || chrome.runtime.id;
			if (targetId === chrome.runtime.id) {
				scheduleExtensionReload(() => chrome.runtime.reload());
				return {
					ok: true,
					data: {
						reloaded: targetId,
						self: true,
						note: "extension restarting; expect ~3s disconnect",
					},
				};
			}
			await chrome.management.setEnabled(targetId, false);
			await chrome.management.setEnabled(targetId, true);
			const e = await chrome.management.get(targetId);
			return {
				ok: true,
				data: { reloaded: targetId, self: false, enabled: e.enabled },
			};
		}

		case "dev.extension.enable": {
			const id = params.id;
			if (!id)
				throw Object.assign(new Error("dev.extension.enable requires id"), {
					code: "BAD_PARAMS",
				});
			await chrome.management.setEnabled(id, true);
			const e = await chrome.management.get(id);
			return { ok: true, data: { id, enabled: e.enabled } };
		}

		case "dev.extension.disable": {
			const id = params.id;
			if (!id)
				throw Object.assign(new Error("dev.extension.disable requires id"), {
					code: "BAD_PARAMS",
				});
			if (id === chrome.runtime.id)
				throw Object.assign(
					new Error("cannot disable self; use reload instead"),
					{ code: "BAD_PARAMS" },
				);
			await chrome.management.setEnabled(id, false);
			const e = await chrome.management.get(id);
			return { ok: true, data: { id, enabled: e.enabled } };
		}

		case "dev.extension.uninstall": {
			const id = params.id;
			if (!id)
				throw Object.assign(new Error("dev.extension.uninstall requires id"), {
					code: "BAD_PARAMS",
				});
			if (id === chrome.runtime.id)
				throw Object.assign(
					new Error("cannot uninstall self; use chrome://extensions UI"),
					{ code: "BAD_PARAMS" },
				);
			await chrome.management.uninstall(id, { showConfirmDialog: false });
			return { ok: true, data: { uninstalled: id } };
		}

		case "download.browser": {
			const url = params.url;
			const filename = params.filename;
			if (!url)
				throw Object.assign(new Error("download.browser requires url"), {
					code: "BAD_PARAMS",
				});
			const downloadId = await chrome.downloads.download({
				url,
				filename,
				saveAs: false,
			});
			return {
				ok: true,
				data: { download_id: downloadId, filename: filename || null },
			};
		}

		case "capture.pdf": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const filename = params.filename || "page.pdf";
			const downloadPath = params.download_path || null;
			const landscape = params.landscape || false;
			const paperFormat = params.format || "A4";
			const { data } = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Page.printToPDF",
				{
					landscape,
					paperFormat,
					printBackground: true,
				},
			);
			if (downloadPath) {
				const fs = await import("fs").catch(() => null);
				if (fs) {
					const fullPath = downloadPath.endsWith("/")
						? downloadPath + filename
						: downloadPath + "/" + filename;
					await fs.promises.writeFile(fullPath, Buffer.from(data, "base64"));
					return { ok: true, data: { file: fullPath, method: "direct-write" } };
				}
			}
			const dataUrl = `data:application/pdf;base64,${data}`;
			const id = await chrome.downloads.download({
				url: dataUrl,
				filename,
				saveAs: false,
			});
			return {
				ok: true,
				data: { download_id: id, filename, method: "chrome-downloads" },
			};
		}

		case "capture.mhtml": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const filename = params.filename || "page.mhtml";
			const downloadPath = params.download_path || null;
			const { data } = await chrome.debugger.sendCommand(
				{ tabId: tab.id },
				"Page.captureSnapshot",
				{
					format: "mhtml",
				},
			);
			if (downloadPath) {
				const fs = await import("fs").catch(() => null);
				if (fs) {
					const fullPath = downloadPath.endsWith("/")
						? downloadPath + filename
						: downloadPath + "/" + filename;
					await fs.promises.writeFile(fullPath, Buffer.from(data, "base64"));
					return { ok: true, data: { file: fullPath, method: "direct-write" } };
				}
			}
			const dataUrl = `data:text/x-mhtml;base64,${data}`;
			const id = await chrome.downloads.download({
				url: dataUrl,
				filename,
				saveAs: false,
			});
			return {
				ok: true,
				data: { download_id: id, filename, method: "chrome-downloads" },
			};
		}

		default:
			throw Object.assign(new Error(`unknown method: ${method}`), {
				code: "UNKNOWN_METHOD",
			});
	}
}

async function activeFilterPolicies(method, params, operatedTab) {
	const policies = params?._filters;
	if (!Array.isArray(policies) || policies.length === 0) return [];
	const methodEligible = policies.some((policy) => {
		const methods = policy?.match?.methods;
		return (
			!Array.isArray(methods) ||
			methods.length === 0 ||
			methods.includes(method)
		);
	});
	if (!methodEligible) return [];

	const tab = await resolveFilterOperationTab(operatedTab, params, resolveTab);
	return matchingPolicies(policies, tab?.url, method);
}

function attachFilterMetadata(response, metadata) {
	if (!hasFilterDiagnostics(metadata)) return response;
	response.meta ||= {};
	response.meta.filters = mergeFilterMetadata(response.meta.filters, metadata);
	return response;
}

function filterDeniedError(metadata) {
	const policyIds = metadata?.matched_policy_ids || [];
	const suffix = policyIds.length > 0 ? `: ${policyIds.join(", ")}` : "";
	return Object.assign(
		new Error(`interaction denied by site filter${suffix}`),
		{
			code: "FILTER_DENIED",
			filterMeta: metadata,
		},
	);
}

// Resolve target tab: explicit tab_id, else active tab of last focused window.
async function resolveTab(params) {
	if (params.tab_id != null) {
		const t = await chrome.tabs.get(params.tab_id);
		return t;
	}
	const win = await chrome.windows.getLastFocused();
	const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
	if (!tabs[0])
		throw Object.assign(new Error("no active tab"), { code: "TAB_NOT_FOUND" });
	return tabs[0];
}

// Host without scheme/port/www. Used to compare the operated tab against an
// adapter's canonical site domain (auto-tab decision).
function safeHostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return null;
	}
}
function normalizeHost(domain) {
	return domain.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();
}

// Wait until an XHR/fetch whose URL contains `urlSubstr` completes.
function waitForXhr(tabId, urlSubstr, timeoutMs) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		let done = false;
		const finish = (fn, value) => {
			if (done) return;
			done = true;
			chrome.debugger.onEvent.removeListener(listener);
			clearTimeout(timer);
			fn(value);
		};
		const listener = (source, method, params) => {
			if (source.tabId !== tabId || method !== "Network.responseReceived")
				return;
			const url = params.response && params.response.url;
			if (url && url.includes(urlSubstr)) {
				finish(resolve, {
					matched: true,
					url,
					waited_ms: Date.now() - start,
					source: "network",
				});
			}
		};
		const timer = setTimeout(() => {
			finish(
				reject,
				Object.assign(new Error(`timeout waiting for xhr ${urlSubstr}`), {
					code: "TIMEOUT",
				}),
			);
		}, timeoutMs);
		chrome.debugger.onEvent.addListener(listener);
	});
}

// Attach debugger if not already attached.
const attachedTabs = new Set();
const attachingTabs = new Map();
const lockedTabs = new Set();
const pendingRestoreTimers = new Map();
const CLEANUP_TIMEOUT_MS = 500;

// ─── Dev mode: per-tab ring buffers for console + network events ──────────
const CONSOLE_BUFFER_CAP = 500;
const NETWORK_BUFFER_CAP = 500;
const consoleBuffers = new Map();
const networkBuffers = new Map();

function pushConsole(tabId, entry) {
	let buf = consoleBuffers.get(tabId);
	if (!buf) {
		buf = [];
		consoleBuffers.set(tabId, buf);
	}
	buf.push(entry);
	if (buf.length > CONSOLE_BUFFER_CAP) buf.shift();
}

function upsertNetwork(tabId, requestId, patch) {
	let buf = networkBuffers.get(tabId);
	if (!buf) {
		buf = new Map();
		networkBuffers.set(tabId, buf);
	}
	const existing = buf.get(requestId) || { request_id: requestId };
	const updated = { ...existing, ...patch };
	buf.set(requestId, updated);
	if (buf.size > NETWORK_BUFFER_CAP) buf.delete(buf.keys().next().value);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
	const tabId = source.tabId;
	if (tabId === null || tabId === undefined) return;
	const ts = Date.now();
	switch (method) {
		case "Runtime.consoleAPICalled":
			pushConsole(tabId, {
				type: params.type || "log",
				text: (params.args || [])
					.map((a) => a.value ?? a.description ?? "")
					.join(" "),
				url: params.stackTrace?.[0]?.url || null,
				line: params.stackTrace?.[0]?.lineNumber ?? null,
				column: params.stackTrace?.[0]?.columnNumber ?? null,
				ts,
			});
			break;
		case "Runtime.exceptionThrown":
			pushConsole(tabId, {
				type: "error",
				text:
					params.exceptionDetails?.text ||
					params.exceptionDetails?.exception?.description ||
					"Uncaught exception",
				stack:
					params.exceptionDetails?.stackTrace?.callFrames
						?.map((f) => `${f.functionName}(${f.url}:${f.lineNumber})`)
						.join("\n") || null,
				url: params.exceptionDetails?.url || null,
				ts,
			});
			break;
		case "Log.entryAdded":
			pushConsole(tabId, {
				type: params.entry?.level || "log",
				text: params.entry?.text || "",
				url: params.entry?.url || null,
				line: params.entry?.lineNumber ?? null,
				ts: params.entry?.timestamp || ts,
			});
			break;
		case "Network.requestWillBeSent":
			upsertNetwork(tabId, params.requestId, {
				method: params.request?.method,
				url: params.request?.url,
				type: params.type,
				request_headers: params.request?.headers,
				ts: params.timestamp ? Date.parse(params.timestamp) : ts,
			});
			break;
		case "Network.responseReceived":
			upsertNetwork(tabId, params.requestId, {
				status: params.response?.status,
				status_text: params.response?.statusText,
				mime_type: params.response?.mimeType,
				response_headers: params.response?.headers,
				response_size: params.response?.encodedDataLength ?? null,
			});
			break;
		case "Network.loadingFinished":
			upsertNetwork(tabId, params.requestId, {
				finished: true,
				duration_ms: params.timestamp
					? Math.round(params.timestamp * 1000)
					: null,
			});
			break;
		case "Network.loadingFailed":
			upsertNetwork(tabId, params.requestId, {
				failed: true,
				error_text: params.errorText,
				finished: true,
			});
			break;
		default:
			break;
	}
});

async function ensureDebugger(tabId) {
	await ensureAttachedOnce(tabId, { attachedTabs, attachingTabs }, async () => {
		try {
			await chrome.debugger.attach({ tabId }, "1.3");
		} catch (e) {
			if (e.message?.includes("Another debugger")) {
				throw Object.assign(new Error(`debugger rejected for tab ${tabId}`), {
					code: "DEBUGGER_ATTACH_FAILED",
				});
			}
			if (!e.message?.includes("Already attached")) {
				throw e;
			}
		}
		await Promise.allSettled(
			["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"].map(
				(method) => chrome.debugger.sendCommand({ tabId }, method),
			),
		);
	});
}

function clearTabState(tabId) {
	clearTabRuntimeState(tabId, {
		attachedTabs,
		attachingTabs,
		lockedTabs,
		pendingRestoreTimers,
		consoleBuffers,
		networkBuffers,
	});
}

chrome.debugger.onDetach.addListener((source) => {
	if (source.tabId != null) clearTabState(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => clearTabState(tabId));

async function detachDebugger(tabId) {
	if (!attachedTabs.has(tabId)) return;
	try {
		await chrome.debugger.detach({ tabId });
	} catch (_) {}
	clearTabState(tabId);
}

async function releaseTab(tabId) {
	cancelPendingRestore(tabId);
	await settleWithin(restoreFavicon(tabId), CLEANUP_TIMEOUT_MS);
	await settleWithin(detachDebugger(tabId), CLEANUP_TIMEOUT_MS);
	clearTabState(tabId);
}

async function unlockOtherTabs(keepTabId) {
	await Promise.all(
		[...lockedTabs].filter((id) => id !== keepTabId).map(releaseTab),
	);
}

async function unlockAllTabs() {
	await Promise.all([...lockedTabs].map(releaseTab));
}

function cancelPendingRestore(tabId) {
	const timer = pendingRestoreTimers.get(tabId);
	if (timer) {
		clearTimeout(timer);
		pendingRestoreTimers.delete(tabId);
	}
}

function scheduleRestore(tabId, delayMs) {
	cancelPendingRestore(tabId);
	const timer = setTimeout(() => releaseTab(tabId), delayMs);
	pendingRestoreTimers.set(tabId, timer);
}

async function truncateOutput(full, params, tab, field) {
	let text = full,
		range = [0, full.length],
		truncated = false;
	if (params.full) {
		// no truncation
	} else if (params.range) {
		const [s, e] = params.range;
		text = full.slice(s, e);
		range = [s, s + text.length];
		truncated = s + text.length < full.length;
	} else {
		const cap = 50000;
		text = full.slice(0, cap);
		range = [0, text.length];
		truncated = text.length < full.length;
	}
	const data = { [field]: text };
	if (truncated) {
		data.truncated = true;
		data.total_chars = full.length;
		data.range = range;
	}
	return {
		ok: true,
		data,
		meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
	};
}

async function buildMeta(operated) {
	try {
		const win = await chrome.windows.getLastFocused({ populate: false });
		const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
		const at = tabs[0] || null;
		const matched = operated && at ? operated.tab_id === at.id : false;
		const { instance_id, label } = await ensureInstanceId();
		const meta = {
			operated,
			focus: { matched_operated_target: matched },
			profile: { instance_id, label: label || null },
		};
		if (!matched && at) {
			meta.focus.tab_id = at.id;
			meta.focus.tab_title = at.title;
		}
		return meta;
	} catch (e) {
		return { focus: { matched_operated_target: false } };
	}
}

// Page-provided strings stay untrusted; never parse them bare.
function safeJsonParse(value) {
	try {
		return JSON.parse(value || "{}") || {};
	} catch (_) {
		return {};
	}
}

// ─── Keep-alive ──────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== KEEPALIVE_ALARM) return;
	ensureKeepaliveAlarm(); // self-heal if the alarm ever went missing
	if (nativePort) {
		const port = nativePort;
		postToNative(port, { jsonrpc: "2.0", method: "keepalive", params: {} });
	} else {
		// Port dropped — reconnect.
		connectNativePort();
	}
});

// ─── Storage change → re-push hello with new label ───────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "local") return;
	if (changes.label) {
		labelCache = changes.label.newValue || "";
		if (nativePort) {
			ensureInstanceId().then(({ instance_id }) =>
				buildHelloWithTabs(instance_id, labelCache).then((hello) =>
					nativePort.postMessage({
						jsonrpc: "2.0",
						method: "hello",
						params: hello,
					}),
				),
			);
		}
	}
});

// ─── SW lifecycle hooks ──────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
	await ensureInstanceId();
	await ensureKeepaliveAlarm();
	await connectNativePort();
});

chrome.runtime.onStartup.addListener(async () => {
	await ensureInstanceId();
	await ensureKeepaliveAlarm();
});

// Top-level unconditional connect: fires on every SW spawn, regardless of
// what woke it (alarm, popup message, tab event, etc). Chrome MV3 may tear
// down the SW and respawn it without re-firing onStartup/onInstalled.
// Alarm ensure here too: if the SW was disposed while the alarm was missing
// (e.g. onInstalled never ran after a reload), this recreates it so the
// wake-net is never lost.
ensureInstanceId().then(() => connectNativePort());
ensureKeepaliveAlarm();

chrome.action.onClicked.addListener(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg?.method === "status") {
		sendResponse({
			native_host: nativePort ? "connected" : "disconnected",
			active_ops: lockedTabs.size,
		});
		return false;
	}
});

// On SW wakeup (any event), make sure we have a port.
