# Console + Network debugging

## Capturing console output

Console messages (log/info/warn/error) and uncaught JS exceptions are captured automatically while the debugger is attached. Query the buffer:

```bash
ap-browser dev console list                  # all messages
ap-browser dev console list --type error     # only errors
ap-browser dev console clear                 # empty the buffer
```

Each entry includes: `type` (log/info/warn/error/debug), `text`, `url` (source file if available), `line`, `column`, `stack` (for exceptions), `ts` (epoch ms).

### Workflow: debug a JS error

```bash
ap-browser dev console clear
ap-browser goto "https://app.example.com"
ap-browser click "#broken-button"
ap-browser dev errors                        # one-shot: JS exceptions + console errors + failed network
```

## Capturing network requests

All HTTP requests/responses are captured while the debugger is attached:

```bash
ap-browser dev network list                  # all requests
ap-browser dev network list --status failed  # only failures (HTTP >= 400 or network error)
ap-browser dev network list --type xhr       # only XHR/fetch
ap-browser dev network list --filter "api/"  # URL regex filter
ap-browser dev network get <request_id>      # full detail + response body
```

Each entry includes: `request_id`, `method`, `url`, `type` (resource type), `status`, `status_text`, `mime_type`, `response_size`, `duration_ms`, `failed`, `error_text`, `ts`.

### Workflow: debug a failed API call

```bash
ap-browser dev console clear
ap-browser goto "https://app.example.com"
ap-browser dev network list --status failed
# pick a request_id from the output
ap-browser dev network get 123.45
# inspect request_headers, response_headers, body
```

## Buffer limits

Each tab has a 500-entry ring buffer for console and network. Old entries are evicted as new ones arrive. If you need to capture a long session, query periodically and clear between batches.

## Per-tab isolation

Buffers are per-tab. Operating on tab A does not capture events from tab B. Use `--tab <ID>` to query a specific tab's buffer.
