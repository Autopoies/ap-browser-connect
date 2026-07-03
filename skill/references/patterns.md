# Agent Patterns

Recipes for common browser automation tasks. Each pattern shows the exact command sequence.

## 1. Navigate and read a page

```bash
ap-browser goto "https://example.com"
sleep 2                          # let page render
ap-browser text                  # full page text (50k cap)
```

**Variant: structured extraction** — use `eval` instead of `text`:

```bash
ap-browser eval "document.title"
ap-browser eval "document.querySelector('h1')?.textContent"
```

## 2. Scrape a list of items

```bash
ap-browser goto "https://example.com/products"
ap-browser eval "
  Array.from(document.querySelectorAll('.product')).map(p => ({
    name: p.querySelector('.name')?.textContent?.trim(),
    price: p.querySelector('.price')?.textContent?.trim(),
    link: p.querySelector('a')?.href
  }))
"
```

`eval` returning an array is cleaner than parsing `text` output.

## 3. Fill and submit a form

```bash
ap-browser goto "https://example.com/search"
ap-browser fill "#search-box" "machine learning"
ap-browser click "#submit"
ap-browser wait ".results" --timeout 10000
ap-browser text --selector ".results"
```

**Key:** always `wait` after a `click` that triggers navigation or async load.

## 4. Login flow (when not yet authenticated)

```bash
# Check if logged in
ap-browser goto "https://example.com/dashboard"
ap-browser eval "document.querySelector('.user-avatar')?.textContent || null"
```

- If returns a username → already logged in, proceed.
- If returns `null` → **ask the user to log in manually**, then retry. Do NOT fill login forms yourself unless explicitly asked.

## 5. Handle SPA navigation

SPA frameworks (React, Vue, Svelte) update content without full page reload:

```bash
ap-browser click ".next-page"
ap-browser wait ".content-loaded"    # critical: wait for re-render
ap-browser text
```

After any `click` or `goto` on an SPA, always `wait` before reading.

## 6. Screenshot for user context

```bash
ap-browser screenshot --out /tmp/page.png --full
```

Use when:
- User asks "what does the page look like?"
- Text extraction failed and you want a visual fallback
- Complex layout needs human verification

## 7. Handle pagination

```bash
# Check if next page exists
ap-browser eval "document.querySelector('.next:not(.disabled)')?.href || null"
# If href → goto it
# If null → end of results
```

Loop: scrape page → check next → goto next → repeat.

## 8. Read truncated content

Large pages (50000+ chars) are truncated:

```bash
ap-browser text                              # first 50k chars
# Response: {truncated: true, total_chars: 234567, range: [0, 50000]}

ap-browser text --range 50000:100000         # next 50k chunk
ap-browser text --full                       # everything (slow on huge pages)
```

Check `data.truncated` in the response to decide if you need more.

## 9. Operate on a specific tab (without switching focus)

```bash
ap-browser tabs list --filter "github"       # find tab
# → [{"id": 42, ...}]

ap-browser --tab 42 eval "document.title"    # operate without switching
ap-browser --tab 42 screenshot --out /tmp/gh.png
```

Use `--tab` to work in the background without disrupting the user's current view.

## 10. Raw CDP for advanced operations

```bash
# All cookies for current domain
ap-browser cdp "Network.getCookiesForUrl" --params '{"url":"https://example.com"}'

# Full DOM snapshot
ap-browser cdp "DOMSnapshot.captureSnapshot" --params '{"computedStyles":[]}'

# Set a cookie
ap-browser cdp "Network.setCookie" --params '{"name":"test","value":"1","domain":"example.com"}'
```

CDP method reference: https://chromedevtools.github.io/devtools-protocol/tot/

## 11. Batch multiple commands (token saver)

When doing 2+ operations in sequence, batch them into one call. Saves ~200 tokens per batch by eliminating per-command envelopes and meta blocks.

```bash
echo '[
  {"method":"goto","url":"https://news.ycombinator.com"},
  {"method":"wait","selector":".athing"},
  {"method":"eval","expression":"Array.from(document.querySelectorAll(\".titleline>a\")).slice(0,5).map(a=>a.textContent)"},
  {"method":"screenshot"}
]' | ap-browser batch
```

Response is one compact JSON:
```json
{"ok":true,"data":{"results":[{"ok":true,"data":{...}},{"ok":true,"data":{...}},...]},"meta":{...}}
```

Only one `meta.focus` block for the entire batch. If any step fails, it's included as `{ok:false,error:{...}}` in the results array — subsequent steps still run unless `stop_on_error:true`.

**Step format:** each step is `{"method":"...", ...params}`. Supported params: `url`, `selector`, `value`, `expression`, `tab_id`, `timeout_ms`.
