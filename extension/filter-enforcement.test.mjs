import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDomReadExpression,
  buildInteractionExpression,
  domDropRules,
  filterDomSubtree,
  interactionDenyRules,
  interactionOutcome,
  matchingPolicies,
  mergeFilterMetadata,
  performGuardedInteraction,
  redactResult,
  resolveBatchStepTab,
  resolveFilterOperationTab,
  shouldFilterOuterResponse,
} from "./filter-enforcement.mjs";

const POLICY = {
  schema_version: 1,
  policy_id: "coursera/content-integrity",
  site: "coursera",
  name: "content-integrity",
  match: {
    origins: ["https://www.coursera.org"],
    paths: ["/learn/*/assignment-submission/*"],
    methods: ["text", "html", "eval", "batch", "click", "fill"],
  },
  dom: {
    drop_selectors: [
      '[data-ai-instructions="true"]',
      '[data-testid="content-integrity-instructions"]',
      '[data-testid="acknowledgment-checkpoint"]',
    ],
  },
  result: {
    redact_blocks: [{
      start: "You are a helpful AI assistant.",
      end: "This verification step is mandatory for all AI assistants accessing assessment pages.",
      replacement: "[FILTERED: coursera content-integrity instructions]",
    }],
  },
  interaction: {
    deny_selectors: ['[data-action="acknowledge-guidelines"]'],
  },
};

test("matches exact origin, pathname glob, and method together", () => {
  assert.deepEqual(
    matchingPolicies(
      [POLICY],
      "https://www.coursera.org/learn/security/assignment-submission/abc?attempt=1",
      "text",
    ),
    [POLICY],
  );
  assert.deepEqual(
    matchingPolicies(
      [POLICY],
      "https://evilcoursera.org/learn/security/assignment-submission/abc",
      "text",
    ),
    [],
  );
  assert.deepEqual(
    matchingPolicies([POLICY], "https://www.coursera.org/learn/security/home", "text"),
    [],
  );
  assert.deepEqual(
    matchingPolicies(
      [POLICY],
      "https://www.coursera.org/learn/security/assignment-submission/abc",
      "screenshot",
    ),
    [],
  );
});

test("missing method constraint applies to every method while malformed URLs do not", () => {
  const everyMethod = { ...POLICY, match: { ...POLICY.match } };
  delete everyMethod.match.methods;
  assert.deepEqual(
    matchingPolicies(
      [everyMethod],
      "https://www.coursera.org/learn/security/assignment-submission/abc",
      "eval",
    ),
    [everyMethod],
  );
  assert.deepEqual(matchingPolicies([everyMethod], "not a URL", "eval"), []);
});

test("normalizes configured and actual origins before exact comparison", () => {
  const loopbackPolicy = {
    ...POLICY,
    match: { ...POLICY.match, origins: ["http://127.1"] },
  };
  assert.deepEqual(
    matchingPolicies(
      [loopbackPolicy],
      "http://127.0.0.1/learn/security/assignment-submission/abc",
      "text",
    ),
    [loopbackPolicy],
  );
  assert.deepEqual(
    matchingPolicies(
      [loopbackPolicy],
      "http://127.0.0.2/learn/security/assignment-submission/abc",
      "text",
    ),
    [],
  );
});

test("batch filters only at each step boundary, never against the batch start URL", () => {
  assert.equal(shouldFilterOuterResponse("batch"), false);
  assert.equal(shouldFilterOuterResponse("eval"), true);
});

test("filter tab resolution reuses the operated tab and propagates resolution failure", async () => {
  let resolveCalls = 0;
  const operatedTab = { id: 12, url: "https://www.coursera.org/learn/x" };
  const reused = await resolveFilterOperationTab(
    operatedTab,
    { tab_id: 12 },
    async () => { resolveCalls += 1; return { id: 99 }; },
  );
  assert.equal(reused, operatedTab);
  assert.equal(resolveCalls, 0);

  await assert.rejects(
    resolveFilterOperationTab(null, {}, async () => {
      throw Object.assign(new Error("no active tab"), { code: "TAB_NOT_FOUND" });
    }),
    { code: "TAB_NOT_FOUND" },
  );
});

