// Accepted host-lifecycle review regressions. Real native host + existing controller,
// fake CDP only. Never launches a browser or accesses installed profiles/keychains.
// Build: cargo build -p ap-browser-host -p ap-browser --locked --offline
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createRecordingController } from "../../../extension/recording.mjs";
import { createRecordingTestClock } from "../../../tests/recording-test-clock.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const bin = resolve(repo, process.env.CARGO_TARGET_DIR || "target", "debug");
const exec = promisify(execFile);
const wire = JSON.parse(await readFile(join(repo, "tests/fixtures/recording/wire.json"), "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) {
	const end = Date.now() + ms;
	while (!(await fn())) { assert.ok(Date.now() < end, "bounded host seam wait expired"); await sleep(10); }
}
const encode = value => {
	const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
	header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
};
async function rpc(path, method, params) {
	const socket = createConnection(path);
	try {
		return await new Promise((resolve, reject) => {
			let bytes = Buffer.alloc(0);
			socket.setTimeout(35000, () => reject(new Error("bounded fixture RPC timeout")));
			socket.on("error", reject); socket.on("end", () => reject(new Error("unexpected host EOF")));
			socket.on("connect", () => socket.write(encode({ jsonrpc: "2.0", method, params })));
			socket.on("data", b => {
				bytes = Buffer.concat([bytes, b]);
				if (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) resolve(JSON.parse(bytes.subarray(4, bytes.readUInt32LE(0) + 4)));
			});
		});
	} finally { socket.destroy(); }
}
async function fixture({ loseStart = false } = {}) {
	const root = await mkdtemp("/tmp/arfix-");
	const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
	const env = { ...process.env, HOME: home, TMPDIR: root, AP_BROWSER_INSTANCE: "repair_fixture" };
	delete env.AP_BROWSER_REMOTE;
	const host = spawn(join(bin, "ap-browser-host"), ["chrome-extension://fake-host-repair/"], { env, stdio: ["pipe", "pipe", "pipe"] });
	const socket = join(root, "ap-browser-repair_fixture.sock");
	let bytes = Buffer.alloc(0), nativeSeq = 0, failStop = false, stopGate, originalStart;
	const clock = createRecordingTestClock();
	let hostStderr = "";
	const pending = new Map(), trace = [], cdp = [], failures = [], releases = [];
	const write = value => { if (!host.stdin.destroyed) host.stdin.write(encode(value)); };
	const native = (method, params) => new Promise((resolve, reject) => {
		const id = `sw-${++nativeSeq}`; pending.set(id, { resolve, reject }); write({ id, method, params });
	});
	// A persistent normal debugger owner is deliberately retained by release.
	const owner = { normal: true, detachCalls: 0 };
	const controller = createRecordingController({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, sendNative: native,
		acquireLease: async tabId => async () => { releases.push(tabId); return { capture_shutdown: false }; },
		chrome: { tabs: { get: async id => ({ id }) }, debugger: {
			detach: async () => { owner.detachCalls++; throw new Error("must not detach normal owner"); },
			sendCommand: async (source, method) => {
				cdp.push({ source, method });
				assert.equal(source.tabId, 7, "all capture/reconciliation CDP calls stay pinned");
				if (method === "Runtime.evaluate") { clock.observeViewport(); return { result: { value: { width: 16, height: 16, visualWidth: 16, visualHeight: 16, dpr: 1, pageScale: 1, offsetX: 0, offsetY: 0, scrollX: 0, scrollY: 0 } } }; }
				if (method === "Page.startScreencast") clock.captureStarted();
				if (method === "Page.stopScreencast") { if (failStop) throw new Error("synthetic CDP rejection"); if (stopGate) await stopGate.promise; }
				return {};
			},
		} },
	});
	async function emit(t = 100) {
		const count = trace.filter(v => v.result?.accepted_seq).length; await clock.atCapture(t);
		controller.onFrame({ tabId: 7 }, "Page.screencastFrame", { sessionId: 99, data: wire.frame.params.jpeg_base64,
			metadata: { deviceWidth: 16, deviceHeight: 16, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0, timestamp: 1234 } });
		await until(() => trace.filter(v => v.result?.accepted_seq).length === count + 1);
	}
	async function route(message) {
		trace.push(message);
		if (typeof message.id === "string") {
			const wait = pending.get(message.id); assert.ok(wait, "source reply must retain its pending string ID"); pending.delete(message.id);
			if (message.ok) wait.resolve(message.result); else wait.reject(Object.assign(new Error(message.error.message), message.error));
		} else if (message.method?.startsWith("record.")) {
			try {
				const data = await (message.method === "record.start" ? clock.start(controller, message.params) : controller.dispatch(message.method, message.params));
				if (message.method === "record.start" && loseStart) {
					if (!originalStart) {
						originalStart = structuredClone(message);
						await emit(); await clock.atCapture(750);
						return; // durable frame ACK, but numeric Started response is lost
					}
					assert.deepEqual(message.params, originalStart.params, "recovery replays EXACT original augmented start");
					assert.equal(trace.filter(v => v.method === "record.start").length, 2, "one recovery replay only");
					// The old numeric reply may arrive late; it is not the recovery ID.
					write({ id: originalStart.id, result: { ok: true, data } });
				}
				write({ id: message.id, result: { ok: true, data } });
			} catch (error) { write({ id: message.id, error: { code: error.code || "FIXTURE_FAILURE", message: error.message } }); }
		} else if (message.method === "ping") write({ id: message.id, result: { ok: true, data: { pong: true } } });
	}
	host.stderr.on("data", b => { hostStderr += b; });
	host.stdout.on("data", b => {
		bytes = Buffer.concat([bytes, b]);
		while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
			const n = bytes.readUInt32LE(0), value = JSON.parse(bytes.subarray(4, n + 4)); bytes = bytes.subarray(n + 4);
			route(value).catch(e => failures.push(e));
		}
	});
	write({ method: "hello", params: { instance_id: env.AP_BROWSER_INSTANCE, extension_version: "fixture", chrome_version: "fake", open_tabs: [] } });
	await until(async () => { try { await access(socket); return true; } catch { return false; } });
	const request = { ...structuredClone(wire.start.params), operation_id: "original_start", config: { ...wire.start.params.config, max_duration_ms: 60000 } };
	return { root, env, host, socket, controller, trace, cdp, failures, owner, releases, request, emit,
		setClock: t => clock.atCapture(t), setFailStop: v => { failStop = v; },
		gateStop: () => { let release; const promise = new Promise(r => { release = r; }); stopGate = { promise, release }; return release; },
		async close() {
			if (stopGate) stopGate.release();
			controller.interrupt("native_disconnected");
			await Promise.race([controller.idle(), sleep(300)]);
			host.stdin.end();
			try { await until(() => host.exitCode !== null || host.signalCode !== null, 1500); }
			catch { host.kill("SIGTERM"); await until(() => host.exitCode !== null || host.signalCode !== null, 1500); }
			for (const wait of pending.values()) wait.reject(new Error("owned fixture cleanup"));
			await rm(root, { recursive: true, force: true });
			assert.equal(failures.length, 0, failures.map(String).join("\n") + hostStderr);
		},
	};
}
const data = response => { assert.ok(response.result?.ok, JSON.stringify(response)); return response.result.data; };
async function terminal(f, identity) {
	let status;
	await until(async () => { status = data(await rpc(f.socket, "record.status", { identity })); return ["failed", "sealed"].includes(status.state); });
	return status;
}

