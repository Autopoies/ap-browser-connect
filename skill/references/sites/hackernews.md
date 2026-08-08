# Hacker News (news.ycombinator.com)

## Overview
Social news site focused on tech. Simple HTML structure, no login needed for reading, very stable selectors.

## Known adapters
- `hackernews top` — Fetch top stories from the front page

## Key URL patterns
- Front page: `https://news.ycombinator.com/`
- Comments page: `https://news.ycombinator.com/item?id=<id>`

## Stable CSS selectors
- Story row: `.athing`
- Title link: `.titleline a` (inside the row)
- Points: `.subtext .score`
- Comment count: `.subtext a:last-child`

## Login requirements
None for reading.

## Known pitfalls
- The story row and its subtext are **sibling** elements (`.athing` + next `.subtext`), not parent-child. Use `row.nextElementSibling` to access subtext.
- Comment count text format: `"123 comments"` — needs parsing to extract the number.
