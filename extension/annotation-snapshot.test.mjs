import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { runtimeEvaluateValue } from "./runtime-helpers.mjs";
import { STATE_ELEMENT_SELECTOR, STATE_MAX_REFS } from "./state-snapshot.mjs";

const background = await readFile(new URL("./background.js", import.meta.url), "utf8");
const start = background.indexOf("async function attachUserAnnotations(");
const source = background.slice(start, background.indexOf("// ─── annotation mode toggle", start));

function element(ref, x, y, w = 100, h = 30) {
	return {
		getAttribute: (name) => (name === "data-ap-ref" ? String(ref) : null),
		getBoundingClientRect: () => ({
			x,
			y,
			left: x,
			top: y,
			right: x + w,
			bottom: y + h,
			width: w,
			height: h,
		}),
	};
}

async function annotate(stored, elements, nodes, selectors) {
	const page = {
		innerWidth: 1000,
		innerHeight: 800,
		document: {
			querySelectorAll: () => nodes,
			querySelector: (selector) => selectors[selector] || null,
		},
	};
	const chrome = {
		storage: {
			session: {
				async get(key) {
					return { [key]: stored };
				},
			},
		},
		debugger: {
			async sendCommand(target, method, params) {
				assert.equal(target.tabId, 12);
				assert.equal(method, "Runtime.evaluate");
				return { result: { value: vm.runInNewContext(params.expression, page) } };
			},
		},
	};
	const context = vm.createContext({
		chrome,
		runtimeEvaluateValue,
		STATE_ELEMENT_SELECTOR,
		STATE_MAX_REFS,
	});
	vm.runInContext(source, context);
	const data = { elements };
	await context.attachUserAnnotations(12, data);
	return JSON.parse(JSON.stringify(data));
}

test("snapshot annotations resolve lazy UI refs by selector and refresh noninteractive geometry", async () => {
	const first = element(250, 20, 30);
	const second = element(1, 40, 100);
	const code = element(251, 60, 170, 300, 80);
	const stale = { ref: 250, selector: "#first", x: 999, y: 999 };
	const data = await annotate(
		[
			stale,
			{ ref: 251, selector: "#code", x: 999, y: 999 },
			{ ref: 1 }, // Legacy ref-only records remain supported.
			{ ref: 0, selector: "#removed", x: 999, y: 999 },
		],
		[
			{ ref: 0, x: 20, y: 30, w: 100, h: 30 },
			{ ref: 1, x: 40, y: 100, w: 100, h: 30 },
		],
		[first, second],
		{
			"#first": first,
			"#code": code,
			'[data-ap-ref="1"]': second,
		},
	);
	assert.equal(data.annotated[0].ref, 0);
	assert.equal(data.elements[0].user, true);
	assert.equal(data.elements[1].user, true);
	assert.deepEqual(data.elements[2], { x: 60, y: 170, w: 300, h: 80, user: true });
	assert.equal(data.annotated[1].ref, null);
	assert.equal(data.annotated[3].x, null);
	assert.equal(data.elements.length, 3); // Removed pins must not draw stale geometry.
	assert.equal(stale.ref, 250); // Returned snapshot refs do not mutate UI/storage identities.
});

test("nested shadow pins resolve their own roots instead of duplicate document selectors", async () => {
	const outside = element(0, 10, 20);
	const first = element(250, 40, 100);
	const second = element(251, 40, 200);
	const leafHost = (node) => ({
		shadowRoot: { querySelector: (s) => (s === "#text" ? node : null) },
	});
	const hosts = { "#a": leafHost(first), "#b": leafHost(second) };
	const comments = { shadowRoot: { querySelector: (s) => hosts[s] || null } };
	const data = await annotate(
		[
			{ ref: 250, selector: "#text", shadow_hosts: ["#comments", "#a"] },
			{ ref: 251, selector: "#text", shadow_hosts: ["#comments", "#b"] },
			{ ref: 252, selector: "#text", shadow_hosts: ["#comments", "#gone"] },
		],
		[{ ref: 0, x: 10, y: 20, w: 100, h: 30 }],
		[outside],
		{ "#text": outside, "#comments": comments },
	);
	assert.equal(data.elements[0].user, undefined);
	assert.deepEqual(
		data.annotated.map((a) => [a.x, a.y]),
		[
			[40, 100],
			[40, 200],
			[null, null],
		],
	);
	assert.equal(data.elements.length, 3);
});

test("layout drift never marks an unrelated fresh snapshot ref", async () => {
	const moved = element(0, 80, 90);
	const data = await annotate(
		[{ ref: 0, selector: "#moved" }],
		[{ ref: 0, x: 20, y: 30, w: 100, h: 30 }],
		[moved],
		{ "#moved": moved },
	);
	assert.equal(data.elements[0].user, undefined);
	assert.equal(data.annotated[0].ref, null);
	assert.deepEqual(data.elements[1], { x: 80, y: 90, w: 100, h: 30, user: true });
});
