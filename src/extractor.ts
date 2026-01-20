import type { BrowserContext, Frame } from 'patchright';
import consola from 'consola';
import { browserPool } from './browserPool.js';

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
          await element.click({ timeout: 2000 }).catch(() => {});
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

  try {
    context = await browserPool.createContext();

    // Don't block popups - closing them breaks the main page
    context.on('page', () => {
      consola.debug('[Extractor] Popup opened (not blocking)');
    });

    let m3u8Url: string | null = null;
    let m3u8Referer: string | null = null;
    let resolved = false;
    let resolvePromise: (value: ExtractedStream | null) => void;

    const m3u8Promise = new Promise<ExtractedStream | null>((resolve) => {
      resolvePromise = resolve;
    });

    // Set up route interception to ABORT m3u8 requests (preserve token)
    await context.route('**/*.m3u8*', async (route) => {
      const url = route.request().url();

      // Skip segment playlists
      if (url.includes('.ts.m3u8')) {
        await route.continue();
        return;
      }

      // Already found one, let subsequent requests through
      if (resolved) {
        await route.abort();
        return;
      }

      m3u8Url = url;
      resolved = true;

      // Get referer from request headers
      const headers = route.request().headers();
      m3u8Referer = headers['referer'] || null;

      consola.info(`[Extractor] Found m3u8 (aborted to preserve token): ${url}`);

      // ABORT the request so the token isn't consumed
      await route.abort();

      // Capture cookies from the context
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
        url: m3u8Url,
        headers: {
          Referer: refererOrigin + '/',
          Origin: refererOrigin,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        cookies: cookieString,
      });
    });

    // Timeout handler
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        consola.warn(`[Extractor] No m3u8 found after ${timeout}ms: ${embedUrl}`);
        resolvePromise(null);
      }
    }, timeout);

    const page = await context.newPage();

    // Navigate
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    // Wait for page to settle
    await page.waitForTimeout(2000).catch(() => {});

    // Try clicking play on main page
    if (!resolved) {
      await tryClickInFrame(page.mainFrame());
      await page.waitForTimeout(1000).catch(() => {});
    }

    // Try clicking play in iframes
    if (!resolved) {
      const frames = page.frames();
      for (const frame of frames) {
        if (resolved) break;
        if (frame === page.mainFrame()) continue;
        await tryClickInFrame(frame);
        await page.waitForTimeout(500).catch(() => {});
      }
    }

    // Wait for m3u8 or timeout
    const result = await m3u8Promise;
    return result;
  } catch (error) {
    consola.error(`[Extractor] Error for ${embedUrl}:`, error);
    return null;
  } finally {
    // Only close the context, not the browser
    if (context) await context.close().catch(() => {});
  }
}

export async function extractM3u8(
  embedUrl: string,
  timeout: number = 15000
): Promise<ExtractedStream | null> {
  // Run with concurrency limiting
  return browserPool.withLimit(() => doExtraction(embedUrl, timeout));
}
