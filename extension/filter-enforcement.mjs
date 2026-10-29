import { resolveSnapshotRef, snapshotIdentity } from "./state-snapshot.mjs";

// Include live form values without exposing passwords, hidden fields or file paths.
// For subtree reads values follow the rendered text; filters run before this reader.
export function readDomText(source) {
	if (!source) return "";
	const fieldValue = el => {
		const type = (el.getAttribute?.("type") || "").toLowerCase();
		if (["password", "hidden", "file", "checkbox", "radio", "submit", "button"].includes(type)) return "";
		return String(el.value ?? "");
	};
	if (["INPUT", "TEXTAREA"].includes(source.tagName)) return fieldValue(source);
	const text = String(source.innerText ?? source.textContent ?? "");
	const values = Array.from(source.querySelectorAll("input, textarea"), fieldValue).filter(Boolean);
	return [text, ...values].filter(Boolean).join("\n");
}

// Read-back only: numeric refs can live inside open shadow roots too.
export function readInteractionValue(documentObject, query) {
	const find = root => {
		const direct = root.querySelector(query);
		if (direct) return direct;
		for (const host of root.querySelectorAll("*")) {
			if (!host.shadowRoot) continue;
			const found = find(host.shadowRoot);
			if (found) return found;
		}
		return null;
	};
	const el = find(documentObject);
	return el?.value ?? el?.textContent ?? "";
}

const FILTER_COUNTER_KEYS = [
	"removed_nodes",
	"redacted_blocks",
	"denied_interactions",
	"invalid_selectors",
];

export function emptyFilterMetadata() {
	return {
		matched_policy_ids: [],
		removed_nodes: 0,
		redacted_blocks: 0,
		denied_interactions: 0,
		invalid_selectors: 0,
	};
}

export function hasFilterDiagnostics(metadata) {
	return Boolean(metadata && FILTER_COUNTER_KEYS.some((key) => Number(metadata[key] || 0) > 0));
}

export function mergeFilterMetadata(...items) {
	const merged = emptyFilterMetadata();
	const policyIds = new Set();
	for (const item of items) {
		if (!item) continue;
		for (const policyId of item.matched_policy_ids || []) {
			if (typeof policyId === "string" && policyId) policyIds.add(policyId);
		}
		for (const key of FILTER_COUNTER_KEYS) {
			merged[key] += Number(item[key] || 0);
		}
	}
	merged.matched_policy_ids = [...policyIds];
	return merged;
}

function policyId(policy) {
	if (typeof policy?.policy_id === "string" && policy.policy_id) {
		return policy.policy_id;
	}
	if (typeof policy?.site === "string" && typeof policy?.name === "string") {
		return `${policy.site}/${policy.name}`;
	}
	return "unknown/unknown";
}