test("R1 lost numeric Started after durable frame ACK recovers cached provenance and explicit partial export", { timeout: 45000 }, async t => {
	const f = await fixture({ loseStart: true });
	try {
		const initial = await rpc(f.socket, "record.start", f.request);
		assert.ok(initial.error?.code === "TIMEOUT" || initial.result?.data?.state === "failed");
		const retried = data(await rpc(f.socket, "record.start", f.request));
		const identity = retried.identity;
		const status = await terminal(f, identity);
		assert.equal(status.persisted_seq, 1); assert.equal(status.state, "failed");
		const response = await rpc(f.socket, "record.manifest", { identity });
		t.diagnostic(JSON.stringify({ persisted_seq: status.persisted_seq, startCalls: f.trace.filter(v => v.method === "record.start").length, manifestError: response.error?.code }));
		const manifest = data(response);
		assert.equal(manifest.frames.length, 1); assert.equal(manifest.tab_id, 7);
		assert.equal(manifest.end.reason, "control_error"); assert.equal(manifest.end.duration_ms, 750); assert.equal(manifest.end.duration_observed, true);
		assert.deepEqual(manifest.clock, { source: "extension_performance", origin: "before_start_screencast" });
		assert.deepEqual(manifest.resolved_region_css, { x: 0, y: 0, width: 16, height: 16 });
		assert.equal(f.trace.filter(v => v.method === "record.start").length, 2);
		assert.equal(f.cdp.filter(v => v.method === "Page.startScreencast").length, 1);
		assert.deepEqual(data(await rpc(f.socket, "record.start", f.request)).identity, identity);
		assert.deepEqual(data(await rpc(f.socket, "record.manifest", { identity })), manifest);
		const handle = `repair_fixture:${identity.host_epoch}:${identity.record_id}`;
		const out = join(f.root, "caller partial.mp4");
		await assert.rejects(exec(join(bin, "ap-browser"), ["record", "export", handle, "--out", out], { env: f.env, timeout: 15000 }));
		await exec(join(bin, "ap-browser"), ["record", "export", handle, "--partial", "--metadata", "--preset", "tiny", "--out", out], { env: f.env, timeout: 15000 });
		const metadata = JSON.parse(await readFile(join(f.root, "caller partial.metadata.json"), "utf8"));
		assert.equal(metadata.partial, true); assert.equal(metadata.duration_ms, 750); assert.equal(metadata.end_reason, "control_error");
		assert.deepEqual(JSON.parse(metadata.source_manifest_json), manifest);
		const probe = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", out], { timeout: 5000 })).stdout);
		assert.equal(probe.streams[0].codec_name, "h264"); assert.equal(probe.streams.length, 1);
	} finally { await f.close(); }
});

