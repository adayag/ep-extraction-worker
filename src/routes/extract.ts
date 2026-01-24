import { Router } from 'express';
import consola from 'consola';
import { authMiddleware } from '../middleware/auth.js';
import { extractM3u8 } from '../extractor.js';

const router = Router();

interface ExtractRequest {
  embedUrl: string;
  timeout?: number;
}

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
  const { embedUrl, timeout = 30000 } = req.body as ExtractRequest;

  if (!embedUrl) {
    res.status(400).json({ error: 'embedUrl is required' });
    return;
  }

  const startTime = Date.now();
  const shortId = getShortId(embedUrl);

  const extracted = await extractM3u8(embedUrl, timeout);
  const duration = Date.now() - startTime;

  if (!extracted) {
    consola.warn(`[Extract] FAILED ${shortId} (${duration}ms)`);
    res.json({
      success: false,
      error: 'm3u8 extraction failed',
    });
    return;
  }

  consola.info(`[Extract] OK ${shortId} (${duration}ms)`);

  res.json({
    success: true,
    url: extracted.url,
    m3u8Url: extracted.url,
    headers: extracted.headers,
    cookies: extracted.cookies,
  });
});

export default router;
