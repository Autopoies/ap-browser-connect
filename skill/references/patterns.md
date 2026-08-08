# Agent Patterns

Recipes for common browser automation tasks. Each pattern shows the exact command sequence.

> **Before any pattern: check for a site adapter first** (`ap-browser sites search <site>`). If the site has an adapter, its command beats every generic pattern below — it already handles selectors, pagination, and waits. These patterns are the generic fallback, not the default. See SKILL.md → Adapter-first rule.

## 1. Navigate, discover, act

```bash
ap-browser goto "https://example.com"
ap-browser state                   # [N] refs + coordinates — what's interactive here?
ap-browser click 12                # act by ref (or by CSS selector)
ap-browser screenshot --annotate   # visual ref map when you need pixels -> [N]
```

**Read page text** when you need content:

```bash
ap-browser text                    # full page text (50k cap)
ap-browser text --selector "h1"   # scoped
```

## 2. Scrape a list of items

```bash
ap-browser goto "https://example.com/products"
# interactive items (links/buttons): state gives you them with refs
ap-browser state
# structured extraction from repeated blocks — eval's first-class use:
ap-browser eval "
  Array.from(document.querySelectorAll('.product')).map(p => ({
    name: p.querySelector('.name')?.textContent?.trim(),
    price: p.querySelector('.price')?.textContent?.trim(),
    link: p.querySelector('a')?.href
  }))
"
```

Mapping many elements to a compact array is **exactly what eval is for** (structured extraction). For interaction — clicking one of those items — go back to refs: `state`, then `click <ref>`.

## 3. Fill and submit a form

```bash
ap-browser goto "https://example.com/search"
ap-browser state                    # find the field + button refs
ap-browser fill 7 "machine learning"
ap-browser click 12
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

CDP method reference: <https://chromedevtools.github.io/devtools-protocol/tot/>

## 11. Batch multiple commands (use it when the sequence is deterministic)

Batch = **one round-trip, one meta block, one timeout envelope** for N steps. Use it when:

1. **3+ steps with no decisions between them** — you would run them anyway, so run them once
2. **The state→ref chain** — `state`, then act by ref, then read: refs stay valid because every step runs in the same page session
3. **Retry loops** — after fixing a failed step, re-run the whole sequence (e.g. with `sites verify`-style args) in one call
4. **Long media waits** — Pattern 12

Do NOT batch when you need to inspect each step's result before choosing the next (interactive debugging) — the batch stops at the first failed step.

**state→ref chain in one call (the default page-operating pattern):**

```bash
echo '[
  {"method":"state"},
  {"method":"click","ref":12},
  {"method":"wait","selector":".results","timeout_ms":10000},
  {"method":"text","selector":".results"}
]' | ap-browser batch
```

**Refs are known before you batch:** run `state` once first, note the target's `ref` number, then put that number in the batch JSON (the batch's own leading `state` step re-tags the DOM so refs stay valid inside the batch). Never guess a ref number — if you don't know it, run `state` first.

Method names are the same as the CLI's (`state`, `click`, `fill`, `select`, `scroll`, `goto`, `wait`, `text`, `eval`, `screenshot`…). Response is one compact JSON:

```json
{"ok":true,"data":{"results":[{"ok":true,"data":{...}},{"ok":true,"data":{...}},...]},"meta":{...}}
```

Only one `meta.focus` block is returned for the entire batch. The CLI stops the batch after the first failed step.

**Step format:** each step is `{"method":"...", ...params}`. Params can be flattened (`url`, `selector`, `value`, `expression`, `ref`, `option`, `count`, `pause_ms`, `timeout_ms`, `url_change_from`, `media_ended`, `tab_id`) or nested in a `params` object.

## 12. Wait for long media without CLI polling

Start playback and wait in one batch. The media wait uses one page event and treats automatic navigation after playback as success.

```bash
printf '%s' '[
  {"method":"eval","expression":"(()=>{const v=document.querySelector(\"video\");v.muted=true;v.playbackRate=16;v.play();return {started:true}})()"},
  {"method":"wait","params":{"media_ended":true,"selector":"video","timeout_ms":180000}}
]' | ap-browser --tab "$TAB" batch
```

For sites that navigate without a media element, capture the current URL and use `wait --url-change-from "$URL"`. Do not loop over `tabs get` or `eval` from the shell.

## 13. Download files from a site (PDFs, docs, media)

Use `download <url>` — it fetches through the browser session, so logged-in/cookie-gated files just work:

```bash
ap-browser download "https://learn.ivey.ca/courses/6143/files/916751/download?download_frd=1"
ap-browser download "https://example.com/video.mp4" --video   # yt-dlp for media sites
```

`download` saves to the current directory and reports the file path. Fall back to `eval` fetch only when `download` fails on a specific endpoint (some sites validate referer — open the page first, then `download` the file's own URL from the page's DOM).

