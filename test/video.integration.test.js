import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFrames, normalizeStillImage, MAX_STILL_PASSTHROUGH_BYTES } from '../src/video.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('video integration extraction', () => {
  test('extracts frames from sample.mp4', async () => {
    const mp4Path = path.join(FIXTURES_DIR, 'sample.mp4');
    if (!fs.existsSync(mp4Path)) return;

    const result = await extractFrames(mp4Path, { classHint: 'player-video' });
    assert.ok(result.frames.length >= 4);
    for (const frame of result.frames) {
      assert.ok(Number.isFinite(frame.t));
      assert.ok(frame.buffer.length > 0);
      // JPEG magic bytes
      assert.equal(frame.buffer[0], 0xff);
      assert.equal(frame.buffer[1], 0xd8);
    }
  });

  test('extracts frames from sample.gif', async () => {
    const gifPath = path.join(FIXTURES_DIR, 'sample.gif');
    if (!fs.existsSync(gifPath)) return;

    const result = await extractFrames(gifPath, { classHint: 'autoplay-animation' });
    assert.ok(result.frames.length > 0);
    for (const frame of result.frames) {
      assert.equal(frame.t, null);
      assert.ok(frame.buffer.length > 0);
      assert.equal(frame.buffer[0], 0xff);
      assert.equal(frame.buffer[1], 0xd8);
    }
  });

  test('extracts frames from sample.apng', async () => {
    const apngPath = path.join(FIXTURES_DIR, 'sample.apng');
    if (!fs.existsSync(apngPath)) return;

    const result = await extractFrames(apngPath, { classHint: 'autoplay-animation' });
    assert.ok(result.frames.length > 0);
    for (const frame of result.frames) {
      assert.ok(frame.buffer.length > 0);
      assert.equal(frame.buffer[0], 0xff);
      assert.equal(frame.buffer[1], 0xd8);
    }
  });

  test('normalizes still webp to jpeg', async () => {
    const webpPath = path.join(FIXTURES_DIR, 'sample_still.webp');
    if (!fs.existsSync(webpPath)) return;

    const buf = fs.readFileSync(webpPath);
    const norm = await normalizeStillImage(buf);

    assert.equal(norm.contentType, 'image/jpeg');
    assert.equal(norm.buffer[0], 0xff);
    assert.equal(norm.buffer[1], 0xd8);
  });

  test('passes through small PNG without transcoding', async () => {
    const pngPath = path.join(FIXTURES_DIR, 'sample_still.png');
    if (!fs.existsSync(pngPath)) return;

    const buf = fs.readFileSync(pngPath);
    const norm = await normalizeStillImage(buf);

    assert.equal(norm.contentType, 'image/png');
    assert.equal(norm.buffer, buf);
  });

  test('transcodes PNG to JPEG when force is true', async () => {
    const pngPath = path.join(FIXTURES_DIR, 'sample_still.png');
    if (!fs.existsSync(pngPath)) return;

    const buf = fs.readFileSync(pngPath);
    const norm = await normalizeStillImage(buf, { force: true });

    assert.equal(norm.contentType, 'image/jpeg');
    assert.equal(norm.buffer[0], 0xff);
    assert.equal(norm.buffer[1], 0xd8);
  });

  test('transcodes PNG to JPEG when buffer exceeds MAX_STILL_PASSTHROUGH_BYTES', async () => {
    assert.equal(MAX_STILL_PASSTHROUGH_BYTES, 10 * 1024 * 1024);

    const pngPath = path.join(FIXTURES_DIR, 'sample_still.png');
    if (!fs.existsSync(pngPath)) return;

    const baseBuf = fs.readFileSync(pngPath);
    const largeBuf = Buffer.concat([baseBuf, Buffer.alloc(MAX_STILL_PASSTHROUGH_BYTES)]);
    const norm = await normalizeStillImage(largeBuf);

    assert.equal(norm.contentType, 'image/jpeg');
    assert.equal(norm.buffer[0], 0xff);
    assert.equal(norm.buffer[1], 0xd8);
  });
});
