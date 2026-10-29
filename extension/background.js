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
	readDomText,
	readInteractionValue,
	resolveBatchStepTab,
	resolveFilterOperationTab,
	shouldFilterOuterResponse,
} from "./filter-enforcement.mjs";
import {
	buildBatchStepParams,
	classifyListBehavior,
	cleanupAutoCreatedTab,
	clearTabRuntimeState,
	ensureAttachedOnce,
	isCurrentPort,
	listSnapshotExpression,
	nextReconnectDelay,
	runtimeEvaluateValue,
	scheduleExtensionReload,
	settleWithin,
	waitForCondition,
	waitForMediaEnd,
	waitForUrlChange,
	withFocusEmulation,
} from "./runtime-helpers.mjs";
import {
	buildSnapshotExpression,
	refSelector,
	STATE_ELEMENT_SELECTOR,
	STATE_MAX_REFS,
} from "./state-snapshot.mjs";

import { createRecordingController, recordingCapabilities } from "./recording.mjs";
import { createRecordingGuard } from "./recording-guard.mjs";

// Every extension CDP path (including ordinary raw commands) crosses this guard.
// Save the actual Chrome method before installing target-specific ownership checks.
const recordingGuard = createRecordingGuard(chrome.debugger.sendCommand.bind(chrome.debugger));
chrome.debugger.sendCommand = recordingGuard.send;

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
let swNextId = 1;
let snapshotAllocation = Promise.resolve();

function nextSnapshotExpression() {
	const pending = snapshotAllocation.then(async () => {
		const stored = await chrome.storage.session.get("state_next_ref");
		const base = stored.state_next_ref || 0;
		await chrome.storage.session.set({ state_next_ref: base + STATE_MAX_REFS });
		return buildSnapshotExpression(base);
	});
	snapshotAllocation = pending.catch(() => {});
	return pending;
}

function checkInteractionError(interaction) {
	if (interaction?.error) {
		throw Object.assign(new Error(interaction.error.message), { code: interaction.error.code });
	}
}
const swPending = new Map();
let recordingController = null;
let recordingPort = null;
const recordingLeases = new Map();
const normalTabUsers = new Map();

function recordingForPort(port) {
	if (recordingController && recordingPort === port) return recordingController;
	if (recordingController?.isActive()) throw Object.assign(new Error("Previous recording cleanup is not confirmed"), { code: "RECORD_BUSY" });
	recordingPort = port;
	recordingController = createRecordingController({
		chrome,
		acquireLease: acquireRecordingLease,
		// Bind every capture RPC to this exact connection. Never reconnect/resume a capture.
		sendNative: (method, params, onSent) => new Promise((resolve, reject) => {
			if (nativePort !== port) {
				reject(Object.assign(new Error("Recording native connection lost"), { code: "RECORD_INTERRUPTED" }));
				return;
			}
			const id = `sw-${swNextId++}`;
			const timer = setTimeout(() => {
				swPending.delete(id);
				reject(Object.assign(new Error("Recording native call timed out"), { code: "TIMEOUT" }));
			}, 10000);
			swPending.set(id, { resolve, reject, timer, port, recording: true });
			try { port.postMessage({ id, method, params }); onSent?.(); }
			catch (e) { clearTimeout(timer); swPending.delete(id); reject(e); }
		}),
	});
	return recordingController;
}

async function sendToNativeHost(method, params = {}, timeoutMs = 15000) {
	if (!nativePort) {
		await connectNativePort();
	}
	if (!nativePort) {
		throw new Error("Native host not connected");
	}
	return new Promise((resolve, reject) => {
		const id = `sw-${swNextId++}`;
		const timer = setTimeout(() => {
			swPending.delete(id);
			reject(new Error(`Timeout waiting for native host: ${method}`));
		}, timeoutMs);
		swPending.set(id, { resolve, reject, timer });
		try {
			nativePort.postMessage({ id, method, params });
		} catch (error) {
			clearTimeout(timer);
			swPending.delete(id);
			reject(error);
		}
	});
}

// Session state is private to this extension session (never exposed to page JS).
const eventRoutes = new Map();
const threadRoutes = new Map();
const earlyRelayEvents = new Map();
const routesReady = chrome.storage.session.get("relay_routes").then(({ relay_routes }) => {
	for (const [id, route] of relay_routes?.events || []) eventRoutes.set(id, route);
	for (const [id, route] of relay_routes?.threads || []) threadRoutes.set(id, route);
});
function persistRoutes() {
	return chrome.storage.session.set({
		relay_routes: { events: [...eventRoutes], threads: [...threadRoutes] },
	});
}
let bindingQueue = Promise.resolve();

function withBindingsLock(fn) {
	const next = bindingQueue.then(fn);
	bindingQueue = next.catch(() => {});
	return next;
}

async function storedBindings() {
	const { session_bindings } = await chrome.storage.session.get("session_bindings");
	return Array.isArray(session_bindings) ? session_bindings : [];
}

function bindingsForTab(bindings, tabId, windowId) {
	return bindings.filter(
		(b) =>
			(b.scope === "tab" && b.tab_id === tabId) ||
			(b.scope === "window" && b.window_id === windowId),
	);
}

function activeBindingOf(pool) {
	const active = pool.filter((b) => b.active);
	const timestamp = (b) => (active.length ? (b.selected_at ?? b.bound_at) : b.bound_at);
	return (active.length ? active : pool).reduce(
		(latest, b) => (!latest || timestamp(b) >= timestamp(latest) ? b : latest),
		null,
	);
}

async function affectedBindingTabs(affected) {
	const tabs = new Map();
	const tabIds = new Set(affected.filter((b) => b.scope === "tab").map((b) => b.tab_id));
	const windowIds = new Set(affected.filter((b) => b.scope === "window").map((b) => b.window_id));
	for (const windowId of windowIds) {
		for (const tab of await chrome.tabs.query({ windowId })) tabs.set(tab.id, tab);
	}
	for (const tabId of tabIds) {
		if (tabs.has(tabId)) continue;
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (tab) tabs.set(tab.id, tab);
	}
	return [...tabs.values()];
}

async function promoteBindings(bindings, affected) {
	for (const tab of await affectedBindingTabs(affected)) {
		const pool = bindingsForTab(bindings, tab.id, tab.windowId);
		if (pool.length && !pool.some((b) => b.active)) {
			const ready = pool.filter(bindingReady);
			activeBindingOf(ready.length ? ready : pool).active = true;
		}
	}
}

async function broadcastBindings(bindings, affected, reason) {
	await Promise.all(
		(await affectedBindingTabs(affected)).map((tab) => {
			const pool = bindingsForTab(bindings, tab.id, tab.windowId);
			return chrome.tabs
				.sendMessage(tab.id, {
					method: "annotate.binding_changed",
					binding: activeBindingOf(pool),
					bindings: pool,
					...(reason ? { reason } : {}),
				})
				.catch(() => {});
		}),
	);
}

const HEALTH_CACHE_MS = 5000;
let healthTimer = null;

function bindingReady(binding) {
	return binding?.health?.state === "ready" && binding.health.valid_until > Date.now();
}

async function bindingHealth(binding) {
	try {
		const res = await sendToNativeHost(
			"relay.check_liveness",
			{
				pid: binding.pid,
				inbox: binding.inbox,
				session_id: binding.session_id,
				receiver_epoch: binding.receiver_epoch,
			},
			3000,
		);
		if (!["ready", "unknown", "offline"].includes(res.state))
			throw new Error("Receiver health protocol unavailable");
		if (res.state === "ready" && (!res.receiver_epoch || !(res.valid_until > Date.now())))
			throw new Error("Receiver evidence expired");
		return res;
	} catch (error) {
		return {
			state: "unknown",
			reason: "HEALTH_CHECK_UNAVAILABLE",
			checked_at: Date.now(),
			valid_until: Date.now(),
		};
	}
}

