# aws_ssp_webmethods_onprem — Working Notes for Claude

Federated API Gateway architecture: AWS API Gateway (SSP edge) + IBM webMethods API Gateway (on-prem PEP) with federated OAuth and HA failover. Code + docs.

## Read first

- [`README.md`](README.md) — full doc index
- [`docs/01-architecture.md`](docs/01-architecture.md) — overall architecture (note: user has edited this to genericize service names to "citizens"/"XXX" placeholders)
- [`docs/02-oauth-flow.md`](docs/02-oauth-flow.md) — federated OAuth: Option 1 pass-through JWT (default) vs Option 2 RFC 8693 token exchange
- [`docs/06-network-architecture.md`](docs/06-network-architecture.md) — network design with AWS-icon PNG

## Tech stack

| Layer | Tech |
|---|---|
| Infra | AWS CDK (TypeScript) in `infra/cdk/` |
| Authorizer | Node.js Lambda with `jose` (JWKS with stale-while-revalidate) |
| Token Exchange | Node.js Lambda with `undici` + ElastiCache Redis (RFC 8693, cached) |
| SSP consumer | Spring Boot 3 (Java 21) with Resilience4j (CB / retry / bulkhead / timelimiter) |
| On-prem APIGW | IBM webMethods API Gateway **10.15** |
| CI/CD | GitHub Actions (`cdk.yml`, `spring.yml`, `openapi-lint.yml`) |

## webMethods version assumption

- **10.15** specifically (confirmed by user)
- JWT validation via JWKS, multi-`aud` claim, scope policy, inbound mTLS — all GA in 10.15
- No custom IS service workarounds required
- Below 10.11 you'd need a custom IS service for JWKS fetch — not in scope here

## Header filter Java service (`webmethods/flow-services/header-filter/`)

Three deployment options documented (don't conflate them):

| Option | What | When |
|---|---|---|
| **A** | Java service + Flow wrapper | Use when you need the filter in any IS Flow context |
| **B** | webMethods API Gateway built-in policy (**blocklist** — NOT regex; literal names; `${...}` is alias syntax) | Plain proxy/passthrough; no IS Flow involvement |
| **C** | Pure Flow inside `pub.apigateway.invokeISService` (RequestSpec → 4 MAP steps with LINK not COPY) | When already using `invokeISService` for other transforms (recommended for this design) |

Header allowlist: `Authorization` · `Content-Type` · `Accept` · `X-Correlation-ID` · `X-Request-ID` · `SOAPAction`

## Naming conventions

- **SSP** = Self Service Portal (the AWS-resident consumer)
- Path prefixes: `/aws/*` (AWS-native backends) · `/onprem/*` (Option 1 pass-through) · `/onprem-tx/*` (Option 2 token exchange via Lambda)
- mTLS between AWS APIGW VPC Link and webMethods
- W3C `traceparent` propagated end-to-end
- Strip inbound `Authorization` at edge; inject internal identity headers (`X-Client-App`, `X-User-Sub`, etc.) downstream

## CDK commands

```powershell
cd infra/cdk
npm ci          # required before synth; missing deps show as IDE TS errors but are not real
npm run build
npx cdk synth
```

## Working with the diagrams

- **Mermaid** for inline doc diagrams (renders on GitHub)
- **Python `diagrams` lib** for the AWS-icon network PNG — source in `docs/diagrams/network_architecture.py`
- Regenerate PNG: `python docs/diagrams/network_architecture.py` (requires Graphviz + diagrams pip pkg)

## Git / push conventions

- Branch: `main`
- Push via `gh` CLI (already auth'd; uses `gho_` browser-issued token in OS keyring)
- **Never** use the PAT the user pasted in chat on 2026-05-18 — it's revoked
- User has been making direct edits via GitHub web UI (genericizing API names to `XXX` placeholders) — always `git pull --rebase origin main` before push to avoid rejected push
- Commit messages: full explanatory body (multi-line); always include rationale

## Notes on user-direct edits

The user has been editing `docs/01-architecture.md` and `docs/02-oauth-flow.md` directly on GitHub to genericize service references (e.g. `onprem-orders-api` → `onprem-XXX-api`, `orders:read` → `XXX:read`, "Lambda (/aws/orders)" → "Lambda (/aws/citizens)"). These are intentional — leave them alone, don't revert. If you regenerate sections, preserve the user's placeholder style.

## What this repo is NOT

- Not a working production deployment — it's a reference implementation
- The 4-environment matrix discussed in the MuleSoftArchitecture project doesn't apply here; this is the reference architecture for one stack
