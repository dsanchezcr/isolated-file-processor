import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProcessAttachmentJob } from '../../src/core/domain/file-payload.js';
import type { AllowedMime } from '../../src/core/domain/file-payload.js';
import { DockerCliSandboxAdapter } from '../../src/infrastructure/sandbox/docker-cli-sandbox.adapter.js';

const enabled = process.env.RUN_DOCKER_TESTS === '1';
const baseImage = process.env.SANDBOX_IMAGE ?? 'supportshield-sandbox:test';
const probeImage = `supportshield-probe:${randomUUID()}`;

function docker(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn('docker', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('Docker command timed out')); }, 120_000);
    process.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    process.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    process.stdin.on('error', reject);
    process.on('error', (error) => { clearTimeout(timer); reject(error); });
    process.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`docker ${args[0]} failed: ${errors}`));
    });
    process.stdin.end(input);
  });
}

function job(bytes: Buffer, mime: AllowedMime): ProcessAttachmentJob {
  return {
    fileId: 'isolation-test', quarantineKey: 'isolation-test/original',
    claimedMime: mime, detectedMime: mime, sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), traceContext: {},
  };
}

async function* input(bytes: Buffer): AsyncIterable<Uint8Array> { yield bytes; }

// Opt-in only locally. CI sets RUN_DOCKER_TESTS=1: unavailable Docker, missing
// images, unsupported isolation, or failed probes then FAIL rather than skip.
describe.skipIf(!enabled)('real disposable Docker isolation', () => {
  beforeAll(async () => {
    await docker(['info']);
    await docker(['image', 'inspect', baseImage]);
    const probe = `
      const fs = require('node:fs'), net = require('node:net'), os = require('node:os');
      process.stdin.resume();
      if (process.argv[1] === 'application/pdf') { setInterval(() => {}, 1000); }
      else {
        const read = (paths) => { for (const path of paths) { try { return fs.readFileSync(path, 'utf8').trim(); } catch {} } throw new Error('Missing cgroup limit'); };
        const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\\n').map(line => line.split(' '));
        const status = fs.readFileSync('/proc/self/status', 'utf8');
        const report = {
          uid: process.getuid(), gid: process.getgid(),
          rootOptions: mounts.find(line => line[1] === '/')[3].split(','),
          scratchOptions: mounts.find(line => line[1] === '/scratch')[3].split(','),
          capabilities: /^CapEff:\\s+(\\w+)$/m.exec(status)[1],
          noNewPrivileges: /^NoNewPrivs:\\s+(\\d+)$/m.exec(status)[1],
          memory: read(['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']),
          pids: read(['/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max']),
          cpu: read(['/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/cpu/cpu.cfs_quota_us']),
          interfaces: Object.keys(os.networkInterfaces()),
          scratchBytes: fs.statfsSync('/scratch').bsize * fs.statfsSync('/scratch').blocks,
        };
        const socket = net.createConnection({host: '1.1.1.1', port: 443});
        let done = false;
        const finish = (reachable) => { if(done) return; done = true; socket.destroy(); report.reachable = reachable; process.stdout.write(JSON.stringify(report)); };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(1000, () => finish(false));
      }
    `;
    await docker(['build', '--quiet', '-t', probeImage, '-'], `FROM ${baseImage}\nENTRYPOINT ${JSON.stringify(['node', '-e', probe])}\n`);
  }, 120_000);

  afterAll(async () => { await docker(['image', 'rm', '-f', probeImage]); }, 120_000);

  it('proves networklessness, non-root UID, read-only root, zero capabilities and live cgroup limits', async () => {
    const bytes = gzipSync(Buffer.from('probe'));
    const sandbox = new DockerCliSandboxAdapter({ image: probeImage });
    const artifact = await sandbox.run(job(bytes, 'application/gzip'), input(bytes));
    const report = JSON.parse(Buffer.from(artifact.bytes).toString()) as Record<string, unknown>;
    expect(report.uid).toBe(10001);
    expect(report.gid).toBe(10001);
    expect(report.rootOptions).toContain('ro');
    expect(report.scratchOptions).toEqual(expect.arrayContaining(['nosuid', 'nodev', 'noexec']));
    expect(report.capabilities).toMatch(/^0+$/);
    expect(report.noNewPrivileges).toBe('1');
    expect(report.memory).toBe('268435456');
    expect(report.pids).toBe('32');
    expect(report.cpu === '50000 100000' || report.cpu === '50000').toBe(true);
    expect(report.interfaces).toEqual(['lo']);
    expect(report.scratchBytes).toBe(67108864);
    expect(report.reachable).toBe(false);
  }, 30_000);

  it('kills a hung sandbox by deadline and leaves no named container behind', async () => {
    const before = new Set((await docker(['ps', '-a', '--format', '{{.Names}}'])).split('\n'));
    const bytes = Buffer.from('%PDF-test');
    const sandbox = new DockerCliSandboxAdapter({ image: probeImage, timeoutMs: 1000 });
    const started = Date.now();
    await expect(sandbox.run(job(bytes, 'application/pdf'), input(bytes))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
    const after = (await docker(['ps', '-a', '--format', '{{.Names}}'])).split('\n');
    expect(after.filter((name) => name.startsWith('supportshield-') && !before.has(name))).toEqual([]);
  }, 30_000);

  it('runs real image reconstruction and destroys metadata', async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).withMetadata().jpeg().toBuffer();
    const artifact = await new DockerCliSandboxAdapter({ image: baseImage }).run(job(bytes, 'image/jpeg'), input(bytes));
    const metadata = await sharp(artifact.bytes).metadata();
    expect(artifact.mime).toBe('image/png');
    expect(metadata.format).toBe('png');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  }, 30_000);

  it('rasterizes PDF visuals rather than carrying active actions forward', async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]).drawText('Harmless fixture', { x: 5, y: 50, size: 8 });
    const action = document.context.obj({ S: 'JavaScript', JS: PDFString.of('/* harmless inert fixture */') });
    document.catalog.set(PDFName.of('OpenAction'), document.context.register(action));
    const bytes = Buffer.from(await document.save());
    const artifact = await new DockerCliSandboxAdapter({ image: baseImage }).run(job(bytes, 'application/pdf'), input(bytes));
    const rebuilt = await PDFDocument.load(artifact.bytes);
    expect(rebuilt.getPageCount()).toBe(1);
    expect(rebuilt.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    expect(rebuilt.getPage(0).node.Resources()?.has(PDFName.of('XObject'))).toBe(true);
  }, 30_000);
});
