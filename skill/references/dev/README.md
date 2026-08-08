# ap-browser dev mode

Structured debugging commands wrapping Chrome DevTools Protocol (CDP). Use these when developing, debugging, or testing web pages.

## Command tree

| Subcommand | What it does |
|---|---|
| **Console** | |
| `dev console list [--type error\|warn\|log]` | List captured console messages |
| `dev console clear` | Clear console buffer |
| **Network** | |
| `dev network list [--filter <regex>] [--type xhr\|fetch\|...] [--status failed]` | List captured network requests |
| `dev network get <request_id>` | Full detail + response body for one request |
| **Errors** | |
| `dev errors` | Aggregated: JS exceptions + console errors + failed network |
| **Inspection** | |
| `dev snapshot [--verbose]` | Accessibility tree (structured, with uids for interaction) |
| `dev dom <selector> [--computed] [--listeners] [--box-model]` | Deep DOM inspection |
| `dev heap stats [--out <file>]` | JS heap usage summary (used/total/limit + node/document/listener counts). Note: full heap snapshot/diff not available — chrome.debugger API does not expose HeapProfiler domain |
| **Performance** | |
| `dev perf metrics` | Current Performance.getMetrics |
| `dev perf trace [--reload] [--duration <s>]` | Capture Core Web Vitals + perf trace |
| `dev lighthouse [--categories ...] [--url ...]` | Run Lighthouse audit (a11y/SEO/best-practices) |
| **Emulation** | |
| `dev emulate dark\|light\|auto` | Color scheme |
| `dev emulate viewport <WxH> [--device-pixel-ratio <r>] [--mobile]` | Viewport size |
| `dev emulate geo <lat>,<lng>` | Geolocation override |
| `dev emulate network offline\|slow3g\|fast3g\|slow4g\|fast4g` | Network throttling |
| `dev emulate cpu <rate>` | CPU throttling (rate multiplier) |
| `dev emulate ua <string>` | User-Agent override |
| `dev emulate headers <json>` | Extra HTTP headers |
| `dev emulate reset` | Clear all emulation overrides |
| **Interaction** | |
| `dev hover <selector>` | Dispatch hover (triggers :hover state) |
| `dev drag <from> <to>` | Drag-and-drop between two elements |
| `dev fill-form <json>` | Fill multiple form fields at once |
| `dev upload <selector> <filepath>` | Set file on `<input type="file">` |
| `dev dialog accept\|dismiss [text]` | Handle JS dialogs (alert/confirm/prompt) |
| **Extension management** | |
| `dev extension list` | List all installed extensions (id/name/version/enabled/installType) |
| `dev extension get <id>` | Full detail for one extension (permissions, icons, etc.) |
| `dev extension reload [<id>]` | Reload extension. No id = reload self (`chrome.runtime.reload()`). Self-reload causes ~3s disconnect (SW restart) — expected |
| `dev extension enable <id>` | Enable a disabled extension |
| `dev extension disable <id>` | Disable an enabled extension (cannot disable self) |
| `dev extension uninstall <id>` | Uninstall an extension (cannot uninstall self) |
| **API testing** | |
| `dev api <METHOD> <URL> [--body '<json>'] [--header 'K: V']... [--expect-status N] [--tab T]` | Send HTTP request via page-context `fetch()` with real cookies/session. URL can be relative (`/api/x`) — resolved against tab origin |
| **Cookie management** | |
| `dev cookies list [--domain D] [--url U] [--name N]` | List cookies (filter by domain/url/name) |
| `dev cookies get --url U --name N` | Get one cookie's full detail |
| `dev cookies set --url U --name N --value V [--domain D] [--path P] [--secure] [--httpOnly] [--sameSite Lax\|Strict\|None]` | Set a cookie |
| `dev cookies delete --url U --name N` | Delete a cookie |
| **Storage inspection** | |
| `dev storage list [--type local\|session\|indexed]` | List localStorage/sessionStorage/IndexedDB entries |
| `dev storage get <key> [--type local\|session]` | Get one storage value |
| `dev storage set <key> --value <v> [--type local\|session]` | Set a storage value |
| `dev storage remove <key> [--type local\|session]` | Remove one storage entry |
| `dev storage clear [--type local\|session]` | Clear all entries in a store |
| **Service Worker / PWA** | |
| `dev sw list [--tab T]` | List registered service workers (scope, scriptURL, state) |
| `dev sw inspect [--tab T]` | Full SW detail: controller + push subscription (FCM endpoint) + cache keys + sync status |
| `dev sw unregister <scope-url> [--tab T]` | Unregister a service worker by its scope URL |

## Global flags (all commands)

- `--tab <ID>` — target tab (default: active tab of focused window)
- `--profile <ID>` — target profile
- `--format json|ndjson` — output format (default: json; auto-switches to ndjson when piped)
- `--human` — human-readable output

## When to use which

- **"What's wrong with this page?"** → `dev errors` (one-shot summary)
- **Debug a failing API call** → `dev network list --status failed` then `dev network get <id>`
- **See console output** → `dev console list --type error`
- **Find a button to click** → `dev snapshot` (returns uids), then use `click <uid>` or `dev hover`
- **Test responsive design** → `dev emulate viewport 375x667 --mobile`
- **Test dark mode** → `dev emulate dark`
- **Audit accessibility** → `dev lighthouse --categories accessibility`
- **Measure page speed** → `dev perf trace --reload`

## How event capture works

Console and network events are captured **continuously** while a debugger is attached to the tab — not just at the moment of query. Each tab has its own 500-entry ring buffer. Detaching (or closing the tab) clears the buffer.

This means: trigger the action that produces events first, then query. Example workflow:

```bash
ap-browser dev console clear                # start fresh
ap-browser goto "https://broken-site.com"   # trigger events
ap-browser dev errors                       # see what went wrong
```

## Domain-specific guides

- [Console + Network debugging](console-network.md)
- [Performance auditing](performance.md)
- [Emulation testing](emulation.md)
- [DOM/A11y inspection](inspection.md)