function scheduleBindingHealth(bindings) {
	clearTimeout(healthTimer);
	if (!bindings.some((b) => b.health?.state !== "offline")) return;
	const expiry = Math.min(...bindings.filter(bindingReady).map((b) => b.health.valid_until));
	healthTimer = setTimeout(
		() => refreshBindingHealth().catch(console.warn),
		Math.max(100, Math.min(HEALTH_CACHE_MS, expiry - Date.now())),
	);
}

// Called under bindingQueue. Keep saved bindings; health loss must not silently select another session.
async function pruneBindings(bindings, candidates = bindings, force = false) {
	const changed = [];
	await Promise.all(
		candidates.map(async (b) => {
			if (b.health?.state === "offline") return; // Explicit rebind is required after identity loss.
			if (
				!force &&
				b.health &&
				Date.now() - b.health.checked_at < HEALTH_CACHE_MS &&
				(b.health.state !== "ready" || bindingReady(b))
			)
				return;
			const health = await bindingHealth(b);
			if (!b.receiver_epoch && health.receiver_epoch) b.receiver_epoch = health.receiver_epoch;
			if (JSON.stringify(b.health) !== JSON.stringify(health)) {
				b.health = health;
				changed.push(b);
			}
		}),
	);
	if (changed.length) {
		await chrome.storage.session.set({ session_bindings: bindings });
		await broadcastBindings(bindings, changed, "health");
	}
	scheduleBindingHealth(bindings);
	return bindings;
}

async function expireRelayReceipts() {
	await routesReady;
	for (const [event_id, route] of eventRoutes) {
		if (route.status === "queued" && route.ack_deadline <= Date.now())
			await forwardRelayEvent({
				event_id,
				status: "unconfirmed",
				message: "No receiver acknowledgement; outcome unknown. Do not automatically retry.",
			}).catch(() => {});
	}
}

async function refreshBindingHealth() {
	await withBindingsLock(async () => pruneBindings(await storedBindings(), undefined, true));
	await expireRelayReceipts();
}

async function invalidateBindingHealth(reason) {
	await withBindingsLock(async () => {
		const bindings = await storedBindings();
		const changed = bindings.filter((b) => b.health?.state !== "offline");
		for (const b of changed) b.health = { state: "unknown", reason, checked_at: 0, valid_until: 0 };
		if (changed.length) {
			await chrome.storage.session.set({ session_bindings: bindings });
			await broadcastBindings(bindings, changed, "health");
		}
	});
}

async function liveBindings() {
	return withBindingsLock(async () => pruneBindings(await storedBindings()));
}

async function resolveBindingsForTab(tabId, windowId, force = false) {
	return withBindingsLock(async () => {
		const stored = await storedBindings();
		const live = await pruneBindings(stored, bindingsForTab(stored, tabId, windowId), force);
		const bindings = bindingsForTab(live, tabId, windowId);
		return { binding: activeBindingOf(bindings), bindings };
	});
}

async function selectBinding(params) {
	return withBindingsLock(async () => {
		const tab = params.tab_id != null ? await chrome.tabs.get(params.tab_id) : null;
		const tabId = tab?.id ?? null;
		const windowId = tab?.windowId ?? params.window_id;
		const stored = await storedBindings();
		const live = await pruneBindings(stored, bindingsForTab(stored, tabId, windowId));
		const bindings = bindingsForTab(live, tabId, windowId);
		const chosen = activeBindingOf(bindings.filter((b) => b.session_id === params.session_id));
		if (!chosen || chosen.health?.state === "offline")
			throw Object.assign(new Error("Session is not in this tab's live pool"), {
				code: "BINDING_OFFLINE",
			});
		for (const b of bindings) b.active = b === chosen;
		chosen.selected_at = Date.now();
		await chrome.storage.session.set({ session_bindings: live });
		await broadcastBindings(live, bindings, "selected");
		return { ok: true, binding: chosen, bindings };
	});
}

async function injectBoundDock(tab) {
	if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
	const probe = await chrome.scripting.executeScript({
		target: { tabId: tab.id },
		func: () => !!(window.__apAnnotatePanel && document.querySelector("#ap-annotate-root")),
	});
	if (!probe?.[0]?.result) {
		await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["annotate-ui.js"] });
	}
}

async function bindSession(params) {
	if (!params.inbox || !params.session_id || !Number.isInteger(params.pid) || params.pid <= 0) {
		throw Object.assign(new Error("inbox, session_id and a positive pid are required"), {
			code: "INVALID_PARAMS",
		});
	}
	const tab = params.tab_id != null ? await chrome.tabs.get(params.tab_id) : null;
	const windowId = tab?.windowId ?? params.window_id ?? (await chrome.windows.getLastFocused()).id;
	const binding = {
		scope: tab ? "tab" : "window",
		tab_id: tab?.id ?? null,
		window_id: windowId,
		session_id: params.session_id,
		label: params.label || params.session_id.slice(0, 8),
		pid: params.pid,
		inbox: params.inbox,
		bound_at: Date.now(),
		active: true,
	};
	await withBindingsLock(async () => {
		binding.health = await bindingHealth(binding);
		binding.receiver_epoch = binding.health.receiver_epoch;
		if (binding.health.state === "offline") {
			throw Object.assign(new Error("Bound session is offline"), { code: "BINDING_OFFLINE" });
		}
		const { instance_id, label } = await ensureInstanceId();
		await sendToNativeHost("relay.register_peer", {
			instance_id,
			label: label || "ap-browser",
			inbox: binding.inbox,
		});
		const live = await pruneBindings(await storedBindings());
		const sameTarget = (b) =>
			b.scope === binding.scope &&
			(binding.scope === "tab" ? b.tab_id === binding.tab_id : b.window_id === binding.window_id);
		const bindings = live.filter((b) => !(sameTarget(b) && b.session_id === binding.session_id));
		for (const b of bindings) if (sameTarget(b)) b.active = false;
		await chrome.storage.session.set({ session_bindings: [...bindings, binding] });
		await broadcastBindings([...bindings, binding], [binding], "bound");
		scheduleBindingHealth([...bindings, binding]);
	});
	const active = tab || (await chrome.tabs.query({ active: true, windowId }))[0];
	// Binding is valid even on restricted pages; injection is only a best effort.
	await injectBoundDock(active).catch(() => {});
	return { ok: true, data: { binding } };
}

async function unbindSessions(params = {}) {
	return withBindingsLock(async () => {
		const bindings = await storedBindings();
		let windowId = params.window_id;
		if (!params.all && params.tab_id == null && windowId == null && !params.session_id) {
			windowId = (await chrome.windows.getLastFocused().catch(() => null))?.id;
		}
		const removed = bindings.filter((b) => {
			if (params.all) return true;
			if (params.session_id && b.session_id !== params.session_id) return false;
			if (params.tab_id != null) return b.scope === "tab" && b.tab_id === params.tab_id;
			if (windowId != null) return b.scope === "window" && b.window_id === windowId;
			return !!params.session_id;
		});
		const remaining = await pruneBindings(bindings.filter((b) => !removed.includes(b)));
		await promoteBindings(remaining, removed);
		await chrome.storage.session.set({ session_bindings: remaining });
		await broadcastBindings(remaining, removed, "unbound");
		return { ok: true, data: { unbound: removed.length } };
	});
}

async function replyTarget(params) {
	const route = eventRoutes.get(params.event_id) || threadRoutes.get(params.thread_id);
	if (params.tab_id != null || route?.tab_id != null) return params.tab_id ?? route.tab_id;
	const bindings = (await liveBindings()).filter(bindingReady);
	const b = bindings.find((b) => params.window_id == null || b.window_id === params.window_id);
	if (!b) return null;
	if (b.scope === "tab") return b.tab_id;
	return (await chrome.tabs.query({ active: true, windowId: b.window_id }))[0]?.id ?? null;
}

