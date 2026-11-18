// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: child-process probe for document-schema resource floors and heap exhaustion, run only from document-schema.test.ts.
import { validateDocumentSchema, type PreflightPolicy } from '../../src/intake/preflight.js';

const policy: PreflightPolicy = {
  maxBytes: 16_384,
  maxDepth: 20,
  maxNodes: 500,
  maxReferences: 10,
  timeoutMs: 5_000,
  workerHeapMb: 32,
  workerStackMb: 4,
  allowedOpenApiVersions: ['3.0.3'],
};
const valid = JSON.stringify({ openapi: '3.0.3', info: { title: 'Synthetic', version: '1' }, paths: {} });
const invalidResource = await validateDocumentSchema(valid, 'json', { ...policy, workerHeapMb: 1 });
const source = 'openapi: 3.0.3\nitems:\n' + '  - {a: synthetic, b: synthetic}\n'.repeat(150_000);
const exhausted = await validateDocumentSchema(source, 'yaml', {
  ...policy,
  maxBytes: Buffer.byteLength(source),
  maxNodes: 2_000_000,
  timeoutMs: 10_000,
});
const recovery = await validateDocumentSchema(valid, 'json', policy);
console.log(JSON.stringify({ invalidResource, exhausted, recovery }));