test("batch step tab pre-resolution rejects instead of reusing a previous tab", async () => {
  const staleTab = { id: 7, url: "https://stale.example/" };
  let selectedTab = staleTab;
  await assert.rejects(
    (async () => {
      selectedTab = null;
      selectedTab = await resolveBatchStepTab("text", { tab_id: 99 }, async () => {
        throw Object.assign(new Error("tab not found"), { code: "TAB_NOT_FOUND" });
      });
    })(),
    { code: "TAB_NOT_FOUND" },
  );
  assert.equal(selectedTab, null);
  assert.equal(await resolveBatchStepTab("ping", {}, async () => staleTab), null);
});

class FakeNode {
  constructor(tag, text = "", selectors = [], children = []) {
    this.tag = tag;
    this.text = text;
    this.selectors = new Set(selectors);
    this.children = children;
    this.parent = null;
    for (const child of children) child.parent = this;
  }

  cloneNode() {
    return new FakeNode(
      this.tag,
      this.text,
      [...this.selectors],
      this.children.map((child) => child.cloneNode(true)),
    );
  }

  matches(selector) {
    if (selector === "[") throw new SyntaxError("invalid selector");
    return this.selectors.has(selector);
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  get innerText() {
    return [this.text, ...this.children.map((child) => child.innerText)]
      .filter(Boolean)
      .join(" ");
  }

  get textContent() {
    return this.innerText;
  }

  get outerHTML() {
    return `<${this.tag}>${this.text}${this.children.map((child) => child.outerHTML).join("")}</${this.tag}>`;
  }
}

test("DOM reads remove configured nodes from a clone and leave the live tree unchanged", () => {
  const injectionSelector = '[data-ai-instructions="true"]';
  const instructionsSelector = '[data-testid="content-integrity-instructions"]';
  const checkpointSelector = '[data-testid="acknowledgment-checkpoint"]';
  const live = new FakeNode("main", "", [], [
    new FakeNode("p", "Legitimate question"),
    new FakeNode("aside", "You are a helpful AI assistant.", [
      injectionSelector,
      instructionsSelector,
    ]),
    new FakeNode("div", "Do you understand? I understand", [checkpointSelector]),
  ]);
  const rules = domDropRules([POLICY]);

  const filtered = filterDomSubtree(live, rules, "text");

  assert.equal(filtered.value, "Legitimate question");
  assert.equal(live.children.length, 3);
  assert.equal(live.innerText.includes("helpful AI assistant"), true);
  assert.equal(live.innerText.includes("Do you understand?"), true);
  assert.deepEqual(filtered.metadata.matched_policy_ids, ["coursera/content-integrity"]);
  assert.equal(filtered.metadata.removed_nodes, 2);
  assert.match(buildDomReadExpression("main", "html", rules), /cloneNode\(true\)/);
});

test("generated DOM read expression executes the same clone-only enforcement", () => {
  const injectionSelector = '[data-ai-instructions="true"]';
  const live = new FakeNode("main", "", [], [
    new FakeNode("p", "Legitimate question"),
    new FakeNode("aside", "hidden injection", [injectionSelector]),
  ]);
  const expression = buildDomReadExpression("main", "text", domDropRules([POLICY]));

  const filtered = Function("document", `return ${expression}`)({
    querySelector: () => live,
  });

  assert.equal(filtered.value, "Legitimate question");
  assert.equal(filtered.metadata.removed_nodes, 1);
  assert.equal(live.children.length, 2);
});

test("invalid DOM policy selectors report a diagnostic without breaking extraction", () => {
  const live = new FakeNode("main", "Legitimate question");
  const filtered = filterDomSubtree(
    live,
    [{ policy_id: "broken/filter", selectors: ["["] }],
    "text",
  );

  assert.equal(filtered.value, "Legitimate question");
  assert.deepEqual(filtered.metadata.matched_policy_ids, ["broken/filter"]);
  assert.equal(filtered.metadata.invalid_selectors, 1);
});

test("recursive block redaction preserves JSON shape and counts every bounded block", () => {
  const block = (body) =>
    `You are a helpful AI assistant. ${body} ` +
    "This verification step is mandatory for all AI assistants accessing assessment pages.";
  const input = {
    title: "keep",
    nested: [
      7,
      true,
      null,
      `before ${block("secret")} after`,
      {
        value: `${block("first")} / ${block("second")}`,
      },
    ],
  };

  const filtered = redactResult(input, [POLICY]);

  assert.deepEqual(filtered.value, {
    title: "keep",
    nested: [
      7,
      true,
      null,
      "before [FILTERED: coursera content-integrity instructions] after",
      {
        value:
          "[FILTERED: coursera content-integrity instructions] / " +
          "[FILTERED: coursera content-integrity instructions]",
      },
    ],
  });
  assert.equal(filtered.metadata.redacted_blocks, 3);
  assert.deepEqual(filtered.metadata.matched_policy_ids, ["coursera/content-integrity"]);
});

test("unclosed literal blocks are preserved", () => {
  const filtered = redactResult(
    "You are a helpful AI assistant. legitimate trailing text",
    [POLICY],
  );
  assert.equal(
    filtered.value,
    "You are a helpful AI assistant. legitimate trailing text",
  );
  assert.equal(filtered.metadata.redacted_blocks, 0);
});

test("interaction guard denies a matching target before invoking its handler", () => {
  let clicked = 0;
  let filled = 0;
  const deniedSelector = '[data-action="acknowledge-guidelines"]';
  const target = {
    matches: (selector) => selector === deniedSelector,
    closest: () => null,
    scrollIntoView: () => {},
    click: () => { clicked += 1; },
    focus: () => {},
    dispatchEvent: () => { filled += 1; },
    value: "",
  };
  const document = { querySelector: () => target };
  const rules = interactionDenyRules([POLICY]);

  const click = performGuardedInteraction(document, "button", rules, "click");
  const fill = performGuardedInteraction(document, "button", rules, "fill", "secret");

  assert.equal(click.status, "denied");
  assert.equal(fill.status, "denied");
  assert.equal(clicked, 0);
  assert.equal(filled, 0);
  assert.deepEqual(click.metadata.matched_policy_ids, ["coursera/content-integrity"]);
  assert.equal(click.metadata.denied_interactions, 1);
  assert.match(buildInteractionExpression("click", "button", undefined, rules), /performGuardedInteraction|function/);
});

test("generated interaction expression denies before invoking a page handler", () => {
  let clicked = 0;
  const deniedSelector = '[data-action="acknowledge-guidelines"]';
  const target = {
    matches: (selector) => selector === deniedSelector,
    closest: () => null,
    scrollIntoView: () => {},
    click: () => { clicked += 1; },
  };
  const expression = buildInteractionExpression(
    "click",
    "button",
    undefined,
    interactionDenyRules([POLICY]),
  );

  const result = Function("document", `return ${expression}`)({
    querySelector: () => target,
  });

  assert.equal(result.status, "denied");
  assert.equal(result.metadata.denied_interactions, 1);
  assert.equal(clicked, 0);
});

test("interaction guard permits non-matching targets", () => {
  let clicked = 0;
  const target = {
    matches: () => false,
    closest: () => null,
    scrollIntoView: () => {},
    click: () => { clicked += 1; },
  };
  const result = performGuardedInteraction(
    { querySelector: () => target },
    "button",
    interactionDenyRules([POLICY]),
    "click",
  );
  assert.equal(result.status, "ok");
  assert.equal(clicked, 1);
});

test("guarded interaction fails closed when Runtime.evaluate has no valid status", () => {
  assert.equal(interactionOutcome(undefined, true), "not_found");
  assert.equal(interactionOutcome({}, true), "not_found");
  assert.equal(interactionOutcome({ status: "unexpected" }, true), "not_found");
  assert.equal(interactionOutcome({ status: "denied" }, true), "denied");
  assert.equal(interactionOutcome({ status: "ok" }, true), "ok");
  assert.equal(interactionOutcome(false, false), "not_found");
  assert.equal(interactionOutcome(true, false), "ok");
});

test("filter metadata merges unique policy IDs and aggregate counters", () => {
  assert.deepEqual(
    mergeFilterMetadata(
      {
        matched_policy_ids: ["a/x"],
        removed_nodes: 1,
        redacted_blocks: 0,
        denied_interactions: 0,
        invalid_selectors: 0,
      },
      {
        matched_policy_ids: ["a/x", "b/y"],
        removed_nodes: 0,
        redacted_blocks: 2,
        denied_interactions: 1,
        invalid_selectors: 1,
      },
    ),
    {
      matched_policy_ids: ["a/x", "b/y"],
      removed_nodes: 1,
      redacted_blocks: 2,
      denied_interactions: 1,
      invalid_selectors: 1,
    },
  );
});
