import { Worker } from 'node:worker_threads';

/** Technical caller policy, not approved product limits. There are no defaults. */
export interface PreflightPolicy {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxReferences: number;
  timeoutMs: number;
  workerHeapMb: number;
  workerStackMb: number;
  allowedOpenApiVersions: readonly string[];
}

export type FailureCode =
  | 'policy-required' | 'input-invalid' | 'bytes-exceeded' | 'timeout'
  | 'worker-failed' | 'syntax-invalid' | 'unsupported-yaml' | 'depth-exceeded'
  | 'nodes-exceeded' | 'references-exceeded' | 'reference-unsupported'
  | 'version-not-allowed' | 'root-invalid';

export type PreflightResult =
  | { status: 'preflight-passed'; schemaValidated: false; executionAuthorized: false }
  | { status: 'rejected'; code: FailureCode; offset?: number };

export function reject(code: FailureCode, offset?: number): PreflightResult {
  return offset === undefined ? { status: 'rejected', code } : { status: 'rejected', code, offset };
}

function validPolicy(value: PreflightPolicy | undefined): value is PreflightPolicy {
  if (!value) return false;
  const numbers = [value.maxBytes, value.maxDepth, value.maxNodes, value.maxReferences,
    value.timeoutMs, value.workerHeapMb, value.workerStackMb];
  return numbers.every(n => Number.isSafeInteger(n) && n > 0)
    // Node timers clamp values outside this range to 1ms.
    && value.timeoutMs <= 2_147_483_647
    && Array.isArray(value.allowedOpenApiVersions)
    && value.allowedOpenApiVersions.length > 0
    && value.allowedOpenApiVersions.every(v => typeof v === 'string' && /^3\.(0|1)\.\d+$/.test(v));
}

/** In-memory preparation only. No route, upload, storage, identity, or target access. */
export async function preflight(
  source: string,
  format: 'json' | 'yaml',
  policy?: PreflightPolicy,
): Promise<PreflightResult> {
  if (!validPolicy(policy)) return reject('policy-required');
  if (typeof source !== 'string' || (format !== 'json' && format !== 'yaml')) return reject('input-invalid');
  if (Buffer.byteLength(source, 'utf8') > policy.maxBytes) return reject('bytes-exceeded');

  let worker: Worker;
  try {
    worker = new Worker(new URL('./preflight-worker.js', import.meta.url), {
      workerData: { source, format, policy },
      resourceLimits: {
        maxOldGenerationSizeMb: policy.workerHeapMb,
        maxYoungGenerationSizeMb: policy.workerHeapMb,
        stackSizeMb: policy.workerStackMb,
      },
    });
  } catch {
    return reject('worker-failed');
  }
  return new Promise(resolve => {
    let finished = false;
    const finish = async (result: PreflightResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Finish termination before returning, including timeout/error paths.
      try { await worker.terminate(); } catch { /* errors are deliberately not exposed */ }
      resolve(result);
    };
    const timer = setTimeout(() => { void finish(reject('timeout')); }, policy.timeoutMs);
    worker.once('message', (result: PreflightResult) => { void finish(result); });
    worker.once('error', () => { void finish(reject('worker-failed')); });
    worker.once('exit', () => { void finish(reject('worker-failed')); });
  });
}
