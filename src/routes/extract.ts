import { Router } from 'express';
import consola from 'consola';
import { authMiddleware } from '../middleware/auth.js';
import { extractM3u8 } from '../extractor.js';
import { extractionsTotal, extractionDuration, ERROR_TYPES } from '../metrics.js';

const router = Router();

interface ExtractRequest {
  embedUrl: string;
  timeout?: number;
  priority?: 'high' | 'normal';
}

// Priority levels: higher number = executes first
const PRIORITY_LEVELS = {
  normal: 0,
  high: 10,
} as const;

// Extract a short identifier from embed URL for logging
function getShortId(embedUrl: string): string {
  try {
    const url = new URL(embedUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    // Return last 2 path segments or full path if short
    return parts.slice(-2).join('/') || url.pathname;
  } catch {
    return embedUrl.slice(0, 50);
  }
}

// Validate embedUrl to prevent SSRF attacks
function validateEmbedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL format';
  }

  // Only allow http and https schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Blocked URL scheme: ${parsed.protocol}`;
  }

  // Strip brackets from IPv6 hostnames (URL parser wraps them in [])
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // Block localhost variants
  if (hostname === 'localhost' || hostname === 'localhost.') {
    return 'Blocked hostname: localhost';
  }

  // Block IPv6 loopback and unspecified
  if (hostname === '::1' || hostname === '::') {
    return `Blocked IPv6 address: ${hostname}`;
  }

  // Block private/internal IPv4 ranges by pattern
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 127 ||                                   // 127.0.0.0/8 loopback
      a === 10 ||                                    // 10.0.0.0/8 RFC1918
      (a === 172 && b >= 16 && b <= 31) ||           // 172.16.0.0/12 RFC1918
      (a === 192 && b === 168) ||                    // 192.168.0.0/16 RFC1918
      (a === 169 && b === 254) ||                    // 169.254.0.0/16 link-local
      a === 0                                        // 0.0.0.0/8
    ) {
      return `Blocked internal IP address: ${hostname}`;
    }
  }

  return null;
}

router.post('/extract', authMiddleware, async (req, res) => {
  const { embedUrl, timeout = 30000, priority: priorityParam } = req.body as ExtractRequest;

  if (!embedUrl) {
    res.status(400).json({ error: 'embedUrl is required' });
    return;
  }

  const urlError = validateEmbedUrl(embedUrl);
  if (urlError) {
    res.status(400).json({ error: urlError });
    return;
  }

  const queueEnqueueTime = Date.now();
  const shortId = getShortId(embedUrl);
  const priority = PRIORITY_LEVELS[priorityParam ?? 'normal'] ?? PRIORITY_LEVELS.normal;
  const priorityLabel = priority > 0 ? 'HIGH' : 'normal';

  consola.info(`[Extract] QUEUED ${shortId} (priority: ${priorityLabel})`);

  try {
    const extracted = await extractM3u8(embedUrl, timeout, priority, queueEnqueueTime);
    const duration = Date.now() - queueEnqueueTime;
    const durationSeconds = duration / 1000;

    if (!extracted) {
      consola.warn(`[Extract] FAILED ${shortId} (${duration}ms) - timeout`);
      extractionsTotal.inc({ status: 'failure', error_type: ERROR_TYPES.timeout });
      extractionDuration.observe({ status: 'failure' }, durationSeconds);
      res.json({
        success: false,
        error: 'm3u8 extraction failed',
      });
      return;
    }

    consola.info(`[Extract] OK ${shortId} (${duration}ms)`);
    extractionsTotal.inc({ status: 'success', error_type: ERROR_TYPES.none });
    extractionDuration.observe({ status: 'success' }, durationSeconds);

    res.json({
      success: true,
      url: extracted.url,
      m3u8Url: extracted.url,
      headers: extracted.headers,
      cookies: extracted.cookies,
    });
  } catch (error: unknown) {
    const duration = Date.now() - queueEnqueueTime;
    const durationSeconds = duration / 1000;

    // Classify error type
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = errorMessage.includes('Circuit breaker')
      ? ERROR_TYPES.circuit_open
      : ERROR_TYPES.browser_error;

    consola.error(`[Extract] ERROR ${shortId} (${duration}ms) - ${errorType}:`, error);
    extractionsTotal.inc({ status: 'failure', error_type: errorType });
    extractionDuration.observe({ status: 'failure' }, durationSeconds);

    res.status(503).json({
      success: false,
      error: errorMessage,
    });
  }
});

export default router;