async function forwardRelayEvent(params, status) {
	await routesReady;
	const event = eventRoutes.get(params.event_id);
	const nextStatus = status || params.status || "done";
	if (
		params.receiver_epoch &&
		event &&
		(event.receiver_epoch !== params.receiver_epoch || event.session_id !== params.session_id)
	)
		return { ok: false };
	if (event) {
		// A late queue timeout/acceptance must not overwrite real execution progress.
		if (
			["accepted", "unconfirmed", "rejected", "expired"].includes(nextStatus) &&
			!["queued", "unconfirmed"].includes(event.status)
		)
			return { ok: true };
		event.status = nextStatus;
		await persistRoutes();
	}
	const tabId = await replyTarget(params);
	if (tabId == null)
		throw Object.assign(new Error("No annotation reply target"), { code: "TAB_NOT_FOUND" });
	const route = eventRoutes.get(params.event_id) || threadRoutes.get(params.thread_id);
	await chrome.tabs.sendMessage(tabId, {
		method: "annotate.relay_event",
		event_id: params.event_id,
		session_id: route?.session_id ?? params.session_id,
		session_label: route?.session_label ?? params.from_label,
		receiver_epoch: route?.receiver_epoch ?? params.receiver_epoch,
		thread_id: params.thread_id || eventRoutes.get(params.event_id)?.thread_id || params.event_id,
		status: nextStatus,
		message: params.message,
		...(params.from_label ? { from_label: params.from_label } : {}),
		ts: Date.now(),
	});
	return { ok: true, data: { delivered: true, tab_id: tabId } };
}

async function sendAnnotationRelay(msg, sender) {
	const tab = sender.tab;
	if (!tab?.id) throw new Error("relay.send requires a content-script tab");
	const pool = await resolveBindingsForTab(tab.id, tab.windowId, true);
	await routesReady;
	const owner = threadRoutes.get(msg.thread_id);
	const sessionId = owner?.session_id ?? msg.session_id;
	const binding =
		sessionId != null
			? activeBindingOf(pool.bindings.filter((b) => b.session_id === sessionId))
			: pool.binding;
	if (
		!binding ||
		binding.health?.state === "offline" ||
		(msg.receiver_epoch && msg.receiver_epoch !== binding.receiver_epoch) ||
		(owner && owner.receiver_epoch !== binding.receiver_epoch)
	)
		return {
			ok: false,
			code: "BINDING_OFFLINE",
			error: "Target session is offline or replaced",
			...pool,
		};
	if (!bindingReady(binding))
		return {
			ok: false,
			code: "BINDING_UNVERIFIED",
			error: "Receiver readiness is not verified",
			...pool,
		};
	const { instance_id, label } = await ensureInstanceId();
	let res;
	try {
		res = await sendToNativeHost("relay.deliver", {
			instance_id,
			profile_label: label || "Chrome",
			session_id: binding.session_id,
			label: binding.label,
			pid: binding.pid,
			inbox: binding.inbox,
			receiver_epoch: binding.receiver_epoch,
			window_id: tab.windowId,
			tab_id: tab.id,
			action: msg.action,
			raw_text: msg.raw_text,
			user_note: msg.user_note,
			is_command: msg.is_command,
			url: msg.url || tab.url,
			title: msg.title || tab.title,
			element: msg.element,
			thread_id: msg.thread_id,
		});
	} catch (error) {
		await refreshBindingHealth();
		return {
			ok: false,
			code: error.code || "RELAY_FAILED",
			error: error.message,
			...(await resolveBindingsForTab(tab.id, tab.windowId)),
		};
	}
	const delivered = res.result;
	const route = {
		tab_id: tab.id,
		window_id: tab.windowId,
		session_id: binding.session_id,
		session_label: binding.label,
		receiver_epoch: binding.receiver_epoch,
	};
	eventRoutes.set(delivered.event_id, {
		...route,
		thread_id: delivered.thread_id,
		status: "queued",
		ack_deadline: delivered.ack_deadline || Date.now() + 60000,
	});
	threadRoutes.set(delivered.thread_id, route);
	await persistRoutes();
	const early = earlyRelayEvents.get(delivered.event_id);
	if (early) {
		earlyRelayEvents.delete(delivered.event_id);
		await forwardRelayEvent(early);
	}
	return { ok: true, data: res };
}

async function removeClosedBindings(tabId, windowId) {
	await routesReady;
	await withBindingsLock(async () => {
		const bindings = await storedBindings();
		await chrome.storage.session.set({
			session_bindings: bindings.filter((b) =>
				windowId != null ? b.window_id !== windowId : !(b.scope === "tab" && b.tab_id === tabId),
			),
		});
	});
	for (const [id, route] of eventRoutes) {
		if (windowId != null ? route.window_id === windowId : route.tab_id === tabId)
			eventRoutes.delete(id);
	}
	for (const [id, route] of threadRoutes) {
		if (windowId != null ? route.window_id === windowId : route.tab_id === tabId)
			threadRoutes.delete(id);
	}
	await persistRoutes();
}

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
	const { instance_id, label } = await chrome.storage.local.get(["instance_id", "label"]);
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
		chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0] || null),
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
			if (recordingPort === port) recordingController?.interrupt("native_disconnected");
			for (const [id, pending] of swPending) {
				clearTimeout(pending.timer);
				swPending.delete(id);
				if (pending.recording && pending.port === port) {
					pending.reject(Object.assign(new Error("Recording native connection lost"), { code: "RECORD_INTERRUPTED" }));
				} else {
					pending.reject(new Error("Native host disconnected"));
				}
			}
			invalidateBindingHealth("HOST_DISCONNECTED").catch(console.warn);
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
		refreshBindingHealth().catch(console.warn);
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
	if (typeof msg.id === "string" && msg.id.startsWith("sw-")) {
		const pending = swPending.get(msg.id);
		if (pending && (!pending.port || pending.port === port)) {
			clearTimeout(pending.timer);
			swPending.delete(msg.id);
			if (msg.ok === false || msg.error) {
				pending.reject(
					Object.assign(new Error(msg.error?.message || msg.error || "Host error"), {
						code: msg.error?.code,
					}),
				);
			} else {
				pending.resolve(msg.result === undefined ? msg : msg.result);
			}
		}
		return;
	}
	if (msg.jsonrpc !== "2.0") return;
	if (msg.method === "relay.delivery_status" || msg.method === "relay.incoming_reply") {
		await routesReady;
		if (msg.method === "relay.delivery_status" && !eventRoutes.has(msg.params?.event_id)) {
			if (earlyRelayEvents.size >= 100)
				earlyRelayEvents.delete(earlyRelayEvents.keys().next().value);
			earlyRelayEvents.set(msg.params?.event_id, msg.params);
			return;
		}
		await forwardRelayEvent(msg.params || {}).catch((e) =>
			console.warn("[ap-browser] relay notification:", e),
		);
		return;
	}
	if (!("id" in msg)) return;

	const id = msg.id;
	const method = msg.method;
	const params = msg.params || {};
	// All record.* calls bypass generic targeting, locks, favicon writes and 3s restore.
	// Status/artifact/wrong-direction calls are rejected here if the host misroutes them.
	if (typeof method === "string" && method.startsWith("record.")) {
		try {
			if (nativePort !== port) throw Object.assign(new Error("Stale recording connection"), { code: "RECORD_INTERRUPTED" });
			const data = method === "record.capabilities" ? recordingCapabilities(msg.params === undefined ? {} : msg.params) : await recordingForPort(port).dispatch(method, params);
			postToNative(port, { jsonrpc: "2.0", id, result: { ok: true, data } });
		} catch (e) {
			postToNative(port, { jsonrpc: "2.0", id, error: { code: e.code || "RECORD_INTERRUPTED", message: e.message || "Recording failed" } });
		}
		return;
	}
	const lockedTab = params.tab_id != null;
	const META_METHODS = new Set([
		"ping",
		"info",
		"keepalive",
		"hello",
		"session.bind",
		"session.unbind",
		"session.bindings",
		"session.reply",
	]);
	// Tab management never attaches the active tab — it must keep working even
	// when the active tab is a chrome:// or chrome-extension:// page.
	const NO_TAB_METHODS = new Set([
		"session.bind",
		"session.unbind",
		"session.bindings",
		"session.reply",
		"download.browser",
		"tabs.new",
		"tabs.list",
		"tabs.get",
		"tabs.close",
		"tabs.activate",
	]);
	const NO_RESTORE_PREFIX = "dev.";
	let operatedTab = null;
	let normalOperationTabId = null;
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
		if (operatedTab) {
			normalOperationTabId = operatedTab.id;
			normalTabUsers.set(operatedTab.id, (normalTabUsers.get(operatedTab.id) || 0) + 1);
			if (lockedTab) {
				await unlockOtherTabs(operatedTab.id);
				lockedTabs.add(operatedTab.id);
			} else {
				await unlockAllTabs();
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
				if (!recordingLeases.has(operatedTab?.id)) await swapFaviconToSparkle(operatedTab?.id);
			} catch (_) {}
			chrome.action.setIcon({ path: "icons/active-128.png" }).catch(() => {});
		}

		if (operatedTab && !META_METHODS.has(method) && !NO_TAB_METHODS.has(method)) {
			const binding = await resolveBindingsForTab(operatedTab.id, operatedTab.windowId)
				.then((pool) => pool.binding)
				.catch(() => null);
			if (bindingReady(binding))
				chrome.tabs
					.sendMessage(operatedTab.id, {
						method: "annotate.agent_activity",
						command: method,
						ts: Date.now(),
					})
					.catch(() => {});
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
		if (normalOperationTabId != null) {
			const remaining = (normalTabUsers.get(normalOperationTabId) || 1) - 1;
			if (remaining) normalTabUsers.set(normalOperationTabId, remaining);
			else normalTabUsers.delete(normalOperationTabId);
		}
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
	const activePolicies = await activeFilterPolicies(method, params, operatedTab);
	const response = await dispatchUnfiltered(method, params, operatedTab);
	if (activePolicies.length === 0 || !response?.data) return response;

	const filtered = redactResult(response.data, activePolicies);
	response.data = filtered.value;
	return attachFilterMetadata(response, filtered.metadata);
}

