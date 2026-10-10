import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Worker } from 'bullmq';
import type { InspectionResult } from '../../src/core/domain/inspection-result.js';
import type { StoragePort } from '../../src/core/ports/storage.port.js';
import { buildServer } from '../../src/gateway/server.js';
import { createStorage, loadConfig } from '../../src/gateway/config.js';
import { BullMQAdapter, QUEUE_NAME, redisConnection } from '../../src/infrastructure/queue/bullmq.adapter.js';
import { DockerCliSandboxAdapter } from '../../src/infrastructure/sandbox/docker-cli-sandbox.adapter.js';
import { OTelAdapter } from '../../src/infrastructure/telemetry/otel.adapter.js';
import { createWorker } from '../../src/worker/consumer.js';

const enabled = process.env['RUN_INTEGRATION_TESTS'] === '1';

describe.skipIf(!enabled)('real Redis/MinIO/Docker ingestion', () => {
  let server: FastifyInstance;
  let storage: StoragePort;
  let queue: BullMQAdapter;
  let worker: Worker<unknown, InspectionResult>;
  const apiKey = 'test-only-' + 'b'.repeat(40);
  const authorization = ['Bearer', apiKey].join(' ');
  const cleanKeys: string[] = [];
  const quarantineKeys: string[] = [];

  beforeAll(async () => {
    const config = loadConfig(false);
    storage = createStorage(config);
    const telemetry = new OTelAdapter();
    queue = new BullMQAdapter(config.redisUrl);
    worker = createWorker({
      connection: redisConnection(config.redisUrl), queueName: QUEUE_NAME, storage, telemetry,
      sandbox: new DockerCliSandboxAdapter({ image: config.sandboxImage }), concurrency: 1,
    });
    await worker.waitUntilReady();
    server = await buildServer({ storage, queue, telemetry }, apiKey);
  });

  afterAll(async () => {
    await server?.close();
    await worker?.close();
    await queue?.close();
    await Promise.allSettled([
      ...cleanKeys.map(key => storage.delete('clean', key)),
      ...quarantineKeys.map(key => storage.delete('quarantine', key)),
    ]);
  });

  it('streams a real upload, executes a disposable sandbox, and promotes a digest manifest', async () => {
    const original = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'red' },
    }).withMetadata().jpeg().toBuffer();
    const payload = Buffer.concat([
      Buffer.from('--flow\r\nContent-Disposition: form-data; name="file"; filename="screenshot.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
      original,
      Buffer.from('\r\n--flow--\r\n'),
    ]);
    const response = await server.inject({
      method: 'POST', url: '/attachments',
      headers: { authorization, 'content-type': 'multipart/form-data; boundary=flow' }, payload,
    });
    expect(response.statusCode).toBe(202);
    const body: unknown = response.json();
    if (typeof body !== 'object' || body === null || !('fileId' in body) || typeof body.fileId !== 'string') {
      throw new Error('Invalid acceptance response');
    }
    const fileId = body.fileId;
    quarantineKeys.push(`${fileId}/original`);
    const deadline = Date.now() + 25_000;
    let result = await queue.getState(fileId);
    while (result?.status === 'QUEUED' || result?.status === 'PROCESSING') {
      if (Date.now() >= deadline) throw new Error('Processing did not complete');
      await sleep(100);
      result = await queue.getState(fileId);
    }
    expect(result?.status).toBe('CLEAN');
    if (result?.status !== 'CLEAN') throw new Error('Expected sanitized artifact');
    cleanKeys.push(result.cleanKey, `${result.cleanKey}.manifest.json`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await storage.get('clean', result.cleanKey)) chunks.push(chunk);
    const output = Buffer.concat(chunks);
    expect(createHash('sha256').update(output).digest('hex')).toBe(result.sha256);
    expect(output.length).toBe(result.sizeBytes);
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    const manifestChunks: Uint8Array[] = [];
    for await (const chunk of await storage.get('clean', `${result.cleanKey}.manifest.json`)) manifestChunks.push(chunk);
    expect(JSON.parse(Buffer.concat(manifestChunks).toString())).toMatchObject({
      fileId, sha256: result.sha256, inputSha256: createHash('sha256').update(original).digest('hex'),
    });
    const poll = await server.inject({ url: `/attachments/${fileId}`, headers: { authorization } });
    expect(poll.json()).toEqual(result);
  });
});
