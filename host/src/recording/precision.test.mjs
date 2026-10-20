// Exact-number regressions: real Rust host/bridge/CLI, existing controller and
// injected CDP only. Never launches Chrome, accesses user profiles or installs.
// Build first: cargo build --workspace --locked --offline
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, createConnection } from "node:net";
import { createRecordingController } from "../../../extension/recording.mjs";
import { createRecordingTestClock } from "../../../tests/recording-test-clock.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const bin = resolve(repo, process.env.CARGO_TARGET_DIR || "target", "debug");
const exec = promisify(execFile), sleep = ms => new Promise(r => setTimeout(r, ms));
async function preserve(name, evidence, requests) {
	if (!process.env.AP_RECORDING_PRECISION_ARTIFACTS) return;
	const parent = await realpath(process.env.AP_RECORDING_PRECISION_ARTIFACTS);
	assert.ok(parent !== repo.slice(0, -1) && !parent.startsWith(repo), "precision artifacts must stay outside repo");
	const directory = await mkdtemp(join(parent, `${name}-`));
	await writeFile(join(directory, "verification.json"), JSON.stringify(evidence, null, 2));
	if (requests) await writeFile(join(directory, "requests.jsonl"), requests.join("\n") + "\n");
	console.log(`Precision artifacts: ${directory}`);
}
const fixtureWire = JSON.parse(await readFile(join(repo, "tests/fixtures/recording/wire.json"), "utf8"));
const captured = [1106.2999999523163, 1076.1000000953675, 1000.1000000238419,
	29.700000047683716, 0.19999999999708962, 90.30000000000291];
