# EP Extraction Worker

A remote m3u8 extraction service using Patchright (stealth Playwright). Designed to run separately from EP Live Events to offload browser work to a dedicated server.

## Quick Start

```bash
npm install
npx patchright install chrome
cp .env.example .env
npm run dev
```

## Configuration

### Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3001` | No | HTTP server port |
| `METRICS_PORT` | `9090` | No | Prometheus metrics port (internal only) |
| `EXTRACTION_SECRET` | — | **Yes** | Shared secret for Bearer token auth |
| `CHROME_PATH` | auto | No | Chrome binary path. When unset, Patchright uses `channel: 'chrome'` to auto-detect the installed Chrome. In Docker, explicitly set to `/usr/bin/google-chrome-stable`. |
| `MAX_CONCURRENT` | `2` | No | Max simultaneous browser contexts (each uses ~150–300 MB) |
| `BROWSER_IDLE_TIMEOUT` | `60000` | No | Close browser after this many ms idle (60 s) |
| `BROWSER_MAX_AGE` | `7200000` | No | Force browser restart after this many ms (2 h) |
| `SHUTDOWN_TIMEOUT` | `30000` | No | Max ms to wait for in-flight requests during graceful shutdown (30 s) |
| `CIRCUIT_BREAKER_EXIT_THRESHOLD` | `120000` | No | If circuit breaker stays open longer than this (120 s), the watchdog calls `process.exit(1)` for container restart |

### Internal Constants

| Constant | Value | Location |
|----------|-------|----------|
| `WATCHDOG_INTERVAL` | 10 000 ms | `src/index.ts:13` |
| `CIRCUIT_BREAKER_THRESHOLD` | 3 consecutive failures | `src/browserPool.ts:22` |
| `CIRCUIT_BREAKER_RESET_MS` | 30 000 ms | `src/browserPool.ts:23` |
| `PRIORITY_LEVELS.normal` | 0 | `src/routes/extract.ts:17` |
| `PRIORITY_LEVELS.high` | 10 | `src/routes/extract.ts:18` |
| `page.goto` timeout | 15 000 ms | `src/extractor.ts:228` |
| Post-navigate wait | 500 ms | `src/extractor.ts:231` |
| Click timeout | 500 ms | `src/extractor.ts:65` |
| Chrome JS heap limit | 128 MB | `src/browserPool.ts:133` |
| Node.js heap limit (Docker) | 512 MB | `Dockerfile:85` |
| Browser viewport | 800 × 600 | `src/browserPool.ts:177–178` |

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run production server |
| `npm test` | Run tests in watch mode (Vitest) |
| `npm run test:run` | Run tests once |
| `npm run test:browser <url>` | Test real extraction against an embed URL |
| `npm run test:browser:verbose <url>` | Same, with detailed output |
| `npm run test:browser:interactive <url>` | Same, keeps browser open for inspection |

## API

### `POST /extract`

Extract an m3u8 URL from an embed page.

**Request:**
```
POST /extract
Content-Type: application/json
Authorization: Bearer <EXTRACTION_SECRET>

{
  "embedUrl": "https://embedsite.com/embed/admin/123",
  "timeout": 30000,
  "priority": "high"
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `embedUrl` | Yes | — | Embed page URL. Must be `http`/`https`. Blocked for localhost, private IPs (127.x, 10.x, 172.16–31.x, 192.168.x, 169.254.x, 0.x), and IPv6 loopback. |
| `timeout` | No | `30000` | Extraction timeout in ms |
| `priority` | No | `"normal"` | `"high"` (priority 10) jumps queue; `"normal"` (priority 0) is FIFO |

**Response (success):**
```json
{
  "success": true,
  "url": "https://cdn.example.com/stream.m3u8",
  "m3u8Url": "https://cdn.example.com/stream.m3u8",
  "headers": {
    "Referer": "https://embedsite.com/",
    "Origin": "https://embedsite.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ..."
  },
  "cookies": "session=abc123; token=xyz"
}
```

`cookies` is included only when the browser context captured cookies. `headers` always includes `Referer`, `Origin`, and `User-Agent`.

**Response (not found):**
```json
{
  "success": false,
  "error": "m3u8 extraction failed"
}
```

**Status codes:**

| Code | Condition |
|------|-----------|
| `200` | Success, or extraction failed (m3u8 not found within timeout) |
| `400` | Missing `embedUrl`, or SSRF-blocked URL |
| `401` | Missing or invalid `Authorization` header |
| `500` | `EXTRACTION_SECRET` not configured on server |
| `503` | Circuit breaker open, or browser crash/error |

### `GET /health`

Returns server health, queue state, and circuit breaker status.

**Response (healthy — `200`):**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "memory": {
    "heapUsedMB": 85,
    "heapTotalMB": 120,
    "rssMB": 450
  },
  "queue": {
    "pending": 0,
    "active": 0
  },
  "browser": {
    "circuitBreaker": {
      "isCircuitOpen": false,
      "consecutiveFailures": 0,
      "circuitOpenUntil": 0
    }
  }
}
```

