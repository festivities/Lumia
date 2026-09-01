import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export const DEFAULT_MAX_FILE_MB = 50;

export const PLAYER_EXT = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg',
  'ts', 'm2ts', 'mts', 'ogv', 'ogm', '3gp', '3g2', 'vob',
]);

export const IMAGE_EXT = new Set([
  'gif', 'png', 'apng', 'webp', 'avif', 'jpg', 'jpeg', 'jfif', 'heic', 'heif',
  'bmp', 'tiff',
]);

/**
 * Pre-download classification of an attachment or URL candidate.
 *
 * @param {{ contentType?: string | null, name?: string | null }} att
 * @param {{ channelMode: 'images' | 'images+videos', animationScope: 'all' | 'autoplay' }} gates
 * @returns {'player-video' | 'image' | null}
 */
export function classifyAttachment(att, gates = { channelMode: 'images+videos', animationScope: 'all' }) {
  if (!att) return null;

  const contentType = (att.contentType || '').toLowerCase().trim();
  const name = (att.name || '').toLowerCase().trim();

  let rawClass = null;

  if (contentType.startsWith('video/')) {
    rawClass = 'player-video';
  } else if (contentType.startsWith('image/')) {
    rawClass = 'image';
  } else {
    // Check file extension fallback
    const extMatch = name.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';

    if (PLAYER_EXT.has(ext)) {
      rawClass = 'player-video';
    } else if (IMAGE_EXT.has(ext)) {
      rawClass = 'image';
    } else {
      return null;
    }
  }

  // Apply gating matrix
  if (rawClass === 'player-video') {
    if (gates.channelMode === 'images+videos' && gates.animationScope === 'all') {
      return 'player-video';
    }
    return null;
  }

  if (rawClass === 'image') {
    return 'image';
  }

  return null;
}

/**
 * Pure JS synchronous sniffer for image formats and animation status.
 * Never throws on invalid or truncated data.
 *
 * @param {Buffer} buffer
 * @returns {{
 *   kind: 'gif' | 'png' | 'webp' | 'avif' | 'jpeg' | 'other',
 *   animated: boolean,
 *   frameCount: number | null
 * }}
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return { kind: 'other', animated: false, frameCount: null };
  }

  // 1. GIF Check (GIF87a or GIF89a)
  const headerStr = buffer.subarray(0, 6).toString('ascii');
  if (headerStr === 'GIF87a' || headerStr === 'GIF89a') {
    return sniffGif(buffer);
  }

  // 2. PNG / APNG Check
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return sniffPng(buffer);
  }

  // 3. WebP Check (RIFF....WEBP)
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.length >= 12 &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return sniffWebp(buffer);
  }

  // 4. AVIF / HEIF Check (ftyp at offset 4)
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return sniffAvif(buffer);
  }

  // 5. JPEG Check (FF D8 FF)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: 'jpeg', animated: false, frameCount: 1 };
  }

  return { kind: 'other', animated: false, frameCount: null };
}

function sniffGif(buf) {
  try {
    let offset = 6;
    if (buf.length < 13) {
      return { kind: 'gif', animated: false, frameCount: 1 };
    }

    const packed = buf[10];
    offset += 7; // Skip LSD (7 bytes)

    if (packed & 0x80) {
      const gctSize = 3 * (1 << ((packed & 0x07) + 1));
      offset += gctSize;
    }

    let frameCount = 0;
    while (offset < buf.length) {
      const blockType = buf[offset];
      if (blockType === 0x3b) {
        // Trailer
        break;
      }

      if (blockType === 0x21) {
        // Extension block
        offset += 2; // Skip 0x21 and label
        while (offset < buf.length) {
          const subLen = buf[offset++];
          if (subLen === 0) break;
          offset += subLen;
        }
      } else if (blockType === 0x2c) {
        // Image Descriptor
        frameCount++;
        if (offset + 10 > buf.length) break;
        const imgPacked = buf[offset + 9];
        offset += 10;
        if (imgPacked & 0x80) {
          const lctSize = 3 * (1 << ((imgPacked & 0x07) + 1));
          offset += lctSize;
        }
        offset += 1; // LZW min code size
        while (offset < buf.length) {
          const subLen = buf[offset++];
          if (subLen === 0) break;
          offset += subLen;
        }
      } else {
        offset++;
      }
    }

    return {
      kind: 'gif',
      animated: frameCount > 1,
      frameCount: frameCount > 0 ? frameCount : 1,
    };
  } catch {
    return { kind: 'gif', animated: false, frameCount: 1 };
  }
}

function sniffPng(buf) {
  try {
    let offset = 8;
    let animated = false;
    let frameCount = 1;

    while (offset + 8 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
      const dataOffset = offset + 8;

      if (type === 'acTL' && dataOffset + 4 <= buf.length) {
        animated = true;
        frameCount = buf.readUInt32BE(dataOffset);
        break;
      }

      if (type === 'IDAT' || type === 'IEND') {
        // If IDAT appears before acTL, it is not animated
        break;
      }

      offset += 12 + length; // 4 len + 4 type + data + 4 crc
    }

    return { kind: 'png', animated, frameCount: animated ? frameCount : 1 };
  } catch {
    return { kind: 'png', animated: false, frameCount: 1 };
  }
}

function sniffWebp(buf) {
  try {
    let offset = 12;
    let animated = false;
    let anmfCount = 0;

    while (offset + 8 <= buf.length) {
      const fourcc = buf.subarray(offset, offset + 4).toString('ascii');
      const size = buf.readUInt32LE(offset + 4);

      if (fourcc === 'ANIM') {
        animated = true;
      } else if (fourcc === 'ANMF') {
        anmfCount++;
      }

      // WebP chunks are padded to even length
      offset += 8 + size + (size % 2);
    }

    return {
      kind: 'webp',
      animated: animated || anmfCount > 1,
      frameCount: anmfCount > 0 ? anmfCount : (animated ? 2 : 1),
    };
  } catch {
    return { kind: 'webp', animated: false, frameCount: 1 };
  }
}

function sniffAvif(buf) {
  try {
    const ftypSize = buf.readUInt32BE(0);
    const majorBrand = buf.subarray(8, 12).toString('ascii');

    let isAnimated = majorBrand === 'avis';

    // Scan compatible brands
    let offset = 16;
    const end = Math.min(ftypSize, buf.length);
    while (offset + 4 <= end) {
      const brand = buf.subarray(offset, offset + 4).toString('ascii');
      if (brand === 'avis') {
        isAnimated = true;
        break;
      }
      offset += 4;
    }

    return {
      kind: 'avif',
      animated: isAnimated,
      frameCount: isAnimated ? null : 1,
    };
  } catch {
    return { kind: 'avif', animated: false, frameCount: 1 };
  }
}

/**
 * Normalizes still images into JPEG or passes through verified PNG/JPEG.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ buffer: Buffer, contentType: 'image/png' | 'image/jpeg' }>}
 */
