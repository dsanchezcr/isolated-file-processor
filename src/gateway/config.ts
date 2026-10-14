import type { StoragePort } from '../core/ports/storage.port.js';
import { AzureBlobStorageAdapter } from '../infrastructure/storage/azure-blob-storage.adapter.js';
import { MinioStorageAdapter } from '../infrastructure/storage/minio-storage.adapter.js';

export interface AppConfig {
  port: number;
  host: string;
  apiKey: string;
  redisUrl: string;
  storageBackend: 'minio' | 'azure';
  minioEndpoint: string;
  minioPort: number;
  minioUseSSL: boolean;
  minioAccessKey: string;
  minioSecretKey: string;
  azureStorageAccount: string;
  sandboxImage: string;
  workerConcurrency: number;
  sandboxBackend: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function loadConfig(requireApiKey = true): AppConfig {
  const storageBackend = required('STORAGE_BACKEND');
  if (storageBackend !== 'minio' && storageBackend !== 'azure') throw new Error('Invalid STORAGE_BACKEND');
  const apiKey = requireApiKey ? required('API_KEY') : '';
  if (requireApiKey && apiKey.length < 32) throw new Error('API_KEY must contain at least 32 characters');
  return {
    port: integer('PORT', 3000, 1, 65535), host: process.env['HOST'] ?? '0.0.0.0', apiKey,
    redisUrl: required('REDIS_URL'), storageBackend,
    minioEndpoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
    minioPort: integer('MINIO_PORT', 9000, 1, 65535),
    minioUseSSL: process.env['MINIO_USE_SSL'] !== 'false',
    minioAccessKey: storageBackend === 'minio' ? required('MINIO_ACCESS_KEY') : '',
    minioSecretKey: storageBackend === 'minio' ? required('MINIO_SECRET_KEY') : '',
    azureStorageAccount: storageBackend === 'azure' ? required('AZURE_STORAGE_ACCOUNT') : '',
    sandboxImage: process.env['SANDBOX_IMAGE'] ?? 'sandbox-runner:local',
    workerConcurrency: integer('WORKER_CONCURRENCY', 2, 1, 8),
    sandboxBackend: process.env['SANDBOX_BACKEND'] ?? 'docker',
  };
}

export function createStorage(config: AppConfig): StoragePort {
  return config.storageBackend === 'azure'
    ? new AzureBlobStorageAdapter(config.azureStorageAccount)
    : new MinioStorageAdapter({
      endpoint: config.minioEndpoint, port: config.minioPort, useSSL: config.minioUseSSL,
      accessKey: config.minioAccessKey, secretKey: config.minioSecretKey,
    });
}
