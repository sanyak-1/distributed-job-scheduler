// ============================================================================
// lib/backoff.js — exponential backoff with jitter
// ============================================================================

const BASE_DELAY_MS = 1000; // 1s
const MAX_DELAY_MS = 5 * 60 * 1000; // cap at 5 minutes

/**
 * Computes the next retry timestamp using full-jitter exponential backoff:
 *   delay = random(0, min(MAX_DELAY_MS, BASE_DELAY_MS * 2^retryCount))
 *
 * @param {number} retryCount - number of attempts already made (0-indexed)
 * @returns {Date} the timestamp at which the job should next become eligible
 */
function computeNextRetryAt(retryCount) {
  const cappedExponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retryCount);
  const jitteredDelay = Math.floor(Math.random() * cappedExponential);
  return new Date(Date.now() + jitteredDelay);
}

module.exports = { computeNextRetryAt, BASE_DELAY_MS, MAX_DELAY_MS };