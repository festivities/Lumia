import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, parseDuration, formatDuration } from '../src/parse.js';

describe('parseVerdict', () => {
  test('parses safe verdict', () => {
    const fixture = 'User Safety: safe';
    const result = parseVerdict(fixture);
    assert.deepEqual(result, {
      safe: true,
      categories: [],
    });
  });

  test('parses safe verdict case-insensitively with surrounding whitespace', () => {
    const fixture = '  User Safety: Safe  \n';
    const result = parseVerdict(fixture);
    assert.deepEqual(result, {
      safe: true,
      categories: [],
    });
  });

  test('parses unsafe verdict with single category (real fixture)', () => {
    const fixture = 'User Safety: unsafe\nSafety Categories: Criminal Planning/Confessions';
    const result = parseVerdict(fixture);
    assert.deepEqual(result, {
      safe: false,
      categories: ['Criminal Planning/Confessions'],
    });
  });

  test('parses unsafe verdict with multiple categories', () => {
    const fixture = 'User Safety: unsafe\nSafety Categories: Sexual Content, Violence, Hate Speech';
    const result = parseVerdict(fixture);
    assert.deepEqual(result, {
      safe: false,
      categories: ['Sexual Content', 'Violence', 'Hate Speech'],
    });
  });

  test('handles extra lines such as Response Safety gracefully', () => {
    const fixture = 'User Safety: unsafe\nSafety Categories: Sexual/Sexually Explicit\nResponse Safety: safe';
    const result = parseVerdict(fixture);
    assert.deepEqual(result, {
      safe: false,
      categories: ['Sexual/Sexually Explicit'],
    });
  });

  test('throws on unparseable / missing User Safety line', () => {
    assert.throws(() => parseVerdict('Something random without user safety'), /Missing or unparseable/);
    assert.throws(() => parseVerdict(''), /Missing or unparseable/);
    assert.throws(() => parseVerdict(null), /must be a string/);
    assert.throws(() => parseVerdict(undefined), /must be a string/);
  });
});

describe('parseDuration', () => {
  test('parses standard single-unit durations', () => {
    assert.equal(parseDuration('45s'), 45 * 1000);
    assert.equal(parseDuration('10m'), 10 * 60 * 1000);
    assert.equal(parseDuration('2d'), 2 * 24 * 60 * 60 * 1000);
  });

  test('parses combined unit sequences', () => {
    assert.equal(parseDuration('1h30m'), (1 * 60 + 30) * 60 * 1000);
    assert.equal(parseDuration('1d12h'), (1 * 24 + 12) * 60 * 60 * 1000);
    assert.equal(parseDuration('1d 2h 30m 10s'), ((1 * 24 + 2) * 3600 + 30 * 60 + 10) * 1000);
  });

  test('handles garbage input and empty strings', () => {
    assert.equal(parseDuration('abc'), null);
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration('   '), null);
    assert.equal(parseDuration('10x'), null);
    assert.equal(parseDuration('invalid10m'), null);
    assert.equal(parseDuration('10m garbage'), null);
    assert.equal(parseDuration(null), null);
    assert.equal(parseDuration(undefined), null);
  });

  test('handles zero and negative durations', () => {
    assert.equal(parseDuration('0s'), null);
    assert.equal(parseDuration('0m'), null);
    assert.equal(parseDuration('0h'), null);
  });

  test('clamps duration at lower and upper bounds', () => {
    // Clamping lower bound: 1000ms minimum
    // Note: '500ms' does not match s/m/h/d regex so it returns null
    // But '0.5s' = 500ms -> clamped to 1000ms
    assert.equal(parseDuration('0.5s'), 1000);

    // Clamping upper bound: 28 days (2419200000ms)
    // 30 days = 2,592,000,000ms -> clamped to 2,419,200,000ms
    assert.equal(parseDuration('30d'), 2419200000);
    assert.equal(parseDuration('100d'), 2419200000);
  });
});

describe('formatDuration', () => {
  test('formats milliseconds into readable string', () => {
    assert.equal(formatDuration(45000), '45s');
    assert.equal(formatDuration(600000), '10m');
    assert.equal(formatDuration(5400000), '1h 30m');
    assert.equal(formatDuration(129600000), '1d 12h');
  });
});
