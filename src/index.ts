import express from 'express';
import consola from 'consola';
import healthRouter from './routes/health.js';
import extractRouter from './routes/extract.js';
import metricsRouter from './routes/metrics.js';
import { browserPool } from './browserPool.js';

const app = express();
const metricsApp = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9090', 10);
const CIRCUIT_BREAKER_EXIT_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_EXIT_THRESHOLD || '120000', 10);
const WATCHDOG_INTERVAL = 10000; // Check every 10 seconds

// Middleware
app.use(express.json());

// Routes
app.use('/', healthRouter);
app.use('/', extractRouter);

// Metrics on separate port (internal only)
metricsApp.use('/', metricsRouter);

// Track when circuit first opened for watchdog
let circuitOpenSince: number | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function startWatchdog(): void {
  watchdogTimer = setInterval(() => {
    const status = browserPool.getStatus();

    if (status.isCircuitOpen) {
      if (circuitOpenSince === null) {
        circuitOpenSince = Date.now();
        consola.warn('[Watchdog] Circuit breaker opened, monitoring...');
      }

      const openDuration = Date.now() - circuitOpenSince;
      if (openDuration >= CIRCUIT_BREAKER_EXIT_THRESHOLD) {
        consola.error(`[Watchdog] Circuit open for ${Math.round(openDuration / 1000)}s, exceeds threshold of ${CIRCUIT_BREAKER_EXIT_THRESHOLD / 1000}s`);
        consola.error('[Watchdog] Exiting process for container restart...');
        process.exit(1);
      }
    } else {
      // Circuit recovered, reset tracking
      if (circuitOpenSince !== null) {
        consola.info('[Watchdog] Circuit breaker recovered');
        circuitOpenSince = null;
      }
    }
  }, WATCHDOG_INTERVAL);
}

// Start servers
const server = app.listen(PORT, () => {
  consola.info(`[ExtractionWorker] Server running on port ${PORT}`);
  consola.info(`[ExtractionWorker] Health: http://localhost:${PORT}/health`);
  consola.info(`[ExtractionWorker] Extract: POST http://localhost:${PORT}/extract`);
  consola.info(`[ExtractionWorker] Watchdog exit threshold: ${CIRCUIT_BREAKER_EXIT_THRESHOLD / 1000}s`);
  startWatchdog();
});

const metricsServer = metricsApp.listen(METRICS_PORT, () => {
  consola.info(`[ExtractionWorker] Metrics: http://localhost:${METRICS_PORT}/metrics`);
});

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
  consola.info(`[ExtractionWorker] Received ${signal}, shutting down gracefully...`);

  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  server.close(() => {
    consola.info('[ExtractionWorker] HTTP server closed');
  });

  metricsServer.close(() => {
    consola.info('[ExtractionWorker] Metrics server closed');
  });

  await browserPool.close();
  consola.info('[ExtractionWorker] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
