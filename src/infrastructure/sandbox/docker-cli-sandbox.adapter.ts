import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProcessAttachmentJob } from '../../core/domain/file-payload.js';
import { SECURITY_PROFILE } from '../../core/domain/security-profile.js';
import { SecurityViolationError } from '../../core/errors/domain-errors.js';
import type { SandboxPort, SanitizedArtifact } from '../../core/ports/sandbox.port.js';
import type { ByteStream } from '../../core/ports/storage.port.js';
import { outputMime, validateJob } from '../../worker/policy.js';

export interface DockerSandboxOptions {
  readonly image: string;
  readonly dockerBinary?: string;
  readonly timeoutMs?: number;
}

export class DockerCliSandboxAdapter implements SandboxPort {
  private readonly binary: string;
  private readonly timeout: number;
  constructor(private readonly options: DockerSandboxOptions) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]{0,255}$/.test(options.image)) {
      throw new SecurityViolationError('Invalid sandbox image');
    }
    this.binary = options.dockerBinary ?? 'docker';
    this.timeout = options.timeoutMs ?? SECURITY_PROFILE.timeoutMs;
    if (!Number.isSafeInteger(this.timeout) || this.timeout <= 0 || this.timeout > SECURITY_PROFILE.timeoutMs) {
      throw new SecurityViolationError('Invalid sandbox deadline');
    }
  }

  async run(untrustedJob: ProcessAttachmentJob, input: ByteStream): Promise<SanitizedArtifact> {
    const job = validateJob(untrustedJob);
    const name = `supportshield-${randomUUID()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      await this.execute([
        'create', '--name', name, '-i', '--network', 'none', '--read-only',
        '--user', '10001:10001', '--cap-drop', 'ALL', '--memory', '256m',
        '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '32',
        '--security-opt', 'no-new-privileges:true',
        '--tmpfs', '/scratch:rw,noexec,nosuid,nodev,size=67108864,mode=1777',
        '--env', 'TMPDIR=/scratch', this.options.image, job.detectedMime,
      ], controller.signal, 1024);
      const bytes = await this.execute(['start', '-ai', name], controller.signal, SECURITY_PROFILE.maxOutputBytes, input);
      if (bytes.length === 0) throw new SecurityViolationError('Empty sandbox artifact');
      return { bytes, mime: outputMime(job.detectedMime) };
    } catch {
      throw new SecurityViolationError('Sandbox execution rejected');
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Use the generated name even when create never returned a container ID.
      // Retry removal to cover a create request completing concurrently with cancellation.
      let removed = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const cleanup = new AbortController();
        const cleanupTimer = setTimeout(() => cleanup.abort(), 2000);
        try { await this.execute(['rm', '-f', name], cleanup.signal, 1024); removed = true; break; }
        catch { /* A failed create may never have registered the name. */ }
        finally { clearTimeout(cleanupTimer); }
        if (attempt < 2) await delay(100 * (attempt + 1));
      }
      if (!removed) throw new SecurityViolationError('Sandbox disposal could not be verified');
    }
  }

  private async execute(args: string[], signal: AbortSignal, limit: number, input?: ByteStream): Promise<Buffer> {
    const child = spawn(this.binary, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let failed = false;
    const kill = (): void => { failed = true; child.kill('SIGKILL'); child.stdin.destroy(); };
    let rejectAbort: ((reason: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = (): void => { kill(); rejectAbort?.(new SecurityViolationError('Sandbox deadline exceeded')); };
    signal.addEventListener('abort', abort, { once: true });
    const completion = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0 || failed || signal.aborted) reject(new SecurityViolationError('Sandbox process failed'));
        else resolve();
      });
    });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) kill();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 64 * 1024) kill();
    });
    child.stdin.on('error', () => { kill(); });
    const feed = async (): Promise<void> => {
      let written = 0;
      if (input) {
        for await (const chunk of input) {
          written += chunk.byteLength;
          if (signal.aborted || written > SECURITY_PROFILE.maxUploadBytes) throw new SecurityViolationError();
          if (!child.stdin.write(chunk)) await once(child.stdin, 'drain', { signal });
        }
      }
      child.stdin.end();
    };
    const feeding = feed().catch((error: unknown) => { kill(); throw error; });
    // Race completion too: a stalled hostile source must not defeat the deadline.
    try {
      await Promise.race([Promise.all([completion, feeding]), aborted]);
      return Buffer.concat(chunks, size);
    } finally {
      signal.removeEventListener('abort', abort);
      kill();
    }
  }
}