async function dispatchUnfiltered(method, params, operatedTab) {
	switch (method) {
		case "session.bind":
			return bindSession(params);
		case "session.unbind":
			return unbindSessions(params);
		case "session.bindings":
			return { ok: true, data: { bindings: await liveBindings() } };
		case "session.reply":
			return forwardRelayEvent(params);
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
				tabs = tabs.filter((t) => re.test(t.url || "") || re.test(t.title || ""));
			}
			let groups = [];
			try {
				const q = {};
				if (params.window_id != null) q.windowId = params.window_id;
				groups = await chrome.tabGroups.query(q);
			} catch (_) {}
			const groupMap = new Map();
			for (const g of groups) groupMap.set(`${g.windowId}:${g.id}`, g.title || null);
			if (params.group) {
				const want = params.group;
				tabs = tabs.filter((t) => {
					const title = groupMap.get(`${t.windowId}:${t.groupId}`);
					return title === want;
				});
			}
			const store = await chrome.storage.session.get(tabs.map((t) => `annotations:${t.id}`));
			const data = tabs.map((t) => {
				const o = { id: t.id, title: t.title, url: t.url };
				const anns = store[`annotations:${t.id}`];
				if (anns?.length) o.annotations = anns.length;
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
					: `(${readDomText.toString()})(document.querySelector(${JSON.stringify(selector)}))`;
			const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
				expression,
				returnByValue: true,
			});
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
						expression: await nextSnapshotExpression(),
						returnByValue: true,
					})
					.catch(() => null);
				if (evaluated) {
					try {
						annotation = JSON.parse(runtimeEvaluateValue(evaluated) || "null");
						await attachUserAnnotations(tab.id, annotation);
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
			const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
				expression: await nextSnapshotExpression(),
				returnByValue: true,
			});
			const value = runtimeEvaluateValue(evaluated);
			let data = {};
			try {
				data = JSON.parse(value || "{}");
			} catch (_) {}
			await attachUserAnnotations(tab.id, data);
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
			const query = params.ref == null ? params.selector : refSelector(params.ref);
			// Phase 1: resolve + filter guard + scrollIntoView, returning the
			// element's viewport rect (see resolveForNativeClick).
			const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
				expression: buildNativeClickResolveExpression(query, denyRules, { ref: params.ref, expect_text: params.expect_text }),
				returnByValue: true,
			});
			const interaction = runtimeEvaluateValue(evaluated);
			checkInteractionError(interaction);
			const outcome = interactionOutcome(interaction, denyRules.length > 0);
			if (outcome === "denied") {
				throw filterDeniedError(interaction.metadata);
			}
			if (outcome !== "ok") {
				if (params.ref != null) {
					throw Object.assign(
						new Error(`ref ${params.ref} not found — page changed? run state again`),
						{ code: "STALE_REF" },
					);
				}
				throw Object.assign(new Error(`selector not found: ${params.selector}`), {
					code: "SELECTOR_NO_MATCH",
				});
			}
			// Phase 2: real input events at the element center — SPA custom
			// controls (Reddit, Radix/MUI) react to pointer/mouse events that
			// el.click() never synthesizes. el.click() remains the fallback
			// when the center is covered (hitOk=false: wrapper cards,
			// overlays, zero-size elements).
			const cx = interaction.x + interaction.w / 2;
			const cy = interaction.y + interaction.h / 2;
			let method = "native-input";
			if (interaction.hitOk) {
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
				await withFocusEmulation(tab.id, chrome.debugger.sendCommand, async () => {
					for (const ev of events) {
						if (ev.type === "mousePressed") {
							const checked = runtimeEvaluateValue(await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
								expression: buildNativeClickResolveExpression(query, denyRules, { ref: params.ref, expect_text: params.expect_text, consume: true }),
								returnByValue: true,
							}));
							checkInteractionError(checked);
							if (checked?.status !== "ok" || !checked.hitOk || Math.abs(checked.x + checked.w / 2 - cx) > 2 || Math.abs(checked.y + checked.h / 2 - cy) > 2) {
								throw Object.assign(new Error("Target changed before input; run state again"), { code: "STALE_REF" });
							}
						}
						await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", ev);
					}
				});
			} else {
				const clickedExpr = await chrome.debugger.sendCommand(
					{ tabId: tab.id },
					"Runtime.evaluate",
					{
						expression: buildNativeClickResolveExpression(query, denyRules, { expect_text: params.expect_text, consume: true, js_click: true }),
						returnByValue: true,
					},
				);
				const clicked = runtimeEvaluateValue(clickedExpr);
				checkInteractionError(clicked);
				if (clicked?.status === "denied") throw filterDeniedError(clicked.metadata);
				if (clicked?.status !== "ok") {
					throw Object.assign(new Error(`selector not found: ${params.selector}`), {
						code: "SELECTOR_NO_MATCH",
					});
				}
				method = "js-click";
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
			const query = params.ref == null ? params.selector : refSelector(params.ref);
			// Phase 1: resolve + filter guard + scrollIntoView + focus + select
			// existing content (see resolveForNativeFill).
			const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
				expression: buildNativeFillResolveExpression(query, denyRules, { ref: params.ref, consume: true }),
				returnByValue: true,
			});
			const interaction = runtimeEvaluateValue(evaluated);
			checkInteractionError(interaction);
			const outcome = interactionOutcome(interaction, denyRules.length > 0);
			if (outcome === "denied") {
				throw filterDeniedError(interaction.metadata);
			}
			if (outcome !== "ok") {
				if (params.ref != null) {
					throw Object.assign(
						new Error(`ref ${params.ref} not found — page changed? run state again`),
						{ code: "STALE_REF" },
					);
				}
				throw Object.assign(new Error(`selector not found: ${params.selector}`), {
					code: "SELECTOR_NO_MATCH",
				});
			}
			// Phase 2: real keystrokes — Backspace clears the selection, then
			// insertText types the value. Works for <input>/<textarea> AND
			// contenteditable (Reddit comment boxes, rich editors), which
			// el.value assignment can't touch.
			await withFocusEmulation(tab.id, chrome.debugger.sendCommand, async () => {
				await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
					type: "keyDown",
					key: "Backspace",
					code: "Backspace",
					windowsVirtualKeyCode: 8,
				});
				await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
					type: "keyUp",
					key: "Backspace",
					code: "Backspace",
					windowsVirtualKeyCode: 8,
				});
				await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", {
					text: params.value,
				});
			});
			// Phase 3: read back what landed — React controlled inputs and
			// masked fields can silently eat characters (opencli rule).
			const verify = await chrome.debugger
				.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
					expression: `(${readInteractionValue.toString()})(document, ${JSON.stringify(query)})`,
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
			const query = params.ref == null ? params.selector : refSelector(params.ref);
			const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
				expression: buildNativeSelectExpression(query, denyRules, params.option, { ref: params.ref, consume: true }),
				returnByValue: true,
			});
			const interaction = runtimeEvaluateValue(evaluated);
			checkInteractionError(interaction);
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
					new Error("target is not a <select> — custom dropdowns need click/eval"),
					{ code: "NOT_A_SELECT" },
				);
			}
			if (status !== "ok") {
				if (params.ref != null) {
					throw Object.assign(
						new Error(`ref ${params.ref} not found — page changed? run state again`),
						{ code: "STALE_REF" },
					);
				}
				throw Object.assign(new Error(`selector not found: ${params.selector}`), {
					code: "SELECTOR_NO_MATCH",
				});
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
			const { label } = await ensureInstanceId();
			return {
				ok: true,
				data: {
					id: tab.id,
					url: tab.url,
					title: tab.title,
					window_id: tab.windowId,
					// Which Chrome profile actually owns this new tab — makes
					// wrong-profile opens visible the moment they happen.
					profile: label || null,
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
			const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
				expression,
				returnByValue: true,
			});
			const value = runtimeEvaluateValue(evaluated);
			const filteredRead =
				dropRules.length > 0
					? value || { value: "", metadata: null }
					: { value: value || "", metadata: null };
			const response = await truncateOutput(filteredRead.value || "", params, tab, "html");
			return attachFilterMetadata(response, filteredRead.metadata);
		}

		case "press": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			const keyInput = params.keys || params.key || "";
			// CDP input events don't route to background tabs; focus emulation
			// makes the page accept them without stealing focus.
			await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setFocusEmulationEnabled", {
				enabled: true,
			});
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
					await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
						type: "keyDown",
						code: k.code,
						key: k.key,
						windowsVirtualKeyCode: k.vk,
						text: k.text || undefined,
					});
					await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
						type: "keyUp",
						code: k.code,
						key: k.key,
						windowsVirtualKeyCode: k.vk,
					});
				} else if (keyInput.includes("+")) {
					const parts = keyInput.split("+").map((s) => s.trim());
					const mainKey = parts[parts.length - 1];
					const modifiers = parts.slice(0, -1);
					const mainVK =
						mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : MODIFIER_VK[mainKey] || 0;

					const modParams = {};
					for (const m of modifiers) {
						if (m === "Control") modParams.controlKey = true;
						else if (m === "Shift") modParams.shiftKey = true;
						else if (m === "Alt") modParams.altKey = true;
						else if (m === "Meta") modParams.metaKey = true;
					}

					await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
						type: "keyDown",
						code: "Key" + mainKey.toUpperCase()[0],
						key: mainKey,
						windowsVirtualKeyCode: mainVK,
						...modParams,
					});
					await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
						type: "keyUp",
						code: "Key" + mainKey.toUpperCase()[0],
						key: mainKey,
						windowsVirtualKeyCode: mainVK,
						...modParams,
					});
				} else if (keyInput.length === 1) {
					await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
						type: "keyDown",
						key: keyInput,
						text: keyInput,
					});
					await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
						type: "keyUp",
						key: keyInput,
					});
				} else {
					await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.insertText", {
						text: keyInput,
					});
				}
			} finally {
				await chrome.debugger
					.sendCommand({ tabId: tab.id }, "Emulation.setFocusEmulationEnabled", { enabled: false })
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
				data = await waitForUrlChange(tab.id, params.url_change_from, timeout, chrome.tabs);
			} else if (params.media_ended) {
				await ensureDebugger(tab.id);
				const evaluate = async (expression) =>
					runtimeEvaluateValue(
						await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
							expression,
							returnByValue: true,
							awaitPromise: true,
						}),
					);
				data = await waitForMediaEnd(tab, params.selector || "video", timeout, evaluate, () =>
					chrome.tabs.get(tab.id),
				);
			} else if (params.until_eval != null || params.eval != null || params.gone != null) {
				await ensureDebugger(tab.id);
				const evaluate = async (expression) =>
					runtimeEvaluateValue(
						await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
							expression,
							returnByValue: true,
							awaitPromise: true,
						}),
					);
				data = await waitForCondition(tab, params, timeout, evaluate, () =>
					chrome.tabs.get(tab.id),
				);
			} else if (params.xhr) {
				// Match an XHR/fetch by URL substring. First check resource timing
				// history (covers requests that already completed, e.g. a click in
				// an earlier batch step), then watch Network events for new ones.
				await ensureDebugger(tab.id);
				const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
					expression: `performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes(${JSON.stringify(params.xhr)}))`,
					returnByValue: true,
				});
				const hits = runtimeEvaluateValue(evaluated);
				if (Array.isArray(hits) && hits.length > 0) {
					data = {
						matched: true,
						completed: true,
						reason: "history_hit",
						url: hits[0],
						waited_ms: 0,
						source: "history",
					};
				} else {
					await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable");
					data = await waitForXhr(tab.id, params.xhr, timeout);
				}
			} else {
				const query = params.ref == null ? params.selector : refSelector(params.ref);
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
						data = {
							matched: true,
							completed: true,
							reason: "selector_matched",
							waited_ms: Date.now() - start,
						};
						break;
					}
					await new Promise((r) => setTimeout(r, 200));
				}
				if (!data) {
					data = {
						matched: false,
						completed: false,
						reason: "deadline_reached",
						waited_ms: Date.now() - start,
						target: query,
					};
				}
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
			// --detect probe: snapshot before scrolling and after each window,
			// classify the list (finite / append-infinite / virtual-infinite)
			// so the agent knows how to extract. Needs ≥2 windows.
			const probe = params.probe === true;
			const windows = probe ? Math.max(count, 2) : count;
			const scrolled = [];
			const snapshots = [];
			const takeSnapshot = async () => {
				const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
					expression: listSnapshotExpression(),
					returnByValue: true,
				});
				return safeJsonParse(runtimeEvaluateValue(evaluated)) || null;
			};
			if (probe) snapshots.push(await takeSnapshot());
			for (let i = 0; i < windows; i++) {
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
					const before = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
						expression: "JSON.stringify({y: window.scrollY, h: document.body.scrollHeight})",
						returnByValue: true,
					});
					const beforeState = safeJsonParse(runtimeEvaluateValue(before));
					await withFocusEmulation(tab.id, chrome.debugger.sendCommand, () =>
						chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
							type: "mouseWheel",
							x: 400,
							y: 300,
							deltaX: 0,
							deltaY: 5000,
						}),
					);
					await new Promise((r) => setTimeout(r, 100));
					const after = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
						expression: "JSON.stringify({y: window.scrollY, h: document.body.scrollHeight})",
						returnByValue: true,
					});
					const afterState = safeJsonParse(runtimeEvaluateValue(after));
					moved = afterState.y > beforeState.y || afterState.h > beforeState.h;
				}
				scrolled.push(moved);
				if (probe) snapshots.push(await takeSnapshot());
				await new Promise((r) => setTimeout(r, pauseMs));
			}
			const data = { scrolled_count: windows, scrolled };
			if (probe) {
				data.list_behavior = classifyListBehavior(snapshots);
				data.snapshots = snapshots;
			}
			return {
				ok: true,
				data,
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
				throw Object.assign(new Error(exceptionDetails.text || "JS exception"), {
					code: "JS_EXCEPTION",
				});
			}
			return {
				ok: true,
				data: { result: result?.value },
				meta: await buildMeta({ window_id: tab.windowId, tab_id: tab.id }),
			};
		}

		case "batch": {
			const steps = params.steps || [];
			let autoCreatedTabId = null;
			const shouldKeepTab = params._auto_tab?.keep_tab === true;
			let domainCandidateWarning = null;
			let existingCandidates = [];

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
					try {
						const allTabs = await chrome.tabs.query({});
						const matchingTabs = allTabs.filter((t) => t.url && safeHostOf(t.url) === want);
						if (matchingTabs.length >= 3) {
							existingCandidates = matchingTabs.map((t) => ({
								tab_id: t.id,
								title: t.title || null,
								url: t.url,
							}));
							domainCandidateWarning = `${matchingTabs.length} tabs matching '${params._auto_tab.domain}' already open.`;
						}
					} catch (_) {}

					const created = await chrome.tabs.create({
						url: `https://${params._auto_tab.domain}`,
						active: false,
					});
					autoCreatedTabId = created.id;
					// Wait for the fresh tab to finish loading before executing
					// batch steps — otherwise adapters scrape about:blank/bootstrapping DOM.
					await new Promise((resolve) => {
						if (created.status === "complete") return resolve();
						let timer;
						const listener = (tabId, info) => {
							if (tabId === created.id && info.status === "complete") {
								chrome.tabs.onUpdated.removeListener(listener);
								clearTimeout(timer);
								resolve();
							}
						};
						chrome.tabs.onUpdated.addListener(listener);
						timer = setTimeout(() => {
							chrome.tabs.onUpdated.removeListener(listener);
							resolve();
						}, 8000); // fallback timeout
					});
					operatedTab = created;
					params.tab_id = created.id;
				}
			}
			try {
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
					const stepMethod = METHOD_ALIASES[step.method || step.cmd] || step.method || step.cmd;
					var stepParams = buildBatchStepParams(step, params.tab_id);
					if (Array.isArray(params._filters)) stepParams._filters = params._filters;
					try {
						const isMeta = stepMethod === "ping" || stepMethod === "info";
						if (!isMeta) {
							lastTab = null;
							lastTab = await resolveBatchStepTab(stepMethod, stepParams, resolveTab);
							if (lastTab) {
								cancelPendingRestore(lastTab.id);
								await ensureDebugger(lastTab.id);
								try {
									await swapFaviconToSparkle(lastTab.id);
								} catch (_) {}
							}
						}
						const r = await dispatch(stepMethod, stepParams, lastTab || operatedTab);
						const stepResult = { ok: true, data: r.data };
						if (r.meta?.filters) {
							stepResult.meta = { filters: r.meta.filters };
							batchFilterMetadata = mergeFilterMetadata(batchFilterMetadata, r.meta.filters);
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
							batchFilterMetadata = mergeFilterMetadata(batchFilterMetadata, e.filterMeta);
						}
						results.push(stepResult);
						if (params.stop_on_error !== false) break;
					}
				}
				const meta = lastTab
					? await buildMeta({ window_id: lastTab.windowId, tab_id: lastTab.id })
					: await buildMeta(null);

				if (autoCreatedTabId != null && shouldKeepTab) {
					meta.tab_id = autoCreatedTabId;
					meta.session_persisted = true;
					meta.hint = `Tab ${autoCreatedTabId} kept open for session continuity. Pass '--tab ${autoCreatedTabId}' to subsequent commands.`;
				}
				if (domainCandidateWarning) {
					meta.warning = domainCandidateWarning;
					meta.existing_candidates = existingCandidates;
					meta.hint = meta.hint
						? `${meta.hint} | Existing tabs found: reuse with '--tab <id>' or clean up with 'tabs close <id>'.`
						: `Multiple tabs for '${params._auto_tab?.domain}' found. Reuse with '--tab <id>' or clean up with 'tabs close <id>'.`;
				}

				return attachFilterMetadata({ ok: true, data: { results }, meta }, batchFilterMetadata);
			} finally {
				if (autoCreatedTabId != null && !shouldKeepTab) {
					await cleanupAutoCreatedTab(autoCreatedTabId, releaseTab, (id) => chrome.tabs.remove(id));
				}
			}
		}

		case "dev.console.list": {
			const tab = await resolveTab(params);
			await ensureDebugger(tab.id);
			let msgs = consoleBuffers.get(tab.id) || [];
			if (params.type) msgs = msgs.filter((m) => m.type === params.type);
			if (params.since) {
				const sinceMs = typeof params.since === "number" ? params.since : Date.parse(params.since);
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
				throw Object.assign(new Error(`no network request with id ${params.request_id}`), {
					code: "NOT_FOUND",
				});
			}
			let body = null;
			try {
				const r = await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.getResponseBody", {
					requestId: params.request_id,
				});
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
				throw Object.assign(new Error("dev.cookies.set requires url + name + value"), {
					code: "BAD_PARAMS",
				});
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
			if (params.expirationDate != null) details.expirationDate = params.expirationDate;
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
				throw Object.assign(new Error("dev.cookies.delete requires url + name"), {
					code: "BAD_PARAMS",
				});
			const result = await chrome.cookies.remove({ url, name });
			return { ok: true, data: { deleted: !!result, url, name } };
		}

		case "dev.annotate": {
			// Inject the annotation picker into a specific tab (same code path
			// as the keyboard shortcut, but targetable — used by `ap-browser
			// dev annotate` for testing and for driving silent tabs).
			const tab = await resolveTab(params);
			const url = tab.url || "";
			if (/^(chrome|chrome-extension|edge|about|devtools):/.test(url)) {
				throw Object.assign(new Error(`cannot annotate ${url.split(":")[0]}:// pages`), {
					code: "INTERNAL",
				});
			}
			await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				files: ["annotate-ui.js"],
			});
			return { ok: true, data: { injected: tab.id } };
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
				throw Object.assign(new Error("cannot disable self; use reload instead"), {
					code: "BAD_PARAMS",
				});
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
				throw Object.assign(new Error("cannot uninstall self; use chrome://extensions UI"), {
					code: "BAD_PARAMS",
				});
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
			const { data } = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.printToPDF", {
				landscape,
				paperFormat,
				printBackground: true,
			});
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
		return !Array.isArray(methods) || methods.length === 0 || methods.includes(method);
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
	return Object.assign(new Error(`interaction denied by site filter${suffix}`), {
		code: "FILTER_DENIED",
		filterMeta: metadata,
	});
}

