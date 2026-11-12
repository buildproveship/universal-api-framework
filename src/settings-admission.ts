import { createHash } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface SettingsScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export interface CredentialReference {
  readonly id: string;
  readonly revision?: string;
}

export interface ManagedReferences {
  readonly case: {
    readonly id: string;
    readonly revision: number;
    readonly sourceHash: string;
    readonly configuration: { readonly applicationVersion: string; readonly environmentVersion: string };
  };
  readonly plan?: { readonly id: string; readonly revision: number };
  readonly schema?: { readonly id: string; readonly revision: string };
  readonly recipe?: {
    readonly id: string;
    readonly revision: string;
    readonly schemaId: string;
    readonly schemaRevision: string;
  };
  readonly data?: readonly {
    readonly reference: string;
    readonly dataset: { readonly id: string; readonly revision: string };
    readonly rowId: string;
    readonly revision: string;
  }[];
}

export interface SettingsAction {
  readonly method: HttpMethod;
  readonly path: string;
  readonly destructive: false;
}

export interface ExplicitLimits {
  readonly maxRequests: number;
  readonly timeoutMs: number;
  readonly requestsPerMinute: number;
  readonly maxConcurrency: number;
  readonly maxBodyBytes: number;
  readonly maxSettingsBytes: number;
}

export interface ApiTestSettings {
  readonly version: 1;
  readonly runId: string;
  readonly scenarioId: string;
  readonly scope: SettingsScope;
  readonly environment: {
    readonly id: string;
    readonly revision: string;
    readonly origin: string;
    readonly initialUrl: string;
  };
  readonly actions: readonly SettingsAction[];
  readonly limits: ExplicitLimits;
  readonly credentialReferences: readonly CredentialReference[];
  readonly managedReferences?: ManagedReferences;
}

export interface LocalExecutionPolicy {
  readonly version: 1;
  readonly scenarioId: string;
  readonly scope: SettingsScope;
  readonly environment: {
    readonly id: string;
    readonly revision: string;
    readonly origin: string;
    readonly production: false;
  };
  readonly requirements: {
    readonly caseRevision: boolean;
    readonly planPin: boolean;
    readonly managedData: boolean;
  };
  readonly allowedActions: readonly SettingsAction[];
  readonly allowedCredentialReferences: readonly CredentialReference[];
  readonly allowDestructive: false;
  readonly limits: ExplicitLimits;
}

export type AdmissionFailureCode =
  | 'input-invalid'
  | 'policy-invalid'
  | 'scope-mismatch'
  | 'scenario-mismatch'
  | 'environment-mismatch'
  | 'target-not-allowed'
  | 'action-not-allowed'
  | 'limit-invalid'
  | 'reference-required'
  | 'reference-invalid'
  | 'owner-check-unavailable'
  | 'credential-reference-not-allowed'
  | 'credential-unavailable'
  | 'policy-changed';

export type SettingsAdmission =
  | {
      readonly status: 'settings-admitted';
      readonly settings: ApiTestSettings;
      readonly policy: LocalExecutionPolicy;
      readonly policyBinding: string;
    }
  | { readonly status: 'rejected'; readonly code: AdmissionFailureCode };

export interface RuntimeCredentialScope {
  readonly runId: string;
  readonly scenarioId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly environmentRevision: string;
}

export interface ResolvedCustomerSecret {
  readonly value: string;
  readonly reference: CredentialReference;
  readonly scope: RuntimeCredentialScope;
}

export interface CustomerSecretProvider {
  resolve(reference: CredentialReference, scope: RuntimeCredentialScope): Promise<ResolvedCustomerSecret>;
}

