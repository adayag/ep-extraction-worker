// Validate embedUrl to prevent SSRF attacks
export function validateEmbedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL format';
  }

  // Only allow http and https schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Blocked URL scheme: ${parsed.protocol}`;
  }

  // Strip brackets from IPv6 hostnames (URL parser wraps them in [])
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // Block localhost variants
  if (hostname === 'localhost' || hostname === 'localhost.') {
    return 'Blocked hostname: localhost';
  }

  // Block IPv6 loopback and unspecified
  if (hostname === '::1' || hostname === '::') {
    return `Blocked IPv6 address: ${hostname}`;
  }

  // Block private/internal IPv4 ranges by pattern
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 127 ||                                   // 127.0.0.0/8 loopback
      a === 10 ||                                    // 10.0.0.0/8 RFC1918
      (a === 172 && b >= 16 && b <= 31) ||           // 172.16.0.0/12 RFC1918
      (a === 192 && b === 168) ||                    // 192.168.0.0/16 RFC1918
      (a === 169 && b === 254) ||                    // 169.254.0.0/16 link-local
      a === 0                                        // 0.0.0.0/8
    ) {
      return `Blocked internal IP address: ${hostname}`;
    }
  }

  return null;
}
