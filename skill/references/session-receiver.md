# Session receiver health and acknowledgements

Read this when implementing a mailbox receiver or diagnosing an unverified binding.
The browser distinguishes saved binding, receiver readiness, and message progress.
A PID, an existing inbox, or disappearance of a mail file proves none of the latter two.

## Protocol requirements

The file-drop envelope uses `v: 1`. Interactive sending requires a fresh receiver
lease. Without valid readiness evidence, a saved binding is **unverified** and
Ask/Run/Summarize/Send/Approve are paused. Pinning and CLI state/screenshot remain
available. The receiving module publishes leases and explicit acknowledgements;
the native host validates them. Neither requires an agent-model call. A manually
fabricated lease or an unrelated heartbeat is not readiness evidence.

## Receiver lease

Create an unpredictable `receiver_epoch` per receiver activation. Rotate it whenever
the session changes, the receiving module restarts, or the same session is resumed
under a new receiver. Atomically write `<inbox>/.ap-browser/receiver.json`:

```json
{
  "v": 1,
  "session_id": "session-123",
  "pid": 12345,
  "receiver_epoch": "unique-per-activation",
  "state": "ready",
  "issued_at": 1792450000000,
  "expires_at": 1792450020000
}
```

Times are Unix milliseconds on the local machine. Use current values, not the
example above. Renew from the **actual accepting/dispatching loop** (suggested:
every 5 seconds, 20-second lifetime; the host rejects lifetimes over 60 seconds).
Readiness means the receiver can validate and durably accept work, not that the
model is idle. A long model task must not block the receiving loop. If the receiver
cannot accept more work, stop renewing; on orderly stop publish `state: "offline"`.
Never let an old receiver overwrite a new receiver's lease.

If the inbox uses the optional `<root>/inbox/<session_id>` / `<root>/peers/` layout,
the corresponding peer record must also exist and have matching `sessionId` and
`pid`. Missing registration is offline; unreadable metadata is unknown. A valid
lease cannot override a mismatched peer identity.

The host returns `health: {state, reason, checked_at, valid_until, receiver_epoch?}`.
The extension pins the epoch on initial verification. A changed epoch is offline
and requires explicit rebind; lease expiry or transport failure is unknown and
may recover with the same epoch. Unknown preserves the interactive layout but
pauses remote actions. Offline restores Pin Mode and preserves drafts and history.
Health checks run while the worker is active, with a Chrome alarm wake fallback;
opening/revealing the dock and sending also check state. Suspension can delay
observations, so UI and send guards also enforce the evidence deadline.

## Receiving a message

The existing `ap_browser` envelope gains `receiver_epoch` and `expires_at` (Unix ms).
Before accepting any mail:

1. Verify `to`, `ap_browser.receiver_epoch`, and deadline against the current receiver.
2. Deduplicate by `id` within that receiver identity. Store the accepted work and
   deduplication record durably before acknowledging it. Re-reading the same ID
   must not execute it twice.
3. Atomically write `<inbox>/.ap-browser/receipts/<event_id>.json`:

```json
{
  "v": 1,
  "event_id": "mail-0123456789abcdef0123456789abcdef",
  "session_id": "session-123",
  "receiver_epoch": "unique-per-activation",
  "status": "accepted",
  "message": "Accepted into receiver queue"
}
```

`status` is `accepted`, `rejected`, or `expired`. For rejected/expired mail, include a
human-readable reason and echo the message's target session/epoch so the sender
can correlate the rejection. Do not report acceptance for a stale target. Send a
negative receipt when dead-lettering; moving/removing a mail file is not a receipt.

The host monitors receipts for about 60 seconds. A matching receipt advances
`queued` to its reported status; without one it reports `unconfirmed` (outcome
unknown, not proof of failure). Keep receipt files at least until that observation
window has elapsed, and keep durable deduplication records according to the
receiver's retention policy. Temporary/control files live under `.ap-browser/`,
outside the top-level mail-file scan. Keep all files owned by the local user;
write private files (0600 on Unix) using a temporary file plus atomic rename.

## Execution and recovery

`accepted` means accepted into the receiver queue, **not running**. Only the
execution side reports `running`, `done`, `confirm`, or `error` using
`ap-browser reply --event-id <id> --status <status> --message <text>`.
Neither acceptance nor a user request implicitly approves destructive commands.
Keep the existing command safety audit and explicit-confirmation policy.

The browser stores event/thread routing in Chrome session storage so a worker
restart does not lose routing. Pending acknowledgement deadlines are reconciled
after restart. The dock's DOM history and drafts survive health/mode changes, not
a full page navigation or browser restart. The system does not automatically
retry uncertain deliveries, replay a draft on reconnection, or silently retarget
an existing thread to a different receiver. A fresh user submission has a fresh
message ID; check uncertain prior work before manually resubmitting it.
