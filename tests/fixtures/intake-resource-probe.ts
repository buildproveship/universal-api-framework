// Run only in a separate process: regressions in resource handling can abort Node.
import { preflight, type PreflightPolicy } from '../../src/intake/preflight.js';

const policy: PreflightPolicy = {
  maxBytes: 16_384, maxDepth: 20, maxNodes: 500, maxReferences: 10,
  timeoutMs: 5_000, workerHeapMb: 32, workerStackMb: 4,
  allowedOpenApiVersions: ['3.0.3'],
};
if (process.argv[2] === 'bad-heap') policy.workerHeapMb = 1;
if (process.argv[2] === 'below-heap-floor') policy.workerHeapMb = 31;
if (process.argv[2] === 'bad-stack') policy.workerStackMb = 1;
if (process.argv[2] === 'below-stack-floor') policy.workerStackMb = 3;
if (process.argv[2] === 'heap-pressure') {
  const source = 'openapi: 3.0.3\nitems:\n' + '  - {a: synthetic, b: synthetic}\n'.repeat(150_000);
  const result = await preflight(source, 'yaml', {
    ...policy, maxBytes: Buffer.byteLength(source), maxNodes: 2_000_000, timeoutMs: 10_000,
  });
  const recovery = await preflight('openapi: 3.0.3', 'yaml', policy);
  console.log(JSON.stringify({ result, recovery }));
} else {
  console.log(JSON.stringify(await preflight('openapi: 3.0.3', 'yaml', policy)));
}
