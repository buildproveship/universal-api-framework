import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { preflight, type FailureCode, type PreflightPolicy } from '../src/intake/preflight.js';
import { startSyntheticApi } from './fixtures/synthetic-api.js';

// Synthetic test settings only; these are not product limits or supported-version promises.
const policy: PreflightPolicy = {
  maxBytes: 16_384, maxDepth: 20, maxNodes: 500, maxReferences: 10,
  timeoutMs: 5_000, workerHeapMb: 32, workerStackMb: 4,
  allowedOpenApiVersions: ['3.0.3', '3.1.0'],
};
const valid = '{"openapi":"3.0.3","info":{"title":"Synthetic","version":"1"},"paths":{}}';

async function rejected(source: string, code: FailureCode, overrides = {}, format: 'json' | 'yaml' = 'yaml') {
  const result = await preflight(source, format, { ...policy, ...overrides });
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.code, code);
  return result;
}

describe('Inactive synthetic contract intake preflight', () => {
  it('Given JSON and YAML, when preflight passes, then schema and execution approval stay false', async () => {
    for (const [source, format] of [[valid, 'json'], ['openapi: 3.1.0\npaths: {}', 'yaml']] as const) {
      assert.deepEqual(await preflight(source, format, policy), {
        status: 'preflight-passed', schemaValidated: false, executionAuthorized: false,
      });
    }
  });

  it('Given missing or invalid policy, when called, then it fails closed', async () => {
    assert.deepEqual(await preflight(valid, 'json'), { status: 'rejected', code: 'policy-required' });
    for (const key of ['maxBytes', 'maxDepth', 'maxNodes', 'maxReferences', 'timeoutMs', 'workerHeapMb', 'workerStackMb']) {
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
    assert.equal((await preflight(valid, 'json', { ...policy, maxBytes: Buffer.byteLength(valid) })).status, 'preflight-passed');
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
      'openapi: 3.0.3\na: !!str secret', 'openapi: 3.0.3\na: !custom secret',
      'openapi: 3.0.3\na: &a [1]\nb: *a', 'openapi: 3.0.3\na: *missing',
      'openapi: 3.0.3\na: {<<: {b: 1}}', 'openapi: 3.0.3\na: .inf',
      'openapi: 3.0.3\n? [a, b]\n: c', '%YAML 1.1\n---\nopenapi: 3.0.3',
    ]) await rejected(source, 'unsupported-yaml');
  });

  it('Given any external or unsupported reference form, when inspected, then it is rejected as data', async () => {
    for (const ref of ['https://example.invalid/private', '//example.invalid/x', 'file:///private', '../other.yaml',
      '/tmp/file', 'data:text/plain,test', '#anchor', '#/bad~2', '#/%zz']) {
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
      await rejected(JSON.stringify({ ...document, components: { $ref: target.origin + '/health' } }), 'reference-unsupported');
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });

  it('Given missing, wrongly typed or unselected versions and invalid roots, then it fails closed', async () => {
    for (const source of ['{}', 'openapi: 3.2.0', 'openapi: 3', 'openapi: {x: 1}']) await rejected(source, 'version-not-allowed');
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
