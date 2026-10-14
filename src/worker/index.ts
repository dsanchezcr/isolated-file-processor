import { OTelAdapter, startTelemetry } from '../infrastructure/telemetry/otel.adapter.js';

const telemetry = new OTelAdapter(startTelemetry());
try {
  // Runtime SDKs are imported only after auto-instrumentation is registered.
  const { main } = await import('./main.js');
  await main(telemetry);
} catch {
  console.error('Worker startup failed; verify configuration and execution-host dependencies');
  process.exitCode = 1;
  try { await telemetry.shutdown(); } catch { process.exitCode = 1; }
}
