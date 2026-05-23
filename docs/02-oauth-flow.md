# 02 — Federated OAuth / JWT Flow

## Trust model

- **One Authorization Server**: the SSP IdP. Issues RS256 JWT access tokens.
- **Two Resource Servers**: AWS API Gateway and webMethods API Gateway. Each validates tokens **independently** against the IdP's JWKS endpoint.
- **No transitive trust** — if the JWT is invalid, webMethods rejects it even if AWS APIGW already accepted it.

## Token issuance + dual validation (pass-through JWT)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant SSP as SSP Web/App
    participant IdP as SSP IdP (AS)
    participant AWS as AWS API Gateway
    participant LA as Lambda JWT Authorizer
    participant WM as webMethods APIGW
    participant BE as On-prem Backend

    User->>SSP: Sign in
    SSP->>IdP: /authorize (PKCE)
    IdP-->>SSP: code
    SSP->>IdP: /token (code + verifier)
    IdP-->>SSP: access_token (JWT, RS256)

    SSP->>AWS: GET /onprem/orders/123<br/>Authorization: Bearer <JWT>
    AWS->>LA: Invoke authorizer (token, methodArn)
    LA->>IdP: GET /.well-known/jwks.json (cached)
    IdP-->>LA: JWKS
    LA->>LA: Verify sig, iss, aud, exp, scope
    LA-->>AWS: Allow + principalId + context

    AWS->>WM: GET /orders/123 (mTLS)<br/>Authorization: Bearer <JWT><br/>traceparent: 00-...
    WM->>WM: JWT policy: validate via JWKS (cached)
    alt JWT valid
        WM->>BE: GET /orders/123
        BE-->>WM: 200 OK
        WM-->>AWS: 200 OK
        AWS-->>SSP: 200 OK
    else JWT invalid
        WM-->>AWS: 401 Unauthorized
        AWS-->>SSP: 401 Unauthorized
    end
```

## Token shape (example)

```json
{
  "iss": "https://idp.ssp.example.com",
  "sub": "user-123",
  "aud": ["ssp-edge", "onprem-orders-api"],
  "scope": "orders:read orders:write profile",
  "azp": "ssp-webapp",
  "exp": 1718812800,
  "iat": 1718809200,
  "nbf": 1718809200,
  "jti": "f4c2...",
  "tenant": "acme"
}
```

- `aud` is a **list** so the same token is accepted by both AWS edge AND the on-prem API.
- `scope` is the authorization unit — enforced per operation in **both** gateways.
- `azp` (authorized party) identifies the client application — useful for per-app rate limits.

## JWKS caching strategy

```mermaid
flowchart LR
    A["Request arrives"] --> B{"kid in cache?"}
    B -- yes --> C{"Cache age &lt; TTL?"}
    B -- no  --> D["Fetch JWKS from IdP"]
    C -- yes --> E["Verify with cached key"]
    C -- no  --> D
    D --> F{"Fetch OK?"}
    F -- yes --> G["Update cache (TTL=1h)"]
    F -- no  --> H{"Cache age &lt; max-stale (6h)?"}
    H -- yes --> E
    H -- no  --> I["Reject 503"]
    G --> E
    E --> J["Continue request"]
```

- **TTL**: 1 hour fresh.
- **Stale-while-revalidate** up to 6 hours if IdP is unreachable — keeps in-flight tokens working during short IdP outages.
- Refresh on `kid` miss (key rotation).
- Alarm on cache age > 6h.

## Why pass-through JWT (v1) and not Token Exchange (v2)

| | Pass-through (chosen) | Token Exchange (RFC 8693) |
|---|---|---|
| Complexity | Low | High — adds an exchange endpoint, separate token lifecycle |
| Audit trail | Single token across hops | Cleaner: separate downstream token per hop |
| Use when | User identity is enough end-to-end | Need impersonation, delegation, or service identity at the downstream |
| Recommended phase | v1 | v2 |

Start with pass-through. Move to token exchange when there's a concrete need (typically: a service-to-service path that must not carry user identity, or when downstream APIs need their own audience without bloating `aud`).

## Failure modes

| Failure | Behavior | Mitigation |
|---|---|---|
| IdP down | No new tokens; in-flight tokens keep working | 15–60 min access token TTL; aggressive JWKS cache |
| JWKS fetch fails | Stale-while-revalidate up to 6h | Alarm + on-call page after 6h |
| Token expired mid-request | 401 from either gateway | SSP refresh token flow + transparent retry |
| Clock skew | Bogus `exp`/`nbf` rejections | 60s leeway in validators; enforce NTP on webMethods |
| Key rotation | `kid` miss | Force JWKS refresh on cache miss |
