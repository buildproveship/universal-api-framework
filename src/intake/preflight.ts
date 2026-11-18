import { fork, type ChildProcess } from 'node:child_process';

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
  | 'policy-required'
  | 'input-invalid'
  | 'bytes-exceeded'
  | 'timeout'
  | 'worker-failed'
  | 'syntax-invalid'
  | 'unsupported-yaml'
  | 'depth-exceeded'
  | 'nodes-exceeded'
  | 'references-exceeded'
  | 'reference-unsupported'
  | 'version-not-allowed'
  | 'root-invalid';

export type SchemaFailureCode =
  FailureCode | 'schema-version-unsupported' | 'document-schema-invalid' | 'circular-reference-unsupported';

export type PreflightResult =
  | { status: 'preflight-passed'; schemaValidated: false; executionAuthorized: false }
  | { status: 'rejected'; code: FailureCode; offset?: number };

export type SchemaValidationResult =
  | {
      status: 'document-schema-passed';
      documentSchemaValidated: true;
      specificationConformanceValidated: false;
      importApproved: false;
      executionAuthorized: false;
    }
  | { status: 'rejected'; code: SchemaFailureCode; offset?: number };

export type IntakeResult = PreflightResult | SchemaValidationResult;

export function reject<Code extends SchemaFailureCode>(
  code: Code,
  offset?: number,
): { status: 'rejected'; code: Code; offset?: number } {
  return offset === undefined ? { status: 'rejected', code } : { status: 'rejected', code, offset };
}

// Conservative parser startup floors, exercised on Node 22 and 24. These are
// technical constraints, not defaults, customer limits, or a memory sandbox.
const MIN_HEAP_MB = 32;
const MIN_STACK_MB = 4;
const MAX_V8_INT = 2_147_483_647;

function snapshotPolicy(value: PreflightPolicy | undefined): PreflightPolicy | undefined {
  try {
    if (!value) return undefined;
    // Read each setting once and make all transferred fields explicit own data.
    // Object spread/structuredClone would drop inherited/non-enumerable limits.
    const versions = value.allowedOpenApiVersions;
    if (!Array.isArray(versions)) return undefined;
    const snapshot: PreflightPolicy = {
      maxBytes: value.maxBytes,
      maxDepth: value.maxDepth,
      maxNodes: value.maxNodes,
      maxReferences: value.maxReferences,
      timeoutMs: value.timeoutMs,
      workerHeapMb: value.workerHeapMb,
      workerStackMb: value.workerStackMb,
      allowedOpenApiVersions: Array.from(versions),
    };
    const numbers = [
      snapshot.maxBytes,
      snapshot.maxDepth,
      snapshot.maxNodes,
      snapshot.maxReferences,
      snapshot.timeoutMs,
      snapshot.workerHeapMb,
      snapshot.workerStackMb,
    ];
    if (
      !numbers.every((n) => Number.isSafeInteger(n) && n > 0) ||
      snapshot.timeoutMs > MAX_V8_INT ||
      snapshot.workerHeapMb < MIN_HEAP_MB ||
      snapshot.workerHeapMb > MAX_V8_INT ||
      snapshot.workerStackMb < MIN_STACK_MB ||
      snapshot.workerStackMb > Math.floor(MAX_V8_INT / 1024) ||
      snapshot.allowedOpenApiVersions.length === 0 ||
      !snapshot.allowedOpenApiVersions.every((v) => typeof v === 'string' && /^3\.(0|1)\.\d+$/.test(v))
    ) {
      return undefined;
    }
    return snapshot;
  } catch {
    // A throwing configuration accessor is not a usable policy.
    return undefined;
  }
}

/** In-memory preparation only. No route, upload, storage, identity, or target access. */
export async function preflight(
  source: string,
  format: 'json' | 'yaml',
  policy?: PreflightPolicy,
): Promise<PreflightResult> {
  const result = await runIntake(source, format, policy, 'preflight');
  if (result.status === 'rejected') {
    const code = result.code;
    return code === 'schema-version-unsupported' ||
      code === 'document-schema-invalid' ||
      code === 'circular-reference-unsupported'
      ? reject('worker-failed')
      : reject(code, result.offset);
  }
  return result.status === 'document-schema-passed' ? reject('worker-failed') : result;
}

/** Offline document-schema validation only; never import or execution approval. */
export async function validateDocumentSchema(
  source: string,
  format: 'json' | 'yaml',
  policy?: PreflightPolicy,
): Promise<SchemaValidationResult> {
  const result = await runIntake(source, format, policy, 'schema');
  return result.status === 'preflight-passed' ? reject('worker-failed') : result;
}

async function runIntake(
  // Untyped JavaScript callers can pass anything; the guards below fail closed.
  source: unknown,
  format: unknown,
  policy: PreflightPolicy | undefined,
  mode: 'preflight' | 'schema',
): Promise<IntakeResult> {
  const configured = snapshotPolicy(policy);
  if (!configured) return reject('policy-required');
  if (typeof source !== 'string' || (format !== 'json' && format !== 'yaml')) return reject('input-invalid');
  if (Buffer.byteLength(source, 'utf8') > configured.maxBytes) return reject('bytes-exceeded');

  let worker: ChildProcess;
  try {
    // A Worker thread can abort its entire host during V8 startup/OOM. Use a
    // separate Node process so fatal parser errors cannot abort the caller's V8.
    worker = fork(new URL('./preflight-worker.js', import.meta.url), [], {
      execPath: process.execPath,
      execArgv: [`--max-old-space-size=${configured.workerHeapMb}`, `--stack-size=${configured.workerStackMb * 1024}`],
      // Never inherit preload hooks, credentials or fatal-error diagnostic output.
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
  } catch {
    return reject('worker-failed');
  }
  return new Promise((resolve) => {
    let outcome: IntakeResult | undefined;
    const finish = (result: IntakeResult) => {
      if (outcome) return;
      outcome = result;
      clearTimeout(timer);
      worker.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      finish(reject('timeout'));
    }, configured.timeoutMs);
    worker.once('message', (result: IntakeResult) => {
      finish(result);
    });
    worker.once('error', () => {
      finish(reject('worker-failed'));
    });
    // Resolve only after the child has exited and IPC/stdio have closed.
    worker.once('close', () => {
      clearTimeout(timer);
      resolve(outcome ?? reject('worker-failed'));
    });
    worker.send({ source, format, policy: configured, mode }, (error) => {
      if (error) finish(reject('worker-failed'));
    });
  });
}
