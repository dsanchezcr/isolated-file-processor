import { describe, expect, it } from 'vitest';
import { detectMime, sniffStream } from '../../src/gateway/middleware/magic-byte-validator.js';
import { UnsupportedMediaError } from '../../src/core/errors/domain-errors.js';

describe('signature allowlist', () => {
  it.each([
    [Buffer.from('%PDF-1.7'), 'application/pdf'],
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'],
    [Buffer.from([255, 216, 255]), 'image/jpeg'],
    [Buffer.from([80, 75, 3, 4]), 'application/zip'],
    [Buffer.from([31, 139, 8]), 'application/gzip'],
  ])('recognizes signature %#', (bytes, mime) => { expect(detectMime(bytes)).toBe(mime); });

  it.each([Buffer.from('MZ'), Buffer.from([127, 69, 76, 70]), Buffer.alloc(0), Buffer.from('%PD')])(
    'rejects unsupported or truncated signature %#', bytes => {
      expect(() => detectMime(bytes)).toThrow(UnsupportedMediaError);
    },
  );

  it('replays a signature split across chunks without losing bytes', async () => {
    const original = Buffer.from('%PDF-1.7\n' + 'x'.repeat(1000));
    const source = (async function* () {
      yield original.subarray(0, 2);
      yield original.subarray(2, 700);
      yield original.subarray(700);
    })();
    const { mime, stream } = await sniffStream(source);
    expect(mime).toBe('application/pdf');
    const received: Uint8Array[] = [];
    for await (const chunk of stream) received.push(chunk);
    expect(Buffer.concat(received)).toEqual(original);
  });
});
