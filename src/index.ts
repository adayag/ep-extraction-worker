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
const STUCK_QUEUE_SIZE_THRESHOLD = parseInt(process.env.STUCK_QUEUE_SIZE_THRESHOLD || '20', 10);
const STUCK_QUEUE_AGE_THRESHOLD = parseInt(process.env.STUCK_QUEUE_AGE_THRESHOLD || '120000', 10);
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

    // Detect a wedged queue: many requests pending AND the oldest running task is older than threshold.
    // Last-resort safety net — normally QUEUE_TASK_TIMEOUT (90s) frees the slot before the
    // 120s age threshold trips, so this only fires if the hard timeout itself misbehaves.
    const queueSize = browserPool.getQueueSize();
    const oldestAge = browserPool.getOldestRunningTaskAge();
    if (
      queueSize >= STUCK_QUEUE_SIZE_THRESHOLD &&
      oldestAge !== null &&
      oldestAge >= STUCK_QUEUE_AGE_THRESHOLD
    ) {
      consola.error(
        `[Watchdog] Queue wedged: pending=${queueSize}, oldest running task age=${Math.round(oldestAge / 1000)}s`,
      );
      consola.error('[Watchdog] Exiting process for container restart...');
      // process.exit(1) is intentional, not SIGTERM. A wedged worker can't run its own graceful
      // shutdown (browser.close() would hang on the same stuck contexts). Hard exit lets the
      // container orchestrator reap us and start fresh. In-flight HTTP requests get connection-
      // reset, which the upstream caller already handles for the existing crash-recovery path.
      process.exit(1);
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
const SHUTDOWN_TIMEOUT = parseInt(process.env.SHUTDOWN_TIMEOUT || '30000', 10);
let shutdownInProgress = false;

async function shutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    consola.warn(`[ExtractionWorker] Shutdown already in progress, ignoring ${signal}`);
    return;
  }
  shutdownInProgress = true;

  consola.info(`[ExtractionWorker] Received ${signal}, shutting down gracefully...`);

  // 1. Stop watchdog
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  // 2. Stop accepting new connections and wait for in-flight requests to drain
  const serverClose = new Promise<void>((resolve) => {
    server.close(() => {
      consola.info('[ExtractionWorker] HTTP server closed');
      resolve();
    });
  });

  const metricsClose = new Promise<void>((resolve) => {
    metricsServer.close(() => {
      consola.info('[ExtractionWorker] Metrics server closed');
      resolve();
    });
  });

  const forceTimeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      consola.warn(`[ExtractionWorker] Shutdown timeout (${SHUTDOWN_TIMEOUT}ms) reached, forcing close`);
      resolve();
    }, SHUTDOWN_TIMEOUT);
  });

  // 3. Wait for servers to drain or timeout
  await Promise.race([
    Promise.all([serverClose, metricsClose]),
    forceTimeout,
  ]);

  // 4. Close browser pool
  await browserPool.close();
  consola.info('[ExtractionWorker] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
