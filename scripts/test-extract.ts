#!/usr/bin/env npx tsx
/**
 * Local Browser Test Script
 *
 * Usage:
 *   npx tsx scripts/test-extract.ts <embedUrl1> [embedUrl2] [embedUrl3] ...
 *   npx tsx scripts/test-extract.ts --file urls.txt
 *   npx tsx scripts/test-extract.ts --interactive
 *
 * Options:
 *   --timeout <ms>     Extraction timeout (default: 30000)
 *   --verbose          Show debug logs
 *   --file <path>      Read URLs from file (one per line)
 *   --interactive      Interactive mode - enter URLs one at a time
 *   --repeat <n>       Repeat each extraction n times (for consistency testing)
 *   --concurrent <n>   Run n extractions concurrently (stress test)
 */

import { chromium } from 'patchright';
import type { Browser, BrowserContext, Frame } from 'patchright';
import * as readline from 'readline';
import * as fs from 'fs';

// ============================================================================
// Configuration
// ============================================================================

interface TestConfig {
  timeout: number;
  verbose: boolean;
  repeat: number;
  concurrent: number;
}

const defaultConfig: TestConfig = {
  timeout: 30000,
  verbose: false,
  repeat: 1,
  concurrent: 1,
};

// ============================================================================
// Extraction Logic (copied from extractor.ts for standalone testing)
// ============================================================================

const BLOCK_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /facebook\.(com|net)/i,
  /doubleclick\.net/i,
  /analytics\./i,
  /hotjar\.com/i,
  /clarity\.ms/i,
  /sentry\.io/i,
  /segment\.(com|io)/i,
  /mixpanel\.com/i,
  /amplitude\.com/i,
  /newrelic\.com/i,
  /bugsnag\.com/i,
  /datadog/i,
  /ads\./i,
  /adserver\./i,
  /pagead/i,
  /prebid/i,
  /adsystem/i,
  /adservice/i,
  /\.(mp4|webm)(\?|$)/i,
];

const PLAYER_DOMAINS = ['player', 'jwplayer', 'plyr', 'video', 'embed', 'hls', 'dash', 'stream'];
const TELEMETRY_PATTERN = /analytics|tracking|beacon|metrics|telemetry|collect|log|event/i;

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

interface ExtractedStream {
  url: string;
  headers?: Record<string, string>;
  cookies?: string;
}

interface ExtractionResult {
  success: boolean;
  embedUrl: string;
  stream?: ExtractedStream;
  error?: string;
  duration: number;
  blockedRequests: number;
  totalRequests: number;
}

async function tryClickInFrame(frame: Frame, verbose: boolean): Promise<boolean> {
  for (const selector of playSelectors) {
    try {
      const element = await frame.$(selector);
      if (element) {
        const box = await element.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          await element.click({ timeout: 2000 }).catch(() => {});
          if (verbose) console.log(`  ✓ Clicked: ${selector}`);
          return true;
        }
      }
    } catch {
      // Ignore
    }
  }
  return false;
}

