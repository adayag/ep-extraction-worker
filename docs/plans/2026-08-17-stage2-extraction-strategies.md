# Stage 2 — Extraction Strategy Library (ep-extraction-worker)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the worker three extraction strategies behind the existing `POST /extract`: `browser` (unchanged Chrome path), `signed-url` (fetch embed → XOR-decode inline blob → signed `.m3u8`), and `http-token` (fetch embed → regex token). The cheap HTTP strategies run on a SEPARATE light queue so they never wait behind the 2-slot Chrome queue. Fully backward-compatible: `strategy` defaults to `browser`, so current callers are unaffected. No provider uses the new strategies yet (that's Stage 3/4).

**Architecture:** A new `src/strategies/` module. `dispatchExtraction(embedUrl, opts)` routes by `opts.strategy`: `browser` → existing `extractM3u8` (untouched, Chrome queue); else → `lightQueue.add(...)` running a pure HTTP+regex strategy. Strategies return the existing `ExtractedStream { url, headers?, cookies? }`, so the route response and the ep-live-events token-pool path are unchanged. SSRF validation is shared via a new `src/ssrf.ts` and re-applied on every redirect hop by `safeFetch`.

**Tech Stack:** TypeScript ESM/NodeNext, Express, `p-queue` (already a dep), global `fetch` (Node 20), vitest, prom-client.

**Design of record:** `_reference/ep-proxy/docs/plans/2026-08-16-source-federation-design.md` §7. The signed-url decode was verified live against timstreams on 2026-08-16 (`((byte ^ k1) - k2 + 256) % 256`, keys parsed from the page).

**Invariant:** `npm run test:run` green after each task (baseline is 53 tests); `npx tsc --noEmit` clean. The `browser` path and its tests are not modified.

---

## Task 1: Extract the SSRF guard to `src/ssrf.ts`

**Why:** `safeFetch` (Task 3) needs `validateEmbedUrl`, but importing it from `routes/extract.ts` would create a cycle (route → strategies → route). Move it to a leaf module.

**Files:** Create `src/ssrf.ts`; modify `src/routes/extract.ts`; create `src/ssrf.test.ts`.

**Step 1: failing test** `src/ssrf.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateEmbedUrl } from './ssrf.js';

describe('validateEmbedUrl', () => {
  it.each([
    ['https://embed.example.com/x', null],
    ['ftp://x', 'scheme'],
    ['http://localhost/x', 'localhost'],
    ['http://127.0.0.1/x', 'internal'],
    ['http://10.1.2.3/x', 'internal'],
    ['http://169.254.1.1/x', 'internal'],
    ['not a url', 'Invalid'],
  ])('validates %s', (url, expectContains) => {
    const r = validateEmbedUrl(url);
    if (expectContains === null) expect(r).toBeNull();
    else expect(r).toContain(expectContains);
  });
});
```

**Step 2:** `npx vitest run src/ssrf.test.ts` → FAIL (no module).

**Step 3:** Create `src/ssrf.ts` by MOVING the `validateEmbedUrl` function verbatim from `routes/extract.ts` (lines 34-78) and `export`ing it. Then in `routes/extract.ts`: delete the local copy and `import { validateEmbedUrl } from '../ssrf.js';`.

**Step 4:** `npx vitest run src/ssrf.test.ts` → PASS. Also `npx vitest run src/routes/extract.test.ts` (its SSRF matrix must still pass through the route).

**Step 5:** `npm run test:run` → green.
```bash
git add src/ssrf.ts src/ssrf.test.ts src/routes/extract.ts
git commit -m "refactor: extract SSRF guard to a shared leaf module"
```

---

## Task 2: Metrics — strategy label + new error types

**Files:** Modify `src/metrics.ts`; append `src/metrics.test.ts` (create if absent).