export async function normalizeStillImage(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Expected Buffer for image normalization');
  }

  // Passthrough for PNG and JPEG
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { buffer, contentType: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { buffer, contentType: 'image/jpeg' };
  }

  // Transcode still webp/avif/heic/bmp to JPEG via single-threaded ffmpeg pipe
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-v', 'error',
      '-threads', '1',
      '-filter_threads', '1',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-q:v', '3',
      '-f', 'image2',
      '-c:v', 'mjpeg',
      'pipe:1',
    ]);

    const chunks = [];
    ffmpeg.stdout.on('data', (c) => chunks.push(c));

    let errOutput = '';
    ffmpeg.stderr.on('data', (d) => {
      errOutput += d.toString();
    });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: 'image/jpeg',
        });
      } else {
        reject(new Error(`Failed to normalize still image (exit ${code}): ${errOutput.slice(0, 200)}`));
      }
    });

    ffmpeg.stdin.write(buffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Adaptive sample frame count for player videos based on duration.
 *
 * @param {number} seconds
 * @returns {number | null}
 */
export function framesForDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds <= 2) return 4;
  if (seconds <= 5) return 5;
  if (seconds <= 10) return 6;
  if (seconds <= 20) return 8;
  if (seconds <= 60) return 10;
  return 12; // Hard cap
}

/**
 * Generates unique sample indices in range [0, totalFrames - 1].
 *
 * @param {number} totalFrames
 * @param {number} targetCount
 * @returns {number[]}
 */
export function calculateSampleIndices(totalFrames, targetCount) {
  if (totalFrames <= 0 || targetCount <= 0) return [];
  const count = Math.min(totalFrames, targetCount);
  const indices = [];
  for (let i = 0; i < count; i++) {
    indices.push(Math.floor((i * totalFrames) / count));
  }
  return [...new Set(indices)];
}

/**
 * Extracts sample frames from a video or animation file.
 *
 * @param {string} filePath Absolute path to file on disk
 * @param {{ classHint?: 'player-video' | 'autoplay-animation' }} [opts={}]
 * @returns {Promise<{ frames: { index: number, t: number | null, buffer: Buffer }[] }>}
 */
