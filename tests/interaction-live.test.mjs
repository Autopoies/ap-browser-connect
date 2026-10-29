// Opt-in validation through the installed CLI -> native host -> real extension.
// Uses one owned silent tab on a loopback fixture, never a user's existing tab.
// AP_BROWSER_LIVE=1 AP_BROWSER_TEST_CLI=ap-browser AP_BROWSER_TEST_PROFILE=Personal node --test tests/interaction-live.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile);
const cli = process.env.AP_BROWSER_TEST_CLI || "ap-browser";

test("installed browser chain: SPA refs, values, label guard, WebGL modal and stable screenshots", { skip: process.env.AP_BROWSER_LIVE !== "1", timeout: 60000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "ap-browser-live-"));
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(`<!doctype html><title>AP interaction regression</title><style>body{font:16px sans-serif}button,input,textarea{margin:10px}#modal{position:fixed;inset:100px;background:#eee;padding:20px}</style>
		<input id="name" placeholder="Name"><button id="export">Export</button><p id="status">idle</p>
		<textarea id="prompt"></textarea><p id="menu" style="cursor:pointer">Batch Export</p><button id="models">Choose models</button>
		<script>
		const prompt = document.querySelector('#prompt'); prompt.value='Current form value';
		document.querySelector('#name').addEventListener('input', () => {
		 const old=document.querySelector('#export'); const next=old.cloneNode(true); old.replaceWith(next);
		});
		document.addEventListener('click', event => {
		 if(event.target.id==='export') document.querySelector('#status').textContent='exported';
		 if(event.target.id==='models') {
		  const modal=document.createElement('div'); modal.id='modal'; modal.innerHTML='<p>Candidate viewer</p><canvas width="320" height="180"></canvas><button id="close">Close viewer</button>';
		  document.body.appendChild(modal); const gl=modal.querySelector('canvas').getContext('webgl'); if(gl){gl.clearColor(.2,.3,.5,1);gl.clear(gl.COLOR_BUFFER_BIT);}
		 }
		 if(event.target.id==='close') document.querySelector('#modal')?.remove();
		});
		</script>`);
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
	let tab;
	const run = async (args, { target = true, expectError = false } = {}) => {
		const argv = [...args];
		if (process.env.AP_BROWSER_TEST_PROFILE) argv.push("--profile", process.env.AP_BROWSER_TEST_PROFILE);
		if (target && tab != null) argv.push("--tab", String(tab));
		let result;
		try { result = await exec(cli, [...argv, "--timeout", "5"], { timeout: 10000 }); }
		catch (error) { result = error; }
		assert.ok(result.stdout?.trim(), "installed CLI returned no JSON");
		const response = JSON.parse(result.stdout);
		if (!expectError) assert.equal(response.ok, true, JSON.stringify(response.error));
		return response;
	};
	const created = await run(["tabs", "new", `http://127.0.0.1:${server.address().port}`, "--silent"], { target: false });
	tab = created.data.id;
	t.after(() => run(["tabs", "close", String(tab)], { target: false }));
	await run(["wait", "#models"]);
	const state = async () => (await run(["state"])).data;
	const first = await state(), ref = name => first.elements.find(el => el.name === name)?.ref;
	assert.ok(first.elements.some(el => el.name === "Batch Export"));
	assert.equal((await run(["text", "--selector", "#prompt"])).data.text, "Current form value");
	const exportRef = ref("Export"), nameRef = ref("Name");
	await run(["fill", String(nameRef), "Updated name"]);
	assert.equal((await run(["click", String(exportRef)], { expectError: true })).error.code, "STALE_REF");
	const refreshed = await state(), exportNow = refreshed.elements.find(el => el.name === "Export").ref;
	assert.equal((await run(["click", String(exportNow), "--expect-text", "Delete"], { expectError: true })).error.code, "TEXT_MISMATCH");
	await run(["click", String(exportNow), "--expect-text", "Export"]);
	assert.equal((await run(["text", "--selector", "#status"])).data.text, "exported");
	const shot = async name => {
		const file = join(root, name);
		await run(["screenshot", "--out", file]);
		const png = await readFile(file);
		return [png.readUInt32BE(16), png.readUInt32BE(20)];
	};
	const before = await shot("before.png");
	// Wait inside a bounded browser command, past the old 3-second detach timer.
	await run(["wait", "--until-eval", "new Promise(resolve => setTimeout(() => resolve(true), 3500))", "--timeout-ms", "4500"]);
	assert.deepEqual(await shot("after.png"), before);
	const models = (await state()).elements.find(el => el.name === "Choose models").ref;
	await run(["click", String(models), "--expect-text", "Choose models"]);
	await run(["state"]);
	await run(["ping"], { target: false });
	await run(["tabs", "list"], { target: false });
	await shot("webgl.png");
	const close = (await state()).elements.find(el => el.name === "Close viewer").ref;
	await run(["click", String(close), "--expect-text", "Close viewer"]);
	t.diagnostic(`installed chain passed; screenshot size stayed ${before.join("x")}`);
});
