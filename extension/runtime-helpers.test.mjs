import assert from "node:assert/strict";
import test from "node:test";

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
} from "./runtime-helpers.mjs";

test("only the current native port may clear itself and reconnect", () => {
	const oldPort = {};
	const livePort = {};
	assert.equal(isCurrentPort(livePort, oldPort), false);
	assert.equal(isCurrentPort(livePort, livePort), true);
});

test("native reconnect backs off to a 30-second ceiling", () => {
	assert.equal(nextReconnectDelay(1000), 2000);
	assert.equal(nextReconnectDelay(16_000), 30_000);
	assert.equal(nextReconnectDelay(30_000), 30_000);
});

test("self-reload is deferred until its response can be sent", () => {
	let scheduled;
	const reload = () => {};
	scheduleExtensionReload(reload, (callback, delayMs) => {
		scheduled = { callback, delayMs };
	});
	assert.deepEqual(scheduled, { callback: reload, delayMs: 100 });
});

test("cleanup wait is bounded when Chrome never settles", async () => {
	let scheduled;
	const pending = settleWithin(
		new Promise(() => {}),
		500,
		(resolve, delayMs) => {
			scheduled = { resolve, delayMs };
		},
	);
	assert.equal(scheduled.delayMs, 500);
	scheduled.resolve();
	await pending;
});

test("Runtime.evaluate exceptions become JS_EXCEPTION errors", () => {
	assert.throws(
		() =>
			runtimeEvaluateValue({
				result: { value: "must not be returned" },
				exceptionDetails: {
					text: "Uncaught",
					exception: { description: "ReferenceError: missing is not defined" },
				},
			}),
		{ code: "JS_EXCEPTION", message: "ReferenceError: missing is not defined" },
	);
	assert.equal(runtimeEvaluateValue({ result: { value: "ok" } }), "ok");
});

test("debugger initialization runs once per attachment, including concurrent calls", async () => {
	const state = { attachedTabs: new Set(), attachingTabs: new Map() };
	let initializations = 0;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const initialize = async () => {
		initializations += 1;
		await gate;
	};

	const first = ensureAttachedOnce(7, state, initialize);
	const second = ensureAttachedOnce(7, state, initialize);
	release();
	await Promise.all([first, second]);
	await ensureAttachedOnce(7, state, initialize);
	assert.equal(initializations, 1);

	state.attachedTabs.delete(7);
	await ensureAttachedOnce(7, state, async () => {
		initializations += 1;
	});
	assert.equal(initializations, 2);
});

test("detach during debugger initialization cannot restore stale attached state", async () => {
	const state = { attachedTabs: new Set(), attachingTabs: new Map() };
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const pending = ensureAttachedOnce(7, state, () => gate);
	state.attachingTabs.delete(7);
	release();
	await pending;
	assert.equal(state.attachedTabs.has(7), false);
});

test("tab cleanup removes attachment, lock, timer, and dev buffers", () => {
	const timer = {};
	const cleared = [];
	const state = {
		attachedTabs: new Set([7, 8]),
		attachingTabs: new Map(),
		lockedTabs: new Set([7, 8]),
		pendingRestoreTimers: new Map([
			[7, timer],
			[8, {}],
		]),
		consoleBuffers: new Map([
			[7, ["log"]],
			[8, []],
		]),
		networkBuffers: new Map([
			[7, new Map()],
			[8, new Map()],
		]),
	};

	clearTabRuntimeState(7, state, (value) => cleared.push(value));

	assert.deepEqual(cleared, [timer]);
	for (const collection of Object.values(state))
		assert.equal(collection.has(7), false);
	for (const [name, collection] of Object.entries(state)) {
		if (name !== "attachingTabs") assert.equal(collection.has(8), true);
	}
});

test("batch forwards flattened event-wait parameters", () => {
	assert.deepEqual(
		buildBatchStepParams(
			{
				method: "wait",
				selector: "video",
				timeout_ms: 180_000,
				url_change_from: "https://old.example/",
				media_ended: true,
			},
			7,
		),
		{
			selector: "video",
			timeout_ms: 180_000,
			url_change_from: "https://old.example/",
			media_ended: true,
			tab_id: 7,
		},
	);
});

test("URL-change wait uses the tab event instead of polling", async () => {
	let listener;
	const tabs = {
		get: async () => ({ url: "https://old.example/" }),
		onUpdated: {
			addListener(fn) {
				listener = fn;
			},
			removeListener(fn) {
				if (listener === fn) listener = undefined;
			},
		},
	};

	const pending = waitForUrlChange(7, "https://old.example/", 100, tabs);
	listener(7, { url: "https://new.example/" }, { url: "https://new.example/" });
	const result = await pending;

	assert.equal(result.reason, "url_changed");
	assert.equal(result.url, "https://new.example/");
	assert.equal(listener, undefined);
});

test("media wait treats navigation during playback as success", async () => {
	const tab = { id: 7, url: "https://old.example/lesson" };
	const result = await waitForMediaEnd(
		tab,
		"video",
		100,
		async () => {
			throw new Error("Execution context was destroyed");
		},
		async () => ({ url: "https://new.example/lesson" }),
	);

	assert.equal(result.reason, "url_changed");
	assert.equal(result.url, "https://new.example/lesson");
});

test("media wait is one event-driven evaluation", async () => {
	let calls = 0;
	const result = await waitForMediaEnd(
		{ id: 7, url: "https://example.test/lesson" },
		"video.lesson",
		100,
		async (expression) => {
			calls += 1;
			assert.match(expression, /addEventListener\(['"]ended/);
			assert.match(expression, /video\.lesson/);
			return { ended: true };
		},
		async () => ({ url: "https://example.test/lesson" }),
	);

	assert.equal(calls, 1);
	assert.equal(result.reason, "media_ended");
});

test("media wait fails closed without an ended result", async () => {
	await assert.rejects(
		waitForMediaEnd(
			{ id: 7, url: "https://example.test/lesson" },
			"video",
			100,
			async () => undefined,
			async () => ({ url: "https://example.test/lesson" }),
		),
		{ code: "JS_EXCEPTION" },
	);
});