**Step 1: failing test** (append/create `src/metrics.test.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { ERROR_TYPES, extractionsTotal } from './metrics.js';

describe('metrics for strategies', () => {
  it('has pattern_miss and http_error error types', () => {
    expect(ERROR_TYPES.pattern_miss).toBe('pattern_miss');
    expect(ERROR_TYPES.http_error).toBe('http_error');
  });
  it('extractionsTotal accepts a strategy label', async () => {
    extractionsTotal.inc({ status: 'success', error_type: 'none', strategy: 'signed-url' });
    const txt = await (await import('./metrics.js')).register.metrics();
    expect(txt).toContain('strategy="signed-url"');
  });
});
```
(If `register` isn't exported, use the existing export path; the map shows `register` is module-local — export it, or assert via `extractionsTotal.get()`.)

**Step 2:** run → FAIL.

**Step 3:** In `src/metrics.ts`: add to `ERROR_TYPES`: `pattern_miss: 'pattern_miss'`, `http_error: 'http_error'`. Add `'strategy'` to `extractionsTotal` `labelNames`: `['status', 'error_type', 'strategy'] as const`. Export `register` if not already.

**Step 4:** run → PASS.

**Step 5:** `npm run test:run` — NOTE: adding a required label may make the existing 3 `.inc` sites in `routes/extract.ts` emit without `strategy`. prom-client tolerates missing labels (renders empty), so the baseline should stay green, but if any test asserts exact metric text, update it. Then:
```bash
git add src/metrics.ts src/metrics.test.ts
git commit -m "feat(metrics): add strategy label + pattern_miss/http_error error types"
```

---

## Task 3: The strategy library

**Files:** Create `src/strategies/safeFetch.ts`, `signedUrl.ts`, `httpToken.ts`, `lightQueue.ts`, `index.ts`; tests `src/strategies/{signedUrl,httpToken,dispatch}.test.ts`.

**Step 1: failing tests**

`src/strategies/signedUrl.test.ts` (the fixture is generated by INVERTING the decode, so the test is self-contained):
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeObfuscatedBlob, extractSignedUrl } from './signedUrl.js';

const K1 = 233, K2 = 18;
function encode(plaintext: string): number[] {
  // inverse of ((b ^ K1) - K2 + 256) % 256 === c  =>  b = ((c + K2) % 256) ^ K1
  return [...plaintext].map(ch => (((ch.charCodeAt(0) + K2) % 256) ^ K1));
}
function fakeEmbed(jsPayload: string): string {
  const arr = encode(jsPayload);
  return `<html><script>(function(){var _a=[${arr.join(',')}],_k1=${K1},_k2=${K2},s="",i;` +
    `for(i=0;i<_a.length;i++){s+=String.fromCharCode(((_a[i]^_k1)-_k2+256)%256);}window["ev"+"al"](s);})();</script></html>`;
}

describe('decodeObfuscatedBlob', () => {
  it('recovers the plaintext JS using in-page keys', () => {
    const js = 'var SIGNED_URL="https://cdn.example.com/secure/abc/123/x.m3u8";';
    expect(decodeObfuscatedBlob(fakeEmbed(js))).toContain('https://cdn.example.com/secure/abc/123/x.m3u8');
  });
  it('returns null when no blob is present', () => {
    expect(decodeObfuscatedBlob('<html>nothing</html>')).toBeNull();
  });
});

describe('extractSignedUrl', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  it('fetches the embed, decodes, and returns the m3u8 with headers', async () => {
    const js = 'var SIGNED_URL="https://volder.example.cfd/main/secure/sig/1786940364/id.m3u8";';
    (fetch as unknown as vi.Mock).mockResolvedValue(new Response(fakeEmbed(js), { status: 200 }));
    const r = await extractSignedUrl('https://embed.example.top/embed/x', 5000);
    expect(r?.url).toBe('https://volder.example.cfd/main/secure/sig/1786940364/id.m3u8');
    expect(r?.headers?.Referer).toBe('https://embed.example.top/');
    expect(r?.headers?.Origin).toBe('https://embed.example.top');
  });
  it('returns null when the decoded blob has no m3u8', async () => {
    (fetch as unknown as vi.Mock).mockResolvedValue(new Response(fakeEmbed('var x=1;'), { status: 200 }));
    expect(await extractSignedUrl('https://embed.example.top/embed/x', 5000)).toBeNull();
  });
});
```

`src/strategies/httpToken.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractHttpToken } from './httpToken.js';

