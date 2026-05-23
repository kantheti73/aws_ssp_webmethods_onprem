# aws_ssp_webmethods_onprem

Reference implementation of a **federated API Gateway** architecture that fronts:

- **AWS-native backends** (Lambda, Spring Boot on ECS, S3) for a Self Service Portal (SSP)
- **On-prem services** protected by **IBM webMethods API Gateway**

…behind a single consumer experience, with **federated OAuth 2.0 / JWT** validated independently by both gateways and resilient multi-region / multi-DC failover.

## Repository layout

```
aws_ssp_webmethods_onprem/
├── docs/                     # Architecture + Mermaid flow charts (render on GitHub)
├── infra/cdk/                # AWS CDK (TypeScript) - APIGW, VPC Link, Lambda, multi-region
├── services/
│   ├── authorizer-lambda/        # JWT authorizer for AWS API Gateway (Node.js)
│   ├── sample-lambda/            # Sample AWS-native API handler
│   ├── token-exchange-lambda/    # Option-2 RFC 8693 token exchange + Redis cache (Node.js)
│   └── ssp-springboot/           # SSP Spring Boot client demonstrating Resilience4j + JWT
├── webmethods/               # webMethods API Gateway JWT policy + API definition + deploy script
└── .github/workflows/        # CI: CDK synth, lint, build
```

## Read the docs first

| Doc | What it covers |
|---|---|
| [01-architecture.md](docs/01-architecture.md) | Logical components and how they fit together |
| [02-oauth-flow.md](docs/02-oauth-flow.md)     | Token issuance + dual-gateway JWT validation sequence |
| [03-routing.md](docs/03-routing.md)           | How a request is classified and routed |
| [04-failover.md](docs/04-failover.md)         | DR / failover state machine |
| [05-deployment.md](docs/05-deployment.md)     | CI/CD spec → dual-gateway publishing pipeline |

## Quickstart (local development)

```bash
# 1. AWS infra (requires AWS creds + CDK bootstrap in target account/region)
cd infra/cdk
npm ci
npm run build
npx cdk synth
npx cdk deploy

# 2. Lambda authorizer (built and deployed by CDK)
cd ../../services/authorizer-lambda
npm ci && npm run build

# 3. SSP Spring Boot client
cd ../ssp-springboot
./mvnw spring-boot:run

# 4. webMethods API publish (run from a host with network access to the APIGW)
cd ../../webmethods
pwsh ./deploy-api.ps1 -GatewayUrl https://wm-apigw.internal:5555 -Credential (Get-Credential)
```

## Required environment

| Var | Purpose |
|---|---|
| `SSP_IDP_ISSUER` | OIDC issuer URL of the SSP IdP (e.g. `https://idp.ssp.example.com`) |
| `SSP_IDP_JWKS_URI` | JWKS endpoint, usually `${SSP_IDP_ISSUER}/.well-known/jwks.json` |
| `EXPECTED_AUDIENCES` | Comma-separated audiences this resource server accepts |
| `WM_APIGW_URL` | Internal URL of webMethods API Gateway |
| `ONPREM_NLB_DNS` | DNS of the NLB targeted by the VPC Link |

## Security notes

- Both gateways validate the JWT **independently** against the IdP's JWKS. There is no transitive trust.
- mTLS is enforced between AWS API Gateway and webMethods on the private network path.
- JWKS responses are cached with a documented refresh strategy (see [02-oauth-flow.md](docs/02-oauth-flow.md)).
- No credentials are stored in this repo. Secrets are pulled at runtime from AWS Secrets Manager / webMethods secure store.

## License

MIT — see [LICENSE](LICENSE).
