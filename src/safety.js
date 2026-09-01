import fs from 'node:fs';
import path from 'node:path';
import { parseVerdict } from './parse.js';
import { extractFrames } from './video.js';

const NEMOTRON_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const STATUS_API_BASE = 'https://integrate.api.nvidia.com/v1/status';
const FIXED_PROMPT = 'Check this image for content safety.';
const MODEL_NAME = 'nvidia/nemotron-3.5-content-safety';

const MAX_QUEUE_SIZE = 50;
const RETRY_DELAYS = [5000, 15000, 45000]; // Delays before retry attempts
const PER_REQUEST_TIMEOUT_MS = 30000;
const IMAGE_JOB_TIMEOUT_MS = 90000;
const VIDEO_JOB_TIMEOUT_MS = 300000;
const MIN_CALL_INTERVAL_MS = 1600; // Throttle ceiling ~37.5 calls/min

let lastCallAt = 0;

class SafetyQueue {
  constructor() {
    this._queue = [];
    this._processing = false;
  }

  get pendingCount() {
    return this._queue.length;
  }

  /**
   * Enqueues an image screening request.
   *
   * @param {Buffer} imageBuffer
   * @param {string} [contentType='image/png']
   * @returns {Promise<{ safe: boolean, categories: string[] }>}
   */
  enqueueImage(imageBuffer, contentType = 'image/png') {
    if (!Buffer.isBuffer(imageBuffer)) {
      return Promise.reject(new Error('Invalid argument to enqueueImage: expected Buffer'));
    }

    if (this._queue.length >= MAX_QUEUE_SIZE) {
      const err = new Error(`Queue overflow: max pending limit (${MAX_QUEUE_SIZE}) reached`);
      console.warn(`[Safety] ${err.message}. Dropping request and failing open.`);
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const item = {
        type: 'image',
        imageBuffer,
        contentType,
        timeoutMs: IMAGE_JOB_TIMEOUT_MS,
        resolve,
        reject,
      };

      this._queue.push(item);
      this._processNext();
    });
  }

  /**
   * Enqueues a video / animation screening request.
   *
   * @param {string} filePath Absolute path to video/animation on disk
   * @param {'player-video' | 'autoplay-animation'} [classHint='player-video']
   * @returns {Promise<{
   *   safe: boolean,
   *   categories: string[],
   *   framesTotal: number,
   *   framesScreened: number,
   *   flaggedAt: string | null,
   *   flaggedFrameBuffer: Buffer | null,
   *   sampleSummary: string
   * }>}
   */
  enqueueVideo(filePath, classHint = 'player-video') {
    if (typeof filePath !== 'string' || !filePath) {
      return Promise.reject(new Error('Invalid argument to enqueueVideo: expected filePath string'));
    }

    if (this._queue.length >= MAX_QUEUE_SIZE) {
      const err = new Error(`Queue overflow: max pending limit (${MAX_QUEUE_SIZE}) reached`);
      console.warn(`[Safety] ${err.message}. Dropping request and failing open.`);
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const item = {
        type: 'video',
        filePath,
        classHint,
        timeoutMs: VIDEO_JOB_TIMEOUT_MS,
        resolve,
        reject,
      };

      this._queue.push(item);
      this._processNext();
    });
  }

  async _processNext() {
    if (this._processing || this._queue.length === 0) return;

    this._processing = true;
    const item = this._queue.shift();

    const jobAbortController = new AbortController();
    const timer = setTimeout(() => {
      jobAbortController.abort(new Error(`Screening job exceeded timeout (${item.timeoutMs}ms)`));
    }, item.timeoutMs);

    try {
      if (item.type === 'image') {
        const result = await evaluateImage(item.imageBuffer, item.contentType, jobAbortController.signal);
        clearTimeout(timer);
        item.resolve(result);
      } else if (item.type === 'video') {
        const result = await this._processVideoJob(item.filePath, item.classHint, jobAbortController.signal);
        clearTimeout(timer);
        item.resolve(result);
      }
    } catch (err) {
      clearTimeout(timer);
      item.reject(err);
    } finally {
      this._processing = false;
      this._processNext();
    }
  }

  async _processVideoJob(filePath, classHint, jobSignal) {
    try {
      const { frames } = await extractFrames(filePath, { classHint });
      if (!frames || frames.length === 0) {
        throw new Error('Frame extraction returned 0 frames');
      }

      let safe = true;
      const categoriesSet = new Set();
      let flaggedAt = null;
      let flaggedFrameBuffer = null;
      let framesScreened = 0;

      const sampleSummary = frames
        .map((f) => (f.t !== null ? `t=${f.t}s` : `frame ${f.index + 1}`))
        .join(', ');

      const isVerbose = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1' || process.env.DEBUG === 'true';
      if (isVerbose) {
        console.log(`[Safety] Video screening (${classHint}): extracted ${frames.length} frame(s) from ${path.basename(filePath)}.`);
      }

      for (const frame of frames) {
        if (jobSignal?.aborted) {
          throw jobSignal.reason || new Error('Video screening job aborted');
        }

        framesScreened++;
        if (isVerbose) {
          console.log(`[Safety] Evaluating frame ${framesScreened}/${frames.length} (${frame.t !== null ? `t=${frame.t}s` : `frame ${frame.index + 1}`})...`);
        }
        const verdict = await evaluateImage(frame.buffer, 'image/jpeg', jobSignal);

        if (!verdict.safe) {
          safe = false;
          for (const cat of verdict.categories) {
            categoriesSet.add(cat);
          }
          flaggedAt = frame.t !== null ? `t=${frame.t}s (frame ${frame.index + 1})` : `frame ${frame.index + 1}`;
          flaggedFrameBuffer = frame.buffer;
          // Short-circuit on first unsafe frame to conserve quota
          break;
        }
      }

      return {
        safe,
        categories: [...categoriesSet],
        framesTotal: frames.length,
        framesScreened,
        flaggedAt,
        flaggedFrameBuffer,
        sampleSummary,
      };
    } finally {
      // Clean up temporary video file if it was created in temp
      try {
        if (fs.existsSync(filePath) && filePath.includes('lumia-')) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.warn('[Safety] Failed to delete temp video file:', err.message);
      }
    }
  }
}

