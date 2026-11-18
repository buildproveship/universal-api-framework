import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createK6Invocation, isolatedK6Environment } from './k6-runtime.ts';
import {
  hardLimitsWithinCeilings,
  lifecycleRequestCount,
  workloadWithinLimits,
  type HardLimits,
  type Workload,
} from './limits.js';
import { closeServer, listenOnLoopback } from './loopback.ts';
import type { PlatformRuntime } from './platform-runtime.ts';
import { settlementOf, type Settlement } from './settlement.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(projectRoot, 'performance', 'config', 'profiles.json');
interface Profile {
  enabled: boolean;
  blockedReason?: string;
  environment: string;
  mockBoundaries: string;
  workloads: string[];
}
interface PerformanceConfig {
  hardLimits: HardLimits;
  profiles: Record<string, Profile | undefined>;
  workloads: Record<string, Workload | undefined>;
}
interface Selection {
  profile: string;
  workload: string;
  fixture: string;
  'platform-root'?: string;
  'platform-image'?: string;
}
type FixtureMode = 'passing' | 'failing' | 'redirecting';
// Untrusted until validateConfiguration() has run.
const config = JSON.parse(await readFile(configPath, 'utf8')) as PerformanceConfig;
/** Sanitized run summary written by the k6 workload and completed here. */
interface RunSummary {
  metrics: { requestCount: number | null };
  platform?: Awaited<ReturnType<PlatformRuntime['evidence']>>;
  runStatus?: string;
  runExitCode?: number;
  cleanup?: Settlement | { complete: false };
  [field: string]: unknown;
}
const k6Path = path.join(projectRoot, '.tools', 'k6', 'k6');
const workloadPath = path.join(projectRoot, 'performance', 'workload.js');
const k6ConfigPath = path.join(projectRoot, 'performance', 'config', 'k6-isolated.json');
const summaryDirectory = path.join(projectRoot, '.performance-results');
const allowedOptions = ['profile', 'workload', 'fixture', 'platform-root', 'platform-image'] as const;
const optionError =
  'Allowed options are --profile, --workload, --fixture, --platform-root, and --platform-image with configured values only.';

function parseArguments(args: string[]): Selection {
  let parsed: Partial<Record<string, string[]>>;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: Object.fromEntries(allowedOptions.map((name) => [name, { type: 'string' as const, multiple: true }])),
    }).values;
  } catch {
    throw new Error(optionError);
  }
  const selection: Selection = { profile: 'direct-mock', workload: 'smoke', fixture: 'passing' };
  for (const key of allowedOptions) {
    const values = parsed[key];
    if (values === undefined) continue;
    if (values.length !== 1) throw new Error(`Option --${key} may be selected only once.`);
    const [value = ''] = values;
    // parseArgs accepts "--profile=--workload"; a value must never look like an option.
    if (value.startsWith('--')) throw new Error(optionError);
    selection[key] = value;
  }
  return selection;
}

function validateConfiguration() {
  if (!hardLimitsWithinCeilings(config.hardLimits)) {
    throw new Error('A configured hard limit is invalid or exceeds its absolute safety ceiling.');
  }
  for (const [name, workload] of Object.entries(config.workloads)) {
    if (!workloadWithinLimits(workload, config.hardLimits)) {
      throw new Error(`Configured workload "${name}" is invalid or exceeds a hard safety ceiling.`);
    }
  }
}

function getRevision() {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (revision.status !== 0 || status.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(revision.stdout)) {
    throw new Error('Could not determine the source revision for the sanitized run summary.');
  }

  return { revision: revision.stdout.trim(), dirty: status.stdout.length > 0 };
}

function verifyK6() {
  const result = spawnSync(k6Path, ['version', '--log-output=stderr'], {
    encoding: 'utf8',
    env: isolatedK6Environment(),
  });

  if (result.error || result.status !== 0 || !result.stdout.startsWith('k6 v0.54.0')) {
    throw new Error('Pinned k6 v0.54.0 is required. Install it with npm run perf:install-k6.');
  }

  return result.stdout.trim().split(/\s+/).slice(0, 2).join(' ');
}

