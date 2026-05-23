# CDK — Federated API Gateway

Deploys the AWS half of the federation:

- **HTTP API v2** for `/aws/*` routes with **native JWT authorizer** (validates against SSP IdP JWKS).
- **REST API v1** for `/onprem/*` routes with **Lambda JWT authorizer** + **VPC Link → NLB** to webMethods.
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
- `onpremNlbDns` — DNS the VPC Link integration calls
- `primaryRegion`, `secondaryRegion`

## What this stack does NOT create (intentionally)

- **Route53 hosted zone / failover records** — owned by the platform DNS team
- **NLB target groups for webMethods** — populated by the network team (DX/VPN side)
- **CloudFront + WAF distribution** — fronts the API Gateway domain, owned by the edge team
- **The IdP itself** — Cognito user pool / Okta / Ping config lives in the IAM team's pipeline

Those are deliberately out of scope to keep this stack idempotent and to respect organizational boundaries.
