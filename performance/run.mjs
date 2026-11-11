import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createK6Invocation, isolatedK6Environment } from './k6-runtime.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(projectRoot, 'performance', 'config', 'profiles.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const k6Path = path.join(projectRoot, '.tools', 'k6', 'k6');
const workloadPath = path.join(projectRoot, 'performance', 'workload.js');
const k6ConfigPath = path.join(projectRoot, 'performance', 'config', 'k6-isolated.json');
const summaryDirectory = path.join(projectRoot, '.performance-results');
const absoluteLimits = {
  maxVus: 2,
  maxRatePerSecond: 2,
  maxDurationSeconds: 10,
  maxRequestTimeoutMilliseconds: 1000,
  maxRequestCount: 20,
};

function parseArguments(args) {
  const parsed = { profile: 'direct-mock', workload: 'smoke', fixture: 'passing' };
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];

    if (!['--profile', '--workload', '--fixture', '--platform-root', '--platform-image'].includes(option) || value === undefined) {
      throw new Error('Allowed options are --profile, --workload, --fixture, --platform-root, and --platform-image with configured values only.');
    }

    const key = option.slice(2);

    if (seen.has(key)) {
      throw new Error(`Option ${option} may be selected only once.`);
    }

    seen.add(key);
    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function validateConfiguration() {
  const limits = config.hardLimits;

  for (const [name, maximum] of Object.entries(absoluteLimits)) {
    if (!Number.isInteger(limits[name]) || limits[name] < 1 || limits[name] > maximum) {
      throw new Error(`Configured hard limit "${name}" is invalid or exceeds its absolute safety ceiling.`);
    }
  }

  for (const [name, workload] of Object.entries(config.workloads)) {
    if (
      !Number.isInteger(workload.ratePerSecond) ||
      !Number.isInteger(workload.durationSeconds) ||
      !Number.isInteger(workload.vus) ||
      !Number.isInteger(workload.requestTimeoutMilliseconds) ||
      !Number.isInteger(workload.maxRequests) ||
      workload.ratePerSecond < 1 ||
      workload.durationSeconds < 1 ||
      workload.vus < 1 ||
      workload.requestTimeoutMilliseconds < 1 ||
      workload.ratePerSecond > limits.maxRatePerSecond ||
      workload.durationSeconds > limits.maxDurationSeconds ||
      workload.vus > limits.maxVus ||
      workload.requestTimeoutMilliseconds > limits.maxRequestTimeoutMilliseconds ||
      workload.ratePerSecond * workload.durationSeconds > limits.maxRequestCount ||
      workload.ratePerSecond * workload.durationSeconds > workload.maxRequests ||
      workload.maxRequests > limits.maxRequestCount
    ) {
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
    encoding: 'utf8', env: isolatedK6Environment(),
  });

  if (result.error || result.status !== 0 || !result.stdout.startsWith('k6 v0.54.0')) {
    throw new Error('Pinned k6 v0.54.0 is required. Install it with npm run perf:install-k6.');
  }

  return result.stdout.trim().split(/\s+/).slice(0, 2).join(' ');
}

