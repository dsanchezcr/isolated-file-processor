import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StoragePort, ByteStream } from '../../core/ports/storage.port.js';
import type { QueuePort } from '../../core/ports/queue.port.js';
import type { TelemetryPort } from '../../core/ports/telemetry.port.js';
import { SECURITY_PROFILE } from '../../core/domain/security-profile.js';
import { DomainError, PayloadTooLargeError } from '../../core/errors/domain-errors.js';
import { sniffStream } from '../middleware/magic-byte-validator.js';

export interface GatewayDependencies {
  storage: StoragePort;
  queue: QueuePort;
  telemetry: TelemetryPort;
}

export function registerIngestionRoutes(server: FastifyInstance, deps: GatewayDependencies): void {
  let activeUploads = 0;
  server.post('/attachments', async (request, reply) => {
    if (activeUploads >= 16) throw new DomainError('Upload capacity exceeded', 'CAPACITY_EXCEEDED', 429);
    activeUploads++;
    const carrier: Record<string, string> = {};
    for (const name of ['traceparent', 'tracestate']) {
      const value = request.headers[name];
      if (typeof value === 'string' && value.length <= 512) carrier[name] = value;
    }
    try {
      return await deps.telemetry.run('attachment.ingest', carrier, () => ingest(request, reply, deps));
    } finally {
      activeUploads--;
    }
  });

  server.get<{ Params: { fileId: string } }>('/attachments/:fileId', {
    schema: { params: { type: 'object', required: ['fileId'], properties: {
      fileId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' },
    }, additionalProperties: false } },
  }, async (request, reply) => {
    const state = await deps.queue.getState(request.params.fileId);
    if (!state) return reply.code(404).send({ code: 'NOT_FOUND' });
    return state;
  });
}

async function ingest(request: FastifyRequest, reply: FastifyReply, deps: GatewayDependencies) {
  const fileId = randomUUID();
  const quarantineKey = `${fileId}/original`;
  let stored = false;
  let publicationAttempted = false;
  try {
    const parts = request.parts({ limits: { files: 1, fields: 0, parts: 1, fileSize: SECURITY_PROFILE.maxUploadBytes } });
    const part = await parts.next();
    if (part.done || part.value.type !== 'file') throw new DomainError('One file is required', 'INVALID_UPLOAD', 400);
    const file = part.value;
    const deadline = setTimeout(() => file.file.destroy(new DomainError('Upload timed out', 'UPLOAD_TIMEOUT', 408)), 60_000);
    deadline.unref();
    try {
      const { mime, stream } = await sniffStream(file.file);
      const hash = createHash('sha256');
      let sizeBytes = 0;
      const measured: ByteStream = (async function* () {
        for await (const bytes of stream) {
          sizeBytes += bytes.byteLength;
          if (sizeBytes > SECURITY_PROFILE.maxUploadBytes) throw new PayloadTooLargeError();
          hash.update(bytes);
          yield bytes;
        }
        if (file.file.truncated) throw new PayloadTooLargeError();
      })();
      stored = true;
      await deps.storage.put('quarantine', quarantineKey, measured, mime);
      if (file.file.truncated) throw new PayloadTooLargeError();
      const extra = await parts.next();
      if (!extra.done) throw new DomainError('Only one file is accepted', 'INVALID_UPLOAD', 400);
      publicationAttempted = true;
      await deps.queue.enqueue({
        fileId, quarantineKey, claimedMime: file.mimetype, detectedMime: mime,
        sha256: hash.digest('hex'), sizeBytes, traceContext: deps.telemetry.inject(),
      });
      return reply.code(202).send({
        fileId, status: 'QUEUED', statusUrl: `/attachments/${fileId}`, pollAfterSeconds: 2,
      });
    } finally {
      clearTimeout(deadline);
      if (!file.file.readableEnded) file.file.destroy();
    }
  } catch (error) {
    if (stored && !publicationAttempted) {
      try { await deps.storage.delete('quarantine', quarantineKey); }
      catch { request.log.error({ fileId }, 'Quarantine cleanup failed'); }
    } else if (publicationAttempted) {
      request.log.warn({ fileId }, 'Queue publication outcome unknown; quarantine retained');
    }
    throw error;
  }
}
