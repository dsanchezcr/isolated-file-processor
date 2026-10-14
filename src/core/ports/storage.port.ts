export type ByteStream = AsyncIterable<Uint8Array>;
export type StorageArea = 'quarantine' | 'clean';

export interface StoragePort {
  put(area: StorageArea, key: string, source: ByteStream, mime: string): Promise<void>;
  get(area: StorageArea, key: string): Promise<ByteStream>;
  delete(area: StorageArea, key: string): Promise<void>;
}
