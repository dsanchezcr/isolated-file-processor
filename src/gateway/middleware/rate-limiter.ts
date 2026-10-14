import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export async function registerRateLimiter(server: FastifyInstance): Promise<void> {
  await server.register(rateLimit, { max: 30, timeWindow: '1 minute' });
}
