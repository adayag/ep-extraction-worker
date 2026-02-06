import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock extractor before importing route
vi.mock('../extractor.js', () => ({
  extractM3u8: vi.fn(),
}));

// Mock metrics to verify error type labels
vi.mock('../metrics.js', () => ({
  extractionsTotal: { inc: vi.fn() },
  extractionDuration: { observe: vi.fn() },
  ERROR_TYPES: {
    none: 'none',
    timeout: 'timeout',
    circuit_open: 'circuit_open',
    browser_error: 'browser_error',
  },
}));

import extractRouter from './extract.js';
import { extractM3u8 } from '../extractor.js';
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
    vi.mocked(extractM3u8).mockResolvedValue({
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
    vi.mocked(extractM3u8).mockResolvedValue(null);

    const res = await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('extraction failed');
  });

  it('should pass custom timeout to extractor', async () => {
    vi.mocked(extractM3u8).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', timeout: 15000 });

    expect(extractM3u8).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      15000,
      0,
      expect.any(Number) // queueEnqueueTime
    );
  });

  it('should use default timeout when not specified', async () => {
    vi.mocked(extractM3u8).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

    expect(extractM3u8).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      30000,
      0,
      expect.any(Number) // queueEnqueueTime
    );
  });

  it('should pass high priority (10) when priority is "high"', async () => {
    vi.mocked(extractM3u8).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', priority: 'high' });

    expect(extractM3u8).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      30000,
      10,
      expect.any(Number) // queueEnqueueTime
    );
  });

  it('should pass normal priority (0) when priority is "normal"', async () => {
    vi.mocked(extractM3u8).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', priority: 'normal' });

    expect(extractM3u8).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      30000,
      0,
      expect.any(Number) // queueEnqueueTime
    );
  });

  it('should treat invalid priority as normal (0)', async () => {
    vi.mocked(extractM3u8).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', priority: 'invalid' });

    expect(extractM3u8).toHaveBeenCalledWith(
      'https://embed.example.com/embed/admin/123',
      30000,
      0,
      expect.any(Number) // queueEnqueueTime
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
      vi.mocked(extractM3u8).mockResolvedValue({
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
      vi.mocked(extractM3u8).mockResolvedValue({
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
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'success' },
        expect.any(Number)
      );
    });

    it('should track timeout error_type when extraction returns null', async () => {
      vi.mocked(extractM3u8).mockResolvedValue(null);

      await request(app)
        .post('/extract')
        .set('Authorization', `Bearer ${TEST_SECRET}`)
        .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

      expect(extractionsTotal.inc).toHaveBeenCalledTimes(1);
      expect(extractionsTotal.inc).toHaveBeenCalledWith({
        status: 'failure',
        error_type: ERROR_TYPES.timeout,
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'failure' },
        expect.any(Number)
      );
    });

    it('should track circuit_open error_type when circuit breaker throws', async () => {
      vi.mocked(extractM3u8).mockRejectedValue(new Error('Circuit breaker open, retry in 30s'));

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
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'failure' },
        expect.any(Number)
      );
    });

    it('should track browser_error error_type for other errors', async () => {
      vi.mocked(extractM3u8).mockRejectedValue(new Error('Browser crashed unexpectedly'));

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
      });
      expect(extractionDuration.observe).toHaveBeenCalledTimes(1);
      expect(extractionDuration.observe).toHaveBeenCalledWith(
        { status: 'failure' },
        expect.any(Number)
      );
    });

    it('should handle non-Error rejection as browser_error', async () => {
      vi.mocked(extractM3u8).mockRejectedValue('string error without Error object');

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
      });
    });
  });
});
