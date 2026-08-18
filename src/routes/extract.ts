import { Router } from 'express';
import consola from 'consola';
import { authMiddleware } from '../middleware/auth.js';
import { dispatchExtraction, type Strategy } from '../strategies/index.js';
import { validateEmbedUrl } from '../ssrf.js';
import { QueueTaskTimeoutError } from '../browserPool.js';
import { extractionsTotal, extractionDuration, ERROR_TYPES } from '../metrics.js';

const router = Router();

interface ExtractRequest {
  embedUrl: string;
  timeout?: number;
  priority?: 'high' | 'normal';
  strategy?: Strategy;
  pattern?: string;
}

const STRATEGIES: readonly Strategy[] = ['browser', 'http-token'];

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

router.post('/extract', authMiddleware, async (req, res) => {
  const {
    embedUrl,
    timeout = 30000,
    priority: priorityParam,
    strategy = 'browser',
    pattern,
  } = req.body as ExtractRequest;

  if (!embedUrl) {
    res.status(400).json({ error: 'embedUrl is required' });
    return;
  }

  const urlError = validateEmbedUrl(embedUrl);
  if (urlError) {
    res.status(400).json({ error: urlError });
    return;
  }

  if (!STRATEGIES.includes(strategy)) {
    res.status(400).json({ error: `Unknown strategy: ${strategy}` });
    return;
  }

  const queueEnqueueTime = Date.now();
  const shortId = getShortId(embedUrl);
  const priority = PRIORITY_LEVELS[priorityParam ?? 'normal'] ?? PRIORITY_LEVELS.normal;
  const priorityLabel = priority > 0 ? 'HIGH' : 'normal';

  consola.info(`[Extract] QUEUED ${shortId} (priority: ${priorityLabel}, strategy: ${strategy})`);

  try {
    const extracted = await dispatchExtraction(embedUrl, {
      timeout,
      priority,
      strategy,
      pattern,
      queueEnqueueTime,
    });
    const duration = Date.now() - queueEnqueueTime;
    const durationSeconds = duration / 1000;

    if (!extracted) {
      // The browser path fails by timing out; HTTP strategies fail by not matching.
      const missType = strategy === 'browser' ? ERROR_TYPES.timeout : ERROR_TYPES.pattern_miss;
      consola.warn(`[Extract] FAILED ${shortId} (${duration}ms) - ${missType}`);
      extractionsTotal.inc({ status: 'failure', error_type: missType, strategy });
      extractionDuration.observe({ status: 'failure' }, durationSeconds);
      res.json({
        success: false,
        error: 'm3u8 extraction failed',
      });
      return;
    }

    consola.info(`[Extract] OK ${shortId} (${duration}ms)`);
    extractionsTotal.inc({ status: 'success', error_type: ERROR_TYPES.none, strategy });
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
    const errorType = error instanceof QueueTaskTimeoutError
      ? ERROR_TYPES.queue_timeout
      : errorMessage.includes('Circuit breaker')
        ? ERROR_TYPES.circuit_open
        : ERROR_TYPES.browser_error;

    consola.error(`[Extract] ERROR ${shortId} (${duration}ms) - ${errorType}:`, error);
    extractionsTotal.inc({ status: 'failure', error_type: errorType, strategy });
    extractionDuration.observe({ status: 'failure' }, durationSeconds);

    res.status(503).json({
      success: false,
      error: errorMessage,
    });
  }
});

export default router;
