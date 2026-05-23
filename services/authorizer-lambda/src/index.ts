import type {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
  PolicyDocument,
  Statement,
} from 'aws-lambda';
import { getJwks, verifyJwt } from './jwks-client';

const ISSUER = required('SSP_IDP_ISSUER');
const JWKS_URI = required('SSP_IDP_JWKS_URI');
const AUDIENCES = required('EXPECTED_AUDIENCES').split(',').map(s => s.trim()).filter(Boolean);
const CACHE_TTL = parseInt(process.env.JWKS_CACHE_TTL_SECONDS ?? '3600', 10);
const MAX_STALE = parseInt(process.env.JWKS_MAX_STALE_SECONDS ?? '21600', 10);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * REQUEST-type Lambda authorizer for AWS API Gateway (REST API v1).
 *
 * Validates the Authorization: Bearer <JWT> header against the SSP IdP's JWKS.
 * Returns an IAM policy plus context that the integration can forward to webMethods.
 *
 * Caching: API Gateway caches authorizer responses by `identitySource` for the
 * authorizer's `resultsCacheTtl` (set in CDK to 5 min). Inside this function we
 * additionally cache the JWKS using stale-while-revalidate so short IdP outages
 * don't break in-flight requests.
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const headers = lowercase(event.headers ?? {});
  const authHeader = headers['authorization'];

  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return deny('Anonymous', event.methodArn, 'missing_bearer');
  }
  const token = authHeader.slice('bearer '.length).trim();
  if (!token) return deny('Anonymous', event.methodArn, 'empty_token');

  try {
    const getKey = getJwks({
      jwksUri: JWKS_URI,
      cacheTtlSeconds: CACHE_TTL,
      maxStaleSeconds: MAX_STALE,
    });
    const claims = await verifyJwt(token, getKey, {
      issuer: ISSUER,
      audiences: AUDIENCES,
    });

    const sub = String(claims.sub ?? 'unknown');
    const scopes = String(claims.scope ?? '').split(/\s+/).filter(Boolean);
    const azp = String(claims['azp'] ?? '');
    const tenant = String(claims['tenant'] ?? '');

    // Per-operation scope check based on the matched route (best effort —
    // for HTTP API JWT authorizer the gateway does this natively; here we
    // pass scopes down to the integration via context for backend re-checks).
    return allow(sub, event.methodArn, {
      sub,
      scopes: scopes.join(' '),
      azp,
      tenant,
      jti: String(claims['jti'] ?? ''),
    });
  } catch (err) {
    const reason = (err as Error).message ?? 'jwt_invalid';
    // Log structured failure for forensics. Do NOT log the token itself.
    console.log(
      JSON.stringify({
        evt: 'authz_denied',
        reason,
        path: event.path,
        sourceIp: event.requestContext?.identity?.sourceIp,
      }),
    );
    return deny('Anonymous', event.methodArn, reason);
  }
};

function lowercase(h: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = v;
  return out;
}

function allow(
  principalId: string,
  methodArn: string,
  context: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: policy('Allow', wildcardArn(methodArn)),
    context,
  };
}

function deny(principalId: string, methodArn: string, reason: string): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: policy('Deny', wildcardArn(methodArn)),
    context: { reason },
  };
}

/**
 * Replace the path portion of the methodArn with a wildcard so the cached
 * policy applies to every route in the API for the same caller — avoids
 * re-invoking the authorizer per route while the same token is valid.
 */
function wildcardArn(methodArn: string): string {
  // arn:aws:execute-api:region:account:apiId/stage/HTTP_METHOD/path
  const parts = methodArn.split(':');
  const apiPart = parts[5];
  const apiPieces = apiPart.split('/');
  return `${parts.slice(0, 5).join(':')}:${apiPieces[0]}/${apiPieces[1]}/*/*`;
}

function policy(effect: 'Allow' | 'Deny', resource: string): PolicyDocument {
  const stmt: Statement = {
    Action: 'execute-api:Invoke',
    Effect: effect,
    Resource: resource,
  };
  return { Version: '2012-10-17', Statement: [stmt] };
}
