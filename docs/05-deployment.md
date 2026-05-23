# 05 — Deployment & CI/CD

## Single source of truth

All API contracts are **OpenAPI 3.1** specs in this repo. CI publishes the same spec to both gateways, eliminating the most common federation failure mode (gateways drift apart).

```mermaid
flowchart LR
    Dev["Developer"] --> PR["Pull request<br/>openapi/*.yaml"]
    PR --> Lint["CI: spectral lint<br/>+ schema validate"]
    Lint --> Review["Peer review"]
    Review --> Main["main branch"]
    Main --> Publish

    subgraph Publish["CI: Publish job"]
        direction LR
        XAWS["x-edge: aws | both<br/>→ CDK deploy"]
        XOP["x-edge: onprem | both<br/>→ webMethods REST publish"]
    end

    XAWS --> AWSAPI["AWS API Gateway"]
    XOP  --> WMAPI["webMethods API Gateway"]
```

## Pipeline stages

```mermaid
sequenceDiagram
    autonumber
    participant Dev as Developer
    participant GH as GitHub Actions
    participant AWS as AWS account
    participant WM as webMethods APIGW
    participant Test as Smoke test runner

    Dev->>GH: push to main
    GH->>GH: lint OpenAPI (spectral)
    GH->>GH: cdk synth + diff
    GH->>AWS: cdk deploy (per region)
    par publish in parallel
        GH->>WM: POST /rest/apigateway/apis (DC-1)
        GH->>WM: POST /rest/apigateway/apis (DC-2)
    end
    GH->>Test: run contract + smoke tests
    Test-->>GH: results
    GH-->>Dev: green/red
```

## Branching & promotion

| Branch | Target |
|---|---|
| `feature/*` | sandbox AWS account + webMethods sandbox tenant |
| `main` | dev + staging (auto) |
| tag `v*.*.*` | prod (manual approval gate) |

## Environments

| Env | AWS account | webMethods tenant | IdP realm |
|---|---|---|---|
| dev | `ssp-dev`     | `wm-dev`     | `idp-dev` |
| stg | `ssp-stg`     | `wm-stg`     | `idp-stg` |
| prd | `ssp-prd-a`, `ssp-prd-b` | `wm-prd-dc1`, `wm-prd-dc2` | `idp-prd` |

## Rollback

- **AWS APIGW**: CDK retains last 5 deployments per stage; revert with `aws apigateway update-stage --patch-operations op=replace,path=/deploymentId,value=...` (wired into a `rollback.yml` workflow).
- **webMethods**: every publish creates a versioned API; promotion to the consumer-facing alias is a separate step. Rollback = re-point alias.
- **Database/schema**: out of scope here — owned by individual backend teams.

## Secret handling

- AWS: Secrets Manager + IAM-scoped retrieval at runtime.
- webMethods: Secure Store (configured by the platform team — not in this repo).
- CI: GitHub Actions OIDC → AWS IAM role (no long-lived AWS keys); webMethods publish uses a scoped service account via OIDC-issued short-lived token.

## What's NOT in CI

- IdP configuration (clients, scopes) — managed by IAM team in their own pipeline.
- Network changes (DX, VPN, NLB) — owned by network team, change-controlled.
- webMethods platform upgrades — owned by integration platform team.

This separation keeps API delivery fast without forcing API teams through platform-team review queues.
