import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isScreenableLinkUrl,
  extractCandidateUrls,
  isPrivateIp,
  dedupeCache,
} from '../src/links.js';

describe('isScreenableLinkUrl', () => {
  test('returns true for media URLs', () => {
    assert.equal(isScreenableLinkUrl('https://example.com/render.png'), true);
    assert.equal(isScreenableLinkUrl('https://example.com/art/clip.mp4?token=123'), true);
    assert.equal(isScreenableLinkUrl('https://cdn.site.org/images/anim.gif#preview'), true);
    assert.equal(isScreenableLinkUrl('https://site.com/video.webm'), true);
  });

  test('returns false for non-media or invalid URLs', () => {
    assert.equal(isScreenableLinkUrl('https://example.com/index.html'), false);
    assert.equal(isScreenableLinkUrl('https://youtube.com/watch?v=12345'), false);
    assert.equal(isScreenableLinkUrl('https://example.com/document.pdf'), false);
    assert.equal(isScreenableLinkUrl('not-a-valid-url'), false);
    assert.equal(isScreenableLinkUrl(''), false);
    assert.equal(isScreenableLinkUrl(null), false);
  });
});

describe('extractCandidateUrls', () => {
  test('extracts media URLs from embeds', () => {
    const msg = {
      content: 'Here is some text with no links',
      embeds: [
        { image: { url: 'https://cdn.example.com/embed1.jpg' } },
        { thumbnail: { url: 'https://cdn.example.com/thumb.png' } },
        { video: { url: 'https://cdn.example.com/clip.mp4' } },
      ],
    };

    const urls = extractCandidateUrls(msg);
    assert.deepEqual(urls.sort(), [
      'https://cdn.example.com/clip.mp4',
      'https://cdn.example.com/embed1.jpg',
      'https://cdn.example.com/thumb.png',
    ].sort());
  });

  test('extracts and trims media URLs from text content while filtering out non-media URLs', () => {
    const msg = {
      content: 'Check out https://art.com/render.png! Also see (https://cdn.org/video.mp4). Read https://news.com/article.',
      embeds: [],
    };

    const urls = extractCandidateUrls(msg);
    assert.deepEqual(urls.sort(), [
      'https://art.com/render.png',
      'https://cdn.org/video.mp4',
    ].sort());
  });

  test('deduplicates URLs between embeds and text content', () => {
    const msg = {
      content: 'Look at https://cdn.com/same.png',
      embeds: [{ image: { url: 'https://cdn.com/same.png' } }],
    };

    const urls = extractCandidateUrls(msg);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], 'https://cdn.com/same.png');
  });
});

describe('isPrivateIp', () => {
  test('correctly identifies private, loopback, and link-local IPv4 addresses', () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('10.0.0.1'), true);
    assert.equal(isPrivateIp('192.168.1.100'), true);
    assert.equal(isPrivateIp('172.16.0.1'), true);
    assert.equal(isPrivateIp('172.31.255.255'), true);
    assert.equal(isPrivateIp('169.254.169.254'), true);
    assert.equal(isPrivateIp('0.0.0.0'), true);
    assert.equal(isPrivateIp('224.0.0.1'), true);
  });

  test('correctly identifies private/loopback IPv6 addresses', () => {
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('fe80::1'), true);
    assert.equal(isPrivateIp('fc00::1'), true);
    assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  });

  test('allows public IPs', () => {
    assert.equal(isPrivateIp('8.8.8.8'), false);
    assert.equal(isPrivateIp('1.1.1.1'), false);
    assert.equal(isPrivateIp('142.250.190.46'), false);
    assert.equal(isPrivateIp('172.32.0.1'), false); // Just outside 172.16.0.0/12
  });
});

describe('dedupeCache', () => {
  test('tracks and evicts oldest items', () => {
    dedupeCache.clear();
    assert.equal(dedupeCache.has('msg1', 'http://a.com'), false);

    dedupeCache.add('msg1', 'http://a.com');
    assert.equal(dedupeCache.has('msg1', 'http://a.com'), true);
    assert.equal(dedupeCache.has('msg2', 'http://a.com'), false);
  });
});
