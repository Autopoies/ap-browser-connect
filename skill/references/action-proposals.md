# Generic action proposals

Use an action proposal when an agent can offer one or more concrete next actions and
wants the user to choose and approve one in the bound browser tab. This is a generic
interaction protocol, not a proofread-specific or site-specific feature.

Before completing an ASK, the agent must decide whether the result supports concrete
actions the user could approve. If so, publish a `confirm` proposal with real options;
do not leave those actions only as prose alternatives or mark the request done before
the user decides. If no meaningful action exists, complete normally without inventing
buttons for a purely informational answer.

## Publish a proposal

Send a normal inline `confirm` update with an `options` JSON array:

```bash
ap-browser reply --event-id mail-0123456789abcdef0123456789abcdef \
  --status confirm --message "Choose which action to run" \
  --options '[
    {"id":"a","label":"Apply recommended edit","description":"Replace only the selected sentence.","payload":{"text":"Revised text"}},
    {"id":"b","label":"Create a comment","description":"Leave the text unchanged and record the suggestion.","payload":{"mode":"comment","text":"Revised text"}}
  ]'
```

Each option has:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique stable ID matching `[A-Za-z0-9._-]{1,64}` |
| `label` | yes | Human-visible action name, 1–160 characters |
| `description` | no | Human-visible effect and scope, at most 2000 characters |
| `payload` | optional | Arbitrary JSON data owned by the proposing agent |

A proposal contains 1–6 options and its normalized options JSON is limited to
12,000 bytes. `--options` requires `--status confirm`. The extension returns a
`proposal_id` in the reply result and displays the choices without executing any
payload. Keep credentials and secrets out of payloads: they appear in browser
history and the receiving session log.

Only propose actions that the current session is prepared to perform. The browser
does not validate or execute the payload's business meaning.

## User decision

Approving option `a` sends a new mail on the **same thread**, targeted to the same
session and receiver epoch. Its `action` is `approve`, and its `ap_browser`
metadata includes:

```json
{
  "proposal_response": {
    "proposal_id": "proposal-...",
    "option_id": "a",
    "option": {
      "id": "a",
      "label": "Apply recommended edit",
      "description": "Replace only the selected sentence.",
      "payload": {"text": "Revised text"}
    }
  }
}
```

The readable body labels this `Action: APPROVE` and includes the same structured
proposal response. This is direct user approval for the disclosed selected action.
Execute only that action; do not switch options, substitute hidden behavior, or
broaden its scope. If the visible label/description did not disclose the effect,
ask for clarification instead of treating the click as approval for something else.
Keep progress and result messages human-readable: do not echo proposal IDs, option IDs,
or raw payload JSON unless the user explicitly asks for technical details.

The Cancel choice sends `action: cancel` with `proposal_response: {proposal_id}`.
Do not execute any option after cancellation.

## Delivery and lifecycle

- A proposal is decided at most once in the dock. Clicking removes its option
  controls and records Approved or Cancelled; uncertain delivery is not retried
  automatically.
- Approval and cancellation use the normal receiver lease, identity checks and
  explicit mailbox receipts. Acceptance still does not mean running or completed.
- Use normal `running`, `done`, or `error` replies for execution progress and the
  final result.
- Proposal controls live in the dock DOM. Page navigation or browser restart can
  remove them; the agent owns any durable business state and recovery.
- A replaced session/receiver epoch or an unhealthy receiver disables the controls
  rather than silently routing the decision elsewhere.
