import Redis, { Redis as RedisClient } from 'ioredis';
import { createHash } from 'crypto';
import type { ExchangeResponse } from './token-exchange';

/**
 * Redis-backed cache for exchanged tokens.
 *
 * Key shape: tx:v1:<sha256(sub|azp|aud|sorted_scopes)>
 * Value: JSON { accessToken, expiresAtEpoch }
 * TTL:   min(token_exp - now - 30s, MAX_CACHE_SECONDS)
 *
 * The 30s safety margin guarantees we never serve a token within 30 seconds of
 * its real expiry. MAX_CACHE_SECONDS caps the window regardless of token TTL —
 * useful when revocation is needed (TTL roof = max blast radius window).
 */
const MAX_CACHE_SECONDS = 240;
const SAFETY_SECONDS = 30;

export interface CacheKeyInputs {
  subjectClaim: string; // jwt.sub
  actorClient: string;  // jwt.azp (the calling app)
  audience: string;
  scope: string;        // space-separated; will be normalized
}

export interface RedisCacheConfig {
  endpoint: string; // host:port
  tlsEnabled: boolean;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

let client: RedisClient | null = null;

export function getClient(cfg: RedisCacheConfig): RedisClient {
  if (client) return client;
  const [host, portStr] = cfg.endpoint.split(':');
  client = new Redis({
    host,
    port: parseInt(portStr ?? '6379', 10),
    tls: cfg.tlsEnabled ? {} : undefined,
    connectTimeout: cfg.connectTimeoutMs ?? 1500,
    commandTimeout: cfg.commandTimeoutMs ?? 200,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // fail fast on cache outage so caller falls back to IdP
    lazyConnect: false,
  });
  client.on('error', (err) => {
    console.log(JSON.stringify({ evt: 'redis_error', msg: err.message }));
  });
  return client;
}

export function deriveKey(inputs: CacheKeyInputs): string {
  const normalizedScope = inputs.scope.split(/\s+/).filter(Boolean).sort().join(' ');
  const material = `${inputs.subjectClaim}|${inputs.actorClient}|${inputs.audience}|${normalizedScope}`;
  const hash = createHash('sha256').update(material).digest('hex');
  return `tx:v1:${hash}`;
}

export interface CachedToken {
  accessToken: string;
  expiresAtEpoch: number;
}

export async function getCached(
  cfg: RedisCacheConfig,
  key: string,
): Promise<CachedToken | null> {
  try {
    const raw = await getClient(cfg).get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedToken;
    const now = Math.floor(Date.now() / 1000);
    if (parsed.expiresAtEpoch - now < SAFETY_SECONDS) {
      // Near expiry — treat as miss so we mint a fresh one.
      return null;
    }
    return parsed;
  } catch {
    // Any Redis problem → treat as miss; the caller will fall through to IdP.
    return null;
  }
}

export async function setCached(
  cfg: RedisCacheConfig,
  key: string,
  resp: ExchangeResponse,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const livingSeconds = Math.max(0, resp.expiresAtEpoch - now - SAFETY_SECONDS);
  const ttl = Math.min(livingSeconds, MAX_CACHE_SECONDS);
  if (ttl <= 0) return;

  const payload: CachedToken = {
    accessToken: resp.accessToken,
    expiresAtEpoch: resp.expiresAtEpoch,
  };
  try {
    await getClient(cfg).set(key, JSON.stringify(payload), 'EX', ttl);
  } catch {
    // Cache write failure is non-fatal — we already have the token to return.
  }
}
