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
		"eval",
		"until_eval",
		"when",
		"gone",
		"interval_ms",
		"initial_delay_ms",
		"progress",
	]) {
		if (step[key] !== undefined) params[key] = step[key];
	}
	if (step.tab_id !== null && step.tab_id !== undefined) params.tab_id = step.tab_id;
	else if (inheritedTabId !== null && inheritedTabId !== undefined) params.tab_id = inheritedTabId;
	return params;
}

export function evaluateDoneCondition(value, when) {
	if (typeof value === "boolean") {
		return value === true;
	}
	if (when && typeof when === "object") {
		if (value == null || typeof value !== "object") return false;
		for (const [k, expected] of Object.entries(when)) {
			if (value[k] !== expected) {
				return false;
			}
		}
		return true;
	}
	if (value && typeof value === "object") {
		if ("isGenerating" in value) {
			return !value.isGenerating;
		}
		if ("isDone" in value) {
			return Boolean(value.isDone);
		}
		if ("completed" in value) {
			return Boolean(value.completed);
		}
		if ("status" in value && typeof value.status === "string") {
			const s = value.status.toLowerCase();
			return ["done", "completed", "success", "succeeded", "idle", "ready"].includes(s);
		}
		return true;
	}
	return !!value;
}

export async function waitForCondition(
	tab,
	params,
	timeoutMs,
	evaluate,
	getTab,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
	const started = Date.now();
	const interval = Math.max(params.interval_ms || 1000, 50);
	const evalExpr = params.eval || params.until_eval;
	let lastValue;

	const initialDelay = params.initial_delay_ms !== undefined ? params.initial_delay_ms : 500;
	if (initialDelay > 0) {
		await sleep(initialDelay);
	}

	while (Date.now() - started < timeoutMs) {
		if (params.gone) {
			const expr = `!document.querySelector(${JSON.stringify(params.gone)})`;
			let exists;
			try {
				exists = await evaluate(expr);
			} catch (e) {
				const current = await getTab().catch(() => null);
				if (current?.url && current.url !== tab.url) {
					return {
						matched: true,
						completed: true,
						reason: "url_changed",
						from_url: tab.url,
						url: current.url,
						waited_ms: Date.now() - started,
					};
				}
				throw e;
			}
			if (exists === true) {
				return {
					matched: true,
					completed: true,
					reason: "element_gone",
					gone: params.gone,
					waited_ms: Date.now() - started,
				};
			}
		} else if (evalExpr) {
			try {
				lastValue = await evaluate(evalExpr);
			} catch (e) {
				const current = await getTab().catch(() => null);
				if (current?.url && current.url !== tab.url) {
					return {
						matched: true,
						completed: true,
						reason: "url_changed",
						from_url: tab.url,
						url: current.url,
						waited_ms: Date.now() - started,
					};
				}
				throw e;
			}
			if (evaluateDoneCondition(lastValue, params.when)) {
				return {
					matched: true,
					completed: true,
					reason: "condition_met",
					waited_ms: Date.now() - started,
					current_status: lastValue,
					value: lastValue,
				};
			}
		}
		const remaining = timeoutMs - (Date.now() - started);
		if (remaining <= 0) break;
		await sleep(Math.min(interval, remaining));
	}

	return {
		matched: false,
		completed: false,
		reason: "deadline_reached",
		waited_ms: Date.now() - started,
		current_status: lastValue !== undefined ? lastValue : null,
		value: lastValue !== undefined ? lastValue : null,
	};
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
					completed: true,
					reason: "url_changed",
					from_url: fromUrl,
					url,
					waited_ms: Date.now() - started,
				});
			}
		};
		tabs.onUpdated.addListener(listener);
		timer = setTimeout(() => {
			finish({
				matched: false,
				completed: false,
				reason: "deadline_reached",
				from_url: fromUrl,
				waited_ms: timeoutMs,
			});
		}, timeoutMs);
		tabs.get(tabId).then(
			(tab) => listener(tabId, {}, tab),
			(error) => finish(null, error),
		);
	});
}

export async function waitForMediaEnd(tab, selector, timeoutMs, evaluate, getTab) {
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
				completed: true,
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
			completed: true,
			reason: "media_ended",
			selector,
			waited_ms: Date.now() - started,
		};
	}
	if (result?.timeout) {
		return {
			matched: false,
			completed: false,
			reason: "deadline_reached",
			selector,
			waited_ms: timeoutMs,
		};
	}
	let code = "JS_EXCEPTION";
	if (result?.missing) code = "SELECTOR_NO_MATCH";
	const message = result?.missing
		? `media not found: ${selector}`
		: `error waiting for media to end: ${selector}`;
	throw Object.assign(new Error(message), { code });
}
