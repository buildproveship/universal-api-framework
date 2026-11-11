import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
const profileConfig = JSON.parse(open('./config/profiles.json'));

const profileName = __ENV.PERF_PROFILE || 'direct-mock';
const profile = profileConfig.profiles[profileName];
const isDev = profileName === 'dev';
const lifecycleRequests = isDev ? 2 : 0;
const workloadName = __ENV.PERF_WORKLOAD;
const workload = profileConfig.workloads[workloadName];
const target = /^http:\/\/(127\.0\.0\.1):([0-9]{1,5})\/$/.exec(__ENV.PERF_TARGET || '');
const expectedVersion = '1';

if (!workload) {
  throw new Error('Workload is not present in the versioned local performance configuration.');
}

if (
  !['direct-mock', 'dev'].includes(profileName) ||
  !profile?.enabled ||
  !profile.workloads.includes(workloadName) ||
  profile.targetProtocol !== 'http:' ||
  profile.targetPort !== (isDev ? 'ephemeral-owned-platform' : 'ephemeral-owned-fixture') ||
  !target ||
  !profile.targetHostAllowlist.includes(target[1]) ||
  target[2] !== __ENV.PERF_OWNED_PORT ||
  String(Number(target[2])) !== target[2] ||
  Number(target[2]) < 1024 ||
  Number(target[2]) > 65535 ||
  (isDev && [33336, 38089].includes(Number(target[2])))
) {
  throw new Error('Target is not an approved owned loopback runtime; no requests were sent.');
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
  ![workload.vus, workload.ratePerSecond, duration,
    workload.requestTimeoutMilliseconds, workload.maxRequests]
    .every((value) => Number.isInteger(value) && value > 0) ||
  workload.vus > hardLimits.maxVus ||
  workload.ratePerSecond > hardLimits.maxRatePerSecond ||
  duration > hardLimits.maxDurationSeconds ||
  workload.requestTimeoutMilliseconds > hardLimits.maxRequestTimeoutMilliseconds ||
  workload.ratePerSecond * duration + lifecycleRequests > hardLimits.maxRequestCount ||
  workload.ratePerSecond * duration + lifecycleRequests > workload.maxRequests ||
  workload.maxRequests > hardLimits.maxRequestCount
) {
  throw new Error('Configured workload exceeds a hard safety ceiling; no requests were sent.');
}

const completedChecks = new Counter('business_checks');
const applicationRequests = new Counter('application_requests');
const projectId = '00000000-0000-4000-8000-000000000102';
const tenantId = '00000000-0000-4000-8000-000000000101';
const environmentId = '00000000-0000-4000-8000-000000000104';

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
    http_reqs: [`count<=${workload.maxRequests}`],
    business_checks: ['count>0'],
  },
};

function requestOptions(route, token) {
  return {
    redirects: 0,
    timeout: `${workload.requestTimeoutMilliseconds}ms`,
    tags: { route },
    headers: {
      'Content-Type': 'application/json',
      // The unchanged ingress forwards to container port 33336. Preserve its
      // canonical HTTP authority while connecting only to our owned host port.
      ...(isDev ? { Host: '127.0.0.1:33336' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
}

function jsonBody(response) {
  try { return response.json(); } catch { return null; }
}

export function setup() {
  if (!isDev) return {};
  const response = http.post(`${targetOrigin}/api/dev/login`,
    JSON.stringify({ user: 'developer-a' }), requestOptions('POST /api/dev/login'));
  const body = jsonBody(response);
  const valid = check(response, {
    'owned Dev mocked login succeeds': (res) => res.status === 200,
    'owned Dev session has the synthetic contract': () =>
      typeof body?.token === 'string' && /^rrdev_[0-9a-f]{64}$/.test(body.token) &&
      Number.isFinite(body.expires),
  });
  if (!valid) throw new Error('Owned Dev mocked login failed; no application workload was sent.');
  return { token: body.token };
}

export default function (session) {
  const route = isDev
    ? `/projects/${projectId}/environments/${environmentId}/configuration`
    : '/widgets/widget-1';
  const response = http.get(`${targetOrigin}${route}`,
    requestOptions(isDev ? 'GET owned project configuration' : 'GET /widgets/widget-1', session?.token));
  applicationRequests.add(1);
  const body = jsonBody(response);
  const results = check(response, {
    'application response is HTTP 200': (res) => res.status === 200,
    'application response is JSON': (res) => (res.headers['Content-Type'] || '').startsWith('application/json'),
    'application business identity is correct': () => isDev
      ? body?.application?.id === (__ENV.PERF_EXPECT_FAILURE === 'true' ? 'deliberately-wrong-project' : projectId) &&
        body.application.tenantId === tenantId && body.environment?.id === environmentId &&
        body.environment.applicationId === projectId
      : body?.id === 'widget-1' && body.active === true && body.version === expectedVersion,
  });
  if (results) completedChecks.add(1);
}

export function teardown(session) {
  if (!isDev || !session?.token) return;
  const response = http.post(`${targetOrigin}/api/dev/logout`, null,
    requestOptions('POST /api/dev/logout', session.token));
  check(response, { 'owned Dev session is revoked': (res) => res.status === 204 });
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
    profile: profileName,
    workload: workloadName,
    mockBoundaries: profile.mockBoundaries,
    metrics: {
      requestCount: requests,
      applicationRequestCount: metricValue(data, 'application_requests', 'count'),
      lifecycleRequestAllowance: lifecycleRequests,
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
