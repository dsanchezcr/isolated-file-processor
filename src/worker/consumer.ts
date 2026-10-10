import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { InspectionResult } from '../core/domain/inspection-result.js';
import type { SandboxPort } from '../core/ports/sandbox.port.js';
import type { StoragePort } from '../core/ports/storage.port.js';
import type { TelemetryPort } from '../core/ports/telemetry.port.js';
import { AttachmentSupervisor } from './supervisor.js';

export interface WorkerDependencies {
  readonly connection: ConnectionOptions;
  readonly queueName: string;
  readonly storage: StoragePort;
  readonly sandbox: SandboxPort;
  readonly telemetry: TelemetryPort;
  readonly concurrency?: number;
}

export function createWorker(dependencies: WorkerDependencies): Worker<unknown, InspectionResult> {
  const concurrency = dependencies.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('Invalid worker concurrency');
  }
  const supervisor = new AttachmentSupervisor(dependencies.storage, dependencies.sandbox, dependencies.telemetry);
  const worker = new Worker<unknown, InspectionResult>(
    dependencies.queueName,
    async (job) => supervisor.inspect(job.data),
    { connection: dependencies.connection, concurrency },
  );
  worker.on('error', () => {
    try { dependencies.telemetry.incident('queue-worker', 'QUEUE_ERROR'); } catch { /* No unhandled emitter error. */ }
  });
  return worker;
}