function pathGlobMatches(pattern, pathname) {
	if (typeof pattern !== "string" || typeof pathname !== "string") return false;
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`).test(pathname);
}

export function matchingPolicies(policies, operatedUrl, method) {
	if (!Array.isArray(policies) || policies.length === 0) return [];
	let url;
	try {
		url = new URL(operatedUrl);
	} catch (_) {
		return [];
	}
	return policies.filter((policy) => {
		const match = policy?.match;
		if (!match || !Array.isArray(match.origins) || !Array.isArray(match.paths)) {
			return false;
		}
		const originMatches = match.origins.some((origin) => {
			try {
				return new URL(origin).origin === url.origin;
			} catch (_) {
				return false;
			}
		});
		if (!originMatches) return false;
		if (!match.paths.some((pattern) => pathGlobMatches(pattern, url.pathname))) return false;
		return (
			!Array.isArray(match.methods) || match.methods.length === 0 || match.methods.includes(method)
		);
	});
}

export function shouldFilterOuterResponse(method) {
	return method !== "batch";
}

export async function resolveFilterOperationTab(operatedTab, params, resolveTab) {
	if (operatedTab) return operatedTab;
	return resolveTab(params);
}

export async function resolveBatchStepTab(stepMethod, stepParams, resolveTab) {
	if (stepMethod === "ping" || stepMethod === "info") return null;
	return resolveTab(stepParams);
}

function rulesFor(policies, section, field) {
	if (!Array.isArray(policies)) return [];
	return policies.flatMap((policy) => {
		const values = policy?.[section]?.[field];
		if (!Array.isArray(values) || values.length === 0) return [];
		return [{ policy_id: policyId(policy), [field]: values }];
	});
}

export function domDropRules(policies) {
	return rulesFor(policies, "dom", "drop_selectors").map((rule) => ({
		policy_id: rule.policy_id,
		selectors: rule.drop_selectors,
	}));
}

export function interactionDenyRules(policies) {
	return rulesFor(policies, "interaction", "deny_selectors").map((rule) => ({
		policy_id: rule.policy_id,
		selectors: rule.deny_selectors,
	}));
}

export function interactionOutcome(resultValue, guarded) {
	// Resolve helpers always return {status: ok|not_found|denied} — honor it
	// in BOTH branches. The old unguarded branch only checked truthiness, so a
	// `{status:"not_found"}` object (truthy!) passed as "ok" and click/fill
	// reported success on selectors that matched nothing.
	if (resultValue?.status === "denied") return "denied";
	if (resultValue?.status) return resultValue.status === "ok" ? "ok" : "not_found";
	if (guarded) return "not_found"; // fail closed
	return resultValue ? "ok" : "not_found"; // legacy truthy-primitive callers
}

// This function is serialized into Runtime.evaluate. Keep it self-contained
// except for emptyFilterMetadata, which the expression builder injects.
export function filterDomSubtree(source, rules, kind) {
	const metadata = emptyFilterMetadata();
	if (!source) return { value: "", metadata };

	const clone = source.cloneNode(true);
	const nodesToRemove = new Set();
	let removeRoot = false;
	const matchedPolicyIds = new Set();

	for (const rule of rules || []) {
		let policyAffected = false;
		for (const selector of rule.selectors || []) {
			try {
				if (clone.matches(selector)) {
					removeRoot = true;
					nodesToRemove.add(clone);
					policyAffected = true;
				}
				for (const node of clone.querySelectorAll(selector)) {
					nodesToRemove.add(node);
					policyAffected = true;
				}
			} catch (_) {
				metadata.invalid_selectors += 1;
				policyAffected = true;
			}
		}
		if (policyAffected) matchedPolicyIds.add(rule.policy_id);
	}

	metadata.matched_policy_ids = [...matchedPolicyIds];
	metadata.removed_nodes = nodesToRemove.size;
	if (removeRoot) return { value: "", metadata };
	for (const node of nodesToRemove) node.remove();

	const value =
		kind === "html"
			? String(clone.outerHTML ?? "")
			: readDomText(clone);
	return { value, metadata };
}

export function buildDomReadExpression(selector, kind, rules) {
	return `(() => {
    const emptyFilterMetadata = ${emptyFilterMetadata.toString()};
    const readDomText = ${readDomText.toString()};
    const filterDomSubtree = ${filterDomSubtree.toString()};
    const source = document.querySelector(${JSON.stringify(selector)});
    return filterDomSubtree(source, ${JSON.stringify(rules)}, ${JSON.stringify(kind)});
  })()`;
}

function redactString(value, block) {
	const start = block?.start;
	const end = block?.end;
	if (
		typeof start !== "string" ||
		start.length === 0 ||
		typeof end !== "string" ||
		end.length === 0
	) {
		return { value, count: 0 };
	}
	const replacement = typeof block.replacement === "string" ? block.replacement : "[FILTERED]";
	let cursor = 0;
	let output = "";
	let count = 0;
	while (cursor < value.length) {
		const startIndex = value.indexOf(start, cursor);
		if (startIndex < 0) break;
		const endIndex = value.indexOf(end, startIndex + start.length);
		if (endIndex < 0) break;
		output += value.slice(cursor, startIndex);
		output += replacement;
		cursor = endIndex + end.length;
		count += 1;
	}
	if (count === 0) return { value, count: 0 };
	output += value.slice(cursor);
	return { value: output, count };
}

export function redactResult(value, policies) {
	const metadata = emptyFilterMetadata();
	const blocks = rulesFor(policies, "result", "redact_blocks");
	const matchedPolicyIds = new Set();

	const visit = (current) => {
		if (typeof current === "string") {
			let filtered = current;
			for (const rule of blocks) {
				for (const block of rule.redact_blocks) {
					const result = redactString(filtered, block);
					filtered = result.value;
					if (result.count > 0) {
						metadata.redacted_blocks += result.count;
						matchedPolicyIds.add(rule.policy_id);
					}
				}
			}
			return filtered;
		}
		if (Array.isArray(current)) return current.map(visit);
		if (current && typeof current === "object") {
			return Object.fromEntries(
				Object.entries(current).map(([key, nested]) => [key, visit(nested)]),
			);
		}
		return current;
	};

	const filteredValue = visit(value);
	metadata.matched_policy_ids = [...matchedPolicyIds];
	return { value: filteredValue, metadata };
}

// This function is serialized into Runtime.evaluate. Keep it self-contained
// except for emptyFilterMetadata, which the expression builder injects.
// Shared filter guard for interaction targets: resolves the element and
// applies deny rules. Returns {target, metadata} or {denied: true, metadata}.
// Serialized into Runtime.evaluate expressions, so it must stay
// self-contained (emptyFilterMetadata is injected by the builder).
export function guardInteractionTarget(documentObject, targetSelector, rules, options = {}) {
	const metadata = emptyFilterMetadata();
	let target;
	if (options.ref != null) {
		const resolved = resolveSnapshotRef(documentObject, options.ref);
		if (resolved.error) return { ...resolved, metadata };
		target = resolved.target;
	} else {
		try {
			if (/^text=|:has-text\(/.test(targetSelector)) throw new SyntaxError("unsupported text selector");
			target = documentObject.querySelector(targetSelector);
		} catch (_) {
			return { error: { code: "INVALID_SELECTOR", message: "Use a CSS selector or a numeric state ref; text= and :has-text() are not supported" }, metadata };
		}
	}
	if (!target) return { target: null, metadata };
	if (options.expect_text != null) {
		const name = String(target.getAttribute?.("aria-label") || target.innerText || target.textContent || "").replace(/\s+/g, " ").trim();
		if (name !== String(options.expect_text).replace(/\s+/g, " ").trim())
			return { error: { code: "TEXT_MISMATCH", message: "Target label does not match --expect-text; run state again" }, metadata };
	}

	const deniedPolicyIds = new Set();
	for (const rule of rules || []) {
		let invalidForPolicy = false;
		for (const selector of rule.selectors || []) {
			try {
				for (let node = target; node; node = node.getRootNode?.()?.host) {
					if (node.matches(selector) || node.closest?.(selector)) deniedPolicyIds.add(rule.policy_id);
				}
			} catch (_) {
				metadata.invalid_selectors += 1;
				invalidForPolicy = true;
			}
		}
		if (invalidForPolicy) metadata.matched_policy_ids.push(rule.policy_id);
	}

	if (deniedPolicyIds.size > 0) {
		metadata.matched_policy_ids = [
			...new Set([...metadata.matched_policy_ids, ...deniedPolicyIds]),
		];
		metadata.denied_interactions = 1;
		return { denied: true, metadata };
	}
	return { target, metadata };
}

// Resolve-only variant for native-input clicks: filter guard + scrollIntoView,
// returning the element's viewport rect so the extension can dispatch real CDP
// mouse events (Input.dispatchMouseEvent) at the element center. SPA custom
// controls (Reddit, Radix/MUI) react to pointer/mouse events that el.click()
// never synthesizes.
export function resolveForNativeClick(documentObject, targetSelector, rules, options = {}) {
	const guard = guardInteractionTarget(documentObject, targetSelector, rules, options);
	if (guard.error) return { status: "error", error: guard.error, metadata: guard.metadata };
	if (guard.denied) return { status: "denied", metadata: guard.metadata };
	const target = guard.target;
	if (!target) return { status: "not_found", metadata: guard.metadata };

	// Snapshot refs are already in the viewport. Scrolling them would invalidate
	// their geometry between resolution and the input-time revalidation.
	if (options.ref == null) target.scrollIntoView({ block: "center", behavior: "instant" });
	const r = target.getBoundingClientRect();
	const style = documentObject.defaultView?.getComputedStyle(target);
	if (r.width < 1 || r.height < 1 || style?.visibility === "hidden" || style?.display === "none" || style?.opacity === "0")
		return { status: "error", error: { code: "NOT_VISIBLE", message: "Target is not visible" }, metadata: guard.metadata };
	if (target.disabled)
		return { status: "error", error: { code: "NOT_INTERACTABLE", message: "Target is disabled" }, metadata: guard.metadata };
	// Hit-test the element center: real input events land on whatever is
	// topmost there, so only use them when that is the target or one of its
	// descendants. Wrapper cards / overlays covering the center (Reddit's
	// community-highlight-card, tooltip layers) would swallow the click —
	// those must go through el.click(), which ignores hit-testing.
	const cx = r.x + r.width / 2;
	const cy = r.y + r.height / 2;
	let hitOk = false;
	if (r.width >= 1 && r.height >= 1 && cx >= 0 && cy >= 0) {
		let hit = documentObject.elementFromPoint(cx, cy);
		while (hit?.shadowRoot?.elementFromPoint) {
			const inner = hit.shadowRoot.elementFromPoint(cx, cy);
			if (!inner || inner === hit) break;
			hit = inner;
		}
		hitOk = hit === target || target.contains(hit);
	}
	if (options.ref != null && !hitOk)
		return { status: "error", error: { code: "ELEMENT_OBSCURED", message: "Target is covered; run state again" }, metadata: guard.metadata };
	if (options.consume) (documentObject.defaultView || window).__apBrowserRefs?.entries.clear();
	if (options.js_click) target.click();
	return {
		status: "ok",
		metadata: guard.metadata,
		x: r.x,
		y: r.y,
		w: r.width,
		h: r.height,
		hitOk,
	};
}

// Resolve-only variant for native-typing fill: filter guard + scrollIntoView
// + focus + select existing content, so the extension can replace it with
// Input.insertText (real keystrokes — works for <input>, <textarea>, AND
// contenteditable, which el.value assignment can't touch).
export function resolveForNativeFill(documentObject, targetSelector, rules, options = {}) {
	const guard = guardInteractionTarget(documentObject, targetSelector, rules, options);
	if (guard.error) return { status: "error", error: guard.error, metadata: guard.metadata };
	if (guard.denied) return { status: "denied", metadata: guard.metadata };
	const target = guard.target;
	if (!target) return { status: "not_found", metadata: guard.metadata };

	if (options.consume) (documentObject.defaultView || window).__apBrowserRefs?.entries.clear();
	target.scrollIntoView({ block: "center", behavior: "instant" });
	target.focus();
	// Select existing content so native insertion replaces it.
	try {
		if (typeof target.select === "function") {
			target.select();
		} else {
			const sel = documentObject.getSelection();
			const range = documentObject.createRange();
			range.selectNodeContents(target);
			sel.removeAllRanges();
			sel.addRange(range);
		}
	} catch (_) {}
	return { status: "ok", metadata: guard.metadata };
}

function interactionPrelude() {
	return `const emptyFilterMetadata = ${emptyFilterMetadata.toString()};
    const snapshotIdentity = ${snapshotIdentity.toString()};
    const resolveSnapshotRef = ${resolveSnapshotRef.toString()};
    const guardInteractionTarget = ${guardInteractionTarget.toString()};`;
}

export function buildNativeClickResolveExpression(targetSelector, rules, options = {}) {
	return `(() => {
    ${interactionPrelude()}
    const resolveForNativeClick = ${resolveForNativeClick.toString()};
    return resolveForNativeClick(
      document,
      ${JSON.stringify(targetSelector)},
      ${JSON.stringify(rules)},
      ${JSON.stringify(options)}
    );
  })()`;
}

export function buildNativeFillResolveExpression(targetSelector, rules, options = {}) {
	return `(() => {
    ${interactionPrelude()}
    const resolveForNativeFill = ${resolveForNativeFill.toString()};
    return resolveForNativeFill(
      document,
      ${JSON.stringify(targetSelector)},
      ${JSON.stringify(rules)},
      ${JSON.stringify(options)}
    );
  })()`;
}

// Native <select> dropdowns are OS-level widgets — CDP input events can't
// open or click them, so selecting happens by DOM mutation (opencli's
// approach): match the option by exact value or visible label, set it, and
// dispatch a bubbling change so React/Vue listeners fire.
export function performNativeSelect(documentObject, targetSelector, rules, want, options = {}) {
	const guard = guardInteractionTarget(documentObject, targetSelector, rules, options);
	if (guard.error) return { status: "error", error: guard.error, metadata: guard.metadata };
	if (guard.denied) return { status: "denied", metadata: guard.metadata };
	const target = guard.target;
	if (!target) return { status: "not_found", metadata: guard.metadata };

	const tag = target.tagName ? target.tagName.toUpperCase() : "";
	if (tag !== "SELECT") return { status: "not_a_select", metadata: guard.metadata };

	target.scrollIntoView({ block: "center" });
	target.focus();
	const choices = Array.from(target.options || []);
	const available = choices.map((o) => ({
		value: o.value,
		label: (o.textContent || "").trim(),
	}));
	const wantStr = String(want ?? "").trim();
	let picked = null;
	for (let i = 0; i < choices.length; i++) {
		const o = choices[i];
		const label = (o.textContent || "").trim();
		if (o.value === wantStr || label === wantStr) {
			picked = { index: i, value: o.value, label };
			break;
		}
	}
	if (!picked) {
		return {
			status: "option_not_found",
			metadata: guard.metadata,
			available,
		};
	}
	if (options.consume) (documentObject.defaultView || window).__apBrowserRefs?.entries.clear();
	target.selectedIndex = picked.index;
	target.dispatchEvent(new Event("change", { bubbles: true }));
	target.dispatchEvent(new Event("input", { bubbles: true }));
	return {
		status: "ok",
		metadata: guard.metadata,
		selected: { value: picked.value, label: picked.label },
	};
}

export function buildNativeSelectExpression(targetSelector, rules, want, options = {}) {
	return `(() => {
    ${interactionPrelude()}
    const performNativeSelect = ${performNativeSelect.toString()};
    return performNativeSelect(
      document,
      ${JSON.stringify(targetSelector)},
      ${JSON.stringify(rules)},
      ${JSON.stringify(want)},
      ${JSON.stringify(options)}
    );
  })()`;
}
