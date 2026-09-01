import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { framesForDuration, calculateSampleIndices } from '../src/video.js';

describe('framesForDuration', () => {
  test('returns correct sample frame count for various durations', () => {
    assert.equal(framesForDuration(0.5), 4);
    assert.equal(framesForDuration(2), 4);
    assert.equal(framesForDuration(3), 5);
    assert.equal(framesForDuration(5), 5);
    assert.equal(framesForDuration(8), 6);
    assert.equal(framesForDuration(10), 6);
    assert.equal(framesForDuration(15), 8);
    assert.equal(framesForDuration(20), 8);
    assert.equal(framesForDuration(45), 10);
    assert.equal(framesForDuration(60), 10);
    assert.equal(framesForDuration(120), 12);
    assert.equal(framesForDuration(600), 12);
  });

  test('returns null for zero, negative, or invalid durations', () => {
    assert.equal(framesForDuration(0), null);
    assert.equal(framesForDuration(-5), null);
    assert.equal(framesForDuration(NaN), null);
    assert.equal(framesForDuration(Infinity), null);
    assert.equal(framesForDuration(null), null);
  });
});

describe('calculateSampleIndices', () => {
  test('returns uniform and deduplicated indices', () => {
    // When total frames F < target N: returns F indices without duplicates
    const res1 = calculateSampleIndices(5, 8);
    assert.deepEqual(res1, [0, 1, 2, 3, 4]);

    // When total frames F >= target N: returns N unique uniform indices
    const res2 = calculateSampleIndices(100, 8);
    assert.equal(res2.length, 8);
    assert.deepEqual(res2, [0, 12, 25, 37, 50, 62, 75, 87]);

    // Zero or negative input
    assert.deepEqual(calculateSampleIndices(0, 8), []);
    assert.deepEqual(calculateSampleIndices(10, 0), []);
  });
});
