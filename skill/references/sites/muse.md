# Muse (muse.ai)

## Overview
`muse.ai` is now the web front end of Meta's Muse personal AI agent (announced
2026-09-08). It is not the old video-hosting service: that product was renamed
**Skiv** (skiv.com) on 2026-03-03, and the muse.ai domain was handed to the agent.
This adapter targets the agent's chat UI. Checked live 2026-10-20 against the
logged-in Personal profile ("Chat — Kei").

Muse has no separate "new conversation" concept. Its conversations are the
**main chat**, **side chats** (旁聊), and **channels** (频道). A side chat *is*
the new conversation.

## Known adapters
- `muse chats` — list sidebar threads with `index` (main chat, side chats, channels), title, detail, active flag
- `muse open` — open a thread by `--index` (from `muse chats`) or `--name` (title substring)
- `muse side` — start a new side chat (`新旁聊`); the next `send` goes into it
- `muse status` — generation state and message counts
- `muse read` — read a message (assistant / user / all) of the open thread, optional wait for completion
- `muse wait` — wait until the current reply finishes
- `muse send` — submit a message in the open thread (refused in read-only channels)
- `muse upload` — attach a local file to the composer; verified by the file name appearing in the composer (does not send)

## Capabilities checked against the UI
| Capability | In muse? | Evidence |
| --- | --- | --- |
| Attach a file | yes | composer "attach" control; hidden `input[type=file]` (multiple) |
| New side chat | yes | sidebar `hatch-chat-compose` ("新旁聊"); route becomes `/thread/new` |
| Read WhatsApp channel | yes, read-only | channel row under `hatch-channel-conversations`; "只能查看 / 消息已从WhatsApp同步" notice |
| Model picker | no | composer has only attach and voice; dock menu has shortcuts, download, report, settings |
| Thinking effort | no | no effort controls anywhere in the composer or dock menu |
| Modes / tools | no | no mode or tool menus; settings tabs are general, connectors, wallet, secure storage, permissions, message channels, devices, data controls, help, legal |

The settings dialog's "data controls" tab has a switch "help improve our AI
models" (privacy). It is not a model selector and is not exposed by any command.

## Channels (WhatsApp)
- The WhatsApp channel is a **read-only mirror**: "只能查看 / 消息已从WhatsApp同步。请在WhatsApp中继续这个对话。" There is no composer.
- `muse open --name WhatsApp` opens it; `muse read` reads its messages with the same selectors as the main chat (checked: 11 messages, last user turn and last assistant turn read cleanly).
- `muse send` detects the read-only notice and refuses before typing anything (`THREAD_READ_ONLY`).
- Channel rows show a detail line "频道对话，仅限查看"; treat it as a label, not a parsed field.

## Key URL patterns
- Main chat: `https://muse.ai/`
- Threads: `https://muse.ai/thread/<uuid>`; a new unsaved side chat is `https://muse.ai/thread/new`
- Threads are SPA routes: switching is a click in the sidebar, not a page load. `muse chats` returns titles and indexes, not links.

## Stable selectors (language-agnostic)
- Thread row: `[data-testid="hatch-thread-row"]`; active row has `aria-current="page"`
- Channel section: `[data-testid="hatch-channel-conversations"]`
- Read-only notice: `[data-testid="hatch-channel-read-only-notice"]`
- New side chat button: `[data-testid="hatch-chat-compose"]`
- Composer: `textarea` (single textarea on the page; absent in read-only channels)
- Attach: `input[type="file"]` (hidden; the visible attach control is a plain button)
- Message: `[data-message-item][data-message-role="assistant"|"user"]`
- Assistant body: `[data-hatch-assistant-message-body]` inside the assistant message
- User text: the message minus its `.sr-only` label (the label is localized and is removed)
- Streaming flag: `[data-hatch-markdown-streaming="true"]`
- Upload verification: the attached file's own name appears in the page text (chip)

## Login requirements
Uses the logged-in Muse account. When logged out, the page redirects to
`auth.muse.ai` ("Not Logged In").

## Known pitfalls
- **`send` is step-based**, so it does not depend on page timers. It refuses read-only channels, fills the composer, waits for the text, presses Enter once, then waits for a new user message past the baseline. Enter is never re-pressed, so a message cannot be submitted twice.
- **Submission itself has not been exercised live.** Testing sends a real message to the user's account. Checked up to a filled composer and the failure path (`SEND_NOT_SUBMITTED`, `THREAD_READ_ONLY`). Confirm with one real send in a side chat before relying on it.
- **`open` reads its index from the same list as `chats`.** If the sidebar changes between the two calls, the index can point at a different thread. Prefer `--name` for stable targets.
- **Wait semantics:** `wait` completes when a reply exists after the last user message and nothing is streaming (`settled`). It does not wait for generation to start, so on an already-finished thread it returns at once. Checked on a thread with a real reply: returns in 0s; during a real generation it polled until the reply arrived.
- **Upload clears the file input.** muse empties `input.files` after it takes the file, so verify through the page text, not the input.
- **`read --wait` still uses a page-side loop** (`read.js`). Use `muse wait` followed by `muse read` in background tabs.
- **`sites verify` ignores `--tab`** and may run against another tab. For live checks use `ap-browser --profile <p> --tab <id> muse <cmd>`.
- **Old video embeds** that point at muse.ai are not this agent. Video content moved to skiv.com.
