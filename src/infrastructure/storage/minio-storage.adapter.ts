import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { ByteStream, StorageArea, StoragePort } from '../../core/ports/storage.port.js';

export interface MinioOptions {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
}

export class MinioStorageAdapter implements StoragePort {
  private readonly client: S3Client;

  constructor(options: MinioOptions) {
    this.client = new S3Client({
      endpoint: `${options.useSSL ? 'https' : 'http'}://${options.endpoint}:${options.port}`,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(area: StorageArea, key: string, source: ByteStream, mime: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket(area), Key: key,
        Body: Readable.from(source, { objectMode: false }), ContentType: mime,
      },
      queueSize: 1,
      partSize: 5 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async get(area: StorageArea, key: string): Promise<ByteStream> {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket(area), Key: key }));
    if (!(object.Body instanceof Readable)) throw new Error('Storage returned an invalid stream');
    return object.Body;
  }

  async delete(area: StorageArea, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket(area), Key: key }));
  }

  private bucket(area: StorageArea): string {
    return area === 'quarantine' ? 'quarantine-files' : 'clean-files';
  }
}