const frame = value => {
	const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4);
	head.writeUInt32LE(body.length); return Buffer.concat([head, body]);
};
async function until(fn, ms = 5000) {
	const end = Date.now() + ms;
	while (!(await fn())) { assert.ok(Date.now() < end, "bounded precision fixture wait expired"); await sleep(10); }
}
async function stop(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	try { await until(() => child.exitCode !== null || child.signalCode !== null, 1500); }
	catch { child.kill("SIGKILL"); await until(() => child.exitCode !== null || child.signalCode !== null, 1500); }
}
async function authenticatedRpc(port, token, method, params) {
	const socket = createConnection({ host: "127.0.0.1", port });
	try {
		return await new Promise((resolve, reject) => {
			let bytes = Buffer.alloc(0), authenticated = false;
			socket.setTimeout(5000, () => reject(new Error("bounded bridge RPC timeout")));
			socket.on("error", reject); socket.on("end", () => reject(new Error("unexpected bridge EOF")));
			socket.on("connect", () => socket.write(frame({ token })));
			socket.on("data", b => {
				bytes = Buffer.concat([bytes, b]);
				while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
					const n = bytes.readUInt32LE(0), response = JSON.parse(bytes.subarray(4, n + 4)); bytes = bytes.subarray(n + 4);
					if (!authenticated) { assert.equal(response.ok, true); authenticated = true; socket.write(frame({ method, params })); }
					else resolve(response);
				}
			});
		});
	} finally { socket.destroy(); }
}
async function harness() {
	const root = await mkdtemp("/tmp/apjson-"); const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
	const env = { ...process.env, HOME: home, TMPDIR: root, AP_BROWSER_INSTANCE: "precision_fixture" }; delete env.AP_BROWSER_REMOTE;
	const host = spawn(join(bin, "ap-browser-host"), ["chrome-extension://precision-fixture/"], { env, stdio: ["pipe", "pipe", "pipe"] });
	const calls = [], replies = [], cdpInputs = [], failures = [], pending = new Map();
	let received = Buffer.alloc(0), next = 0, bridge, stderr = "";
	const clock = createRecordingTestClock();
	const write = value => host.stdin.write(frame(value));
	const native = (method, params) => new Promise((resolve, reject) => {
		const id = `sw-${++next}`;
		// This is the original JS value/text BEFORE any Rust parser sees it.
		calls.push({ id, method, params: structuredClone(params), raw: JSON.stringify(params) });
		pending.set(id, { resolve, reject }); write({ id, method, params });
	});
	const controller = createRecordingController({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
		sendNative: native, acquireLease: async () => async () => ({ capture_shutdown: true }),
		chrome: { tabs: { get: async id => ({ id }) }, debugger: { sendCommand: async (_source, method) => {
			if (method === "Runtime.evaluate") { clock.observeViewport(); return { result: { value: { width: 16, height: 16, visualWidth: 16, visualHeight: 16, dpr: 1, pageScale: 1, offsetX: 0, offsetY: 0, scrollX: 0, scrollY: 0 } } }; }
			if (method === "Page.startScreencast") clock.captureStarted();
			return {};
		} } },
	});
	async function route(message) {
		if (typeof message.id === "string") {
			replies.push(message); const wait = pending.get(message.id); assert.ok(wait); pending.delete(message.id);
			if (message.ok) wait.resolve(message.result); else wait.reject(Object.assign(new Error(message.error.message), message.error));
			return;
		}
		try {
			let data;
			if (message.method.startsWith("record.")) data = await (message.method === "record.start" ? clock.start(controller, message.params) : controller.dispatch(message.method, message.params));
			else if (message.method === "cdp" && message.params.method === "Precision.echo") {
				cdpInputs.push(structuredClone(message.params.params)); data = { result: message.params.params };
			} else throw new Error(`unexpected fixture method ${message.method}`);
			write({ id: message.id, result: { ok: true, data } });
		} catch (e) { write({ id: message.id, error: { code: e.code || "FIXTURE_FAILURE", message: e.message } }); }
	}
	host.stderr.on("data", b => { stderr += b; });
	host.stdout.on("data", b => {
		received = Buffer.concat([received, b]);
		while (received.length >= 4 && received.length >= received.readUInt32LE(0) + 4) {
			const n = received.readUInt32LE(0); assert.ok(n < 1024 * 1024);
			const message = JSON.parse(received.subarray(4, n + 4)); received = received.subarray(n + 4);
			route(message).catch(e => failures.push(e));
		}
	});
	write({ method: "hello", params: { instance_id: env.AP_BROWSER_INSTANCE, extension_version: "test", chrome_version: "fake", open_tabs: [] } });
	const socket = join(root, "ap-browser-precision_fixture.sock");
	try {
		await until(async () => { try { await access(socket); return true; } catch { return false; } });
		const reservation = createServer(); await new Promise(r => reservation.listen(0, "127.0.0.1", r));
		const port = reservation.address().port; await new Promise(r => reservation.close(r));
		const tokenFile = join(root, "token");
		bridge = spawn(join(bin, "ap-browser-bridge"), ["--instance", env.AP_BROWSER_INSTANCE, "--listen", `127.0.0.1:${port}`, "--token-file", tokenFile], { env, stdio: ["ignore", "ignore", "pipe"] });
		let bridgeLog = ""; bridge.stderr.on("data", b => { bridgeLog += b; });
		await until(() => bridgeLog.includes("AP_BROWSER_REMOTE="));
		const token = await readFile(tokenFile, "utf8"); env.AP_BROWSER_REMOTE = `tcp://127.0.0.1:${port}?token=${token}`;
		return { root, calls, replies, cdpInputs, controller, clock, native,
			async cli(args) {
				try { const { stdout } = await exec(join(bin, "ap-browser"), args, { env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }); return { code: 0, value: JSON.parse(stdout) }; }
				catch (e) { return { code: e.code, value: JSON.parse(e.stdout) }; }
			},
			rpc: (method, params) => authenticatedRpc(port, token, method, params),
			async emit() {
				await clock.atCapture(0);
				controller.onFrame({ tabId: 7 }, "Page.screencastFrame", { sessionId: 99, data: fixtureWire.frame.params.jpeg_base64,
					metadata: { deviceWidth: 16, deviceHeight: 16, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0, timestamp: 1234 } });
				await until(() => replies.some(v => v.result?.accepted_seq === 1));
			},
			async close() {
				controller.interrupt("native_disconnected"); await Promise.race([controller.idle(), sleep(250)]);
				await stop(bridge); host.stdin.end(); await stop(host);
				for (const wait of pending.values()) wait.reject(new Error("owned fixture cleanup"));
				await rm(root, { recursive: true, force: true }); assert.equal(failures.length, 0, failures.map(String).join("\n") + stderr);
			},
		};
	} catch (error) { await stop(bridge); await stop(host); await rm(root, { recursive: true, force: true }); throw error; }
}

