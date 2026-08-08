# Creating a Site Adapter

A practical, experience-driven guide for creating site-specific commands for ap-browser.

## Step 0: Check existing knowledge

```bash
ap-browser sites doc <site>
ap-browser sites list
```

If `sites/doc` returns a knowledge doc, read it first — the selectors, URL patterns, and pitfalls are already documented and validated. Skip to Step 3 using those selectors.

If no doc exists, proceed to Step 1.

## Step 1: Explore the page structure

This is the most critical step. The goal is not "find selectors" — it is **prove which selectors are stable and which are fragile**.

### Step 1a: Navigate and confirm load

```bash
ap-browser goto "https://target-site.com/search?q=test"
ap-browser wait ".some-container"
```

`wait` is your **load confirmation gate**. Choose a selector that:

- Only exists after meaningful content has rendered (not just page shell)
- Is unique to the data list (not a generic `.container`)

**Common mistake**: choosing `body` or a header as the `wait` target. This passes too early and the eval runs on an empty DOM.

### Step 1b: Probe candidate selectors

Don't guess. Probe the actual DOM:

```bash
ap-browser eval "(() => {
  const items = document.querySelectorAll('.candidate-selector');
  if (!items.length) return { hint: 'empty, try alternates', alternatives: [...document.querySelectorAll('[class]')].slice(0,20).map(el => el.className.slice(0,40)).filter(c => /card|item|video|result|feed/i.test(c)) };
  const first = items[0];
  // Map the leaf structure of the first item
  const leafs = [...first.querySelectorAll('*')].filter(el => el.children.length === 0 && el.textContent.trim());
  return {
    count: items.length,
    leafs: leafs.slice(0,15).map(el => ({
      tag: el.tagName,
      class: (el.className || '').slice(0,50),
      text: el.textContent.trim().slice(0,40),
      href: el.href || '',
    })),
  };
})()"
```

This returns a **structured map of the item's leaf elements**. From this output you pick selectors — not the other way around.

### Step 1c: Language-agnostic selector rules

**Rule: never match on text content.** Text is localized, versioned, and can change with A/B tests. Use:

| Don't | Do |
| --- | --- |
| `.find(a => /views\|watchings/i.test(a.textContent))` | `.ytContentMetadataViewModelMetadataText` (structural class) |
| `.querySelectorAll('span')[3]` (positional) | `.querySelectorAll('.ytContentMetadataViewModelMetadataText')` (semantic) |
| `.find(a => a.textContent.includes('comments'))` | `.querySelector('.interaction-item__action')` (semantic) |

**Exception**: when a single semantic class holds multiple semantic values (e.g. one metadata-text class shared by channel name, view count, and date), positional indexing within that semantic class is acceptable — but document the position contract in the adapter's knowledge doc.

### Step 1d: Verify each picked selector

Run the final eval expression and verify each field returns non-empty for at least 3 items:

```bash
ap-browser eval "<your final eval expression>"
```

If field X is empty for item 0 but not item 1, the selector is fragile. Find a more stable one before writing the YAML.

### Step 1e: Handle SPA loading / skeletons

SPAs (modern React/Vue/Angular apps) often render **placeholder skeletons** before the real data. These skeletons match the same card container selector but have no title/content.

Two fixes:

1. **Stronger wait**: use the title element, not the card container, as the `wait` target
2. **Filter in eval**: skip items where the title selector returns empty

Example pattern (filter on a child element that only real items have):

```js
const real = cards.filter(c => c.querySelector('.item__title'));
```

### Step 1f: Filter ads / sponsored content

Many sites inject sponsored items into the feed (e.g. ad-network URLs, "sponsored" badges). Filter them out by URL pattern in eval:

```js
const real = cards.filter(c => !c.querySelector('a[href*="ad-network-domain"]'));
```

Document the ad-filter pattern in the knowledge doc — it varies per site and breaks silently if not present.

## Step 2: Write the knowledge doc

Create `skill/references/sites/<site>.md` from `_template.md`. Capture:

- **Selectors that survived Step 1d** — with their class-name structure (e.g. `.ytLockupMetadataViewModelTitle`, not just "the title element")
- **Ad-filter pattern** — what URL or attribute distinguishes ads
- **SPA timing notes** — which selector confirms real data (not skeleton)
- **Login requirements** — which commands need login, which don't
- **DOM version observation** — e.g. "2024+ uses `yt-lockup-view-model`, pre-2024 used `#video-title` (stale)"

