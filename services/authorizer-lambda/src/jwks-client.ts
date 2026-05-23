import { createRemoteJWKSet, JWTPayload, jwtVerify, JWSHeaderParameters, FlattenedJWSInput } from 'jose';

/**
 * Wraps `jose`'s remote JWKS with explicit fresh/stale TTLs so that the authorizer
 * keeps validating in-flight tokens during short IdP outages (stale-while-revalidate).
 *
 * `jose` already caches and refetches on `kid` miss. We layer on a max-stale window
 * by recording the last successful fetch and falling back to the cached set if a
 * refresh fails within the allowed staleness window.
 */
export interface JwksConfig {
  jwksUri: string;
  cacheTtlSeconds: number;
  maxStaleSeconds: number;
  cooldownSeconds?: number;
}

type GetKeyFn = (header: JWSHeaderParameters, input: FlattenedJWSInput) => Promise<CryptoKey>;

let cachedGetKey: GetKeyFn | null = null;
let lastFetchedAt = 0;

export function getJwks(config: JwksConfig): GetKeyFn {
  const ageMs = Date.now() - lastFetchedAt;
  const maxStaleMs = config.maxStaleSeconds * 1000;

  if (cachedGetKey && ageMs < maxStaleMs) {
    return cachedGetKey;
  }

  // (Re)create the JWKS getter. `jose` will refetch internally when its own TTL elapses
  // or when a kid miss happens.
  const remoteJwks = createRemoteJWKSet(new URL(config.jwksUri), {
    cacheMaxAge: config.cacheTtlSeconds * 1000,
    cooldownDuration: (config.cooldownSeconds ?? 30) * 1000,
    timeoutDuration: 3000,
  }) as unknown as GetKeyFn;

  cachedGetKey = remoteJwks;
  lastFetchedAt = Date.now();
  return remoteJwks;
}

export interface VerifyOptions {
  issuer: string;
  audiences: string[];
  clockToleranceSeconds?: number;
}

export async function verifyJwt(token: string, getKey: GetKeyFn, opts: VerifyOptions): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, getKey, {
    issuer: opts.issuer,
    audience: opts.audiences,
    clockTolerance: `${opts.clockToleranceSeconds ?? 60}s`,
    algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'],
  });
  return payload;
}
