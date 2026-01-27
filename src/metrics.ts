import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const register = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop lag, GC)
collectDefaultMetrics({ register });

// --- Operations ---
export const circuitBreakerOpen = new Gauge({
  name: 'extraction_worker_circuit_breaker_open',
  help: 'Circuit breaker state (1=open, 0=closed)',
  registers: [register],
});

// Initialize to 0 so Prometheus has a value before any failures
circuitBreakerOpen.set(0);

export const browserLaunches = new Counter({
  name: 'extraction_worker_browser_launches_total',
  help: 'Total browser launches',
  registers: [register],
});

export const browserLaunchFailures = new Counter({
  name: 'extraction_worker_browser_launch_failures_total',
  help: 'Total browser launch failures',
  registers: [register],
});

export const browserRestarts = new Counter({
  name: 'extraction_worker_browser_restarts_total',
  help: 'Total browser restarts (idle/max-age)',
  labelNames: ['reason'] as const,
  registers: [register],
});

// --- Performance ---
// Error type constants for consistent labeling
export const ERROR_TYPES = {
  none: 'none',
  timeout: 'timeout',
  circuit_open: 'circuit_open',
  browser_error: 'browser_error',
} as const;

export const extractionsTotal = new Counter({
  name: 'extraction_worker_extractions_total',
  help: 'Total extractions',
  labelNames: ['status', 'error_type'] as const,
  registers: [register],
});

export const extractionDuration = new Histogram({
  name: 'extraction_worker_extraction_duration_seconds',
  help: 'Extraction duration in seconds',
  labelNames: ['status'] as const,
  buckets: [0.5, 1, 2, 5, 10, 15, 30, 60],
  registers: [register],
});

// --- Capacity ---
export const queueDepth = new Gauge({
  name: 'extraction_worker_queue_depth',
  help: 'Number of extractions waiting in queue',
  registers: [register],
});

export const activeExtractions = new Gauge({
  name: 'extraction_worker_active_extractions',
  help: 'Number of extractions currently running',
  registers: [register],
});

// --- Circuit Breaker & Browser Health ---
export const circuitBreakerTrips = new Counter({
  name: 'extraction_worker_circuit_breaker_trips_total',
  help: 'Total circuit breaker trips (when circuit opens)',
  registers: [register],
});

export const browserDisconnects = new Counter({
  name: 'extraction_worker_browser_disconnects_total',
  help: 'Total unexpected browser disconnections',
  registers: [register],
});

// --- Performance Breakdown ---
export const queueWaitTime = new Histogram({
  name: 'extraction_worker_queue_wait_seconds',
  help: 'Time waiting in queue before execution starts',
  buckets: [0.01, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const contextCreationTime = new Histogram({
  name: 'extraction_worker_context_creation_seconds',
  help: 'Time to create browser context',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

export const m3u8DetectionTime = new Histogram({
  name: 'extraction_worker_m3u8_detection_seconds',
  help: 'Time from page navigation start to m3u8 intercept',
  buckets: [0.5, 1, 2, 5, 10, 15, 30, 60],
  registers: [register],
});
