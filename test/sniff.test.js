import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sniffImage } from '../src/video.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('sniffImage', () => {
  test('returns other for null, empty, or garbage buffers without throwing', () => {
    assert.deepEqual(sniffImage(null), { kind: 'other', animated: false, frameCount: null });
    assert.deepEqual(sniffImage(Buffer.alloc(0)), { kind: 'other', animated: false, frameCount: null });
    assert.deepEqual(sniffImage(Buffer.from('garbage data here')), { kind: 'other', animated: false, frameCount: null });
  });

  test('detects JPEG images as static', () => {
    const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const res = sniffImage(jpegBuf);
    assert.deepEqual(res, { kind: 'jpeg', animated: false, frameCount: 1 });
  });

  test('detects still PNG vs APNG from fixtures', () => {
    if (fs.existsSync(path.join(FIXTURES_DIR, 'sample.apng'))) {
      const apngBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.apng'));
      const res = sniffImage(apngBuf);
      assert.equal(res.kind, 'png');
      assert.equal(res.animated, true);
      assert.ok(res.frameCount > 1);
    }
  });

  test('detects animated GIF from fixtures', () => {
    if (fs.existsSync(path.join(FIXTURES_DIR, 'sample.gif'))) {
      const gifBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.gif'));
      const res = sniffImage(gifBuf);
      assert.equal(res.kind, 'gif');
      assert.equal(res.animated, true);
      assert.ok(res.frameCount > 1);
    }
  });

  test('detects animated WebP from fixtures', () => {
    if (fs.existsSync(path.join(FIXTURES_DIR, 'sample.webp'))) {
      const webpBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.webp'));
      const res = sniffImage(webpBuf);
      assert.equal(res.kind, 'webp');
      assert.equal(res.animated, true);
    }
  });

  test('detects still WebP from fixtures', () => {
    if (fs.existsSync(path.join(FIXTURES_DIR, 'sample_still.webp'))) {
      const webpBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample_still.webp'));
      const res = sniffImage(webpBuf);
      assert.equal(res.kind, 'webp');
      assert.equal(res.animated, false);
    }
  });

  test('detects AVIF from fixtures', () => {
    if (fs.existsSync(path.join(FIXTURES_DIR, 'sample.avif'))) {
      const avifBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.avif'));
      const res = sniffImage(avifBuf);
      assert.equal(res.kind, 'avif');
    }
  });
});
