import { chromium } from 'patchright';
import type { Browser, BrowserContext } from 'patchright';
import consola from 'consola';
import pLimit from 'p-limit';

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSER_IDLE_TIMEOUT || '60000', 10); // 60 seconds
const MAX_AGE_MS = parseInt(process.env.BROWSER_MAX_AGE || '7200000', 10); // 2 hours

class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private limiter = pLimit(MAX_CONCURRENT);
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private launchTime: number = 0;
  private activeCount = 0;

  async getBrowser(): Promise<Browser> {
    // Check if existing browser is still connected
    if (this.browser) {
      if (this.browser.isConnected()) {
        // Check max-age - restart if exceeded and no active extractions
        const age = Date.now() - this.launchTime;
        if (age > MAX_AGE_MS && this.activeCount === 0) {
          consola.info(`[BrowserPool] Max age exceeded (${Math.round(age / 1000)}s), restarting browser`);
          await this.restartBrowser();
        } else {
          return this.browser;
        }
      } else {
        // Browser disconnected, clear reference
        consola.warn('[BrowserPool] Browser disconnected, will relaunch');
        this.browser = null;
      }
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
    this.launchTime = Date.now();
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
        // Process limit flags (reduce memory by sharing renderer)
        '--renderer-process-limit=1',
        '--disable-features=IsolateOrigins,site-per-process',
        // Graphics optimizations (video embeds don't need 3D)
        '--disable-webgl',
        '--disable-webgl2',
        '--disable-3d-apis',
        '--disable-canvas-aa',
        // Keep extraction responsive (don't throttle timers/renderer)
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        // Reduce background CPU work
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-client-side-phishing-detection',
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
    return this.limiter(async () => {
      // Clear idle timer when extraction starts
      this.clearIdleTimer();
      this.activeCount++;

      try {
        return await fn();
      } finally {
        this.activeCount--;
        // Schedule idle restart after extraction completes (if no more active)
        if (this.activeCount === 0) {
          this.scheduleIdleRestart();
        }
      }
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleRestart(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(async () => {
      if (this.activeCount === 0 && this.browser) {
        const age = Math.round((Date.now() - this.launchTime) / 1000);
        consola.info(`[BrowserPool] Idle restart (age: ${age}s)`);
        await this.restartBrowser();
      }
    }, IDLE_TIMEOUT_MS);
  }

  private async restartBrowser(): Promise<void> {
    this.clearIdleTimer();
    if (this.browser) {
      const oldBrowser = this.browser;
      this.browser = null; // Set null FIRST to avoid race with getBrowser()
      await oldBrowser.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    if (this.browser) {
      consola.info('[BrowserPool] Closing browser...');
      const oldBrowser = this.browser;
      this.browser = null; // Set null FIRST to avoid race with getBrowser()
      await oldBrowser.close().catch(() => {});
      consola.info('[BrowserPool] Browser closed');
    }
  }

  isRunning(): boolean {
    return this.browser !== null;
  }
}

// Singleton instance
export const browserPool = new BrowserPool();