**Response (unhealthy — `503`):** Same shape with `"status": "unhealthy"`. Returned when the circuit breaker is open.

### `GET /metrics` (port 9090)

Prometheus metrics on a separate port for internal scraping.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `extraction_worker_circuit_breaker_open` | Gauge | — | Circuit breaker state (1=open, 0=closed) |
| `extraction_worker_circuit_breaker_trips_total` | Counter | — | Times circuit breaker has opened |
| `extraction_worker_browser_launches_total` | Counter | — | Total browser launches |
| `extraction_worker_browser_launch_failures_total` | Counter | — | Total browser launch failures |
| `extraction_worker_browser_restarts_total` | Counter | `reason` | Restarts by reason (`idle`, `max_age`) |
| `extraction_worker_browser_disconnects_total` | Counter | — | Unexpected browser disconnections |
| `extraction_worker_extractions_total` | Counter | `status`, `error_type` | Extractions by outcome |
| `extraction_worker_extraction_duration_seconds` | Histogram | `status` | End-to-end extraction duration |
| `extraction_worker_queue_depth` | Gauge | — | Extractions waiting in queue |
| `extraction_worker_active_extractions` | Gauge | — | Extractions currently running |
| `extraction_worker_queue_wait_seconds` | Histogram | — | Time spent waiting in queue |
| `extraction_worker_context_creation_seconds` | Histogram | — | Time to create browser context |
| `extraction_worker_m3u8_detection_seconds` | Histogram | — | Time from navigation to m3u8 intercept |

**Error types** (`error_type` label values): `none`, `timeout`, `circuit_open`, `browser_error`

Default Node.js metrics (`nodejs_*`, `process_*`) are also included.

**Example queries:**
```promql
# Error rate by type
sum by (error_type) (rate(extraction_worker_extractions_total{status="failure"}[5m]))

# P95 queue wait time
histogram_quantile(0.95, sum(rate(extraction_worker_queue_wait_seconds_bucket[5m])) by (le))

# P95 extraction duration
histogram_quantile(0.95, sum(rate(extraction_worker_extraction_duration_seconds_bucket[5m])) by (le))

# Circuit breaker trip rate
rate(extraction_worker_circuit_breaker_trips_total[5m])

# Browser stability (disconnects per hour)
rate(extraction_worker_browser_disconnects_total[1h]) * 3600
```

**Scrape config:**
```yaml
- job_name: 'extraction-worker'
  static_configs:
    - targets: ['ep-extraction-worker:9090']
```

## Architecture

### Request Flow

```
POST /extract
  → Auth middleware (Bearer token)
  → SSRF URL validation
  → p-queue (priority, concurrency: MAX_CONCURRENT)
  → Browser context (created per extraction)
    → Route handler: block resources, intercept m3u8
    → Navigate to embedUrl (15s timeout)
    → Wait 500ms, click play buttons (main frame + iframes)
    → Wait for m3u8 or timeout
  → Cleanup: unroute → close pages → close context
  → Return URL + headers + cookies
```

### Browser Pool

Single Chrome instance managed as a **lazy singleton** — not launched at startup, but on the first extraction request. The browser is reused across extractions; only contexts are created and destroyed per request.

- **Lazy launch:** First `getBrowser()` call launches Chrome via Patchright
- **Concurrent launch protection:** A `launching` promise prevents multiple simultaneous launches
- **Disconnect recovery:** On unexpected disconnect, the reference is nulled and the next request relaunches
- **Idle restart:** When all extractions finish, a timer schedules browser close after `BROWSER_IDLE_TIMEOUT`. Resets on new activity.
- **Max-age restart:** On each `getBrowser()` call, if the browser exceeds `BROWSER_MAX_AGE` and no extractions are active, it restarts immediately
- **Restart mechanism:** Nulls the reference first (race protection), then closes the old browser. Does not eagerly relaunch — next `getBrowser()` call will.

### Concurrency & Queue

Extractions are queued through `p-queue` with `concurrency: MAX_CONCURRENT` (default 2). Requests specify `"high"` (priority 10, jumps queue) or `"normal"` (priority 0, FIFO). Invalid priority values fall back to `normal`.

### Circuit Breaker

Protects against repeated Chrome launch failures:

1. Each failed `launchBrowser()` increments `consecutiveFailures`
2. At **3 consecutive failures** (`CIRCUIT_BREAKER_THRESHOLD`), the circuit opens for **30 s** (`CIRCUIT_BREAKER_RESET_MS`)
3. While open, all `getBrowser()` calls throw immediately (`"Circuit breaker open, retry in Xs"`)
4. After 30 s, the next request attempts a launch. On success, failures reset to 0 and the circuit closes.

