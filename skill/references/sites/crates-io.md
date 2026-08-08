# crates.io (crates.io)

## Overview
Rust package registry. Svelte SPA but search page renders server-side for crawlers. Stable `.crate-row` family.

## Known adapters
- `crates-io search` — Crate search with pagination

## Key URL patterns
- Search: `https://crates.io/search?q=<q>&page=<n>`
- Crate: `https://crates.io/crates/<name>`

## Stable CSS selectors
- Crate row: `.crate-row`
- Name link: `a.name`
- Version: `.version`
- Description: `.description`
- Stats list: `.stats > li.downloads` (all-time), `.stats > li.recent-downloads` (90-day)

## Login requirements
None for search.

## Known pitfalls
- **Stat text has redundant prefix**: `.downloads` li textContent is `All-TimeDownloads: 771,878,953` (with sr-only span). Adapter strips the prefix via regex.
- **Pagination is 10/page** (smaller than most sites). High `page` numbers return empty results without error — just empty list.
- **Svelte hydration**: the search page renders content during SSR, so first DOM snapshot is complete. No SPA lazy-load; `scroll` step not needed.