// ─── user annotations (annotation mode) ───────────────────────────────────
// Attach the user's checked refs (annotate-ui.js panel) to a snapshot:
// `annotated` array for the agent + `user: true` on matching elements so
// screenshot --annotate renders them green (cli/src/annotate.rs).
async function attachUserAnnotations(tabId, data) {
	if (!data || typeof data !== "object") return data;
	const k = `annotations:${tabId}`;
	const stored = (await chrome.storage.session.get(k))[k];
	if (!Array.isArray(stored) || stored.length === 0) return data;
	// UI refs are lazy and need not equal the snapshot's freshly enumerated refs.
	// Resolve identity in the page, not by comparing unrelated stored numbers.
	const evaluated = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
		expression: `(() => {
			const stored = ${JSON.stringify(stored)};
			const snapshot = new Map(${JSON.stringify(data.elements || [])}.map(item => [item.ref, item]));
			const liveRefs = new Map();
			let n = 0;
			for (const el of document.querySelectorAll(${JSON.stringify(STATE_ELEMENT_SELECTOR)})) {
				if (n >= ${STATE_MAX_REFS}) break;
				if (el.getAttribute('tabindex') === '-1' || el.getAttribute('role') === 'presentation') continue;
				const r = el.getBoundingClientRect();
				if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
				const match = snapshot.get(n);
				// Do not match a different element if layout changed between evaluations.
				if (match && match.x === Math.round(r.x) && match.y === Math.round(r.y) && match.w === Math.round(r.width) && match.h === Math.round(r.height)) liveRefs.set(el, n);
				n++;
			}
			const elementFor = a => {
				let root = document;
				for (const selector of a.shadow_hosts || []) {
					root = root.querySelector(selector)?.shadowRoot;
					if (!root) return null;
				}
				return a.selector ? root.querySelector(a.selector) : a.ref != null ? root.querySelector('[data-ap-ref="' + Number(a.ref) + '"]') : null;
			};
			const boundaryNode = boundary => {
				let target = elementFor(boundary);
				for (const index of boundary.path) target = target?.childNodes[index];
				return target;
			};
			return JSON.stringify(stored.map(a => {
				try {
					if (a.selection) {
						const { start, end, quote } = a.selection;
						const first = boundaryNode(start), last = boundaryNode(end);
						if (!first || !last || first.getRootNode() !== last.getRootNode()) throw new Error('Missing selection boundary');
						const range = document.createRange();
						range.setStart(first, start.offset);
						range.setEnd(last, end.offset);
						if (range.collapsed || range.toString() !== quote) throw new Error('Stale selection');
						const r = range.getBoundingClientRect();
						if (r.width <= 0 || r.height <= 0) throw new Error('Hidden selection');
						return { ...a, ref: null, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
					}
					const el = elementFor(a);
					if (el) {
						const r = el.getBoundingClientRect();
						return { ...a, ref: liveRefs.get(el) ?? null, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
					}
				} catch (_) {}
				return { ...a, ref: null, x: null, y: null };
			}));
		})()`,
		returnByValue: true,
	});
	const resolved = JSON.parse(runtimeEvaluateValue(evaluated) || "[]");
	data.annotated = resolved;
	const refs = new Set(resolved.filter((a) => a.ref != null).map((a) => a.ref));
	for (const el of data.elements || []) {
		if (refs.has(el.ref)) el.user = true;
	}
	for (const a of resolved) {
		if (a.ref == null && a.x != null && a.y != null) {
			(data.elements ||= []).push({ x: a.x, y: a.y, w: a.w, h: a.h, user: true });
		}
	}
	return data;
}

