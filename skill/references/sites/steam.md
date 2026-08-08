# Steam (store.steampowered.com)

## Overview
PC game store. Public listing pages work without login. Stable search-result selectors for years.

## Known adapters
- `steam top-sellers` — Global top-sellers list
- `steam specials` — Current discounts
- `steam wishlist <profile>` — Public wishlist by profile id
- `steam my-wishlist` — Your own wishlist (requires Chrome login)

## Key URL patterns
- Top sellers: `https://store.steampowered.com/search/?filter=topsellers`
- New releases: `https://store.steampowered.com/search/?filter=popularnew`
- Specials: `https://store.steampowered.com/search/?filter=specials`
- Game page: `https://store.steampowered.com/app/<appid>/<slug>/`

## Stable CSS selectors
- Result row: `a.search_result_row` (has `data-ds-appid`)
- Title: `.title` (inside row)
- Release date: `.search_released`
- Price container: `.search_price_discount_combined`
- Final price (text): `.discount_final_price` inside the container
- Final price (cents): `data-price-final` attribute on the container
- Discount percent: `.discount_pct` (may be absent for full-price items)

## Login requirements
None for listing. Store region detection from IP affects currency/locale. `my-wishlist` requires the user to be logged into Steam in the active Chrome profile.

## Known pitfalls
- **`.search_price` is empty**: don't query it directly — modern Steam renders price inside `.discount_final_price` even when no discount. The combined container `.search_price_discount_combined` is the source of truth.
- **Cents attribute**: `data-price-final` is integer cents (e.g. `719` = $7.19 / C$ 7.19). Downstream should divide by 100.
- **Currency varies by region**: price_text includes the local currency symbol. Adapter passes through opaque; downstream normalizes.
- **Discount may be empty**: full-price items have no `.discount_pct` element. Default to empty string, don't fail.
- **Localized release date**: text is locale-formatted (e.g. "2026 年 6 月 22 日" in zh). Pass through as opaque string.
- **Wishlist new-UI DOM**: Steam 2025+ wishlist uses class-name-obfuscated React components. Adapter anchors on `a[href*="/app/"]` and walks up until it finds a sibling that also contains an app link — that's the card boundary. Price extraction uses `¥<num>` regex matching (locale-specific); for non-CNY regions, swap the currency prefix or read from card-level text patterns.
- **Wishlist duplicate anchor**: each item has two anchors — an empty-text image link and a title link. Adapter filters `a.textContent.trim()` to skip the image link and dedupes by appid.
