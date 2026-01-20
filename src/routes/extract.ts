import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { extractM3u8 } from '../extractor.js';
import { buildMediaFlowUrl } from '../mediaflow.js';

const router = Router();

interface ExtractRequest {
  embedUrl: string;
  timeout?: number;
}

router.post('/extract', authMiddleware, async (req, res) => {
  const { embedUrl, timeout = 30000 } = req.body as ExtractRequest;

  if (!embedUrl) {
    res.status(400).json({ error: 'embedUrl is required' });
    return;
  }

  const extracted = await extractM3u8(embedUrl, timeout);

  if (!extracted) {
    res.json({
      success: false,
      error: 'm3u8 extraction failed',
    });
    return;
  }

  const mediaFlowUrl = buildMediaFlowUrl(extracted.url, extracted.headers);

  res.json({
    success: true,
    url: mediaFlowUrl,
    m3u8Url: extracted.url,
    headers: extracted.headers,
  });
});

export default router;
