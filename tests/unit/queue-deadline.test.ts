import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessAttachmentJob } from '../../src/core/domain/file-payload.js';

const mocks = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<void>>(),
  add: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    on(): void {}
    waitUntilReady = mocks.ready;
    add = mocks.add;
    getJob = mocks.getJob;
    async close(): Promise<void> {}
  },
}));

import { BullMQAdapter } from '../../src/infrastructure/queue/bullmq.adapter.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('queue outage deadlines', () => {
  it('bounds readiness and never publishes a job after the deadline', async () => {
    vi.useFakeTimers();
    let becomeReady = (): void => {};
    mocks.ready.mockReturnValue(new Promise<void>(resolve => { becomeReady = resolve; }));
    const queue = new BullMQAdapter('redis://localhost:6379');
    const job: ProcessAttachmentJob = {
      fileId: 'test-file', quarantineKey: 'test-file/original', claimedMime: 'application/pdf',
      detectedMime: 'application/pdf', sha256: 'a'.repeat(64), sizeBytes: 10, traceContext: {},
    };
    const pending = expect(queue.enqueue(job)).rejects.toThrow('Queue readiness timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    becomeReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.add).not.toHaveBeenCalled();
    await queue.close();
  });

  it('also bounds polling while Redis is unavailable', async () => {
    vi.useFakeTimers();
    mocks.ready.mockReturnValue(new Promise<void>(() => {}));
    const queue = new BullMQAdapter('redis://localhost:6379');
    const pending = expect(queue.getState('test-file')).rejects.toThrow('Queue readiness timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(mocks.getJob).not.toHaveBeenCalled();
    await queue.close();
  });
});
