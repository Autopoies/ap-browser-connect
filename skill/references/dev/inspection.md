# DOM and accessibility inspection

## Accessibility tree snapshot

```bash
ap-browser dev snapshot             # flattened AX tree
ap-browser dev snapshot --verbose   # include all AX properties
```

Returns the page's accessibility tree as a list of `{uid, role, name, focused}` objects. The `uid` is a stable identifier (`ax-<nodeId>`) you can reference in documentation or use to locate elements for interaction.

### When to use snapshot vs text/html

- **snapshot** — structured view of the page's semantic structure (roles, names, focus state). Best for finding interactive elements, understanding a11y, or getting stable references.
- **text** — raw visible text content. Best for content extraction.
- **html** — raw HTML. Best for inspecting markup.

### Workflow: find and click a button

```bash
ap-browser dev snapshot
# scan output for role: "button", name: "Submit"
# note the uid (e.g. "ax-42")
ap-browser click "button[name='Submit']"     # or use the actual CSS selector
```

## DOM deep inspection

```bash
ap-browser dev dom "#submit-btn"                          # basic: tag, attrs, HTML, box
ap-browser dev dom "#submit-btn" --computed               # + computed CSS styles
ap-browser dev dom "#submit-btn" --listeners              # + event listeners
ap-browser dev dom "#submit-btn" --box-model              # + content/padding/border/margin boxes
ap-browser dev dom "#submit-btn" --computed --listeners   # combine flags
```

### Use cases

- **--computed** — debug CSS issues (why is this element red? what's the actual font-size?)
- **--listeners** — debug event handler issues (is the click handler attached? is it passive?)
- **--box-model** — debug layout issues (why is this overlapping? what's the actual width?)

### Workflow: debug a broken click handler

```bash
ap-browser dev dom "#submit-btn" --listeners
# check if click listener is present, check scriptId + lineNumber for source location
# if listener is missing, the handler wasn't attached — check the JS
```

## JS heap snapshot

```bash
ap-browser dev heap                           # summary: used/total heap, top constructors
ap-browser dev heap --out /tmp/snapshot.json  # write summary to file
```

Returns current JS heap usage. Use to detect memory leaks by comparing heap size before and after repeated actions.

### Workflow: detect a memory leak

```bash
ap-browser dev heap                           # baseline
# → used_js_heap_bytes: 10_000_000

# trigger repeated actions (e.g. navigate, click, scroll)
ap-browser goto "https://app.example.com"
ap-browser click "#load-more"
ap-browser click "#load-more"
ap-browser click "#load-more"

ap-browser dev heap                           # after
# → used_js_heap_bytes: 50_000_000  ← 5x growth suggests a leak
```
