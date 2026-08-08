# Stack Overflow (stackoverflow.com)

## Overview
Q&A site for programmers. Stable DOM since 2022 Stacks redesign (`s-post-summary` family). No login needed for browsing.

## Known adapters
- `stackoverflow search` — Search questions by tag, sorted by tab

## Key URL patterns
- Tag listing: `https://stackoverflow.com/questions/tagged/<tag>?tab=<Votes|Newest|Frequent|Bounties|Unanswered>`
- Question: `https://stackoverflow.com/questions/<id>/<slug>`
- Search: `https://stackoverflow.com/search?q=<query>`

## Stable CSS selectors
- Post row: `.s-post-summary`
- Title link: `.s-post-summary--content-title a` (or `h3 a` as fallback)
- Excerpt: `.s-post-summary--content-excerpt`
- Stat (votes/answers/views): `.s-post-summary--stats-item` — three siblings in fixed order
- Stat number: `.s-post-summary--stats-item-number`
- Tags: `.s-tag`

## Login requirements
None for reading.

## Known pitfalls
- **Stats are positional**: three `.s-post-summary--stats-item` siblings in fixed order (votes, answers, views). Index 0/1/2 — don't filter by unit text, the order is stable across pages.
- **Tag count varies**: questions may have 0–5 `.s-tag` elements. Always map + accept empty arrays.
- **Tab names are capitalised in URL**: `Votes`, `Newest`, `Frequent`, `Bounties`, `Unanswered` — case-sensitive.
- **Excerpt length**: SO truncates excerpts server-side; `.slice(0, 200)` is a safety cap on top of SO's own truncation.
