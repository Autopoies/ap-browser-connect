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
	/^import\s+\{[\s\S]*?\}\s+from\s+"[^"]+";\n/gm, "",
);
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener() {} });
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };

class Element {
	constructor(tag, text, attrs = {}) {
		this.tagName = tag.toUpperCase();
		this.textContent = text;
		this.innerText = text;
		this.attrs = { ...attrs };
		this.value = "";
		this.isConnected = true;
		this.rect = { x: 10, y: 20, width: 100, height: 30, top: 20, bottom: 50, left: 10, right: 110 };
		this.style = { display: "block", visibility: "visible", opacity: "1", cursor: "auto" };
	}
	getAttribute(name) { return this.attrs[name] ?? null; }
	setAttribute(name, value) { this.attrs[name] = value; }
	removeAttribute(name) { delete this.attrs[name]; }
	getBoundingClientRect() { return { ...this.rect }; }
	getClientRects() { return [this.rect]; }
	matches(selector) {
		if (selector.includes(",")) return selector.split(/,\s*/).some(s => this.matches(s));
		if (selector === "*") return true;
		if (selector.startsWith("#")) return this.attrs.id === selector.slice(1);
		const compound = selector.match(/^([a-z]+)(\[.*\])$/);
		if (compound) return this.matches(compound[1]) && this.matches(compound[2]);
		const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
		if (attr) return attr[2] == null ? this.attrs[attr[1]] != null : this.attrs[attr[1]] === attr[2];
		return this.tagName.toLowerCase() === selector;
	}
	closest(selector) { return this.matches(selector) ? this : null; }
	contains(node) { return this === node; }
	scrollIntoView() {}
	focus() {}
	select() {}
	querySelectorAll() { return []; }
}

async function harness() {
	const elements = [];
	const document = {
		querySelectorAll(selector) { return elements.filter(el => selector.split(/,\s*/).some(s => el.matches(s))); },
		querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
		elementFromPoint() { return elements.find(el => el.isConnected) ?? null; },
		documentElement: { scrollHeight: 900 },
	};
	const page = vm.createContext({
		document, window: { innerHeight: 800, innerWidth: 1200, scrollY: 0, scrollX: 0 },
		location: { href: "https://example.test/" }, getComputedStyle: el => el.style,
		Event: class {},
	});
	const calls = [], responses = [], timers = new Map();
	let nextTimer = 0;
	const port = { onMessage: event(), onDisconnect: event(), postMessage(msg) { responses.push(msg); } };
	const data = { instance_id: "test-instance", label: "Test" };
	const storage = {
		async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]])); },
		async set(value) { Object.assign(data, value); },
	};
	const tab = { id: 7, windowId: 1, active: true, url: "https://example.test/" };
	const control = {};
	const chrome = {
		storage: { local: storage, session: storage, onChanged: event() },
		runtime: { connectNative: () => port, getManifest: () => ({ version: "test" }), onInstalled: event(), onStartup: event(), onMessage: event() },
		tabs: { onRemoved: event(), onUpdated: event(), async get() { return tab; }, async query() { return [tab]; }, async sendMessage() {} },
		tabGroups: { async query() { return []; } },
		windows: { onRemoved: event(), async getLastFocused() { return { id: 1 }; } },
		debugger: {
			onEvent: event(), onDetach: event(), async attach() { calls.push({ method: "attach" }); },
			async detach(target) { calls.push({ method: "detach" }); for (const fn of chrome.debugger.onDetach.listeners) fn(target); },
			async sendCommand(_target, method, params) {
				calls.push({ method, params });
				if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") control.onMouseMove?.();
				if (method === "Runtime.evaluate") {
					if (control.stalled) return new Promise(() => {});
					try { return { result: { value: vm.runInContext(params.expression, page) } }; }
					catch (error) { return { exceptionDetails: { text: error.message } }; }
				}
				return {};
			},
		},
		action: { onClicked: event(), async setIcon() {} },
		alarms: { onAlarm: event(), async get() { return {}; } }, commands: { onCommand: event() },
	};
	const context = vm.createContext({
		...filters, ...runtime, ...snapshot, createRecordingGuard, recordingCapabilities,
		chrome, console, TextEncoder, btoa, navigator: { userAgent: "test" },
		setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
		clearTimeout(id) { timers.delete(id); },
	});
	vm.runInContext(source, context, { filename: "background.js" });
	await flush();
	const rpc = (method, params = {}) => context.dispatchUnfiltered(method, { tab_id: 7, ...params }, null);
	return { elements, calls, responses, control, context, port, timers, rpc };
}

test("snapshot refs are never recycled for a different node", async () => {
	const h = await harness();
	h.elements.push(new Element("button", "Export"));
	const before = await h.rpc("state.snapshot");
	const oldRef = before.data.elements[0].ref;
	h.elements.splice(0, 1, new Element("a", "Asset", { href: "/asset" }));
	await h.rpc("state.snapshot");
	await assert.rejects(h.rpc("click", { ref: oldRef }), { code: "STALE_REF" });
});