// ─── annotation mode toggle (keyboard command + popup) ───────────────────
async function toggleAnnotation() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return { ok: false, error: "no active tab" };
	const url = tab.url || "";
	if (/^(chrome|chrome-extension|edge|about|devtools):/.test(url)) {
		return {
			ok: false,
			error: `cannot annotate ${url.split(":")[0]}:// pages`,
		};
	}
	try {
		// Preserve the dock and its shortcut listener when hiding it.
		const probe = await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			func: () => !!(window.__apAnnotatePanel && document.querySelector("#ap-annotate-root")),
		});
		if (probe?.[0]?.result) {
			await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => {
					window.__apAnnotatePanel?.toggle?.();
				},
			});
			return { ok: true, toggled: false };
		}
		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			files: ["annotate-ui.js"],
		});
		return { ok: true, toggled: true };
	} catch (e) {
		return { ok: false, error: String(e?.message || e) };
	}
}

// Resolve target tab: explicit tab_id, else active tab of last focused window.
async function resolveTab(params) {
	if (params.tab_id != null) {
		const t = await chrome.tabs.get(params.tab_id);
		return t;
	}
	const win = await chrome.windows.getLastFocused();
	const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
	if (!tabs[0]) throw Object.assign(new Error("no active tab"), { code: "TAB_NOT_FOUND" });
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
	return domain
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.toLowerCase();
}

