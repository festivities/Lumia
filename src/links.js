import dns from 'node:dns';
import { PLAYER_EXT, IMAGE_EXT } from './video.js';

export const ALL_MEDIA_EXT = new Set([...PLAYER_EXT, ...IMAGE_EXT]);

/**
 * Checks if an extension from a URL path matches screenable media extensions.
 *
 * @param {string} urlString
 * @returns {boolean}
 */
export function isScreenableLinkUrl(urlString) {
  if (typeof urlString !== 'string') return false;
  try {
    const parsed = new URL(urlString);
    const pathname = parsed.pathname.toLowerCase();
    const extMatch = pathname.match(/\.([a-z0-9]+)$/i);
    if (!extMatch) return false;
    return ALL_MEDIA_EXT.has(extMatch[1]);
  } catch {
    return false;
  }
}

/**
 * Extracts candidate media URLs from a Discord message (embeds + text URLs).
 * User message text is only parsed locally for URLs and never sent to any model.
 *
 * @param {{ content?: string | null, embeds?: any[] }} message
 * @returns {string[]} Unique list of candidate URLs
 */
export function extractCandidateUrls(message) {
  if (!message) return [];

  const candidates = new Set();

  // 1. Embeds: image.url, thumbnail.url, video.url
  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      if (embed?.image?.url) candidates.add(embed.image.url);
      if (embed?.thumbnail?.url) candidates.add(embed.thumbnail.url);
      if (embed?.video?.url) candidates.add(embed.video.url);
    }
  }

  // 2. Text content URLs
  if (typeof message.content === 'string' && message.content.length > 0) {
    const urlRegex = /https?:\/\/[^\s<>"']+/gi;
    let match;
    while ((match = urlRegex.exec(message.content)) !== null) {
      let rawUrl = match[0];
      // Trim trailing punctuation like ).,!?
      rawUrl = rawUrl.replace(/[).,!?]+$/, '');

      if (isScreenableLinkUrl(rawUrl)) {
        candidates.add(rawUrl);
      }
    }
  }

  return [...candidates];
}

/**
 * Checks if an IP address is a private, loopback, link-local, or reserved address.
 *
 * @param {string} ip
 * @returns {boolean} True if IP is private/unsafe for SSRF
 */
export function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;

  // Handle IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  // IPv4 Checks
  if (ip.includes('.')) {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return true; // Invalid format is unsafe
    }

    const [a, b] = parts;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;
    // 10.0.0.0/8 (Private)
    if (a === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (Link-local)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (a >= 224) return true;

    return false;
  }

  // IPv6 Checks
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true; // Link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique local (fc00::/7)

  return false;
}

/**
 * Validates a hostname by resolving DNS and ensuring no resolved IPs are private.
 *
 * @param {string} hostname
 * @returns {Promise<boolean>}
 */
async function validateHostnameSsrf(hostname) {
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) return false;

    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        console.warn(`[Links] SSRF Guard: Rejected host ${hostname} resolving to private IP ${addr.address}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.warn(`[Links] DNS lookup failed for ${hostname}:`, err.message);
    return false;
  }
}

/**
 * Fetches a URL with SSRF guards, redirect tracking, and stream size capping.
 *
 * @param {string} urlString
 * @param {number} maxBytes
 * @returns {Promise<{ buffer: Buffer, contentType: string } | null>}
 */
export async function fetchGuarded(urlString, maxBytes = 50 * 1024 * 1024) {
  let currentUrl = urlString;
  const maxRedirects = 3;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(`[Links] Rejected non-HTTP protocol: ${parsed.protocol}`);
      return null;
    }

    // SSRF Check on hostname
    const safeHost = await validateHostnameSsrf(parsed.hostname);
    if (!safeHost) return null;

    let res;
    try {
      res = await fetch(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Lumia-Bot/1.0 (+https://github.com/festivities/Lumia)',
        },
      });
    } catch (err) {
      console.warn(`[Links] Fetch failed for ${currentUrl}:`, err.message);
      return null;
    }

    // Handle Redirects
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    if (!res.ok) {
      console.warn(`[Links] HTTP ${res.status} fetching ${currentUrl}`);
      return null;
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    // Exclude HTML pages (e.g. YouTube watch pages)
    if (contentType.includes('text/html')) {
      return null;
    }

    // Must be image/*, video/*, or application/octet-stream
    if (!contentType.startsWith('image/') && !contentType.startsWith('video/') && !contentType.includes('octet-stream')) {
      return null;
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      console.warn(`[Links] Content-Length (${contentLength}) exceeds cap (${maxBytes})`);
      return null;
    }

    // Stream download with cap
    try {
      if (!res.body) {
        const ab = await res.arrayBuffer();
        if (ab.byteLength > maxBytes) return null;
        return { buffer: Buffer.from(ab), contentType };
      }

      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          reader.cancel();
          console.warn(`[Links] Stream exceeded size cap (${maxBytes})`);
          return null;
        }
        chunks.push(Buffer.from(value));
      }

      return {
        buffer: Buffer.concat(chunks),
        contentType: contentType || 'application/octet-stream',
      };
    } catch (err) {
      console.warn(`[Links] Error streaming body from ${currentUrl}:`, err.message);
      return null;
    }
  }

  return null;
}

/**
 * In-memory dedupe cache (FIFO eviction, max 2000 entries)
 * Keyed by `${messageId}|${url}`
 */
class DedupeCache {
  constructor(maxEntries = 2000) {
    this._maxEntries = maxEntries;
    this._cache = new Map();
  }

  has(messageId, url) {
    return this._cache.has(`${messageId}|${url}`);
  }

  add(messageId, url) {
    const key = `${messageId}|${url}`;
    if (this._cache.size >= this._maxEntries) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(key, Date.now());
  }

  clear() {
    this._cache.clear();
  }
}

export const dedupeCache = new DedupeCache();
export default {
  isScreenableLinkUrl,
  extractCandidateUrls,
  isPrivateIp,
  fetchGuarded,
  dedupeCache,
};
