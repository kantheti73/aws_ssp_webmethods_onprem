# 03 — Request Routing

## Path convention

| Prefix | Target | Backend |
|---|---|---|
| `/aws/*`     | AWS-native | Lambda / ECS / S3 (per route) |
| `/onprem/*`  | webMethods | Mapped to internal on-prem REST/SOAP services |
| `/health`    | Local | Returned by APIGW Mock Integration |
| `/.well-known/*` | Pass-through | For tooling and discovery |

## Decision flow

```mermaid
flowchart TD
    A["Incoming request<br/>Authorization: Bearer JWT"] --> WAF{"WAF rules"}
    WAF -- block --> X1["403"]
    WAF -- pass  --> AUTH["Lambda JWT Authorizer"]
    AUTH -- deny --> X2["401"]
    AUTH -- allow --> ROUTE{"Path prefix?"}
    ROUTE -- "/aws/*"    --> AWSB["AWS backend<br/>(Lambda / ECS / S3)"]
    ROUTE -- "/onprem/*" --> SCOPE{"Required scope<br/>in token?"}
    SCOPE -- no  --> X3["403 insufficient_scope"]
    SCOPE -- yes --> VPCL["VPC Link → NLB"]
    VPCL --> DX{"Direct Connect<br/>healthy?"}
    DX -- yes --> WM["webMethods APIGW (active/active)"]
    DX -- no  --> VPN["VPN failover"]
    VPN --> WM
    WM --> WMAUTH{"webMethods<br/>JWT policy"}
    WMAUTH -- invalid --> X4["401 from webMethods"]
    WMAUTH -- valid   --> BE["On-prem backend"]
    BE --> RESP["Response"]
    AWSB --> RESP
```

## Route classification rules

Routes are declared in OpenAPI specs with an `x-edge` extension. CI uses this to publish to the right gateway(s):

```yaml
paths:
  /onprem/orders/{id}:
    x-edge: onprem        # publish only to AWS APIGW with VPC Link target = webMethods
    get:
      x-required-scope: orders:read
      ...
  /aws/profile:
    x-edge: aws           # publish to AWS APIGW with Lambda target
    get:
      x-required-scope: profile
      ...
  /shared/catalog:
    x-edge: both          # publish to both — AWS APIGW serves cache, webMethods serves origin
```

## Scope enforcement

Both gateways enforce per-operation scopes:

| Gateway | Mechanism |
|---|---|
| AWS APIGW | Lambda Authorizer returns `context.scopes`; integration request maps to backend via VTL or HTTP API JWT authorizer with `authorizationScopes` |
| webMethods | Identify & Access → OAuth2/JWT scope policy attached to the API operation |

## Rate limiting strategy (don't double-throttle)

| Layer | Limit | Purpose |
|---|---|---|
| AWS APIGW Usage Plan | Per API key / per `azp` claim | Consumer-level quota |
| AWS APIGW Method | Per route burst limit | Spike protection |
| webMethods | Per backend operation | **Backend** protection (NOT consumer quota) |

Keep webMethods limits **higher** than AWS APIGW limits for any route reachable via AWS, so the edge always trips first. Otherwise consumers see opaque 429s from the inner gateway with no useful retry-after headers.
