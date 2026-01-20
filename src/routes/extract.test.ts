import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock extractor and mediaflow before importing route
vi.mock('../extractor.js', () => ({
  extractM3u8: vi.fn(),
}));

vi.mock('../mediaflow.js', () => ({
  buildMediaFlowUrl: vi.fn(),
}));

import extractRouter from './extract.js';
import { extractM3u8 } from '../extractor.js';
import { buildMediaFlowUrl } from '../mediaflow.js';

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

  it('should return MediaFlow URL on successful extraction', async () => {
    vi.mocked(extractM3u8).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: { Referer: 'https://embed.example.com/' },
    });
    vi.mocked(buildMediaFlowUrl).mockReturnValue('https://proxy.example.com/proxy/hls/manifest.m3u8?d=...');

    const res = await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toBe('https://proxy.example.com/proxy/hls/manifest.m3u8?d=...');
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
    vi.mocked(buildMediaFlowUrl).mockReturnValue('https://proxy.example.com/...');

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123', timeout: 15000 });

    expect(extractM3u8).toHaveBeenCalledWith('https://embed.example.com/embed/admin/123', 15000);
  });

  it('should use default timeout when not specified', async () => {
    vi.mocked(extractM3u8).mockResolvedValue({
      url: 'https://cdn.example.com/stream.m3u8',
      headers: {},
    });
    vi.mocked(buildMediaFlowUrl).mockReturnValue('https://proxy.example.com/...');

    await request(app)
      .post('/extract')
      .set('Authorization', `Bearer ${TEST_SECRET}`)
      .send({ embedUrl: 'https://embed.example.com/embed/admin/123' });

    expect(extractM3u8).toHaveBeenCalledWith('https://embed.example.com/embed/admin/123', 30000);
  });
});