function makeFixture(mode, redirectTarget) {
  return createServer((request, response) => {
    if (mode === 'redirecting' && request.method === 'GET' && request.url === '/widgets/widget-1') {
      response.writeHead(302, {
        Location: redirectTarget,
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

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();

  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    throw new Error('The performance fixture did not bind to IPv4 loopback.');
  }

  return `http://127.0.0.1:${address.port}/`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runK6(environment) {
  const invocation = createK6Invocation(environment, workloadPath, k6ConfigPath);
  const child = spawn(k6Path, invocation.args, {
    cwd: projectRoot,
    env: invocation.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (diagnostics.length < 8192) {
      diagnostics += chunk.slice(0, 8192 - diagnostics.length);
    }
  });
  let interrupted = false;
  const forwardSignal = (signal) => {
    interrupted = true;
    child.kill(signal);
  };
  const onInterrupt = () => forwardSignal('SIGINT');
  const onTerminate = () => forwardSignal('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not start the pinned k6 process.')));
    child.once('close', (code) => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      resolve({ code: code ?? 1, interrupted, diagnostics });
    });
  });
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
    throw new Error('Dev requires --platform-root at the pinned revision and --platform-image with verified source labels. No runtime was started.');
  }
  if (!isDev && (selection['platform-root'] || selection['platform-image'])) {
    throw new Error('Platform settings are accepted only by the owned Dev profile.');
  }
  if (!config.workloads[selection.workload] || !selectedProfile.workloads.includes(selection.workload)) {
    throw new Error('Workload is not present in the selected versioned performance profile.');
  }
  if (!(isDev ? ['passing', 'failing'] : ['passing', 'failing', 'redirecting']).includes(selection.fixture)) {
    throw new Error('Fixture mode is not supported by the selected profile.');
  }
  const workload = config.workloads[selection.workload];
  const totalRequests = workload.ratePerSecond * workload.durationSeconds + (isDev ? 2 : 0);
  if (totalRequests > workload.maxRequests || totalRequests > config.hardLimits.maxRequestCount) {
    throw new Error('Workload and authentication requests exceed the request ceiling.');
  }

  const k6Version = verifyK6();
  const revision = getRevision();
  await mkdir(summaryDirectory, { recursive: true });
  const summaryName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
  const summaryPath = path.join(summaryDirectory, summaryName);
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => { interrupted = true; controller.abort(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let platform;
  let fixture;
  let redirectDestination;
  let summary;
  let result;
  let failure;
  let cleanup;
  let k6Started = false;
  try {
    let baseUrl;
    if (isDev) {
      const { startPlatformRuntime } = await import('./platform-runtime.mjs');
      platform = await startPlatformRuntime({
        platformRoot: selection['platform-root'],
        image: selection['platform-image'],
        signal: controller.signal,
      });
      baseUrl = platform.baseUrl.replace(/\/?$/, '/');
    } else {
      redirectDestination = selection.fixture === 'redirecting' ? makeRedirectDestination() : undefined;
      const redirectTarget = redirectDestination ? await listenOnLoopback(redirectDestination.server) : undefined;
      fixture = makeFixture(selection.fixture, redirectTarget);
      baseUrl = await listenOnLoopback(fixture);
    }
    if (controller.signal.aborted) throw new Error('Owned runtime startup was cancelled.');
    k6Started = true;
    result = await runK6({
      PERF_TARGET: baseUrl,
      PERF_OWNED_PORT: new URL(baseUrl).port,
      PERF_PROFILE: selection.profile,
      PERF_EXPECT_FAILURE: String(isDev && selection.fixture === 'failing'),
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
      summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    } catch {
      // Child diagnostics may contain runtime data. Never persist or echo them.
      throw new Error(`k6 exited with code ${result.code}; no sanitized summary was produced.`);
    }
    if (platform && !interrupted) {
      summary.platform = await platform.evidence();
      if (!(summary.platform.matchedLoginRequests > 0) || summary.platform.unmatchedRequests !== 0 || !summary.platform.noDefaultRoute) {
        throw new Error('Actual Platform/WireMock login or isolation evidence is incomplete.');
      }
    }
  } catch (error) {
    failure = error;
    if (error?.settlement) cleanup = error.settlement;
  } finally {
    try {
      if (platform) {
        cleanup = await platform.close();
        if (!cleanup?.settled || !cleanup?.gracefulStopVerified) {
          throw new Error('Owned Platform runtime cleanup did not prove graceful settlement.');
        }
      }
      await Promise.all([
        fixture?.listening ? closeServer(fixture) : Promise.resolve(),
        redirectDestination?.server.listening ? closeServer(redirectDestination.server) : Promise.resolve(),
      ]);
    } catch (error) {
      if (error?.settlement) cleanup = error.settlement;
      failure ??= error;
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  const exitCode = interrupted || result?.interrupted ? 130 : failure ? 1 : result?.code ?? 1;
  const outcome = exitCode === 130 ? 'cancelled' : exitCode === 0 ? 'passed' : 'failed';
  if (!summary) {
    summary = {
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
  }
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
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Local performance harness failed.');
  process.exitCode ||= 1;
});
