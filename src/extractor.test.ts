import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock browserPool before importing extractor
vi.mock('./browserPool.js', () => {
  const mockContext = {
    on: vi.fn(),
    route: vi.fn(),
    unroute: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue([]),
    newPage: vi.fn(),
    pages: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    browserPool: {
      createContext: vi.fn().mockResolvedValue(mockContext),
      withLimit: vi.fn((fn: () => Promise<unknown>) => fn()),
      close: vi.fn(),
      isRunning: vi.fn().mockReturnValue(true),
      _mockContext: mockContext, // Expose for test access
    },
  };
});

import { extractM3u8 } from './extractor.js';
import { browserPool } from './browserPool.js';

describe('extractor', () => {
  let mockPage: {
    goto: ReturnType<typeof vi.fn>;
    waitForTimeout: ReturnType<typeof vi.fn>;
    mainFrame: ReturnType<typeof vi.fn>;
    frames: ReturnType<typeof vi.fn>;
  };
  let routeCallbacks: Array<(route: unknown) => Promise<void>> = [];

  // Get the mocked context from browserPool
  const getMockContext = () => (browserPool as unknown as { _mockContext: ReturnType<typeof vi.fn> })._mockContext;

  beforeEach(() => {
    vi.clearAllMocks();
    routeCallbacks = [];

    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      mainFrame: vi.fn().mockReturnValue({
        $: vi.fn().mockResolvedValue(null),
      }),
      frames: vi.fn().mockReturnValue([]),
    };

    const mockContext = getMockContext();
    mockContext.on.mockClear();
    mockContext.route.mockImplementation(
      async (_pattern: string, callback: (route: unknown) => Promise<void>) => {
        routeCallbacks.push(callback);
      }
    );
    mockContext.cookies.mockResolvedValue([]);
    mockContext.newPage.mockResolvedValue(mockPage);
    mockContext.close.mockResolvedValue(undefined);

    vi.mocked(browserPool.createContext).mockResolvedValue(mockContext);
    vi.mocked(browserPool.withLimit).mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Helper to create mock route object
  function createMockRoute(url: string, referer?: string, resourceType: string = 'xhr') {
    return {
      request: () => ({
        url: () => url,
        headers: () => (referer ? { referer } : {}),
        resourceType: () => resourceType,
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

    it('should return null when context creation fails', async () => {
      vi.mocked(browserPool.createContext).mockRejectedValue(new Error('Browser failed'));

      const result = await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(result).toBeNull();
    });

    it('should close context after extraction', async () => {
      const mockContext = getMockContext();
      mockPage.goto.mockImplementation(async () => {
        const mockRoute = createMockRoute('https://cdn.example.com/stream.m3u8');
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(mockContext.close).toHaveBeenCalled();
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
      const mockContext = getMockContext();
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

    it('should run extraction through concurrency limiter', async () => {
      mockPage.goto.mockImplementation(async () => {
        const mockRoute = createMockRoute('https://cdn.example.com/stream.m3u8');
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(browserPool.withLimit).toHaveBeenCalled();
    });

    it('should unroute before closing context', async () => {
      const mockContext = getMockContext();
      mockPage.goto.mockImplementation(async () => {
        const mockRoute = createMockRoute('https://cdn.example.com/stream.m3u8');
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(mockContext.unroute).toHaveBeenCalledWith('**/*');
      // Verify unroute was called before close
      const unrouteOrder = mockContext.unroute.mock.invocationCallOrder[0];
      const closeOrder = mockContext.close.mock.invocationCallOrder[0];
      expect(unrouteOrder).toBeLessThan(closeOrder);
    });

    it('should close all pages before closing context', async () => {
      const mockContext = getMockContext();
      const mockPageToClose = { close: vi.fn().mockResolvedValue(undefined) };
      mockContext.pages.mockReturnValue([mockPageToClose]);

      mockPage.goto.mockImplementation(async () => {
        const mockRoute = createMockRoute('https://cdn.example.com/stream.m3u8');
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(mockPageToClose.close).toHaveBeenCalled();
      // Verify page was closed before context.close
      const pageCloseOrder = mockPageToClose.close.mock.invocationCallOrder[0];
      const contextCloseOrder = mockContext.close.mock.invocationCallOrder[0];
      expect(pageCloseOrder).toBeLessThan(contextCloseOrder);
    });

    it('should close popup pages immediately', async () => {
      const mockContext = getMockContext();
      let pageHandler: ((page: unknown) => void) | null = null;

      // Capture the page event handler
      mockContext.on.mockImplementation((event: string, handler: (page: unknown) => void) => {
        if (event === 'page') {
          pageHandler = handler;
        }
      });

      const mockPopup = { close: vi.fn().mockResolvedValue(undefined) };

      mockPage.goto.mockImplementation(async () => {
        // Simulate popup opening during navigation
        if (pageHandler) {
          pageHandler(mockPopup);
        }
        const mockRoute = createMockRoute('https://cdn.example.com/stream.m3u8');
        for (const cb of routeCallbacks) {
          await cb(mockRoute);
        }
      });

      await extractM3u8('https://embed.example.com/embed/admin/123', 1000);

      expect(mockPopup.close).toHaveBeenCalled();
    });
  });
});
