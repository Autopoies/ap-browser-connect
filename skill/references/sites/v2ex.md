# V2EX (v2ex.com)

## Overview
Creative worker community. Simple server-rendered HTML, stable selectors, no SPA complexity.

## Known adapters
- `v2ex hot` — Fetch hot topics from the front page

## Key URL patterns
- Hot tab: `https://www.v2ex.com/?tab=hot`
- Topic: `https://www.v2ex.com/t/<topic_id>`

## Stable CSS selectors
- Topic item: `.cell.item`
- Title: `.item_title a`
- Node tag: `.node`
- Author: `.topic_info strong a`
- Reply count: `.count_livid`

## Login requirements
- Reading: not required
- Posting/replying: required

## Known pitfalls
- Rate limiting: V2EX may throttle rapid successive requests. Add `wait` between operations if hitting errors.
- Reply count is in a small colored span, not the main text — use `.count_livid` not a text match.