/**
 * Sends image data to NVIDIA Nemotron API with retries, rate limiting, and 202 async polling.
 *
 * @param {Buffer} imageBuffer
 * @param {string} contentType
 * @param {AbortSignal} jobSignal
 * @returns {Promise<{ safe: boolean, categories: string[] }>}
 */
export async function evaluateImage(imageBuffer, contentType = 'image/png', jobSignal = null) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error('NVIDIA_API_KEY environment variable is not set');
  }

  const base64Data = imageBuffer.toString('base64');
  const dataUri = `data:${contentType};base64,${base64Data}`;

  const requestBody = {
    model: MODEL_NAME,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUri } },
          { type: 'text', text: FIXED_PROMPT },
        ],
      },
    ],
    max_tokens: 200,
    temperature: 0.01,
    top_p: 0.95,
    stream: false,
    chat_template_kwargs: { request_categories: '/categories' },
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  let lastError = null;
  const maxAttempts = RETRY_DELAYS.length + 1; // 1 initial + 3 retries = 4 total attempts

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (jobSignal?.aborted) {
      throw jobSignal.reason || new Error('Job aborted before attempt');
    }

    // Rate limiter: enforce 1.6s minimum interval between API calls
    const now = Date.now();
    const waitTime = Math.max(0, MIN_CALL_INTERVAL_MS - (now - lastCallAt));
    if (waitTime > 0) {
      await sleep(waitTime, jobSignal);
    }
    lastCallAt = Date.now();

    try {
      const requestSignal = AbortSignal.any
        ? AbortSignal.any([AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS), ...(jobSignal ? [jobSignal] : [])])
        : AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS);

      const response = await fetch(NEMOTRON_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: requestSignal,
      });

      if (response.status === 200) {
        const json = await response.json();
        const content = json?.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('Response JSON missing choices[0].message.content');
        }
        const verdict = parseVerdict(content);
        const isVerbose = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1' || process.env.DEBUG === 'true';
        if (isVerbose) {
          console.log(`[Safety] Nemotron API response: ${verdict.safe ? 'SAFE' : 'UNSAFE'}${verdict.categories.length > 0 ? ` (${verdict.categories.join(', ')})` : ''}`);
        }
        return verdict;
      }

      if (response.status === 202) {
        // Async polling mode
        const json = await response.json().catch(() => ({}));
        const reqId = json.reqId || json.id || json.requestId || response.headers.get('nvcf-reqid');
        if (!reqId) {
          throw new Error('Received 202 Accepted but no request ID could be extracted');
        }
        return await pollStatus(reqId, apiKey, jobSignal);
      }

      const bodyText = await response.text().catch(() => '');
      const bodySnippet = bodyText.slice(0, 200);

      // Flakiness: 403 Forbidden / 429 Rate limit / 5xx Server errors
      const isRetryable = response.status === 403 || response.status === 429 || (response.status >= 500 && response.status < 600);
      const errorMsg = `HTTP ${response.status}: ${bodySnippet}`;

      if (isRetryable && attempt <= RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt - 1];
        console.warn(`[Safety] Attempt ${attempt} failed with ${errorMsg}. Retrying in ${delay}ms...`);
        await sleep(delay, jobSignal);
        continue;
      }

      throw new Error(`Nemotron API error: ${errorMsg}`);
    } catch (err) {
      lastError = err;
      if (jobSignal?.aborted) {
        throw jobSignal.reason || err;
      }

      const isNetworkError = err.name === 'TypeError' || err.name === 'FetchError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (isNetworkError && attempt <= RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt - 1];
        console.warn(`[Safety] Attempt ${attempt} encountered network error: ${err.message}. Retrying in ${delay}ms...`);
        await sleep(delay, jobSignal);
        continue;
      }

      if (attempt > RETRY_DELAYS.length || !isNetworkError) {
        throw err;
      }
    }
  }

  throw lastError || new Error('Nemotron screening failed after all retries');
}