describe('extractHttpToken', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());
  it('extracts a default .m3u8 from the page HTML', async () => {
    (fetch as unknown as vi.Mock).mockResolvedValue(new Response(
      '<html><script>file:"https://cdn.free.top/hls/token123/stream.m3u8"</script></html>', { status: 200 }));
    const r = await extractHttpToken('https://embed.free.top/embed/x', 5000);
    expect(r?.url).toBe('https://cdn.free.top/hls/token123/stream.m3u8');
    expect(r?.headers?.Origin).toBe('https://embed.free.top');
  });
  it('honors a provided capture pattern', async () => {
    (fetch as unknown as vi.Mock).mockResolvedValue(new Response('data-src="https://x.top/a/b.m3u8"', { status: 200 }));
    const r = await extractHttpToken('https://embed.free.top/e', 5000, 'data-src="([^"]+\\.m3u8[^"]*)"');
    expect(r?.url).toBe('https://x.top/a/b.m3u8');
  });
  it('returns null when nothing matches', async () => {
    (fetch as unknown as vi.Mock).mockResolvedValue(new Response('<html>no stream</html>', { status: 200 }));
    expect(await extractHttpToken('https://embed.free.top/e', 5000)).toBeNull();
  });
});
```

`src/strategies/dispatch.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../extractor.js', () => ({ extractM3u8: vi.fn().mockResolvedValue({ url: 'browser-url' }) }));
vi.mock('./signedUrl.js', () => ({ extractSignedUrl: vi.fn().mockResolvedValue({ url: 'signed-url' }) }));
vi.mock('./httpToken.js', () => ({ extractHttpToken: vi.fn().mockResolvedValue({ url: 'token-url' }) }));
import { extractM3u8 } from '../extractor.js';
import { extractSignedUrl } from './signedUrl.js';
import { dispatchExtraction } from './index.js';

beforeEach(() => vi.clearAllMocks());

describe('dispatchExtraction', () => {
  it('routes browser to extractM3u8 (Chrome queue)', async () => {
    const r = await dispatchExtraction('u', { timeout: 1, priority: 10, strategy: 'browser', queueEnqueueTime: 0 });
    expect(r).toEqual({ url: 'browser-url' });
    expect(extractM3u8).toHaveBeenCalledOnce();
    expect(extractSignedUrl).not.toHaveBeenCalled();
  });
  it('routes signed-url off the browser queue', async () => {
    const r = await dispatchExtraction('u', { timeout: 1, priority: 0, strategy: 'signed-url' });
    expect(r).toEqual({ url: 'signed-url' });
    expect(extractSignedUrl).toHaveBeenCalledOnce();
    expect(extractM3u8).not.toHaveBeenCalled();
  });
});
```

**Step 2:** run the three files → FAIL (no modules).

**Step 3: implement**

`src/strategies/safeFetch.ts`:
```ts
import { validateEmbedUrl } from '../ssrf.js';

const MAX_REDIRECTS = 5;