test("copied ref attributes cannot impersonate a snapshotted DOM node", async () => {
	const h = await harness();
	h.elements.push(new Element("button", "Export"));
	const state = await h.rpc("state.snapshot");
	const ref = state.data.elements[0].ref;
	h.elements[0].isConnected = false;
	h.elements.splice(0, 1, new Element("a", "Asset", { "data-ap-ref": String(ref), href: "/asset" }));
	await assert.rejects(h.rpc("click", { ref }), { code: "STALE_REF" });
});

test("reused DOM nodes with changed labels or positions fail closed", async () => {
	for (const change of [el => { el.textContent = el.innerText = "Delete"; }, el => { el.rect.y += 50; el.rect.top += 50; el.rect.bottom += 50; }]) {
		const h = await harness();
		const el = new Element("button", "Export");
		h.elements.push(el);
		const state = await h.rpc("state.snapshot");
		change(el);
		await assert.rejects(h.rpc("click", { ref: state.data.elements[0].ref }), { code: "STALE_REF" });
	}
});

test("click expected label is checked before any input", async () => {
	const h = await harness();
	h.elements.push(new Element("button", "Delete", { id: "action" }));
	await assert.rejects(h.rpc("click", { selector: "#action", expect_text: "Export" }), { code: "TEXT_MISMATCH" });
	assert.equal(h.calls.some(call => call.method === "Input.dispatchMouseEvent"), false);
});

test("fresh refs click normally, then expire after an interaction", async () => {
	const h = await harness();
	h.elements.push(new Element("button", "Export"));
	const state = await h.rpc("state.snapshot");
	const ref = state.data.elements[0].ref;
	assert.equal((await h.rpc("click", { ref, expect_text: "Export" })).ok, true);
	assert.equal(h.calls.filter(call => call.method === "Input.dispatchMouseEvent").length, 3);
	await assert.rejects(h.rpc("click", { ref }), { code: "STALE_REF" });
});

test("hover-triggered rerenders are caught before mousePressed", async () => {
	const h = await harness();
	const el = new Element("button", "Export");
	h.elements.push(el);
	const state = await h.rpc("state.snapshot");
	h.control.onMouseMove = () => { el.textContent = el.innerText = "Delete"; };
	await assert.rejects(h.rpc("click", { ref: state.data.elements[0].ref }), { code: "STALE_REF" });
	assert.equal(h.calls.some(call => call.params?.type === "mousePressed"), false);
});

test("fill invalidates other refs before a subsequent SPA click", async () => {
	const h = await harness();
	h.elements.push(new Element("input", ""), new Element("button", "Export"));
	const state = await h.rpc("state.snapshot");
	await h.rpc("fill", { ref: state.data.elements[0].ref, value: "New name" });
	await assert.rejects(h.rpc("click", { ref: state.data.elements[1].ref }), { code: "STALE_REF" });
});

test("unsupported text selectors explain the CSS/ref contract", async () => {
	const h = await harness();
	for (const selector of ["text=Export", "button:has-text('Export')"]) {
		await assert.rejects(h.rpc("click", { selector }), { code: "INVALID_SELECTOR", message: /CSS selector or a numeric state ref/ });
	}
});

test("state excludes invisible controls and includes pointer/menu controls", async () => {
	const h = await harness();
	const hidden = new Element("button", "Hidden");
	hidden.style.visibility = "hidden";
	const menu = new Element("p", "Batch Export");
	menu.style.cursor = "pointer";
	h.elements.push(hidden, menu);
	const state = await h.rpc("state.snapshot");
	assert.deepEqual(Array.from(state.data.elements, el => el.name), ["Batch Export"]);
	assert.ok(state.data.coverage, "state reports its iframe/shadow coverage");
});

test("text returns current textarea values, not initial markup", async () => {
	const h = await harness();
	const field = new Element("textarea", "", { id: "journeyPrompt" });
	field.value = "Updated prompt";
	h.elements.push(field);
	assert.equal((await h.rpc("text", { selector: "#journeyPrompt" })).data.text, "Updated prompt");
});

test("tabs.list is independent of a stalled renderer/debugger", async () => {
	const h = await harness();
	h.control.stalled = true;
	void h.context.handleNativeMessage({ jsonrpc: "2.0", id: 99, method: "tabs.list", params: { tab_id: 7 } }, h.port);
	await flush();
	assert.equal(h.responses.find(msg => msg.id === 99)?.result?.ok, true);
	assert.equal(h.calls.some(call => call.method === "attach"), false);
});

test("explicit-tab tasks retain debugger attachment between commands", async () => {
	const h = await harness();
	h.elements.push(new Element("button", "Export"));
	await h.context.handleNativeMessage({ jsonrpc: "2.0", id: 100, method: "state.snapshot", params: { tab_id: 7 } }, h.port);
	for (const [id, timer] of [...h.timers]) {
		if (timer.ms === 3000) { h.timers.delete(id); await timer.fn(); }
	}
	assert.equal(h.calls.filter(call => call.method === "detach").length, 0);
	await h.context.handleNativeMessage({ jsonrpc: "2.0", id: 101, method: "state.snapshot", params: { tab_id: 7 } }, h.port);
	assert.equal(h.calls.filter(call => call.method === "attach").length, 1);
});
