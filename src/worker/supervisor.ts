import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { InspectionResult } from '../core/domain/inspection-result.js';
import { SECURITY_PROFILE } from '../core/domain/security-profile.js';
import { SecurityViolationError } from '../core/errors/domain-errors.js';
import type { SandboxPort } from '../core/ports/sandbox.port.js';
import type { ByteStream, StoragePort } from '../core/ports/storage.port.js';
import type { TelemetryPort } from '../core/ports/telemetry.port.js';
import { outputMime, validateJob } from './policy.js';

async function* stream(bytes: Uint8Array): ByteStream { yield bytes; }

export class AttachmentSupervisor {
  constructor(
    private readonly storage: StoragePort,
    private readonly sandbox: SandboxPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  async inspect(value: unknown): Promise<InspectionResult> {
    let incidentId = 'invalid-job';
    let cleanKey: string | undefined;
    try {
      const job = validateJob(value);
      incidentId = job.fileId;
      return await this.telemetry.run('attachment.inspect', job.traceContext, async () => {
        const source = await this.storage.get('quarantine', job.quarantineKey);
        const chunks: Buffer[] = [];
        const hash = createHash('sha256');
        let size = 0;
        const deadline = Date.now() + SECURITY_PROFILE.timeoutMs;
        const iterator = source[Symbol.asyncIterator]();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SecurityViolationError('Input stream deadline exceeded')), SECURITY_PROFILE.timeoutMs);
        });
        try {
          while (true) {
            const next = await Promise.race([iterator.next(), expired]);
            if (next.done) break;
            if (!(next.value instanceof Uint8Array)) throw new SecurityViolationError('Invalid input stream');
            size += next.value.byteLength;
            if (size > job.sizeBytes || size > SECURITY_PROFILE.maxUploadBytes || Date.now() > deadline) {
              throw new SecurityViolationError('Input exceeds declared bounds');
            }
            const copy = Buffer.from(next.value);
            hash.update(copy);
            chunks.push(copy);
          }
        } finally {
          if (timer) clearTimeout(timer);
          if (source instanceof Readable) source.destroy();
        }
        if (size !== job.sizeBytes || hash.digest('hex') !== job.sha256) {
          throw new SecurityViolationError('Quarantine integrity mismatch');
        }
        const artifact = await this.sandbox.run(job, stream(Buffer.concat(chunks, size)));
        const expectedMime = outputMime(job.detectedMime);
        if (!(artifact.bytes instanceof Uint8Array) || !artifact.bytes.byteLength ||
            artifact.bytes.byteLength > SECURITY_PROFILE.maxOutputBytes || artifact.mime !== expectedMime) {
          throw new SecurityViolationError('Invalid sandbox artifact');
        }
        const bytes = Buffer.from(artifact.bytes);
        // Only protocol signatures are checked here; parsers run exclusively inside the sandbox.
        if ((expectedMime === 'application/pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) ||
            (expectedMime === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
            (expectedMime === 'text/plain' && !validText(bytes))) {
          throw new SecurityViolationError('Sandbox artifact protocol mismatch');
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        cleanKey = `${job.fileId}/sanitized`;
        const manifest = Buffer.from(JSON.stringify({
          fileId: job.fileId, inputSha256: job.sha256, sha256, sizeBytes: bytes.length,
          outputMime: expectedMime, cleanKey,
        }));
        await this.storage.put('clean', `${cleanKey}.manifest.json`, stream(manifest), 'application/json');
        await this.storage.put('clean', cleanKey, stream(bytes), expectedMime);
        return { status: 'CLEAN', outputMime: expectedMime, sha256, sizeBytes: bytes.length, cleanKey };
      });
    } catch {
      if (cleanKey) {
        await Promise.allSettled([
          this.storage.delete('clean', cleanKey),
          this.storage.delete('clean', `${cleanKey}.manifest.json`),
        ]);
      }
      try { this.telemetry.incident(incidentId, 'QUARANTINE_REJECTED'); } catch { /* Remain fail closed if telemetry is unavailable. */ }
      return { status: 'QUARANTINE_REJECTED', reason: 'Attachment rejected by security policy' };
    }
  }
}

function validText(bytes: Buffer): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
  } catch { return false; }
}
