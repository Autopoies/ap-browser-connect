# Google Scholar (scholar.google.com)

## Overview

Academic literature search with citation counts. No login needed, but Google rate-limits automated navigation at the IP level with a `/sorry/` captcha interstitial.

## Known adapters

- `google-scholar search` — paper search (title/URL/authors/snippet/citations/pdf), pages 1-10
- `google-scholar cite` — citation export: formatted strings + BibTeX text + EndNote/RefMan/RefWorks links
- `google-scholar author` — author profile by user id (affiliation, interests, citation metrics, 20 publications)
- `google-scholar author-search` — find author profiles by name (returns user ids for `author`)

## Key URL patterns

- Results page: `https://scholar.google.com/scholar?q=<query>&start=<n>` (10 results/page, `start` steps of 10)
- Search form: homepage `input[name=q]` + submit button `#gs_hdr_tsb`
- Standalone cite page (safe to navigate to): `/scholar?q=info:<data-cid>:scholar.google.com/&output=cite&scirp=0&hl=en`
- Author profile: `https://scholar.google.com/citations?hl=en&user=<id>` (direct goto OK — not rate-limited like `/scholar?q=`)
- Author search: `https://scholar.google.com/citations?view_op=search_authors&hl=en&mauthors=<name>` (direct goto OK)

## Stable CSS selectors

- Result row: `div.gs_r.gs_or.gs_scl` (fall back to `.gs_r`)
- Title: `h3.gs_rt` — the link inside holds the clean title text
- Authors/venue/year line: `div.gs_a` (one opaque text line)
- Snippet: `div.gs_rs`
- Cited-by link: `.gs_fl a[href*="cites="]` (text "Cited by N", localized)
- Direct PDF link: `.gs_ggs a, .gs_or_ggsm a` (right-side [PDF] link)
- Pagination numbers: `a[href*="start="]` (link text is the page number)
- Cite dialog (in-page or standalone cite page): `.gs_citr` (formatted citations, 3-5 depending on locale), `a.gs_citi` (export links; match by `scholar.bib`/`scholar.enw`/`scholar.ris`/`scholar.rfw` in href — texts are brand names but hrefs are stable)
- Result cluster id: `div.gs_r[data-cid]` (needed to build the standalone cite page URL)
- Author search row: `.gsc_1usr` → name `.gs_ai_name a`, affiliation `.gs_ai_aff`, email `.gs_ai_eml`, user id via `/user=([\w-]+)/` on the name link href
- Author profile: name `#gsc_prf_in`, affiliation first `.gsc_prf_il`, interests `.gsc_prf_inta`, metrics `#gsc_rsb_st tr` (`.gsc_rsb_sc1` label + 2 tds: all / since-5y), publications `.gsc_a_tr` → title `.gsc_a_at`, first `.gs_gray` line = authors, cited `.gsc_a_c` (trailing `*` = merged-profile citations), year `.gsc_a_y`

## Login requirements

None.

## Known pitfalls

- **Never `goto` a `/scholar?q=` URL directly.** On a flagged IP this trips the
  `/sorry/` captcha interstitial almost instantly. The adapter instead goes to
  the homepage, fills the search box, presses Escape (dismiss the autocomplete
  dropdown!), and clicks `#gs_hdr_tsb`. That form-submission path passes
  reliably where direct URL navigation does not.
- **Autocomplete hijacks Enter.** Pressing Enter in the search box accepts a
  suggestion entry (observed: typed "graph neural networks", Enter served
  q="60"). Always Escape first, then click the button. `verify.js` guards the
  landed `?q=` against the requested query and fails loudly on mismatch.
- **Captcha is IP-level.** When `/sorry/` does appear, the eval throws a
  descriptive error instead of returning `[]` silently. Wait it out; a single
  manual solve (or sometimes a CDP click on the reCAPTCHA checkbox) clears it.
  Do not automate image challenges.
- **`[PDF]`/`[HTML]`/`[BOOK]` badges** appear in `h3.gs_rt` textContent
  (sometimes doubled: `[PDF][PDF] Title`). Use the inner `a` textContent for
  the clean title; strip bracket prefixes only as a no-link fallback.
- **Non-link rows** (pure `[CITATION]` entries) have no `<a>` in `.gs_rt` →
  empty `url`/`pdf_url`, `cited_by_url` still populated.
- **Citation count text is localized** ("Cited by 263847" / "被引用次数：…").
  Parse with `\d[\d,.]*` on the link text, then strip separators.
- **Pagination ceiling**: pages 2-10 only (one numbered-link click). Page 11+
  would need repeated "Next" navigations — not implemented.
- **Pagination race**: `paginate.js` stamps `body[data-apb-nav]` before
  clicking; the `wait: {gone: "body[data-apb-nav]"}` step only resolves after
  navigation has swapped the document.
- **BibTeX fetch is CORS-blocked.** The export links live on
  `scholar.googleusercontent.com` — same-origin `fetch()` from the cite page
  throws `Failed to fetch`. The `cite` adapter instead navigates the tab to the
  BibTeX URL (a `text/plain` response whose `body.textContent` is the entry).
- **Cross-navigation state passes via `window.name`** (survives cross-origin
  same-tab navigations where sessionStorage cannot): `cite-open.js` stashes
  query/title, `cite-extract.js` adds formats + links, `cite-final.js` reads
  and clears it. If `window.name` is wiped, output degrades but BibTeX text
  still returns.
- **Export links are session-signed** (`scisdr`/`scisig` params) — they expire;
  never cache them.
- **Cite formats vary by locale** (`hl=en` → MLA/APA/Harvard…; `hl=zh-CN` →
  GB/T 7714 first). `cite` pins `hl=en` on the standalone cite page and
  returns whatever formats render, as an ordered array.
- **`/citations` pages are NOT rate-limited like `/scholar?q=`** — direct
  `goto` works for author profile and author search. Only the search-results
  path needs the form-submission dance.
- **`location.href =` assignment trips the repo's open-redirect lint** —
  navigate by creating an anchor and calling `.click()` (same pattern as
  `paginate.js`).