async function extractM3u8(
  browser: Browser,
  embedUrl: string,
  config: TestConfig
): Promise<ExtractionResult> {
  const startTime = Date.now();
  let blockedRequests = 0;
  let totalRequests = 0;
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      bypassCSP: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 800, height: 600 },
      screen: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      serviceWorkers: 'block',
    });

    let m3u8Url: string | null = null;
    let m3u8Referer: string | null = null;
    let resolved = false;
    let resolvePromise: (value: ExtractedStream | null) => void;

    const m3u8Promise = new Promise<ExtractedStream | null>((resolve) => {
      resolvePromise = resolve;
    });

    // Single route handler for blocking AND m3u8 detection
    // (separate regex routes don't work reliably with URLs containing port numbers)
    await context.route('**/*', async (route) => {
      totalRequests++;
      const url = route.request().url();
      const resourceType = route.request().resourceType();

      // Check for m3u8 FIRST (before any blocking)
      if (url.includes('.m3u8') && !url.includes('.ts.m3u8')) {
        if (resolved) {
          await route.abort();
          return;
        }

        m3u8Url = url;
        resolved = true;

        const headers = route.request().headers();
        m3u8Referer = headers['referer'] || null;

        if (config.verbose) {
          console.log(`  ✓ Found m3u8: ${url.substring(0, 80)}...`);
        }

        let cookieString: string | undefined;
        try {
          const cookies = await context!.cookies();
          if (cookies.length > 0) {
            cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          }
        } catch {}

        await route.abort();

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
        return;
      }

      if (['image', 'font', 'stylesheet'].includes(resourceType)) {
        blockedRequests++;
        await route.abort();
        return;
      }

      if (resourceType === 'script') {
        const isPlayerScript = PLAYER_DOMAINS.some((d) => url.toLowerCase().includes(d));
        if (!isPlayerScript) {
          for (const pattern of BLOCK_PATTERNS) {
            if (pattern.test(url)) {
              blockedRequests++;
              await route.abort();
              return;
            }
          }
        }
      }

      if (['xhr', 'fetch'].includes(resourceType)) {
        if (TELEMETRY_PATTERN.test(url)) {
          blockedRequests++;
          await route.abort();
          return;
        }
      }

      for (const pattern of BLOCK_PATTERNS) {
        if (pattern.test(url)) {
          blockedRequests++;
          await route.abort();
          return;
        }
      }

      await route.continue();
    });

    // Timeout handler
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolvePromise(null);
      }
    }, config.timeout);

    const page = await context.newPage();

    if (config.verbose) {
      console.log(`  → Navigating to embed...`);
    }

    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000).catch(() => {});

    if (!resolved) {
      if (config.verbose) console.log(`  → Trying play buttons on main frame...`);
      await tryClickInFrame(page.mainFrame(), config.verbose);
      await page.waitForTimeout(1000).catch(() => {});
    }

    if (!resolved) {
      const frames = page.frames();
      if (config.verbose) console.log(`  → Checking ${frames.length - 1} iframes...`);
      for (const frame of frames) {
        if (resolved) break;
        if (frame === page.mainFrame()) continue;
        await tryClickInFrame(frame, config.verbose);
        await page.waitForTimeout(500).catch(() => {});
      }
    }

    const result = await m3u8Promise;
    const duration = Date.now() - startTime;

    if (result) {
      return {
        success: true,
        embedUrl,
        stream: result,
        duration,
        blockedRequests,
        totalRequests,
      };
    } else {
      return {
        success: false,
        embedUrl,
        error: 'No m3u8 found within timeout',
        duration,
        blockedRequests,
        totalRequests,
      };
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      embedUrl,
      error: error instanceof Error ? error.message : String(error),
      duration,
      blockedRequests,
      totalRequests,
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

// ============================================================================
// Test Runner
// ============================================================================

function printResult(result: ExtractionResult, index: number, total: number): void {
  const status = result.success ? '✅' : '❌';
  const duration = (result.duration / 1000).toFixed(2);
  const blocked = `${result.blockedRequests}/${result.totalRequests}`;

  console.log(`\n${status} [${index}/${total}] ${result.embedUrl.substring(0, 60)}...`);
  console.log(`   Duration: ${duration}s | Blocked: ${blocked} requests`);

  if (result.success && result.stream) {
    console.log(`   M3u8: ${result.stream.url.substring(0, 80)}...`);
    if (result.stream.cookies) {
      console.log(`   Cookies: ${result.stream.cookies.substring(0, 50)}...`);
    }
  } else if (result.error) {
    console.log(`   Error: ${result.error}`);
  }
}

function printSummary(results: ExtractionResult[]): void {
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length / 1000;
  const totalBlocked = results.reduce((sum, r) => sum + r.blockedRequests, 0);
  const totalRequests = results.reduce((sum, r) => sum + r.totalRequests, 0);

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total: ${results.length} | Success: ${successful} | Failed: ${failed}`);
  console.log(`Success Rate: ${((successful / results.length) * 100).toFixed(1)}%`);
  console.log(`Avg Duration: ${avgDuration.toFixed(2)}s`);
  console.log(`Blocked Requests: ${totalBlocked}/${totalRequests} (${((totalBlocked / totalRequests) * 100).toFixed(1)}%)`);

  if (failed > 0) {
    console.log('\nFailed URLs:');
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  - ${r.embedUrl}`);
        console.log(`    Error: ${r.error}`);
      });
  }
}

