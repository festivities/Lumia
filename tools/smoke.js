import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateImage } from '../src/safety.js';
import { extractFrames } from '../src/video.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures');

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const imageBuffer = Buffer.from(TINY_PNG_BASE64, 'base64');

console.log('[Smoke Test] 1/2: Testing Nemotron-3.5 Content Safety API validation with test image...');

if (!process.env.NVIDIA_API_KEY) {
  console.error('[Smoke Test] ERROR: NVIDIA_API_KEY is not set in environment or .env');
  process.exit(1);
}

try {
  const verdict = await evaluateImage(imageBuffer, 'image/png');
  console.log('[Smoke Test] SUCCESS! Image verdict received:', JSON.stringify(verdict, null, 2));
} catch (err) {
  console.error('[Smoke Test] Image evaluation failed:', err.message);
  process.exit(1);
}

console.log('[Smoke Test] 2/2: Testing video frame extraction and screening with sample.mp4...');

const sampleMp4 = path.join(FIXTURES_DIR, 'sample.mp4');
if (fs.existsSync(sampleMp4)) {
  try {
    const { frames } = await extractFrames(sampleMp4, { classHint: 'player-video' });
    console.log(`[Smoke Test] Extracted ${frames.length} frames from sample.mp4.`);
    if (frames.length === 0) {
      throw new Error('0 frames extracted from sample.mp4');
    }

    const videoVerdict = await evaluateImage(frames[0].buffer, 'image/jpeg');
    console.log('[Smoke Test] SUCCESS! First video frame verdict received:', JSON.stringify(videoVerdict, null, 2));
  } catch (err) {
    console.error('[Smoke Test] Video smoke test failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('[Smoke Test] sample.mp4 fixture not found, skipping video frame test.');
}

console.log('[Smoke Test] ALL SMOKE TESTS PASSED!');
process.exitCode = 0;
