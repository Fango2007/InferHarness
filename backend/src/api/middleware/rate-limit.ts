import { FastifyReply, FastifyRequest } from 'fastify';

export interface RateLimitOptions {
  keyPrefix: string;
  maxRequests: number;
  windowMs: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

function clientAddress(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function routeKey(request: FastifyRequest): string {
  const routeUrl = request.routeOptions.url ?? request.url;
  return `${request.method}:${routeUrl}`;
}

export function createRateLimitPreHandler(options: RateLimitOptions) {
  const buckets = new Map<string, RateLimitBucket>();

  return async function rateLimitPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const now = Date.now();
    const key = `${options.keyPrefix}:${clientAddress(request)}:${routeKey(request)}`;
    const current = buckets.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count <= options.maxRequests) {
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return reply
      .code(429)
      .header('Retry-After', String(retryAfterSeconds))
      .send({ error: 'Too many requests' });
  };
}
