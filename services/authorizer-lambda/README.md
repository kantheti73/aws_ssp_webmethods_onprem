# JWT Authorizer Lambda

REQUEST-type AWS API Gateway authorizer that validates the SSP-issued JWT against the IdP's JWKS.

## Why a Lambda authorizer (not the native JWT authorizer)?

- The native HTTP API v2 JWT authorizer is great for `/aws/*` routes (see `HttpJwtAuthorizer` in the CDK stack).
- For `/onprem/*` routes we use the REST API v1 because it supports `VPC Link → NLB` integrations natively. REST API v1 has no native JWT authorizer — this Lambda fills that gap and also lets us propagate custom claims (tenant, azp) into the integration request as headers.

## Behaviour

- Reads `Authorization: Bearer <JWT>`.
- Verifies signature via JWKS (cached, stale-while-revalidate).
- Enforces `iss`, `aud` (multi-valued), `exp`, with 60s clock leeway.
- Returns an IAM policy scoped to the whole API (cached for 5 min).
- Emits structured deny logs (no token contents).

## Env vars

| Name | Required | Default | Purpose |
|---|---|---|---|
| `SSP_IDP_ISSUER` | yes | — | Expected `iss` claim |
| `SSP_IDP_JWKS_URI` | yes | — | JWKS endpoint |
| `EXPECTED_AUDIENCES` | yes | — | CSV of accepted `aud` values |
| `JWKS_CACHE_TTL_SECONDS` | no | `3600` | Fresh window |
| `JWKS_MAX_STALE_SECONDS` | no | `21600` | Stale-while-revalidate window |

## Local build

```bash
npm ci
npm run build
```

CDK bundles it via `aws-cdk-lib/aws-lambda-nodejs` (esbuild) — no separate package upload step.
