// Sanitized cleanup evidence for the owned Dev Platform runtime. Kept apart from
// platform-runtime.ts so the runner can read it without loading Docker code.

export interface CleanupFailure { operation: string; reason: string }
export interface RemainingResource { kind: string; id: string | undefined }
export interface Settlement {
  settled: boolean; gracefulStopVerified: boolean; project: string | undefined;
  owner?: string | undefined; cleanupFailures?: CleanupFailure[]; cleanupFailureCount?: number;
  remainingOwnedResources: RemainingResource[]; remainingResourcesMayBeStale?: boolean;
  remainingResourcesKnown?: boolean; creationOutcomeUncertain: boolean; stableEmptyObservations?: number;
}

/** An error that carries sanitized cleanup evidence for the run summary. */
export type SettlementError = Error & { settlement?: Settlement | undefined };

export function withSettlement<E extends Error>(error: E, settlement: Settlement | undefined): E & SettlementError {
  return Object.assign(error, { settlement });
}

export function settlementOf(error: unknown): Settlement | undefined {
  return error instanceof Error ? (error as SettlementError).settlement : undefined;
}