export async function extractFrames(filePath, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumia-extract-'));

  try {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const classHint = opts.classHint || (PLAYER_EXT.has(ext) ? 'player-video' : 'autoplay-animation');

    if (classHint === 'player-video' || ext === 'mp4' || ext === 'mov' || ext === 'webm' || ext === 'mkv') {
      return await extractPlayerVideoFrames(filePath, tmpDir);
    }

    if (ext === 'webp') {
      return await extractWebpFrames(filePath, tmpDir);
    }

    // Default for gif / apng / avif animations
    return await extractAnimationFrames(filePath, tmpDir);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.warn('[Video] Failed to clean up temp extract dir:', err.message);
    }
  }
}

async function extractPlayerVideoFrames(filePath, tmpDir) {
  // 1. Probe duration with ffprobe
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf-8' });

  const duration = parseFloat((probe.stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe could not determine video duration for ${filePath}`);
  }

  const sampleCount = framesForDuration(duration);
  const frames = [];

  for (let i = 0; i < sampleCount; i++) {
    const t = (i * duration) / sampleCount;
    const outPath = path.join(tmpDir, `frame_${i}.jpg`);

    const res = spawnSync('ffmpeg', [
      '-v', 'error',
      '-threads', '1',
      '-filter_threads', '1',
      '-ss', t.toFixed(3),
      '-i', filePath,
      '-frames:v', '1',
      '-q:v', '3',
      '-y', outPath,
    ]);

    if (res.status === 0 && fs.existsSync(outPath)) {
      const buffer = fs.readFileSync(outPath);
      frames.push({
        index: i,
        t: parseFloat(t.toFixed(2)),
        buffer,
      });
    }
  }

  if (frames.length === 0) {
    throw new Error('Failed to extract any frames from video');
  }

  return { frames };
}

async function extractAnimationFrames(filePath, tmpDir) {
  // 1. Count frames using ffprobe
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf-8' });

  let F = parseInt((probe.stdout || '').trim(), 10);
  if (!Number.isFinite(F) || F <= 0) {
    // Fallback probe
    const probe2 = spawnSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { encoding: 'utf-8' });
    F = parseInt((probe2.stdout || '').trim(), 10);
  }

  if (!Number.isFinite(F) || F <= 0) {
    // Fallback: extract up to 8 frames using fps or single pass
    F = 8;
  }

  const indices = calculateSampleIndices(F, Math.min(F, 8));
  const selectFilter = indices.map((idx) => `eq(n\\,${idx})`).join('+');

  const outPattern = path.join(tmpDir, 'frame_%03d.jpg');
  spawnSync('ffmpeg', [
    '-v', 'error',
    '-threads', '1',
    '-filter_threads', '1',
    '-i', filePath,
    '-vf', `select='${selectFilter}'`,
    '-vsync', 'vfr',
    '-q:v', '3',
    '-y', outPattern,
  ]);

  const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jpg')).sort();
  const frames = [];

  for (let i = 0; i < files.length; i++) {
    const fPath = path.join(tmpDir, files[i]);
    const buffer = fs.readFileSync(fPath);
    frames.push({
      index: indices[i] ?? i,
      t: null,
      buffer,
    });
  }

  if (frames.length === 0) {
    // Final fallback: single frame extract
    const singleOut = path.join(tmpDir, 'single.jpg');
    spawnSync('ffmpeg', [
      '-v', 'error',
      '-threads', '1',
      '-filter_threads', '1',
      '-i', filePath,
      '-frames:v', '1',
      '-q:v', '3',
      '-y', singleOut,
    ]);
    if (fs.existsSync(singleOut)) {
      frames.push({
        index: 0,
        t: null,
        buffer: fs.readFileSync(singleOut),
      });
    }
  }

  if (frames.length === 0) {
    throw new Error('Failed to extract animation frames from file');
  }

  return { frames };
}

async function extractWebpFrames(filePath, tmpDir) {
  // Extract up to 6 frames using webpmux if available
  const frames = [];

  for (let i = 1; i <= 6; i++) {
    const outWebp = path.join(tmpDir, `frame_${i}.webp`);
    const res = spawnSync('webpmux', ['-get', 'frame', String(i), filePath, '-o', outWebp]);

    if (res.status === 0 && fs.existsSync(outWebp)) {
      try {
        const webpBuf = fs.readFileSync(outWebp);
        const norm = await normalizeStillImage(webpBuf);
        frames.push({
          index: i - 1,
          t: null,
          buffer: norm.buffer,
        });
      } catch {
        break;
      }
    } else {
      break;
    }
  }

  if (frames.length === 0) {
    // Fallback: extract with ffmpeg animation path
    return extractAnimationFrames(filePath, tmpDir);
  }

  return { frames };
}
