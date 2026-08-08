# Reddit (www.reddit.com)

## Overview
Community link aggregator. Public `.json` API returns JSON instead of HTML — adapter parses JSON directly, bypassing the SPA DOM entirely.

## Known adapters
- `reddit hot <subreddit>` — Hot posts for a subreddit (no login)

## Key URL patterns
- Subreddit hot (JSON): `https://www.reddit.com/r/<sub>/hot/.json?limit=<n>`
- Subreddit new (JSON): `https://www.reddit.com/r/<sub>/new/.json?limit=<n>`
- Subreddit top (JSON): `https://www.reddit.com/r/<sub>/top/.json?limit=<n>&t=<day|week|month|year|all>`
- Post permalink: `https://www.reddit.com/r/<sub>/comments/<id>/...`

## Stable CSS selectors
- None — adapter reads `document.body.innerText` and JSON.parses it.

## Login requirements
None for public subreddits. Some subreddits are private/quarantined and will return errors in the JSON.

## Known pitfalls
- **`.json` suffix is the whole pattern**: appending `/.json` to most reddit URLs returns the API representation. The adapter loads this URL directly — no DOM scraping.
- **Wait selector**: `pre` works because reddit's JSON response is rendered inside a `<pre>` tag. If reddit ever wraps JSON differently, fall back to `body`.
- **Rate limiting**: anonymous requests are throttled aggressively. Adapter deliberately caps `limit` via the URL param rather than fetching all and slicing — fewer requests, smaller JSON.
- **`over_18` / quarantined**: such subreddits return redirect JSON instead of listings. Adapter returns whatever posts exist; missing data is silent.
- **No comments tree**: this adapter returns post metadata only. Comment trees need a separate request to `/<permalink>.json`.
