import test from 'node:test';
import assert from 'node:assert/strict';
import { assertImageId, assertLocalContext, assertOwned, validateModel, makeOverlay, runtimeConfig } from '../performance/platform-runtime.mjs';
test('Mutable image references are refused', () => {
  for (const image of ['latest', 'sha256:abc', '-bad', 'repo:tag']) assert.throws(() => assertImageId(image));
  assert.doesNotThrow(() => assertImageId(`sha256:${'a'.repeat(64)}`));
});
test('Remote Docker endpoints are refused', () => {
  for (const Host of ['tcp://localhost:2375', 'ssh://host', 'unix://relative']) assert.throws(() => assertLocalContext({ Endpoints: { docker: { Host } } }));
  assert.equal(assertLocalContext({ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }), 'unix:///var/run/docker.sock');
});
test('Foreign project resources cannot be cleaned up', () => {
  assert.throws(() => assertOwned({ Labels: { 'com.docker.compose.project': 'rrk6-test' } }, 'rrk6-test', 'owner'));
  assert.doesNotThrow(() => assertOwned({ Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner' } }, 'rrk6-test', 'owner'));
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
  assert.doesNotThrow(() => validateModel(model(), opts));
  for (const mutate of [m => m.services.ingress.ports[0].published = '33336', m => m.services.ingress.ports[0].host_ip = '0.0.0.0', m => m.networks.dev.internal = false, m => m.services.central.environment.TOKEN = 'secret', m => m.services.central.network_mode = 'host', m => m.services.gateway.privileged = true, m => m.services.wiremock.volumes[0].read_only = false]) {
    const m = model(); mutate(m); assert.throws(() => validateModel(m, opts));
  }
});

test('Cleanup refuses all mutation if any enumerated resource is foreign', async () => {
  const { cleanupOwnedResources } = await import('../performance/platform-runtime.mjs');
  const calls = [];
  await assert.rejects(cleanupOwnedResources({
    resources: async () => ({ container: [], network: [{ Labels: {} }], volume: [] }),
    run: async args => calls.push(args), json: async () => [], project: 'rrk6-test', owner: 'owner',
  }), /foreign/);
  assert.deepEqual(calls, []);
});
test('Cleanup stops central and proves termination before removing owned resources', async () => {
  const { cleanupOwnedResources } = await import('../performance/platform-runtime.mjs');
  const calls = [];
  const labels = { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': 'central' };
  const central = { Id: 'central-id', Config: { Labels: labels }, State: { Running: false } };
  let enumerations = 0;
  const result = { container: [central], network: [], volume: [] };
  await cleanupOwnedResources({ resources: async () => ++enumerations === 1 ? result : { container: [], network: [], volume: [] }, json: async () => [central], run: async args => calls.push(args), project: 'rrk6-test', owner: 'owner' });
  assert.deepEqual(calls, [['container', 'stop', '--time', '45', 'central-id'], ['container', 'rm', '-f', 'central-id']]);
  central.State.Running = true;
  calls.length = 0;
  await assert.rejects(cleanupOwnedResources({ resources: async () => result, json: async () => [central], run: async args => calls.push(args), project: 'rrk6-test', owner: 'owner' }), /could not verify resource settlement/);
  assert.equal(calls.length, 6); // One graceful stop and five independently verified forced cleanup attempts.
});

test('Healthy runtime cleanup verifies exit zero and the stopped report before claiming graceful settlement', async () => {
  const { cleanupOwnedResources } = await import('../performance/platform-runtime.mjs');
  for (const [exitCode, report, expected] of [[0, 'stopped', true], [137, 'stopped', false], [0, 'stopping', false], [0, null, false]]) {
    let reads = 0;
    const calls = [];
    const central = { Id: 'central-id', Config: { Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': 'central' } }, State: { Running: false, ExitCode: exitCode } };
    const result = await cleanupOwnedResources({
      resources: async () => ({ container: ++reads === 1 ? [central] : [], network: [], volume: [] }),
      json: async () => [central], run: async args => calls.push(args), project: 'rrk6-test', owner: 'owner', requireGraceful: true,
      readStopState: async () => { if (report === null) throw new Error('Missing report'); return report; },
    });
    assert.equal(result.settled, true);
    assert.equal(result.gracefulStopVerified, expected);
    assert.deepEqual(calls.at(-1), ['container', 'rm', '-f', 'central-id']);
  }
});

test('A stop failure and transient removal failure do not block cleanup of other owned containers', async () => {
  const { cleanupOwnedResources } = await import('../performance/platform-runtime.mjs');
  const make = service => ({ Id: service, Config: { Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': service } } });
  const remaining = new Map(['central', 'gateway'].map(service => [service, make(service)]));
  const removals = [];
  let failFirstCentralRemoval = true;
  const result = await cleanupOwnedResources({
    resources: async () => ({ container: [...remaining.values()], network: [], volume: [] }),
    json: async args => [remaining.get(args[2])],
    run: async args => {
      if (args[1] === 'stop') throw new Error('Transient stop failure');
      const id = args.at(-1); removals.push(id);
      if (id === 'central' && failFirstCentralRemoval) { failFirstCentralRemoval = false; throw new Error('Transient removal failure'); }
      remaining.delete(id);
    }, project: 'rrk6-test', owner: 'owner', requireGraceful: true, readStopState: async () => 'stopped',
  });
  assert.deepEqual(removals, ['central', 'gateway', 'central']);
  assert.equal(result.settled, true);
  assert.equal(result.gracefulStopVerified, false);
  assert.equal(result.cleanupFailures.length, 2);
  assert.deepEqual(result.remainingOwnedResources, []);
});

test('Permanent removal failure is bounded and reports the remaining owned resources', async () => {
  const { cleanupOwnedResources } = await import('../performance/platform-runtime.mjs');
  const container = { Id: 'gateway', Config: { Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': 'gateway' } } };
  let attempts = 0;
  await assert.rejects(cleanupOwnedResources({
    resources: async () => ({ container: [container], network: [], volume: [] }), json: async () => [container],
    run: async () => { attempts++; throw new Error('Permanent failure'); }, project: 'rrk6-test', owner: 'owner',
  }), error => {
    assert.equal(error.settlement.settled, false);
    assert.deepEqual(error.settlement.remainingOwnedResources, [{ kind: 'container', id: 'gateway' }]);
    assert.equal(error.settlement.cleanupFailures.length, 5);
    return true;
  });
  assert.equal(attempts, 5);
});

test('Cleanup catches late owned resources after an initial empty inventory', async () => {
  const { cleanupOwnedResources } = await import('../performance/platform-runtime.mjs');
  const late = { Id: 'late-gateway', Config: { Labels: { 'com.docker.compose.project': 'rrk6-test', 'releaseready.performance.owner': 'owner', 'com.docker.compose.service': 'gateway' } } };
  let observations = 0, removed = false;
  const result = await cleanupOwnedResources({
    resources: async () => ({ container: ++observations >= 2 && !removed ? [late] : [], network: [], volume: [] }),
    json: async () => [late], run: async () => { removed = true; }, project: 'rrk6-test', owner: 'owner', settleDelay: async () => {},
  });
  assert.equal(removed, true);
  assert.equal(result.settled, true);
  assert.ok(observations >= 5);
});

test('A timed-out creation remains uncertain even after repeated empty inventories', async () => {
  const { cleanupOwnedResources } = await import('../performance/platform-runtime.mjs');
  let observations = 0;
  await assert.rejects(cleanupOwnedResources({
    resources: async () => { observations++; return { container: [], network: [], volume: [] }; },
    json: async () => [], run: async () => {}, project: 'rrk6-test', owner: 'owner', creationOutcomeUncertain: true, settleDelay: async () => {},
  }), error => {
    assert.equal(error.settlement.settled, false);
    assert.equal(error.settlement.creationOutcomeUncertain, true);
    assert.deepEqual(error.settlement.remainingOwnedResources, []);
    return true;
  });
  assert.equal(observations, 6);
});

test('Startup error wrappers preserve sanitized cleanup metadata before a handle exists', async () => {
  const { failStartupWithSettlement } = await import('../performance/platform-runtime.mjs');
  const original = new Error('Startup failed');
  const cleanup = new Error('Cleanup failed');
  cleanup.settlement = { settled: false, gracefulStopVerified: false, project: 'rrk6-test', remainingOwnedResources: [{ kind: 'container', id: 'owned-container' }], creationOutcomeUncertain: true, token: 'must-not-copy' };
  await assert.rejects(failStartupWithSettlement(original, async () => { throw cleanup; }, { project: 'rrk6-test', owner: 'owner' }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, cleanup]);
    assert.equal(error.settlement.creationOutcomeUncertain, true);
    assert.equal(error.settlement.owner, 'owner');
    assert.deepEqual(error.settlement.remainingOwnedResources, [{ kind: 'container', id: 'owned-container' }]);
    assert.equal('token' in error.settlement, false);
    return true;
  });
});

test('Successful startup-failure cleanup is attached to the original error', async () => {
  const { failStartupWithSettlement } = await import('../performance/platform-runtime.mjs');
  const original = new Error('Startup aborted');
  await assert.rejects(failStartupWithSettlement(original, async () => ({ settled: true, gracefulStopVerified: false, remainingOwnedResources: [] }), { project: 'rrk6-test', owner: 'owner', creationOutcomeUncertain: false }), error => {
    assert.equal(error, original);
    assert.equal(error.settlement.settled, true);
    assert.equal(error.settlement.project, 'rrk6-test');
    return true;
  });
});

test('Missing cleanup evidence falls back to explicit unknown settlement', async () => {
  const { failStartupWithSettlement } = await import('../performance/platform-runtime.mjs');
  await assert.rejects(failStartupWithSettlement(new Error('Startup failed'), async () => { throw new Error('Enumeration failed'); }, { project: 'rrk6-test', owner: 'owner', creationOutcomeUncertain: true }), error => {
    assert.equal(error.settlement.settled, false);
    assert.equal(error.settlement.remainingResourcesKnown, false);
    assert.equal(error.settlement.remainingResourcesMayBeStale, true);
    assert.equal(error.settlement.creationOutcomeUncertain, true);
    return true;
  });
});
