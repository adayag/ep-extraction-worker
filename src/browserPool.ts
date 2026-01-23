import { chromium } from 'patchright';
import type { Browser, BrowserContext } from 'patchright';
import consola from 'consola';
import pLimit from 'p-limit';

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);

class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private limiter = pLimit(MAX_CONCURRENT);

  async getBrowser(): Promise<Browser> {
    // Check if existing browser is still connected
    if (this.browser) {
      if (this.browser.isConnected()) {
        return this.browser;
      }
      // Browser disconnected, clear reference
      consola.warn('[BrowserPool] Browser disconnected, will relaunch');
      this.browser = null;
    }

    // Prevent multiple simultaneous launches
    if (this.launching) {
      return this.launching;
    }

    this.launching = this.launchBrowser();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    consola.info('[BrowserPool] Launching browser...');
    const browser = await chromium.launch({
      channel: 'chrome',
      executablePath: process.env.CHROME_PATH || undefined,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        // Memory optimizations
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-default-apps',
        '--no-first-run',
        '--js-flags=--max-old-space-size=128',
        // Additional CPU optimizations
        '--disable-software-rasterizer',
        '--disable-accelerated-2d-canvas',
        '--mute-audio',
      ],
    });

    // Handle browser disconnect/crash - clear reference so next request relaunches
    browser.on('disconnected', () => {
      consola.warn('[BrowserPool] Browser disconnected unexpectedly');
      if (this.browser === browser) {
        this.browser = null;
      }
    });

    consola.info('[BrowserPool] Browser launched');
    return browser;
  }

  async createContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    return browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      bypassCSP: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 800, height: 600 },
      screen: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      // Performance optimizations
      reducedMotion: 'reduce',
    });
  }

  /**
   * Run an extraction function with concurrency limiting
   */
  async withLimit<T>(fn: () => Promise<T>): Promise<T> {
    return this.limiter(fn);
  }

  async close(): Promise<void> {
    if (this.browser) {
      consola.info('[BrowserPool] Closing browser...');
      await this.browser.close().catch(() => {});
      this.browser = null;
      consola.info('[BrowserPool] Browser closed');
    }
  }

  isRunning(): boolean {
    return this.browser !== null;
  }
}

// Singleton instance
export const browserPool = new BrowserPool();
