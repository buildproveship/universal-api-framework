import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
const profileConfig = JSON.parse(open('./config/profiles.json'));

const profile = profileConfig.profiles['direct-mock'];
const workloadName = __ENV.PERF_WORKLOAD;
const workload = profileConfig.workloads[workloadName];
const target = /^http:\/\/(127\.0\.0\.1):([0-9]{1,5})\/$/.exec(__ENV.PERF_TARGET || '');
const expectedVersion = '1';

if (!workload) {
  throw new Error('Workload is not present in the versioned local performance configuration.');
}

if (
  !profile.enabled ||
  profile.targetProtocol !== 'http:' ||
  profile.targetPort !== 'ephemeral-owned-fixture' ||
  !target ||
  !profile.targetHostAllowlist.includes(target[1]) ||
  Number(target[2]) < 49152 ||
  Number(target[2]) > 65535
) {
  throw new Error('Target is not an approved ephemeral loopback fixture; no requests were sent.');
}

const targetOrigin = `http://${target[1]}:${target[2]}`;
const hardLimits = profileConfig.hardLimits;
const absoluteLimits = {
  maxVus: 2,
  maxRatePerSecond: 2,
  maxDurationSeconds: 10,
  maxRequestTimeoutMilliseconds: 1000,
  maxRequestCount: 20,
};
const duration = workload.durationSeconds;

for (const [name, maximum] of Object.entries(absoluteLimits)) {
  if (
    !Number.isInteger(hardLimits[name]) ||
    hardLimits[name] < 1 ||
    hardLimits[name] > maximum
  ) {
    throw new Error('Configured hard limits exceed absolute safety ceilings; no requests were sent.');
  }
}

if (
  workload.vus > hardLimits.maxVus ||
  workload.ratePerSecond > hardLimits.maxRatePerSecond ||
  duration > hardLimits.maxDurationSeconds ||
  workload.requestTimeoutMilliseconds > hardLimits.maxRequestTimeoutMilliseconds ||
  workload.ratePerSecond * duration > hardLimits.maxRequestCount ||
  workload.ratePerSecond * duration > workload.maxRequests ||
  workload.maxRequests > hardLimits.maxRequestCount
) {
  throw new Error('Configured workload exceeds a hard safety ceiling; no requests were sent.');
}

const completedChecks = new Counter('business_checks');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    configured_workload: {
      executor: 'constant-arrival-rate',
      rate: workload.ratePerSecond,
      timeUnit: '1s',
      duration: `${duration}s`,
      preAllocatedVUs: workload.vus,
      maxVUs: workload.vus,
      gracefulStop: '0s',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    business_checks: ['count>0'],
  },
};

export default function () {
  const response = http.get(`${targetOrigin}/widgets/widget-1`, {
    redirects: 0,
    timeout: `${workload.requestTimeoutMilliseconds}ms`,
    tags: { route: 'GET /widgets/widget-1' },
  });
  const body = response.json();
  const results = check(response, {
    'widget response is HTTP 200': (res) => res.status === 200,
    'widget response is JSON': (res) => (res.headers['Content-Type'] || '').startsWith('application/json'),
    'widget business identity is correct': () =>
      body.id === 'widget-1' && body.active === true && body.version === expectedVersion,
  });

  if (results) {
    completedChecks.add(1);
  }
}

function metricValue(data, metricName, valueName) {
  return data.metrics[metricName]?.values?.[valueName] ?? 0;
}

export function handleSummary(data) {
  const requests = metricValue(data, 'http_reqs', 'count');
  const durationMs = data.state.testRunDurationMs ?? 0;
  const summary = {
    schemaVersion: 1,
    codeRevision: __ENV.PERF_REVISION,
    workingTreeDirty: __ENV.PERF_WORKTREE_DIRTY === 'true',
    k6Version: __ENV.PERF_K6_VERSION,
    environment: profile.environment,
    profile: 'direct-mock',
    workload: workloadName,
    mockBoundaries: profile.mockBoundaries,
    metrics: {
      requestCount: requests,
      throughputRequestsPerSecond: durationMs > 0 ? requests / (durationMs / 1000) : 0,
      errorRate: metricValue(data, 'http_req_failed', 'rate'),
      checkPassRate: metricValue(data, 'checks', 'rate'),
      checksPassed: metricValue(data, 'checks', 'passes'),
      checksFailed: metricValue(data, 'checks', 'fails'),
      droppedIterations: metricValue(data, 'dropped_iterations', 'count'),
      latencyMilliseconds: {
        p50: metricValue(data, 'http_req_duration', 'med'),
        p90: metricValue(data, 'http_req_duration', 'p(90)'),
        p95: metricValue(data, 'http_req_duration', 'p(95)'),
        p99: metricValue(data, 'http_req_duration', 'p(99)'),
      },
    },
  };
  const serialized = JSON.stringify(summary, null, 2);

  return {
    stdout: `${serialized}\n`,
    [__ENV.PERF_SUMMARY_PATH]: `${serialized}\n`,
  };
}
