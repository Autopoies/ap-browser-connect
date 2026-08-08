# Emulation testing

## Color scheme

```bash
ap-browser dev emulate dark      # set prefers-color-scheme: dark
ap-browser dev emulate light     # set prefers-color-scheme: light
ap-browser dev emulate auto      # clear override (use system default)
```

Use to test dark mode CSS without changing OS settings.

## Viewport size

```bash
ap-browser dev emulate viewport 375x667                              # iPhone SE size
ap-browser dev emulate viewport 375x667 --device-pixel-ratio 3       # retina
ap-browser dev emulate viewport 375x667 --mobile                     # mobile + touch
ap-browser dev emulate viewport 1920x1080                            # desktop
```

Use to test responsive layouts. `--mobile` enables touch events.

## Geolocation

```bash
ap-browser dev emulate geo 40.7128,-74.0060     # New York
ap-browser dev emulate geo 35.6762,139.6503     # Tokyo
```

Overrides `navigator.geolocation`. Useful for testing location-aware features.

## Network throttling

```bash
ap-browser dev emulate network offline      # fully offline
ap-browser dev emulate network slow3g       # ~400kbps, 400ms RTT
ap-browser dev emulate network fast3g       # ~1.5Mbps, 150ms RTT
ap-browser dev emulate network slow4g       # ~4Mbps, 100ms RTT
ap-browser dev emulate network fast4g       # ~10Mbps, 40ms RTT
```

Use to test slow-network UX, offline fallbacks, loading states.

## CPU throttling

```bash
ap-browser dev emulate cpu 4     # 4x slowdown (simulates low-end device)
ap-browser dev emulate cpu 6     # 6x slowdown
```

Use to test performance on low-end devices.

## User-Agent override

```bash
ap-browser dev emulate ua "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"
```

Overrides `navigator.userAgent` and outbound HTTP `User-Agent` header.

## Extra HTTP headers

```bash
ap-browser dev emulate headers '{"Authorization": "Bearer token123", "X-Test-Mode": "true"}'
```

Adds headers to all subsequent requests. Useful for testing auth flows or feature flags.

## Reset all overrides

```bash
ap-browser dev emulate reset
```

Clears color scheme, viewport, geolocation, network, CPU, UA, and headers overrides.

## Composition

Overrides compose — set multiple at once:

```bash
ap-browser dev emulate dark
ap-browser dev emulate viewport 375x667 --mobile
ap-browser dev emulate network slow3g
# Now page renders dark + small viewport + slow network
```

All overrides persist until `dev emulate reset` or the debugger detaches.

## Workflow: test mobile dark mode

```bash
ap-browser dev emulate dark
ap-browser dev emulate viewport 375x667 --mobile --device-pixel-ratio 3
ap-browser goto "https://your-app.com"
ap-browser dev snapshot                  # verify layout
ap-browser screenshot --out mobile-dark.png
ap-browser dev emulate reset             # cleanup
```
