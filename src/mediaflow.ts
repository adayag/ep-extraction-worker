export interface MediaFlowConfig {
  mediaflowProxyUrl: string;
}

export function getMediaFlowConfig(): MediaFlowConfig {
  return {
    mediaflowProxyUrl: process.env.MEDIAFLOW_PROXY_URL || '',
  };
}

export function buildMediaFlowUrl(
  m3u8Url: string,
  headers?: Record<string, string>,
  cookies?: string
): string {
  const config = getMediaFlowConfig();

  if (!config.mediaflowProxyUrl) {
    return m3u8Url;
  }

  // Parse base URL to preserve any query params (like api_password)
  const baseUrl = new URL(config.mediaflowProxyUrl);
  const url = new URL('/proxy/hls/manifest.m3u8', baseUrl.origin);

  // Copy existing query params from base URL (e.g., api_password)
  baseUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  url.searchParams.set('d', m3u8Url);

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      url.searchParams.set(`h_${key}`, value);
    }
  }

  // Add cookies as Cookie header
  if (cookies) {
    url.searchParams.set('h_Cookie', cookies);
  }

  return url.toString();
}
