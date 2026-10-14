import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ByteStream } from '../../src/core/ports/storage.port.js';

const received = vi.hoisted(() => ({ chunks: [] as Uint8Array[] }));

async function consume(body: Readable): Promise<void> {
  expect(body.readableObjectMode).toBe(false);
  for await (const chunk of body) {
    expect(Buffer.isBuffer(chunk)).toBe(true);
    received.chunks.push(chunk);
  }
}

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(private readonly options: { params: { Body: Readable } }) {}
    async done(): Promise<void> { await consume(this.options.params.Body); }
  },
}));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: class {
    getContainerClient() {
      return { getBlockBlobClient: () => ({ uploadStream: consume }) };
    }
  },
}));

import { AzureBlobStorageAdapter } from '../../src/infrastructure/storage/azure-blob-storage.adapter.js';
import { MinioStorageAdapter } from '../../src/infrastructure/storage/minio-storage.adapter.js';

describe('framework-neutral binary storage streams', () => {
  it.each(['azure', 'minio'])('normalizes plain Uint8Array chunks for the %s SDK', async backend => {
    received.chunks.length = 0;
    const storage = backend === 'azure'
      ? new AzureBlobStorageAdapter('teststorage')
      : new MinioStorageAdapter({
        endpoint: 'localhost', port: 9000, useSSL: false,
        accessKey: 'test-only-access', secretKey: 'test-only-secret',
      });
    const source: ByteStream = (async function* () {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    })();
    await storage.put('quarantine', 'test/original', source, 'image/png');
    expect(Buffer.concat(received.chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
