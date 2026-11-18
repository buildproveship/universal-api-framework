// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: the performance runner CLI with pinned k6 against its owned synthetic loopback fixture; it does not start the Dev Platform runtime.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = path.join(root, 'performance', 'run.ts');
const configPath = path.join(root, 'performance', 'config', 'profiles.json');

function run(args: string[]) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function getSummaryPath(output: string) {
  const match = output.match(/summary: (\.performance-results\/[0-9TZ+-]+-[0-9a-f-]+\.json)/);
  assert.ok(match?.[1], 'run output should expose only the sanitized summary path');
  return path.join(root, match[1]);
}

describe('RRDAPI-10 local performance harness', { timeout: 30_000 }, () => {
  it('rejects unprepared Dev and arbitrary-target selections before runtime startup', async () => {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const dev = run(['--profile', 'dev', '--workload', 'smoke']);
    const override = run(['--profile', 'direct-mock', '--target', 'https://production.example']);
    const production = run(['--profile', 'production', '--workload', 'smoke']);

    assert.equal(config.profiles.dev.enabled, true);
    assert.deepEqual(config.profiles['direct-mock'].targetHostAllowlist, ['127.0.0.1']);
    assert.equal(config.workloads.baseline.vus, config.hardLimits.maxVus);
    assert.equal(config.workloads.baseline.ratePerSecond, config.hardLimits.maxRatePerSecond);
    assert.equal(config.workloads.baseline.durationSeconds, config.hardLimits.maxDurationSeconds);
    assert.equal(config.workloads.baseline.maxRequests, config.hardLimits.maxRequestCount);
    assert.notEqual(dev.status, 0);
    assert.match(dev.stderr, /Dev requires --platform-root/);
    assert.notEqual(override.status, 0);
    assert.match(override.stderr, /Allowed options/);
    assert.equal(override.stdout, '');
    assert.notEqual(production.status, 0);
    assert.match(production.stderr, /not present/);
  });

  it('rejects repeated, missing and option-like values before runtime startup', () => {
    const cases: [string[], RegExp][] = [
      [['--profile', 'direct-mock', '--profile', 'dev'], /--profile may be selected only once/],
      [['--workload'], /Allowed options/],
      [['--workload', '--fixture', 'passing'], /Allowed options/],
      [['--workload=--fixture'], /Allowed options/],
      [['smoke'], /Allowed options/],
    ];
    for (const [args, message] of cases) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, message, args.join(' '));
      assert.equal(result.stdout, '', args.join(' '));
    }
  });

  it('writes a sanitized summary for a passing bounded fixture run', async () => {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const result = run(['--profile', 'direct-mock', '--workload', 'smoke', '--fixture', 'passing']);

    assert.equal(result.status, 0, result.stderr);
    const summaryPath = getSummaryPath(result.stdout);
    const summaryText = await readFile(summaryPath, 'utf8');
    const summary = JSON.parse(summaryText);

    assert.equal(summary.environment, 'direct-mock');
    assert.equal(summary.profile, 'direct-mock');
    assert.equal(summary.workload, 'smoke');
    assert.equal(summary.k6Version, 'k6 v0.54.0');
    assert.equal(summary.runStatus, 'passed');
    assert.equal(summary.runExitCode, 0);
    assert.equal(summary.metrics.checksFailed, 0);
    assert.ok(summary.metrics.requestCount > 0);
    assert.ok(summary.metrics.throughputRequestsPerSecond > 0);
    assert.equal(summary.metrics.errorRate, 0);
    assert.deepEqual(Object.keys(summary.metrics.latencyMilliseconds), ['p50', 'p90', 'p95', 'p99']);
    assert.ok(Object.values(summary.metrics.latencyMilliseconds).every(Number.isFinite));
    assert.ok(summary.metrics.requestCount <= config.workloads.smoke.maxRequests);
    assert.doesNotMatch(summaryText, /Synthetic widget|widget-1|responseBody|Authorization/);
  });

  it('fails the run and records failed checks for the intentionally wrong business fixture', async () => {
    const result = run(['--profile', 'direct-mock', '--workload', 'smoke', '--fixture', 'failing']);

    assert.notEqual(result.status, 0);
    const summary = JSON.parse(await readFile(getSummaryPath(result.stdout), 'utf8'));

    assert.equal(summary.runStatus, 'failed');
    assert.notEqual(summary.runExitCode, 0);
    assert.ok(summary.metrics.checksFailed > 0);
    assert.ok(summary.metrics.checkPassRate < 1);
    assert.equal(summary.metrics.errorRate, 0);
  });

  it('does not follow a loopback redirect to a second fixture', async () => {
    const result = run(['--profile', 'direct-mock', '--workload', 'smoke', '--fixture', 'redirecting']);

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /redirect destination received traffic/);
    const summary = JSON.parse(await readFile(getSummaryPath(result.stdout), 'utf8'));

    assert.equal(summary.runStatus, 'failed');
    assert.notEqual(summary.runExitCode, 0);
    assert.equal(summary.metrics.requestCount, 2);
    assert.ok(summary.metrics.checksFailed > 0);
    assert.ok(summary.metrics.checkPassRate < 1);
  });
});
