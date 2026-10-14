import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import type { AllowedMime } from '../../core/domain/file-payload.js';
import { SECURITY_PROFILE as LIMIT } from '../../core/domain/security-profile.js';
import { SecurityViolationError } from '../../core/errors/domain-errors.js';

const reject = (): never => { throw new SecurityViolationError(); };

export async function collect(source: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > limit) reject();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function isNested(bytes: Buffer): boolean {
  return bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    bytes.subarray(0, 2).equals(Buffer.from('PK')) ||
    bytes.subarray(0, 6).equals(Buffer.from('7z\xbc\xaf\x27\x1c', 'latin1')) ||
    bytes.subarray(0, 4).equals(Buffer.from('Rar!')) ||
    bytes.subarray(0, 3).equals(Buffer.from('BZh')) ||
    bytes.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0])) ||
    bytes.subarray(257, 262).equals(Buffer.from('ustar'));
}

function text(bytes: Buffer): string {
  if (isNested(bytes)) reject();
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) reject();
  return value;
}

export async function sanitizeGzip(bytes: Buffer): Promise<Buffer> {
  const output = await collect(Readable.from([bytes]).pipe(createGunzip()), Math.min(LIMIT.maxExpandedBytes, bytes.length * LIMIT.maxExpansionRatio));
  return Buffer.from(text(output));
}

function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, rejectPromise) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => { if (error || !zip) rejectPromise(error ?? new SecurityViolationError()); else resolve(zip); });
  });
}

export async function sanitizeZip(bytes: Buffer): Promise<Buffer> {
  const zip = await openZip(bytes);
  if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount <= 0 || zip.entryCount > LIMIT.maxArchiveEntries) {
    zip.close();
    reject();
  }
  const outputs: Buffer[] = [];
  let entries = 0;
  let expanded = 0;
  let outputSize = 0;
  return new Promise((resolve, rejectPromise) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      rejectPromise(error);
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(outputs, outputSize));
    });
    zip.on('entry', (entry: Entry) => {
      const consume = async (): Promise<void> => {
        entries += 1;
        const name = entry.fileName;
        const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
        const directory = name.endsWith('/');
        if (entries > LIMIT.maxArchiveEntries || name.length === 0 || name.length > 1024 ||
            name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.includes('\\') ||
            name.split('/').some((part) => part === '..' || part === '.') ||
            /[\u0000-\u001f\u007f]/u.test(name) ||
            (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            /\.(zip|gz|gzip|tgz|tar|bz2|xz|7z|rar)$/i.test(name) ||
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize > LIMIT.maxExpandedBytes ||
            entry.uncompressedSize > Math.max(1, entry.compressedSize) * LIMIT.maxExpansionRatio ||
            expanded + entry.uncompressedSize > Math.min(LIMIT.maxExpandedBytes, bytes.length * LIMIT.maxExpansionRatio)) reject();
        if (directory) {
          if (entry.uncompressedSize !== 0) reject();
          zip.readEntry();
          return;
        }
        if (unixType === 0x4000) reject();
        const stream = await new Promise<Readable>((resolveStream, rejectStream) => {
          zip.openReadStream(entry, (error, source) => {
            if (error || !source) rejectStream(error ?? new SecurityViolationError()); else resolveStream(source);
          });
        });
        const content = await collect(stream, Math.min(LIMIT.maxExpandedBytes - expanded, bytes.length * LIMIT.maxExpansionRatio - expanded));
        if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc32) reject();
        expanded += content.length;
        const output = Buffer.from(`--- ${name} ---\n${text(content)}\n`);
        outputSize += output.length;
        if (outputSize > LIMIT.maxOutputBytes) reject();
        outputs.push(output);
        zip.readEntry();
      };
      void consume().catch(fail);
    });
    zip.readEntry();
  });
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function image(bytes: Buffer): Promise<Buffer> {
  const parser = sharp(bytes, { limitInputPixels: LIMIT.maxImagePixels, failOn: 'warning', animated: false });
  const metadata = await parser.metadata();
  if ((metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height ||
      metadata.width * metadata.height > LIMIT.maxImagePixels) reject();
  const output = await parser.rotate().png().toBuffer();
  if (output.length > LIMIT.maxOutputBytes) reject();
  return output;
}

function command(binary: string, args: string[], deadline: number, outputLimit: number): Promise<Buffer> {
  return new Promise((resolve, rejectPromise) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let failed = false;
    const kill = (): void => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(kill, Math.max(1, deadline - Date.now()));
    child.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) kill(); else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 64 * 1024) kill();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || failed) rejectPromise(new SecurityViolationError());
      else resolve(Buffer.concat(chunks, size));
    });
  });
}

async function pdf(bytes: Buffer): Promise<Buffer> {
  const directory = `/scratch/${randomUUID()}`;
  const deadline = Date.now() + LIMIT.timeoutMs;
  await mkdir(directory, { mode: 0o700 });
  try {
    const path = `${directory}/input.pdf`;
    await writeFile(path, bytes);
    const info = (await command('pdfinfo', [path], deadline, 64 * 1024)).toString('utf8');
    const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
    if (!Number.isSafeInteger(pages) || pages <= 0 || pages > LIMIT.maxPdfPages ||
        !/^Encrypted:\s+no\s*$/m.test(info)) reject();
    const document = await PDFDocument.create();
    let totalRasterBytes = 0;
    for (let page = 1; page <= pages; page += 1) {
      const prefix = `${directory}/page`;
      await command('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile',
        '-scale-to', '2000', '-png', path, prefix], deadline, 1024);
      const raster = await image(await readFile(`${prefix}.png`));
      totalRasterBytes += raster.length;
      if (totalRasterBytes > LIMIT.maxOutputBytes) reject();
      await rm(`${prefix}.png`);
      const embedded = await document.embedPng(raster);
      const outputPage = document.addPage([embedded.width, embedded.height]);
      outputPage.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }
    const output = Buffer.from(await document.save());
    if (output.length > LIMIT.maxOutputBytes) reject();
    return output;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function sanitize(mime: AllowedMime, bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > LIMIT.maxUploadBytes) reject();
  switch (mime) {
    case 'image/jpeg':
      if (!bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) reject();
      return image(bytes);
    case 'image/png':
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) reject();
      return image(bytes);
    case 'application/pdf':
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) reject();
      return pdf(bytes);
    case 'application/zip':
      if (!bytes.subarray(0, 2).equals(Buffer.from('PK'))) reject();
      return sanitizeZip(bytes);
    case 'application/gzip':
      if (!bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) reject();
      return sanitizeGzip(bytes);
    default: return reject();
  }
}
