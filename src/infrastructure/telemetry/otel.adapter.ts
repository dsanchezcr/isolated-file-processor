import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import type { TelemetryPort } from '../../core/ports/telemetry.port.js';

export function startTelemetry(): NodeSDK | undefined {
  if (!process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return undefined;
  const sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    })],
  });
  sdk.start();
  return sdk;
}

export class OTelAdapter implements TelemetryPort {
  constructor(private readonly sdk?: NodeSDK) {}

  inject(): Readonly<Record<string, string>> {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return carrier;
  }

  async run<T>(name: string, carrier: Readonly<Record<string, string>>, operation: () => Promise<T>): Promise<T> {
    const parent = propagation.extract(context.active(), carrier);
    return context.with(parent, () => trace.getTracer('support-shield').startActiveSpan(name, async span => {
      try { return await operation(); }
      catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally { span.end(); }
    }));
  }

  incident(fileId: string, reason: string): void {
    console.error(JSON.stringify({ event: 'security.incident', fileId, reason, traceId: trace.getActiveSpan()?.spanContext().traceId }));
  }

  async shutdown(): Promise<void> { await this.sdk?.shutdown(); }
}
