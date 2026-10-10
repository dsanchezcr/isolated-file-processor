import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { ProcessAttachmentJob } from '../../core/domain/file-payload.js';
import type { JobState } from '../../core/domain/inspection-result.js';
import type { QueuePort } from '../../core/ports/queue.port.js';

export const QUEUE_NAME = 'attachments';

export function redisConnection(address: string): ConnectionOptions {
  const url = new URL(address);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Invalid Redis URL');
  const db = Number(url.pathname.slice(1) || '0');
  if (!Number.isSafeInteger(db) || db < 0) throw new Error('Invalid Redis database');
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'rediss:' ? '6380' : '6379')),
    username: decodeURIComponent(url.username) || 'default',
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db,
    ...(url.protocol === 'rediss:' ? { tls: { servername: url.hostname } } : {}),
    maxRetriesPerRequest: null,
  };
}

export class BullMQAdapter implements QueuePort {
  private readonly queue: Queue<ProcessAttachmentJob, JobState>;

  constructor(address: string) {
    this.queue = new Queue(QUEUE_NAME, {
      connection: { ...redisConnection(address), maxRetriesPerRequest: 1, enableOfflineQueue: false },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 86_400, count: 10_000 },
      },
    });
    this.queue.on('error', () => { /* Operations reject at the application boundary. */ });
  }

  async enqueue(job: ProcessAttachmentJob): Promise<void> {
    await this.queue.add('process-attachment', job, { jobId: job.fileId });
  }

  async getState(fileId: string): Promise<JobState | undefined> {
    const job = await this.queue.getJob(fileId);
    if (!job) return undefined;
    const state = await job.getState();
    if (state === 'completed') return job.returnvalue;
    if (state === 'failed') return { status: 'QUARANTINE_REJECTED', reason: 'Processing failed' };
    return { status: state === 'active' ? 'PROCESSING' : 'QUEUED' };
  }

  async close(): Promise<void> { await this.queue.close(); }
}
