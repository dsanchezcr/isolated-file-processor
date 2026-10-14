import type { ProcessAttachmentJob } from '../domain/file-payload.js';
import type { JobState } from '../domain/inspection-result.js';

export interface QueuePort {
  enqueue(job: ProcessAttachmentJob): Promise<void>;
  getState(fileId: string): Promise<JobState | undefined>;
  close(): Promise<void>;
}
