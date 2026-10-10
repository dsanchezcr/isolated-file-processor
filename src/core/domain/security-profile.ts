import { SecurityViolationError } from '../errors/domain-errors.js';

export const SECURITY_PROFILE = Object.freeze({
  maxUploadBytes: 20 * 1024 * 1024,
  maxOutputBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 32 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxArchiveEntries: 128,
  maxImagePixels: 16_000_000,
  maxPdfPages: 20,
  timeoutMs: 15_000,
  memoryBytes: 256 * 1024 * 1024,
  scratchBytes: 64 * 1024 * 1024,
});

export function validatePayloadSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0 || size > SECURITY_PROFILE.maxUploadBytes) {
    throw new SecurityViolationError('Invalid payload size');
  }
}
