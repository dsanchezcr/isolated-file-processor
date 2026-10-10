import type { AllowedMime } from '../../core/domain/file-payload.js';
import type { ByteStream } from '../../core/ports/storage.port.js';
import { UnsupportedMediaError } from '../../core/errors/domain-errors.js';

const signatures: readonly [AllowedMime, readonly number[]][] = [
  ['application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['application/zip', [0x50, 0x4b, 0x03, 0x04]],
  ['application/gzip', [0x1f, 0x8b, 0x08]],
];

export function detectMime(prefix: Uint8Array): AllowedMime {
  for (const [mime, signature] of signatures) {
    if (signature.every((byte, index) => prefix[index] === byte)) return mime;
  }
  throw new UnsupportedMediaError();
}

export async function sniffStream(source: ByteStream): Promise<{ mime: AllowedMime; stream: ByteStream }> {
  const iterator = source[Symbol.asyncIterator]();
  const consumed: Uint8Array[] = [];
  const prefix = new Uint8Array(512);
  let length = 0;
  try {
    while (length < prefix.length) {
      const chunk = await iterator.next();
      if (chunk.done) break;
      consumed.push(chunk.value);
      const count = Math.min(chunk.value.byteLength, prefix.length - length);
      prefix.set(chunk.value.subarray(0, count), length);
      length += count;
    }
    const mime = detectMime(prefix.subarray(0, length));
    return {
      mime,
      stream: (async function* () {
        try {
          yield* consumed;
          for (;;) {
            const chunk = await iterator.next();
            if (chunk.done) break;
            yield chunk.value;
          }
        } finally { await iterator.return?.(); }
      })(),
    };
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}
