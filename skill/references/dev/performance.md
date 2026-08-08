# Performance auditing

## Quick metrics snapshot

```bash
ap-browser dev perf metrics
```

Returns current Performance.getMetrics: JS heap size, node count, layout objects, JS event listeners, task/script duration, etc.

## Performance trace with Core Web Vitals

```bash
ap-browser dev perf trace --reload           # capture full page load
ap-browser dev perf trace --duration 10      # capture 10s of runtime
```

Returns: navigation timing (TTFB, FCP, domContentLoaded, loadEvent), and Performance metrics. Use `--reload` to measure page load, or `--duration` to measure runtime interactions.

### Workflow: measure page load speed

```bash
ap-browser goto "about:blank"                # reset
ap-browser dev perf trace --reload           # navigate + measure
# look at vitals.fcp_ms (First Contentful Paint), vitals.ttfb_ms (Time to First Byte)
```

## Lighthouse audit

```bash
ap-browser dev lighthouse                                     # audit current tab (all categories)
ap-browser dev lighthouse --categories accessibility          # a11y only
ap-browser dev lighthouse --categories accessibility,seo      # multiple
ap-browser dev lighthouse --url https://example.com          # audit specific URL
```

Lighthouse runs via the system `npx lighthouse` CLI (no internal Chrome dependency). Categories: `accessibility`, `best-practices`, `seo`, `performance`.

Output includes per-category scores (0-100) and the full raw Lighthouse JSON for detailed drill-down.

### Prerequisite

Requires Node.js + npx. If `npx lighthouse` fails, install:

```bash
npm install -g lighthouse
```

### Workflow: a11y audit before shipping

```bash
ap-browser dev lighthouse --categories accessibility
# scores.accessibility.score should be >= 90 for production
# drill into raw.audits for specific failures
```

## When to use which

| Goal | Command |
|---|---|
| One-shot metrics (memory, nodes) | `dev perf metrics` |
| Page load timing (LCP/FCP/TTFB) | `dev perf trace --reload` |
| Runtime interaction timing (INP) | `dev perf trace --duration 10` |
| Full audit with recommendations | `dev lighthouse --categories performance` |
| Accessibility compliance check | `dev lighthouse --categories accessibility` |
