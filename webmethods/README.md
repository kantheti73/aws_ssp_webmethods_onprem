# webMethods API Gateway — Federation Config

Files in this directory configure **webMethods API Gateway 10.15** to:

1. **Independently validate** JWTs issued by the SSP IdP (no trust in AWS APIGW).
2. **Expose on-prem REST APIs** to the AWS APIGW VPC-Link path with **mTLS** at the inbound edge.
3. **Enforce per-operation scopes** and rate limits.

## Files

| File | Purpose |
|---|---|
| [jwt-policy.json](jwt-policy.json) | Global JWT identification policy (JWKS-backed) |
| [api-definition-orders.json](api-definition-orders.json) | Example on-prem Orders API definition |
| [deploy-api.ps1](deploy-api.ps1) | Idempotent PowerShell publisher |

## Apply

```powershell
$cred = Get-Credential   # service account with "API Provider" role
.\deploy-api.ps1 -GatewayUrl https://wm-apigw.internal:5555 -Credential $cred
```

Repeat for the second DC (e.g., `wm-apigw-dc2.internal:5555`). CI in `.github/workflows/` runs both in parallel.

## Version target: 10.15

This config is written for **webMethods API Gateway 10.15** specifically. Relevant capabilities we rely on (all GA in 10.15):

- **JWKS-backed JWT identifier** with cache TTL + cooldown + clock-skew tolerance.
- **Multi-valued `aud` claim** handling natively (no custom identifier needed).
- **Scope policy** as a first-class operation-level enforcement point (`Authorize User` → `Scopes`).
- **Inbound mTLS** with truststore-based client cert subject filtering.
- **OAuth2/JWT introspection** as an optional fallback if you ever need opaque tokens (not used here).
- **Native `traceparent` propagation** for W3C trace context end-to-end.

### 10.15-specific things worth knowing

- The Identify & Access policy stage allows **multiple identifiers in priority order** — you could add a fallback API-key identifier for legacy callers without touching the JWT flow.
- JWKS cache parameters in 10.15 are runtime-configurable via the policy (no Integration Server fix-pack needed, unlike earlier 10.x).
- The REST Admin API endpoints used by `deploy-api.ps1` (`/rest/apigateway/apis`, `/policies`) are stable in 10.15 — no breaking changes vs 10.11+.

### If you ever roll back below 10.15

- **10.11–10.14**: same policy shape works; double-check the JWKS cooldown field name in your stage (it was renamed once in 10.11). Test in a sandbox first.
- **Sub-10.11**: you'll need a custom IS service for JWKS fetch/cache + a Custom Identifier policy. Don't attempt without integration-platform-team involvement.

## What this config does NOT cover

- **Inbound mTLS truststore setup** — done by the platform team in webMethods Security → Truststores.
- **Splunk HEC token** — provisioned by the observability team and referenced as `@secret:splunk-hec-token`.
- **Backend service URLs** — placeholders here; real values come from the environment-specific config map.
