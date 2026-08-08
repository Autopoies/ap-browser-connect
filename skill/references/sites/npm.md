# npm (www.npmjs.com)

## Overview
JavaScript package registry. Search page is server-rendered React with hashed utility classes (unstable) but stable semantic `<section>` boundaries.

## Known adapters
- `npm search` — Package search

## Key URL patterns
- Search: `https://www.npmjs.com/search?q=<q>`
- Package: `https://www.npmjs.com/package/<name>`

## Stable CSS selectors
- Result card: `section` (one per result — npm wraps each result in a top-level section)
- Name link: `a[href*="/package/"]` containing `h3` (or `h2`)
- Description: `p` (first paragraph inside section)

## Login requirements
None for search.

## Known pitfalls
- **Hashed utility class names**: npm uses Tachyons-style hashed classes (`bea55649`, `db7ee1ac`). They change between deploys. Select by tag and href pattern, never by class.
- **Section is the only stable boundary**: result cards are wrapped in `<section>` tags, 20 per search page. Don't look for `.card` or `.result` classes — they don't exist or change.
- **Version is buried in text**: section textContent has `• 5.2.1 • 7 months ago • ...` pattern. Adapter regex-extracts the first `• <version> •` segment.
- **No pagination via URL**: npm search uses infinite scroll. For v1, adapter returns top 20; raise via `scroll` step if needed (npm does load more on scroll).
