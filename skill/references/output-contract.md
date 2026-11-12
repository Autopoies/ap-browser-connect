# Output Contract

## Response shape

### Success
```json
{
  "ok": true,
  "data": { /* command-specific */ },
  "meta": {
    "operated": { "window_id": 1, "tab_id": 12 },
    "focus": {
      "window_id": 1,
      "window_focused": true,
      "window_state": "normal",
      "tab_id": 12,
      "tab_url": "https://example.com",
      "tab_title": "Example",
      "tab_group": null,
      "matched_operated_target": true
    },
    "profile": { "instance_id": "uuid…", "label": "Work" }
  }
}
```

### Error
```json
{
  "ok": false,
  "error": { "code": "TAB_NOT_FOUND", "message": "no tab with id 99" },
  "meta": { /* focus snapshot if available */ }
}
```

When the CLI and native host versions differ, `meta` automatically includes `cli_version`, `host_version`, and `version_warning`.

## Non-standard JSON exceptions

All browser/extension RPC commands, `tabs list`, `sites list`, and `sites search` return the `{ok, data, meta}` envelope above. A small set of local inspection and multi-profile commands have distinct JSON shapes:

| Command | Top-level JSON shape | Notes |
|---------|----------------------|-------|
| `profiles` | `[ { "instance_id", "label", ... } ]` | Bare array of online profiles |
| `status` | `{ "online": N, "profiles": [...], "partial"?: true, "errors"?: [...] }` | Includes `partial` + `errors` if any profile probe failed |
| `current` | `{ "profile": "<id\|null>" }` | Active default profile selection |
| `use <id\|label>` | `{ "ok": true, "selected": "<id>" }` | Switches sticky default profile |
| `doctor --json` | `{ "ok": bool, "summary": {...}, "checks": [...] }` | Health report |
| `tabs list` (1 profile or `--profile`) | `{ "ok": true, "data": { "tabs": [...] }, "meta": {...} }` | Extension response for that single profile |
| `tabs list` (multiple online profiles, no `--profile`) | `{ "ok": true, "data": { "profiles": [ { "instance_id", "label", "tabs": [...] } ], "partial"?: true, "errors"?: [...] }, "meta": {} }` | Concurrent cross-profile aggregation |

## Exit codes

| Code | Error code | Meaning | Agent action |
|------|-----------|---------|-------------|
| 0 | — | success | proceed |
| 1 | `USAGE_ERROR` | bad CLI arguments | fix args |
| 2 | `EXTENSION_NOT_CONNECTED` | socket dial failed | ask user to open Chrome / reload extension |
| 3 | `TAB_NOT_FOUND` | tab ID doesn't exist | re-list tabs, use correct ID |
| 4 | `CDP_ERROR` / `JS_EXCEPTION` / `SELECTOR_NO_MATCH` / `STALE_REF` / `TEXT_MISMATCH` / `NOT_VISIBLE` / `NOT_INTERACTABLE` / `ELEMENT_OBSCURED` / `INVALID_SELECTOR` / `DEBUGGER_ATTACH_FAILED` | page-level error | inspect fresh state; fix target or selector |
| 5 | `TIMEOUT` | response deadline exceeded | inspect state before retrying an interaction; it may already have executed |
| 6 | `MULTIPLE_PROFILES` | multiple profiles online, none selected | run `profiles` + `use` |

## meta.focus interpretation

`meta.focus` is a real-time snapshot of the user's Chrome attention at response time.

### Key field: `matched_operated_target`

- **`true`** → user is looking at the tab you just operated on. They can see your work.
- **`false`** → you operated on tab X, but user is on tab Y. Your command still executed successfully. Don't panic.

### Behavioral rules

1. **Never abort** a command because `matched_operated_target` is false. Always run to completion.
2. **Never hijack focus.** Do NOT run `tabs activate` to "bring them back." They may have switched deliberately.
3. If `matched_operated_target: false` persists for **3+ consecutive commands**, surface it once: *"I've been working on [tab X], you're on [tab Y]. Want me to continue or pause?"* Then proceed regardless.
4. `window_state: "minimized"` or `window_focused: false` → user stepped away. Finish quietly, don't ask mid-task.

## Truncation

`text` and `html` default to 50000 characters.

| Flag | Behavior |
|------|----------|
| (none) | First 50000 chars, `truncated: true` if more exists |
| `--full` | No limit (may be slow on huge pages) |
| `--range <start:end>` | Byte-offset slice, e.g. `--range 50000:100000` |

Response fields: `truncated`, `total_chars`, `returned_chars`, `range: [start, end]`.

## Tab resolution

When `--tab` is not passed:

1. Call `chrome.windows.getLastFocused()` → get the focused window
2. Call `chrome.tabs.query({active: true, windowId: <focused>})` → get active tab of that window
3. Operate on that tab

This means the **user's current tab** — which is usually what you want. If the user switches tabs between your commands, subsequent commands target the new active tab.

To lock to a specific tab across multiple commands, pass `--tab <ID>` explicitly.
