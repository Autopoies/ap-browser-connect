# YouTube (youtube.com)

## Overview
World's largest video platform. Heavy SPA, frequent DOM refactors (2024+ uses `yt-lockup-view-model` / `ytContentMetadataViewModel` classes). Login required for personalized homepage and notifications.

## Known adapters
- `youtube home` — Fetch recommended videos from homepage

## Key URL patterns
- Homepage: `https://www.youtube.com/`
- Video: `https://www.youtube.com/watch?v=<11char_id>`
- Channel: `https://www.youtube.com/@<handle>`

## Stable CSS selectors (2024+ layout)
- Video card: `ytd-rich-item-renderer`
- Title: `.ytLockupMetadataViewModelTitle`
- Channel link: `a[href*="/@"]`
- Duration: `.ytBadgeShapeText`
- Metadata text (views, date): `.ytContentMetadataViewModelMetadataText`
- Watch link: `a[href*="/watch"]`

## Login requirements
- Homepage recommendations: login improves quality but not strictly required
- Notifications/replies/likes: **login required**

## Known pitfalls
- DOM structure changes frequently. Pre-2024 selectors (`#video-title`, `#metadata-line`) are stale.
- Metadata spans: channel name appears twice (verification badge), dedupe before positional indexing.
- `ytd-rich-item-renderer` count changes on scroll — first N are stable.
- `\xa0` (non-breaking space) appears in view counts and durations — downstream may need normalization.
