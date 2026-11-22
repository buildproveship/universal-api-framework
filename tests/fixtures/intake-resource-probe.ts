// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: child-process probe for preflight resource floors and heap exhaustion, run only from intake-preflight.test.ts.
// Run only in a separate process: regressions in resource handling can abort Node.
import { parseArgs } from "node:util";
import { preflight, type PreflightPolicy } from "../../src/intake/preflight.js";

const policy: PreflightPolicy = {
  maxBytes: 16_384,
  maxDepth: 20,
  maxNodes: 500,
  maxReferences: 10,
  timeoutMs: 5_000,
  workerHeapMb: 32,
  workerStackMb: 4,
  allowedOpenApiVersions: ["3.0.3"],
};
const [mode] = parseArgs({ allowPositionals: true }).positionals;
if (mode === "bad-heap") policy.workerHeapMb = 1;
if (mode === "below-heap-floor") policy.workerHeapMb = 31;
if (mode === "bad-stack") policy.workerStackMb = 1;
if (mode === "below-stack-floor") policy.workerStackMb = 3;
if (mode === "heap-pressure") {
  const source =
    "openapi: 3.0.3\nitems:\n" +
    "  - {a: synthetic, b: synthetic}\n".repeat(150_000);
  const result = await preflight(source, "yaml", {
    ...policy,
    maxBytes: Buffer.byteLength(source),
    maxNodes: 2_000_000,
    timeoutMs: 10_000,
  });
  const recovery = await preflight("openapi: 3.0.3", "yaml", policy);
  console.log(JSON.stringify({ result, recovery }));
} else {
  console.log(
    JSON.stringify(await preflight("openapi: 3.0.3", "yaml", policy)),
  );
}
