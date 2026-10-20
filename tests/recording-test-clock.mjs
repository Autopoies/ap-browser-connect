// Test-only monotonic time. Drives actual producer preparation timers; origin is
// the screenshot invocation that resolves Started, not a screencast event.
import assert from "node:assert/strict";
export const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
export function createRecordingTestClock() {
	let time = 0, nextId = 0, origin = null, lastScreenshot = null;
	const timers = new Map(), starts = [];
	const nextTimer = () => [...timers].sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
	async function advanceTo(target) {
		assert.ok(Number.isFinite(target) && target >= time, "monotonic test time"); await flush();
		for (let n = 0; ; n++) {
			const next = nextTimer(); if (!next || next[1].at > target) break;
			assert.ok(n < 10000, "bounded timer driver"); time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
		}
		time = target; await flush();
	}
	return {
		now: () => time,
		setTimer(fn, delay) { assert.ok(Number.isFinite(delay) && delay >= 0); const id = ++nextId; timers.set(id, {fn, at:time+delay}); return id; },
		clearTimer: id => timers.delete(id),
		screenshotInvoked() { lastScreenshot = time; },
		async start(controller, params) {
			let settled = false; const began = time;
			const result = controller.dispatch("record.start", params);
			result.then(() => { origin = lastScreenshot; starts.push({began, origin}); settled = true; }, () => { settled = true; });
			await flush();
			for (let n = 0; !settled; n++) {
				assert.ok(n < 1000); const next = nextTimer(); assert.ok(next && next[1].at <= began+10000);
				await advanceTo(next[1].at);
			}
			return result;
		},
		async atCapture(t) { assert.notEqual(origin, null); await advanceTo(origin+t); },
		facts: () => ({now:time, starts:structuredClone(starts)}),
	};
}
