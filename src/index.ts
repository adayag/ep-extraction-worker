import express from 'express';
import consola from 'consola';
import healthRouter from './routes/health.js';
import extractRouter from './routes/extract.js';
import { browserPool } from './browserPool.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Middleware
app.use(express.json());

// Routes
app.use('/', healthRouter);
app.use('/', extractRouter);

// Start server
const server = app.listen(PORT, () => {
  consola.info(`[ExtractionWorker] Server running on port ${PORT}`);
  consola.info(`[ExtractionWorker] Health: http://localhost:${PORT}/health`);
  consola.info(`[ExtractionWorker] Extract: POST http://localhost:${PORT}/extract`);
});

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
  consola.info(`[ExtractionWorker] Received ${signal}, shutting down gracefully...`);

  server.close(() => {
    consola.info('[ExtractionWorker] HTTP server closed');
  });

  await browserPool.close();
  consola.info('[ExtractionWorker] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
