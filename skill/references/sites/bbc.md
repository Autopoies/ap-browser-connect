# BBC News (www.bbc.com)

## Overview
British public broadcaster. Headline-only listing works well; full articles often lazy-loaded with auth prompts. Adapter returns title + URL pairs only.

## Known adapters
- `bbc news` — Front page headlines

## Key URL patterns
- Front page: `https://www.bbc.com/news`
- Article: `https://www.bbc.com/news/articles/<id>` or `https://www.bbc.co.uk/news/resources/idt-<uuid>`

## Stable CSS selectors
- Headline element: `[data-testid="card-headline"]` (an `h2`)
- Headline link: `h.closest('a')` — headline `h2` is wrapped directly by the anchor

## Login requirements
None for the front page listing.

## Known pitfalls
- **No card wrapper**: BBC renders `[data-testid="card-headline"]` as a bare `<h2>` inside `<a>`. There is no enclosing card container — `closest('article')` returns null. Read fields off the link, not a card.
- **Duplicate headlines on front page**: same story appears in multiple sections (lead + topic strip). Adapter dedupes by URL.
- **bbc.com vs bbc.co.uk**: links may cross between the two domains depending on geo. Both work; don't normalize.
- **Headlines only**: extracting summaries requires loading each article page (slow, per-request). Adapter deliberately returns title + URL only — feed downstream `ap-browser goto` for full text.
