// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: offline OpenAPI 3.0 document-schema validation through validateDocumentSchema() and inspectInput() with the pinned libraries and synthetic documents; it does not prove full specification conformance.
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
  maxBytes: 16_384,
  maxDepth: 20,
  maxNodes: 500,
  maxReferences: 10,
  timeoutMs: 5_000,
  workerHeapMb: 32,
  workerStackMb: 4,
  allowedOpenApiVersions: ['3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.0.4', '3.1.0'],
};
const document = (openapi = '3.0.3') => ({
  openapi,
  info: { title: 'Synthetic', version: '1' },
  paths: {},
  components: { schemas: { Item: { type: 'string' }, Alias: { $ref: '#/components/schemas/Item' } } },
});
const success = {
  status: 'document-schema-passed',
  documentSchemaValidated: true,
  specificationConformanceValidated: false,
  importApproved: false,
  executionAuthorized: false,
};

describe('Offline OpenAPI 3.0 document-schema validation', () => {
  it('Given local pointers, then only exact own-property paths resolve', async () => {
    for (const [ref, extension, passes] of [
      ['#/components/schemas/__proto__', {}, false],
      ['#/x-schema/a/b', { 'a/b': { type: 'string' } }, false],
      ['#/x-schema/a~1b', { 'a/b': { type: 'string' } }, true],
      ['#/x-schema/a/b', { a: { b: { type: 'string' } } }, true],
      ['#/x-schema/__proto__', JSON.parse('{"__proto__":{"type":"string"}}') as object, true],
      ['#/x-schema/a%7E1b', { 'a/b': { type: 'string' } }, false],
      ['#/x-schema/a~01b', { 'a~1b': { type: 'string' } }, true],
      // Percent-encoded refs are explicitly outside the supported capability.
      ['#/x-schema/a%252Fb', { 'a%2Fb': { type: 'string' } }, false],
      ['#/x-schema/0', [{ type: 'string' }], true],
      ['#/x-schema/00', [{ type: 'string' }], false],
      ['#/x-schema/length', [{ type: 'string' }], false],
      ['#/x-schema/-', [{ type: 'string' }], false],
      ['#/x-schema/1', [{ type: 'string' }], false],
    ] as const) {
      const candidate = { ...document(), 'x-schema': extension };
      candidate.components.schemas.Alias.$ref = ref;
      const result = await validateDocumentSchema(JSON.stringify(candidate), 'json', policy);
      assert.equal(result.status, passes ? 'document-schema-passed' : 'rejected', ref);
      if (!passes && result.status === 'rejected')
        assert.equal(result.code, ref.includes('%') ? 'reference-unsupported' : 'document-schema-invalid');
    }
  });

  it('Given a reference in a forbidden location, then transformation cannot bypass schema checks', async () => {
    for (const schemas of [{ 'bad/name': { type: 'INVALID' } }, { Valid: { type: 'string' } }]) {
      const result = await validateDocumentSchema(
        JSON.stringify({
          ...document(),
          components: { $ref: '#/x-components' },
          'x-components': { schemas },
        }),
        'json',
        policy,
      );
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'document-schema-invalid');
    }
  });

  it('Given references in permitted OpenAPI locations, then valid parameters and responses still resolve', async () => {
    const candidate = {
      ...document(),
      paths: {
        '/item': {
          get: {
            parameters: [{ $ref: '#/components/parameters/Query' }],
            responses: { '200': { $ref: '#/components/responses/Ok' } },
          },
        },
      },
      components: {
        ...document().components,
        parameters: { Query: { name: 'q', in: 'query', schema: { type: 'string' } } },
        responses: { Ok: { description: 'Synthetic' } },
      },
    };
    assert.deepEqual(await validateDocumentSchema(JSON.stringify(candidate), 'json', policy), success);
  });

  it('Given encoded target collisions, then the resolver cannot validate a different target', async (t) => {
    const cases = [
      ['a%252Fb', 'a%2Fb', 'a/b'],
      ['a%2520b', 'a%20b', 'a b'],
      ['a%257E1b', 'a%7E1b', 'a/b'],
    ] as const;
    for (const [encoded, intended, alternate] of cases) {
      for (const intendedType of ['INVALID', 'string']) {
        const candidate = {
          ...document(),
          'x-schema': {
            [intended]: { type: intendedType },
            [alternate]: { type: intendedType === 'INVALID' ? 'string' : 'INVALID' },
          },
        };
        candidate.components.schemas.Alias.$ref = '#/x-schema/' + encoded;
        // One URI-fragment decode selects the intended own property.
        const token = decodeURIComponent(encoded).replaceAll('~1', '/').replaceAll('~0', '~');
        assert.equal(token, intended);
        assert.equal(candidate['x-schema'][token]?.type, intendedType);
        const result = await validateDocumentSchema(JSON.stringify(candidate), 'json', policy);
        assert.deepEqual(result, { status: 'rejected', code: 'reference-unsupported' }, encoded + ':' + intendedType);
      }
    }
    const spy = t.mock.method(SwaggerParser.prototype, 'dereference', () =>
      Promise.reject(new Error('must not resolve ambiguous encoding')),
    );
    const nested = {
      ...document(),
      'x-schema': {
        'a%2Fb': { type: 'INVALID' },
        a: { b: { type: 'string' } },
      },
    };
    nested.components.schemas.Alias.$ref = '#/x-schema/a%252Fb';
    const result = await inspectInput({ source: JSON.stringify(nested), format: 'json', policy, mode: 'schema' });
    assert.deepEqual(result, { status: 'rejected', code: 'reference-unsupported' });
    assert.equal(spy.mock.callCount(), 0);
  });

  it('Given every claimed technical version, then document schemas and local references are checked', async () => {
    for (const version of ['3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.0.4']) {
      assert.deepEqual(await validateDocumentSchema(JSON.stringify(document(version)), 'json', policy), success);
      const invalid = document(version);
      invalid.components.schemas.Item.type = 'not-a-json-schema-type';
      const result = await validateDocumentSchema(JSON.stringify(invalid), 'json', policy);
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'document-schema-invalid');
    }
  });

  it('Given explicit policy, then no default or unsupported 3.1 capability is inferred', async () => {
    const source = JSON.stringify(document());
    assert.deepEqual(await validateDocumentSchema(source, 'json'), { status: 'rejected', code: 'policy-required' });
    assert.deepEqual(await validateDocumentSchema(source, 'json', { ...policy, allowedOpenApiVersions: ['3.0.4'] }), {
      status: 'rejected',
      code: 'version-not-allowed',
    });
    const unsupported = await validateDocumentSchema(JSON.stringify(document('3.1.0')), 'json', policy);
    assert.equal(unsupported.status, 'rejected');
    assert.equal(unsupported.code, 'schema-version-unsupported');
    const future = await validateDocumentSchema(JSON.stringify(document('3.0.99')), 'json', {
      ...policy,
      allowedOpenApiVersions: ['3.0.99'],
    });
    assert.equal(future.status, 'rejected');
    assert.equal(future.code, 'schema-version-unsupported');
    assert.deepEqual(await preflight(JSON.stringify(document('3.1.0')), 'json', policy), {
      status: 'preflight-passed',
      schemaValidated: false,
      executionAuthorized: false,
    });
  });

  it('Given unresolved and circular pointers, then neither is silently accepted', async () => {
    for (const [ref, code] of [
      ['#/components/schemas/Missing', 'document-schema-invalid'],
      ['#/components/schemas/Alias', 'circular-reference-unsupported'],
      ['#', 'circular-reference-unsupported'],
    ] as const) {
      const candidate = document();
      candidate.components.schemas.Alias.$ref = ref;
      assert.deepEqual(await validateDocumentSchema(JSON.stringify(candidate), 'json', policy), {
        status: 'rejected',
        code,
      });
    }
    const mutual = {
      ...document(),
      components: {
        schemas: {
          A: { $ref: '#/components/schemas/B' },
          B: { $ref: '#/components/schemas/A' },
        },
      },
    };
    const result = await validateDocumentSchema(JSON.stringify(mutual), 'json', policy);
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'circular-reference-unsupported');
    const recursive = {
      ...document(),
      components: {
        schemas: {
          Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } },
        },
      },
    };
    assert.deepEqual(await validateDocumentSchema(JSON.stringify(recursive), 'json', policy), {
      status: 'rejected',
      code: 'circular-reference-unsupported',
    });
  });

  it('Given invalid YAML schema values, then diagnostics map to original source without revealing it', async () => {
    const source = 'openapi: 3.0.3\ninfo:\n  title: 123\n  version: "SYNTHETIC-PRIVATE"\npaths: {}';
    assert.deepEqual(await validateDocumentSchema(source, 'yaml', policy), {
      status: 'rejected',
      code: 'document-schema-invalid',
      offset: source.indexOf('123'),
    });
    const invalid = { ...document(), components: { schemas: { 'SYNTHETIC-PRIVATE/~': { type: 'private-value' } } } };
    const result = await validateDocumentSchema(JSON.stringify(invalid), 'json', policy);
    assert.equal(result.status, 'rejected');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private-value|components|schemas/);
    if (result.offset !== undefined) assert.ok(Number.isInteger(result.offset));
  });

  it('Given dereferenced errors, then resolved children are not attributed to original reference siblings', async () => {
    const source = JSON.stringify({
      ...document(),
      components: {
        schemas: {
          Alias: { $ref: '#/components/schemas/Target', type: 'string' },
          Target: { type: 'invalid-type' },
        },
      },
    });
    const result = await validateDocumentSchema(source, 'json', policy);
    assert.equal(result.status, 'rejected');
    {
      assert.equal(result.code, 'document-schema-invalid');
      assert.notEqual(result.offset, source.indexOf('"string"'));
    }
  });

  it('Given external references, unsafe YAML or excluded versions, then the validator is never invoked', async (t) => {
    const spy = t.mock.method(SwaggerParser.prototype, 'dereference', () =>
      Promise.reject(new Error('must not invoke')),
    );
    for (const ref of ['https://example.invalid/private', 'file:///synthetic-private.yaml', '../synthetic.yaml']) {
      const candidate = document();
      candidate.components.schemas.Alias.$ref = ref;
      const result = await inspectInput({ source: JSON.stringify(candidate), format: 'json', policy, mode: 'schema' });
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'reference-unsupported');
    }
    await inspectInput({ source: 'openapi: 3.0.3\na: !!str private', format: 'yaml', policy, mode: 'schema' });
    await inspectInput({ source: JSON.stringify(document('3.1.0')), format: 'json', policy, mode: 'schema' });
    assert.equal(spy.mock.callCount(), 0);
  });

  it('Given valid in-memory input, then all file/HTTP and secondary-parser hooks remain unused', async (t) => {
    // Load trusted code before interception; module loading is not document I/O.
    assert.deepEqual(
      await inspectInput({ source: JSON.stringify(document()), format: 'json', policy, mode: 'schema' }),
      success,
    );
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('@apidevtools/json-schema-ref-parser'));
    // The ref-parser's internal parser and resolver plugins, loaded the same way the library loads them.
    const plugin = (path: string) => (require(join(root, path)) as { default: Record<string, () => unknown> }).default;
    const parsers = ['json', 'yaml', 'text', 'binary'].map((kind) => plugin(`parsers/${kind}.js`));
    const resolvers = ['file', 'http'].map((kind) => plugin(`resolvers/${kind}.js`));
    const denied = () => {
      throw new Error('document I/O forbidden');
    };
    const spies: { mock: { callCount: () => number } }[] = [
      t.mock.method(fs.promises, 'readFile', denied),
      t.mock.method(fs, 'readFileSync', denied),
      t.mock.method(http, 'request', denied),
      t.mock.method(https, 'request', denied),
      t.mock.method(globalThis, 'fetch', denied),
    ];
    for (const parser of parsers) spies.push(t.mock.method(parser, 'parse', denied));
    for (const resolver of resolvers) spies.push(t.mock.method(resolver, 'read', denied));
    const candidate = { ...document(), servers: [{ url: 'https://example.invalid/private' }] };
    assert.deepEqual(
      await inspectInput({ source: JSON.stringify(candidate), format: 'json', policy, mode: 'schema' }),
      success,
    );
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  });

  it('Given missing resources, timeout or process creation failure, then validation fails closed', async (t) => {
    const source = JSON.stringify(document());
    assert.deepEqual(await validateDocumentSchema(source, 'json', { ...policy, maxBytes: 1 }), {
      status: 'rejected',
      code: 'bytes-exceeded',
    });
    assert.deepEqual(await validateDocumentSchema(source, 'json', { ...policy, timeoutMs: 1 }), {
      status: 'rejected',
      code: 'timeout',
    });
    const spy = t.mock.method(childProcess, 'fork', () => {
      throw new Error('synthetic-private-startup-error');
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(await validateDocumentSchema(source, 'json', policy), {
        status: 'rejected',
        code: 'worker-failed',
      });
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await validateDocumentSchema(source, 'json', policy), success);
  });

  it('Given isolated resource exhaustion, then the caller survives and a later schema validation succeeds', () => {
    const probe = childProcess.spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/schema-resource-probe.js', import.meta.url))],
      {
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16_384,
      },
    );
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, `status=${probe.status} signal=${probe.signal}`);
    assert.deepEqual(JSON.parse(probe.stdout), {
      invalidResource: { status: 'rejected', code: 'policy-required' },
      exhausted: { status: 'rejected', code: 'worker-failed' },
      recovery: success,
    });
  });
});