This doc is the **durable artifact**. Adapters may break on site redesign; the doc tells the next agent (or you in 3 months) what to look for.

## Step 3: Write the adapter YAML

### Standard layout

```yaml
# ~/.ap-browser/sites/<site>/<cmd>.yaml
site: <site>              # MUST match parent folder
name: <cmd>               # MUST match filename (no .yaml)
description: <one line>

args:
  <arg>:
    type: string          # string | int | bool
    required: true
    default: <value>      # optional
    desc: <description>

output:
  type: array             # array | object
  fields: [field1, field2]

timeout: 60               # optional — max seconds for this adapter's request
                          # default: estimated from steps (min 30s); override
                          # for slow waits / heavy pages (host cap: 3600)

steps:
  - goto: "https://target-site.com/path?q={{args.arg}}"
  - wait: ".stable-load-gate-selector"
  - eval: <cmd>.js        # file reference — see below
```

**`timeout` (optional):** the adapter's request otherwise gets an estimate from its steps (30s floor). Set `timeout` when the adapter genuinely needs longer — e.g. a `wait` step with a big `timeout_ms`, or a slow site — or shorter, when the steps are known-fast and you want an early failure instead of a 30s hang. Values over 3600 are clamped by the host.

Also create `~/.ap-browser/sites/<site>/site.yml`:

```yaml
site: <site>
domain: target-site.com
description: <site overview>
login_url: https://...     # optional
```

### Eval: inline vs file reference

Two forms, pick by length:

**Inline** (`eval: |` block in YAML) — for trivial evals, ≤5 lines. Works fine, no extra file:

```yaml
steps:
  - eval: |
      document.title
```

**File reference** (`eval: <name>.js`) — for any non-trivial DOM logic. The .js file lives next to the .yaml in the site folder and is inlined at load time:

```yaml
steps:
  - eval: hot.js
```

```js
// ~/.ap-browser/sites/<site>/hot.js
(() => {
  const items = document.querySelectorAll('.item-card');
  return [...items].slice(0, {{args.limit}}).map(el => ({
    title: el.querySelector('.title-class')?.textContent?.trim() || '',
    url: el.querySelector('.link-class')?.href || '',
  }));
})()
```

**Why file reference**: the .js file gets IDE highlighting, eslint/prettier, clean git diff, and DevTools paste-and-debug. YAML literal blocks get none of that. Past ~10 lines of JS, file reference is the right call. Lint fails loudly if the .js file is missing.

`{{args.X}}` template substitution works identically in both forms.

### Template rules

- `{{args.X}}` in `goto` (URL context): auto percent-encoded
- `{{args.X}}` in `eval` (JS context): inserted as raw string value
- `{{eval args.X <op> <int> [<op> <int>]*}}`: integer arithmetic for pagination offsets. Operates left-to-right, no precedence. Operators: `+ - * /`. Arg must be type `int`. Example: `?start={{eval args.page - 1 * 25}}`
- Every `{{...}}` must reference a declared arg (lint enforces)
- Optional args (no `default`) used in templates resolve to empty string when not provided — useful for filters like `trending/{{args.language}}?since=...` that should produce `trending/?since=...` when language is omitted

### Available step methods

`goto`, `wait`, `eval`, `text`, `click`, `fill`, `press`, `scroll` — each maps to the corresponding ap-browser primitive.

### Pagination: two patterns

**URL pagination** (sites with `?page=N` or `?start=N` query params): add a `page` arg with `default: 1`, then reference it in the `goto` URL. Use `{{eval args.page - 1 * <per_page>}}` for offset-style URLs.

```yaml
args:
  page:
    type: int
    default: 1
steps:
  - goto: "https://example.com/list?page={{args.page}}"
  # or offset-style:
  - goto: "https://example.com/list?start={{eval args.page - 1 * 25}}"
```

**Lazy-load (SPA) pagination** (infinite scroll sites like feeds): use the `scroll` step between `wait` and `eval`. Each scroll goes to page bottom and pauses for lazy-load.

```yaml
args:
  scrolls:
    type: int
    default: 2
    desc: scroll-to-bottom count to trigger lazy loading
steps:
  - goto: "https://example.com/feed"
  - wait: ".feed-item"
  - scroll:
      count: "{{args.scrolls}}"
      pause_ms: 1000
  - eval: feed.js
```

