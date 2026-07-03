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

## Exit codes

| Code | Error code | Meaning | Agent action |
|------|-----------|---------|-------------|
| 0 | — | success | proceed |
| 1 | `USAGE_ERROR` | bad CLI arguments | fix args |
| 2 | `EXTENSION_NOT_CONNECTED` | socket dial failed | ask user to open Chrome / reload extension |
| 3 | `TAB_NOT_FOUND` | tab ID doesn't exist | re-list tabs, use correct ID |
| 4 | `CDP_ERROR` / `JS_EXCEPTION` / `SELECTOR_NO_MATCH` / `DEBUGGER_ATTACH_FAILED` | page-level error | fix selector/JS, or check page state |
| 5 | `TIMEOUT` | command exceeded timeout | retry once, or ask user if page is responsive |
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
