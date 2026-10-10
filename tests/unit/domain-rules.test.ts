import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { SECURITY_PROFILE, validatePayloadSize } from '../../src/core/domain/security-profile.js';

function moduleReferences(source: string): string[] {
  for (const match of source.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)) {
    if (!/^\s*(['"])[^'"]+\1\s*$/.test(match[1] ?? '')) {
      throw new Error('Computed module specifier');
    }
  }
  return Array.from(source.matchAll(
    /\b(?:from\s*|import\s*|(?:import|require)\s*\(\s*)['"]([^'"]+)['"]/g,
  ), match => match[1] ?? '');
}

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
          for (const specifier of moduleReferences(source)) {
            expect(specifier.startsWith('.')).toBe(true);
            const target = resolve(dirname(path), specifier);
            expect(relative(root, target).startsWith('..')).toBe(false);
          }
        }
      }
    }
    check(root);
  });
  it.each([
    "import 'node:fs';",
    "export * from 'fastify';",
    "const parser = import('sharp');",
    "const parser = require('pdf-lib');",
    "import queue = require('bullmq');",
    "type Parser = import('yauzl').ZipFile;",
  ])('detects module references in %s', source => {
    expect(moduleReferences(source)).toHaveLength(1);
    expect(moduleReferences(source)[0]?.startsWith('.')).toBe(false);
  });
  it.each(["import(name)", "require(name)"])('rejects computed imports in %s', source => {
    expect(() => moduleReferences(source)).toThrow('Computed module specifier');
  });
  it('keeps parsers out of the transitive gateway and worker host import graphs', () => {
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const visited = new Set<string>();
    function check(path: string): void {
      if (visited.has(path)) return;
      visited.add(path);
      const location = relative(root, path).split('\\').join('/');
      expect(location.startsWith('worker/sandbox/')).toBe(false);
      expect(location.startsWith('worker/runner/')).toBe(false);
      for (const specifier of moduleReferences(readFileSync(path, 'utf8'))) {
        expect(['sharp', 'pdf-lib', 'yauzl']).not.toContain(specifier.split('/')[0]);
        if (specifier.startsWith('.')) check(resolve(dirname(path), specifier.replace(/\.js$/, '.ts')));
      }
    }
    check(join(root, 'gateway/index.ts'));
    check(join(root, 'worker/index.ts'));
  });
});
