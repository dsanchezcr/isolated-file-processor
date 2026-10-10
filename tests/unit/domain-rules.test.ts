import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { SECURITY_PROFILE, validatePayloadSize } from '../../src/core/domain/security-profile.js';

describe('domain security invariants', () => {
  it.each([0, -1, NaN, Infinity, 0.5, SECURITY_PROFILE.maxUploadBytes + 1])('rejects invalid size %s', size => {
    expect(() => validatePayloadSize(size)).toThrow();
  });
  it('permits the inclusive upload bound', () => {
    expect(() => validatePayloadSize(SECURITY_PROFILE.maxUploadBytes)).not.toThrow();
    expect(Object.isFrozen(SECURITY_PROFILE)).toBe(true);
  });
  it('keeps core imports inside the domain boundary', () => {
    const root = fileURLToPath(new URL('../../src/core/', import.meta.url));
    function check(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) check(path);
        else {
          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
            expect(match[1]?.startsWith('.')).toBe(true);
            const target = resolve(dirname(path), match[1] ?? '');
            expect(relative(root, target).startsWith('..')).toBe(false);
          }
        }
      }
    }
    check(root);
  });
});
