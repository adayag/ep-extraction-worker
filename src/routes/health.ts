import { Router } from 'express';
import { browserPool } from '../browserPool.js';

const router = Router();

router.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  const browserStatus = browserPool.getStatus();
  const isHealthy = !browserStatus.isCircuitOpen;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    queue: {
      pending: browserPool.getQueueSize(),
      active: browserPool.getActiveCount(),
    },
    browser: {
      circuitBreaker: browserStatus,
    },
  });
});

export default router;
