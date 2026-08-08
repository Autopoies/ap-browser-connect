# Lobsters (lobste.rs)

## Overview
Computing-focused link aggregator. Simple server-rendered HTML, very stable `.story` selectors, no login needed for reading.

## Known adapters
- `lobsters hot` — Front page hot stories
- `lobsters newest` — Newest submissions
- `lobsters tag` — Stories filtered by tag

## Key URL patterns
- Hot (front page): `https://lobste.rs/` (note: no `/hot` path — root IS hot)
- Newest: `https://lobste.rs/newest`
- Recent (active): `https://lobste.rs/recent`
- By tag: `https://lobste.rs/t/<tag>`
- Story comments: `https://lobste.rs/s/<shortid>/<slug>`

## Stable CSS selectors
- Story row: `li.story`
- Title link: `.u-url` (single anchor inside `.link`)
- Vote count (score): `.upvoter` (text content is the score, used as both vote button label and count)
- Tags: `.tag` (also `.tag_<name>` per-tag for styling — use base `.tag`)
- Author: `.byline a[href^="/~"]` (user profile link, tilde-prefixed)
- Comments link: any `a` whose pathname matches `/s/<shortid>` (no dedicated class)

## Login requirements
None for reading. Login only needed for upvote/comment.

## Known pitfalls
- **No `/hot` URL**: front page is the root `/`. Requesting `/hot` returns 404. Three commands (`hot` / `newest` / `tag`) instead of one with a `tab` arg, because schema goto can't conditionally emit empty path segment.
- **`.upvoter` is the vote button, not just the score**: textContent is the score (e.g. `99`). When logged out it links to `/login`, but the text still works as score.
- **Comments link has no class**: must scan `a` elements for pathname pattern `/s/<shortid>`. Don't match by text "comments" — text is locale-free but format varies (`"52 comments"`, `"discuss"` for zero comments).
- **Tag pill has duplicate classes**: each tag element has both `.tag` and `.tag_<name>` (e.g. `.tag_rust`). Always select `.tag` to get the label, not the per-tag styling class.
