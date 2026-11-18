// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: Dev profile workload policy through k6 inspect and an in-memory k6 stand-in; it sends no traffic and starts no Docker runtime.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as limits from '../../performance/limits.js';
import { k6, readProfiles, readSummary, root, runner, workloadPath as workload } from './support.ts';

const profiles = readProfiles();
// The k6 script as plain script source, so it can run in a vm context with k6 stand-ins.
const workloadSource = readFileSync(workload, 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export default function (session)', 'function executeWorkload(session)')
  .replace(/export (const|function) /g, '$1 ');
interface RecordedCall {
  url: string;
  options: { headers: Record<string, string | undefined>; redirects: number };
}
/** Stand-in for k6's Counter; the workload only calls add(). */
class FakeCounter {
  added = 0;
  add(value: number) {
    this.added += value;
  }
}
interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  json: () => unknown;
}
function inspect(profile: string, selection: string, target = 'http://127.0.0.1:45000/') {
  return spawnSync(
    k6,
    [
      'inspect',
      '--env',
      `PERF_PROFILE=${profile}`,
      '--env',
      `PERF_WORKLOAD=${selection}`,
      '--env',
      `PERF_TARGET=${target}`,
      '--env',
      'PERF_OWNED_PORT=45000',
      workload,
    ],
    { cwd: root, env: {}, encoding: 'utf8', timeout: 5000 },
  );
}

describe('Owned Platform Dev workload policy without traffic', () => {
  it('counts login/logout inside both total request ceilings', () => {
    for (const name of ['dev-smoke', 'dev-baseline'] as const) {
      const spec = profiles.workloads[name];
      assert.equal(spec.ratePerSecond * spec.durationSeconds + 2, spec.maxRequests);
      assert.ok(spec.maxRequests <= profiles.hardLimits.maxRequestCount);
      const result = inspect('dev', name);
      assert.equal(result.status, 0, result.stderr);
      const options = JSON.parse(result.stdout) as {
        thresholds: { http_reqs: string[] };
        scenarios: { configured_workload: { maxVUs: number } };
      };
      assert.deepEqual(options.thresholds.http_reqs, [`count<=${spec.maxRequests}`]);
      assert.equal(options.scenarios.configured_workload.maxVUs, spec.vus);
    }
  });

  it('rejects cross-profile workloads and unapproved targets before traffic', () => {
    for (const [profile, name] of [
      ['dev', 'baseline'],
      ['direct-mock', 'dev-smoke'],
      ['production', 'dev-smoke'],
    ] as const) {
      assert.notEqual(inspect(profile, name).status, 0);
    }
    for (const target of [
      'https://127.0.0.1:45000/',
      'http://localhost:45000/',
      'http://127.0.0.2:45000/',
      'http://127.0.0.1:33336/',
      'http://127.0.0.1:38089/',
      'http://user:secret@127.0.0.1:45000/',
      'http://127.0.0.1:45000/path',
      'http://127.0.0.1:45000/?q=1',
      'http://127.0.0.1:45000/#fragment',
    ])
      assert.notEqual(inspect('dev', 'dev-smoke', target).status, 0);
  });

  it('uses the fixed Dev HTTP authority but only the owned random transport URL', () => {
    for (const profile of ['direct-mock', 'dev']) {
      const calls: RecordedCall[] = [];
      const response = (status: number, body: unknown): FakeResponse => ({
        status,
        headers: { 'Content-Type': 'application/json' },
        json: () => body,
      });
      const context = {
        __ENV: {
          PERF_PROFILE: profile,
          PERF_WORKLOAD: profile === 'dev' ? 'dev-smoke' : 'smoke',
          PERF_TARGET: 'http://127.0.0.1:45000/',
          PERF_OWNED_PORT: '45000',
          PERF_HOST: 'untrusted.invalid',
        },
        open: () => JSON.stringify(profiles),
        ...limits,
        Counter: FakeCounter,
        check: (value: FakeResponse, checks: Record<string, (value: FakeResponse) => boolean>) =>
          Object.values(checks).every((fn) => fn(value)),
        http: {
          post(url: string, _body: unknown, options: RecordedCall['options']) {
            calls.push({ url, options });
            return url.endsWith('/login')
              ? response(200, { token: 'rrdev_' + '0'.repeat(64), expires: 1 })
              : response(204, null);
          },
          get(url: string, options: RecordedCall['options']) {
            calls.push({ url, options });
            return response(200, {
              id: 'widget-1',
              active: true,
              version: '1',
              application: {
                id: '00000000-0000-4000-8000-000000000102',
                tenantId: '00000000-0000-4000-8000-000000000101',
              },
              environment: {
                id: '00000000-0000-4000-8000-000000000104',
                applicationId: '00000000-0000-4000-8000-000000000102',
              },
            });
          },
        },
      };
      vm.runInNewContext(
        workloadSource + '\nconst session = setup(); executeWorkload(session); teardown(session);',
        context,
      );
      assert.equal(calls.length, profile === 'dev' ? 3 : 1);
      for (const call of calls) {
        assert.ok(call.url.startsWith('http://127.0.0.1:45000/'));
        assert.equal(call.options.headers.Host, profile === 'dev' ? '127.0.0.1:33336' : undefined);
        assert.equal(call.options.redirects, 0);
      }
    }
  });

  it('refuses configuration above the shared ceilings inside k6 before any request', () => {
    const run = (config: typeof profiles) => {
      const calls: string[] = [];
      const context = {
        __ENV: {
          PERF_PROFILE: 'direct-mock',
          PERF_WORKLOAD: 'smoke',
          PERF_TARGET: 'http://127.0.0.1:45000/',
          PERF_OWNED_PORT: '45000',
        },
        open: () => JSON.stringify(config),
        ...limits,
        Counter: FakeCounter,
        check: () => true,
        http: {
          get: (url: string) => {
            calls.push(url);
          },
          post: (url: string) => {
            calls.push(url);
          },
        },
      };
      try {
        vm.runInNewContext(workloadSource, context);
        return { calls, error: '' };
      } catch (error) {
        return { calls, error: String(error) };
      }
    };
    assert.equal(run(profiles).error, '');
    const raisedCeiling = structuredClone(profiles);
    raisedCeiling.hardLimits.maxVus = limits.absoluteLimits.maxVus + 1;
    assert.match(run(raisedCeiling).error, /absolute safety ceilings/);
    const oversizedWorkload = structuredClone(profiles);
    oversizedWorkload.workloads.smoke.vus = profiles.hardLimits.maxVus + 1;
    const result = run(oversizedWorkload);
    assert.match(result.error, /hard safety ceiling/);
    assert.deepEqual(result.calls, []);
  });

  it('rejects mutable image references before Docker or Platform source access', () => {
    const result = spawnSync(
      process.execPath,
      [
        runner,
        '--profile',
        'dev',
        '--workload',
        'dev-smoke',
        '--platform-root',
        '/does-not-exist',
        '--platform-image',
        'latest',
      ],
      { cwd: root, env: {}, encoding: 'utf8', timeout: 5000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /immutable local image ID/);
    const summaryPath = /summary: (\.performance-results\/[^\s]+\.json)/.exec(result.stdout)?.[1];
    assert.ok(summaryPath, 'A pre-execution failure must retain a sanitized receipt');
    const { summary: receipt } = readSummary(path.join(root, summaryPath));
    assert.equal(receipt.phase, 'startup');
    assert.equal(receipt.runStatus, 'failed');
    assert.equal(receipt.metrics.requestCount, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /does-not-exist|Authorization|rrdev_/);
  });
});
