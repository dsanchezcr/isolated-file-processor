import type { AllowedMime } from './file-payload.js';
import { SECURITY_PROFILE } from './security-profile.js';

export type InspectionResult =
  | { readonly status: 'CLEAN'; readonly outputMime: AllowedMime | 'text/plain'; readonly sha256: string; readonly sizeBytes: number; readonly cleanKey: string }
  | { readonly status: 'QUARANTINE_REJECTED'; readonly reason: string };

export type JobState =
  | { readonly status: 'QUEUED' | 'PROCESSING' }
  | InspectionResult;

export function parseInspectionResult(value: unknown, fileId: string): InspectionResult {
  const rejected: InspectionResult = {
    status: 'QUARANTINE_REJECTED', reason: 'Attachment rejected by security policy',
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return rejected;
  const result = value as Record<string, unknown>;
  if (result.status !== 'CLEAN' ||
      (result.outputMime !== 'application/pdf' && result.outputMime !== 'image/png' && result.outputMime !== 'text/plain') ||
      typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256) ||
      typeof result.sizeBytes !== 'number' || !Number.isSafeInteger(result.sizeBytes) ||
      result.sizeBytes <= 0 || result.sizeBytes > SECURITY_PROFILE.maxOutputBytes ||
      typeof result.cleanKey !== 'string' || result.cleanKey !== `${fileId}/sanitized`) return rejected;
  return {
    status: 'CLEAN', outputMime: result.outputMime, sha256: result.sha256,
    sizeBytes: result.sizeBytes, cleanKey: result.cleanKey,
  };
}
