import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as filters from "./filter-enforcement.mjs";
import * as runtime from "./runtime-helpers.mjs";
import * as snapshot from "./state-snapshot.mjs";
import { createRecordingGuard } from "./recording-guard.mjs";
import { recordingCapabilities } from "./recording.mjs";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8")).replace(
	/^import\s+\{[\s\S]*?\}\s+from\s+"[^"]+";\n/gm,
	"",
);

function event() {
	return {
		listeners: [],
		addListener(fn) {
			this.listeners.push(fn);
		},
		removeListener() {},
	};
}

async function harness(t, initial = {}) {
	const session = structuredClone(initial);
	const local = { instance_id: "test-browser", label: "Test profile" };
	const tabs = [
		{ id: 12, windowId: 7, active: true, url: "https://example.com", title: "Example" },
		{ id: 13, windowId: 7, active: false, url: "https://example.org", title: "Other" },
		{ id: 22, windowId: 8, active: true, url: "chrome://settings", title: "Settings" },
	];
	const dead = new Set();
	const unknown = new Set();
	const sent = [],
		nativeCalls = [],
		scripts = [],
		debuggerCalls = [],
		responses = [];
	const timers = [];
	let writes = 0;
	let context;
	const port = {
		onMessage: event(),
		onDisconnect: event(),
		postMessage(msg) {
			if (!msg.id?.startsWith?.("sw-")) {
				responses.push(msg);
				return;
			}
			nativeCalls.push(msg);
			let result;
			if (msg.method === "relay.check_liveness")
				result = {
					state: dead.has(msg.params.pid)
						? "offline"
						: unknown.has(msg.params.pid)
							? "unknown"
							: "ready",
					checked_at: Date.now(),
					valid_until: Date.now() + 20000,
					receiver_epoch: `epoch-${msg.params.pid}`,
				};
			else if (msg.method === "relay.register_peer") result = { registered: true };
			else if (msg.method === "relay.deliver")
				result = {
					ok: true,
					result: {
						event_id: `mail-${String(nativeCalls.length).padStart(32, "0")}`,
						thread_id: msg.params.thread_id || "thread-a",
						status: "queued",
						prompt_file: "/tmp/prompt.md",
					},
				};
			else throw new Error(`Unexpected native method ${msg.method}`);
			queueMicrotask(() => context.handleNativeMessage({ id: msg.id, ok: true, result }, port));
		},
	};
	const storage = (data) => ({
		async get(keys) {
			if (keys == null) return { ...data };
			return Object.fromEntries(
				(Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]]),
			);
		},
		async set(value) {
			Object.assign(data, value);
			if (data === session) writes++;
		},
	});
	const page = { document: { querySelector: () => null }, window: {} };
	const chrome = {
		storage: { session: storage(session), local: storage(local), onChanged: event() },
		runtime: {
			connectNative: () => port,
			getManifest: () => ({ version: "test" }),
			onInstalled: event(),
			onStartup: event(),
			onMessage: event(),
		},
		tabs: {
			onRemoved: event(),
			onUpdated: event(),
			async get(id) {
				const tab = tabs.find((t) => t.id === id);
				if (!tab) throw new Error("No tab");
				return tab;
			},
			async query(q) {
				return tabs.filter(
					(t) =>
						(!q.active || t.active) &&
						(q.windowId == null || t.windowId === q.windowId) &&
						(!q.currentWindow || t.windowId === 7),
				);
			},
			async sendMessage(id, msg) {
				sent.push(structuredClone({ id, ...msg }));
			},
			async reload() {},
		},
		windows: {
			async getLastFocused() {
				return { id: 7 };
			},
			onRemoved: event(),
		},
		scripting: {
			async executeScript(details) {
				scripts.push(details);
				return [
					{
						result: details.func
							? vm.runInNewContext(`(${details.func.toString()})()`, page)
							: undefined,
					},
				];
			},
		},
		debugger: {
			onEvent: event(),
			onDetach: event(),
			async attach() {
				debuggerCalls.push("attach");
			},
			async detach() {},
			async sendCommand(_target, method) {
				debuggerCalls.push(method);
				return {};
			},
		},
		action: { onClicked: event(), async setIcon() {} },
		alarms: {
			onAlarm: event(),
			async get() {
				return {};
			},
		},
		commands: { onCommand: event() },
	};
	context = vm.createContext({
		...filters,
		...runtime,
		...snapshot,
		createRecordingGuard,
		recordingCapabilities,
		chrome,
		console,
		TextEncoder,
		btoa: (s) => Buffer.from(s, "binary").toString("base64"),
		navigator: { userAgent: "test" },
		setTimeout: (fn, ms) => {
			const id = setTimeout(fn, ms);
			timers.push(id);
			return id;
		},
		clearTimeout,
	});
	t.after(() => timers.forEach(clearTimeout));
	vm.runInContext(source, context, { filename: "background.js" });
	await new Promise(setImmediate); // finish automatic hello/connect bootstrap
	const rpc = (method, params = {}) => context.dispatchUnfiltered(method, params, null);
	const binding = (extra = {}) => ({
		inbox: "/mail/inbox/session-a",
		session_id: "session-a",
		label: "Local session",
		pid: 123,
		...extra,
	});
	const message = (msg, sender = {}) =>
		new Promise((resolve) => chrome.runtime.onMessage.listeners[0](msg, sender, resolve));
	return {
		context,
		session,
		tabs,
		dead,
		unknown,
		sent,
		nativeCalls,
		scripts,
		debuggerCalls,
		responses,
		chrome,
		page,
		rpc,
		binding,
		message,
		writes: () => writes,
	};
}