function makeFixture(mode: FixtureMode, redirectTarget: string | undefined): Server {
  return createServer((request, response) => {
    if (mode === 'redirecting' && request.method === 'GET' && request.url === '/widgets/widget-1') {
      response.writeHead(302, {
        Location: redirectTarget ?? '',
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ id: 'redirected-widget', active: true, version: '1' }));
      return;
    }

    if (request.method !== 'GET' || request.url !== '/widgets/widget-1') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        id: mode === 'failing' ? 'unexpected-widget' : 'widget-1',
        active: true,
        version: '1',
      }),
    );
  });
}

function makeRedirectDestination() {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'unexpected_redirect_follow' }));
  });

  return {
    server,
    get requestCount() {
      return requestCount;
    },
  };
}

function runK6(
  environment: Record<string, string>,
): Promise<{ code: number; interrupted: boolean; diagnostics: string }> {
  const invocation = createK6Invocation(environment, workloadPath, k6ConfigPath);
  const child = spawn(k6Path, invocation.args, {
    cwd: projectRoot,
    env: invocation.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (diagnostics.length < 8192) {
      diagnostics += chunk.slice(0, 8192 - diagnostics.length);
    }
  });
  let interrupted = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    interrupted = true;
    child.kill(signal);
  };
  const onInterrupt = () => {
    forwardSignal('SIGINT');
  };
  const onTerminate = () => {
    forwardSignal('SIGTERM');
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  return new Promise((resolve, reject) => {
    child.once('error', () => {
      reject(new Error('Could not start the pinned k6 process.'));
    });
    child.once('close', (code) => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      resolve({ code: code ?? 1, interrupted, diagnostics });
    });
  });
}

/** Closes everything the run owns. Never throws: a cleanup failure is returned with any evidence. */
async function releaseRuntime(
  platform: PlatformRuntime | undefined,
  servers: (Server | undefined)[],
): Promise<{ cleanup?: Settlement | undefined; error?: unknown }> {
  let cleanup: Settlement | undefined;
  try {
    if (platform) {
      cleanup = await platform.close();
      if (!cleanup.settled || !cleanup.gracefulStopVerified) {
        throw new Error('Owned Platform runtime cleanup did not prove graceful settlement.');
      }
    }
    await Promise.all(servers.flatMap((server) => (server ? [closeServer(server)] : [])));
    return { cleanup };
  } catch (error) {
    return { cleanup: settlementOf(error) ?? cleanup, error };
  }
}

