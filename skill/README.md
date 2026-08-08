# ap-browser-connect skill

The agent skill for [ap-browser](https://github.com/autopoies/ap-browser-connect) — the open, vendor-neutral way to let any AI agent drive your already-logged-in Chrome.

## Install

This skill follows the [vercel-labs/skills](https://github.com/vercel-labs/skills) convention:

```bash
npx skills add autopoies/ap-browser-connect/skill
```

The agent (Claude Code, Cursor, Codex, ...) then activates this skill on browser-related prompts.

**Installing the skill is not the same as installing ap-browser.** The skill tells your agent *how to use* `ap-browser`; the CLI binary, native host, Chrome extension, and runtime data are installed separately. Once the skill loads, the agent reads `install.md` and walks through the 4 install steps automatically.

## TL;DR — paste into your agent

```
Install ap-browser: run `npx skills add autopoies/ap-browser-connect/skill` if the skill isn't already installed, then read that skill's `install.md` and follow the 4 steps it describes (release binaries, extension load-unpacked, native manifest, adapters/filters). Verify with `ap-browser ping`. If any step fails, open https://github.com/autopoies/ap-browser-connect/blob/main/skill/install.md and follow it manually.
```

## Directory contents

| Path | Purpose |
|---|---|
| `SKILL.md` | Agent entry point — description, command menu, when-to-use rules |
| `install.md` | Installation reference (binaries + extension + manifest + runtime data) — agent reads this on first activation |
| `install.sh` | `curl \| bash` convenience wrapper that runs `npx skills add` |
| `references/commands.md` | Full command reference (flags, examples, edge cases) |
| `references/patterns.md` | Recipe catalog (scrape, fill, SPA wait, pagination, screenshot) |
| `references/output-contract.md` | JSON envelope, `meta.focus`, exit codes, truncation |
| `references/multi-profile.md` | Multiple Chrome profiles online |
| `references/create-site.md` | How to author a new site adapter |
| `references/sites/` | Per-site knowledge docs (selectors, URL patterns, pitfalls) for adapter contributors |
| `references/dev/` | Dev-mode debugging reference (console, network, performance, emulation) |
| `references/capture-download.md` | Capture & download reference |

## Compatibility

Compatible with any agent that follows the vercel-labs/skills convention:
Claude Code, Cursor, Codex, GitHub Copilot, and 30+ others. The skill is plain
Markdown with YAML frontmatter — no runtime, no dependencies beyond the
`ap-browser` CLI it documents.

## License

Apache-2.0
