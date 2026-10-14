import { createWorker } from './consumer.js';
import type { WorkerDependencies } from './consumer.js';
import type { TelemetryPort } from '../core/ports/telemetry.port.js';
import { loadConfig, createStorage } from '../gateway/config.js';
import { QUEUE_NAME, redisConnection } from '../infrastructure/queue/bullmq.adapter.js';
import { DockerCliSandboxAdapter } from '../infrastructure/sandbox/docker-cli-sandbox.adapter.js';

export async function main(telemetry: TelemetryPort): Promise<{ close(): Promise<void> }> {
  const config = loadConfig(false);
  if (config.sandboxBackend !== 'docker') throw new Error('A dedicated Docker execution host is required');
  return startWorker({
    connection: redisConnection(config.redisUrl), queueName: QUEUE_NAME,
    storage: createStorage(config), telemetry,
    sandbox: new DockerCliSandboxAdapter({ image: config.sandboxImage }),
    concurrency: config.workerConcurrency,
  });
}

export async function startWorker(dependencies: WorkerDependencies): Promise<{ close(): Promise<void> }> {
  const worker = createWorker(dependencies);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      process.removeListener('SIGTERM', shutdown);
      process.removeListener('SIGINT', shutdown);
      try { await worker.close(); } finally { await dependencies.telemetry.shutdown(); }
    })();
    return closing;
  };
  const shutdown = (): void => { void close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try { await worker.waitUntilReady(); } catch (error) { await close(); throw error; }
  return { close };
}
