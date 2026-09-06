import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseOmniResult } from '../src/parse.js';
import { getProvider } from '../src/safety.js';

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
