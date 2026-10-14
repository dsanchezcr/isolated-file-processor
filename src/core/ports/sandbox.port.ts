import type { ProcessAttachmentJob, AllowedMime } from '../domain/file-payload.js';
import type { ByteStream } from './storage.port.js';

export interface SanitizedArtifact {
  readonly bytes: Uint8Array;
  readonly mime: AllowedMime | 'text/plain';
}

export interface SandboxPort {
  run(job: ProcessAttachmentJob, input: ByteStream): Promise<SanitizedArtifact>;
}
