# Reddit (www.reddit.com)

## Overview

Use the Reddit adapters to read ordinary rendered pages. Reddit can return a
network-security HTML page from a `.json` endpoint even when its normal webpage
works; do not rely on JSON endpoints or same-origin API fetches as a fallback.
A normal webpage that is itself blocked, private or login-gated remains an access
limitation, not permission to bypass Reddit's controls.

## Commands

```sh
ap-browser reddit hot --subreddit programming --limit 25
ap-browser reddit new --subreddit ClaudeCode --limit 25
ap-browser reddit top --subreddit rust --period week --limit 25
ap-browser reddit search --query "browser automation" --limit 25
ap-browser reddit user --username pro-vi --limit 25
ap-browser reddit post --permalink /r/ClaudeCode/comments/1xato0b/fable_55_imminent/ --limit 10
```

Public content does not require login in the adapter contract, but Reddit may
require the browser's authenticated session in a particular environment. Use the
intended Chrome profile. The adapter opens a silent tab when the current site
does not match; an explicit `--tab` targets that tab instead.

## Rendered DOM contract

Observed on Shreddit in October 2026; selectors are version-dependent:

- **Hot/new/top:** `shreddit-post[post-title][permalink]`. Read `post-title`,
  `content-href`, `permalink`, `score`, `comment-count`, `author`, and
  `subreddit-name` / `subreddit-prefixed-name`. Skip empty placeholders and
  promoted posts; deduplicate canonical permalinks before applying the limit.
- **Search:** title anchors `a[data-testid="post-title"]` and
  `a[data-testid="post-title-text"]` inside
  `[data-testid="search-post-with-content-preview"]`. These pages may have no
  `shreddit-post`. Thumbnail, preview and Reply anchors repeat URLs and are not
  extra results. The observed `[data-testid="search-counter-row"]` contains two
  `faceplate-number[number]` elements: votes first, comments second. Read their
  raw attributes, not rounded/localized labels; a lone counter is ambiguous.
- **User overview:** read both `shreddit-post` and `shreddit-profile-comment[href]`
  in DOM order. Comments use the `.md` body, `shreddit-comment-action-row[score]`,
  and `time[datetime]`; preserve `kind: "link" | "comment"`. A Reply link is not a
  post. Some profiles hide activity, so an empty overview is not proof that the
  user has never posted.
- **Post:** select the `shreddit-post` matching the requested post ID, not a
  related recommendation. Read `[slot="text-body"]` and top-level
  `shreddit-comment` bodies; exclude nested replies and never inherit a reply's
  text for a deleted parent. AutoModerator is not deliberately filtered out.
  Normalize available creation times to ISO 8601 UTC (`...Z`).

## Limits and output

Feed/search/profile results lazy-load. The adapters scroll before extraction,
with effort derived from `limit`, then deduplicate and cap the returned rows.
The scroll primitive caps a request at 50 scrolls. `limit` is an upper bound,
not a promise that private, exhausted, hidden or unavailable content exists.
When validating a change, test the default 25, not only limits of 2–3.

Keep the existing output field names and string-valued scores/counts. Missing
rendered metadata is an empty string, not an invented zero. In search results,
`url` is the Reddit post permalink: the cards do not reliably expose the outbound
link destination. Hot/new/top preserve the outbound `content-href` when present.
User bodies retain the 500-character bound; post bodies and comment bodies retain
2000- and 1000-character bounds respectively. `post --limit` caps top-level
comments, not nested replies or the post itself.

## Verification and recovery

Use `ap-browser sites lint reddit`, then `ap-browser sites verify reddit <cmd>`
with appropriate test arguments. Check real row counts, distinct permalinks,
user comment kinds/bodies and post comment timestamps, not just a non-empty
result. If Reddit changes its markup, inspect the ordinary page and update the
selectors; a `pre` wait or `JSON.parse(document.body.innerText)` is not a rendered
page readiness check. Run `ap-browser update` to obtain published adapter fixes;
local edits to synchronized adapters can be overwritten by an update.
