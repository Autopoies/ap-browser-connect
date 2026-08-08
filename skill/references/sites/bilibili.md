# Bilibili (bilibili.com)

## Overview
Chinese video sharing platform. Search is SPA — needs `wait` for results to render. Comments require login.

## Known adapters
- `bilibili search` — Search videos by keyword
- `bilibili home` — Fetch recommended videos from homepage
- `bilibili replies` — Fetch reply notifications (who replied to your comments)
- `bilibili likes` — Fetch like notifications (who liked your comments)

## Key URL patterns
- Search: `https://search.bilibili.com/all?keyword=<q>&page=<n>`
- Video page: `https://www.bilibili.com/video/<BV id>`

## Stable CSS selectors
- Video card: `.bili-video-card`
- Title: `.bili-video-card__info--tit`
- BV id: extract from `<a href>` via regex `/BV\w+/`
- Author (UP): `.bili-video-card__info--author`
- Stats (plays/danmaku): `.bili-video-card__info--stats-item` (index 0 = plays, 1 = danmaku)

## Login requirements
- Search: not required
- Comments: required — use the user's logged-in Chrome session

## Known pitfalls
- Search page is a SPA. **Must** `wait` for `.bili-video-card` before evaluating selectors.
- BV id format: `BV` + 10 chars base58 (e.g., `BV1xx411c7mD`).
- Stats text includes units (e.g., `"1.2万播放"` = 12k views) — may need parsing for numeric comparison.