// Wait until an XHR/fetch whose URL contains `urlSubstr` completes.
function waitForXhr(tabId, urlSubstr, timeoutMs) {
	return new Promise((resolve) => {
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
			if (source.tabId !== tabId || method !== "Network.responseReceived") return;
			const url = params.response && params.response.url;
			if (url && url.includes(urlSubstr)) {
				finish(resolve, {
					matched: true,
					completed: true,
					reason: "xhr_completed",
					url,
					waited_ms: Date.now() - start,
					source: "network",
				});
			}
		};
		const timer = setTimeout(() => {
			finish(resolve, {
				matched: false,
				completed: false,
				reason: "deadline_reached",
				xhr: urlSubstr,
				waited_ms: timeoutMs,
			});
		}, timeoutMs);
		chrome.debugger.onEvent.addListener(listener);
	});
}

// Attach debugger if not already attached.
const attachedTabs = new Set();
const attachingTabs = new Map();
const recordingOnlyTabs = new Set();
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
	// An unrelated owner's stream is not our source and not ours to ACK or stop.
	if (method === "Page.screencastFrame") return;
	const tabId = source.tabId;
	if (tabId === null || tabId === undefined) return;
	const ts = Date.now();
	switch (method) {
		case "Runtime.consoleAPICalled":
			pushConsole(tabId, {
				type: params.type || "log",
				text: (params.args || []).map((a) => a.value ?? a.description ?? "").join(" "),
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
				duration_ms: params.timestamp ? Math.round(params.timestamp * 1000) : null,
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

async function ensureDebugger(tabId, recordingOnly = false) {
	await ensureAttachedOnce(tabId, { attachedTabs, attachingTabs }, async () => {
		try {
			await chrome.debugger.attach({ tabId }, "1.3");
			recordingGuard.attached(tabId, true);
		} catch (e) {
			if (e.message?.includes("Another debugger")) {
				throw Object.assign(new Error(`debugger rejected for tab ${tabId}`), {
					code: "DEBUGGER_ATTACH_FAILED",
				});
			}
			if (!e.message?.includes("Already attached")) {
				throw e;
			}
			// Worker restart / unknown pre-attachment: readonly viewport facts cannot certify it.
			recordingGuard.attached(tabId, false);
		}
		await Promise.allSettled(
			(recordingOnly ? ["Page.enable"] : ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]).map((method) =>
				chrome.debugger.sendCommand({ tabId }, method),
			),
		);
		if (recordingOnly) recordingOnlyTabs.add(tabId);
	});
	if (!recordingOnly && recordingOnlyTabs.has(tabId)) {
		recordingOnlyTabs.delete(tabId);
		await Promise.allSettled(["Runtime.enable", "Log.enable", "Network.enable"].map((method) => chrome.debugger.sendCommand({ tabId }, method)));
	}
}

function clearTabState(tabId) {
	recordingGuard.detached(tabId);
	recordingOnlyTabs.delete(tabId);
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
	if (source.tabId != null) {
		recordingController?.interrupt("debugger_detached", source.tabId);
		clearTabState(source.tabId);
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	recordingController?.interrupt("tab_closed", tabId);
	clearTabState(tabId);
	removeClosedBindings(tabId, null).catch(() => {});
});
chrome.windows.onRemoved.addListener((windowId) =>
	removeClosedBindings(null, windowId).catch(() => {}),
);
chrome.tabs.onActivated?.addListener(({ tabId, windowId }) => {
	(async () => {
		const bindings = bindingsForTab(await storedBindings(), tabId, windowId);
		if (!bindings.length) return;
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (tab) await injectBoundDock(tab).catch(() => {});
	})();
});
chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
	if (changeInfo?.status !== "complete") return;
	(async () => {
		const bindings = bindingsForTab(await storedBindings(), tabId, tab?.windowId);
		if (!bindings.length) return;
		await injectBoundDock(tab || (await chrome.tabs.get(tabId).catch(() => null))).catch(() => {});
	})();
});

