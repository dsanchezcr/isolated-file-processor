export interface TelemetryPort {
  inject(): Readonly<Record<string, string>>;
  run<T>(name: string, carrier: Readonly<Record<string, string>>, operation: () => Promise<T>): Promise<T>;
  incident(fileId: string, reason: string): void;
  shutdown(): Promise<void>;
}
