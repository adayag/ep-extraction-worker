import express from 'express';
import consola from 'consola';
import healthRouter from './routes/health.js';
import extractRouter from './routes/extract.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Middleware
app.use(express.json());

// Routes
app.use('/', healthRouter);
app.use('/', extractRouter);

// Start server
app.listen(PORT, () => {
  consola.info(`[ExtractionWorker] Server running on port ${PORT}`);
  consola.info(`[ExtractionWorker] Health: http://localhost:${PORT}/health`);
  consola.info(`[ExtractionWorker] Extract: POST http://localhost:${PORT}/extract`);
});

export default app;