test("session RPCs work on restricted tabs without debugger attachment; scope pools retain other sessions", async (t) => {
	const h = await harness(t);
	await h.context.handleNativeMessage(
		{ jsonrpc: "2.0", id: 1, method: "session.bind", params: h.binding({ window_id: 8 }) },
		{ postMessage: (msg) => h.responses.push(msg) },
	);
	assert.equal(h.responses.at(-1).result.data.binding.scope, "window");
	assert.equal(h.scripts.length, 0);
	assert.equal(h.debuggerCalls.length, 0);
	await h.rpc("session.bind", h.binding({ window_id: 7 }));
	await h.rpc("session.bind", h.binding({ tab_id: 12, session_id: "tab-session", pid: 456 }));
	await h.rpc("session.bind", h.binding({ tab_id: 12, session_id: "replacement", pid: 789 }));
	assert.equal(h.session.session_bindings.length, 4);
	assert.equal((await h.context.resolveBindingsForTab(12, 7)).binding.session_id, "replacement");
	assert.equal((await h.context.resolveBindingsForTab(12, 7)).bindings.length, 3);
	assert.equal((await h.context.resolveBindingsForTab(13, 7)).binding.session_id, "session-a");
	await h.rpc("session.bind", h.binding({ tab_id: 12, session_id: "replacement", pid: 790 }));
	assert.equal(h.session.session_bindings.length, 4);
	assert.ok(h.scripts.some((s) => s.files?.includes("annotate-ui.js")));
	assert.ok(h.sent.some((m) => m.method === "annotate.binding_changed"));
	assert.ok(h.nativeCalls.some((m) => m.method === "relay.register_peer"));
	for (const method of ["session.bindings", "session.unbind", "session.reply"]) {
		await h.context.handleNativeMessage(
			{
				jsonrpc: "2.0",
				id: method,
				method,
				params: { tab_id: 22, event_id: "test", message: "reply" },
			},
			{ postMessage: (msg) => h.responses.push(msg) },
		);
	}
	assert.equal(h.debuggerCalls.length, 0);
});

test("offline bindings are retained without silent target promotion; cached lookup does not rewrite storage", async (t) => {
	const h = await harness(t);
	await Promise.all([
		h.rpc("session.bind", h.binding({ window_id: 7 })),
		h.rpc("session.bind", h.binding({ tab_id: 12, pid: 456 })),
	]);
	const writes = h.writes();
	await h.rpc("session.bindings");
	assert.equal(h.writes(), writes);
	h.dead.add(456);
	await h.context.refreshBindingHealth();
	assert.equal((await h.context.resolveBindingsForTab(12, 7)).binding.scope, "tab");
	assert.equal(h.session.session_bindings.length, 2);
	assert.ok(
		h.sent.some(
			(m) =>
				m.reason === "health" &&
				m.id === 12 &&
				m.binding?.health.state === "offline" &&
				m.bindings.length === 2,
		),
	);
	h.dead.add(123);
	await h.context.refreshBindingHealth();
	assert.equal((await h.rpc("session.bindings")).data.bindings.length, 2);
	await assert.rejects(h.rpc("session.bind", h.binding()), { code: "BINDING_OFFLINE" });
	assert.equal((await h.rpc("session.unbind", { all: true })).data.unbound, 2);
});

