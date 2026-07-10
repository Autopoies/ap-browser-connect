export function isCurrentPort(currentPort, disconnectedPort) {
  return currentPort === disconnectedPort;
}

export function runtimeEvaluateValue(response) {
  if (response?.exceptionDetails) {
    const details = response.exceptionDetails;
    const error = new Error(
      details.exception?.description || details.text || "JavaScript exception",
    );
    error.code = "JS_EXCEPTION";
    throw error;
  }
  return response?.result?.value;
}

export async function ensureAttachedOnce(tabId, state, initialize) {
  if (state.attachedTabs.has(tabId)) return;
  let pending = state.attachingTabs.get(tabId);
  if (!pending) {
    pending = (async () => {
      await initialize();
      if (state.attachingTabs.get(tabId) === pending) state.attachedTabs.add(tabId);
    })();
    state.attachingTabs.set(tabId, pending);
  }
  try {
    await pending;
  } finally {
    if (state.attachingTabs.get(tabId) === pending) {
      state.attachingTabs.delete(tabId);
    }
  }
}

export function clearTabRuntimeState(tabId, state, clearTimer = clearTimeout) {
  state.attachedTabs.delete(tabId);
  state.attachingTabs?.delete(tabId);
  state.lockedTabs.delete(tabId);
  const timer = state.pendingRestoreTimers.get(tabId);
  if (timer !== undefined) clearTimer(timer);
  state.pendingRestoreTimers.delete(tabId);
  state.consoleBuffers.delete(tabId);
  state.networkBuffers.delete(tabId);
}
