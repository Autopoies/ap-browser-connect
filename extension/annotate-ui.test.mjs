import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeEvaluateValue } from "./runtime-helpers.mjs";
import { STATE_ELEMENT_SELECTOR, STATE_MAX_REFS } from "./state-snapshot.mjs";

// Dependency-free browser regression tests. Set AP_TEST_CHROME on other platforms.
const browser = [
	process.env.AP_TEST_CHROME,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
].find((path) => path && existsSync(path));
const source = await readFile(new URL("./annotate-ui.js", import.meta.url), "utf8");
const background = await readFile(new URL("./background.js", import.meta.url), "utf8");
const annotationStart = background.indexOf("async function attachUserAnnotations(");
const annotationSource = background.slice(
	annotationStart,
	background.indexOf("// ─── annotation mode toggle", annotationStart),
);

test("annotation source contains no emoji or legacy agent launcher", () => {
	assert.doesNotMatch(source, /\p{Extended_Pictographic}/u);
	assert.doesNotMatch(source, /agent\.launch|marksLayer\.replaceChildren|function enumerate/);
});

test("annotation UI in real Chromium", {
	skip:
		!browser || typeof WebSocket === "undefined"
			? "Chrome and Node with WebSocket required"
			: false,
	timeout: 60000,
}, async (t) => {
	const profile = await mkdtemp(join(tmpdir(), "ap-annotate-test-"));
	const child = spawn(
		browser,
		[
			"--headless",
			"--disable-gpu",
			"--no-sandbox",
			"--no-first-run",
			"--no-default-browser-check",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"about:blank",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let socket;
	t.after(async () => {
		socket?.close();
		if (child.exitCode == null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill();
			await exited;
		}
		await rm(profile, { recursive: true, force: true, maxRetries: 3 });
	});
	const endpoint = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Chrome startup timeout")), 10000);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
			if (match) {
				clearTimeout(timeout);
				resolve(match[1]);
			}
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Chrome exited ${code}: ${stderr}`));
		});
	});
	socket = new WebSocket(endpoint);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let nextId = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const msg = JSON.parse(event.data);
		if (!msg.id) return;
		const request = pending.get(msg.id);
		if (!request) return;
		pending.delete(msg.id);
		clearTimeout(request.timeout);
		if (msg.error) request.reject(new Error(JSON.stringify(msg.error)));
		else request.resolve(msg.result);
	});
	function cdp(method, params = {}, sessionId) {
		return new Promise((resolve, reject) => {
			const id = ++nextId;
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`${method} timeout`));
			}, 10000);
			pending.set(id, { resolve, reject, timeout });
			socket.send(JSON.stringify({ id, method, params, sessionId }));
		});
	}
	const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
	await cdp(
		"Emulation.setDeviceMetricsOverride",
		{ width: 1000, height: 760, deviceScaleFactor: 1, mobile: false },
		sessionId,
	);
	async function evaluate(expression) {
		const result = await cdp(
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true },
			sessionId,
		);
		if (result.exceptionDetails)
			throw new Error(
				result.exceptionDetails.exception?.description || result.exceptionDetails.text,
			);
		return result.result.value;
	}
	const frames = () =>
		evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
	const ui = "document.querySelector('#ap-annotate-root').shadowRoot";
	async function setup(bound = false, extra = "") {
		await evaluate(`window.__apAnnotateCleanup?.(); document.body.innerHTML = ${JSON.stringify(`
			<style>body { margin:0; height:2500px; font:16px sans-serif; background:#f8fafc; color:#111 } #target {position:absolute;left:50px;top:100px;width:180px;height:40px} #text {position:absolute;left:80px;top:230px;width:400px} #code {position:absolute;left:80px;top:350px;width:300px;height:80px} #giant {position:absolute;left:0;top:800px;width:100%;height:1500px}</style>
			<button id="target">A page button</button><p id="text">Select this helpful paragraph for a question.</p><pre id="code">npm test</pre><div id="giant">Large layout</div>
		`)};
			window.scrollTo(0,0);
			window.__binding = ${bound ? '{session_id:"session-a",label:"Pi",scope:"tab"}' : "null"};
			window.__ready = b => { if(b) {b.receiver_epoch ||= 'epoch-'+b.session_id; b.health ||= {state:'ready',checked_at:Date.now(),valid_until:Date.now()+60000};} return b; };
			__ready(__binding);
			window.__bindings = __binding ? [__binding] : [];
			window.__sent = []; window.__runtimeListeners = []; window.__offline = false; window.__holdSave = false; window.__pageClicks = 0;
			document.querySelector('#target').onclick = () => window.__pageClicks++;
			Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {window.__copied=text}}});
			window.chrome = { runtime: {
				onMessage: {addListener(fn){__runtimeListeners.push(fn)},removeListener(fn){__runtimeListeners=__runtimeListeners.filter(x=>x!==fn)}},
				async sendMessage(msg) {
					__sent.push(msg);
					if(msg.method==='annotations.tab') return {ok:true,tab_id:12,window_id:7};
					if(msg.method==='annotations.get') return {ok:true,refs:window.__stored || []};
					if(msg.method==='session.get_binding') return {ok:true,binding:__binding,bindings:__bindings};
					if(msg.method==='session.select_binding') {
						__binding=__bindings.find(b=>b.session_id===msg.session_id);
						__bindings.forEach(b=>b.active=b===__binding);
						__runtimeListeners.forEach(fn=>fn({method:'annotate.binding_changed',binding:__binding,bindings:__bindings}));
						return {ok:true,binding:__binding,bindings:__bindings};
					}
					if(msg.method==='session.unbind') {
						__bindings=__bindings.filter(b=>!(b.session_id===msg.session_id && (msg.tab_id!=null?b.scope==='tab':b.scope==='window')));
						if(!__bindings.includes(__binding)) __binding=__bindings.at(-1)||null;
						__runtimeListeners.forEach(fn=>fn({method:'annotate.binding_changed',binding:__binding,bindings:__bindings}));
						return {ok:true};
					}
					if(msg.method==='annotations.set' && __holdSave) return new Promise(()=>{});
					if(msg.method==='relay.send') {
						if(__offline) {__binding=null;__bindings=[];}
						return __offline || !__bindings.some(b=>b.session_id===msg.session_id) ? {ok:false,code:'BINDING_OFFLINE',binding:__binding,bindings:__bindings} : {ok:true,data:{result:{event_id:'event-'+__sent.length,thread_id:msg.thread_id,status:'queued'}}};
					}
					return {ok:true};
				}
			}, storage: {local:{get:async()=>window.__localStore,set:async(v)=>{Object.assign(window.__localStore,v)}}}};
			window.__localStore = {};
			window.__stored = [];
			${extra}
			__bindings.forEach(__ready); __ready(__binding);
		`);
		await evaluate(source);
		await frames();
	}
	async function click(selector, modifiers = 0) {
		const { x, y } = await evaluate(
			`(()=>{const r=(${selector}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
		);
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers }, sessionId);
		await cdp(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers },
			sessionId,
		);
		await cdp(
			"Input.dispatchMouseEvent",
			{ type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers },
			sessionId,
		);
		await frames();
	}
	const selectionFixture = `{
		const fixture=document.createElement('section');
		fixture.id='selection-fixture';
		fixture.style.cssText='position:absolute;left:500px;top:100px;width:360px;padding:20px;font:16px/28px monospace';
		fixture.innerHTML='<div id="part-a">ignore Selected <em>alpha</em></div><div id="part-b">Selected beta ignore</div><div id="part-c">Unselected footer</div>';
		document.body.append(fixture);
	}`;
	async function dragText(start, end, beforeRelease = async () => {}) {
		await evaluate("getSelection().removeAllRanges()");
		const [from, to] =
			await evaluate(`(${JSON.stringify([start, end])}).map(([selector,offset,hosts=[]])=>{
			let root=document;
			for(const host of hosts) root=root.querySelector(host).shadowRoot;
			const range=document.createRange();
			range.setStart(root.querySelector(selector).firstChild,offset);
			range.collapse(true);
			const r=range.getBoundingClientRect();
			return {x:r.x,y:r.y+r.height/2};
		})`);
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...from }, sessionId);
		await cdp(
			"Input.dispatchMouseEvent",
			{
				type: "mousePressed",
				...from,
				button: "left",
				clickCount: 1,
			},
			sessionId,
		);
		for (let step = 1; step <= 3; step++)
			await cdp(
				"Input.dispatchMouseEvent",
				{
					type: "mouseMoved",
					button: "left",
					buttons: 1,
					x: from.x + ((to.x - from.x) * step) / 3,
					y: from.y + ((to.y - from.y) * step) / 3,
				},
				sessionId,
			);
		await frames();
		try {
			await beforeRelease();
		} finally {
			await cdp(
				"Input.dispatchMouseEvent",
				{
					type: "mouseReleased",
					...to,
					button: "left",
					clickCount: 1,
				},
				sessionId,
			);
			await frames();
		}
	}
	async function assertSelectionBox(selector = ".box:not(.preview)") {
		assert.equal(
			await evaluate(`(()=>{
			const actual=${ui}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
			const expected=getSelection().getRangeAt(0).getBoundingClientRect();
			return ['x','y','width','height'].every(key=>Math.abs(actual[key]-expected[key])<1);
		})()`),
			true,
		);
	}
	const target = "document.querySelector('#target')";
	const buttonWith = (text) =>
		`${ui}.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)})`;
	const action = (text) => `[...${buttonWith(text)}`;
	async function message(msg) {
		await evaluate(
			`(()=>{const msg=${JSON.stringify(msg)};if(msg.method==='annotate.binding_changed'){__binding=__ready(msg.binding);__bindings=(msg.bindings || (msg.binding?[msg.binding]:[])).map(__ready);}__runtimeListeners.forEach(fn=>fn(msg));})()`,
		);
		await frames();
	}

	await t.test("unbound pins are optimistic, pin-only, and survive close/reopen", async () => {
		await setup(false, "window.__holdSave = true;");
		assert.equal(await evaluate(`${ui}.querySelector('.title').textContent`), "Pin Mode");
		await click(target);
		assert.equal(await evaluate("__pageClicks"), 0);
		assert.equal(
			await evaluate(`${ui}.querySelector('summary').textContent`),
			"Pinned Elements (1)",
		);
		assert.equal(await evaluate(`${ui}.querySelectorAll('.item button').length`), 2);
		assert.equal(
			await evaluate(`${ui}.querySelectorAll('.capsule.unbound .actions button').length`),
			1,
		);
		assert.equal(await evaluate("__sent.filter(m=>m.method==='annotations.set').length"), 1);
		await click(`${ui}.querySelector('.head button:last-child')`);
		assert.equal(await evaluate("!!document.querySelector('#ap-annotate-root')"), true);
		assert.equal(
			await evaluate("document.querySelector('#ap-annotate-root').style.display"),
			"none",
		);
		for (let i = 0; i < 3; i++) {
			await evaluate(
				"window.dispatchEvent(new KeyboardEvent('keydown',{key:'E',metaKey:true,shiftKey:true,composed:true,bubbles:true}))",
			);
			assert.equal(
				await evaluate("document.querySelector('#ap-annotate-root').style.display"),
				i % 2 === 0 ? "block" : "none",
			);
		}
		await evaluate(source);
		await evaluate(source);
		assert.equal(await evaluate("__runtimeListeners.length"), 1);
		assert.equal(await evaluate("__sent.filter(m=>m.method==='annotations.get').length"), 1);
		await click(target);
		assert.equal(
			await evaluate(`${ui}.querySelector('summary').textContent`),
			"Pinned Elements (0)",
		);
	});

	await t.test(
		"Pin Mode supports consecutive element selections without reactivation",
		async () => {
			await setup(false);
			await click(`${ui}.querySelector('[aria-label="Expand dock"]')`);
			assert.match(
				await evaluate(`${ui}.querySelector('.status').textContent`),
				/keep clicking to add more/,
			);
			assert.doesNotMatch(
				await evaluate(`${ui}.querySelector('.status').textContent`),
				/Unbound|CLI|screenshot/,
			);
			assert.equal(
				await evaluate(`getComputedStyle(${ui}.querySelector('.status .status-label')).whiteSpace`),
				"normal",
			);
			await click(target);
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (1)",
			);
			await click("document.querySelector('#code')");
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (2)",
			);
			await click("document.querySelector('#text')");
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (3)",
			);
			await click(target);
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (2)",
			);
			assert.equal(await evaluate("__pageClicks"), 0);
		},
	);

	await t.test(
		"Pin Mode has a readable selection toggle that pauses clicks and text pins",
		async () => {
			await setup(false, selectionFixture);
			const toggle = `${ui}.querySelector('.pick')`;
			assert.equal(
				await evaluate(`${toggle}.hidden`),
				false,
				"Pin Mode must expose its selection switch",
			);
			assert.equal(
				await evaluate(`getComputedStyle(${toggle}.querySelector('span')).display !== 'none'`),
				true,
			);
			assert.equal(await evaluate(`${toggle}.getAttribute('aria-pressed')`), "true");
			await click(target);
			await click(toggle);
			assert.equal(await evaluate(`${toggle}.getAttribute('aria-pressed')`), "false");
			await click(target);
			assert.equal(await evaluate("__pageClicks"), 1);
			await dragText(["#part-a", 7], ["#part-b", 13]);
			assert.equal(
				await evaluate(`${ui}.querySelectorAll('.item').length`),
				1,
				"Pausing selection must retain existing pins without creating new ones",
			);
			assert.equal(await evaluate("getSelection().toString()"), "Selected alpha\nSelected beta");
			await click(toggle);
			await dragText(["#part-a", 7], ["#part-b", 13]);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 2);
		},
	);

	await t.test(
		"Pin Mode uses the resized dock for its list instead of leaving a blank footer",
		async () => {
			await setup(
				false,
				`${selectionFixture}
			window.__localStore.annotate_site_layouts={local:{minimized:false,w:469,h:334}};
			window.__stored=['#target','#text','#code','#part-c'].map((selector,i)=>({selector,ref:250+i,name:'Pinned directory '+i,text:'Pinned directory '+i}));
		`,
			);
			const metrics = await evaluate(
				`(()=>{const root=${ui}; const dock=root.querySelector('.dock').getBoundingClientRect();const list=root.querySelector('.pins-list').getBoundingClientRect();const footer=root.querySelector('.footer').getBoundingClientRect();return {dockBottom:dock.bottom,footerBottom:footer.bottom,listHeight:list.height,hintWhiteSpace:getComputedStyle(root.querySelector('.status .status-label')).whiteSpace}})()`,
			);
			assert.ok(Math.abs(metrics.dockBottom - metrics.footerBottom) < 3, JSON.stringify(metrics));
			assert.ok(metrics.listHeight > 150, "The pin list should use the available height");
			assert.equal(metrics.hintWhiteSpace, "normal");
		},
	);

	await t.test(
		"Pin Mode text dragging across file links creates a text pin, not native link dragging",
		async () => {
			await setup(
				false,
				`${selectionFixture}
			document.querySelector('#part-a').innerHTML='<a id="file-link" href="#should-not-navigate">ignore Selected alpha</a>';
			document.querySelector('#selection-fixture').onclick=()=>__pageClicks++;
		`,
			);
			await dragText(["#file-link", 7], ["#part-b", 13]);
			const stored = await evaluate("__sent.filter(m=>m.method==='annotations.set').at(-1)?.refs");
			assert.equal(stored?.length, 1, "Dragging a file link in Pin Mode must select its text");
			assert.equal(stored[0].text, "Selected alpha\nSelected beta");
			assert.equal(await evaluate("location.hash"), "");
			assert.equal(
				await evaluate("document.querySelector('#file-link').hasAttribute('style')"),
				false,
				"Gesture-only overrides must be removed after release",
			);
			assert.equal(
				await evaluate("__pageClicks"),
				0,
				"A text drag must not activate a page click handler",
			);
			await dragText(["#file-link", 7], [".pick span", 3, ["#ap-annotate-root"]]);
			assert.equal(
				await evaluate("document.querySelector('#file-link').hasAttribute('style')"),
				false,
				"Releasing over the overlay must also restore page styles",
			);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 1);
		},
	);

	await t.test(
		"Pin Mode refreshes an old panel without replacing a Connect Mode thread",
		async () => {
			await setup(false);
			await click(target);
			await evaluate(
				`window.__stored=__sent.filter(m=>m.method==='annotations.set').at(-1).refs;window.__previousRoot=document.querySelector('#ap-annotate-root');__previousRoot.removeAttribute('data-ap-pin-ui');`,
			);
			await evaluate(source);
			await frames();
			assert.equal(
				await evaluate("document.querySelector('#ap-annotate-root')===__previousRoot"),
				false,
			);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 1);
			assert.equal(await evaluate(`${ui}.querySelector('.pick').hidden`), false);
			await setup(true);
			await click(`${ui}.querySelector('[aria-label="Expand dock"]')`);
			await evaluate(
				`window.__previousRoot=document.querySelector('#ap-annotate-root');__previousRoot.removeAttribute('data-ap-pin-ui');window.__previousInput=${ui}.querySelector('.follow input');__previousInput.value='Keep my Connect draft';`,
			);
			await evaluate(source);
			await frames();
			assert.equal(
				await evaluate("document.querySelector('#ap-annotate-root')===__previousRoot"),
				true,
			);
			assert.equal(await evaluate(`${ui}.querySelector('.follow input')===__previousInput`), true);
			assert.equal(await evaluate("__previousInput.value"), "Keep my Connect draft");
			assert.equal(await evaluate("__sent.filter(m=>m.method==='annotations.get').length"), 1);
		},
	);

	await t.test(
		"Connect Mode keeps its Pick control, compact pin list and native link behavior",
		async () => {
			await setup(
				true,
				`${selectionFixture}
			window.__localStore.annotate_site_layouts={local:{minimized:false,w:469,h:334}};
			document.querySelector('#part-a').innerHTML='<a id="file-link" href="#native-link">ignore Selected alpha</a>';
		`,
			);
			assert.equal(await evaluate(`${ui}.querySelector('.pick').textContent`), "Pick");
			assert.equal(
				await evaluate(`${ui}.querySelector('.pick').getAttribute('aria-pressed')`),
				"false",
			);
			assert.equal(
				await evaluate(`getComputedStyle(${ui}.querySelector('.pins-list')).maxHeight`),
				"96px",
			);
			assert.equal(
				await evaluate(`getComputedStyle(${ui}.querySelector('.status')).display`),
				"none",
			);
			assert.equal(await evaluate(`${ui}.querySelector('.follow').hidden`), false);
			await dragText(["#file-link", 7], ["#part-b", 13]);
			assert.equal(
				await evaluate("document.querySelector('#file-link').hasAttribute('style')"),
				false,
			);
			assert.equal(await evaluate("__sent.filter(m=>m.method==='annotations.set').length"), 0);
		},
	);

	await t.test("Pin Mode merges a native cross-div text drag into one selection pin", async () => {
		await setup(false, selectionFixture);
		await dragText(["#part-a", 7], ["#part-b", 13], async () => {
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 0);
			assert.equal(await evaluate(`${ui}.querySelector('.preview').style.display`), "block");
			await assertSelectionBox(".preview");
		});
		const stored = await evaluate("__sent.filter(m=>m.method==='annotations.set').at(-1)?.refs");
		assert.equal(stored?.length, 1);
		assert.equal(stored[0].text, "Selected alpha\nSelected beta");
		assert.equal(stored[0].selection.start.selector, "#part-a");
		assert.equal(stored[0].selection.start.offset, 7);
		assert.equal(stored[0].selection.end.selector, "#part-b");
		assert.equal(stored[0].selection.end.offset, 13);
		assert.equal(await evaluate(`${ui}.querySelectorAll('.box:not(.preview)').length`), 1);
		assert.equal(await evaluate(`${ui}.querySelectorAll('.capsule:not(.selection)').length`), 1);
		assert.equal(
			await evaluate("document.querySelector('#part-a').hasAttribute('data-ap-ref')"),
			false,
		);
		assert.equal(await evaluate(`${ui}.querySelector('.selection').hidden`), true);
		await assertSelectionBox();
		assert.equal(stored[0].w < 360, true); // Never expand to the common parent container.
		if (process.env.AP_TEST_SCREENSHOT) {
			const screenshot = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
			await writeFile(process.env.AP_TEST_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
		}
	});

	await t.test(
		"native text pins inside nested shadow roots restore their own boundaries",
		async () => {
			await setup(
				false,
				`${selectionFixture}{
			const outer=document.createElement('div'); outer.id='selection-outer';
			const inner=document.createElement('div'); inner.id='selection-inner';
			document.body.append(outer);
			outer.attachShadow({mode:'open'}).append(inner);
			const fixture=document.querySelector('#selection-fixture');
			const content=fixture.innerHTML;
			fixture.replaceChildren();
			fixture.attachShadow({mode:'open'}).innerHTML=content;
			inner.attachShadow({mode:'open'}).append(fixture);
		}`,
			);
			const hosts = ["#selection-outer", "#selection-inner", "#selection-fixture"];
			await dragText(["#part-a", 7, hosts], ["#part-b", 13, hosts]);
			const stored = await evaluate("__sent.filter(m=>m.method==='annotations.set').at(-1)?.refs");
			assert.equal(stored?.length, 1, "A shadow-root text selection must create one pin");
			assert.equal(stored[0].text, "Selected alpha\nSelected beta");
			assert.deepEqual(stored[0].selection.start.shadow_hosts, hosts);
			assert.deepEqual(stored[0].selection.end.shadow_hosts, hosts);
			assert.equal(stored[0].w < 360, true);
			await evaluate(
				"window.__stored=__sent.filter(m=>m.method==='annotations.set').at(-1).refs; window.__apAnnotateCleanup();",
			);
			await evaluate(source);
			await frames();
			assert.equal(await evaluate(`${ui}.querySelectorAll('.box:not(.preview)').length`), 1);
		},
	);

	await t.test(
		"backward and same-element text pins coexist with ordinary pins and deduplicate",
		async () => {
			await setup(false, selectionFixture);
			await click(target);
			await dragText(["#part-b", 13], ["#part-a", 7]);
			await dragText(["#part-a", 0], ["#part-a", 6]);
			await dragText(["#part-a", 7], ["#part-b", 13]);
			const stored = await evaluate("__sent.filter(m=>m.method==='annotations.set').at(-1).refs");
			assert.equal(stored.length, 3);
			assert.equal(new Set(stored.map((item) => item.ref)).size, 3);
			assert.deepEqual(
				stored.map((item) => item.text),
				["A page button", "Selected alpha\nSelected beta", "ignore"],
			);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.box:not(.preview)').length`), 3);
			await click(`${ui}.querySelector('[aria-label="Expand dock"]')`);
			await click(`${ui}.querySelectorAll('.item')[1].querySelector('button:last-child')`);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.box:not(.preview)').length`), 2);
			await click(target);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 1);
			assert.equal(await evaluate("__pageClicks"), 0);
		},
	);

	await t.test(
		"selection pins restore their range, follow layout, and hide missing endpoints",
		async () => {
			await setup(false, selectionFixture);
			await dragText(["#part-a", 7], ["#part-b", 13]);
			await evaluate("window.scrollTo(0,1000)");
			await frames();
			assert.equal(
				await evaluate(`${ui}.querySelector('.capsule:not(.selection)').style.display`),
				"none",
			);
			await evaluate(
				"window.scrollTo(0,0); document.querySelector('#selection-fixture').style.left='540px'; window.dispatchEvent(new Event('resize'));",
			);
			await frames();
			await assertSelectionBox();
			await evaluate(
				"window.__stored=__sent.filter(m=>m.method==='annotations.set').at(-1).refs; window.__apAnnotateCleanup(); getSelection().removeAllRanges();",
			);
			await evaluate(source);
			await frames();
			assert.equal(await evaluate(`${ui}.querySelectorAll('.box:not(.preview)').length`), 1);
			assert.equal(
				await evaluate(`${ui}.querySelector('.box:not(.preview)').getBoundingClientRect().x > 540`),
				true,
			);
			await evaluate(
				"document.querySelector('#part-b').remove(); window.dispatchEvent(new Event('resize'));",
			);
			await frames();
			assert.equal(
				await evaluate(`${ui}.querySelector('.box:not(.preview)').style.display`),
				"none",
			);
			await evaluate("window.__apAnnotateCleanup()");
			await evaluate(source);
			await frames();
			assert.equal(await evaluate(`${ui}.querySelectorAll('.box:not(.preview)').length`), 0);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 1); // Keep removable text, not stale geometry.
		},
	);

	await t.test(
		"state and screenshots resolve selection geometry without marking the parent",
		async () => {
			await setup(false, selectionFixture);
			await dragText(["#part-a", 7], ["#part-b", 13]);
			await evaluate(`window.__readAnnotationSnapshot=async()=>{
			const STATE_ELEMENT_SELECTOR=${JSON.stringify(STATE_ELEMENT_SELECTOR)};
			const STATE_MAX_REFS=${STATE_MAX_REFS};
			const runtimeEvaluateValue=${runtimeEvaluateValue.toString()};
			chrome.storage.session={get:async key=>({[key]:__sent.filter(m=>m.method==='annotations.set').at(-1).refs})};
			chrome.debugger={sendCommand:async(target,method,params)=>({result:{value:globalThis.eval(params.expression)}})};
			${annotationSource}
			const r=document.querySelector('#target').getBoundingClientRect();
			const data={elements:[{ref:0,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}]};
			await attachUserAnnotations(12,data);
			return data;
		}`);
			let data = await evaluate("__readAnnotationSnapshot()");
			assert.equal(data.annotated[0].ref, null);
			assert.equal(data.annotated[0].text, "Selected alpha\nSelected beta");
			assert.equal(data.elements[0].user, undefined);
			assert.equal(data.elements.length, 2);
			const before = data.annotated[0];
			await evaluate(
				"document.querySelector('#selection-fixture').style.left='540px'; window.scrollTo(0,80)",
			);
			await frames();
			data = await evaluate("__readAnnotationSnapshot()");
			assert.equal(data.annotated[0].x, before.x + 40);
			assert.equal(data.annotated[0].y, before.y - 80);
			assert.deepEqual(data.elements[1], {
				x: data.annotated[0].x,
				y: data.annotated[0].y,
				w: data.annotated[0].w,
				h: data.annotated[0].h,
				user: true,
			});
			await evaluate("document.querySelector('#part-b').firstChild.data='Changed beta ignore'");
			await frames();
			assert.equal(
				await evaluate(`${ui}.querySelector('.box:not(.preview)').style.display`),
				"none",
			);
			data = await evaluate("__readAnnotationSnapshot()");
			assert.equal(data.annotated[0].x, null);
			assert.equal(data.elements.length, 1);
		},
	);

	await t.test(
		"text drag ignores cancelled gestures and editing, but accepts short selections",
		async () => {
			await setup(false, selectionFixture);
			await dragText(["#part-a", 7], ["#part-b", 13], async () => {
				await evaluate(
					"window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
				);
			});
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 0);
			await evaluate("document.querySelector('#part-a').contentEditable='true'");
			await dragText(["#part-a", 0], ["#part-a", 6]);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 0);
			await evaluate("document.querySelector('#part-a').removeAttribute('contenteditable')");
			await dragText(["#part-a", 0], ["#part-a", 2]);
			assert.equal(
				await evaluate("__sent.filter(m=>m.method==='annotations.set').at(-1)?.refs[0].text"),
				"ig",
			);
		},
	);

	await t.test(
		"Connect text dragging stays opt-in and keeps its existing element Pin action",
		async () => {
			await setup(true, selectionFixture);
			await dragText(["#part-a", 7], ["#part-b", 13]);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.item').length`), 0);
			assert.equal(await evaluate(`${ui}.querySelector('.selection').hidden`), false);
			await click(`${ui}.querySelector('.selection button:last-child')`);
			const context = "ignore Selected alphaSelected beta ignoreUnselected footer";
			assert.equal(
				await evaluate("__sent.filter(m=>m.method==='annotations.set').at(-1).refs[0].text"),
				context,
			);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.box:not(.preview)').length`), 1);
			await click(`${ui}.querySelector('.capsule:not(.selection) .actions button')`);
			await evaluate(
				`(()=>{const form=${ui}.querySelector('.capsule:not(.selection) form');form.input.value='Explain both';form.requestSubmit()})()`,
			);
			const sent = await evaluate("__sent.find(m=>m.method==='relay.send')");
			assert.equal(sent.raw_text, context);
			assert.equal(sent.element.selector, "#selection-fixture");
			assert.equal(sent.element.selection, undefined);
		},
	);

	await t.test(
		"Pin Mode selects multiple comments inside nested shadow roots after a normal pin",
		async () => {
			await setup(
				false,
				`
			const comments=document.createElement('x-comments');
			comments.style.cssText='position:absolute;left:300px;top:180px;width:600px;height:1500px';
			document.body.append(comments);
			const root=comments.attachShadow({mode:'open'});
			for(let i=0;i<2;i++) {
				const comment=document.createElement('x-comment');
				comment.style.cssText='display:block;margin:24px;width:280px;height:60px';
				root.append(comment);
				comment.attachShadow({mode:'open'}).innerHTML='<span id="text" style="display:block;width:280px;height:40px">Comment '+i+'</span>';
			}
		`,
			);
			const comment = (index) =>
				`document.querySelector('x-comments').shadowRoot.querySelectorAll('x-comment')[${index}].shadowRoot.querySelector('#text')`;
			await click(target);
			const point = await evaluate(
				`(()=>{const r=(${comment(0)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
			);
			await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, sessionId);
			await frames();
			assert.equal(await evaluate(`${ui}.querySelector('.preview').style.display`), "block");
			assert.equal(
				await evaluate(`${ui}.querySelector('.preview').getBoundingClientRect().width`),
				280,
			);
			await click(comment(0));
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (2)",
			);
			await click(comment(1));
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (3)",
			);
			const saved = await evaluate("__sent.filter(m=>m.method==='annotations.set').at(-1).refs");
			assert.equal(saved[1].shadow_hosts.length, 2);
			assert.notDeepEqual(saved[1].shadow_hosts, saved[2].shadow_hosts);
			await evaluate(
				"window.__stored=__sent.filter(m=>m.method==='annotations.set').at(-1).refs; window.__apAnnotateCleanup();",
			);
			await evaluate(source);
			await frames();
			assert.equal(await evaluate(`${ui}.querySelectorAll('.capsule.unbound').length`), 3);
			await click(comment(0));
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (2)",
			);
		},
	);

	await t.test(
		"bound browse is non-intercepting; Alt pin and Pick/Escape are independent",
		async () => {
			await setup(true);
			await click(target);
			assert.equal(await evaluate("__pageClicks"), 1);
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (0)",
			);
			await click(target, 1);
			assert.equal(await evaluate("__pageClicks"), 1);
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (1)",
			);
			await click(action("Pick"));
			assert.equal(
				await evaluate(`${ui}.querySelector('.pick').getAttribute('aria-pressed')`),
				"true",
			);
			await evaluate(
				`${ui}.querySelector('.pick').dispatchEvent(new KeyboardEvent('keydown',{key:'E',metaKey:true,shiftKey:true,bubbles:true,composed:true}))`,
			);
			assert.equal(
				await evaluate(`${ui}.querySelector('.pick').getAttribute('aria-pressed')`),
				"false",
			);
			await click(action("Pick"));
			await evaluate(
				"window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
			);
			assert.equal(
				await evaluate(`${ui}.querySelector('.pick').getAttribute('aria-pressed')`),
				"false",
			);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.box:not(.preview)').length`), 1);
			assert.equal(
				await evaluate(`${ui}.querySelector('.dock').getBoundingClientRect().width`),
				340,
			);
		},
	);

	await t.test(
		"scroll batches geometry only, hides offscreen pins, and preserves IME input",
		async () => {
			await setup(true);
			await click(target, 1);
			await click(action("Ask Pi"));
			await evaluate(
				`window.__input = ${ui}.querySelector('.capsule:not(.selection) input'); __input.value='中文'; __input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); window.__capsule=__input.closest('.capsule'); window.__mutations=0; window.__observer=new MutationObserver(ms=>{__mutations+=ms.filter(m=>m.type==='childList').length}); __observer.observe(__capsule.parentElement,{childList:true,subtree:true});`,
			);
			await evaluate("window.scrollTo(0,1000)");
			await frames();
			assert.equal(await evaluate("__input.isConnected && __input.value==='中文'"), true);
			assert.equal(await evaluate("__capsule.style.display"), "none");
			assert.equal(
				await evaluate(`${ui}.querySelector('.box:not(.preview)').style.display`),
				"none",
			);
			assert.equal(await evaluate("__mutations"), 0);
			await evaluate(
				"__input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));",
			);
			assert.equal(await evaluate("__sent.filter(m=>m.method==='relay.send').length"), 0);
			await evaluate("window.scrollTo(0,0)");
			await frames();
			await evaluate(
				"__input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); __input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); __observer.disconnect();",
			);
			assert.equal(await evaluate("__sent.find(m=>m.method==='relay.send').user_note"), "中文");
		},
	);

	await t.test("persistent preview, giant-container filter, and drag-selection guard", async () => {
		await setup(true);
		await click(action("Pick"));
		await evaluate(
			`window.__preview=${ui}.querySelector('.preview'); var target=document.querySelector('#text'); for(let i=0;i<20;i++) target.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:100,clientY:240}));`,
		);
		await frames();
		assert.equal(await evaluate(`${ui}.querySelectorAll('.preview').length`), 1);
		assert.equal(await evaluate("__preview.style.display"), "block");
		await evaluate(
			"var target=document.querySelector('#text');target.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:80,clientY:230,button:0}));target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:100,clientY:230,button:0}));",
		);
		assert.equal(
			await evaluate(`${ui}.querySelector('summary').textContent`),
			"Pinned Elements (0)",
		);
		await evaluate(
			"window.scrollTo(0,800);document.querySelector('#giant').dispatchEvent(new MouseEvent('mousemove',{bubbles:true}));",
		);
		await frames();
		assert.equal(await evaluate("__preview.style.display"), "none");
	});

	await t.test(
		"selection ask/run/pin, threaded replies, activity, confirmation and follow-up",
		async () => {
			await setup(true);
			async function select(selector) {
				await evaluate(
					`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=document.createRange();r.selectNodeContents(el);window.getSelection().removeAllRanges();window.getSelection().addRange(r);el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));})()`,
				);
				await frames();
			}
			await select("#text");
			assert.equal(await evaluate(`${ui}.querySelector('.selection').hidden`), false);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.selection button')[1].hidden`), true);
			assert.equal(
				await evaluate(`${ui}.querySelectorAll('.selection-highlight').length > 0`),
				true,
			);
			await click(action("Ask Pi"));
			assert.equal(
				await evaluate(`${ui}.querySelectorAll('.selection-highlight').length > 0`),
				true,
			);
			await evaluate(
				`var f=${ui}.querySelector('.selection form');f.input.value='Explain';f.requestSubmit();`,
			);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.selection-highlight').length`), 0);
			const sent = await evaluate("__sent.find(m=>m.method==='relay.send')");
			assert.equal(sent.action, "ask");
			assert.match(sent.raw_text, /helpful paragraph/);
			assert.equal(sent.user_note, "Explain");
			await message({
				method: "annotate.relay_event",
				thread_id: sent.thread_id,
				status: "running",
			});
			assert.match(await evaluate(`${ui}.querySelector('.progress').textContent`), /Thinking/);
			await message({ method: "annotate.agent_activity", command: "read_file", ts: 1 });
			assert.equal(
				await evaluate(`${ui}.querySelector('.activity').textContent`),
				"Agent: read_file",
			);
			await message({
				method: "annotate.relay_event",
				thread_id: sent.thread_id,
				status: "confirm",
				message:
					"### Check this\n1. **Bold** and `inline`\n```sh\necho safe\n```\n<script>unsafe</script>",
				from_label: "Pi",
			});
			assert.equal(await evaluate(`${ui}.querySelectorAll('.reply script').length`), 0);
			assert.equal(
				await evaluate(`${ui}.querySelector('.reply .md-h3')?.textContent`),
				"Check this",
			);
			assert.equal(await evaluate(`${ui}.querySelector('.reply strong')?.textContent`), "Bold");
			assert.equal(await evaluate(`${ui}.querySelector('.reply .md-code')?.textContent`), "inline");
			await click(action("Copy"));
			assert.equal(await evaluate("__copied"), "echo safe\n");
			await click(action("Approve"));
			assert.deepEqual(
				await evaluate(
					"(()=>{const m=__sent.filter(m=>m.method==='relay.send').at(-1);return [m.action,m.thread_id]})()",
				),
				["approve", sent.thread_id],
			);
			await evaluate(
				`var f=${ui}.querySelector('.follow');f.input.value='Next';f.requestSubmit();`,
			);
			assert.equal(
				await evaluate("__sent.filter(m=>m.method==='relay.send').at(-1).thread_id"),
				sent.thread_id,
			);
			await message({
				method: "annotate.relay_event",
				thread_id: sent.thread_id,
				status: "done",
				message: "Finished",
			});
			assert.match(
				await evaluate(`${ui}.querySelectorAll('.progress')[2].textContent`),
				/Completed/,
			);
			await select("#code");
			assert.equal(await evaluate(`${ui}.querySelector('.selection .run').textContent`), "Run");
			await click(action("Run"));
			assert.equal(
				await evaluate("__sent.filter(m=>m.method==='relay.send').at(-1).action"),
				"run",
			);
			await select("#text");
			await click(action("Pin"));
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (1)",
			);
		},
	);

	await t.test(
		"dock drag/minimize stays on screen; offline cleanly switches to pin-only",
		async () => {
			await setup(true);
			const { x, y } = await evaluate(
				`(()=>{const r=${ui}.querySelector('.title').getBoundingClientRect();return {x:r.x+10,y:r.y+5}})()`,
			);
			await cdp(
				"Input.dispatchMouseEvent",
				{ type: "mousePressed", x, y, button: "left", clickCount: 1 },
				sessionId,
			);
			await cdp(
				"Input.dispatchMouseEvent",
				{ type: "mouseMoved", x: 30, y: 30, button: "left", buttons: 1 },
				sessionId,
			);
			await cdp(
				"Input.dispatchMouseEvent",
				{ type: "mouseReleased", x: 30, y: 30, button: "left", clickCount: 1 },
				sessionId,
			);
			assert.equal(await evaluate(`${ui}.querySelector('.dock').style.left`), "0px");
			assert.equal(
				await evaluate(
					`(()=>{const r=${ui}.querySelector('.dock').getBoundingClientRect();return r.x>=0 && r.y>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()`,
				),
				true,
			);
			assert.equal(
				await evaluate("Boolean(window.__localStore.annotate_site_layouts?.local)"),
				true,
			);
			assert.equal(
				await evaluate(`${ui}.querySelector('.dock').classList.contains('minimized')`),
				true,
			);
			await click(`${ui}.querySelector('[aria-label="Expand dock"]')`);
			assert.equal(
				await evaluate(`${ui}.querySelector('.dock').classList.contains('minimized')`),
				false,
			);
			await click(`${ui}.querySelector('[aria-label="Minimize dock"]')`);
			assert.equal(
				await evaluate(`${ui}.querySelector('.dock').getBoundingClientRect().height`),
				34,
			);
			await click(`${ui}.querySelector('[aria-label="Expand dock"]')`);
			await evaluate("__offline=true;");
			await evaluate(
				`var f=${ui}.querySelector('.follow');f.input.value='Are you there?';f.requestSubmit();`,
			);
			await frames();
			assert.match(
				await evaluate(`${ui}.querySelector('.banner').textContent`),
				/Session disconnected/,
			);
			assert.equal(await evaluate(`${ui}.querySelector('.title').textContent`), "Pin Mode");
			assert.equal(
				await evaluate(`${ui}.querySelector('section[aria-label="Live Thread"]').hidden`),
				false, // Preserve history even after leaving interactive mode.
			);
			await click("document.querySelector('#code')");
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (1)",
			);
			await message({
				method: "annotate.binding_changed",
				binding: {
					session_id: "session-b",
					label: "Codex",
					scope: "tab",
					tab_id: 12,
					window_id: 7,
				},
			});
			assert.equal(
				await evaluate(`${ui}.querySelector('.pick').getAttribute('aria-pressed')`),
				"false",
			);
			await click(action("Disconnect"));
			assert.equal(await evaluate("__sent.at(-1).method"), "session.unbind");
			assert.equal(
				await evaluate(`${ui}.querySelector('.dock').getBoundingClientRect().width`),
				270,
			);
		},
	);

	await t.test("dragged dock reclamps when live thread content grows", async () => {
		await setup(true);
		const { x, y } = await evaluate(
			`(()=>{const r=${ui}.querySelector('.title').getBoundingClientRect();return {x:r.x+8,y:r.y+5}})()`,
		);
		await cdp(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", x, y, button: "left", clickCount: 1 },
			sessionId,
		);
		await cdp(
			"Input.dispatchMouseEvent",
			{ type: "mouseMoved", x: 30, y: 740, button: "left", buttons: 1 },
			sessionId,
		);
		await cdp(
			"Input.dispatchMouseEvent",
			{ type: "mouseReleased", x: 30, y: 740, button: "left", clickCount: 1 },
			sessionId,
		);
		await evaluate(
			`var f=${ui}.querySelector('.follow');f.input.value='A new task';f.requestSubmit();`,
		);
		await frames();
		assert.equal(
			await evaluate(
				`(()=>{const r=${ui}.querySelector('.dock').getBoundingClientRect();return r.y>=0 && r.bottom<=innerHeight})()`,
			),
			true,
		);
	});

	await t.test(
		"element Run preserves full command text and only one capsule uses blur",
		async () => {
			await setup(true);
			await evaluate(
				"window.__rawCommand='npm test '+ 'x'.repeat(1400);document.querySelector('#code').textContent=__rawCommand;",
			);
			await click("document.querySelector('#code')", 1);
			await click(`${ui}.querySelector('.capsule:not(.selection) .run')`);
			assert.equal(
				await evaluate("__sent.find(m=>m.method==='relay.send').raw_text"),
				await evaluate("__rawCommand"),
			);
			await click(target, 1);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.capsule.active').length`), 1);
			assert.equal(
				await evaluate(
					`getComputedStyle(${ui}.querySelector('.capsule:not(.active):not(.selection)')).backdropFilter`,
				),
				"none",
			);
		},
	);

	await t.test("pending initialization preserves early pins and newer binding events", async () => {
		await setup(
			false,
			`window.__stored=[{ref:1,selector:'#code',name:'Earlier pin',text:'npm test',ts:1}]; window.__priorSend=chrome.runtime.sendMessage;chrome.runtime.sendMessage=msg=>msg.method==='annotations.get'?new Promise(resolve=>{window.__finishLoad=()=>resolve({refs:__stored})}):__priorSend(msg);`,
		);
		await click(target);
		assert.equal(
			await evaluate(`${ui}.querySelector('summary').textContent`),
			"Pinned Elements (1)",
		);
		await message({
			method: "annotate.binding_changed",
			binding: {
				session_id: "new-session",
				label: "Codex",
				scope: "tab",
				tab_id: 12,
				window_id: 7,
			},
		});
		await evaluate("__finishLoad()");
		await frames();
		assert.equal(
			await evaluate(`${ui}.querySelector('summary').textContent`),
			"Pinned Elements (2)",
		);
		assert.equal(await evaluate(`${ui}.querySelector('.title').textContent`), "Codex");
		assert.equal(
			await evaluate("__sent.filter(m=>m.method==='annotations.set').at(-1).refs.length"),
			2,
		);
		assert.equal(await evaluate(`${ui}.querySelectorAll('.capsule.active').length`), 0);
		assert.equal(
			await evaluate(
				`getComputedStyle(${ui}.querySelector('.capsule:not(.selection)')).backdropFilter`,
			),
			"none",
		);
		assert.equal(
			await evaluate(`getComputedStyle(${ui}.querySelector('.status-dot.bound')).width`),
			"6px",
		);
	});

	await t.test("confirmation cancellation and relay errors remain in the same thread", async () => {
		await setup(true);
		await evaluate(
			`var f=${ui}.querySelector('.follow');f.input.value='Question';f.requestSubmit();`,
		);
		const sent = await evaluate("__sent.find(m=>m.method==='relay.send')");
		await message({
			method: "annotate.relay_event",
			thread_id: sent.thread_id,
			status: "confirm",
			message: "Proceed?",
		});
		await click(action("Cancel"));
		assert.deepEqual(
			await evaluate(
				"(()=>{const m=__sent.filter(m=>m.method==='relay.send').at(-1);return [m.action,m.thread_id]})()",
			),
			["cancel", sent.thread_id],
		);
		await message({
			method: "annotate.relay_event",
			thread_id: sent.thread_id,
			status: "error",
			message: "Cancelled",
		});
		assert.equal(await evaluate(`${ui}.querySelectorAll('.progress .error').length`), 1);
		assert.match(await evaluate(`${ui}.querySelectorAll('.reply')[1].textContent`), /Cancelled/);
	});

	await t.test(
		"session switcher preserves thread affinity, input nodes, and surviving targets",
		async () => {
			await setup(true);
			const a = {
				session_id: "session-a",
				label: "Pi",
				scope: "tab",
				tab_id: 12,
				window_id: 7,
				active: false,
			};
			const b = {
				session_id: "session-b",
				label: "Codex",
				scope: "window",
				window_id: 7,
				active: true,
			};
			const c = {
				session_id: "session-c",
				label: "Claude",
				scope: "tab",
				tab_id: 12,
				window_id: 7,
				active: false,
			};
			await evaluate(
				`var f=${ui}.querySelector('.follow');f.input.value='Question for A';f.requestSubmit();`,
			);
			const original = await evaluate("__sent.find(m=>m.method==='relay.send')");
			await evaluate(
				`window.__cardInput=${ui}.querySelector('.card-follow input');__cardInput.value='中文 follow-up';__cardInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));`,
			);
			await message({ method: "annotate.binding_changed", binding: b, bindings: [a, b] });
			assert.equal(await evaluate(`${ui}.querySelector('.session-count').textContent`), "+1");
			assert.equal(await evaluate(`${ui}.querySelector('.head > button').hidden`), true);
			assert.equal(await evaluate(`${ui}.querySelector('.session-badge').textContent`), "Pi");
			assert.equal(await evaluate(`${ui}.querySelector('.session-badge').title`), "Pi");
			assert.equal(
				await evaluate("__cardInput.isConnected && __cardInput.value==='中文 follow-up'"),
				true,
			);
			await click(`${ui}.querySelector('[aria-label="Select active session"]')`);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.session-row').length`), 2);
			assert.deepEqual(
				await evaluate(`[...${ui}.querySelectorAll('.scope')].map(el=>el.textContent)`),
				["Tab · ready", "Win · ready"],
			);
			await click(action("Set Active"));
			assert.equal(
				await evaluate("__sent.filter(m=>m.method==='session.select_binding').at(-1).session_id"),
				"session-a",
			);
			await click(action("Set Active"));
			assert.equal(
				await evaluate("__sent.filter(m=>m.method==='session.select_binding').at(-1).session_id"),
				"session-b",
			);
			await evaluate(
				"__cardInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));",
			);
			assert.equal(await evaluate("__sent.filter(m=>m.method==='relay.send').length"), 1);
			await evaluate(
				"__cardInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));__cardInput.form.requestSubmit();",
			);
			assert.deepEqual(
				await evaluate(
					"(()=>{const m=__sent.filter(m=>m.method==='relay.send').at(-1);return [m.session_id,m.thread_id]})()",
				),
				["session-a", original.thread_id],
			);
			await evaluate(
				`var f=${ui}.querySelector('.follow');f.input.value='New question for B';f.requestSubmit();`,
			);
			assert.equal(
				await evaluate("__sent.filter(m=>m.method==='relay.send').at(-1).session_id"),
				"session-b",
			);
			assert.equal(
				await evaluate(`${ui}.querySelectorAll('.session-badge')[2].textContent`),
				"Codex",
			);
			await message({
				method: "annotate.agent_activity",
				session_id: "session-b",
				command: "read_file",
			});
			await message({
				method: "annotate.relay_event",
				thread_id: original.thread_id,
				session_id: "session-a",
				status: "done",
				message: "Answer from A",
			});
			assert.match(
				await evaluate(`${ui}.querySelectorAll('.reply')[1].textContent`),
				/Answer from A/,
			);
			assert.equal(
				await evaluate(`${ui}.querySelector('.activity').textContent`),
				"Agent: read_file",
			);
			await click(`${ui}.querySelector('.session-row').querySelectorAll('button')[1]`);
			assert.equal(
				await evaluate(`${ui}.querySelector('[aria-label="Select active session"]')===null`),
				true,
			);
			assert.equal(await evaluate(`${ui}.querySelector('.disconnect').hidden`), false);
			await evaluate(
				"__cardInput.value='Try disconnected owner';__cardInput.form.requestSubmit();",
			);
			await frames();
			assert.equal(await evaluate(`${ui}.querySelector('.title').textContent`), "Codex");
			assert.equal(
				await evaluate(`${ui}.querySelector('section[aria-label="Live Thread"]').hidden`),
				false,
			);
			assert.equal(await evaluate("__cardInput.value"), "Try disconnected owner");
			assert.equal(
				await evaluate("__cardInput.form.querySelector('button[type=submit]').disabled"),
				true,
			);
			assert.equal(await evaluate("__sent.filter(m=>m.method==='relay.send').length"), 3);
			await message({ method: "annotate.binding_changed", binding: b, bindings: [a, b, c] });
			await click(`${ui}.querySelector('[aria-label="Select active session"]')`);
			await click(action("Disconnect All"));
			assert.equal(await evaluate(`${ui}.querySelector('.title').textContent`), "Pin Mode");
			assert.deepEqual(
				await evaluate(
					"__sent.filter(m=>m.method==='session.unbind').slice(-3).map(m=>m.session_id).sort()",
				),
				["session-a", "session-b", "session-c"],
			);
		},
	);

	await t.test(
		"health transitions gate all remote actions, preserve drafts, and restore Pin Mode",
		async () => {
			await setup(true);
			await click(`${ui}.querySelector('[aria-label="Expand dock"]')`);
			await evaluate(
				`var f=${ui}.querySelector('.follow'); f.input.value='First question'; f.requestSubmit();`,
			);
			await frames();
			await evaluate(
				`var f=${ui}.querySelector('.follow'); f.input.value='未发送的草稿'; window.__draftInput=f.input;`,
			);
			const count = await evaluate("__sent.filter(m=>m.method==='relay.send').length");
			const unknown = {
				session_id: "session-a",
				label: "Pi",
				scope: "tab",
				health: { state: "unknown", reason: "HOST_DISCONNECTED" },
			};
			await message({ method: "annotate.binding_changed", binding: unknown, bindings: [unknown] });
			assert.equal(
				await evaluate(`${ui}.querySelector('.dock').classList.contains('bound')`),
				true,
			);
			assert.equal(
				await evaluate("__draftInput.isConnected && __draftInput.value==='未发送的草稿'"),
				true,
			);
			assert.equal(
				await evaluate(`[...${ui}.querySelectorAll('[data-relay-target]')].every(b=>b.disabled)`),
				true,
			);
			assert.equal(
				await evaluate(`${ui}.querySelector('.follow button[type=submit]').disabled`),
				true,
			);
			await evaluate("__draftInput.form.requestSubmit()");
			assert.equal(await evaluate("__sent.filter(m=>m.method==='relay.send').length"), count);
			await click(target);
			assert.equal(await evaluate("__pageClicks"), 1); // Unknown must not turn ordinary clicks into pins.
			const offline = { ...unknown, health: { state: "offline", reason: "SESSION_UNREGISTERED" } };
			await message({ method: "annotate.binding_changed", binding: offline, bindings: [offline] });
			assert.equal(
				await evaluate(`${ui}.querySelector('.dock').classList.contains('bound')`),
				false,
			);
			assert.equal(await evaluate(`${ui}.querySelector('.title').textContent`), "Pin Mode");
			assert.equal(await evaluate("__draftInput.value"), "未发送的草稿");
			await click(target);
			assert.equal(await evaluate("__pageClicks"), 1);
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (1)",
			);
			assert.equal(
				await evaluate(
					`${ui}.querySelectorAll('.capsule:not(.selection) [data-relay-target]').length`,
				),
				0,
			);
			const ready = { ...unknown, health: { state: "ready", valid_until: Date.now() + 60000 } };
			await message({ method: "annotate.binding_changed", binding: ready, bindings: [ready] });
			assert.equal(
				await evaluate(`${ui}.querySelector('.follow button[type=submit]').disabled`),
				false,
			);
			assert.equal(await evaluate("__draftInput.value"), "未发送的草稿");
			assert.equal(await evaluate("__sent.filter(m=>m.method==='relay.send').length"), count);
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (1)",
			);
		},
	);

	await t.test(
		"acceptance is not running, and replacing receiver identity blocks old thread actions",
		async () => {
			await setup(true);
			await evaluate(
				`var f=${ui}.querySelector('.follow'); f.input.value='Question'; f.requestSubmit();`,
			);
			await frames();
			const sent = await evaluate("__sent.find(m=>m.method==='relay.send')");
			await message({
				method: "annotate.relay_event",
				thread_id: sent.thread_id,
				status: "accepted",
			});
			assert.match(await evaluate(`${ui}.querySelector('.progress').textContent`), /Accepted/);
			assert.equal(
				await evaluate(`${ui}.querySelector('.progress').classList.contains('busy')`),
				false,
			);
			const replacement = {
				session_id: "session-a",
				label: "Pi",
				scope: "tab",
				receiver_epoch: "replacement",
			};
			await message({
				method: "annotate.binding_changed",
				binding: replacement,
				bindings: [replacement],
			});
			await evaluate(
				`var input=${ui}.querySelector('.card-follow input'); input.value='Old thread'; input.form.requestSubmit();`,
			);
			assert.equal(await evaluate("__sent.filter(m=>m.method==='relay.send').length"), 1);
			assert.equal(await evaluate(`${ui}.querySelector('.card-follow input').value`), "Old thread");
		},
	);

	await t.test(
		"injection does not enumerate/mutate page refs; stored selector pins restore lazily",
		async () => {
			await setup(
				false,
				`window.__queries=0;const original=document.querySelectorAll.bind(document);document.querySelectorAll=(...args)=>{__queries++;return original(...args)};window.__stored=[{ref:9,selector:'#code',name:'Stored command',text:'npm test',ts:1}];`,
			);
			assert.equal(await evaluate("__queries"), 0);
			assert.equal(
				await evaluate("document.querySelector('#target').hasAttribute('data-ap-ref')"),
				false,
			);
			assert.equal(
				await evaluate(`${ui}.querySelector('summary').textContent`),
				"Pinned Elements (1)",
			);
			assert.equal(await evaluate(`${ui}.querySelectorAll('.capsule:not(.selection)').length`), 1);
			await message({ method: "annotate.binding_changed", binding: null });
			assert.match(await evaluate(`${ui}.querySelector('.banner').textContent`), /Pin-Only/);
		},
	);
});
