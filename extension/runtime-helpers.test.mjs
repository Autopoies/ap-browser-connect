import assert from "node:assert/strict";
import test from "node:test";

import {
  clearTabRuntimeState,
  ensureAttachedOnce,
  isCurrentPort,
  runtimeEvaluateValue,
} from "./runtime-helpers.mjs";

test("only the current native port may clear itself and reconnect", () => {
  const oldPort = {};
  const livePort = {};
  assert.equal(isCurrentPort(livePort, oldPort), false);
  assert.equal(isCurrentPort(livePort, livePort), true);
});

test("Runtime.evaluate exceptions become JS_EXCEPTION errors", () => {
  assert.throws(
    () => runtimeEvaluateValue({
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
  const gate = new Promise((resolve) => { release = resolve; });
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
  await ensureAttachedOnce(7, state, async () => { initializations += 1; });
  assert.equal(initializations, 2);
});

test("detach during debugger initialization cannot restore stale attached state", async () => {
  const state = { attachedTabs: new Set(), attachingTabs: new Map() };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
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
    pendingRestoreTimers: new Map([[7, timer], [8, {}]]),
    consoleBuffers: new Map([[7, ["log"]], [8, []]]),
    networkBuffers: new Map([[7, new Map()], [8, new Map()]]),
  };

  clearTabRuntimeState(7, state, (value) => cleared.push(value));

  assert.deepEqual(cleared, [timer]);
  for (const collection of Object.values(state)) assert.equal(collection.has(7), false);
  for (const [name, collection] of Object.entries(state)) {
    if (name !== "attachingTabs") assert.equal(collection.has(8), true);
  }
});
