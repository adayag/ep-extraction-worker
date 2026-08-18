import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the strategy dispatcher before importing route
vi.mock('../strategies/index.js', () => ({
  dispatchExtraction: vi.fn(),
}));

// Mock metrics to verify error type labels
vi.mock('../metrics.js', () => ({
  extractionsTotal: { inc: vi.fn() },
  extractionDuration: { observe: vi.fn() },
  ERROR_TYPES: {
    none: 'none',
    timeout: 'timeout',
    circuit_open: 'circuit_open',
    queue_timeout: 'queue_timeout',
    browser_error: 'browser_error',
    pattern_miss: 'pattern_miss',
    http_error: 'http_error',
  },
}));

import extractRouter from './extract.js';
import { dispatchExtraction } from '../strategies/index.js';
import { QueueTaskTimeoutError } from '../browserPool.js';
import { extractionsTotal, extractionDuration, ERROR_TYPES } from '../metrics.js';

describe('POST /extract', () => {
  let app: express.Application;
  const TEST_SECRET = 'test-secret-123';

  beforeEach(() => {
    process.env.EXTRACTION_SECRET = TEST_SECRET;

    app = express();
    app.use(express.json());
    app.use('/', extractRouter);

    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.EXTRACTION_SECRET;
  });

  it('should return 401 without auth header', async () => {
    const res = await request(app)
      .post('/extract')
      .send({ embedUrl: 'https://example.com/embed' });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Authorization');
  });

  it('should return 401 with invalid token', async () => {
    const res = await request(app)
      .post('/extract')
      .set('Authorization', 'Bearer wrong-token')
      .send({ embedUrl: 'https://example.com/embed' });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid');
  });

  it('should return 400 when embedUrl is missing', async () => {
    const res = await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('embedUrl');
  });

  it('should return raw m3u8 URL on successful extraction', async () => {
    vi.mocked(dispatchExtraction).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: { Referer: 'https://embed.example.com/' },
    });

    const res = await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toBe('https://cdn.example.com/stream.m3u8');
    expect(res.body.m3u8Url).toBe('https://cdn.example.com/stream.m3u8');
    expect(res.body.headers).toEqual({ Referer: 'https://embed.example.com/' });
  });

  it('should return success: false when extraction fails', async () => {
    vi.mocked(dispatchExtraction).mockResolvedValue(null);

    const res = await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('extraction failed');
  });

  it('should pass custom timeout to extractor', async () => {
    vi.mocked(dispatchExtraction).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', timeout: 15000 });

    expect(dispatchExtraction).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      expect.objectContaining({
        timeout: 15000,
        priority: 0,
        strategy: 'browser',
        queueEnqueueTime: expect.any(Number),
      })
    );
  });

  it('should use default timeout when not specified', async () => {
    vi.mocked(dispatchExtraction).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

    expect(dispatchExtraction).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      expect.objectContaining({
        timeout: 30000,
        priority: 0,
        strategy: 'browser',
        queueEnqueueTime: expect.any(Number),
      })
    );
  });

  it('should pass high priority (10) when priority is "high"', async () => {
    vi.mocked(dispatchExtraction).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', priority: 'high' });

    expect(dispatchExtraction).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      expect.objectContaining({
        timeout: 30000,
        priority: 10,
        strategy: 'browser',
        queueEnqueueTime: expect.any(Number),
      })
    );
  });

  it('should pass normal priority (0) when priority is "normal"', async () => {
    vi.mocked(dispatchExtraction).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', priority: 'normal' });

    expect(dispatchExtraction).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      expect.objectContaining({
        timeout: 30000,
        priority: 0,
        strategy: 'browser',
        queueEnqueueTime: expect.any(Number),
      })
    );
  });

  it('should treat invalid priority as normal (0)', async () => {
    vi.mocked(dispatchExtraction).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', priority: 'invalid' });

    expect(dispatchExtraction).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      expect.objectContaining({
        timeout: 30000,
        priority: 0,
        strategy: 'browser',
        queueEnqueueTime: expect.any(Number),
      })
    );
  });

  // URL validation / SSRF protection tests
  describe('URL validation', () => {
    it('should reject file:// scheme', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'file:///etc/passwd' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked URL scheme');
    });

    it('should reject javascript: scheme', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'javascript:alert(1)' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked URL scheme');
    });

    it('should reject malformed URL', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'not-a-url' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid URL');
    });

    it('should reject http://127.0.0.1', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'http://127.0.0.1/foo' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked internal IP');
    });

    it('should reject http://169.254.169.254 (cloud metadata)', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'http://169.254.169.254/latest/meta-data/' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked internal IP');
    });

    it('should reject http://10.0.0.1 (RFC1918)', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'http://10.0.0.1/admin' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked internal IP');
    });

    it('should reject http://192.168.1.1 (RFC1918)', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'http://192.168.1.1/' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked internal IP');
    });

    it('should reject http://172.16.0.1 (RFC1918)', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'http://172.16.0.1/' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked internal IP');
    });

    it('should reject http://localhost', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'http://localhost/foo' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked hostname: localhost');
    });

    it('should reject http://[::1] (IPv6 loopback)', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'http://[::1]/foo' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked IPv6');
    });

    it('should reject http://0.0.0.0', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'http://0.0.0.0/' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Blocked internal IP');
    });

    it('should accept valid https embed URL', async () => {
      vi.mocked(dispatchExtraction).mockResolvedValue({
        url: 'https://cdn.example.com/stream.m3u8',
        headers: {},
      });

      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.com/video' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // Error type metrics tests
  describe('error type metrics', () => {
    it('should track success with error_type "none"', async () => {
      vi.mocked(dispatchExtraction).mockResolvedValue({
        url: 'https://cdn.example.com/stream.m3u8',
        headers: {},
      });

      await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

      expect(extractionsTotal.inc).toHaveBeenCalledTimes(1);
      expect(extractionsTotal.inc).toHaveBeenCalledWith({
        status: 'success',
        error_type: ERROR_TYPES.none,
        strategy: 'browser',
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'success' },
        expect.any(Number)
      );
    });

    it('should track timeout error_type when extraction returns null', async () => {
      vi.mocked(dispatchExtraction).mockResolvedValue(null);

      await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

      expect(extractionsTotal.inc).toHaveBeenCalledTimes(1);
      expect(extractionsTotal.inc).toHaveBeenCalledWith({
        status: 'failure',
        error_type: ERROR_TYPES.timeout,
        strategy: 'browser',
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'failure' },
        expect.any(Number)
      );
    });

    it('should track circuit_open error_type when circuit breaker throws', async () => {
      vi.mocked(dispatchExtraction).mockRejectedValue(new Error('Circuit breaker open, retry in 30s'));

      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

      expect(res.status).toBe(503);
      expect(res.body.error).toContain('Circuit breaker');
      expect(extractionsTotal.inc).toHaveBeenCalledTimes(1);
      expect(extractionsTotal.inc).toHaveBeenCalledWith({
        status: 'failure',
        error_type: ERROR_TYPES.circuit_open,
        strategy: 'browser',
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'failure' },
        expect.any(Number)
      );
    });

    it('should track browser_error error_type for other errors', async () => {
      vi.mocked(dispatchExtraction).mockRejectedValue(new Error('Browser crashed unexpectedly'));

      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Browser crashed unexpectedly');
      expect(extractionsTotal.inc).toHaveBeenCalledTimes(1);
      expect(extractionsTotal.inc).toHaveBeenCalledWith({
        status: 'failure',
        error_type: ERROR_TYPES.browser_error,
        strategy: 'browser',
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'failure' },
        expect.any(Number)
      );
    });

    it('should track queue_timeout error_type when QueueTaskTimeoutError thrown', async () => {
      vi.mocked(dispatchExtraction).mockRejectedValue(new QueueTaskTimeoutError(90000));

      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/QUEUE_TASK_TIMEOUT/);
      expect(extractionsTotal.inc).toHaveBeenCalledTimes(1);
      expect(extractionsTotal.inc).toHaveBeenCalledWith({
        status: 'failure',
        error_type: ERROR_TYPES.queue_timeout,
        strategy: 'browser',
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'failure' },
        expect.any(Number)
      );
    });

    it('should handle non-Error rejection as browser_error', async () => {
      vi.mocked(dispatchExtraction).mockRejectedValue('string error without Error object');

      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('string error without Error object');
      expect(extractionsTotal.inc).toHaveBeenCalledTimes(1);
      expect(extractionsTotal.inc).toHaveBeenCalledWith({
        status: 'failure',
        error_type: ERROR_TYPES.browser_error,
        strategy: 'browser',
      });
    });
  });

  // Strategy dispatch tests
  describe('strategy dispatch', () => {
    it('defaults strategy to browser and passes it through', async () => {
      vi.mocked(dispatchExtraction).mockResolvedValue({ url: 'https://x/y.m3u8' });

      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.top/e' });

      expect(res.status).toBe(200);
      expect(vi.mocked(dispatchExtraction).mock.calls[0][1]).toMatchObject({ strategy: 'browser' });
    });

    it('routes an explicit http-token strategy', async () => {
      vi.mocked(dispatchExtraction).mockResolvedValue({ url: 'https://cdn/s.m3u8' });

      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.top/e', strategy: 'http-token' });

      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://cdn/s.m3u8');
      expect(vi.mocked(dispatchExtraction).mock.calls[0][1]).toMatchObject({ strategy: 'http-token' });
    });

    it('labels a non-browser null result as pattern_miss', async () => {
      vi.mocked(dispatchExtraction).mockResolvedValue(null);

      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.top/e', strategy: 'http-token' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(extractionsTotal.inc).toHaveBeenCalledWith({
        status: 'failure',
        error_type: ERROR_TYPES.pattern_miss,
        strategy: 'http-token',
      });
    });

    it('rejects an unknown strategy with 400', async () => {
      const res = await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.top/e', strategy: 'bogus' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('strategy');
      expect(dispatchExtraction).not.toHaveBeenCalled();
    });

    it('passes a custom pattern through to the dispatcher', async () => {
      vi.mocked(dispatchExtraction).mockResolvedValue({ url: 'https://cdn/s.m3u8' });

      await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.top/e', strategy: 'http-token', pattern: 'src="([^"]+)"' });

      expect(vi.mocked(dispatchExtraction).mock.calls[0][1]).toMatchObject({
        strategy: 'http-token',
        pattern: 'src="([^"]+)"',
      });
    });
  });
});
