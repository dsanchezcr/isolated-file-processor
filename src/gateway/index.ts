import { OTelAdapter, startTelemetry } from '../infrastructure/telemetry/otel.adapter.js';

const telemetry = new OTelAdapter(startTelemetry());

async function main(): Promise<void> {
  const [{ loadConfig, createStorage }, { BullMQAdapter }, { buildServer }] = await Promise.all([
    import('./config.js'), import('../infrastructure/queue/bullmq.adapter.js'), import('./server.js'),
  ]);
  const config = loadConfig();
  const queue = new BullMQAdapter(config.redisUrl);
  try {
    const server = await buildServer({ storage: createStorage(config), queue, telemetry }, config.apiKey);
    server.addHook('onClose', async () => { await queue.close(); await telemetry.shutdown(); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { void server.close().catch(() => { process.exitCode = 1; }); });
    }
    await server.listen({ port: config.port, host: config.host });
  } catch (error) {
    await queue.close();
    throw error;
  }
}

main().catch(async () => {
  console.error('Gateway startup failed; verify configuration and service dependencies');
  process.exitCode = 1;
  await telemetry.shutdown();
});
