import type { AllowedMime, ProcessAttachmentJob } from '../core/domain/file-payload.js';
import { SECURITY_PROFILE } from '../core/domain/security-profile.js';
import { SecurityViolationError } from '../core/errors/domain-errors.js';

export function outputMime(mime: AllowedMime): AllowedMime | 'text/plain' {
  switch (mime) {
    case 'application/pdf': return 'application/pdf';
    case 'image/png':
    case 'image/jpeg': return 'image/png';
    case 'application/zip':
    case 'application/gzip': return 'text/plain';
  }
}

export function validateJob(value: unknown): ProcessAttachmentJob {
  if (typeof value !== 'object' || value === null) throw new SecurityViolationError('Invalid job metadata');
  const job = value as Record<string, unknown>;
  const mimes: readonly string[] = ['application/pdf', 'image/png', 'image/jpeg', 'application/zip', 'application/gzip'];
  if (typeof job.fileId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(job.fileId) ||
      job.quarantineKey !== `${job.fileId}/original` ||
      typeof job.claimedMime !== 'string' || job.claimedMime.length > 256 ||
      typeof job.detectedMime !== 'string' || !mimes.includes(job.detectedMime) ||
      typeof job.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(job.sha256) ||
      typeof job.sizeBytes !== 'number' || !Number.isSafeInteger(job.sizeBytes) ||
      job.sizeBytes <= 0 || job.sizeBytes > SECURITY_PROFILE.maxUploadBytes ||
      typeof job.traceContext !== 'object' || job.traceContext === null || Array.isArray(job.traceContext)) {
    throw new SecurityViolationError('Invalid job metadata');
  }
  const trace = Object.entries(job.traceContext);
  if (trace.length > 16 || trace.some(([key, item]) =>
    key.length > 128 || typeof item !== 'string' || item.length > 1024)) {
    throw new SecurityViolationError('Invalid trace metadata');
  }
  return {
    fileId: job.fileId, quarantineKey: job.quarantineKey, claimedMime: job.claimedMime,
    detectedMime: job.detectedMime as AllowedMime, sha256: job.sha256, sizeBytes: job.sizeBytes,
    traceContext: Object.fromEntries(trace) as Record<string, string>,
  };
}
