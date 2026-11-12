import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { admitSettings, revalidateSettings, withCustomerCredential } from '../src/settings-admission.js';
import type { ApiTestSettings, LocalExecutionPolicy, ManagedReferences } from '../src/settings-admission.js';
import { startSyntheticApi } from './fixtures/synthetic-api.js';

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  environmentId: '00000000-0000-4000-8000-000000000003',
} as const;
const limits = {
  maxRequests: 10,
  timeoutMs: 1_000,
  requestsPerMinute: 5,
  maxConcurrency: 1,
  maxBodyBytes: 4_096,
  maxSettingsBytes: 16_384,
} as const;
const action = { method: 'GET', path: '/health', destructive: false } as const;

function policyFor(origin: string, changes: Partial<LocalExecutionPolicy> = {}): LocalExecutionPolicy {
  return {
    version: 1,
    scenarioId: 'synthetic-health-check',
    scope,
    environment: { id: scope.environmentId, revision: 'dev-1', origin, production: false },
    requirements: { caseRevision: false, planPin: false, managedData: false },
    allowedActions: [action],
    allowedCredentialReferences: [{ id: 'synthetic-api-key', revision: 'secret-v1' }],
    allowDestructive: false,
    limits,
    ...changes,
  };
}

function settingsFor(origin: string, changes: Partial<ApiTestSettings> = {}): ApiTestSettings {
  return {
    version: 1,
    runId: 'synthetic-run-1',
    scenarioId: 'synthetic-health-check',
    scope,
    environment: {
      id: scope.environmentId,
      revision: 'dev-1',
      origin,
      initialUrl: `${origin}/health`,
    },
    actions: [action],
    limits,
    credentialReferences: [{ id: 'synthetic-api-key', revision: 'secret-v1' }],
    ...changes,
  };
}

function admitted(source: string, policy: LocalExecutionPolicy) {
  const result = admitSettings(source, policy);
  assert.equal(result.status, 'settings-admitted');
  if (result.status !== 'settings-admitted') throw new Error('Expected local policy admission');
  return result;
}

const managedReferences: ManagedReferences = {
  case: {
    id: '00000000-0000-4000-8000-000000000010',
    revision: 3,
    sourceHash: 'a'.repeat(64),
    configuration: { applicationVersion: 'app-v1', environmentVersion: 'env-v1' },
  },
  plan: {
    id: '00000000-0000-4000-8000-000000000011',
    revision: 2,
  },
  schema: { id: 'schema-v1', revision: '1' },
  recipe: { id: 'recipe-v1', revision: '1', schemaId: 'schema-v1', schemaRevision: '1' },
  data: [{
    reference: 'customer-id',
    dataset: { id: 'synthetic-dataset', revision: 'dataset-v1' },
    rowId: 'row-1',
    revision: 'data-v1',
  }],
};

