# Hugging Face (huggingface.co)

## Overview
Model / dataset / space hub. Public listing, no login. Tailwind-class heavy DOM (class names are unstable), so adapter uses semantic tags (`article`, `h4`, `time`, `a[href]`) only.

## Known adapters
- `hf top` — Trending models

## Key URL patterns
- Trending models: `https://huggingface.co/models?sort=trending`
- Most liked: `https://huggingface.co/models?sort=likes`
- Model card: `https://huggingface.co/<org>/<name>`
- Datasets trending: `https://huggingface.co/datasets?sort=trending`

## Stable CSS selectors
- Model row: `article` (one per model)
- Model id: `h4` inside article (full `org/name` text)
- Updated time: `time` element inside article
- Link: `a[href]` inside article (relative path like `/org/name`)

## Login requirements
None for listing pages.

## Known pitfalls
- **Tailwind classes are unstable**: HF uses utility-class styling (`text-md truncate font-mono group-hover/repo:text-yellow-500 …`). These change between redesigns. Don't select by class.
- **Selector strategy**: use semantic tags (`article`, `h4`, `time`, `a`) and the structure of the article wrapper. Avoid class-based selectors entirely.
- **No likes/downloads on new UI**: as of mid-2026 the trending listing shows only task / param-count / updated-time, not likes or download counts. Those live on the model card page (separate request). Adapter returns the slim set; downstream can `goto` each card for richer stats.
- **Relative href**: `a[href]` is `/org/name` (relative). Resolve to `https://huggingface.co/org/name` for absolute URLs, or rely on `link.href` (DOM API auto-resolves).