/**
 * Polls status endpoint for HTTP 202 responses until completion or timeout.
 *
 * @param {string} reqId
 * @param {string} apiKey
 * @param {AbortSignal} jobSignal
 * @returns {Promise<{ safe: boolean, categories: string[] }>}
 */
async function pollStatus(reqId, apiKey, jobSignal) {
  const statusUrl = `${STATUS_API_BASE}/${reqId}`;
  const maxPollSeconds = 60;
  const pollIntervalMs = 1000;

  for (let i = 0; i < maxPollSeconds; i++) {
    if (jobSignal?.aborted) {
      throw jobSignal.reason || new Error('Job aborted during polling');
    }

    await sleep(pollIntervalMs, jobSignal);

    const pollSignal = AbortSignal.any
      ? AbortSignal.any([AbortSignal.timeout(10000), ...(jobSignal ? [jobSignal] : [])])
      : AbortSignal.timeout(10000);

    const res = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: pollSignal,
    });

    if (res.status === 200) {
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Status polling completed but response missing message content');
      }
      const verdict = parseVerdict(content);
      const isVerbose = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1' || process.env.DEBUG === 'true';
      if (isVerbose) {
        console.log(`[Safety] Nemotron async status response: ${verdict.safe ? 'SAFE' : 'UNSAFE'}${verdict.categories.length > 0 ? ` (${verdict.categories.join(', ')})` : ''}`);
      }
      return verdict;
    }

    if (res.status === 202) {
      continue;
    }

    const errText = await res.text().catch(() => '');
    throw new Error(`Status polling returned unexpected HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  throw new Error(`Polling status timed out after ${maxPollSeconds}s for request ${reqId}`);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason || new Error('Aborted during sleep'));
    }

    const timeout = setTimeout(() => {
      resolve();
    }, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timeout);
        reject(signal.reason || new Error('Aborted during sleep'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export const safetyQueue = new SafetyQueue();
export function enqueueImage(buffer, contentType) {
  return safetyQueue.enqueueImage(buffer, contentType);
}
export function enqueueVideo(filePath, classHint) {
  return safetyQueue.enqueueVideo(filePath, classHint);
}

// Backward compatibility alias for enqueue
export function enqueue(arg1, arg2) {
  return safetyQueue.enqueueImage(arg1, arg2);
}

export default {
  enqueue,
  enqueueImage,
  enqueueVideo,
  evaluateImage,
  safetyQueue,
};
