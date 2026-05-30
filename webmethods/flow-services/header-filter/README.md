# Header Filter Flow Service (webMethods 10.15)

Strips every HTTP header except the six the SSP federation needs downstream:

| Header | Why we keep it |
|---|---|
| `Authorization` | The Bearer JWT (Option 1 pass-through or Option 2 exchanged) |
| `Content-Type` | Body parsing on the backend |
| `Accept` | Content negotiation |
| `X-Correlation-ID` | App-level correlation for logs |
| `X-Request-ID` | Per-request idempotency / replay protection |
| `SOAPAction` | Required for legacy SOAP backends |

Everything else (`x-amzn-trace-id`, `x-forwarded-*`, `via`, `x-amz-cf-id`, `host`, internal AWS API Gateway metadata, etc.) is dropped before the call leaves webMethods to the on-prem backend.

---

## Two ways to deploy this

### Option A — Flow + Java service (this directory)

Use when you need the filtering inside an IS Flow — typically when webMethods is doing protocol mediation (REST→SOAP, REST→MQ), custom transformations, or anything beyond what an API Gateway policy can express.

**Files:**

| Path | Purpose |
|---|---|
| `code/source/myorg/api/util/headers/HeaderFilter.java` | Java service — the actual iteration & filter |
| `flow-service-design.md` | Step-by-step Designer instructions for the Flow wrapper(s) |

**Install:**

1. Copy `HeaderFilter.java` into your IS package at:
   ```
   IntegrationServer/packages/<YourPkg>/code/source/myorg/api/util/headers/HeaderFilter.java
   ```
2. In Software AG Designer, **right-click your package → Refresh**.
3. **Right-click namespace → New → Java Service** → name `filterAllowed` → leave the body unedited (Designer will read the existing class).
4. Repeat for `filterAllowedFromTransport`.
5. Build the Flow service `cleanInboundHeaders` per [flow-service-design.md](flow-service-design.md).
6. Reload the package (or restart IS) so the compiled class registers.

**Verify:**

In Designer's **Service Browser**, run `cleanInboundHeaders` against a service triggered by an HTTPS request (e.g., your existing API Gateway-routed endpoint). Check the pipeline trace:
- `filteredHeaders` should contain only the six allowlisted headers
- `removedNames` lists everything dropped (great for first-time tuning)

---

### Option B — webMethods API Gateway 10.15 built-in policy (no code)

If the filtering is needed **only** at the API Gateway tier (no IS protocol mediation), you don't need this service at all. Use the built-in policy:

1. Open the API in **API Gateway UI** → **Policies** tab.
2. Add: **Request Processing → Transformation → Header Transformation**.
3. Action: **Remove headers**.
4. Match expression: `^(?!authorization$|content-type$|accept$|x-correlation-id$|x-request-id$|soapaction$).*$` (case-insensitive).
   - Alternatively: switch action to **Keep headers** and list the six explicitly.
5. Save and activate the API.

| | Flow service (Option A) | API Gateway policy (Option B) |
|---|---|---|
| Effort | ~30 min | ~5 min |
| Where it runs | IS Flow | API Gateway request pipeline |
| Visibility in custom transformations | Yes — you can branch / log / mutate | No |
| Performance | Java call per request (~sub-ms) | Native — fastest |
| Auditable in API Gateway analytics | Indirect | Yes |

**Recommendation:** Use Option B for plain proxy/passthrough APIs. Use Option A when you also need a Flow service in the path for other reasons.

---

## Customizing the allowlist

The defaults are baked into `HeaderFilter.java` (`DEFAULT_ALLOWED`). If you need a different list per call:

```
INVOKE myorg.api.util.headers:filterAllowed
  Input:
    headers      = <your IData>
    allowedNames = ["Authorization", "Content-Type", "X-Tenant-ID"]   # overrides default
  Output:
    filteredHeaders, removedNames, removedCount, keptCount
```

Case-insensitive by default. Override via the `caseSensitive` input (`"true"` / `"false"`).

---

## Performance notes

- `HeaderFilter` uses `IDataCursor` iteration — O(n) over header count, n typically < 30.
- `DEFAULT_ALLOWED` is a `HashSet` initialized once at class load — O(1) lookups.
- No regex (the optional API Gateway policy approach uses regex, this Java service doesn't).
- Safe for concurrent invocation — no static mutable state.
