# Multi-Profile Workflow

## When this matters

The user may have multiple Chrome profiles open simultaneously (e.g. "Work" and "Personal"). Each profile runs its own extension instance with its own socket.

## Discovery

```bash
ap-browser profiles
```

Returns an array of online profiles:

```json
[
  {"instance_id":"a1b2…","label":"Work","active_tab_url":"https://slack.com","active_tab_title":"#general"},
  {"instance_id":"c3d4…","label":"Personal","active_tab_url":"https://gmail.com","active_tab_title":"Inbox"}
]
```

If the array is empty → extension not running. Ask user to open Chrome.

## Selection

### Persistent (recommended)
```bash
ap-browser use Work
# Writes to ~/.ap-browser/current, all subsequent commands target "Work"
```

### One-shot override
```bash
ap-browser --profile Work goto "https://..."
# Only this command targets "Work", default unchanged
```

### Environment variable
```bash
export AP_BROWSER_PROFILE=Work
ap-browser goto "https://..."
```

## Resolution priority

When a command runs without `--profile`, the CLI resolves the target profile in this order:

1. `--profile` flag (highest)
2. `AP_BROWSER_PROFILE` env var
3. `~/.ap-browser/current` file
4. If exactly one socket exists → use it
5. If multiple sockets exist → **exit code 6**, print available profiles

## Agent decision tree

```
Is this the first browser command in this task?
├── YES → run `ap-browser profiles`
│   ├── 0 profiles → ask user to open Chrome + reload extension
│   ├── 1 profile  → proceed (auto-selected)
│   └── 2+ profiles → show user the list, ask which one, run `use`
└── NO → proceed (profile already selected or auto-resolved)

Got exit code 6?
└── Run `profiles`, present options to user, run `use <label>`, retry
```

## Label management

Labels are set by the user in the extension popup. If a profile has no label, it shows as `(no label)` and can only be selected by instance_id prefix (first 8 chars usually suffice).

```bash
ap-browser profiles
# [{"instance_id":"a1b2c3d4-…","label":""}]

ap-browser use a1b2c3d4   # works (prefix match)
```

Recommend the user set labels via the extension popup for easier selection.