// The exact captured number must survive strict controller canonical equality,
// typed Event persistence, native echo, real bridge reparsing and CLI rendering.
test("precision captured mark survives strict controller/native/bridge/CLI echo and manifest", { timeout: 30000 }, async t => {
	const h = await harness();
	try {
		const start = await h.cli(["--tab", "7", "record", "start", "--max-duration", "60s", "--operation-id", "precision_start"]);
		assert.equal(start.code, 0, JSON.stringify(start.value)); const handle = start.value.data.handle;
		const [, host_epoch, record_id] = handle.split(":"); const identity = { host_epoch, record_id };
		await h.emit(); await h.clock.atCapture(29.700000047683716);
		const phase = await h.cli(["record", "phase", handle, "--text", "phase literal", "--operation-id", "precision_phase"]);
		assert.equal(phase.code, 0, JSON.stringify(phase.value)); assert.equal(phase.value.data.t_ms, 29.700000047683716);
		await h.clock.atCapture(captured[0]);
		const mark = await h.cli(["record", "mark", handle, "--text", "STEP +1", "--duration", "1s", "--operation-id", "precision_mark"]);
		const sent = h.calls.find(v => v.method === "record.event" && v.params.event.kind === "mark");
		const echoed = h.replies.find(v => v.id === sent.id);
		t.diagnostic(JSON.stringify({ original: sent.params.event.t_ms, native_echo: echoed.result?.t_ms, mark_cli_exit: mark.code }));
		assert.equal(sent.params.event.t_ms, captured[0], "fixture stamps the exact captured JS value");
		assert.ok(sent.raw.includes('"t_ms":1106.2999999523163'), "captured raw decimal crosses the native text parser");
		const bits = Buffer.alloc(8); bits.writeDoubleLE(echoed.result.t_ms);
		assert.equal(bits.readBigUInt64LE().toString(), "4652580374301376512", "exact captured IEEE754 bits after the real native reply");
		assert.equal(echoed.result.t_ms, captured[0], "strict JS number equality: no ULP tolerance");
		assert.equal(mark.code, 0, JSON.stringify(mark.value)); assert.deepEqual(mark.value.data, sent.params.event);
		await h.clock.atCapture(1500);
		const stopped = await h.cli(["record", "stop", handle]); assert.equal(stopped.code, 0); assert.equal(stopped.value.data.status.state, "sealed");
		const manifest = (await h.rpc("record.manifest", { identity })).result.data;
		assert.deepEqual(manifest.events, [phase.value.data, sent.params.event]);
		for (const mutation of ["identity", "event_index", "text", "duration_ms", "t_ms"]) {
			const changed = structuredClone(sent.params);
			if (mutation === "identity") changed.identity.record_id = "another_record";
			else changed.event[mutation] = mutation === "event_index" ? 3 : mutation === "text" ? "changed" : mutation === "duration_ms" ? 999 : 1106.2999999523165;
			// Send genuine changed wire values: only exact retries may be accepted.
			await assert.rejects(h.native("record.event", changed), e => ["RECORD_NOT_FOUND", "RECORD_OPERATION_CONFLICT", "RECORD_SEQUENCE"].includes(e.code));
			if (["text", "duration_ms"].includes(mutation)) {
				await assert.rejects(h.controller.dispatch("record.mark", { identity, operation_id: "precision_mark", text: changed.event.text, duration_ms: changed.event.duration_ms }), e => e.code === "RECORD_OPERATION_CONFLICT");
			}
		}
		assert.deepEqual((await h.rpc("record.manifest", { identity })).result.data, manifest);
		await preserve("captured-mark", { scope: "real controller/native/bridge/CLI, fake CDP only", original: sent, native: echoed, cli: mark, manifest, exact_bits: bits.readBigUInt64LE().toString(), strict_negative_fields: ["identity", "event_index", "text", "duration_ms", "t_ms"] });
	} finally { await h.close(); }
});