`scroll` params:

- `count` (int, default 1, max 50): number of scroll-to-bottom iterations
- `pause_ms` (int, default 800, clamped 200–5000): wait between scrolls for lazy-load
- `selector` (optional): scroll a specific element into view instead of page bottom

**When to use which**: site has `?page=` or `Next →` link → URL pagination. Site loads more on scroll-to-bottom → SPA scroll. Sites with finite single-page lists (e.g. top-25 ranking) → neither, just `limit`.

### Eval convention: defensive null-guards

Every DOM read in eval should use optional chaining + fallback:

```js
el.querySelector('.title')?.textContent?.trim() || ''
```

A missing selector returns empty string, not `undefined` or exception. This keeps the output schema stable across runs even if one item has a missing field.

### Eval convention: skip empty items

After filtering for the title field, skip items where the title is empty:

```js
const title = el.querySelector('.title')?.textContent?.trim() || '';
if (!title) return;  // skip skeleton/ad/sponsored
out.push({ title, ... });
```

### Pipe input (optional)

Add `input` to receive piped data:

```yaml
input:
  field: <argname>         # map stdin field to this arg
  field: null              # raw line mode → access via {{args._input}}
```

### Notification-style adapters

For "inbox" / "feed" pages (notifications, replies, likes):

1. The page is usually a SPA hash route (`#/reply`, `#/love`) — `goto` works but you must `wait` for the item selector, not just the page shell
2. Action descriptions are language-specific (e.g. "liked your comment", "replied to you", localized equivalents) — **extract them as opaque strings**, don't try to parse them into enums. The user knows what they mean; the adapter schema should not encode any language.
3. Multiple users may share one notification (e.g. "User A, User B and 15 others liked your comment") — join names with `,` in the adapter, let downstream decide how to present.

## Step 4: Lint (static check)

```bash
ap-browser sites lint <site>
```

Catches: site/name mismatches, invalid arg types, unknown step methods, undeclared template vars, missing `input.field` references. Exit 0 = pass, exit 4 = errors.

## Step 5: Live verify

```bash
ap-browser sites verify <site> <cmd> --test-args '{"arg":"value"}'
```

Runs the adapter step-by-step against the live page with PASS/FAIL + selector similarity hints on failure. **Use this whenever selectors might have drifted.**

If you skipped Step 1d (selector verification), this is where you'll find out — `wait` will fail and verify will suggest similar selectors.

## Step 6: Real invocation

```bash
ap-browser <site> <cmd> "real arg" --format json
ap-browser <site> <cmd> "real arg"               # auto NDJSON when piped
ap-browser <site> <cmd> | jq '.field'
```

## Common failure patterns (from real adapters)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `eval` returns `[{...}, {...}]` but field X is always empty | Selector matches element but wrong attribute / text not where expected | Re-probe with Step 1b's leaf-mapping eval |
| First N items OK, rest have empty fields | Lazy-loaded items not yet rendered | Add `limit` arg, or scroll in eval before query |
| Works for items 1-5, fails on item 6 | Item 6 is an ad / sponsored card with different structure | Filter ads in eval (see Step 1f) |
| `wait` passes but `eval` finds 0 items | SPA skeleton matched the `wait` selector | Use a more specific selector (title element, not card container) |
| Output contains `\xa0` or `&nbsp;` | Site uses non-breaking spaces | Accept in adapter; downstream normalizes if needed |
| Multiple selectors return the same text | Verification badge duplicates a name | Dedupe via `new Set()` before positional indexing |
| Adapter works today, breaks next month | Site DOM redesign | Knowledge doc tells next agent what to look for; `sites verify` diagnoses drift |

## Anti-patterns to avoid

- **Text-based matching**: `/views|watchings/i` — localized, fragile, breaks across site language variants
- **Positional indexing on generic classes**: `document.querySelectorAll('span')[3]` — breaks when site adds/removes a span
- **Skipping Step 1b (leaf probe)**: guessing selectors from memory or other adapters
- **Skipping Step 1d (multi-item verification)**: only testing item 0, missing edge cases on items 1+
- **Not writing the knowledge doc**: next agent has to redo Step 1 from scratch
- **Parsing action text**: any localized action string ("liked your comment", "replied to you", etc.) should be passed through as opaque text, not parsed into `{action: "like"}` — language changes, schema shouldn't
