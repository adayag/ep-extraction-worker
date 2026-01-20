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
    route: ReturnType<typeof vi.fn>;
    cookies: ReturnType<typeof vi.fn>;
    newPage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let mockPage: {
    goto: ReturnType<typeof vi.fn>;
    waitForTimeout: ReturnType<typeof vi.fn>;
    mainFrame: ReturnType<typeof vi.fn>;
    frames: ReturnType<typeof vi.fn>;
  };
  let routeCallbacks: Array<(route: unknown) => Promise<void>> = [];

  beforeEach(() => {
    routeCallbacks = [];

    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      mainFrame: vi.fn().mockReturnValue({
        $: vi.fn().mockResolvedValue(null),
      }),
      frames: vi.fn().mockReturnValue([]),
    };

    mockContext = {
      on: vi.fn(),
      route: vi.fn(async (_pattern: string, callback: (route: unknown) => Promise<void>) => {
        routeCallbacks.push(callback);
      }),
      cookies: vi.fn().mockResolvedValue([]),
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

  // Helper to create mock route object
  function createMockRoute(url: string, referer?: string) {
    return {
      request: () => ({
        url: () => url,
        headers: () => (referer ? { referer } : {}),
      }),
      abort: vi.fn().mockResolvedValue(undefined),
      continue: vi.fn().mockResolvedValue(undefined),
    };
  }

  describe('extractM3u8', () => {
    it('should return ExtractedStream when m3u8 is found', async () => {
      // After page navigation, simulate m3u8 request via route
      mockPage.goto.mockImplementation(async () => {
        const mockRoute = createMockRoute(
          'https://cdn.example.com/stream.m3u8',
          'https://embed.example.com/player'
        );
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(result).not.toBeNull();
      expect(result?.url).toBe('https://cdn.example.com/stream.m3u8');
      expect(result?.headers).toHaveProperty('Referer');
      expect(result?.headers?.Referer).toBe('https://embed.example.com/');
    });

    it('should abort m3u8 request to preserve token', async () => {
      const mockRoute = createMockRoute('https://cdn.example.com/stream.m3u8');

      mockPage.goto.mockImplementation(async () => {
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(mockRoute.abort).toHaveBeenCalled();
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
        const mockRoute = createMockRoute('https://cdn.example.com/stream.m3u8');
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(mockContext.close).toHaveBeenCalled();
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should continue .ts.m3u8 segment URLs and not capture them', async () => {
      let callCount = 0;
      const segmentRoute = createMockRoute('https://cdn.example.com/segment.ts.m3u8');
      const playlistRoute = createMockRoute('https://cdn.example.com/playlist.m3u8');

      mockPage.goto.mockImplementation(async () => {
        // First: segment URL (should be continued, not captured)
        for (const cb of routeCallbacks) {
          await cb(segmentRoute);
        }
      });

      mockPage.waitForTimeout.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // After first waitForTimeout, send real m3u8
          for (const cb of routeCallbacks) {
            await cb(playlistRoute);
          }
        }
      });

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(segmentRoute.continue).toHaveBeenCalled();
      expect(playlistRoute.abort).toHaveBeenCalled();
      expect(result?.url).toBe('https://cdn.example.com/playlist.m3u8');
    });

    it('should use referer header for Referer when available', async () => {
      mockPage.goto.mockImplementation(async () => {
        const mockRoute = createMockRoute(
          'https://cdn.example.com/stream.m3u8',
          'https://player.different.com/iframe'
        );
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(result?.headers?.Referer).toBe('https://player.different.com/');
      expect(result?.headers?.Origin).toBe('https://player.different.com');
    });

    it('should capture cookies when available', async () => {
      mockContext.cookies.mockResolvedValue([
        { name: 'session', value: 'abc123' },
        { name: 'token', value: 'xyz789' },
      ]);

      mockPage.goto.mockImplementation(async () => {
        const mockRoute = createMockRoute('https://cdn.example.com/stream.m3u8');
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(result?.cookies).toBe('session=abc123; token=xyz789');
    });
  });
});
