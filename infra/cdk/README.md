# CDK — Federated API Gateway

Deploys the AWS half of the federation:

- **HTTP API v2** for `/aws/*` routes with **native JWT authorizer** (validates against SSP IdP JWKS).
- **REST API v1** for `/onprem/*` routes with **Lambda JWT authorizer** + **VPC Link → NLB** to webMethods (Option 1 — pass-through JWT).
- **(Optional) REST API v1** for `/onprem-tx/{aud}/{scope}/{proxy+}` routes — backed by the **Token Exchange Lambda** + **ElastiCache Redis** (Option 2 — RFC 8693). Enabled per-region via `enableTokenExchange` context.
- Stack is parameterized for **primary** and **secondary** regions (multi-region active/passive via Route53 outside this stack).

## Prerequisites

- AWS CLI v2 configured with credentials for the target account
- Node.js 20+
- `npm ci` (uses lockfile if present, else npm install)
- CDK bootstrapped: `npx cdk bootstrap aws://<account>/<region>` for **both** primary and secondary regions

## Deploy

```bash
npm ci
npm run build
npx cdk synth
npx cdk deploy FederatedApiGw-Primary
npx cdk deploy FederatedApiGw-Secondary
```

## Configuration

Edit `cdk.json` `context.ssp` to set:

- `idpIssuer`, `idpJwksUri`, `expectedAudiences`
- `idpTokenUrl`, `idpEdgeClientId` — only needed when `enableTokenExchange` is true
- `onpremNlbDns` — DNS the VPC Link integration calls
- `primaryRegion`, `secondaryRegion`
- `enableTokenExchange.{primary,secondary}` — toggle Option 2 per region (Redis + TX Lambda costs)

### Option 2 routing convention

Routes that use token exchange are exposed at `/onprem-tx/{aud}/{scope}/{proxy+}`. The path segments `{aud}` and `{scope}` are mapped by integration-request parameters into the `x-target-audience` and `x-required-scope` headers the Token Exchange Lambda consumes — clients don't see this; the developer portal hides it in the route definition.

Example: `GET /onprem-tx/onprem-orders-api/orders:read/orders/123` exchanges the user's token for one with `aud=onprem-orders-api, scope=orders:read`, then proxies `GET /orders/123` to webMethods.

### Option 2 client secret

For non-dev environments, **pre-create** the SSP edge client secret in Secrets Manager and pass it to the `TokenExchange` construct via `existingClientSecret` instead of letting it create the placeholder. The current default (`createPlaceholderSecret: true`) writes `"REPLACE_ME_IN_PROD"` — safe for synth/diff but useless at runtime.

## What this stack does NOT create (intentionally)

- **Route53 hosted zone / failover records** — owned by the platform DNS team
- **NLB target groups for webMethods** — populated by the network team (DX/VPN side)
- **CloudFront + WAF distribution** — fronts the API Gateway domain, owned by the edge team
- **The IdP itself** — Cognito user pool / Okta / Ping config lives in the IAM team's pipeline
- **The real SSP edge client secret** — pre-created by the IAM team in Secrets Manager (this stack only creates a placeholder for dev)
- **IdP-side token exchange grant config** (`token_exchange_target_audiences`) — IAM team's pipeline

Those are deliberately out of scope to keep this stack idempotent and to respect organizational boundaries.
