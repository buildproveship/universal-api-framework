// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: OpenAPI intake preflight through the public preflight() API and its child process with synthetic documents; it does not cover document-schema validation.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflight, type FailureCode, type PreflightPolicy } from '../src/intake/preflight.js';
import { startSyntheticApi } from './fixtures/synthetic-api.js';

// Synthetic test settings only; these are not product limits or supported-version promises.
const policy: PreflightPolicy = {
  maxBytes: 16_384,
  maxDepth: 20,
  maxNodes: 500,
  maxReferences: 10,
  timeoutMs: 5_000,
  workerHeapMb: 32,
  workerStackMb: 4,
  allowedOpenApiVersions: ['3.0.3', '3.1.0'],
};
const valid = '{"openapi":"3.0.3","info":{"title":"Synthetic","version":"1"},"paths":{}}';

async function rejected(source: string, code: FailureCode, overrides = {}, format: 'json' | 'yaml' = 'yaml') {
  const result = await preflight(source, format, { ...policy, ...overrides });
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, code);
  return result;
}

describe('Inactive synthetic contract intake preflight', () => {
  it('Given inherited or non-enumerable limits, then the validated limits survive transfer', async () => {
    const cases = [
      ['maxNodes', valid, 'nodes-exceeded'],
      ['maxDepth', valid, 'depth-exceeded'],
      ['maxReferences', 'openapi: 3.0.3\na: {$ref: "#/a"}\nb: {$ref: "#/b"}', 'references-exceeded'],
    ] as const;
    for (const [key, source, code] of cases) {
      for (const inherited of [false, true]) {
        const configured = { ...policy };
        Reflect.deleteProperty(configured, key);
        if (inherited) Object.setPrototypeOf(configured, { [key]: 1 });
        else Object.defineProperty(configured, key, { value: 1, enumerable: false });
        const result = await preflight(source, 'yaml', configured);
        assert.equal(result.status, 'rejected');
        assert.equal(result.code, code);
      }
    }
  });

  it('Given unsafe runtime resources, then isolated callers survive and receive a policy rejection', () => {
    for (const mode of ['bad-heap', 'below-heap-floor', 'bad-stack', 'below-stack-floor']) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/intake-resource-probe.js', import.meta.url)), mode],
        {
          encoding: 'utf8',
          timeout: 20_000,
          killSignal: 'SIGKILL',
          maxBuffer: 16_384,
        },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, `mode=${mode} status=${child.status} signal=${child.signal}`);
      assert.deepEqual(JSON.parse(child.stdout), { status: 'rejected', code: 'policy-required' });
    }
  });

  it('Given resource floors and parser heap exhaustion, then the isolated caller survives and can recover', () => {
    for (const mode of ['minimum', 'heap-pressure']) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/intake-resource-probe.js', import.meta.url)), mode],
        {
          encoding: 'utf8',
          timeout: 20_000,
          killSignal: 'SIGKILL',
          maxBuffer: 16_384,
        },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, `mode=${mode} status=${child.status} signal=${child.signal}`);
      const output = JSON.parse(child.stdout) as { status?: string; result?: unknown; recovery?: { status?: string } };
      if (mode === 'minimum') assert.equal(output.status, 'preflight-passed');
      else {
        assert.deepEqual(output.result, { status: 'rejected', code: 'worker-failed' });
        assert.equal(output.recovery?.status, 'preflight-passed');
      }
    }
  });

  it('Given configuration accessors, then each value is read once into validated plain data', async () => {
    let reads = 0;
    const configured = {
      ...policy,
      get maxNodes() {
        reads++;
        return reads === 1 ? 1 : 500;
      },
    };
    const result = await preflight(valid, 'json', configured);
    assert.equal(reads, 1);
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'nodes-exceeded');
    const throwing = {
      ...policy,
      get maxNodes(): number {
        throw new Error('synthetic private configuration');
      },
    };
    assert.deepEqual(await preflight(valid, 'json', throwing), { status: 'rejected', code: 'policy-required' });
  });

  it('Given malformed URI fragments, then syntax fails before pointer decoding', async () => {
    for (const ref of ['#/a b', '#/a#b', '#/a\nb', '#/a\tb', '#/a\\b', '#/a[0]', '#/é']) {
      await rejected(JSON.stringify({ openapi: '3.0.3', a: { $ref: ref } }), 'reference-unsupported');
    }
    for (const ref of ['#/a%20b', '#/a%23b', '#/%C3%A9', '#/a~1b', '#/a?b', '#/a%0Ab']) {
      assert.equal(
        (await preflight(JSON.stringify({ openapi: '3.0.3', a: { $ref: ref } }), 'json', policy)).status,
        'preflight-passed',
      );
    }
  });
  it('Given JSON and YAML, when preflight passes, then schema and execution approval stay false', async () => {
    for (const [source, format] of [
      [valid, 'json'],
      ['openapi: 3.1.0\npaths: {}', 'yaml'],
    ] as const) {
      assert.deepEqual(await preflight(source, format, policy), {
        status: 'preflight-passed',
        schemaValidated: false,
        executionAuthorized: false,
      });
    }
  });

  it('Given missing or invalid policy, when called, then it fails closed', async () => {
    assert.deepEqual(await preflight(valid, 'json'), { status: 'rejected', code: 'policy-required' });
    for (const key of [
      'maxBytes',
      'maxDepth',
      'maxNodes',
      'maxReferences',
      'timeoutMs',
      'workerHeapMb',
      'workerStackMb',
    ]) {
      for (const value of [undefined, 0, -1, 0.5, Infinity, NaN]) {
        await rejected(valid, 'policy-required', { [key]: value });
      }
    }
    await rejected(valid, 'policy-required', { allowedOpenApiVersions: [] });
    await rejected(valid, 'policy-required', { allowedOpenApiVersions: ['2.0'] });
    await rejected(valid, 'policy-required', { timeoutMs: 2_147_483_648 });
  });

  it('Given UTF-8 multibyte input, when bytes exceed the explicit limit, then it rejects before parsing', async () => {
    await rejected('éé', 'bytes-exceeded', { maxBytes: 3 });
    assert.equal(
      (await preflight(valid, 'json', { ...policy, maxBytes: Buffer.byteLength(valid) })).status,
      'preflight-passed',
    );
    await rejected(valid, 'bytes-exceeded', { maxBytes: Buffer.byteLength(valid) - 1 });
  });

  it('Given excessive structure or references, when inspected, then caller bounds reject it', async () => {
    await rejected('openapi: 3.0.3\na: {b: {c: 1}}', 'depth-exceeded', { maxDepth: 3 });
    await rejected(valid, 'nodes-exceeded', { maxNodes: 2 });
    await rejected('openapi: 3.0.3\na: {$ref: "#/a"}\nb: {$ref: "#/b"}', 'references-exceeded', { maxReferences: 1 });
  });

  it('Given malformed, duplicate or multi-document syntax, when parsed, then it is rejected', async () => {
    for (const source of ['openapi: [', 'openapi: 3.0.3\nopenapi: 3.1.0', 'openapi: 3.0.3\n---\nopenapi: 3.1.0']) {
      await rejected(source, 'syntax-invalid');
    }
    for (const source of ['{"openapi":"3.0.3","openapi":"3.1.0"}', 'openapi: 3.0.3', '{"openapi":"3.0.3",}']) {
      await rejected(source, 'syntax-invalid', {}, 'json');
    }
  });

  it('Given YAML tags, anchors, aliases, merge keys or non-JSON values, when parsed, then no expansion is allowed', async () => {
    for (const source of [
      'openapi: 3.0.3\na: !!str secret',
      'openapi: 3.0.3\na: !custom secret',
      'openapi: 3.0.3\na: &a [1]\nb: *a',
      'openapi: 3.0.3\na: *missing',
      'openapi: 3.0.3\na: {<<: {b: 1}}',
      'openapi: 3.0.3\na: .inf',
      'openapi: 3.0.3\n? [a, b]\n: c',
      '%YAML 1.1\n---\nopenapi: 3.0.3',
    ])
      await rejected(source, 'unsupported-yaml');
  });

  it('Given any external or unsupported reference form, when inspected, then it is rejected as data', async () => {
    for (const ref of [
      'https://example.invalid/private',
      '//example.invalid/x',
      'file:///private',
      '../other.yaml',
      '/tmp/file',
      'data:text/plain,test',
      '#anchor',
      '#/bad~2',
      '#/%zz',
    ]) {
      await rejected(JSON.stringify({ openapi: '3.0.3', components: { $ref: ref } }), 'reference-unsupported');
    }
    for (const key of ['$id', '$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveRef', '$recursiveAnchor']) {
      await rejected(JSON.stringify({ openapi: '3.0.3', [key]: 'private' }), 'reference-unsupported');
    }
    await rejected('openapi: 3.0.3\na: {$ref: 123}', 'reference-unsupported');
  });

  it('Given syntactic local pointers, when preflight passes, then unresolved targets are not claimed valid', async () => {
    const result = await preflight('openapi: 3.0.3\na: {$ref: "#/missing~1item"}', 'yaml', policy);
    assert.deepEqual(result, { status: 'preflight-passed', schemaValidated: false, executionAuthorized: false });
  });

  it('Given server declarations and external references, when inspected, then the owned target receives no requests', async () => {
    const target = await startSyntheticApi();
    try {
      const document = { openapi: '3.0.3', servers: [{ url: target.origin }], paths: {} };
      assert.equal((await preflight(JSON.stringify(document), 'json', policy)).status, 'preflight-passed');
      await rejected(
        JSON.stringify({ ...document, components: { $ref: target.origin + '/health' } }),
        'reference-unsupported',
      );
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });

  it('Given missing, wrongly typed or unselected versions and invalid roots, then it fails closed', async () => {
    for (const source of ['{}', 'openapi: 3.2.0', 'openapi: 3', 'openapi: {x: 1}'])
      await rejected(source, 'version-not-allowed');
    for (const source of ['', '[]', 'null', 'hello']) await rejected(source, 'root-invalid');
  });

  it('Given private-looking synthetic text, when rejected, then diagnostics contain only code and numeric location', async () => {
    const source = 'openapi: 3.0.3\nprivate-synthetic-key: {$ref: "https://example.invalid/SYNTHETIC-SECRET"}';
    const result = await rejected(source, 'reference-unsupported');
    assert.deepEqual(result, { status: 'rejected', code: 'reference-unsupported', offset: source.indexOf('$ref') });
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private|https/);
  });

  it('Given a deadline expires, when the worker is starting, then it terminates and later calls still work', async () => {
    await rejected(valid, 'timeout', { timeoutMs: 1 });
    assert.equal((await preflight(valid, 'json', policy)).status, 'preflight-passed');
  });
});