describe('Inactive local settings admission', () => {
  it('Given explicit local policy and non-authorizing observations, then only policy admits a self-contained synthetic scenario', async () => {
    const target = await startSyntheticApi();
    try {
      const observationFlags = {
        tcm: { approvalGranted: false, executionAuthorized: false },
        tdm: { executionAuthorized: false },
      };
      const settings = settingsFor(target.origin);
      const policy = policyFor(target.origin);
      const result = admitted(JSON.stringify(settings), policy);

      assert.equal(result.status, 'settings-admitted');
      assert.equal(result.policyBinding.length, 64);
      assert.equal('tcm' in settings, false);
      assert.equal('tdm' in settings, false);
      assert.equal(policy.requirements.caseRevision, false);
      assert.deepEqual(observationFlags, {
        tcm: { approvalGranted: false, executionAuthorized: false },
        tdm: { executionAuthorized: false },
      });
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });

  it('Given a settings source is later changed, then the admitted snapshot is deeply immutable and revalidation preserves it', async () => {
    const target = await startSyntheticApi();
    try {
      const sourceSettings = JSON.parse(JSON.stringify(settingsFor(target.origin))) as ApiTestSettings;
      const source = JSON.stringify(sourceSettings);
      const result = admitted(source, policyFor(target.origin));

      assert.equal(Object.isFrozen(result.settings), true);
      assert.equal(Object.isFrozen(result.settings.actions), true);
      assert.equal(Object.isFrozen(result.settings.actions[0]), true);
      assert.equal(result.settings.actions[0]?.method, 'GET');
      assert.equal(Reflect.set(sourceSettings.actions[0]!, 'method', 'POST'), true);
      assert.equal(Reflect.set(result.settings.actions[0]!, 'method', 'POST'), false);
      assert.equal(result.settings.actions[0]?.method, 'GET');
      assert.equal(revalidateSettings(result, result.policy), result);
      assert.deepEqual(
        revalidateSettings(result, {
          ...result.policy,
          environment: { ...result.policy.environment, revision: 'dev-2' },
        }),
        { status: 'rejected', code: 'policy-changed' },
      );
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });

  it('Given required managed refs are absent or their owner check is unavailable, then no admission is returned', async () => {
    const target = await startSyntheticApi();
    try {
      const base = settingsFor(target.origin);
      const policy = policyFor(target.origin, {
        requirements: { caseRevision: true, planPin: true, managedData: true },
      });
      assert.deepEqual(admitSettings(JSON.stringify(base), policy), {
        status: 'rejected',
        code: 'reference-required',
      });
      assert.deepEqual(admitSettings(JSON.stringify({ ...base, managedReferences }), policy), {
        status: 'rejected',
        code: 'owner-check-unavailable',
      });
      assert.deepEqual(admitSettings(JSON.stringify({
        ...base,
        managedReferences: {
          ...managedReferences,
          data: [managedReferences.data![0]!, { ...managedReferences.data![0]!, rowId: 'row-2' }],
        },
      }), policy), {
        status: 'rejected',
        code: 'input-invalid',
      });
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });

  it('Given managed refs are supplied for a scenario that does not require them, then the extra refs are rejected', async () => {
    const target = await startSyntheticApi();
    try {
      assert.deepEqual(
        admitSettings(JSON.stringify(settingsFor(target.origin, { managedReferences })), policyFor(target.origin)),
        { status: 'rejected', code: 'reference-invalid' },
      );
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });

  it('Given local policy scope, environment, target, action or numeric limits do not match, then admission fails closed', async () => {
    const target = await startSyntheticApi();
    try {
      const settings = settingsFor(target.origin);
      assert.deepEqual(admitSettings(JSON.stringify({ ...settings, scope: { ...scope, projectId: '00000000-0000-4000-8000-000000000099' } }), policyFor(target.origin)), {
        status: 'rejected', code: 'scope-mismatch',
      });
      assert.deepEqual(admitSettings(JSON.stringify({ ...settings, scenarioId: 'other-scenario' }), policyFor(target.origin)), {
        status: 'rejected', code: 'scenario-mismatch',
      });
      assert.deepEqual(admitSettings(JSON.stringify({ ...settings, actions: [{ ...action, method: 'POST' }] }), policyFor(target.origin)), {
        status: 'rejected', code: 'action-not-allowed',
      });
      assert.deepEqual(admitSettings(JSON.stringify({ ...settings, actions: [{ ...action, destructive: true }] }), policyFor(target.origin)), {
        status: 'rejected', code: 'input-invalid',
      });
      assert.deepEqual(admitSettings(JSON.stringify({ ...settings, limits: { ...limits, maxRequests: 11 } }), policyFor(target.origin)), {
        status: 'rejected', code: 'limit-invalid',
      });
      assert.deepEqual(admitSettings(JSON.stringify({ ...settings, limits: undefined }), policyFor(target.origin)), {
        status: 'rejected', code: 'input-invalid',
      });
      assert.deepEqual(admitSettings(JSON.stringify({ ...settings, environment: { ...settings.environment, origin: 'https://example.invalid' } }), policyFor(target.origin)), {
        status: 'rejected', code: 'input-invalid',
      });
      assert.deepEqual(admitSettings(JSON.stringify({ ...settings, destructive: true }), policyFor(target.origin)), {
        status: 'rejected', code: 'input-invalid',
      });
      assert.deepEqual(admitSettings(JSON.stringify(settings), JSON.parse(JSON.stringify({
        ...policyFor(target.origin),
        environment: { ...policyFor(target.origin).environment, production: true },
      }))), {
        status: 'rejected', code: 'policy-invalid',
      });
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });

  it('Given missing, ambiguous or cross-scope secret resolution, then the credential is rejected without leaking provider details', async () => {
    const target = await startSyntheticApi();
    try {
      const policy = policyFor(target.origin);
      const result = admitted(JSON.stringify(settingsFor(target.origin)), policy);
      const ref = result.settings.credentialReferences[0];
      assert.ok(ref);
      let useCalls = 0;
      const missing = await withCustomerCredential(result, policy, ref, {
        async resolve() { throw new Error('SYNTHETIC_SECRET provider detail'); },
      }, () => { useCalls++; return 'used'; });
      const crossScope = await withCustomerCredential(result, policy, ref, {
        async resolve(reference, resolvedScope) {
          return {
            value: 'SYNTHETIC_SECRET',
            reference,
            scope: { ...resolvedScope, projectId: '00000000-0000-4000-8000-000000000099' },
          };
        },
      }, () => { useCalls++; return 'used'; });
      const ambiguous = await withCustomerCredential(result, policy, ref, {
        async resolve(reference, resolvedScope) {
          return {
            value: 'SYNTHETIC_SECRET',
            reference: { ...reference, revision: 'other-revision' },
            scope: resolvedScope,
          };
        },
      }, () => { useCalls++; return 'used'; });
      const resultText = JSON.stringify([missing, crossScope, ambiguous]);

      assert.deepEqual(missing, { status: 'rejected', code: 'credential-unavailable' });
      assert.deepEqual(crossScope, { status: 'rejected', code: 'credential-unavailable' });
      assert.deepEqual(ambiguous, { status: 'rejected', code: 'credential-unavailable' });
      assert.doesNotMatch(resultText, /SYNTHETIC_SECRET|provider detail/);
      assert.equal(useCalls, 0);
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });

  it('Given an approved opaque secret ref, then resolution is scoped and only the callback receives its value', async () => {
    const target = await startSyntheticApi();
    try {
      const policy = policyFor(target.origin);
      const result = admitted(JSON.stringify(settingsFor(target.origin)), policy);
      const ref = result.settings.credentialReferences[0];
      assert.ok(ref);
      let providerScope: unknown;
      let callbackReceivedSecret = false;
      const resolution = await withCustomerCredential(result, policy, ref, {
        async resolve(reference, scope) {
          providerScope = scope;
          return { value: 'SYNTHETIC_SECRET_VALUE', reference, scope };
        },
      }, secret => { callbackReceivedSecret = secret === 'SYNTHETIC_SECRET_VALUE'; });

      assert.deepEqual(resolution, { status: 'resolved' });
      assert.equal(callbackReceivedSecret, true);
      assert.deepEqual(providerScope, {
        runId: 'synthetic-run-1',
        scenarioId: 'synthetic-health-check',
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        environmentRevision: 'dev-1',
      });
      assert.doesNotMatch(JSON.stringify(result.settings), /SYNTHETIC_SECRET_VALUE/);
      assert.equal(target.requestCount, 0);
    } finally {
      await target.close();
    }
  });
});