export type CredentialResolution =
  | { readonly status: 'resolved' }
  | { readonly status: 'rejected'; readonly code: 'credential-unavailable' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key));
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validScope(value: unknown): value is SettingsScope {
  return isRecord(value) &&
    hasExactKeys(value, ['tenantId', 'projectId', 'environmentId']) &&
    typeof value.tenantId === 'string' && UUID.test(value.tenantId) &&
    typeof value.projectId === 'string' && UUID.test(value.projectId) &&
    typeof value.environmentId === 'string' && UUID.test(value.environmentId);
}

function parseOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin !== value
    ) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function validLimits(value: unknown): value is ExplicitLimits {
  return isRecord(value) &&
    hasExactKeys(value, ['maxRequests', 'timeoutMs', 'requestsPerMinute', 'maxConcurrency', 'maxBodyBytes', 'maxSettingsBytes']) &&
    Object.values(value).every(positiveInteger);
}

function validAction(value: unknown): value is SettingsAction {
  if (!isRecord(value) || !hasExactKeys(value, ['method', 'path', 'destructive'])) return false;
  if (!HTTP_METHODS.includes(value.method as HttpMethod) || value.destructive !== false) return false;
  if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.startsWith('//') ||
      value.path.includes('?') || value.path.includes('#') || value.path.includes('\\')) return false;
  try {
    const parsed = new URL(value.path, 'http://127.0.0.1:1');
    return parsed.origin === 'http://127.0.0.1:1' && parsed.pathname === value.path &&
      parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

function validCredentialReference(value: unknown): value is CredentialReference {
  return isRecord(value) &&
    hasExactKeys(value, ['id'], ['revision']) &&
    typeof value.id === 'string' && IDENTIFIER.test(value.id) &&
    (value.revision === undefined || (typeof value.revision === 'string' && IDENTIFIER.test(value.revision)));
}

function validRuntimeCredentialScope(value: unknown): value is RuntimeCredentialScope {
  return isRecord(value) &&
    hasExactKeys(value, ['runId', 'scenarioId', 'tenantId', 'projectId', 'environmentId', 'environmentRevision']) &&
    typeof value.runId === 'string' && IDENTIFIER.test(value.runId) &&
    typeof value.scenarioId === 'string' && IDENTIFIER.test(value.scenarioId) &&
    typeof value.tenantId === 'string' && UUID.test(value.tenantId) &&
    typeof value.projectId === 'string' && UUID.test(value.projectId) &&
    typeof value.environmentId === 'string' && UUID.test(value.environmentId) &&
    typeof value.environmentRevision === 'string' && IDENTIFIER.test(value.environmentRevision);
}

function validManagedReferences(value: unknown): value is ManagedReferences {
  if (!isRecord(value) || !hasExactKeys(value, ['case'], ['plan', 'schema', 'recipe', 'data'])) return false;
  const ref = value.case;
  if (!isRecord(ref) || !hasExactKeys(ref, ['id', 'revision', 'sourceHash', 'configuration']) ||
      typeof ref.id !== 'string' || !UUID.test(ref.id) || !positiveInteger(ref.revision) ||
      typeof ref.sourceHash !== 'string' || !SHA256.test(ref.sourceHash) ||
      !isRecord(ref.configuration) ||
      !hasExactKeys(ref.configuration, ['applicationVersion', 'environmentVersion']) ||
      typeof ref.configuration.applicationVersion !== 'string' || !IDENTIFIER.test(ref.configuration.applicationVersion) ||
      typeof ref.configuration.environmentVersion !== 'string' || !IDENTIFIER.test(ref.configuration.environmentVersion)) return false;
  if (value.plan !== undefined) {
    const plan = value.plan;
    if (!isRecord(plan) || !hasExactKeys(plan, ['id', 'revision']) ||
        typeof plan.id !== 'string' || !UUID.test(plan.id) || !positiveInteger(plan.revision)) return false;
  }
  for (const key of ['schema', 'recipe'] as const) {
    const item = value[key];
    if (item !== undefined) {
      if (!isRecord(item) || Object.values(item).some(v => typeof v !== 'string' || !IDENTIFIER.test(v))) return false;
      if (key === 'schema' && !hasExactKeys(item, ['id', 'revision'])) return false;
      if (key === 'recipe' && !hasExactKeys(item, ['id', 'revision', 'schemaId', 'schemaRevision'])) return false;
    }
  }
  if (value.data !== undefined) {
    if (!Array.isArray(value.data) || value.data.length < 1 || value.data.length > 50 ||
        !value.data.every(item => isRecord(item) &&
          hasExactKeys(item, ['reference', 'dataset', 'rowId', 'revision']) &&
          typeof item.reference === 'string' && IDENTIFIER.test(item.reference) &&
          typeof item.rowId === 'string' && IDENTIFIER.test(item.rowId) &&
          typeof item.revision === 'string' && IDENTIFIER.test(item.revision) &&
          isRecord(item.dataset) && hasExactKeys(item.dataset, ['id', 'revision']) &&
          typeof item.dataset.id === 'string' && IDENTIFIER.test(item.dataset.id) &&
          typeof item.dataset.revision === 'string' && IDENTIFIER.test(item.dataset.revision))) return false;
    if (new Set(value.data.map(item => item.reference)).size !== value.data.length ||
        new Set(value.data.map(item => JSON.stringify([item.dataset.id, item.dataset.revision, item.rowId]))).size !== value.data.length) {
      return false;
    }
  }
  const schema = value.schema;
  const recipe = value.recipe;
  if (schema !== undefined && recipe !== undefined &&
      (!isRecord(schema) || !isRecord(recipe) ||
       recipe.schemaId !== schema.id || recipe.schemaRevision !== schema.revision)) return false;
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function jsonSnapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function validatePolicy(value: unknown): value is LocalExecutionPolicy {
  if (!isRecord(value) ||
      !hasExactKeys(value, ['version', 'scenarioId', 'scope', 'environment', 'requirements', 'allowedActions', 'allowedCredentialReferences', 'allowDestructive', 'limits']) ||
      value.version !== 1 || typeof value.scenarioId !== 'string' || !IDENTIFIER.test(value.scenarioId) ||
      !validScope(value.scope) || !validLimits(value.limits) ||
      value.allowDestructive !== false || !Array.isArray(value.allowedActions) ||
      !value.allowedActions.every(validAction) || !Array.isArray(value.allowedCredentialReferences) ||
      !value.allowedCredentialReferences.every(validCredentialReference) ||
      !isRecord(value.requirements) ||
      !hasExactKeys(value.requirements, ['caseRevision', 'planPin', 'managedData']) ||
      !Object.values(value.requirements).every(flag => typeof flag === 'boolean') ||
      value.allowedActions.length === 0 ||
      new Set(value.allowedCredentialReferences.map(item => JSON.stringify(item))).size !== value.allowedCredentialReferences.length ||
      (value.requirements.planPin === true && value.requirements.caseRevision !== true) ||
      (value.requirements.managedData === true && value.requirements.caseRevision !== true)) return false;
  const environment = value.environment;
  return isRecord(environment) &&
    hasExactKeys(environment, ['id', 'revision', 'origin', 'production']) &&
    typeof environment.id === 'string' && IDENTIFIER.test(environment.id) &&
    typeof environment.revision === 'string' && IDENTIFIER.test(environment.revision) &&
    parseOrigin(environment.origin) !== undefined && environment.production === false &&
    value.scope.environmentId === environment.id;
}

function validateSettings(value: unknown): value is ApiTestSettings {
  if (!isRecord(value) ||
      !hasExactKeys(value, ['version', 'runId', 'scenarioId', 'scope', 'environment', 'actions', 'limits', 'credentialReferences'], ['managedReferences']) ||
      value.version !== 1 ||
      typeof value.runId !== 'string' || !IDENTIFIER.test(value.runId) ||
      typeof value.scenarioId !== 'string' || !IDENTIFIER.test(value.scenarioId) ||
      !validScope(value.scope) || !validLimits(value.limits) ||
      !Array.isArray(value.actions) || value.actions.length < 1 || !value.actions.every(validAction) ||
      !Array.isArray(value.credentialReferences) || !value.credentialReferences.every(validCredentialReference) ||
      new Set(value.actions.map(item => JSON.stringify(item))).size !== value.actions.length ||
      new Set(value.credentialReferences.map(item => JSON.stringify(item))).size !== value.credentialReferences.length ||
      (value.managedReferences !== undefined && !validManagedReferences(value.managedReferences))) return false;
  const environment = value.environment;
  return isRecord(environment) &&
    hasExactKeys(environment, ['id', 'revision', 'origin', 'initialUrl']) &&
    typeof environment.id === 'string' && IDENTIFIER.test(environment.id) &&
    typeof environment.revision === 'string' && IDENTIFIER.test(environment.revision) &&
    value.scope.environmentId === environment.id &&
    parseOrigin(environment.origin) !== undefined &&
    typeof environment.initialUrl === 'string' &&
    (() => {
      try {
        const target = new URL(environment.initialUrl);
        return target.origin === environment.origin && target.username === '' &&
          target.password === '' && target.search === '' && target.hash === '';
      } catch {
        return false;
      }
    })();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reject(code: AdmissionFailureCode): SettingsAdmission {
  return { status: 'rejected', code };
}

function validateAgainstPolicy(settings: ApiTestSettings, policy: LocalExecutionPolicy): AdmissionFailureCode | undefined {
  if (settings.scenarioId !== policy.scenarioId) return 'scenario-mismatch';
  if (!sameJson(settings.scope, policy.scope)) return 'scope-mismatch';
  if (settings.environment.id !== policy.environment.id ||
      settings.environment.revision !== policy.environment.revision ||
      settings.environment.origin !== policy.environment.origin) return 'environment-mismatch';
  if (policy.environment.production || policy.allowDestructive) return 'policy-invalid';
  if (settings.actions.some(action => action.destructive !== false ||
      !policy.allowedActions.some(allowed => sameJson(action, allowed)))) return 'action-not-allowed';
  const limits = Object.keys(policy.limits) as (keyof ExplicitLimits)[];
  if (limits.some(key => settings.limits[key] > policy.limits[key])) return 'limit-invalid';
  if (settings.credentialReferences.some(reference =>
    !policy.allowedCredentialReferences.some(allowed => sameJson(reference, allowed)))) {
    return 'credential-reference-not-allowed';
  }
  const requirements = policy.requirements;
  const refs = settings.managedReferences;
  if (requirements.caseRevision && !refs) return 'reference-required';
  if (requirements.planPin && !refs?.plan) return 'reference-required';
  if (requirements.managedData && (!refs?.schema || !refs.recipe || !refs.data)) return 'reference-required';
  if (refs && (
    (!requirements.caseRevision && refs.case) ||
    (!requirements.planPin && refs.plan) ||
    (!requirements.managedData && (refs.schema || refs.recipe || refs.data))
  )) return 'reference-invalid';
  if (requirements.caseRevision || requirements.planPin || requirements.managedData) {
    return 'owner-check-unavailable';
  }
  return undefined;
}

/** Prepare settings against trusted customer-owned local policy; this performs no I/O. */
export function admitSettings(source: string, trustedPolicy: LocalExecutionPolicy): SettingsAdmission {
  let policyValue: unknown;
  try {
    policyValue = jsonSnapshot(trustedPolicy);
  } catch {
    return reject('policy-invalid');
  }
  if (!validatePolicy(policyValue)) return reject('policy-invalid');
  let settingsValue: unknown;
  try {
    if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > policyValue.limits.maxSettingsBytes) {
      return reject('input-invalid');
    }
    settingsValue = JSON.parse(source) as unknown;
  } catch {
    return reject('input-invalid');
  }
  if (!validateSettings(settingsValue)) return reject('input-invalid');

  const settings = jsonSnapshot(settingsValue) as ApiTestSettings;
  const policy = policyValue as LocalExecutionPolicy;
  const failure = validateAgainstPolicy(settings, policy);
  if (failure) return reject(failure);
  const policyBinding = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  return {
    status: 'settings-admitted',
    settings: deepFreeze(settings),
    policy: deepFreeze(policy),
    policyBinding,
  };
}

/** Recheck the frozen local policy before each target operation; managed-owner paths remain unavailable. */
export function revalidateSettings(
  admission: SettingsAdmission,
  currentTrustedPolicy: LocalExecutionPolicy,
): SettingsAdmission {
  if (admission.status !== 'settings-admitted') return admission;
  if (!Object.isFrozen(admission.settings) || !Object.isFrozen(admission.policy) ||
      createHash('sha256').update(JSON.stringify(admission.policy)).digest('hex') !== admission.policyBinding) {
    return reject('policy-changed');
  }
  let currentPolicy: unknown;
  try {
    currentPolicy = jsonSnapshot(currentTrustedPolicy);
  } catch {
    return reject('policy-invalid');
  }
  if (!validatePolicy(currentPolicy)) return reject('policy-invalid');
  if (createHash('sha256').update(JSON.stringify(currentPolicy)).digest('hex') !== admission.policyBinding) {
    return reject('policy-changed');
  }
  const failure = validateAgainstPolicy(admission.settings, admission.policy);
  return failure ? reject(failure) : admission;
}

function sameCredentialScope(actual: RuntimeCredentialScope, expected: RuntimeCredentialScope): boolean {
  return sameJson(actual, expected);
}

/** Resolve a secret only at runtime, scoped to the exact run/scenario/environment, and never echo provider errors. */
export async function withCustomerCredential<T>(
  admission: SettingsAdmission,
  currentTrustedPolicy: LocalExecutionPolicy,
  reference: CredentialReference,
  provider: CustomerSecretProvider,
  use: (secret: string) => T | Promise<T>,
): Promise<CredentialResolution> {
  let referenceValue: unknown;
  let resolve: CustomerSecretProvider['resolve'];
  try {
    referenceValue = jsonSnapshot(reference);
    resolve = provider?.resolve;
  } catch {
    return { status: 'rejected', code: 'credential-unavailable' };
  }
  if (!validCredentialReference(referenceValue) || typeof resolve !== 'function') {
    return { status: 'rejected', code: 'credential-unavailable' };
  }
  const checked = revalidateSettings(admission, currentTrustedPolicy);
  if (checked.status !== 'settings-admitted' ||
      !checked.settings.credentialReferences.some(item => sameJson(item, referenceValue))) {
    return { status: 'rejected', code: 'credential-unavailable' };
  }
  const scope: RuntimeCredentialScope = {
    runId: checked.settings.runId,
    scenarioId: checked.settings.scenarioId,
    tenantId: checked.settings.scope.tenantId,
    projectId: checked.settings.scope.projectId,
    environmentId: checked.settings.environment.id,
    environmentRevision: checked.settings.environment.revision,
  };
  let secret: string;
  try {
    const resolved = await resolve.call(provider, referenceValue, scope) as unknown;
    if (!isRecord(resolved) ||
        !hasExactKeys(resolved, ['value', 'reference', 'scope']) ||
        typeof resolved.value !== 'string' || resolved.value.length === 0 ||
        !sameJson(resolved.reference, referenceValue) ||
        !validRuntimeCredentialScope(resolved.scope) ||
        !sameCredentialScope(resolved.scope, scope)) {
      return { status: 'rejected', code: 'credential-unavailable' };
    }
    secret = resolved.value;
  } catch {
    return { status: 'rejected', code: 'credential-unavailable' };
  }
  await use(secret);
  return { status: 'resolved' };
}
