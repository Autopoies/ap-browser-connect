// Run the shipped in-page expressions against an isolated real Chrome DOM.
// This never opens or changes the user's browser/profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSnapshotExpression } from "../extension/state-snapshot.mjs";
import { buildNativeClickResolveExpression, buildNativeFillResolveExpression, buildDomReadExpression, readDomText } from "../extension/filter-enforcement.mjs";

const candidates = [process.env.AP_BROWSER_CHROME, "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
let binary;
for (const candidate of candidates) if (await access(candidate).then(() => true, () => false)) { binary = candidate; break; }
const available = Boolean(binary);

test("interaction expressions work in an isolated real browser", { skip: !available, timeout: 20000 }, async t => {
	const profile = await mkdtemp(join(tmpdir(), "ap-interaction-chrome-"));
	const child = spawn(binary, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
	const exited = new Promise(resolve => child.once("exit", resolve));
	t.after(async () => { child.kill(); await exited; await rm(profile, { recursive: true, force: true, maxRetries: 3 }); });
	const endpoint = await new Promise((resolve, reject) => {
		let output = "";
		child.stderr.on("data", chunk => { output += chunk; const found = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) resolve(found[1]); });
		child.once("error", reject);
		child.once("exit", code => reject(new Error(`Chrome exited before readiness (${code})`)));
	});
	const ws = new WebSocket(endpoint);
	await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
	t.after(() => ws.close());
	let id = 0, sessionId;
	const pending = new Map();
	ws.addEventListener("message", event => {
		const msg = JSON.parse(event.data), waiter = pending.get(msg.id);
		if (!waiter) return;
		pending.delete(msg.id);
		if (msg.error) waiter.reject(new Error(msg.error.message)); else waiter.resolve(msg.result);
	});
	const cdp = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
		const request = { id: ++id, method, params };
		if (session) request.sessionId = session;
		pending.set(id, { resolve, reject }); ws.send(JSON.stringify(request));
	});
	const target = await cdp("Target.createTarget", { url: "about:blank" });
	sessionId = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
	const evaluate = async expression => {
		const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
		return result.result.value;
	};
	await evaluate(`document.body.innerHTML = '<button style="visibility:hidden">Hidden</button><input id="name"><button id="export" tabindex="-1">Export</button><p style="cursor:pointer">Batch Export</p><textarea id="prompt"></textarea><input type="password" value="secret-fixture"><div id="host"></div><iframe src="about:blank"></iframe>'; document.querySelector('#prompt').value='Current prompt'; document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>'; window.clicked=0; document.querySelector('#export').onclick=()=>window.clicked++;`);
	const state = JSON.parse(await evaluate(buildSnapshotExpression(0)));
	assert.ok(state.elements.some(el => el.name === "Export"), "tabindex=-1 does not hide actual buttons");
	assert.ok(state.elements.some(el => el.name === "Batch Export"));
	assert.ok(state.elements.some(el => el.name === "Shadow action"));
	assert.ok(!state.elements.some(el => el.name === "Hidden" || el.name === "secret-fixture"));
	assert.equal(state.coverage.open_shadow_roots, 1);
	assert.equal(state.coverage.iframes.length, 1);
	assert.equal(await evaluate(`(${readDomText.toString()})(document.querySelector('#prompt'))`), "Current prompt");
	const fullText = await evaluate(`(${readDomText.toString()})(document.body)`);
	assert.ok(fullText.includes("Current prompt"));
	assert.ok(!fullText.includes("secret-fixture"));
	const filtered = await evaluate(buildDomReadExpression("body", "text", [{ policy_id: "fixture", selectors: ["#prompt"] }]));
	assert.ok(!filtered.value.includes("Current prompt"), "form values must not bypass drop filters");
	const ref = state.elements.find(el => el.name === "Export").ref;
	let click = await evaluate(buildNativeClickResolveExpression("unused", [], { ref, expect_text: "Export" }));
	assert.equal(click.status, "ok");
	await evaluate(`document.querySelector('#export').outerHTML='<a href="/asset" data-ap-ref="${ref}">Asset</a>'`);
	click = await evaluate(buildNativeClickResolveExpression("unused", [], { ref }));
	assert.equal(click.error.code, "STALE_REF");
	const refreshed = JSON.parse(await evaluate(buildSnapshotExpression(250)));
	const asset = refreshed.elements.find(el => el.name === "Asset");
	assert.ok(asset, JSON.stringify(refreshed));
	assert.ok(asset.ref !== ref);
	const input = refreshed.elements.find(el => el.tag === "input");
	assert.equal((await evaluate(buildNativeFillResolveExpression("unused", [], { ref: input.ref, consume: true }))).status, "ok");
	await cdp("Input.insertText", { text: "Updated name" });
	assert.equal(await evaluate("document.querySelector('#name').value"), "Updated name");
	assert.equal((await evaluate(buildNativeClickResolveExpression("unused", [], { ref: asset.ref }))).error.code, "STALE_REF");
	assert.equal(await evaluate("window.clicked"), 0, "stale interaction must never fire another action");
});
