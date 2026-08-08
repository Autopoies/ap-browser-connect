# arXiv (arxiv.org)

## Overview
Open-access scholarly article archive. Public search, no login. Stable DOM using `.arxiv-result` family.

## Known adapters
- `arxiv search` — Full-text paper search

## Key URL patterns
- Search (all fields): `https://arxiv.org/search/?searchtype=all&query=<q>`
- Paper abstract: `https://arxiv.org/abs/<id>`
- Paper PDF: `https://arxiv.org/pdf/<id>`

## Stable CSS selectors
- Result row: `li.arxiv-result`
- Title text: `p.title`
- Title link (also arxiv id source): `p.list-title a[href*="/abs/"]`
- Authors block: `.authors` (text content needs `Authors:` prefix stripped)
- Abstract: `.abstract` (needs `Abstract:` prefix stripped)
- Subjects: `.primary-subject` (primary) + `.tags .tag` (others)

## Login requirements
None.

## Known pitfalls
- **Query URL must include `searchtype=all`**: bare `?query=` triggers the old 1990s search form, which renders different markup and zero `.arxiv-result` rows.
- **Authors/abstract have prefix labels**: textContent starts with `Authors:\n` or `Abstract:\n`. Strip with regex + collapse whitespace.
- **Abstract is unbounded**: server returns full abstract (~2000 chars). Adapter slices to 400 chars for downstream readability; bump if needed.
- **arxiv_id regex**: `\d+\.\d+` (e.g. `2606.32036`). Old IDs like `cs/0701001` exist but rare in search results — current format dominates.
- **Subjects vs primary**: `.primary-subject` is the main category; secondary categories are in `.tags .tag`. Adapter returns combined array.