test("precision 10006 JS timestamp corpus is exact across CLI/core/bridge/host repeated hops", { timeout: 60000 }, async t => {
	const h = await harness();
	try {
		const expected = [...captured, ...Array.from({ length: 10000 }, (_, n) => (100000 + n / 10) - 100000)];
		const mismatches = [0, 0, 0], nativeMismatches = [0, 0, 0], examples = [];
		for (let offset = 0; offset < expected.length; offset += 512) {
			const original = expected.slice(offset, offset + 512); let payload = { values: original };
			for (let hop = 0; hop < 3; hop++) {
				// JSON.stringify supplies actual JS lexemes to the CLI's text parser.
				const response = await h.cli(["--raw", "cdp", "Precision.echo", "--params", JSON.stringify(payload)]);
				assert.equal(response.code, 0, JSON.stringify(response.value)); payload = response.value;
				assert.equal(payload.values.length, original.length);
				const atNative = h.cdpInputs.at(-1).values;
				for (let i = 0; i < original.length; i++) {
					if (!Object.is(atNative[i], original[i])) nativeMismatches[hop]++;
					if (!Object.is(payload.values[i], original[i])) { mismatches[hop]++; if (examples.length < 4) examples.push({ hop, index: offset + i, expected: original[i], actual: payload.values[i] }); }
				}
			}
		}
		t.diagnostic(JSON.stringify({ cases: expected.length, hops: 3, nativeMismatches, mismatches, examples }));
		assert.deepEqual(nativeMismatches, [0, 0, 0]); assert.deepEqual(mismatches, [0, 0, 0]);
		await preserve("representative-corpus", { cases: expected.length, captured, hops: 3, nativeMismatches, mismatches, examples });
	} finally { await h.close(); }
});

// Keep the initial diagnostic's seeds, JS arithmetic, order and event shape
// distinct from the representative corpus above. Strict values, not lexemes.
test("precision original 10006-event JS corpus preserves every value through newly built CLI/bridge/host", { timeout: 60000 }, async t => {
	const h = await harness();
	try {
		const explicit = [1076.1000000953675, 14.799999952316284, 1000.1000000238419, 3880.799999952316, 5998.5, 300.59999990463257];
		const values = [...explicit, ...Array.from({ length: 10000 }, (_, i) => 123456.789 + i / 10 - 123456.789)];
		const requests = values.map(t_ms => JSON.stringify({ event_index: 2, operation_id: "probe", t_ms, kind: "mark", text: "STEP +1", duration_ms: 1000 }));
		const events = requests.map(JSON.parse), nativeMismatches = [0, 0, 0], mismatches = [0, 0, 0];
		for (let offset = 0; offset < events.length; offset += 512) {
			const original = events.slice(offset, offset + 512); let payload = { events: original };
			for (let hop = 0; hop < 3; hop++) {
				const response = await h.cli(["--raw", "cdp", "Precision.echo", "--params", JSON.stringify(payload)]);
				assert.equal(response.code, 0, JSON.stringify(response.value)); payload = response.value;
				const atNative = h.cdpInputs.at(-1).events; assert.equal(atNative.length, original.length); assert.equal(payload.events.length, original.length);
				for (let i = 0; i < original.length; i++) {
					if (atNative[i].t_ms !== values[offset + i]) nativeMismatches[hop]++;
					if (payload.events[i].t_ms !== values[offset + i]) mismatches[hop]++;
					assert.deepEqual(atNative[i], original[i]); assert.deepEqual(payload.events[i], original[i]);
				}
			}
		}
		assert.deepEqual(nativeMismatches, [0, 0, 0]); assert.deepEqual(mismatches, [0, 0, 0]);
		const receipt = { cases: values.length, explicit, generator: "123456.789 + i / 10 - 123456.789", hops: 3, nativeMismatches, mismatches };
		t.diagnostic(JSON.stringify(receipt)); await preserve("original-corpus", receipt, requests);
	} finally { await h.close(); }
});
