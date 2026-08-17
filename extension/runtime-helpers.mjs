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
		"require_started",
		"gone",
		"interval_ms",
		"initial_delay_ms",
		"progress",
		"probe",
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

// Active-generation evidence for require_started: any status object field that
// says work is in flight right now. Keeps the latch generic across adapters.
function activityEvidence(value) {
	if (!value || typeof value !== "object") return false;
	if (
		value.isGenerating === true ||
		value.isThinking === true ||
		value.isSearching === true ||
		value.stopBtnFound === true
	)
		return true;
	return value.currentActivity !== null && value.currentActivity !== undefined;
}

// Completion evidence for require_started when no poll caught the busy phase:
// the response grew since the first poll (fast answer finished between polls).
function growthEvidence(value, baseline) {
	if (!value || typeof value !== "object" || !baseline) return false;
	if (
		typeof value.lastResponseLength === "number" &&
		value.lastResponseLength > baseline.lastResponseLength
	)
		return true;
	if (typeof value.markdownCount === "number" && value.markdownCount > baseline.markdownCount)
		return true;
	return false;
}

function snapshotGrowth(value) {
	if (!value || typeof value !== "object") return null;
	return {
		lastResponseLength:
			typeof value.lastResponseLength === "number" ? value.lastResponseLength : -1,
		markdownCount: typeof value.markdownCount === "number" ? value.markdownCount : -1,
	};
}

// Scroll-probe classification: snapshots taken before the first scroll
// window and after each window. Comparing first-half vs second-half growth
// separates the three list behaviors an agent must handle differently:
//   finite          — nothing grows: stop scrolling, extract now
//   append-infinite — nodes+chars keep growing: scroll N windows, extract once
//   virtual-infinite — chars keep growing while DOM stops (recycling):
//     extract incrementally after EACH window, or the tail is all you keep
// CHAR_EPS is a noise floor: menus/anims wiggle innerText by a few bytes.
const CHAR_EPS = 200;

export function classifyListBehavior(snapshots) {
	if (!Array.isArray(snapshots) || snapshots.length < 3) return null;
	const first = snapshots[0];
	const last = snapshots[snapshots.length - 1];
	// Per-window deltas across ALL windows, not halves: virtualization shows up
	// as grow-then-shed oscillation (mount → recycle → remount), which halves
	// average away. Measured on X: nodes 2040→6585→5074→6996→3974.
	const deltas = snapshots.slice(1).map((s, i) => ({
		nodes: s.nodes - snapshots[i].nodes,
		chars: s.chars - snapshots[i].chars,
	}));
	const anyGrowth = deltas.some((d) => d.chars > CHAR_EPS || d.nodes > 5);
	// Content REMOVED while scrolling: an append-only feed never loses DOM;
	// losing 200+ chars / 10+ nodes means items scrolled out were recycled.
	const anyShed = deltas.some((d) => d.chars < -CHAR_EPS || d.nodes < -10);
	const scrolledDown = (last.y ?? 0) > (first.y ?? 0);
	const lazy = snapshots.slice(1).some((s, i) => s.imgsLoaded - snapshots[i].imgsLoaded > 0);
	const exhausted = !anyGrowth;
	const infinite = anyGrowth && scrolledDown;
	const virtual = infinite && anyShed;
	const behavior = exhausted
		? "finite"
		: virtual
			? "virtual-infinite"
			: "append-infinite";
	const strategy =
		behavior === "finite"
			? "list exhausted — extract now; more scrolling yields nothing"
			: behavior === "virtual-infinite"
				? "virtualized list — DOM recycles items: extract after EACH scroll window and merge; a single extraction at the end only keeps the tail"
				: "infinite append — scroll N windows, then extract once";
	return {
		behavior,
		infinite,
		virtual,
		lazy,
		exhausted,
		first_window: {
			nodes: snapshots[Math.floor(snapshots.length / 2)].nodes - first.nodes,
			chars: snapshots[Math.floor(snapshots.length / 2)].chars - first.chars,
		},
		second_window: { nodes: last.nodes - snapshots[Math.floor(snapshots.length / 2)].nodes, chars: last.chars - snapshots[Math.floor(snapshots.length / 2)].chars },
		max_nodes: Math.max(...snapshots.map((s) => s.nodes)),
		strategy,
	};
}

// Serialized into Runtime.evaluate by the scroll probe. Keep self-contained.
export function listSnapshotExpression() {
	return `JSON.stringify((() => {
		const imgs = Array.from(document.querySelectorAll('img'));
		return {
			nodes: document.getElementsByTagName('*').length,
			chars: document.body.innerText.length,
			imgs: imgs.length,
			imgsLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
			y: Math.round(window.scrollY),
		};
	})())`;
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
	// require_started: an idle status only counts as done once generation was
	// actually observed (busy flag seen, or response grew since the first
	// poll). Without it, `isGenerating: false` matches in the dead window
	// after send but before the first token — a false-positive "completed".
	const requireStarted = params.require_started === true;
	let everActive = false;
	let baseline = null;
	let lastValue;

	const initialDelay = params.initial_delay_ms === undefined ? 500 : params.initial_delay_ms;
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
			if (requireStarted) {
				if (activityEvidence(lastValue)) everActive = true;
				if (baseline === null) baseline = snapshotGrowth(lastValue);
			}
			const done = evaluateDoneCondition(lastValue, params.when);
			// ponytail: require_started can miss a response that fully completes
			// before the first poll AND shows no growth fields — accept that rare
			// miss (agent falls back to `read`); baseline tracking needs send-coupling
			// we don't want.
			const startedEnough = !requireStarted || everActive || growthEvidence(lastValue, baseline);
			if (done && startedEnough) {
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
		reason: requireStarted && !everActive ? "started_not_observed" : "deadline_reached",
		waited_ms: Date.now() - started,
		current_status: lastValue === undefined ? null : lastValue,
		value: lastValue === undefined ? null : lastValue,
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