**Watchdog:** A timer checks every 10 s (`WATCHDOG_INTERVAL`). If the circuit breaker has been continuously open longer than `CIRCUIT_BREAKER_EXIT_THRESHOLD` (default 120 s), the process exits with code 1 for container restart.

### Extraction Pipeline

1. **Context creation:** New browser context with stealth User-Agent, `bypassCSP`, `ignoreHTTPSErrors`, 800×600 viewport, `reducedMotion: 'reduce'`
2. **Resource blocking:** Images, fonts, stylesheets blocked by resource type. Analytics/tracking scripts (Google Analytics, Facebook, Hotjar, Sentry, Mixpanel, etc.), ads, telemetry XHR/fetch, and video previews (`.mp4`, `.webm`) blocked by URL pattern. Player-related scripts are allowed through.
3. **m3u8 interception:** A route handler on `**/*` checks every request for `.m3u8` in the URL (excluding `.ts.m3u8` segment URLs). On first match, the request is **aborted** (not fulfilled) to preserve single-use stream tokens. Cookies are captured before abort.
4. **Play button clicks:** Tries 8 selectors (JW Player, Video.js, Plyr, generic) on the main frame, then all iframes in parallel
5. **Popup handling:** Popups are allowed (not closed) because closing them breaks some embeds

### Graceful Shutdown

On `SIGTERM` or `SIGINT`:

1. Stop the watchdog timer
2. Stop accepting new connections (`server.close()` + `metricsServer.close()`)
3. Wait for in-flight requests to drain, racing against `SHUTDOWN_TIMEOUT` (default 30 s)
4. Close the browser pool
5. `process.exit(0)`

Duplicate signals are ignored via a `shutdownInProgress` guard.

## Memory Management

### Browser Restart

Chrome accumulates memory over time. Two auto-restart strategies (both wait for active extractions to finish):

- **Idle restart** — after `BROWSER_IDLE_TIMEOUT` (default 60 s) of inactivity
- **Max-age restart** — after `BROWSER_MAX_AGE` (default 2 h) regardless of activity

### Heap Limits

- **Node.js:** `--max-old-space-size=512` (512 MB, set in Dockerfile CMD)
- **Chrome:** `--js-flags=--max-old-space-size=128` (128 MB, set in launch args)
- Chrome renderer processes limited to 1, site isolation disabled, WebGL/3D APIs disabled

### Troubleshooting

- **Heap keeps growing:** Check logs for `[BrowserPool] Idle restart` messages. If missing after idle periods, the timer may not be scheduling correctly.
- **OOM crashes:** Lower `MAX_CONCURRENT`. Each context uses ~150–300 MB.
- **Browser not restarting:** Ensure no stuck extractions. Check `BROWSER_IDLE_TIMEOUT` value.
- **Monitor:** `heapUsedMB` in `/health` response. Expected stable range: 80–150 MB.

## Deployment

### Docker

Multi-stage build: `node:20-alpine` (builder) → `node:20-slim` (production with Google Chrome).

- **Non-root user:** Runs as `nodejs` (UID 1001)
- **HEALTHCHECK:** `GET /health` every 30 s, 10 s timeout, 5 s start period, 3 retries
- **Platform:** `linux/amd64` only (Chrome stealth requires x86)
- **Ports:** 3001 (HTTP), 9090 (metrics, not exposed in Dockerfile)

### Resource Requirements

| `MAX_CONCURRENT` | RAM | CPU | Notes |
|-------------------|-----|-----|-------|
| 1 | 512 MB | 1 core | Minimum, slow |
| 2 | 1 GB | 1–2 cores | Recommended |
| 4 | 2 GB | 2+ cores | High throughput |

### GitHub Actions

Builds trigger on:
- **Push to `main`:** Tags image as `main`, `latest`, and commit SHA
- **Tag push (`v*`):** Tags image as semver (`1.2.3`, `1.2`) plus `latest` and SHA
- **Manual dispatch**

Image published to `ghcr.io/<owner>/ep-extraction-worker`. Platform: `linux/amd64`. Uses GitHub Actions cache (`type=gha`).

## Testing

```bash
npm test                                    # Watch mode
npm run test:run                            # Run once
npx tsc --noEmit                            # Type-check
npm run test:browser "https://embed-url"    # Real extraction test
npm run test:browser:verbose "url"          # Detailed output
npm run test:browser:interactive "url"      # Keep browser open
```

See [docs/benchmark.md](docs/benchmark.md) for performance benchmarks.

## Integration with EP Live Events

Set these in EP Live Events:

```bash
EXTRACTION_WORKER_URL=https://extraction.yourdomain.com
EXTRACTION_SECRET=same-secret-as-worker
PARALLEL_EXTRACTIONS=3
```

The cache worker will use the remote extraction service instead of local Patchright.
