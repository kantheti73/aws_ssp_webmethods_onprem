import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { request } from 'undici';
import { exchangeToken, TokenExchangeError } from './token-exchange';
import { getCached, setCached, deriveKey } from './redis-cache';
import { getClientSecret } from './secrets';

/**
 * Token Exchange Lambda — handles Option-2 routes for the federated APIGW.
 *
 *  1. Receives the original user JWT in Authorization header.
 *  2. Decodes (does NOT verify — already verified by the upstream authorizer)
 *     to pull sub/azp/scope claims for the cache key.
 *  3. Looks up Redis for a fresh downstream token.
 *  4. On cache miss, calls the IdP /token endpoint (RFC 8693) and stores result.
 *  5. Forwards the request to webMethods over the private path, replacing
 *     the Authorization header with the downstream token.
 *  6. Returns the webMethods response verbatim.
 *
 * This Lambda runs inside the VPC, in the same subnets as the ElastiCache
 * Redis cluster and the NLB that fronts webMethods.
 */

const IDP_TOKEN_URL = required('IDP_TOKEN_URL');
const IDP_CLIENT_ID = required('IDP_CLIENT_ID');
const IDP_CLIENT_SECRET_ARN = required('IDP_CLIENT_SECRET_ARN');
const REDIS_ENDPOINT = required('REDIS_ENDPOINT');
const REDIS_TLS = (process.env.REDIS_TLS ?? 'true').toLowerCase() === 'true';
const WM_BASE_URL = required('WM_BASE_URL'); // e.g. https://wm-apigw-internal.example.com
const AUDIENCE_HEADER = 'x-target-audience';
const SCOPE_HEADER = 'x-required-scope';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

interface DecodedClaims {
  sub: string;
  azp: string;
  scope: string;
}

/** Base64URL-decode the payload segment without signature verification. */
function decodeClaims(token: string): DecodedClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_jwt');
  const payload = JSON.parse(
    Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  );
  return {
    sub: String(payload.sub ?? ''),
    azp: String(payload.azp ?? payload.client_id ?? ''),
    scope: String(payload.scope ?? ''),
  };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const headers = lowercase(event.headers ?? {});
  const auth = headers['authorization'];
  if (!auth?.toLowerCase().startsWith('bearer ')) {
    return text(401, 'missing_bearer');
  }
  const userToken = auth.slice('bearer '.length).trim();

  const targetAudience = headers[AUDIENCE_HEADER];
  const requiredScope = headers[SCOPE_HEADER] ?? '';
  if (!targetAudience) {
    return text(500, `routing_misconfigured: ${AUDIENCE_HEADER} header missing`);
  }

  let claims: DecodedClaims;
  try {
    claims = decodeClaims(userToken);
  } catch {
    return text(401, 'invalid_jwt');
  }

  // 1) Try cache
  const cacheCfg = { endpoint: REDIS_ENDPOINT, tlsEnabled: REDIS_TLS };
  const key = deriveKey({
    subjectClaim: claims.sub,
    actorClient: claims.azp,
    audience: targetAudience,
    scope: requiredScope || claims.scope,
  });
  let downstreamToken: string | null = null;
  const cached = await getCached(cacheCfg, key);
  if (cached) {
    downstreamToken = cached.accessToken;
  } else {
    // 2) Cache miss → exchange
    try {
      const clientSecret = await getClientSecret(IDP_CLIENT_SECRET_ARN);
      const resp = await exchangeToken(
        {
          tokenUrl: IDP_TOKEN_URL,
          clientId: IDP_CLIENT_ID,
          clientSecret,
          timeoutMs: 3000,
        },
        {
          subjectToken: userToken,
          audience: targetAudience,
          scope: requiredScope || claims.scope,
        },
      );
      downstreamToken = resp.accessToken;
      await setCached(cacheCfg, key, resp);
    } catch (err) {
      if (err instanceof TokenExchangeError) {
        console.log(
          JSON.stringify({
            evt: 'token_exchange_failed',
            status: err.httpStatus,
            audience: targetAudience,
          }),
        );
        return text(err.httpStatus >= 500 ? 503 : 401, 'token_exchange_failed');
      }
      throw err;
    }
  }

  // 3) Forward to webMethods with the downstream token
  const targetPath = event.path; // already includes /onprem-tx/... — strip prefix
  const wmPath = targetPath.replace(/^\/onprem-tx/, '');
  const url = `${WM_BASE_URL}${wmPath}`
    + (event.queryStringParameters
        ? '?' + new URLSearchParams(event.queryStringParameters as Record<string, string>).toString()
        : '');

  const forwardHeaders: Record<string, string> = {
    'Authorization': `Bearer ${downstreamToken}`,
    'Content-Type': headers['content-type'] ?? 'application/json',
    'Accept': headers['accept'] ?? 'application/json',
    'traceparent': headers['traceparent'] ?? '',
    'Idempotency-Key': headers['idempotency-key'] ?? '',
  };

  const { statusCode, body: respBody, headers: respHeaders } = await request(url, {
    method: event.httpMethod as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    headers: forwardHeaders,
    body: event.body ?? undefined,
    bodyTimeout: 25000,
    headersTimeout: 5000,
  });

  const responseBody = await respBody.text();

  return {
    statusCode,
    body: responseBody,
    headers: {
      'content-type': String(respHeaders['content-type'] ?? 'application/json'),
    },
  };
};

function text(status: number, body: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    body: JSON.stringify({ error: body }),
    headers: { 'content-type': 'application/json' },
  };
}

function lowercase(h: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = v;
  return out;
}