// SSRF-safe fetch: re-validates every hop (embed pages can redirect), manual
// redirect handling, hard timeout. Returns null if blocked or too many hops.
export async function safeFetch(
  url: string,
  opts: { timeout: number; headers?: Record<string, string> }
): Promise<Response | null> {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (validateEmbedUrl(current)) return null; // blocked host/hop
    const res = await fetch(current, {
      method: 'GET',
      headers: opts.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeout),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  return null;
}
```

`src/strategies/signedUrl.ts`:
```ts
import consola from 'consola';
import type { ExtractedStream } from '../extractor.js';
import { safeFetch } from './safeFetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// The embed page ships an XOR-obfuscated JS blob AND the decode keys inline.
// Recover the JS: for each byte b, char = ((b ^ k1) - k2 + 256) % 256, where
// k1/k2 and the byte array are resolved from their variable declarations.
export function decodeObfuscatedBlob(html: string): string | null {
  const formula = html.match(/(\w+)\s*\[\s*\w+\s*\]\s*\^\s*(\w+)\s*\)\s*-\s*(\w+)\s*\+\s*256/);
  if (!formula) return null;
  const [, arrName, k1Name, k2Name] = formula;
  const arrM = html.match(new RegExp(arrName + '\\s*=\\s*\\[([0-9,\\s]+)\\]'));
  const k1M = html.match(new RegExp(k1Name + '\\s*=\\s*(\\d+)'));
  const k2M = html.match(new RegExp(k2Name + '\\s*=\\s*(\\d+)'));
  if (!arrM || !k1M || !k2M) return null;
  const arr = arrM[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
  const k1 = parseInt(k1M[1], 10);
  const k2 = parseInt(k2M[1], 10);
  let out = '';
  for (const b of arr) out += String.fromCharCode(((b ^ k1) - k2 + 256) % 256);
  return out;
}

export async function extractSignedUrl(embedUrl: string, timeout: number): Promise<ExtractedStream | null> {
  const res = await safeFetch(embedUrl, { timeout, headers: { 'User-Agent': UA } });
  if (!res || res.status !== 200) return null;
  const html = await res.text();
  const decoded = decodeObfuscatedBlob(html) ?? html; // some pages may be plain
  const m = decoded.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
  if (!m) { consola.debug('[signed-url] no m3u8 in decoded blob'); return null; }
  const origin = new URL(embedUrl).origin;
  return { url: m[0], headers: { Referer: `${origin}/`, Origin: origin, 'User-Agent': UA } };
}
```

`src/strategies/httpToken.ts`:
```ts
import consola from 'consola';
import type { ExtractedStream } from '../extractor.js';
import { safeFetch } from './safeFetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_PATTERN = /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/;

export async function extractHttpToken(embedUrl: string, timeout: number, pattern?: string): Promise<ExtractedStream | null> {
  const res = await safeFetch(embedUrl, { timeout, headers: { 'User-Agent': UA } });
  if (!res || res.status !== 200) return null;
  const html = await res.text();
  const re = pattern ? new RegExp(pattern) : DEFAULT_PATTERN;
  const m = html.match(re);
  if (!m) { consola.debug('[http-token] no token match'); return null; }
  const url = m[1] ?? m[0]; // capture group 1 if the pattern has one
  const origin = new URL(embedUrl).origin;
  return { url, headers: { Referer: `${origin}/`, Origin: origin, 'User-Agent': UA } };
}
```

`src/strategies/lightQueue.ts`:
```ts
import PQueue from 'p-queue';

// Cheap HTTP strategies run here, NOT on the 2-slot browser queue, so a slow
// Chrome extraction can never starve a fast signed-url/http-token fetch.
const LIGHT_MAX = parseInt(process.env.LIGHT_MAX_CONCURRENT || '8', 10);
export const lightQueue = new PQueue({ concurrency: LIGHT_MAX });
```

`src/strategies/index.ts`:
```ts
import { extractM3u8, type ExtractedStream } from '../extractor.js';
import { extractSignedUrl } from './signedUrl.js';
import { extractHttpToken } from './httpToken.js';
import { lightQueue } from './lightQueue.js';

export type Strategy = 'browser' | 'signed-url' | 'http-token';

export interface DispatchOpts {
  timeout: number;
  priority: number;
  strategy: Strategy;
  pattern?: string;
  queueEnqueueTime?: number;
}

export async function dispatchExtraction(embedUrl: string, opts: DispatchOpts): Promise<ExtractedStream | null> {
  if (opts.strategy === 'browser') {
    return extractM3u8(embedUrl, opts.timeout, opts.priority, opts.queueEnqueueTime);
  }
  const run = opts.strategy === 'signed-url'
    ? () => extractSignedUrl(embedUrl, opts.timeout)
    : () => extractHttpToken(embedUrl, opts.timeout, opts.pattern);
  return (await lightQueue.add(run)) ?? null;
}
```

**Step 4:** run the three test files → PASS.

**Step 5:** `npm run test:run` → green.
```bash
git add src/strategies src/strategies/*.test.ts
git commit -m "feat(strategies): add signed-url + http-token strategies on a light queue"
```

---

## Task 4: Wire the route to `dispatchExtraction`

**Files:** Modify `src/routes/extract.ts`; append `src/routes/extract.test.ts`.

**Step 1: failing tests** (append to `src/routes/extract.test.ts`, following its existing supertest setup — mock `../strategies/index.js` `dispatchExtraction`):
```ts
// (add near the other mocks) vi.mock('../strategies/index.js', () => ({ dispatchExtraction: vi.fn() }));
// import { dispatchExtraction } from '../strategies/index.js';

it('defaults strategy to browser and passes it through', async () => {
  (dispatchExtraction as any).mockResolvedValue({ url: 'https://x/y.m3u8' });
  const res = await request(app).post('/extract').set('Authorization', `Bearer ${SECRET}`)
    .send({ embedUrl: 'https://embed.example.top/e' });
  expect(res.status).toBe(200);
  expect((dispatchExtraction as any).mock.calls[0][1]).toMatchObject({ strategy: 'browser' });
});

it('routes an explicit signed-url strategy', async () => {
  (dispatchExtraction as any).mockResolvedValue({ url: 'https://cdn/s.m3u8' });
  const res = await request(app).post('/extract').set('Authorization', `Bearer ${SECRET}`)
    .send({ embedUrl: 'https://embed.example.top/e', strategy: 'signed-url' });
  expect(res.status).toBe(200);
  expect(res.body.url).toBe('https://cdn/s.m3u8');
  expect((dispatchExtraction as any).mock.calls[0][1]).toMatchObject({ strategy: 'signed-url' });
});

it('labels a non-browser null result as pattern_miss', async () => {
  (dispatchExtraction as any).mockResolvedValue(null);
  const res = await request(app).post('/extract').set('Authorization', `Bearer ${SECRET}`)
    .send({ embedUrl: 'https://embed.example.top/e', strategy: 'signed-url' });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(false);
});
```
(Adapt `app`/`SECRET`/mocking to the file's existing harness. If it currently mocks `../extractor.js`, switch the assertion target to `../strategies/index.js`.)

**Step 2:** run → FAIL.

**Step 3: implement** in `src/routes/extract.ts`:
- Extend the interface: `interface ExtractRequest { embedUrl: string; timeout?: number; priority?: 'high'|'normal'; strategy?: 'browser'|'signed-url'|'http-token'; pattern?: string; }`.
- Replace `import { extractM3u8 } from '../extractor.js';` with `import { dispatchExtraction, type Strategy } from '../strategies/index.js';`.
- In the handler: read `strategy = 'browser'` and `pattern` from the body; call `const extracted = await dispatchExtraction(embedUrl, { timeout, priority, strategy, pattern, queueEnqueueTime });`.
- Add `strategy` to all three `extractionsTotal.inc({...})` calls.
- On the `!extracted` branch, set `error_type` to `strategy === 'browser' ? ERROR_TYPES.timeout : ERROR_TYPES.pattern_miss`.
- Validate `strategy` is one of the three; on invalid, `400`.

**Step 4:** run → PASS.

**Step 5:** `npm run test:run` → green; `npx tsc --noEmit` → clean.
```bash
git add src/routes/extract.ts src/routes/extract.test.ts
git commit -m "feat(extract): dispatch by strategy (browser default), label metrics by strategy"
```

---

## Done criteria for Stage 2
- `npm run test:run` green; `npx tsc --noEmit` clean.
- `POST /extract` with no `strategy` behaves exactly as before (browser, Chrome queue).
- `strategy: 'signed-url'|'http-token'` run off the browser queue and return `ExtractedStream`.
- `.env.example` / README note the new optional `strategy`/`pattern` request fields and `LIGHT_MAX_CONCURRENT` (do this in Step 5 of Task 4 or a small docs commit).
- Next: Stage 3 wires ep-live-events to SEND the strategy (from `CachedStream.extraction`) and adds the timstreams adapter.
