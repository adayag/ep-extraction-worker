# EP Extraction Worker

A remote m3u8 extraction service using Patchright (stealth Playwright). Designed to run separately from EP Live Events to offload browser work to a dedicated server.

## Features

- Stealth browser extraction using Patchright
- Concurrency-limited Chrome pool (configurable)
- Shared secret authentication
- Health endpoint for monitoring

## Quick Start

```bash
# Install dependencies
npm install

# Install Chrome for Patchright
npx patchright install chrome

# Copy environment config
cp .env.example .env

# Start development server
npm run dev
```

## API Endpoints

### Health Check

```
GET /health
```

Returns `200 OK` with status information.

### Extract m3u8

```
POST /extract
Content-Type: application/json
Authorization: Bearer <EXTRACTION_SECRET>

{
  "embedUrl": "https://embedsite.com/embed/admin/123",
  "timeout": 15000,
  "priority": "high"
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `embedUrl` | Yes | - | The embed page URL to extract from |
| `timeout` | No | 30000 | Extraction timeout in ms |
| `priority` | No | `"normal"` | `"high"` jumps queue, `"normal"` is FIFO |

**Response (success):**
```json
{
  "success": true,
  "url": "https://cdn.example.com/stream.m3u8",
  "m3u8Url": "https://cdn.example.com/stream.m3u8",
  "headers": {
    "Referer": "https://embedsite.com/",
    "Origin": "https://embedsite.com"
  }
}
```

**Response (not found):**
```json
{
  "success": false,
  "error": "No m3u8 found"
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `NODE_ENV` | `production` | Environment |
| `EXTRACTION_SECRET` | (required) | Shared secret for auth |
| `CHROME_PATH` | (auto) | Path to Chrome binary |
| `MAX_CONCURRENT` | `2` | Max simultaneous Chrome contexts |
| `BROWSER_IDLE_TIMEOUT` | `60000` | Restart browser after idle (ms) |
| `BROWSER_MAX_AGE` | `7200000` | Max browser lifetime (ms, 2 hours) |

### Example .env

```bash
NODE_ENV=production
PORT=3001
EXTRACTION_SECRET=your-32-character-secret-here
CHROME_PATH=/usr/bin/chromium
MAX_CONCURRENT=2
```

## Architecture

```
┌────────────────────────────────────────────────┐
│             EP Extraction Worker               │
├────────────────────────────────────────────────┤
│                                                │
│  POST /extract ─► Auth Check ─► Browser Pool   │
│                                    │           │
│                         ┌──────────┴───────────┐
│                         │   p-queue (priority) │
│                         │   (MAX_CONCURRENT)   │
│                         └──────────┬───────────┘
│                                    │           │
│                              Chrome Context    │
│                                    │           │
│                         Navigate ─► Click ─►   │
│                         Intercept m3u8 request │
│                                    │           │
│                         Return URL + headers   │
│                                                │
└────────────────────────────────────────────────┘
```

### Concurrency Control

The `MAX_CONCURRENT` env var controls how many Chrome browser contexts can run simultaneously:

- Default: `2` (suitable for 1-2GB RAM VPS)
- Each context uses ~150-300MB RAM
- Requests beyond the limit are queued automatically
- Lower this on memory-constrained systems

## Deployment

### Docker

```dockerfile
FROM node:20-slim

# Install Chrome
RUN apt-get update && apt-get install -y \
    wget gnupg \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production
RUN npx patchright install chrome

COPY dist ./dist

ENV NODE_ENV=production
ENV CHROME_PATH=/usr/bin/google-chrome-stable
EXPOSE 3001

CMD ["node", "dist/index.js"]
```

### Resource Requirements

| Setting | RAM | CPU | Notes |
|---------|-----|-----|-------|
| `MAX_CONCURRENT=1` | 512MB | 1 core | Minimum, slow |
| `MAX_CONCURRENT=2` | 1GB | 1-2 cores | Recommended |
| `MAX_CONCURRENT=4` | 2GB | 2+ cores | High throughput |

## Memory Management

The worker implements several strategies to prevent memory leaks and OOM crashes:

### Browser Restart

Chrome accumulates memory over time. The worker automatically restarts the browser:

1. **Idle restart** - After 60 seconds of inactivity (configurable via `BROWSER_IDLE_TIMEOUT`)
2. **Max-age restart** - After 2 hours regardless of activity (configurable via `BROWSER_MAX_AGE`)

Both restarts only occur when no extractions are in progress. Watch for log messages:
```
[BrowserPool] Idle restart (age: 123s)
[BrowserPool] Max age exceeded (7201s), restarting browser
```

### Node.js Heap Limit

The Docker image runs with `--max-old-space-size=512` to cap Node.js heap at 512MB. This prevents unbounded growth and forces crashes earlier (recoverable via container restart) rather than consuming all available memory.

### Health Endpoint Memory Stats

The `/health` endpoint includes memory usage for monitoring:

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "memory": {
    "heapUsedMB": 85,
    "heapTotalMB": 120,
    "rssMB": 450
  }
}
```

Monitor `heapUsedMB` over time. Expected stable usage: 80-150MB. If heap consistently grows above 300MB, the idle restart may not be firing correctly.

### Troubleshooting Memory Issues

1. **Heap keeps growing**: Check logs for `[BrowserPool] Idle restart` messages. If missing after periods of inactivity, the timer may not be scheduling correctly.

2. **OOM crashes**: Lower `MAX_CONCURRENT` to reduce peak memory usage. Each context uses 150-300MB.

3. **Browser not restarting**: Ensure no stuck extractions. Check `BROWSER_IDLE_TIMEOUT` value. Default 60 seconds should trigger after a minute of no requests.

## Testing

```bash
# Run unit tests
npm test

# Run tests once
npm run test:run

# Type check
npx tsc --noEmit

# Browser test with real embeds
npm run test:browser:verbose "https://embedsports.top/embed/..."
```

See [docs/benchmark.md](docs/benchmark.md) for performance benchmarks and test methodology.

## Integration with EP Live Events

Set these environment variables in EP Live Events:

```bash
EXTRACTION_WORKER_URL=https://extraction.yourdomain.com
EXTRACTION_SECRET=same-secret-as-worker
PARALLEL_EXTRACTIONS=3
```

The cache worker will automatically use the remote extraction service instead of local Patchright.

## License

MIT