function acquireRecordingLease(tabId) {
	const token = Symbol("recording lease");
	const wasAttached = attachedTabs.has(tabId);
	let cancelled = false, access = null;
	recordingLeases.set(tabId, token);
	const cleanup = async () => {
		if (recordingLeases.has(tabId)) return { capture_shutdown: false };
		// Preserve normal command ownership; let its ordinary restore path do cleanup.
		if (lockedTabs.has(tabId) || pendingRestoreTimers.has(tabId) || normalTabUsers.has(tabId)) {
			// In-flight commands schedule their own restore when they finish. Never
			// start that timer early or detach underneath an unlocked normal command.
			if (pendingRestoreTimers.has(tabId) && !normalTabUsers.has(tabId)) scheduleRestore(tabId, 3000);
			return { capture_shutdown: false };
		}
		if (!wasAttached && recordingGuard.ownsAttachment(tabId)) return { capture_shutdown: await detachDebugger(tabId) };
		return { capture_shutdown: false };
	};
	const release = async () => {
		cancelled = true;
		if (recordingLeases.get(tabId) !== token) return { capture_shutdown: false };
		access?.release();
		recordingLeases.delete(tabId);
		return cleanup();
	};
	const ready = ensureDebugger(tabId, true).then(async () => {
		// Timeout/disconnect may precede attach/enable completion. Do not leak a
		// late attachment, and never detach a replacement lease or normal user.
		if (cancelled) { await cleanup(); throw Object.assign(new Error("Recording lease cancelled"), { code: "RECORD_INTERRUPTED" }); }
		access = recordingGuard.reserve(tabId);
		return access;
	}).catch(async (e) => { await release(); throw e; });
	return { ready, release };
}

async function detachDebugger(tabId) {
	if (recordingLeases.has(tabId)) return false;
	if (!attachedTabs.has(tabId)) return true;
	try {
		await chrome.debugger.detach({ tabId });
	} catch (_) { return false; }
	clearTabState(tabId);
	return true;
}

async function releaseTab(tabId) {
	lockedTabs.delete(tabId);
	if (recordingLeases.has(tabId) || normalTabUsers.has(tabId)) return;
	cancelPendingRestore(tabId);
	await settleWithin(restoreFavicon(tabId), CLEANUP_TIMEOUT_MS);
	// A recording may have acquired ownership while favicon restoration awaited CDP.
	if (recordingLeases.has(tabId)) return;
	await settleWithin(detachDebugger(tabId), CLEANUP_TIMEOUT_MS);
	if (!recordingLeases.has(tabId)) clearTabState(tabId);
}

async function unlockOtherTabs(keepTabId) {
	await Promise.all([...lockedTabs].filter((id) => id !== keepTabId).map(releaseTab));
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
	const timer = setTimeout(async () => {
		if (recordingLeases.has(tabId) || normalTabUsers.has(tabId)) return;
		pendingRestoreTimers.delete(tabId);
		if (lockedTabs.has(tabId)) {
			// Explicit --tab tasks retain the attachment until a target switch,
			// tab close or user detach. Do not toggle Chrome's debugger infobar
			// (and resize the viewport) between state/fill/click commands.
			await settleWithin(restoreFavicon(tabId), CLEANUP_TIMEOUT_MS);
			return;
		}
		await releaseTab(tabId);
	}, delayMs);
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
	refreshBindingHealth().catch(console.warn);
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
invalidateBindingHealth("WORKER_RESTARTED")
	.then(() => ensureInstanceId())
	.then(() => connectNativePort())
	.catch(console.warn);
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
	if (msg?.method === "toggle-annotate") {
		toggleAnnotation().then(sendResponse);
		return true;
	}
	if (msg?.method === "annotations.count") {
		(async () => {
			try {
				const [tab] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});
				if (!tab?.id) return sendResponse({ ok: true, count: 0 });
				const k = `annotations:${tab.id}`;
				const stored = (await chrome.storage.session.get(k))[k];
				sendResponse({
					ok: true,
					count: Array.isArray(stored) ? stored.length : 0,
				});
			} catch (e) {
				sendResponse({ ok: false, error: String(e?.message || e) });
			}
		})();
		return true;
	}
	if (msg?.method === "annotations.tab") {
		sendResponse({
			ok: true,
			tab_id: _sender.tab?.id ?? null,
			window_id: _sender.tab?.windowId ?? null,
		});
		return false;
	}
	if (msg?.method === "annotations.get") {
		(async () => {
			try {
				const k = `annotations:${msg.tab_id}`;
				const stored = (await chrome.storage.session.get(k))[k];
				sendResponse({ ok: true, refs: Array.isArray(stored) ? stored : [] });
			} catch (e) {
				sendResponse({ ok: false, error: String(e?.message || e) });
			}
		})();
		return true;
	}
	if (msg?.method === "annotations.set") {
		(async () => {
			try {
				await chrome.storage.session.set({
					[`annotations:${msg.tab_id}`]: Array.isArray(msg.refs) ? msg.refs : [],
				});
				sendResponse({ ok: true });
			} catch (e) {
				sendResponse({ ok: false, error: String(e?.message || e) });
			}
		})();
		return true;
	}
	if (
		[
			"session.get_binding",
			"session.select_binding",
			"session.bindings",
			"session.unbind",
			"relay.send",
		].includes(msg?.method)
	) {
		(async () => {
			if (msg.method === "session.get_binding") {
				const tabId = msg.tab_id ?? _sender.tab?.id;
				const windowId =
					msg.window_id ??
					_sender.tab?.windowId ??
					(tabId != null ? (await chrome.tabs.get(tabId)).windowId : null);
				return { ok: true, ...(await resolveBindingsForTab(tabId, windowId, msg.force === true)) };
			}
			if (msg.method === "session.select_binding")
				return selectBinding({
					...msg,
					tab_id: msg.tab_id ?? _sender.tab?.id,
					window_id: msg.window_id ?? _sender.tab?.windowId,
				});
			if (msg.method === "relay.send") return sendAnnotationRelay(msg, _sender);
			const params = { ...(msg.params || msg) };
			if (
				msg.method === "session.unbind" &&
				_sender.tab &&
				!params.all &&
				!params.session_id &&
				params.tab_id == null &&
				params.window_id == null
			) {
				const bindings = await storedBindings();
				const tabBinding = bindings.find((b) => b.scope === "tab" && b.tab_id === _sender.tab.id);
				if (tabBinding) params.tab_id = _sender.tab.id;
				else params.window_id = _sender.tab.windowId;
			}
			return dispatchUnfiltered(msg.method, params, null);
		})()
			.then(sendResponse)
			.catch((e) =>
				sendResponse({ ok: false, code: e.code || "RELAY_FAILED", error: e.message || String(e) }),
			);
		return true;
	}
	if (msg?.method === "profile.set_label") {
		(async () => {
			try {
				const label = String(msg.label || "")
					.trim()
					.slice(0, 32);
				labelCache = label;
				await chrome.storage.local.set({ label });
				sendResponse({ ok: true, label });
			} catch (e) {
				sendResponse({ ok: false, error: String(e?.message || e) });
			}
		})();
		return true;
	}
});

chrome.commands.onCommand.addListener((command) => {
	if (command === "toggle-annotate") toggleAnnotation().catch(() => {});
});

// On SW wakeup (any event), make sure we have a port.
