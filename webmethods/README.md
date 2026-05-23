# webMethods API Gateway — Federation Config

Files in this directory configure webMethods API Gateway (10.7+) to:

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

## Version compatibility note

This config assumes **webMethods API Gateway 10.7 or later**, where:
- JWT identifier supports JWKS URI directly with cache + cooldown semantics.
- Multi-valued `aud` claim handling works out of the box.

If you're on 10.5–10.6, you'll need a custom Integration Server (IS) service to fetch and cache JWKS, then a Custom Identifier policy that calls into it. Talk to the integration platform team before publishing this config to a sub-10.7 environment.

## What this config does NOT cover

- **Inbound mTLS truststore setup** — done by the platform team in webMethods Security → Truststores.
- **Splunk HEC token** — provisioned by the observability team and referenced as `@secret:splunk-hec-token`.
- **Backend service URLs** — placeholders here; real values come from the environment-specific config map.
