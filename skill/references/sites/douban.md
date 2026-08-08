# 豆瓣电影 (movie.douban.com)

## Overview
Chinese movie review community. Top250 list has stable server-rendered DOM. No login needed for Top250.

## Known adapters
- `douban top250` — 豆瓣电影 Top 250 (page 1, 25 entries)

## Key URL patterns
- Top250 page 1: `https://movie.douban.com/top250`
- Top250 page N: `https://movie.douban.com/top250?start=<25*(N-1)>&filter=`
- Movie: `https://movie.douban.com/subject/<id>/`

## Stable CSS selectors
- Movie item: `#content .item` (must scope with #content — bare `.item` matches unrelated nav)
- Rank: `.pic em`
- Poster link: `.pic a`
- Chinese title: `.hd .title` (first one)
- English title: `.hd .title` (second one, prefixed with `/`)
- Rating: `.rating_num`
- Quote: `.quote`
- Year + director + genres: inside `.bd p` (mixed text, regex-extract year)

## Login requirements
None for Top250.

## Known pitfalls
- **Scope with `#content`**: bare `.item` returns 28 results including 3 unrelated sidebar/nav items. Inside `#content` it returns exactly 25.
- **Two `.title` spans**: Chinese + English (with `&nbsp;/&nbsp;` separator). Adapter strips the separator.
- **Pagination**: Top250 has 10 pages of 25. Adapter only fetches page 1 by design — extend with `start` arg if needed.
- **`.bd p` mixes everything**: director + cast + year + country + genre in one text blob. Adapter regex-extracts 4-digit year only; richer parsing belongs in downstream.
- **CN-locale**: ranks are numeric strings, ratings are decimal strings ("9.7"). Pass through as opaque.
