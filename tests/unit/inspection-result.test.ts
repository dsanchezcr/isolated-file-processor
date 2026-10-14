import { describe, expect, it } from 'vitest';
import { parseInspectionResult } from '../../src/core/domain/inspection-result.js';
import { SECURITY_PROFILE } from '../../src/core/domain/security-profile.js';

const fileId = '00000000-0000-4000-8000-000000000000';
const clean = {
  status: 'CLEAN', outputMime: 'image/png', sha256: 'c'.repeat(64),
  sizeBytes: 100, cleanKey: `${fileId}/sanitized`,
};

describe('untrusted queue results', () => {
  it('accepts only bounded sanitized artifact metadata', () => {
    expect(parseInspectionResult(clean, fileId)).toEqual(clean);
  });
  it.each([
    null, undefined, [], { status: 'QUEUED' },
    { ...clean, cleanKey: 'other-file/sanitized' },
    { ...clean, cleanKey: '../original' },
    { ...clean, outputMime: 'text/html' },
    { ...clean, sha256: 'invalid' },
    { ...clean, sizeBytes: 0 },
    { ...clean, sizeBytes: NaN },
    { ...clean, sizeBytes: SECURITY_PROFILE.maxOutputBytes + 1 },
  ])('never reports malformed or cross-file results as clean: %#', value => {
    expect(parseInspectionResult(value, fileId).status).toBe('QUARANTINE_REJECTED');
  });
  it('does not reflect untrusted error details to the API', () => {
    expect(parseInspectionResult({ status: 'QUARANTINE_REJECTED', reason: 'untrusted internal details' }, fileId)).toEqual({
      status: 'QUARANTINE_REJECTED', reason: 'Attachment rejected by security policy',
    });
  });
});
