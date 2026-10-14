export type AllowedMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'application/zip' | 'application/gzip';

export interface ProcessAttachmentJob {
  readonly fileId: string;
  readonly quarantineKey: string;
  readonly claimedMime: string;
  readonly detectedMime: AllowedMime;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly traceContext: Readonly<Record<string, string>>;
}
