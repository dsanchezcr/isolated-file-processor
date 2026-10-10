import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/gateway/server.js';
import type { ByteStream, StorageArea, StoragePort } from '../../src/core/ports/storage.port.js';
import type { QueuePort } from '../../src/core/ports/queue.port.js';
import type { ProcessAttachmentJob } from '../../src/core/domain/file-payload.js';
import type { JobState } from '../../src/core/domain/inspection-result.js';
import type { TelemetryPort } from '../../src/core/ports/telemetry.port.js';
import { SECURITY_PROFILE } from '../../src/core/domain/security-profile.js';

const apiKey = 'test-only-' + 'a'.repeat(40);
const authorization = ['Bearer', apiKey].join(' ');
const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

class MemoryStorage implements StoragePort {
  readonly objects = new Map<string, Buffer>();
  writes = 0;
  async put(_area: StorageArea, key: string, source: ByteStream): Promise<void> {
    this.writes++;
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) chunks.push(chunk);
    this.objects.set(key, Buffer.concat(chunks));
  }
  async get(_area: StorageArea, key: string): Promise<ByteStream> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('Missing object');
    return (async function* () { yield bytes; })();
  }
  async delete(_area: StorageArea, key: string): Promise<void> { this.objects.delete(key); }
}

class MemoryQueue implements QueuePort {
  readonly jobs: ProcessAttachmentJob[] = [];
  fail = false;
  async enqueue(job: ProcessAttachmentJob): Promise<void> {
    if (this.fail) throw new Error('Queue unavailable');
    this.jobs.push(job);
  }
  async getState(id: string): Promise<JobState | undefined> {
    return this.jobs.some(job => job.fileId === id) ? { status: 'QUEUED' } : undefined;
  }
  async close(): Promise<void> {}
}

const telemetry: TelemetryPort = {
  inject: () => ({ traceparent: '00-11111111111111111111111111111111-2222222222222222-01' }),
  run: async (_name, _carrier, operation) => operation(),
  incident: () => {},
  shutdown: async () => {},
};

function multipart(bytes: Buffer, secondFile = false): Buffer {
  const first = Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="misleading.png"\r\nContent-Type: image/png\r\n\r\n');
  const extra = secondFile
    ? Buffer.from('\r\n--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="second.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7')
    : Buffer.alloc(0);
  return Buffer.concat([first, bytes, extra, Buffer.from('\r\n--test-boundary--\r\n')]);
}

async function fixture() {
  const storage = new MemoryStorage();
  const queue = new MemoryQueue();
  const server = await buildServer({ storage, queue, telemetry }, apiKey);
  servers.push(server);
  return { storage, queue, server };
}

function headers(auth = authorization) {
  return { authorization: auth, 'content-type': 'multipart/form-data; boundary=test-boundary' };
}

describe('ingestion HTTP boundary', () => {
  it('stores exact bytes then queues integrity metadata and provides polling', async () => {
    const { server, storage, queue } = await fixture();
    const bytes = Buffer.from('%PDF-1.7\nvisible fixture');
    const response = await server.inject({ method: 'POST', url: '/attachments', headers: headers(), payload: multipart(bytes) });
    expect(response.statusCode).toBe(202);
    const job = queue.jobs[0];
    expect(job).toBeDefined();
    if (!job) throw new Error('Expected job');
    expect(storage.objects.get(job.quarantineKey)).toEqual(bytes);
    expect(job.detectedMime).toBe('application/pdf');
    expect(job.claimedMime).toBe('image/png');
    expect(job.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(job.sizeBytes).toBe(bytes.length);
    expect(job.traceContext['traceparent']).toBeDefined();
    const poll = await server.inject({ url: `/attachments/${job.fileId}`, headers: { authorization } });
    expect(poll.json()).toEqual({ status: 'QUEUED' });
  });

  it('rejects a disguised executable before any storage write', async () => {
    const { server, storage, queue } = await fixture();
    const response = await server.inject({ method: 'POST', url: '/attachments', headers: headers(), payload: multipart(Buffer.from('MZ executable')) });
    expect(response.statusCode).toBe(415);
    expect(storage.writes).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it('requires authentication before accepting payloads or polling', async () => {
    const { server, storage } = await fixture();
    const response = await server.inject({ method: 'POST', url: '/attachments', headers: headers('invalid'), payload: multipart(Buffer.from('%PDF-1.7')) });
    expect(response.statusCode).toBe(401);
    expect(storage.writes).toBe(0);
    expect((await server.inject('/attachments/00000000-0000-4000-8000-000000000000')).statusCode).toBe(401);
    expect((await server.inject('/health')).statusCode).toBe(200);
  });

  it('deletes the quarantine object if queue publication fails', async () => {
    const { server, storage, queue } = await fixture();
    queue.fail = true;
    const response = await server.inject({ method: 'POST', url: '/attachments', headers: headers(), payload: multipart(Buffer.from('%PDF-1.7')) });
    expect(response.statusCode).toBe(503);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects oversized streams without enqueueing truncated content', async () => {
    const { server, storage, queue } = await fixture();
    const bytes = Buffer.alloc(SECURITY_PROFILE.maxUploadBytes + 1, 65);
    bytes.write('%PDF-1.7');
    const response = await server.inject({ method: 'POST', url: '/attachments', headers: headers(), payload: multipart(bytes) });
    expect(response.statusCode).toBe(413);
    expect(storage.objects.size).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it('rejects extra files and cleans up the first object', async () => {
    const { server, storage, queue } = await fixture();
    const response = await server.inject({ method: 'POST', url: '/attachments', headers: headers(), payload: multipart(Buffer.from('%PDF-1.7'), true) });
    expect(response.statusCode).toBe(413);
    expect(storage.objects.size).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it('limits repeated requests', async () => {
    const { server } = await fixture();
    let status = 0;
    for (let index = 0; index < 31; index++) status = (await server.inject('/health')).statusCode;
    expect(status).toBe(429);
  });
});
