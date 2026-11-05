import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { inspectInput } from '../src/intake/intake-inspection.js';
import { preflight, validateDocumentSchema, type PreflightPolicy } from '../src/intake/preflight.js';

const policy: PreflightPolicy = {
  maxBytes: 16_384, maxDepth: 20, maxNodes: 500, maxReferences: 10,
  timeoutMs: 5_000, workerHeapMb: 32, workerStackMb: 4,
  allowedOpenApiVersions: ['3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.0.4', '3.1.0'],
};
const document = (openapi = '3.0.3') => ({
  openapi, info: { title: 'Synthetic', version: '1' }, paths: {},
  components: { schemas: { Item: { type: 'string' }, Alias: { $ref: '#/components/schemas/Item' } } },
});
const success = {
  status: 'document-schema-passed', documentSchemaValidated: true,
  specificationConformanceValidated: false, importApproved: false, executionAuthorized: false,
};

describe('Offline OpenAPI 3.0 document-schema validation', () => {
  it('Given every claimed technical version, then document schemas and local references are checked', async () => {
    for (const version of ['3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.0.4']) {
      assert.deepEqual(await validateDocumentSchema(JSON.stringify(document(version)), 'json', policy), success);
      const invalid = document(version);
      invalid.components.schemas.Item.type = 'not-a-json-schema-type';
      const result = await validateDocumentSchema(JSON.stringify(invalid), 'json', policy);
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.equal(result.code, 'document-schema-invalid');
    }
  });

  it('Given explicit policy, then no default or unsupported 3.1 capability is inferred', async () => {
    const source = JSON.stringify(document());
    assert.deepEqual(await validateDocumentSchema(source, 'json'), { status: 'rejected', code: 'policy-required' });
    assert.deepEqual(await validateDocumentSchema(source, 'json', { ...policy, allowedOpenApiVersions: ['3.0.4'] }), {
      status: 'rejected', code: 'version-not-allowed',
    });
    const unsupported = await validateDocumentSchema(JSON.stringify(document('3.1.0')), 'json', policy);
    assert.equal(unsupported.status, 'rejected');
    if (unsupported.status === 'rejected') assert.equal(unsupported.code, 'schema-version-unsupported');
    const future = await validateDocumentSchema(JSON.stringify(document('3.0.99')), 'json', {
      ...policy, allowedOpenApiVersions: ['3.0.99'],
    });
    assert.equal(future.status, 'rejected');
    if (future.status === 'rejected') assert.equal(future.code, 'schema-version-unsupported');
    assert.deepEqual(await preflight(JSON.stringify(document('3.1.0')), 'json', policy), {
      status: 'preflight-passed', schemaValidated: false, executionAuthorized: false,
    });
  });

  it('Given unresolved and circular pointers, then neither is silently accepted', async () => {
    for (const [ref, code] of [
      ['#/components/schemas/Missing', 'document-schema-invalid'],
      ['#/components/schemas/Alias', 'circular-reference-unsupported'], ['#', 'circular-reference-unsupported'],
    ] as const) {
      const candidate = document();
      candidate.components.schemas.Alias.$ref = ref;
      assert.deepEqual(await validateDocumentSchema(JSON.stringify(candidate), 'json', policy), {
        status: 'rejected', code,
      });
    }
    const mutual = { ...document(), components: { schemas: {
      A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' },
    } } };
    const result = await validateDocumentSchema(JSON.stringify(mutual), 'json', policy);
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.code, 'circular-reference-unsupported');
    const recursive = { ...document(), components: { schemas: {
      Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } },
    } } };
    assert.deepEqual(await validateDocumentSchema(JSON.stringify(recursive), 'json', policy), {
      status: 'rejected', code: 'circular-reference-unsupported',
    });
  });

  it('Given invalid YAML schema values, then diagnostics map to original source without revealing it', async () => {
    const source = 'openapi: 3.0.3\ninfo:\n  title: 123\n  version: "SYNTHETIC-PRIVATE"\npaths: {}';
    assert.deepEqual(await validateDocumentSchema(source, 'yaml', policy), {
      status: 'rejected', code: 'document-schema-invalid', offset: source.indexOf('123'),
    });
    const invalid = { ...document(), components: { schemas: { 'SYNTHETIC-PRIVATE/~': { type: 'private-value' } } } };
    const result = await validateDocumentSchema(JSON.stringify(invalid), 'json', policy);
    assert.equal(result.status, 'rejected');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-value|components|schemas/);
    if (result.status === 'rejected' && result.offset !== undefined) assert.ok(Number.isInteger(result.offset));
  });

  it('Given dereferenced errors, then resolved children are not attributed to original reference siblings', async () => {
    const source = JSON.stringify({ ...document(), components: { schemas: {
      Alias: { $ref: '#/components/schemas/Target', type: 'string' }, Target: { type: 'invalid-type' },
    } } });
    const result = await validateDocumentSchema(source, 'json', policy);
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.equal(result.code, 'document-schema-invalid');
      assert.notEqual(result.offset, source.indexOf('"string"'));
    }
  });

  it('Given external references, unsafe YAML or excluded versions, then the validator is never invoked', async t => {
    const spy = t.mock.method(SwaggerParser, 'validate', async () => { throw new Error('must not invoke'); });
    for (const ref of ['https://example.invalid/private', 'file:///synthetic-private.yaml', '../synthetic.yaml']) {
      const candidate = document();
      candidate.components.schemas.Alias.$ref = ref;
      const result = await inspectInput({ source: JSON.stringify(candidate), format: 'json', policy, mode: 'schema' });
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.equal(result.code, 'reference-unsupported');
    }
    await inspectInput({ source: 'openapi: 3.0.3\na: !!str private', format: 'yaml', policy, mode: 'schema' });
    await inspectInput({ source: JSON.stringify(document('3.1.0')), format: 'json', policy, mode: 'schema' });
    assert.equal(spy.mock.callCount(), 0);
  });

  it('Given valid in-memory input, then all file/HTTP and secondary-parser hooks remain unused', async t => {
    // Load trusted code before interception; module loading is not document I/O.
    assert.deepEqual(await inspectInput({ source: JSON.stringify(document()), format: 'json', policy, mode: 'schema' }), success);
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('@apidevtools/json-schema-ref-parser'));
    const parsers = ['json', 'yaml', 'text', 'binary'].map(kind => require(join(root, 'parsers', kind + '.js')).default);
    const resolvers = ['file', 'http'].map(kind => require(join(root, 'resolvers', kind + '.js')).default);
    const denied = () => { throw new Error('document I/O forbidden'); };
    const spies = [t.mock.method(fs.promises, 'readFile', denied), t.mock.method(fs, 'readFileSync', denied),
      t.mock.method(http, 'request', denied), t.mock.method(https, 'request', denied), t.mock.method(globalThis, 'fetch', denied)];
    for (const parser of parsers) spies.push(t.mock.method(parser, 'parse', denied));
    for (const resolver of resolvers) spies.push(t.mock.method(resolver, 'read', denied));
    const candidate = { ...document(), servers: [{ url: 'https://example.invalid/private' }] };
    assert.deepEqual(await inspectInput({ source: JSON.stringify(candidate), format: 'json', policy, mode: 'schema' }), success);
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  });

  it('Given missing resources, timeout or process creation failure, then validation fails closed', async t => {
    const source = JSON.stringify(document());
    assert.deepEqual(await validateDocumentSchema(source, 'json', { ...policy, maxBytes: 1 }), { status: 'rejected', code: 'bytes-exceeded' });
    assert.deepEqual(await validateDocumentSchema(source, 'json', { ...policy, timeoutMs: 1 }), { status: 'rejected', code: 'timeout' });
    const spy = t.mock.method(childProcess, 'fork', () => { throw new Error('synthetic-private-startup-error'); });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(await validateDocumentSchema(source, 'json', policy), { status: 'rejected', code: 'worker-failed' });
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await validateDocumentSchema(source, 'json', policy), success);
  });

  it('Given isolated resource exhaustion, then the caller survives and a later schema validation succeeds', () => {
    const probe = childProcess.spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/schema-resource-probe.js', import.meta.url))], {
      encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 16_384,
    });
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, `status=${probe.status} signal=${probe.signal}`);
    assert.deepEqual(JSON.parse(probe.stdout), {
      invalidResource: { status: 'rejected', code: 'policy-required' },
      exhausted: { status: 'rejected', code: 'worker-failed' }, recovery: success,
    });
  });
});
