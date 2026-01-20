import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildMediaFlowUrl, getMediaFlowConfig } from './mediaflow.js';

describe('mediaflow', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getMediaFlowConfig', () => {
    it('should return proxy URL from environment', () => {
      process.env.MEDIAFLOW_PROXY_URL = 'https://proxy.example.com';
      const config = getMediaFlowConfig();
      expect(config.mediaflowProxyUrl).toBe('https://proxy.example.com');
    });

    it('should return empty string when not configured', () => {
      delete process.env.MEDIAFLOW_PROXY_URL;
      const config = getMediaFlowConfig();
      expect(config.mediaflowProxyUrl).toBe('');
    });
  });

  describe('buildMediaFlowUrl', () => {
    it('should return original URL when proxy not configured', () => {
      delete process.env.MEDIAFLOW_PROXY_URL;
      const m3u8Url = 'https://stream.example.com/video.m3u8';
      const result = buildMediaFlowUrl(m3u8Url);
      expect(result).toBe(m3u8Url);
    });

    it('should wrap m3u8 URL with MediaFlow proxy', () => {
      process.env.MEDIAFLOW_PROXY_URL = 'https://proxy.example.com';
      const m3u8Url = 'https://stream.example.com/video.m3u8';
      const result = buildMediaFlowUrl(m3u8Url);

      expect(result).toContain('https://proxy.example.com/proxy/hls/manifest.m3u8');
      expect(result).toContain('d=' + encodeURIComponent(m3u8Url));
    });

    it('should preserve query params from proxy URL (api_password)', () => {
      process.env.MEDIAFLOW_PROXY_URL = 'https://proxy.example.com?api_password=secret123';
      const m3u8Url = 'https://stream.example.com/video.m3u8';
      const result = buildMediaFlowUrl(m3u8Url);

      expect(result).toContain('api_password=secret123');
      expect(result).toContain('d=' + encodeURIComponent(m3u8Url));
    });

    it('should add headers as h_ prefixed query params', () => {
      process.env.MEDIAFLOW_PROXY_URL = 'https://proxy.example.com';
      const m3u8Url = 'https://stream.example.com/video.m3u8';
      const headers = {
        Referer: 'https://embed.example.com/',
        Origin: 'https://embed.example.com',
      };
      const result = buildMediaFlowUrl(m3u8Url, headers);

      const url = new URL(result);
      expect(url.searchParams.get('h_Referer')).toBe('https://embed.example.com/');
      expect(url.searchParams.get('h_Origin')).toBe('https://embed.example.com');
    });

    it('should handle complex headers with User-Agent', () => {
      process.env.MEDIAFLOW_PROXY_URL = 'https://proxy.example.com?api_password=test';
      const m3u8Url = 'https://stream.example.com/video.m3u8';
      const headers = {
        Referer: 'https://embed.example.com/',
        Origin: 'https://embed.example.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      };
      const result = buildMediaFlowUrl(m3u8Url, headers);

      const url = new URL(result);
      expect(url.searchParams.get('api_password')).toBe('test');
      expect(url.searchParams.get('h_User-Agent')).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0');
    });

    it('should add cookies as h_Cookie query param', () => {
      process.env.MEDIAFLOW_PROXY_URL = 'https://proxy.example.com';
      const m3u8Url = 'https://stream.example.com/video.m3u8';
      const headers = { Referer: 'https://embed.example.com/' };
      const cookies = 'session=abc123; token=xyz789';
      const result = buildMediaFlowUrl(m3u8Url, headers, cookies);

      const url = new URL(result);
      expect(url.searchParams.get('h_Cookie')).toBe('session=abc123; token=xyz789');
    });

    it('should not add h_Cookie when cookies is undefined', () => {
      process.env.MEDIAFLOW_PROXY_URL = 'https://proxy.example.com';
      const m3u8Url = 'https://stream.example.com/video.m3u8';
      const result = buildMediaFlowUrl(m3u8Url, undefined, undefined);

      const url = new URL(result);
      expect(url.searchParams.has('h_Cookie')).toBe(false);
    });
  });
});
