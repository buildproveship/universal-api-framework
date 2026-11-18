// Test classification: integration
// Review status: Not Reviewed
// Evidence: synthetic
// Scope: shared typed readers for the versioned performance configuration and the sanitized run summaries; no test cases.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HardLimits, Workload } from '../../performance/limits.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const runner = path.join(root, 'performance', 'run.ts');
export const k6 = path.join(root, '.tools', 'k6', 'k6');
export const workloadPath = path.join(root, 'performance', 'workload.js');

export interface ProfilesConfig {
  hardLimits: HardLimits;
  profiles: Record<'direct-mock' | 'dev', { enabled: boolean; targetHostAllowlist: string[]; workloads: string[] }>;
  workloads: Record<'smoke' | 'baseline' | 'dev-smoke' | 'dev-baseline', Workload>;
}

/** The versioned profiles exactly as committed. */
export function readProfiles(): ProfilesConfig {
  return JSON.parse(readFileSync(path.join(root, 'performance', 'config', 'profiles.json'), 'utf8')) as ProfilesConfig;
}

export interface RunSummaryFile {
  environment: string;
  profile: string;
  workload: string;
  k6Version: string;
  phase?: string;
  runStatus: string;
  runExitCode: number;
  metrics: {
    requestCount: number | null;
    checksFailed: number;
    checkPassRate: number;
    errorRate: number;
    throughputRequestsPerSecond: number;
    latencyMilliseconds: Record<string, number>;
  };
}

/** A sanitized summary written by the runner. */
export function readSummary(summaryPath: string): { text: string; summary: RunSummaryFile } {
  const text = readFileSync(summaryPath, 'utf8');
  return { text, summary: JSON.parse(text) as RunSummaryFile };
}
