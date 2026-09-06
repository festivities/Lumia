import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseOmniResult } from '../src/parse.js';
import { getProvider, retryDelayMs, rateLimitHint } from '../src/safety.js';

describe('parseOmniResult', () => {
  test('maps clean image to safe verdict', () => {
    const json = {
      id: 'modr-123',
      model: 'omni-moderation-latest',
      results: [{
        flagged: false,
        categories: { sexual: false, 'sexual/minors': false, violence: false, 'violence/graphic': false },
        category_scores: { sexual: 0.001 },
      }],
    };
    assert.deepEqual(parseOmniResult(json), { safe: true, categories: [] });
  });

  test('maps sexual flag to unsafe verdict', () => {
    const json = {
      results: [{
        flagged: true,
        categories: { sexual: true, 'sexual/minors': false, violence: false },
      }],
    };
    assert.deepEqual(parseOmniResult(json), { safe: false, categories: ['sexual'] });
  });

  test('ignores non-sexual flags (sexual-only policy)', () => {
    const json = {
      results: [{
        flagged: true,
        categories: { sexual: false, 'sexual/minors': false, violence: true, 'violence/graphic': true },
      }],
    };
    assert.deepEqual(parseOmniResult(json), { safe: true, categories: [] });
  });

  test('throws on malformed responses (fail-open upstream)', () => {
    assert.throws(() => parseOmniResult({}), /results\[0\]/);
    assert.throws(() => parseOmniResult({ results: [] }), /results\[0\]/);
    assert.throws(() => parseOmniResult({ results: [{ flagged: false }] }), /categories/);
    assert.throws(() => parseOmniResult(null), /results\[0\]/);
  });
});

describe('retryDelayMs', () => {
  test('falls back to scheduled backoff with jitter when no headers', () => {
    const res = new Response('{}', { status: 429 });
    const d1 = retryDelayMs(res, 1);
    assert.ok(d1 >= 5000 && d1 <= 6000, `attempt 1 delay ${d1} out of range`);
    const d3 = retryDelayMs(res, 3);
    assert.ok(d3 >= 45000 && d3 <= 46000, `attempt 3 delay ${d3} out of range`);
  });

  test('honors retry-after-ms server guidance over shorter schedule', () => {
    const res = new Response('{}', { status: 429, headers: { 'retry-after-ms': '20000' } });
    const d = retryDelayMs(res, 1);
    assert.ok(d >= 20000 && d <= 21000, `delay ${d} out of range`);
  });

  test('honors retry-after seconds header', () => {
    const res = new Response('{}', { status: 429, headers: { 'retry-after': '10' } });
    const d = retryDelayMs(res, 1);
    assert.ok(d >= 10000 && d <= 11000, `delay ${d} out of range`);
  });

  test('caps delays at 60s', () => {
    const res = new Response('{}', { status: 429, headers: { 'retry-after-ms': '600000' } });
    assert.ok(retryDelayMs(res, 1) <= 60000);
  });
});

describe('rateLimitHint', () => {
  test('summarizes rate-limit headers', () => {
    const res = new Response('{}', {
      status: 429,
      headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '12s' },
    });
    assert.equal(rateLimitHint(res), ' [ratelimit remaining=0 reset=12s]');
  });

  test('returns empty string when headers absent', () => {
    assert.equal(rateLimitHint(new Response('{}', { status: 429 })), '');
  });
});

describe('getProvider', () => {
  const orig = process.env.MODERATION_PROVIDER;

  afterEach(() => {
    if (orig === undefined) delete process.env.MODERATION_PROVIDER;
    else process.env.MODERATION_PROVIDER = orig;
  });

  beforeEach(() => {
    delete process.env.MODERATION_PROVIDER;
  });

  test('defaults to omni when unset', () => {
    assert.equal(getProvider(), 'omni');
  });

  test('selects nemotron on nemotron values (case-insensitive)', () => {
    process.env.MODERATION_PROVIDER = 'nemotron';
    assert.equal(getProvider(), 'nemotron');
    process.env.MODERATION_PROVIDER = 'Nemotron-3.5-CS';
    assert.equal(getProvider(), 'nemotron');
  });

  test('selects omni for omni values and anything else', () => {
    process.env.MODERATION_PROVIDER = 'omni-moderation';
    assert.equal(getProvider(), 'omni');
    process.env.MODERATION_PROVIDER = 'omni-moderation-latest';
    assert.equal(getProvider(), 'omni');
  });
});
