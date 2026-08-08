# Wikipedia (en.wikipedia.org)

## Overview
English Wikipedia. Stable selectors, no login needed. Search has two modes:
- **Go mode** (default): exact-title match redirects straight to the article
- **Full-text search**: lists multiple matches — requires `&fulltext=1` URL param

## Known adapters
- `wikipedia search` — Full-text article search

## Key URL patterns
- Search results: `https://en.wikipedia.org/w/index.php?search=<q>&title=Special:Search&fulltext=1`
- Article: `https://en.wikipedia.org/wiki/<title>`
- Summary API (alt): `https://en.wikipedia.org/api/rest_v1/page/summary/<title>` (JSON, no DOM)

## Stable CSS selectors
- Result row: `ul.mw-search-results > li`
- Title link: `.mw-search-result-heading a` (title text + href)
- Description: `.searchresult`
- Word count / timestamp: `.mw-search-result-data`

## Login requirements
None.

## Known pitfalls
- **Go vs search**: omitting `&fulltext=1` triggers exact-title redirect, returning zero results on the search page (the URL becomes the article URL). Always include `fulltext=1` for list-style search.
- **Title link has nested `<span class="searchmatch">`**: `a.textContent` flattens them — works fine, but don't try to read title from a leaf span.
- Title link may be the only stable anchor per row — other text elements can vary across skins.