test("relay delivery records event/thread routes for CLI and unsolicited peer replies", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ window_id: 7 }));
	const result = await h.message(
		{
			method: "relay.send",
			action: "ask",
			raw_text: "context",
			user_note: "Explain",
			is_command: false,
			element: { ref: 4 },
			thread_id: "thread-a",
		},
		{ tab: h.tabs[1] },
	);
	assert.equal(result.ok, true);
	assert.equal(result.data.result.status, "queued");
	const params = h.nativeCalls.find((m) => m.method === "relay.deliver").params;
	assert.equal(params.tab_id, 13);
	assert.equal(params.window_id, 7);
	assert.equal(params.session_id, "session-a");
	assert.equal(params.instance_id, "test-browser");
	const id = result.data.result.event_id;
	await h.rpc("session.reply", { event_id: id, status: "running", message: "Working" });
	assert.equal(h.sent.at(-1).id, 13);
	assert.equal(h.sent.at(-1).status, "running");
	await h.context.handleNativeMessage(
		{
			jsonrpc: "2.0",
			method: "relay.incoming_reply",
			params: {
				event_id: "unknown",
				thread_id: "thread-a",
				message: "Done",
				from_label: "Local session",
			},
		},
		{},
	);
	assert.equal(h.sent.at(-1).id, 13);
	assert.equal(h.sent.at(-1).message, "Done");
	assert.equal(h.sent.at(-1).from_label, "Local session");
	await h.rpc("session.reply", { event_id: id, tab_id: 12, message: "Explicit override" });
	assert.equal(h.sent.at(-1).id, 12);
});

test("runtime binding lookup, unbound relay failure, scope disconnect and close cleanup", async (t) => {
	const h = await harness(t);
	const tabInfo = await h.message({ method: "annotations.tab" }, { tab: h.tabs[0] });
	assert.equal(tabInfo.window_id, 7);
	const offline = await h.message({ method: "relay.send" }, { tab: h.tabs[0] });
	assert.equal(offline.code, "BINDING_OFFLINE");
	await h.rpc("session.bind", h.binding({ window_id: 7 }));
	await h.rpc("session.bind", h.binding({ tab_id: 12 }));
	const bound = await h.message({ method: "session.get_binding" }, { tab: h.tabs[0] });
	assert.equal(bound.binding.scope, "tab");
	const removed = await h.message({
		method: "session.unbind",
		tab_id: 12,
		session_id: "session-a",
	});
	assert.equal(removed.data.unbound, 1);
	assert.equal((await h.message({ method: "session.bindings" })).data.bindings.length, 1);
	assert.ok(h.sent.some((m) => m.reason === "unbound"));
	await h.rpc("session.bind", h.binding({ tab_id: 13 }));
	await h.context.removeClosedBindings(13, null);
	assert.equal(h.session.session_bindings.length, 1);
	await h.context.removeClosedBindings(null, 7);
	assert.equal(h.session.session_bindings.length, 0);
});

test("existing annotation root toggles its panel without destroying listeners", async (t) => {
	const h = await harness(t);
	let toggled = 0,
		cleaned = 0;
	h.page.document.querySelector = () => ({});
	h.page.window.__apAnnotatePanel = {
		toggle() {
			toggled++;
		},
	};
	h.page.window.__apAnnotateCleanup = () => cleaned++;
	await h.context.toggleAnnotation();
	assert.equal(toggled, 1);
	assert.equal(cleaned, 0);
	assert.equal(h.scripts.filter((s) => s.files).length, 0);
});

test("real CLI page operations emit activity only to a bound tab", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ window_id: 7 }));
	await h.context.handleNativeMessage(
		{ jsonrpc: "2.0", id: 50, method: "reload", params: { tab_id: 12 } },
		{ postMessage: (msg) => h.responses.push(msg) },
	);
	assert.equal(h.responses.at(-1).error, undefined);
	assert.ok(
		h.sent.some(
			(m) => m.id === 12 && m.method === "annotate.agent_activity" && m.command === "reload",
		),
	);
});

