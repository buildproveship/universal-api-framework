// Test classification: unit
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: the shared performance safety ceilings used by the Node runner and the k6 workload; it does not start k6 or a fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  absoluteLimits, hardLimitsWithinCeilings, lifecycleRequestCount, workloadWithinLimits,
} from '../performance/limits.js';

const profiles = JSON.parse(readFileSync(new URL('../performance/config/profiles.json', import.meta.url), 'utf8'));
const limits = { ...absoluteLimits };
const workload = { vus: 1, ratePerSecond: 1, durationSeconds: 2, requestTimeoutMilliseconds: 1000, maxRequests: 2 };

describe('Shared performance safety ceilings', () => {
  it('Given the versioned profiles, then every workload and its lifecycle requests fit the hard limits', () => {
    assert.equal(hardLimitsWithinCeilings(profiles.hardLimits), true);
    for (const [name, profile] of Object.entries(profiles.profiles)) {
      for (const selected of profile.workloads) {
        assert.equal(workloadWithinLimits(profiles.workloads[selected], profiles.hardLimits, lifecycleRequestCount(name)), true, selected);
      }
    }
  });

  it('Given a hard limit above its absolute ceiling or not a positive integer, then the limits are refused', () => {
    for (const name of Object.keys(absoluteLimits)) {
      for (const value of [absoluteLimits[name] + 1, 0, 1.5, '1', undefined]) {
        assert.equal(hardLimitsWithinCeilings({ ...limits, [name]: value }), false, `${name}=${value}`);
      }
    }
    assert.equal(hardLimitsWithinCeilings(undefined), false);
  });

  it('Given a workload over any configured limit, then it is refused', () => {
    assert.equal(workloadWithinLimits(workload, limits), true);
    for (const override of [
      { vus: 3 }, { ratePerSecond: 3 }, { durationSeconds: 11 }, { requestTimeoutMilliseconds: 1001 },
      { maxRequests: 21 }, { vus: 0 }, { maxRequests: 1.5 }, { ratePerSecond: undefined },
    ]) {
      assert.equal(workloadWithinLimits({ ...workload, ...override }, limits), false, JSON.stringify(override));
    }
    assert.equal(workloadWithinLimits({ ...workload, ratePerSecond: 2, durationSeconds: 10, maxRequests: 20 }, limits), true);
    assert.equal(workloadWithinLimits({ ...workload, ratePerSecond: 2, durationSeconds: 10, maxRequests: 20 }, { ...limits, maxRequestCount: 19 }), false);
    assert.equal(workloadWithinLimits(undefined, limits), false);
  });

  it('Given Dev login and logout, then they count against both request ceilings', () => {
    assert.equal(lifecycleRequestCount('dev'), 2);
    assert.equal(lifecycleRequestCount('direct-mock'), 0);
    assert.equal(workloadWithinLimits(workload, limits, lifecycleRequestCount('dev')), false);
    assert.equal(workloadWithinLimits({ ...workload, maxRequests: 4 }, limits, lifecycleRequestCount('dev')), true);
  });
});
