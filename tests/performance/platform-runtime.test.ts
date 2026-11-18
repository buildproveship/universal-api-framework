// Test classification: unit
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: Dev Platform runtime guards and cleanup logic with fake Docker calls; it does not run Docker or the Platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertImageId, assertLocalContext, assertOwned, validateModel, makeOverlay, runtimeConfig,
  type Settlement, type SettlementError,
} from '../../performance/platform-runtime.ts';

function first<T>(items: T[]): T {
  const [item] = items;
  assert.ok(item);
  return item;
}
/** The sanitized settlement attached to a rejected cleanup or startup. */
function settlementOf(error: unknown): Settlement {
  assert.ok(error instanceof Error);
  const { settlement } = error as SettlementError;
  assert.ok(settlement);
  return settlement;
}
test('Mutable image references are refused', () => {
  for (const image of ['latest', 'sha256:abc', '-bad', 'repo:tag']) assert.throws(() => { assertImageId(image); });
  assert.doesNotThrow(() => { assertImageId(`sha256:${'a'.repeat(64)}`); });
});
test('Remote Docker endpoints are refused', () => {
  for (const Host of ['tcp://localhost:2375', 'ssh://host', 'unix://relative']) assert.throws(() => assertLocalContext({ Endpoints: { docker: { Host } } }));
  assert.equal(assertLocalContext({ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }), 'unix:///var/run/docker.sock');
});
test('Foreign project resources cannot be cleaned up', () => {
  assert.throws(() => { assertOwned({ Labels: { 'com.docker.compose.project': 'rrk6-test' } }, 'rrk6-test', 'owner'); });
  assert.doesNotThrow(() => { assertOwned({ Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner' } }, 'rrk6-test', 'owner'); });
});
test('Overlay replaces the published port and central environment', () => {
  const text = makeOverlay('owner');
  assert.match(text, /ports: !override/);
  assert.match(text, /environment: !override/);
  assert.doesNotMatch(text, /RR_FEATURE_TEST_PLANS/);
  assert.match(text, /127.0.0.1:0:33336/);
});
function model() {
  const image = `sha256:${'a'.repeat(64)}`;
  const label = { 'releaseready.performance.owner': 'owner' };
  const common = { image, pull_policy: 'never', labels: label, read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] };
  return { services: {
    gateway: { ...common, networks: { dev: {} } },
    ingress: { ...common, networks: { dev: {}, ingress: {} }, ports: [{ host_ip: '127.0.0.1', published: '0', target: 33336 }] },
    central: { ...common, network_mode: 'service:gateway', environment: { NODE_ENV: 'development', RR_ENVIRONMENT: 'dev', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' }, volumes: [{ type: 'volume', source: 'data', target: '/data' }] },
    wiremock: { ...common, image: runtimeConfig.wiremockImage, network_mode: 'service:gateway', volumes: [{ type: 'bind', source: '/source/ops/dev/wiremock/mappings', target: '/home/wiremock/mappings', read_only: true }] },
  }, networks: { dev: { internal: true, labels: label }, ingress: { labels: label } }, volumes: { data: { labels: label } } };
}
test('Merged model accepts only private loopback publication and isolated app namespaces', () => {
  const opts = { image: `sha256:${'a'.repeat(64)}`, owner: 'owner', platformRoot: '/source' };
  assert.doesNotThrow(() => { validateModel(model(), opts); });
  const mutations: ((m: ReturnType<typeof model>) => void)[] = [
    m => { first(m.services.ingress.ports).published = '33336'; },
    m => { first(m.services.ingress.ports).host_ip = '0.0.0.0'; },
    m => { m.networks.dev.internal = false; },
    m => { Object.assign(m.services.central.environment, { TOKEN: 'secret' }); },
    m => { m.services.central.network_mode = 'host'; },
    m => { Object.assign(m.services.gateway, { privileged: true }); },
    m => { first(m.services.wiremock.volumes).read_only = false; },
  ];
  for (const mutate of mutations) {
    const m = model(); mutate(m); assert.throws(() => { validateModel(m, opts); });
  }
});

test('Cleanup refuses all mutation if any enumerated resource is foreign', async () => {
  const { cleanupOwnedResources } = await import('../../performance/platform-runtime.ts');
  const calls: string[][] = [];
  const record = (args: string[]) => { calls.push(args); return Promise.resolve(); };
  await assert.rejects(cleanupOwnedResources({
    resources: () => Promise.resolve({ container: [], network: [{ Labels: {} }], volume: [] }),
    run: record, json: () => Promise.resolve([]), project: 'rrk6-test', owner: 'owner',
  }), /foreign/);
  assert.deepEqual(calls, []);
});
test('Cleanup stops central and proves termination before removing owned resources', async () => {
  const { cleanupOwnedResources } = await import('../../performance/platform-runtime.ts');
  const calls: string[][] = [];
  const record = (args: string[]) => { calls.push(args); return Promise.resolve(); };
  const labels = { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': 'central' };
  const central = { Id: 'central-id', Config: { Labels: labels }, State: { Running: false } };
  let enumerations = 0;
  const result = { container: [central], network: [], volume: [] };
  await cleanupOwnedResources({ resources: () => Promise.resolve(++enumerations === 1 ? result : { container: [], network: [], volume: [] }), json: () => Promise.resolve([central]), run: record, project: 'rrk6-test', owner: 'owner' });
  assert.deepEqual(calls, [['container', 'stop', '--time', '45', 'central-id'], ['container', 'rm', '-f', 'central-id']]);
  central.State.Running = true;
  calls.length = 0;
  await assert.rejects(cleanupOwnedResources({ resources: () => Promise.resolve(result), json: () => Promise.resolve([central]), run: record, project: 'rrk6-test', owner: 'owner' }), /could not verify resource settlement/);
  assert.equal(calls.length, 6); // One graceful stop and five independently verified forced cleanup attempts.
});

test('Healthy runtime cleanup verifies exit zero and the stopped report before claiming graceful settlement', async () => {
  const { cleanupOwnedResources } = await import('../../performance/platform-runtime.ts');
  const cases: [exitCode: number, report: string | null, expected: boolean][] = [[0, 'stopped', true], [137, 'stopped', false], [0, 'stopping', false], [0, null, false]];
  for (const [exitCode, report, expected] of cases) {
    let reads = 0;
    const calls: string[][] = [];
    const record = (args: string[]) => { calls.push(args); return Promise.resolve(); };
    const central = { Id: 'central-id', Config: { Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': 'central' } }, State: { Running: false, ExitCode: exitCode } };
    const result = await cleanupOwnedResources({
      resources: () => Promise.resolve({ container: ++reads === 1 ? [central] : [], network: [], volume: [] }),
      json: () => Promise.resolve([central]), run: record, project: 'rrk6-test', owner: 'owner', requireGraceful: true,
      readStopState: () => report === null ? Promise.reject(new Error('Missing report')) : Promise.resolve(report),
    });
    assert.equal(result.settled, true);
    assert.equal(result.gracefulStopVerified, expected);
    assert.deepEqual(calls.at(-1), ['container', 'rm', '-f', 'central-id']);
  }
});

test('A stop failure and transient removal failure do not block cleanup of other owned containers', async () => {
  const { cleanupOwnedResources } = await import('../../performance/platform-runtime.ts');
  const make = (service: string) => ({ Id: service, Config: { Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': service } } });
  const remaining = new Map(['central', 'gateway'].map(service => [service, make(service)]));
  const removals: (string | undefined)[] = [];
  let failFirstCentralRemoval = true;
  const result = await cleanupOwnedResources({
    resources: () => Promise.resolve({ container: [...remaining.values()], network: [], volume: [] }),
    json: args => Promise.resolve([remaining.get(args[2] ?? '')]),
    run: args => {
      if (args[1] === 'stop') return Promise.reject(new Error('Transient stop failure'));
      const id = args.at(-1); removals.push(id);
      if (id === 'central' && failFirstCentralRemoval) { failFirstCentralRemoval = false; return Promise.reject(new Error('Transient removal failure')); }
      if (id !== undefined) remaining.delete(id);
      return Promise.resolve();
    }, project: 'rrk6-test', owner: 'owner', requireGraceful: true, readStopState: () => Promise.resolve('stopped'),
  });
  assert.deepEqual(removals, ['central', 'gateway', 'central']);
  assert.equal(result.settled, true);
  assert.equal(result.gracefulStopVerified, false);
  assert.equal(result.cleanupFailures?.length, 2);
  assert.deepEqual(result.remainingOwnedResources, []);
});

test('Permanent removal failure is bounded and reports the remaining owned resources', async () => {
  const { cleanupOwnedResources } = await import('../../performance/platform-runtime.ts');
  const container = { Id: 'gateway', Config: { Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': 'gateway' } } };
  let attempts = 0;
  await assert.rejects(cleanupOwnedResources({
    resources: () => Promise.resolve({ container: [container], network: [], volume: [] }), json: () => Promise.resolve([container]),
    run: () => { attempts++; return Promise.reject(new Error('Permanent failure')); }, project: 'rrk6-test', owner: 'owner',
  }), (error: unknown) => {
    const settlement = settlementOf(error);
    assert.equal(settlement.settled, false);
    assert.deepEqual(settlement.remainingOwnedResources, [{ kind: 'container', id: 'gateway' }]);
    assert.equal(settlement.cleanupFailures?.length, 5);
    return true;
  });
  assert.equal(attempts, 5);
});

test('Cleanup catches late owned resources after an initial empty inventory', async () => {
  const { cleanupOwnedResources } = await import('../../performance/platform-runtime.ts');
  const late = { Id: 'late-gateway', Config: { Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': 'gateway' } } };
  let observations = 0, removed = false;
  const result = await cleanupOwnedResources({
    resources: () => Promise.resolve({ container: ++observations >= 2 && !removed ? [late] : [], network: [], volume: [] }),
    json: () => Promise.resolve([late]), run: () => { removed = true; return Promise.resolve(); }, project: 'rrk6-test', owner: 'owner', settleDelay: () => Promise.resolve(),
  });
  assert.equal(removed, true);
  assert.equal(result.settled, true);
  assert.ok(observations >= 5);
});

test('A timed-out creation remains uncertain even after repeated empty inventories', async () => {
  const { cleanupOwnedResources } = await import('../../performance/platform-runtime.ts');
  let observations = 0;
  await assert.rejects(cleanupOwnedResources({
    resources: () => { observations++; return Promise.resolve({ container: [], network: [], volume: [] }); },
    json: () => Promise.resolve([]), run: () => Promise.resolve(), project: 'rrk6-test', owner: 'owner', creationOutcomeUncertain: true, settleDelay: () => Promise.resolve(),
  }), (error: unknown) => {
    const settlement = settlementOf(error);
    assert.equal(settlement.settled, false);
    assert.equal(settlement.creationOutcomeUncertain, true);
    assert.deepEqual(settlement.remainingOwnedResources, []);
    return true;
  });
  assert.equal(observations, 6);
});

test('Startup error wrappers preserve sanitized cleanup metadata before a handle exists', async () => {
  const { failStartupWithSettlement } = await import('../../performance/platform-runtime.ts');
  const original = new Error('Startup failed');
  const cleanup = new Error('Cleanup failed');
  Object.assign(cleanup, { settlement: { settled: false, gracefulStopVerified: false, project: 'rrk6-test', remainingOwnedResources: [{ kind: 'container', id: 'owned-container' }], creationOutcomeUncertain: true, token: 'must-not-copy' } });
  await assert.rejects(failStartupWithSettlement(original, () => Promise.reject(cleanup), { project: 'rrk6-test', owner: 'owner' }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    const settlement = settlementOf(error);
    assert.deepEqual(error.errors, [original, cleanup]);
    assert.equal(settlement.creationOutcomeUncertain, true);
    assert.equal(settlement.owner, 'owner');
    assert.deepEqual(settlement.remainingOwnedResources, [{ kind: 'container', id: 'owned-container' }]);
    assert.equal('token' in settlement, false);
    return true;
  });
});

test('Successful startup-failure cleanup is attached to the original error', async () => {
  const { failStartupWithSettlement } = await import('../../performance/platform-runtime.ts');
  const original = new Error('Startup aborted');
  await assert.rejects(failStartupWithSettlement(original, () => Promise.resolve({ settled: true, gracefulStopVerified: false, remainingOwnedResources: [] }), { project: 'rrk6-test', owner: 'owner', creationOutcomeUncertain: false }), (error: unknown) => {
    assert.equal(error, original);
    const settlement = settlementOf(error);
    assert.equal(settlement.settled, true);
    assert.equal(settlement.project, 'rrk6-test');
    return true;
  });
});

test('Missing cleanup evidence falls back to explicit unknown settlement', async () => {
  const { failStartupWithSettlement } = await import('../../performance/platform-runtime.ts');
  await assert.rejects(failStartupWithSettlement(new Error('Startup failed'), () => Promise.reject(new Error('Enumeration failed')), { project: 'rrk6-test', owner: 'owner', creationOutcomeUncertain: true }), (error: unknown) => {
    const settlement = settlementOf(error);
    assert.equal(settlement.settled, false);
    assert.equal(settlement.remainingResourcesKnown, false);
    assert.equal(settlement.remainingResourcesMayBeStale, true);
    assert.equal(settlement.creationOutcomeUncertain, true);
    return true;
  });
});
