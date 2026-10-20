# Google Gemini (gemini.google.com)

## Overview
Google Gemini web app. Chat interface, similar in shape to the ChatGPT adapter.
Commands operate on the Gemini tab that is already open (they do not navigate).
Pass `--tab <id>` when several Gemini tabs exist, and make that tab the active
tab in its window before running menu commands (see "Tab must be active").
Checked live 2026-10-20 against the logged-in Personal profile.

## Known adapters
Conversation and chat:
- `gemini status` — generation state, response and user-turn counts
- `gemini read` — read a turn (assistant / user / all), optional wait for completion
- `gemini wait` — wait until the current reply finishes
- `gemini send` — submit a prompt (optional model pre-selection)
- `gemini chats` — list sidebar conversations (title + URL)

Composer menus (read-only unless noted):
- `gemini menus` — everything in the composer menus: models (+ current), thinking
  effort (+ current), upload actions, available tools, selected tools, and the
  "more tools" switches (personalization)
- `gemini models` — the model list from the mode menu
- `gemini model` — select a model by index or name (verified by reading back)
- `gemini effort` — select a thinking level by index or label (verified by reading back)
- `gemini mode` — select a tool (Canvas, Deep Research, ...) by index or label, or `--clear true`
- `gemini upload` — attach a local file via the upload & tools menu (does not send)

## Key URL patterns
- New chat / home: `https://gemini.google.com/app`
- Conversation: `https://gemini.google.com/app/<conversation_id>`

## Menu structure (language-agnostic)
Labels are localized, so nothing is matched by text. Structural hooks only:
- Model menu toggle: `button[data-test-id="bard-mode-menu-button"]` (`aria-expanded`)
- Model options: `gem-menu-item[data-test-id^="bard-mode-option-"]`; the selected item carries the `selected` class
- Thinking-level submenu trigger: `gem-menu gem-menu-item[value="thinking_level"]`; its options are the `gem-menu-item` elements without a `data-test-id` in the overlay pane that holds no model options
- Upload & tools toggle: the `input-container button[aria-haspopup="menu"]` without a `data-test-id`
- Upload actions: `data-test-id` values `local-images-files-uploader-button`, `uploader-drive-button`
- Tools: plain `button.mat-mdc-list-item` items in that menu, with no `data-test-id`, no submenu, and not `hidden-*`
- "More tools" submenu: `button[data-test-id="more-tools-button"]`; it contains `personalization-toggle` (a switch, `button[role="switch"]` with `aria-checked`), not more tools
- Selected tools in the composer: `toolbox-drawer [data-test-id="deselect-drawer-item-gem-button"]`
- File input: `uploader input[type="file"]` (created only while the upload menu is open; `accept="image/*"` for images, a long document list for files)
- Attachment chips: `uploader-file-preview` (count = attachments); close button `.gem-attachment-close-button`

## Conversation selectors
- Composer: `rich-textarea div.ql-editor` (contenteditable, Quill-backed)
- Send button: `button.send-button` (rendered while the composer holds text or an attachment)
- User turn: `user-query`; text in `.query-text-line`; the screen-reader label is a `.cdk-visually-hidden` heading and is skipped
- Model turn: `model-response`; rendered answer in `.markdown`
- Streaming flag: `.markdown[aria-busy="true"]`
- Regenerate / copy: `[data-test-id="regenerate-button"]`, `[data-test-id="prompt-copy-button"]`
- Sidebar conversations: `conversations-list a[href^="/app/"]`

## How the menu commands work
Each menu command is a list of small steps:
1. `eval` — synchronous read or click (JS `.click()` on toggles and items)
2. `wait` — the CLI polls a state expression (`menus-state.js`) until the menu is open or idle

Nothing in the page waits on its own timers, so a hidden tab does not stall the
command (see pitfalls). Results accumulate on `window.__apMenus`; `menus-collect.js`
returns them. Menus are always closed again at the end.

## Login requirements
Uses the logged-in Google account in the user's Chrome. Logged-out pages show no conversations.

## Known pitfalls
- **Tab must be active.** Chrome does not render Angular menu panels in a background tab: the panel stays at its first animation frame (about 41px, a "card-container") and the items never appear. Run `ap-browser tabs activate <id>` first. The menu commands then return "upload menu not open" or empty lists if the tab is not active.
- **Models, efforts and tools change or are localized.** Never hardcode them. Read them with `gemini menus`, then pass the index. Name matching: exact match wins, otherwise the shortest name containing the substring (`Flash` picks `3.8 Flash`, not `3.5 Flash-Lite`). Effort labels change between renders (for example 低 / 低点), so prefer `--index`.
- **Tooltips can cover buttons.** CLI coordinate clicks on menu triggers can land on a tooltip instead. The menu commands therefore use JS clicks for toggles.
- **`send` is step-based too**, so it does not depend on page timers. Its submission check is an observed new `user-query` past a baseline; the send button is clicked once, with one retry only if the prompt is still in the composer after the first click. A model pre-selection (`model` arg) needs the model menu to render, so use an active tab when passing `model`. Not tested in a background tab.
- **Submission itself has not been exercised live.** Testing sends a real message to the user's account, so the click path was checked up to a ready send button (`canSend`) and the failure path (`SEND_NOT_SUBMITTED`, `MODEL_NOT_SELECTED`). Confirm with one real send before relying on it.
- **`read --wait` still uses a page-side loop** (`read.js`). Use `gemini wait` followed by `gemini read` in background tabs.
- **Trusted Types:** `gemini.google.com` blocks `innerHTML` assignment inside `eval`. Use `textContent` or DOM APIs.
- **`sites verify` ignores `--tab`** and may run against another tab. For live checks use `ap-browser --profile <p> --tab <id> gemini <cmd>`.
- **Attachments stay in the composer** until a message is sent or the chip is removed. `gemini upload` does not send.
