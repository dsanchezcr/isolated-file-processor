import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { DomainError } from '../core/errors/domain-errors.js';
import { SECURITY_PROFILE } from '../core/domain/security-profile.js';
import { registerRateLimiter } from './middleware/rate-limiter.js';
import { registerHealthRoute } from './routes/health.route.js';
import { registerIngestionRoutes } from './routes/ingestion.route.js';
import type { GatewayDependencies } from './routes/ingestion.route.js';

export async function buildServer(deps: GatewayDependencies, apiKey: string) {
  if (apiKey.length < 32) throw new Error('API_KEY must contain at least 32 characters');
  const expected = createHash('sha256').update(['Bearer', apiKey].join(' ')).digest();
  const server = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: false,
    requestTimeout: 60_000,
    connectionTimeout: 65_000,
    bodyLimit: SECURITY_PROFILE.maxUploadBytes + 4096,
  });
  await registerRateLimiter(server);
  await server.register(multipart, { limits: { files: 1, fields: 0, parts: 1, fileSize: SECURITY_PROFILE.maxUploadBytes } });
  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url === '/health') return;
    const presented = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expected, presented)) await reply.code(401).send({ code: 'UNAUTHORIZED' });
  });
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      void reply.code(error.httpStatus).send({ code: error.code, message: error.message });
      return;
    }
    const suppliedStatus = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof suppliedStatus === 'number' && suppliedStatus >= 400 && suppliedStatus < 500 ? suppliedStatus : 503;
    if (status === 503) request.log.error('Ingestion operation failed');
    void reply.code(status).send({ code: status === 503 ? 'SERVICE_UNAVAILABLE' : 'INVALID_REQUEST' });
  });
  registerHealthRoute(server);
  registerIngestionRoutes(server, deps);
  return server;
}
