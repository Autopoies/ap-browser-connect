# LINUX DO (linux.do)

## Overview
Chinese tech community on Discourse. Public read, stable Discourse selectors. Cloudflare-protected (5s shield on first visit).

## Known adapters
- `linux-do top` — Top topics

## Key URL patterns
- Top: `https://linux.do/top`
- Latest: `https://linux.do/latest`
- Topic: `https://linux.do/t/topic/<id>`

## Stable CSS selectors
- Topic row: `tr.topic-list-item` (also has `[data-topic-id]`)
- Title link: `a.title.raw-link` (or `a.title`)
- Category: `.badge-category .category-name`
- Replies: `.posts-map`
- Views: `.views`
- Activity: `.activity`

## Login requirements
Reading top/latest: not required. Cloudflare visitor cookie usually auto-granted.

## Known pitfalls
- **Cloudflare 5s shield**: first goto hits `/top?__cf_chl_f_tk=...` and waits ~10s before content renders. `wait` selector retries handle this; if first attempt fails, retry the command.
- **No likes on listing pages**: Discourse top/latest list shows replies/views/activity only. Likes need per-topic fetch — out of scope for adapter.
- **Discourse SPA**: subsequent navigations don't trigger full page loads; the adapter always does fresh `goto` to bypass SPA state.
- **Localized text**: "1 小时" / "11.7k" — adapter passes through as opaque strings; don't parse to numbers downstream.
