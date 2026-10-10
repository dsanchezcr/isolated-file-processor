import { Readable } from 'node:stream';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import type { ByteStream, StorageArea, StoragePort } from '../../core/ports/storage.port.js';

export class AzureBlobStorageAdapter implements StoragePort {
  private readonly client: BlobServiceClient;

  constructor(account: string) {
    if (!/^[a-z0-9]{3,24}$/.test(account)) throw new Error('Invalid Azure storage account');
    this.client = new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
  }

  async put(area: StorageArea, key: string, source: ByteStream, mime: string): Promise<void> {
    await this.blob(area, key).uploadStream(Readable.from(source, { objectMode: false }), 1024 * 1024, 2, {
      blobHTTPHeaders: { blobContentType: mime },
    });
  }

  async get(area: StorageArea, key: string): Promise<ByteStream> {
    const response = await this.blob(area, key).download();
    if (!response.readableStreamBody) throw new Error('Storage returned an invalid stream');
    const stream = response.readableStreamBody;
    return (async function* () {
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Storage returned non-binary content');
        yield chunk;
      }
    })();
  }

  async delete(area: StorageArea, key: string): Promise<void> {
    await this.blob(area, key).deleteIfExists();
  }

  private blob(area: StorageArea, key: string) {
    return this.client.getContainerClient(area === 'quarantine' ? 'quarantine-files' : 'clean-files')
      .getBlockBlobClient(key);
  }
}