async function main() {
  validateConfiguration();
  const selection = parseArguments(process.argv.slice(2));
  const selectedProfile = config.profiles[selection.profile];

  if (!selectedProfile) {
    throw new Error('Profile is not present in the versioned performance configuration.');
  }

  if (!selectedProfile.enabled) {
    throw new Error(selectedProfile.blockedReason);
  }

  const isDev = selection.profile === 'dev';
  if (isDev && (!selection['platform-root'] || !selection['platform-image'])) {
    throw new Error(
      'Dev requires --platform-root at the pinned revision and --platform-image with verified source labels. No runtime was started.',
    );
  }
  if (!isDev && (selection['platform-root'] || selection['platform-image'])) {
    throw new Error('Platform settings are accepted only by the owned Dev profile.');
  }
  if (!config.workloads[selection.workload] || !selectedProfile.workloads.includes(selection.workload)) {
    throw new Error('Workload is not present in the selected versioned performance profile.');
  }
  const fixtureMode = (isDev ? ['passing', 'failing'] : (['passing', 'failing', 'redirecting'] as const)).find(
    (mode): mode is FixtureMode => mode === selection.fixture,
  );
  if (!fixtureMode) {
    throw new Error('Fixture mode is not supported by the selected profile.');
  }
  const workload = config.workloads[selection.workload];
  if (!workloadWithinLimits(workload, config.hardLimits, lifecycleRequestCount(selection.profile))) {
    throw new Error('Workload and authentication requests exceed the request ceiling.');
  }

  const k6Version = verifyK6();
  const revision = getRevision();
  await mkdir(summaryDirectory, { recursive: true });
  const summaryName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
  const summaryPath = path.join(summaryDirectory, summaryName);
  const controller = new AbortController();
  // Aborted only by SIGINT/SIGTERM. A function, so each read sees the live state.
  const interrupt = () => {
    controller.abort();
  };
  const isInterrupted = () => controller.signal.aborted;
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let platform: PlatformRuntime | undefined;
  let fixture: Server | undefined;
  let redirectDestination: ReturnType<typeof makeRedirectDestination> | undefined;
  let summary: RunSummary | undefined;
  let result: Awaited<ReturnType<typeof runK6>> | undefined;
  let failure: unknown;
  let cleanup: Settlement | undefined;
  let k6Started = false;
  try {
    let baseUrl: string;
    if (isDev) {
      const { startPlatformRuntime } = await import('./platform-runtime.ts');
      platform = await startPlatformRuntime({
        platformRoot: selection['platform-root'],
        image: selection['platform-image'],
        signal: controller.signal,
      });
      baseUrl = platform.baseUrl.replace(/\/?$/, '/');
    } else {
      redirectDestination = fixtureMode === 'redirecting' ? makeRedirectDestination() : undefined;
      const redirectTarget = redirectDestination ? `${await listenOnLoopback(redirectDestination.server)}/` : undefined;
      fixture = makeFixture(fixtureMode, redirectTarget);
      baseUrl = `${await listenOnLoopback(fixture)}/`;
    }
    if (controller.signal.aborted) throw new Error('Owned runtime startup was cancelled.');
    k6Started = true;
    result = await runK6({
      PERF_TARGET: baseUrl,
      PERF_OWNED_PORT: new URL(baseUrl).port,
      PERF_PROFILE: selection.profile,
      PERF_EXPECT_FAILURE: String(isDev && fixtureMode === 'failing'),
      PERF_WORKLOAD: selection.workload,
      PERF_REVISION: revision.revision,
      PERF_WORKTREE_DIRTY: String(revision.dirty),
      PERF_K6_VERSION: k6Version,
      PERF_SUMMARY_PATH: summaryPath,
    });
    if (redirectDestination && redirectDestination.requestCount !== 0) {
      throw new Error('The local redirect destination received traffic; refusing the run result.');
    }
    try {
      summary = JSON.parse(await readFile(summaryPath, 'utf8')) as RunSummary;
    } catch {
      // Child diagnostics may contain runtime data. Never persist or echo them.
      throw new Error(`k6 exited with code ${result.code}; no sanitized summary was produced.`);
    }
    if (platform && !isInterrupted()) {
      const evidence = await platform.evidence();
      summary.platform = evidence;
      if (!(evidence.matchedLoginRequests > 0) || evidence.unmatchedRequests !== 0 || !evidence.noDefaultRoute) {
        throw new Error('Actual Platform/WireMock login or isolation evidence is incomplete.');
      }
    }
  } catch (error) {
    failure = error;
    cleanup = settlementOf(error) ?? cleanup;
  } finally {
    const released = await releaseRuntime(platform, [fixture, redirectDestination?.server]);
    cleanup = released.cleanup ?? cleanup;
    failure ??= released.error;
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  const interrupted = isInterrupted();
  const exitCode = interrupted || result?.interrupted ? 130 : failure ? 1 : (result?.code ?? 1);
  const outcome = exitCode === 130 ? 'cancelled' : exitCode === 0 ? 'passed' : 'failed';
  summary ??= {
    schemaVersion: 1,
    codeRevision: revision.revision,
    workingTreeDirty: revision.dirty,
    k6Version,
    environment: selectedProfile.environment,
    profile: selection.profile,
    workload: selection.workload,
    mockBoundaries: selectedProfile.mockBoundaries,
    phase: k6Started ? 'execution' : 'startup',
    metrics: { requestCount: k6Started ? null : 0 },
    failureCode: interrupted ? 'cancelled' : 'runtime_or_summary_unavailable',
  };
  {
    summary.runStatus = outcome;
    summary.runExitCode = exitCode;
    if (isDev) summary.cleanup = cleanup ?? { complete: false };
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      `${isDev ? 'Owned Platform Dev' : 'Direct mock-only'} ${selection.workload} ${outcome} with ${summary.metrics.requestCount ?? 'unknown'} requests; ` +
        `summary: ${path.relative(projectRoot, summaryPath)}`,
    );
  }
  process.exitCode = exitCode;
  if (failure) throw failure instanceof Error ? failure : new Error('Local performance harness failed.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Local performance harness failed.');
  process.exitCode ??= 1;
});
