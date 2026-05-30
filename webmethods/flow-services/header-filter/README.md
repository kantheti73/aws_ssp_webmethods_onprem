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

## Three ways to deploy this — pick the one that fits

### Decision table

|  | Option A — Flow + Java service | Option B — APIGW built-in policy (no code) | Option C — Pure Flow inside `invokeISService` |
|---|---|---|---|
| **Effort** | ~30 min | ~5 min | ~10 min |
| **Runs in** | Any IS Flow context | API Gateway policy pipeline (native) | API Gateway `Invoke IS service` policy |
| **Code** | Java + Flow | None | Flow only (no Java) |
| **Allowlist** | Static or dynamic (per-call override) | Static (regex / list in policy UI) | Static (LINKs hardcoded in MAP step) |
| **Reusable outside APIGW** | **Yes** | No | No |
| **Where allowlist lives** | `HeaderFilter.java` `DEFAULT_ALLOWED` | API policy config | Flow service MAP step |
| **Best for** | Protocol mediation, dynamic allowlists, shared IS+APIGW use | Plain proxy/passthrough APIs | Fixed allowlist + you're already using `invokeISService` for other transforms |

> **Default recommendation:** If you have no other reason to involve IS, use **Option B**. If you're already inside an `invokeISService` policy for other transformations, use **Option C** and skip the Java step. Reach for **Option A** only when the allowlist must vary per call or the same filter is needed in non-APIGW Flows.

---

### Option A — Flow + Java service (this directory)

Use when you need the filtering inside an IS Flow — typically when webMethods is doing protocol mediation (REST→SOAP, REST→MQ), the allowlist is dynamic, or the same filter is shared across IS and APIGW contexts.

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

If the filtering is needed **only** at the API Gateway tier (no IS protocol mediation), you don't need any service at all. Use the built-in policy:

1. Open the API in **API Gateway UI** → **Policies** tab.
2. Add: **Request Processing → Transformation → Header Transformation**.
3. Action: **Remove headers**.
4. Match expression: `^(?!authorization$|content-type$|accept$|x-correlation-id$|x-request-id$|soapaction$).*$` (case-insensitive).
   - Alternatively: switch action to **Keep headers** and list the six explicitly.
5. Save and activate the API.

---

### Option C — Pure Flow inside `pub.apigateway.invokeISService` (no Java)

When the service signature matches `pub.apigateway.invokeISService.specifications.RequestSpec`, the inbound headers are already exposed as `request/headers` (a Document with each header name as a child field). You don't need to iterate an IData — you can clear the field and LINK back only the six allowed names.

**File:** [filterRequestHeaders-design.md](filterRequestHeaders-design.md)

The whole service is **4 MAP steps**:

```
1. COPY request/headers → savedHeaders         (preserve)
2. SET VALUE request/headers = empty Document  (clear)
3. LINK savedHeaders/<Name> → request/headers/<Name>   × 6
4. DROP savedHeaders
```

Wire it into API Gateway as a **Request Processing → Invoke webMethods IS service** policy. See the design doc for the full Designer walkthrough, the LINK-vs-COPY gotcha, and the header-casing notes.

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
