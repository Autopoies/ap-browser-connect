import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
	buildSnapshotExpression,
	isRefTarget,
	refSelector,
} from "./state-snapshot.mjs";

test("refSelector builds attribute query", () => {
	assert.equal(refSelector(12), '[data-ap-ref="12"]');
});

test("isRefTarget: bare integers are refs, CSS is not", () => {
	assert.equal(isRefTarget("12"), true);
	assert.equal(isRefTarget("0"), true);
	assert.equal(isRefTarget("button.x"), false);
	assert.equal(isRefTarget("#main"), false);
	assert.equal(isRefTarget(""), false);
});

test("snapshot expression is syntactically valid and self-contained", () => {
	const expr = buildSnapshotExpression();
	assert.ok(expr.startsWith("(() =>"));
	assert.ok(expr.includes("data-ap-ref"));
	assert.ok(expr.includes("JSON.stringify"));
	assert.ok(expr.includes("vw:")); // CLI annotation scale source
	// vm.Script compiles without executing — pure syntax validation.
	assert.doesNotThrow(() => new vm.Script(expr));
});