test("R2 explicit terminal stop reaches quarantine cleanup without mutating partial or detaching normal owner", { timeout: 15000 }, async t => {
	const f = await fixture();
	try {
		const started = data(await rpc(f.socket, "record.start", f.request)); const identity = started.identity;
		await f.emit(); await f.setClock(750); f.setFailStop(true);
		await rpc(f.socket, "record.stop", { identity, operation_id: "initial_stop" });
		const status = await terminal(f, identity); await f.controller.idle();
		assert.equal(status.end.reason, "control_error"); assert.equal(f.controller.isActive(), true);
		const manifest = data(await rpc(f.socket, "record.manifest", { identity }));
		const chunk = data(await rpc(f.socket, "record.read", { identity, offset: 0, length: 262144 }));
		assert.deepEqual(data(await rpc(f.socket, "record.stop", { identity, operation_id: "initial_stop" })), status);
		assert.equal(f.trace.filter(v => v.method === "record.stop").length, 1, "ordinary retry of initial stop stays local");
		const stale = await rpc(f.socket, "record.stop", { identity: { ...identity, host_epoch: "stale_epoch" }, operation_id: "stale" });
		assert.equal(stale.error.code, "RECORD_STALE_HOST");
		assert.deepEqual(data(await rpc(f.socket, "ping", {})), { pong: true });
		f.setFailStop(false); const releaseStop = f.gateStop();
		const result = data(await rpc(f.socket, "record.stop", { identity, operation_id: "explicit_cleanup" }));
		t.diagnostic(JSON.stringify({ stopCalls: f.trace.filter(v => v.method === "record.stop").length, terminal: result.state }));
		assert.equal(f.trace.filter(v => v.method === "record.stop").length, 2, "terminal cleanup must reach extension");
		assert.deepEqual(result, status, "acknowledgement is still original failed status, not confirmed cleanup");
		assert.equal(f.controller.isActive(), true, "asynchronous cleanup has not yet succeeded");
		assert.deepEqual(data(await rpc(f.socket, "record.stop", { identity, operation_id: "explicit_cleanup" })), status);
		assert.equal(f.trace.filter(v => v.method === "record.stop").length, 2, "same cleanup operation is not replayed");
		releaseStop(); await until(() => !f.controller.isActive());
		assert.equal(f.owner.normal, true); assert.equal(f.owner.detachCalls, 0);
		assert.deepEqual(data(await rpc(f.socket, "record.manifest", { identity })), manifest);
		assert.deepEqual(data(await rpc(f.socket, "record.read", { identity, offset: 0, length: 262144 })), chunk);
		assert.deepEqual(data(await rpc(f.socket, "record.status", { identity })), status);
		const next = data(await rpc(f.socket, "record.start", { ...f.request, operation_id: "after_cleanup" }));
		assert.notDeepEqual(next.identity, identity); assert.equal(next.state, "recording");
		assert.equal(f.cdp.filter(v => v.method === "Page.startScreencast").length, 2);
		const stoppedBefore = f.cdp.filter(v => v.method === "Page.stopScreencast").length;
		assert.deepEqual(data(await rpc(f.socket, "record.stop", { identity, operation_id: "late_old_cleanup" })), status);
		assert.equal(f.cdp.filter(v => v.method === "Page.stopScreencast").length, stoppedBefore, "old failed handle cannot stop the replacement capture");
		assert.equal(data(await rpc(f.socket, "record.status", { identity: next.identity })).state, "recording");
		assert.equal(f.owner.detachCalls, 0);
	} finally { await f.close(); }
});
