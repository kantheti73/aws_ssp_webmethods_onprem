# Token Exchange Lambda (RFC 8693)

Backs Option-2 routes on the federated AWS API Gateway. Sits between the JWT authorizer and webMethods, performing per-call (cached) token exchange so the downstream sees a narrowed, short-lived, audience-scoped JWT instead of the user's original token.

See [`docs/02-oauth-flow.md`](../../docs/02-oauth-flow.md#option-2--token-exchange-rfc-8693) for the architectural rationale and sequence diagram.

## What it does, per request

1. Receives the user JWT (already validated by the upstream Lambda authorizer).
2. Decodes (no re-verify) to pull `sub`, `azp`, `scope` claims for cache key derivation.
3. Looks up Redis (ElastiCache) for a fresh exchanged token. **Cache hit**: skip to step 6.
4. **Cache miss**: calls the IdP `/token` endpoint with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, target `audience`, and narrowed `scope`.
5. Stores the result in Redis with TTL = `min(token_exp − now − 30s, 240s)`.
6. Forwards the original request to webMethods, replacing the `Authorization` header with the downstream token.
7. Returns the webMethods response verbatim.

## Env vars

| Name | Required | Purpose |
|---|---|---|
| `IDP_TOKEN_URL` | yes | OAuth2 token endpoint of the SSP IdP |
| `IDP_CLIENT_ID` | yes | Client ID of the `ssp-edge` actor performing the exchange |
| `IDP_CLIENT_SECRET_ARN` | yes | Secrets Manager ARN holding the client secret |
| `REDIS_ENDPOINT` | yes | `host:port` of the ElastiCache primary endpoint |
| `REDIS_TLS` | no (default `true`) | Set `false` only for local testing |
| `WM_BASE_URL` | yes | Internal HTTPS base URL of webMethods APIGW |

## Routing convention

This Lambda is fronted at `/onprem-tx/{proxy+}` on the REST API. The caller (or the route definition) must supply two headers:

| Header | Example | Meaning |
|---|---|---|
| `x-target-audience` | `onprem-orders-api` | Downstream `aud` to request |
| `x-required-scope` | `orders:read` | Narrowed scope for the exchange |

In production these headers are injected by the API Gateway integration request mapping (declared per-route in the OpenAPI spec via `x-token-exchange-target` and `x-token-exchange-scope`) rather than expected from clients.

## What this Lambda deliberately does NOT do

- **Validate the JWT signature** — that's the upstream authorizer's job; doing it twice wastes CPU and the user-token validation has already happened.
- **Decide which routes need exchange** — that's a routing decision made by API Gateway based on path prefix and OpenAPI extensions.
- **Implement revocation** — short downstream TTL (≤300s) is the revocation strategy. If hard revocation is needed, add a Redis deny-list keyed by `jti`.

## Failure handling

| Failure | Behavior |
|---|---|
| Redis down | Cache miss → falls through to IdP. IdP load spikes 20×+ in this state; alarm on cache hit ratio < 90% |
| IdP `/token` 5xx | Return 503 to caller with `retry-after`; Resilience4j on caller will back off |
| IdP `/token` 4xx | Return 401 — the user token was rejected for exchange |
| Exchanged token decode failure | Return 502 — IdP returned malformed token (very rare; alarm immediately) |
| webMethods 5xx | Pass through; circuit breaker on the consumer side handles it |

## Local build

```bash
npm ci
npm run build
```

CDK bundles via esbuild — no manual zip step.
