// End-to-end CLI wire regressions. No logged-in browser or credentials needed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile);
const cli = process.env.AP_BROWSER_TEST_CLI || resolve(process.env.CARGO_TARGET_DIR || "target", "debug/ap-browser");

async function harness(t, respond, local = false) {
	const root = await mkdtemp(join(tmpdir(), "ap-interaction-"));
	const sockets = new Set(), requests = [];
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buf = Buffer.alloc(0), authed = local;
		const send = value => {
			const payload = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
			header.writeUInt32LE(payload.length);
			socket.write(Buffer.concat([header, payload]));
		};
		socket.on("data", chunk => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE()) {
				const n = buf.readUInt32LE(), request = JSON.parse(buf.subarray(4, n + 4));
				buf = buf.subarray(n + 4);
				if (!authed) { authed = true; send({ ok: true }); continue; }
				requests.push(request);
				const result = respond(request);
				if (result !== undefined) send(result);
			}
		});
	});
	await new Promise(r => local ? server.listen(join(root, "ap-browser-fixture.sock"), r) : server.listen(0, "127.0.0.1", r));
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise(r => server.close(r));
		await rm(root, { recursive: true, force: true });
	});
	const env = { ...process.env, HOME: root, TMPDIR: root };
	delete env.AP_BROWSER_REMOTE;
	if (!local) env.AP_BROWSER_REMOTE = `tcp://127.0.0.1:${server.address().port}?token=fixture`;
	return { requests, run: async args => {
		try { return await exec(cli, args, { env, timeout: 2500 }); }
		catch (error) { return error; }
	} };
}

test("bare ok:false is normalized to an actionable structured error", async t => {
	const h = await harness(t, () => ({ result: { ok: false } }));
	const result = await h.run(["click", "50", "--tab", "7"]);
	const response = JSON.parse(result.stdout);
	assert.equal(response.ok, false);
	assert.equal(typeof response.error?.code, "string");
	assert.ok(response.error.message.length > 0);
});

test("--timeout bounds a silent host even when it ignores the timeout hint", async t => {
	const h = await harness(t, () => undefined);
	const start = performance.now();
	const result = await h.run(["ping", "--timeout", "1"]);
	assert.equal(result.killed, false, "CLI had to be killed after exceeding its own deadline");
	assert.equal(JSON.parse(result.stdout).error.code, "TIMEOUT");
	assert.ok(performance.now() - start < 2000);
});

test("doctor does not mistake a connectable socket for a responsive extension", { skip: process.platform === "win32" }, async t => {
	const h = await harness(t, () => ({ error: { code: "TIMEOUT", message: "service worker unresponsive" } }), true);
	const result = await h.run(["doctor", "--json"]);
	const check = JSON.parse(result.stdout).checks.find(c => c.name === "extension online");
	assert.equal(check.status, "fail");
	assert.match(check.message, /unresponsive|respond|TIMEOUT/i);
});

test("click --expect-text reaches the extension", async t => {
	const h = await harness(t, () => ({ result: { ok: true, data: { clicked: true } } }));
	const result = await h.run(["click", "50", "--expect-text", "Export", "--tab", "7"]);
	assert.equal(JSON.parse(result.stdout).ok, true);
	assert.equal(h.requests[0].params.expect_text, "Export");
});
