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

    if (!['--profile', '--workload', '--fixture'].includes(option) || value === undefined) {
      throw new Error('Allowed options are --profile, --workload, and --fixture with configured values only.');
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

  if (!config.workloads[selection.workload]) {
    throw new Error('Workload is not present in the versioned performance configuration.');
  }

  if (!['passing', 'failing', 'redirecting'].includes(selection.fixture)) {
    throw new Error('Fixture mode must be "passing", "failing", or "redirecting".');
  }

  if (selection.profile !== 'direct-mock') {
    throw new Error('Only the harness-owned direct-mock fixture profile is currently executable.');
  }

  const k6Version = verifyK6();
  const revision = getRevision();
  await mkdir(summaryDirectory, { recursive: true });
  const summaryName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
  const summaryPath = path.join(summaryDirectory, summaryName);
  const redirectDestination =
    selection.fixture === 'redirecting' ? makeRedirectDestination() : undefined;
  const redirectTarget = redirectDestination
    ? await listenOnLoopback(redirectDestination.server)
    : undefined;
  const fixture = makeFixture(selection.fixture, redirectTarget);
  const baseUrl = await listenOnLoopback(fixture);

  try {
    const result = await runK6({
      PERF_TARGET: baseUrl,
      PERF_OWNED_PORT: new URL(baseUrl).port,
      PERF_WORKLOAD: selection.workload,
      PERF_REVISION: revision.revision,
      PERF_WORKTREE_DIRTY: String(revision.dirty),
      PERF_K6_VERSION: k6Version,
      PERF_SUMMARY_PATH: summaryPath,
    });

    if (redirectDestination && redirectDestination.requestCount !== 0) {
      throw new Error('The local redirect destination received traffic; refusing the run result.');
    }

    let summary;

    try {
      summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    } catch {
      const diagnostic = result.diagnostics
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-3)
        .join(' ')
        .replace(/https?:\/\/\S+/g, '[loopback target]')
        .slice(0, 360);
      throw new Error(
        `k6 exited with code ${result.code}; no sanitized summary was produced.` +
          (diagnostic ? ` ${diagnostic}` : ''),
      );
    }

    const outcome = result.interrupted ? 'cancelled' : result.code === 0 ? 'passed' : 'failed';
    summary.runStatus = outcome;
    summary.runExitCode = result.code;
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    console.log(
      `Direct mock-only ${selection.workload} ${outcome} with ${summary.metrics.requestCount} requests; ` +
        `summary: ${path.relative(projectRoot, summaryPath)}`,
    );

    if (result.interrupted) {
      process.exitCode = 130;
    } else {
      process.exitCode = result.code;
    }
  } finally {
    await Promise.all([
      closeServer(fixture),
      redirectDestination ? closeServer(redirectDestination.server) : Promise.resolve(),
    ]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Local performance harness failed.');
  process.exitCode = 1;
});
