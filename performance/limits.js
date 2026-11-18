// Single source of the performance safety ceilings. Plain ES module with no
// Node or k6 imports, so both the Node runner and the k6 workload import it.

/** Ceilings that versioned configuration may lower but never raise. */
export const absoluteLimits = Object.freeze({
  maxVus: 2,
  maxRatePerSecond: 2,
  maxDurationSeconds: 10,
  maxRequestTimeoutMilliseconds: 1000,
  maxRequestCount: 20,
});

/** The Dev profile adds one login and one logout request around the workload. */
export function lifecycleRequestCount(profileName) {
  return profileName === 'dev' ? 2 : 0;
}

/** True when every configured hard limit is a positive integer within its absolute ceiling. */
export function hardLimitsWithinCeilings(limits) {
  return Object.entries(absoluteLimits).every(
    ([name, maximum]) => Number.isInteger(limits?.[name]) && limits[name] >= 1 && limits[name] <= maximum,
  );
}

/** True when a workload, plus its lifecycle requests, stays inside the configured hard limits. */
export function workloadWithinLimits(workload, limits, lifecycleRequests = 0) {
  const { vus, ratePerSecond, durationSeconds, requestTimeoutMilliseconds, maxRequests } = workload ?? {};
  if (![vus, ratePerSecond, durationSeconds, requestTimeoutMilliseconds, maxRequests].every((value) => Number.isInteger(value) && value > 0)) {
    return false;
  }
  const totalRequests = ratePerSecond * durationSeconds + lifecycleRequests;
  return (
    vus <= limits.maxVus &&
    ratePerSecond <= limits.maxRatePerSecond &&
    durationSeconds <= limits.maxDurationSeconds &&
    requestTimeoutMilliseconds <= limits.maxRequestTimeoutMilliseconds &&
    totalRequests <= limits.maxRequestCount &&
    totalRequests <= maxRequests &&
    maxRequests <= limits.maxRequestCount
  );
}
