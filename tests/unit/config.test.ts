import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/gateway/config.js';
import { redisConnection } from '../../src/infrastructure/queue/bullmq.adapter.js';

afterEach(() => vi.unstubAllEnvs());

function configure(): void {
  vi.stubEnv('STORAGE_BACKEND', 'minio');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('MINIO_ACCESS_KEY', 'test-only-access');
  vi.stubEnv('MINIO_SECRET_KEY', 'test-only-secret');
  vi.stubEnv('API_KEY', 'test-only-' + 'a'.repeat(40));
}

describe('fail-closed runtime configuration', () => {
  it('requires gateway authentication configuration', () => {
    configure();
    vi.stubEnv('API_KEY', '');
    expect(() => loadConfig()).toThrow('API_KEY');
    expect(() => loadConfig(false)).not.toThrow();
  });
  it('rejects weak gateway keys', () => {
    configure();
    vi.stubEnv('API_KEY', 'short');
    expect(() => loadConfig()).toThrow('32 characters');
  });
  it.each(['0', '9', '1.5', 'NaN'])('bounds worker concurrency: %s', value => {
    configure();
    vi.stubEnv('WORKER_CONCURRENCY', value);
    expect(() => loadConfig(false)).toThrow('WORKER_CONCURRENCY');
  });
  it('does not silently choose a storage backend', () => {
    configure();
    vi.stubEnv('STORAGE_BACKEND', 'invalid');
    expect(() => loadConfig()).toThrow('STORAGE_BACKEND');
  });
  it('uses TLS and validates Redis protocol', () => {
    const address = new URL('rediss://cache.example:6380/0');
    address.username = 'default';
    address.password = 'encoded/value';
    const connection = redisConnection(address.toString());
    expect(connection).toMatchObject({ host: 'cache.example', port: 6380, password: 'encoded/value', tls: { servername: 'cache.example' } });
    expect(() => redisConnection('https://cache.example')).toThrow();
    expect(() => redisConnection('redis://localhost/1.5')).toThrow();
  });
});
