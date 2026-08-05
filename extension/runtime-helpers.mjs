export function isCurrentPort(currentPort, disconnectedPort) {
	return currentPort === disconnectedPort;
}

// CDP Input.* events don't route to background tabs (verified: key and mouse
// events are dropped on silent tabs). Focus emulation makes the page accept
// them without stealing real focus; always restore it afterwards.
export async function withFocusEmulation(tabId, sendCommand, fn) {
	await sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
		enabled: true,
	});
	try {
		return await fn();
	} finally {
		await sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
			enabled: false,
		}).catch(() => {});
	}
}

export function nextReconnectDelay(delayMs) {
	return Math.min(delayMs * 2, 30_000);
}

export function scheduleExtensionReload(reload, schedule = setTimeout) {
	schedule(reload, 100);
}

export function settleWithin(promise, timeoutMs, schedule = setTimeout) {
	return Promise.race([
		Promise.resolve(promise).catch(() => undefined),
		new Promise((resolve) => schedule(resolve, timeoutMs)),
	]);
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
			if (state.attachingTabs.get(tabId) === pending)
				state.attachedTabs.add(tabId);
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

export function buildBatchStepParams(step, inheritedTabId) {
	const params = { ...(step.params || {}) };
	for (const key of [
		"url",
		"selector",
		"value",
		"expression",
		"timeout_ms",
		"url_change_from",
		"media_ended",
		"ref",
		"option",
		"count",
		"pause_ms",
		"active",
	]) {
		if (step[key] !== undefined) params[key] = step[key];
	}
	if (step.tab_id !== null && step.tab_id !== undefined)
		params.tab_id = step.tab_id;
	else if (inheritedTabId !== null && inheritedTabId !== undefined)
		params.tab_id = inheritedTabId;
	return params;
}

export function waitForUrlChange(tabId, fromUrl, timeoutMs, tabs) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		let timer;
		const finish = (value, error) => {
			clearTimeout(timer);
			tabs.onUpdated.removeListener(listener);
			if (error) reject(error);
			else resolve(value);
		};
		const listener = (id, change, tab) => {
			const url = change.url || tab.url;
			if (id === tabId && url && url !== fromUrl) {
				finish({
					matched: true,
					reason: "url_changed",
					from_url: fromUrl,
					url,
					waited_ms: Date.now() - started,
				});
			}
		};
		tabs.onUpdated.addListener(listener);
		timer = setTimeout(() => {
			const error = new Error(
				`timeout waiting for URL to change from ${fromUrl}`,
			);
			error.code = "TIMEOUT";
			finish(null, error);
		}, timeoutMs);
		tabs.get(tabId).then(
			(tab) => listener(tabId, {}, tab),
			(error) => finish(null, error),
		);
	});
}

export async function waitForMediaEnd(
	tab,
	selector,
	timeoutMs,
	evaluate,
	getTab,
) {
	const started = Date.now();
	const expression = `new Promise(resolve=>{const m=document.querySelector(${JSON.stringify(selector)});if(!m)return resolve({missing:true});if(m.ended)return resolve({ended:true});let t;const done=()=>{clearTimeout(t);resolve({ended:true})};m.addEventListener('ended',done,{once:true});t=setTimeout(()=>{m.removeEventListener('ended',done);resolve({timeout:true})},${timeoutMs})})`;
	let result;
	try {
		result = await evaluate(expression);
	} catch (error) {
		const current = await getTab();
		if (current.url && current.url !== tab.url) {
			return {
				matched: true,
				reason: "url_changed",
				from_url: tab.url,
				url: current.url,
				waited_ms: Date.now() - started,
			};
		}
		throw error;
	}
	if (result?.ended) {
		return {
			matched: true,
			reason: "media_ended",
			selector,
			waited_ms: Date.now() - started,
		};
	}
	let code = "JS_EXCEPTION";
	if (result?.missing) code = "SELECTOR_NO_MATCH";
	else if (result?.timeout) code = "TIMEOUT";
	const message = result?.missing
		? `media not found: ${selector}`
		: `timeout waiting for media to end: ${selector}`;
	throw Object.assign(new Error(message), { code });
}