async function runInteractiveMode(browser: Browser, config: TestConfig): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n🎬 Interactive Extraction Test');
  console.log('Enter embed URLs to test (empty line to quit)\n');

  const results: ExtractionResult[] = [];

  const askForUrl = (): void => {
    rl.question('Enter embed URL: ', async (url) => {
      if (!url.trim()) {
        rl.close();
        if (results.length > 0) {
          printSummary(results);
        }
        return;
      }

      console.log(`\nExtracting...`);
      const result = await extractM3u8(browser, url.trim(), config);
      results.push(result);
      printResult(result, results.length, results.length);
      console.log('');
      askForUrl();
    });
  };

  askForUrl();

  await new Promise<void>((resolve) => {
    rl.on('close', resolve);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = { ...defaultConfig };
  const urls: string[] = [];

  let interactive = false;
  let urlFile: string | null = null;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--timeout' && args[i + 1]) {
      config.timeout = parseInt(args[++i], 10);
    } else if (arg === '--verbose' || arg === '-v') {
      config.verbose = true;
    } else if (arg === '--repeat' && args[i + 1]) {
      config.repeat = parseInt(args[++i], 10);
    } else if (arg === '--concurrent' && args[i + 1]) {
      config.concurrent = parseInt(args[++i], 10);
    } else if (arg === '--file' && args[i + 1]) {
      urlFile = args[++i];
    } else if (arg === '--interactive' || arg === '-i') {
      interactive = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: npx tsx scripts/test-extract.ts [options] <url1> [url2] ...

Options:
  --timeout <ms>     Extraction timeout (default: 30000)
  --verbose, -v      Show debug logs
  --file <path>      Read URLs from file (one per line)
  --interactive, -i  Interactive mode - enter URLs one at a time
  --repeat <n>       Repeat each extraction n times
  --concurrent <n>   Run n extractions concurrently
  --help, -h         Show this help

Examples:
  npx tsx scripts/test-extract.ts https://example.com/embed/123
  npx tsx scripts/test-extract.ts --verbose --timeout 45000 https://example.com/embed/123
  npx tsx scripts/test-extract.ts --file urls.txt
  npx tsx scripts/test-extract.ts --interactive
`);
      process.exit(0);
    } else if (arg.startsWith('http')) {
      urls.push(arg);
    }
  }

  // Read URLs from file if specified
  if (urlFile) {
    const fileContent = fs.readFileSync(urlFile, 'utf-8');
    const fileUrls = fileContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line.startsWith('http'));
    urls.push(...fileUrls);
  }

  // Validate inputs
  if (!interactive && urls.length === 0) {
    console.error('Error: No URLs provided. Use --help for usage.');
    process.exit(1);
  }

  console.log('🚀 EP Extraction Worker Test Script');
  console.log(`   Timeout: ${config.timeout}ms`);
  console.log(`   Verbose: ${config.verbose}`);
  if (!interactive) {
    console.log(`   URLs: ${urls.length}`);
    console.log(`   Repeat: ${config.repeat}x`);
    console.log(`   Concurrent: ${config.concurrent}`);
  }

  // Launch browser
  console.log('\n⏳ Launching browser...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-default-apps',
      '--no-first-run',
      '--js-flags=--max-old-space-size=128',
      '--disable-software-rasterizer',
      '--disable-accelerated-2d-canvas',
      '--mute-audio',
    ],
  });
  console.log('✓ Browser launched');

  try {
    if (interactive) {
      await runInteractiveMode(browser, config);
    } else {
      // Expand URLs by repeat count
      const expandedUrls = urls.flatMap((url) => Array(config.repeat).fill(url));
      const results: ExtractionResult[] = [];

      console.log(`\n📋 Testing ${expandedUrls.length} extractions...`);

      // Process in batches based on concurrency
      for (let i = 0; i < expandedUrls.length; i += config.concurrent) {
        const batch = expandedUrls.slice(i, i + config.concurrent);
        const batchResults = await Promise.all(
          batch.map((url) => extractM3u8(browser, url, config))
        );

        for (const result of batchResults) {
          results.push(result);
          printResult(result, results.length, expandedUrls.length);
        }
      }

      printSummary(results);
    }
  } finally {
    console.log('\n⏳ Closing browser...');
    await browser.close();
    console.log('✓ Done');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
