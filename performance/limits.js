// Single source of the performance safety ceilings. Plain ES module with no
// Node or k6 imports, so both the Node runner and the k6 workload import it.

/**
 * @typedef {{ maxVus: number, maxRatePerSecond: number, maxDurationSeconds: number,
 *   maxRequestTimeoutMilliseconds: number, maxRequestCount: number }} HardLimits
 * @typedef {{ vus: number, ratePerSecond: number, durationSeconds: number,
 *   requestTimeoutMilliseconds: number, maxRequests: number }} Workload
 */

/** Ceilings that versioned configuration may lower but never raise. @type {Readonly<HardLimits>} */
export const absoluteLimits = Object.freeze({
  maxVus: 2,
  maxRatePerSecond: 2,
  maxDurationSeconds: 10,
  maxRequestTimeoutMilliseconds: 1000,
  maxRequestCount: 20,
});

/**
 * The Dev profile adds one login and one logout request around the workload.
 * @param {string} profileName
 * @returns {number}
 */
export function lifecycleRequestCount(profileName) {
  return profileName === "dev" ? 2 : 0;
}

/**
 * True when every configured hard limit is a positive integer within its absolute ceiling.
 * @param {unknown} limits untrusted configuration
 * @returns {limits is HardLimits}
 */
export function hardLimitsWithinCeilings(limits) {
  if (limits === null || typeof limits !== "object") return false;
  const configured = /** @type {Record<string, unknown>} */ (limits);
  return Object.entries(absoluteLimits).every(([name, maximum]) => {
    const value = configured[name];
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= maximum
    );
  });
}

/**
 * True when a workload, plus its lifecycle requests, stays inside the configured hard limits.
 * @param {unknown} workload untrusted configuration
 * @param {HardLimits} limits limits already checked by hardLimitsWithinCeilings
 * @param {number} [lifecycleRequests]
 * @returns {workload is Workload}
 */
export function workloadWithinLimits(workload, limits, lifecycleRequests = 0) {
  if (workload === null || typeof workload !== "object") return false;
  const {
    vus,
    ratePerSecond,
    durationSeconds,
    requestTimeoutMilliseconds,
    maxRequests,
  } = /** @type {Partial<Record<keyof Workload, unknown>>} */ (workload);
  const positive = (/** @type {unknown} */ value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0;
  if (
    !positive(vus) ||
    !positive(ratePerSecond) ||
    !positive(durationSeconds) ||
    !positive(requestTimeoutMilliseconds) ||
    !positive(maxRequests)
  ) {
    return false;
  }
  const w = /** @type {Workload} */ (workload);
  const totalRequests = w.ratePerSecond * w.durationSeconds + lifecycleRequests;
  return (
    w.vus <= limits.maxVus &&
    w.ratePerSecond <= limits.maxRatePerSecond &&
    w.durationSeconds <= limits.maxDurationSeconds &&
    w.requestTimeoutMilliseconds <= limits.maxRequestTimeoutMilliseconds &&
    totalRequests <= limits.maxRequestCount &&
    totalRequests <= w.maxRequests &&
    w.maxRequests <= limits.maxRequestCount
  );
}