test("multiple live sessions merge across scopes, select explicitly, and promote on unbind", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ window_id: 7 }));
	await h.rpc("session.bind", h.binding({ tab_id: 12, session_id: "session-b", pid: 456 }));
	await h.rpc("session.bind", h.binding({ window_id: 7, session_id: "session-c", pid: 789 }));
	let pool = await h.message({ method: "session.get_binding" }, { tab: h.tabs[0] });
	assert.equal(pool.binding.session_id, "session-c");
	assert.equal(pool.bindings.length, 3);
	assert.ok(h.sent.some((m) => m.id === 12 && m.bindings?.length === 3));
	const selected = await h.message(
		{ method: "session.select_binding", session_id: "session-a" },
		{ tab: h.tabs[0] },
	);
	assert.equal(selected.ok, true);
	assert.equal(selected.binding.session_id, "session-a");
	assert.equal(selected.bindings.filter((b) => b.active).length, 1);
	await h.rpc("session.unbind", { session_id: "session-c", window_id: 7 });
	pool = await h.context.resolveBindingsForTab(12, 7);
	assert.equal(pool.binding.session_id, "session-a"); // Removing an inactive target preserves selection.
	await h.rpc("session.unbind", { session_id: "session-a", window_id: 7 });
	pool = await h.context.resolveBindingsForTab(12, 7);
	assert.equal(pool.binding.session_id, "session-b");
	assert.equal(pool.binding.active, true);
	assert.equal(pool.bindings.length, 1);
	assert.equal(
		h.sent.filter((m) => m.id === 12 && m.reason === "unbound").at(-1).binding.session_id,
		"session-b",
	);
	h.dead.add(456);
	await h.context.refreshBindingHealth();
	pool = await h.context.resolveBindingsForTab(12, 7);
	assert.equal(pool.binding.health.state, "offline");
	assert.equal(pool.bindings.length, 1);
	assert.equal(
		(
			await h.message(
				{ method: "session.select_binding", session_id: "missing" },
				{ tab: h.tabs[0] },
			)
		).code,
		"BINDING_OFFLINE",
	);
});

test("thread and explicit-session affinity survive active switching and reject an offline owner", async (t) => {
	const h = await harness(t);
	const sender = { tab: h.tabs[0] };
	await h.rpc("session.bind", h.binding({ window_id: 7 }));
	const first = await h.message(
		{ method: "relay.send", action: "ask", raw_text: "Context", thread_id: "owned-by-a" },
		sender,
	);
	await h.rpc(
		"session.bind",
		h.binding({ window_id: 7, session_id: "session-b", pid: 456, label: "Session B" }),
	);
	await h.message({ method: "relay.send", action: "ask", thread_id: "owned-by-b" }, sender);
	assert.equal(
		h.nativeCalls.filter((m) => m.method === "relay.deliver").at(-1).params.session_id,
		"session-b",
	);
	await h.message({ method: "relay.send", action: "ask", thread_id: "owned-by-a" }, sender);
	assert.equal(
		h.nativeCalls.filter((m) => m.method === "relay.deliver").at(-1).params.session_id,
		"session-a",
	);
	await h.message(
		{ method: "relay.send", action: "ask", session_id: "session-a", thread_id: "explicit-a" },
		sender,
	);
	assert.equal(
		h.nativeCalls.filter((m) => m.method === "relay.deliver").at(-1).params.session_id,
		"session-a",
	);
	await h.rpc("session.reply", { event_id: first.data.result.event_id, message: "A replies" });
	assert.equal(h.sent.at(-1).session_id, "session-a");
	assert.equal(h.sent.at(-1).session_label, "Local session");
	const count = h.nativeCalls.filter((m) => m.method === "relay.deliver").length;
	h.dead.add(123);
	await h.context.refreshBindingHealth();
	const offline = await h.message(
		{ method: "relay.send", action: "ask", thread_id: "owned-by-a" },
		sender,
	);
	assert.equal(offline.code, "BINDING_OFFLINE");
	assert.equal(offline.binding.session_id, "session-b");
	assert.equal(offline.bindings.length, 2);
	assert.equal(h.nativeCalls.filter((m) => m.method === "relay.deliver").length, count);
	const unknown = await h.message({ method: "relay.send", session_id: "not-bound" }, sender);
	assert.equal(unknown.code, "BINDING_OFFLINE");
});

test("unverified health pauses delivery, retains selection, and recovers without replay", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ tab_id: 12 }));
	h.unknown.add(123);
	await h.context.refreshBindingHealth();
	assert.equal(h.session.session_bindings[0].health.state, "unknown");
	const res = await h.message({ method: "relay.send", action: "run" }, { tab: h.tabs[0] });
	assert.equal(res.code, "BINDING_UNVERIFIED");
	assert.equal(h.nativeCalls.filter((m) => m.method === "relay.deliver").length, 0);
	h.unknown.clear();
	await h.context.refreshBindingHealth();
	assert.equal(h.session.session_bindings[0].health.state, "ready");
	assert.equal(h.nativeCalls.filter((m) => m.method === "relay.deliver").length, 0);
});

