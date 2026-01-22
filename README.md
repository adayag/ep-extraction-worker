# EP Extraction Worker

A remote m3u8 extraction service using Patchright (stealth Playwright). Designed to run separately from EP Live Events to offload browser work to a dedicated server.

## Features

- Stealth browser extraction using Patchright
- Concurrency-limited Chrome pool (configurable)
- MediaFlow proxy URL wrapping
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
  "url": "https://embedsite.com/embed/admin/123",
  "timeout": 15000
}
```

**Response (success):**
```json
{
  "success": true,
  "data": {
    "url": "https://mediaflow.proxy/hls/manifest.m3u8?d=...",
    "headers": {
      "Referer": "https://embedsite.com/",
      "Origin": "https://embedsite.com"
    }
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
| `MEDIAFLOW_PROXY_URL` | (optional) | MediaFlow proxy base URL |
| `CHROME_PATH` | (auto) | Path to Chrome binary |
| `MAX_CONCURRENT` | `2` | Max simultaneous Chrome contexts |

### Example .env

```bash
NODE_ENV=production
PORT=3001
EXTRACTION_SECRET=your-32-character-secret-here
MEDIAFLOW_PROXY_URL=https://mediaflow.example.com?api_password=xxx
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
│                         │   p-limit queue      │
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
