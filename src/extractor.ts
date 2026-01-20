import { chromium } from 'patchright';
import type { Browser, BrowserContext, Frame } from 'patchright';
import consola from 'consola';

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

export async function extractM3u8(
  embedUrl: string,
  timeout: number = 30000
): Promise<ExtractedStream | null> {
  consola.debug(`[Extractor] Opening: ${embedUrl}`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      bypassCSP: true,
      ignoreHTTPSErrors: true,
    });

    // Don't block popups - closing them breaks the main page
    context.on('page', () => {
      consola.debug('[Extractor] Popup opened (not blocking)');
    });

    const page = await context.newPage();

    let m3u8Url: string | null = null;
    let iframeOrigin: string | null = null;
    let resolved = false;

    // Create a promise that resolves when m3u8 is found
    const m3u8Promise = new Promise<ExtractedStream | null>((resolve) => {
      context!.on('request', async (request) => {
        if (resolved) return;

        const url = request.url();

        if (url.includes('.m3u8') && !url.includes('.ts.m3u8') && !m3u8Url) {
          m3u8Url = url;
          resolved = true;

          const frame = request.frame();
          if (frame) {
            try {
              const frameUrl = frame.url();
              if (frameUrl && !frameUrl.startsWith('about:')) {
                iframeOrigin = new URL(frameUrl).origin;
              }
            } catch {
              iframeOrigin = null;
            }
          }

          consola.info(`[Extractor] Found m3u8: ${url}`);

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

          const refererOrigin = iframeOrigin || new URL(embedUrl).origin;
          resolve({
            url: m3u8Url,
            headers: {
              Referer: refererOrigin + '/',
              Origin: refererOrigin,
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            cookies: cookieString,
          });
        }
      });

      // Timeout
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          consola.warn(`[Extractor] No m3u8 found after ${timeout}ms: ${embedUrl}`);
          resolve(null);
        }
      }, timeout);
    });

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
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}
