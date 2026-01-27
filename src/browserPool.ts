import { chromium } from 'patchright';
import type { Browser, BrowserContext } from 'patchright';
import consola from 'consola';
import PQueue from 'p-queue';
import {
  browserLaunches,
  browserLaunchFailures,
  browserRestarts,
  circuitBreakerOpen,
  queueDepth,
  activeExtractions,
} from './metrics.js';

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSER_IDLE_TIMEOUT || '60000', 10); // 60 seconds
const MAX_AGE_MS = parseInt(process.env.BROWSER_MAX_AGE || '7200000', 10); // 2 hours

// Circuit breaker settings
const CIRCUIT_BREAKER_THRESHOLD = 3; // failures before opening circuit
const CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds before retry

class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private queue = new PQueue({ concurrency: MAX_CONCURRENT });
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private launchTime: number = 0;
  private activeCount = 0;

  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitOpenUntil: number = 0;

  async getBrowser(): Promise<Browser> {
    // Check circuit breaker - throw if open
    if (this.isCircuitOpen()) {
      const waitTime = Math.ceil((this.circuitOpenUntil - Date.now()) / 1000);
      throw new Error(`Circuit breaker open, retry in ${waitTime}s`);
    }

    // Check if existing browser is still connected
    if (this.browser) {
      if (this.browser.isConnected()) {
        // Check max-age - restart if exceeded and no active extractions
        const age = Date.now() - this.launchTime;
        if (age > MAX_AGE_MS && this.activeCount === 0) {
          consola.info(`[BrowserPool] Max age exceeded (${Math.round(age / 1000)}s), restarting browser`);
          browserRestarts.inc({ reason: 'max_age' });
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

    this.launching = this.launchBrowserWithCircuitBreaker();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  private isCircuitOpen(): boolean {
    return this.circuitOpenUntil > Date.now();
  }

  private async launchBrowserWithCircuitBreaker(): Promise<Browser> {
    try {
      const browser = await this.launchBrowser();
      // Success - reset circuit breaker
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      circuitBreakerOpen.set(0);
      return browser;
    } catch (error) {
      // Failure - increment and possibly open circuit
      this.consecutiveFailures++;
      browserLaunchFailures.inc();
      consola.error(`[BrowserPool] Launch failed (${this.consecutiveFailures}/${CIRCUIT_BREAKER_THRESHOLD}):`, error);

      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
        circuitBreakerOpen.set(1);
        consola.error(`[BrowserPool] Circuit breaker OPEN for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
      }
      throw error;
    }
  }

  getStatus(): { isCircuitOpen: boolean; consecutiveFailures: number; circuitOpenUntil: number } {
    return {
      isCircuitOpen: this.isCircuitOpen(),
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntil: this.circuitOpenUntil,
    };
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
    browserLaunches.inc();
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
   * Run an extraction function with concurrency limiting and priority support
   * @param fn - The async function to execute
   * @param priority - Priority level (0-10, higher runs first). Default: 0
   */
  async withLimit<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    const result = await this.queue.add(async () => {
      // Clear idle timer when extraction starts
      this.clearIdleTimer();
      this.activeCount++;

      // Update metrics
      queueDepth.set(this.queue.size);
      activeExtractions.set(this.activeCount);

      try {
        return await fn();
      } finally {
        this.activeCount--;
        // Update metrics
        queueDepth.set(this.queue.size);
        activeExtractions.set(this.activeCount);
        // Schedule idle restart after extraction completes (if no more active)
        if (this.activeCount === 0) {
          this.scheduleIdleRestart();
        }
      }
    }, { priority });

    return result as T;
  }

  /**
   * Get the number of pending items in the queue
   */
  getQueueSize(): number {
    return this.queue.size;
  }

  /**
   * Get the number of currently running tasks
   */
  getActiveCount(): number {
    return this.activeCount;
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
        browserRestarts.inc({ reason: 'idle' });
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
