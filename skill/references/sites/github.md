# GitHub (github.com)

## Overview
Code hosting platform. Trending page has stable `article.Box-row` structure; per-repo metadata via `/stargazers` and `/forks` anchors.

## Known adapters
- `github trending` — Trending repositories (filterable by language and time window)
- `github issues <query>` — Global issue search (full GitHub query syntax)

## Key URL patterns
- Trending all languages: `https://github.com/trending?since=<daily|weekly|monthly>`
- Trending by language: `https://github.com/trending/<lang>?since=<window>`
- Repository: `https://github.com/<owner>/<name>`

## Stable CSS selectors
- Repo row: `article.Box-row`
- Repo name + link: `h2.lh-condensed a` (text is `owner / name`)
- Description: `p` (first paragraph inside row)
- Language: `[itemprop="programmingLanguage"]`
- Stars total: `a[href$="/stargazers"]`
- Forks: `a[href$="/forks"]`
- Stars this period: any element whose text matches `stars (today|this week|this month)`

## Login requirements
None for trending.

## Known pitfalls
- **Don't read `h2` textContent directly**: GitHub's React hydration emits error placeholders ("Sorry, something went wrong.", "Uh oh!") as sibling spans inside the h2. Read `h2.lh-condensed a` textContent only.
- **`since` is case-sensitive lowercase**: must be `daily` / `weekly` / `monthly`. Wrong case returns 200 with empty list.
- **Empty `language` filter**: trending URL `https://github.com/trending/?since=daily` works; `https://github.com/trending/rust?since=daily` filters by language. Adapter composes URL by inserting the (possibly empty) language arg into the path — empty produces `trending/?since=...`, which GitHub accepts.
- **Stars-this-period text is localized**: en/zh/ja all share the `stars (today|this week|this month)` pattern for English; localized variants exist. Regex is en-only; non-en locale may return empty for `stars_period`.
