import type { AllowedMime } from './file-payload.js';

export type InspectionResult =
  | { readonly status: 'CLEAN'; readonly outputMime: AllowedMime | 'text/plain'; readonly sha256: string; readonly sizeBytes: number; readonly cleanKey: string }
  | { readonly status: 'QUARANTINE_REJECTED'; readonly reason: string };

export type JobState =
  | { readonly status: 'QUEUED' | 'PROCESSING' }
  | InspectionResult;
