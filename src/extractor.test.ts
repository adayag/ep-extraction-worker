import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock patchright before importing extractor
vi.mock('patchright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

import { extractM3u8, type ExtractedStream } from './extractor.js';
import { chromium } from 'patchright';

describe('extractor', () => {
  let mockBrowser: {
    newContext: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let mockContext: {
    on: ReturnType<typeof vi.fn>;
    newPage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let mockPage: {
    goto: ReturnType<typeof vi.fn>;
    waitForTimeout: ReturnType<typeof vi.fn>;
    mainFrame: ReturnType<typeof vi.fn>;
    frames: ReturnType<typeof vi.fn>;
  };
  let requestCallbacks: Array<(request: unknown) => void> = [];

  beforeEach(() => {
    requestCallbacks = [];

    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      mainFrame: vi.fn().mockReturnValue({
        $: vi.fn().mockResolvedValue(null),
      }),
      frames: vi.fn().mockReturnValue([]),
    };

    mockContext = {
      on: vi.fn((event: string, callback: (request: unknown) => void) => {
        if (event === 'request') {
          requestCallbacks.push(callback);
        }
      }),
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('extractM3u8', () => {
    it('should return ExtractedStream when m3u8 is found', async () => {
      // After page navigation, simulate m3u8 request
      mockPage.goto.mockImplementation(async () => {
        // Trigger callback after "navigation"
        for (const cb of requestCallbacks) {
          cb({
            url: () => 'https://cdn.example.com/stream.m3u8',
            frame: () => ({
              url: () => 'https://embed.example.com/player',
            }),
          });
        }
      });

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(result).not.toBeNull();
      expect(result?.url).toBe('https://cdn.example.com/stream.m3u8');
      expect(result?.headers).toHaveProperty('Referer');
      expect(result?.headers?.Referer).toBe('https://embed.example.com/');
    });

    it('should return null on timeout when no m3u8 found', async () => {
      // No m3u8 request triggered
      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 100);

      expect(result).toBeNull();
    }, 10000);

    it('should return null when browser launch fails', async () => {
      vi.mocked(chromium.launch).mockRejectedValue(new Error('Browser failed'));

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(result).toBeNull();
    });

    it('should close browser and context after extraction', async () => {
      mockPage.goto.mockImplementation(async () => {
        for (const cb of requestCallbacks) {
          cb({
            url: () => 'https://cdn.example.com/stream.m3u8',
            frame: () => ({
              url: () => 'https://embed.example.com/player',
            }),
          });
        }
      });

      await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(mockContext.close).toHaveBeenCalled();
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should filter out .ts.m3u8 segment URLs', async () => {
      let callCount = 0;

      mockPage.goto.mockImplementation(async () => {
        for (const cb of requestCallbacks) {
          // First call: segment URL (should be ignored)
          cb({
            url: () => 'https://cdn.example.com/segment.ts.m3u8',
            frame: () => ({ url: () => 'https://embed.example.com/' }),
          });
        }
      });

      mockPage.waitForTimeout.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // After first waitForTimeout, send real m3u8
          for (const cb of requestCallbacks) {
            cb({
              url: () => 'https://cdn.example.com/playlist.m3u8',
              frame: () => ({ url: () => 'https://embed.example.com/' }),
            });
          }
        }
      });

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(result?.url).toBe('https://cdn.example.com/playlist.m3u8');
    });

    it('should use iframe origin for Referer when available', async () => {
      mockPage.goto.mockImplementation(async () => {
        for (const cb of requestCallbacks) {
          cb({
            url: () => 'https://cdn.example.com/stream.m3u8',
            frame: () => ({
              url: () => 'https://player.different.com/iframe',
            }),
          });
        }
      });

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(result?.headers?.Referer).toBe('https://player.different.com/');
      expect(result?.headers?.Origin).toBe('https://player.different.com');
    });
  });
});
