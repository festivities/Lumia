const MIN_TIMEOUT_MS = 1000; // 1 second
const MAX_TIMEOUT_MS = 2419200000; // 28 days (Discord max timeout)

const UNIT_MULTIPLIERS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parses the safety verdict returned by the Nemotron content safety model.
 * Matches `User Safety:\s*(safe|unsafe)` and `Safety Categories:\s*(.+)`.
 *
 * @param {string} content
 * @returns {{ safe: boolean, categories: string[] }}
 * @throws {Error} If the content is not a string or User Safety line is missing
 */
export function parseVerdict(content) {
  if (typeof content !== 'string') {
    throw new Error('Verdict content must be a string');
  }

  const userSafetyMatch = content.match(/User Safety:\s*(safe|unsafe)/i);
  if (!userSafetyMatch) {
    throw new Error('Missing or unparseable "User Safety" line in verdict response');
  }

  const isSafe = userSafetyMatch[1].toLowerCase() === 'safe';
  if (isSafe) {
    return {
      safe: true,
      categories: [],
    };
  }

  const categoriesMatch = content.match(/Safety Categories:\s*([^\r\n]+)/i);
  let categories = [];
  if (categoriesMatch && categoriesMatch[1]) {
    categories = categoriesMatch[1]
      .split(',')
      .map((cat) => cat.trim())
      .filter((cat) => cat.length > 0);
  }

  return {
    safe: false,
    categories,
  };
}

/**
 * Parses a duration string into milliseconds.
 * Accepts formats like "10m", "1h30m", "2d", "45s", "1d12h".
 * Clamps the output between 1,000ms (1s) and 2,419,200,000ms (28d).
 *
 * @param {string} str
 * @returns {number | null} Duration in ms, or null if invalid / zero
 */
export function parseDuration(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed) return null;

  // Verify the entire string consists only of valid <number><unit> pairs (ignoring whitespace between pairs)
  const fullMatchRegex = /^(?:\s*\d+(?:\.\d+)?\s*[smhd]\s*)+$/i;
  if (!fullMatchRegex.test(trimmed)) {
    return null;
  }

  let totalMs = 0;
  const unitRegex = /(\d+(?:\.\d+)?)\s*([smhd])/gi;
  let match;

  while ((match = unitRegex.exec(trimmed)) !== null) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = UNIT_MULTIPLIERS[unit];
    if (multiplier && !Number.isNaN(value)) {
      totalMs += value * multiplier;
    }
  }

  if (totalMs <= 0 || !Number.isFinite(totalMs)) {
    return null;
  }

  // Clamp to [1000, 2419200000]
  return Math.min(Math.max(Math.round(totalMs), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * Helper to format milliseconds into human-readable duration (e.g. "1h 30m").
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remSeconds = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remSeconds > 0 || parts.length === 0) parts.push(`${remSeconds}s`);

  return parts.join(' ');
}