test("receipt identity is checked and late timeout cannot overwrite execution", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ tab_id: 12 }));
	const res = await h.message({ method: "relay.send", action: "ask" }, { tab: h.tabs[0] });
	const event_id = res.data.result.event_id;
	const receipt = (epoch, status) =>
		h.context.handleNativeMessage(
			{
				jsonrpc: "2.0",
				method: "relay.delivery_status",
				params: { event_id, session_id: "session-a", receiver_epoch: epoch, status },
			},
			{},
		);
	const before = h.sent.length;
	await receipt("wrong-epoch", "accepted");
	assert.equal(h.sent.length, before);
	await receipt("epoch-123", "accepted");
	assert.equal(h.sent.at(-1).status, "accepted");
	await h.rpc("session.reply", { event_id, status: "running", message: "Working" });
	await receipt("epoch-123", "unconfirmed");
	assert.equal(h.sent.at(-1).status, "running");
	assert.ok(h.session.relay_routes.events.some(([id]) => id === event_id));
});

test("native port loss is unknown, not offline, and does not erase the binding", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ tab_id: 12 }));
	const port = h.chrome.runtime.connectNative();
	port.onDisconnect.listeners[0]();
	await new Promise(setImmediate);
	assert.equal(h.session.session_bindings.length, 1);
	assert.equal(h.session.session_bindings[0].health.state, "unknown");
	assert.equal(h.session.session_bindings[0].health.reason, "HOST_DISCONNECTED");
});

test("worker restart invalidates cached green and reconciles persisted acknowledgement deadlines", async (t) => {
	const h = await harness(t, {
		session_bindings: [
			{
				session_id: "session-a",
				pid: 123,
				inbox: "/mail/inbox/session-a",
				scope: "tab",
				tab_id: 12,
				window_id: 7,
				active: true,
				receiver_epoch: "epoch-123",
				health: { state: "ready", checked_at: Date.now(), valid_until: Date.now() + 60000 },
			},
		],
		relay_routes: {
			events: [
				[
					"old-event",
					{
						tab_id: 12,
						window_id: 7,
						session_id: "session-a",
						receiver_epoch: "epoch-123",
						thread_id: "old-thread",
						status: "queued",
						ack_deadline: Date.now() - 1,
					},
				],
			],
			threads: [],
		},
	});
	assert.ok(h.sent.some((m) => m.binding?.health?.reason === "WORKER_RESTARTED"));
	assert.equal(h.session.session_bindings[0].health.state, "ready");
	assert.ok(h.sent.some((m) => m.event_id === "old-event" && m.status === "unconfirmed"));
	await h.rpc("session.reply", {
		event_id: "old-event",
		status: "running",
		message: "Late execution evidence",
	});
	assert.equal(h.sent.at(-1).id, 12);
});

test("receiver loss between preflight and write updates binding health and preserves target", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ tab_id: 12 }));
	const port = h.chrome.runtime.connectNative();
	const post = port.postMessage;
	port.postMessage = (msg) => {
		if (msg.method !== "relay.deliver") return post(msg);
		h.dead.add(123);
		h.context.handleNativeMessage(
			{ id: msg.id, ok: false, error: { code: "BINDING_OFFLINE", message: "Receiver replaced" } },
			port,
		);
	};
	const res = await h.message({ method: "relay.send", action: "run" }, { tab: h.tabs[0] });
	assert.equal(res.code, "BINDING_OFFLINE");
	assert.equal(res.binding.session_id, "session-a");
	assert.equal(res.binding.health.state, "offline");
});

test("keepalive checks target health even without a user action", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ tab_id: 12 }));
	h.dead.add(123);
	h.chrome.alarms.onAlarm.listeners[0]({ name: "ap-keepalive" });
	await new Promise(setImmediate);
	assert.equal(h.session.session_bindings[0].health.state, "offline");
	assert.ok(h.sent.some((m) => m.reason === "health" && m.binding?.health.state === "offline"));
});

test("dead active sessions do not silently promote or retarget another peer", async (t) => {
	const h = await harness(t);
	await h.rpc("session.bind", h.binding({ window_id: 7 }));
	await h.rpc("session.bind", h.binding({ window_id: 7, session_id: "session-b", pid: 456 }));
	await h.rpc("session.bind", h.binding({ window_id: 7, session_id: "session-c", pid: 789 }));
	h.session.session_bindings.forEach((b, index) => {
		b.bound_at = index + 1;
	});
	h.session.session_bindings[0].selected_at = 100; // Historical selection is no longer active.
	h.dead.add(789);
	await h.context.refreshBindingHealth();
	const pool = await h.context.resolveBindingsForTab(12, 7);
	assert.equal(pool.binding.session_id, "session-c");
	assert.equal(pool.binding.health.state, "offline");
	assert.equal(pool.binding.active, true);
	assert.equal(pool.bindings.length, 3);
	assert.ok(
		h.sent.some(
			(m) =>
				m.id === 12 &&
				m.reason === "health" &&
				m.binding?.session_id === "session-c" &&
				m.bindings.length === 3,
		),
	);
});
