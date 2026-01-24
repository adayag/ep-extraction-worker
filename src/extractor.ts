import type { BrowserContext, Frame } from 'patchright';
import consola from 'consola';
import { browserPool } from './browserPool.js';

// Cached patterns for performance (compiled once at module load)
const BLOCK_PATTERNS = [
  // Analytics & tracking
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /facebook\.(com|net)/i,
  /doubleclick\.net/i,
  /analytics\./i,
  /hotjar\.com/i,
  /clarity\.ms/i,
  // Additional tracking services
  /sentry\.io/i,
  /segment\.(com|io)/i,
  /mixpanel\.com/i,
  /amplitude\.com/i,
  /newrelic\.com/i,
  /bugsnag\.com/i,
  /datadog/i,
  // Ads
  /ads\./i,
  /adserver\./i,
  /pagead/i,
  /prebid/i,
  /adsystem/i,
  /adservice/i,
  // Video previews (not the stream)
  /\.(mp4|webm)(\?|$)/i,
];

// Single regex for player domain detection (more efficient than array iteration)
const PLAYER_DOMAIN_REGEX = /player|jwplayer|plyr|video|embed|hls|dash|stream/i;

// Telemetry patterns for XHR/Fetch blocking
const TELEMETRY_PATTERN = /analytics|tracking|beacon|metrics|telemetry|collect|log|event/i;

export interface ExtractedStream {
  url: string;
  headers?: Record<string, string>;
  cookies?: string;
}

const playSelectors = [
  '.jw-icon-playback',
  '.jw-display-icon-container',
  '.vjs-big-play-button',
  '[aria-label="Play"]',
  '.play-button',
  '.plyr__control--overlaid',
  'video',
  '[class*="play"]',
];

async function tryClickInFrame(frame: Frame): Promise<void> {
  for (const selector of playSelectors) {
    try {
      const element = await frame.$(selector);
      if (element) {
        const box = await element.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          await element.click({ timeout: 500 }).catch(() => {});
          consola.debug(`[Extractor] Clicked: ${selector}`);
          return;
        }
      }
    } catch {
      // Ignore
    }
  }
}

async function doExtraction(
  embedUrl: string,
  timeout: number
): Promise<ExtractedStream | null> {
  consola.debug(`[Extractor] Opening: ${embedUrl}`);

  let context: BrowserContext | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    context = await browserPool.createContext();

    // Close popup pages immediately to prevent memory accumulation
    context.on('page', async (page) => {
      consola.debug('[Extractor] Closing popup');
      await page.close().catch(() => {});
    });

    let resolved = false;
    let resolvePromise: (value: ExtractedStream | null) => void;

    const m3u8Promise = new Promise<ExtractedStream | null>((resolve) => {
      resolvePromise = resolve;
    });

    // Single route handler for blocking AND m3u8 detection
    // (separate regex routes don't work reliably with URLs containing port numbers)
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      const resourceType = route.request().resourceType();

      // Check for m3u8 FIRST (before any blocking)
      if (url.includes('.m3u8') && !url.includes('.ts.m3u8')) {
        // Race condition fix: check and set resolved atomically
        if (resolved) {
          await route.abort();
          return;
        }
        resolved = true; // Set immediately before any async operations

        // Clear timeout since we found m3u8
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        // Get referer from request headers
        const headers = route.request().headers();
        const m3u8Referer = headers['referer'] || null;

        consola.info(`[Extractor] Found m3u8 (aborted to preserve token): ${url}`);

        // Race condition fix: Capture cookies BEFORE aborting request
        // to ensure context is still valid
        let cookieString: string | undefined;
        try {
          const cookies = await context!.cookies();
          if (cookies.length > 0) {
            cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
            consola.debug(`[Extractor] Captured ${cookies.length} cookies`);
          }
        } catch {
          consola.debug('[Extractor] Could not capture cookies');
        }

        // ABORT the request so the token isn't consumed
        await route.abort();

        // Use referer from request, or fall back to embed URL origin
        let refererOrigin: string;
        if (m3u8Referer) {
          try {
            refererOrigin = new URL(m3u8Referer).origin;
          } catch {
            refererOrigin = new URL(embedUrl).origin;
          }
        } else {
          refererOrigin = new URL(embedUrl).origin;
        }

        resolvePromise({
          url,
          headers: {
            Referer: refererOrigin + '/',
            Origin: refererOrigin,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          cookies: cookieString,
        });
        return;
      }

      // Block images, fonts, and stylesheets by resource type
      if (['image', 'font', 'stylesheet'].includes(resourceType)) {
        await route.abort();
        return;
      }

      // Check URL against block patterns once (consolidated)
      const shouldBlock = BLOCK_PATTERNS.some((pattern) => pattern.test(url));

      // Block non-player scripts that match block patterns
      if (resourceType === 'script') {
        const isPlayerScript = PLAYER_DOMAIN_REGEX.test(url);
        if (!isPlayerScript && shouldBlock) {
          await route.abort();
          return;
        }
      }

      // Block telemetry XHR/Fetch requests
      if (['xhr', 'fetch'].includes(resourceType)) {
        if (TELEMETRY_PATTERN.test(url)) {
          await route.abort();
          return;
        }
      }

      // Block by URL patterns (already computed)
      if (shouldBlock) {
        await route.abort();
        return;
      }

      await route.continue();
    });

    // Timeout handler with memory leak fix
    timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        consola.warn(`[Extractor] No m3u8 found after ${timeout}ms: ${embedUrl}`);
        resolvePromise(null);
      }
    }, timeout);

    const page = await context.newPage();

    // Navigate
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    // Wait for page to settle (reduced from 2000ms)
    await page.waitForTimeout(500).catch(() => {});

    // Try clicking play on main page
    if (!resolved) {
      await tryClickInFrame(page.mainFrame());
      await page.waitForTimeout(500).catch(() => {});
    }

    // Try clicking play in iframes (parallelized)
    if (!resolved) {
      const frames = page.frames().filter((f) => f !== page.mainFrame());
      if (frames.length > 0) {
        await Promise.all(frames.map((frame) => tryClickInFrame(frame).catch(() => {})));
      }
    }

    // Wait for m3u8 or timeout
    const result = await m3u8Promise;
    return result;
  } catch (error) {
    consola.error(`[Extractor] Error for ${embedUrl}:`, error);
    return null;
  } finally {
    // Clear timeout to prevent memory leak
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (context) {
      // Clean up route handlers to release closures
      await context.unroute('**/*').catch(() => {});
      // Close all pages explicitly
      const pages = context.pages();
      await Promise.all(pages.map((p) => p.close().catch(() => {})));
      // Then close context
      await context.close().catch(() => {});
    }
  }
}

export async function extractM3u8(
  embedUrl: string,
  timeout: number = 15000
): Promise<ExtractedStream | null> {
  // Run with concurrency limiting
  return browserPool.withLimit(() => doExtraction(embedUrl, timeout));
}
