import { SECURITY_PROFILE } from '../../core/domain/security-profile.js';
import type { AllowedMime } from '../../core/domain/file-payload.js';
import { collect, sanitize } from './parsers.js';

const timeout = setTimeout(() => process.exit(1), SECURITY_PROFILE.timeoutMs);
try {
  const mime = process.argv[2];
  if (!mime || !['application/pdf', 'image/png', 'image/jpeg', 'application/zip', 'application/gzip'].includes(mime)) {
    throw new Error('Unsupported media');
  }
  const bytes = await collect(process.stdin, SECURITY_PROFILE.maxUploadBytes);
  const output = await sanitize(mime as AllowedMime, bytes);
  if (!output.length || output.length > SECURITY_PROFILE.maxOutputBytes) throw new Error('Invalid artifact');
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => { if (error) reject(error); else resolve(); });
  });
} catch {
  process.stderr.write('QUARANTINE_REJECTED\n');
  process.exitCode = 1;
} finally { clearTimeout(timeout); }
