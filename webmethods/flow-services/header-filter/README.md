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

|  | Option A — Flow + Java service | Option B — APIGW built-in policy (blocklist only) | Option C — Pure Flow inside `invokeISService` |
|---|---|---|---|
| **Effort** | ~30 min | ~5 min | ~10 min |
| **Runs in** | Any IS Flow context | API Gateway policy pipeline (native) | API Gateway `Invoke IS service` policy |
| **Code** | Java + Flow | None | Flow only (no Java) |
| **Semantics** | Allowlist (configurable) | **Blocklist** — list each unwanted header by name (regex NOT supported; wildcards vary by fix-pack) | Allowlist (LINKs hardcoded) |
| **Drift risk** | Low (config in code) | **High** — new AWS-injected header next quarter slips through silently | Low (config in Flow) |
| **Reusable outside APIGW** | **Yes** | No | No |
| **Where allowlist lives** | `HeaderFilter.java` `DEFAULT_ALLOWED` | API policy blocklist | Flow service MAP step |
| **Best for** | Protocol mediation, dynamic allowlists, shared IS+APIGW use | Quick fix to drop *known* unwanted headers | Fixed allowlist + you're already using `invokeISService` |

> **Default recommendation:**
> - **Option C** if you're already inside `invokeISService` for any transformation — true allowlist, no Java, no drift.
> - **Option A** if the same filter is needed outside API Gateway, or the allowlist must vary per call.
> - **Option B** only as a quick blocklist tactical fix; not for long-term allowlist needs.

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

### Option B — webMethods API Gateway 10.15 built-in policy (no code, **blocklist only**)

The native **Header Transformation** policy in API Gateway 10.15 takes **literal header names** in its **Remove Headers** action — **not** regex. Anything that looks like an alias reference (`${...}`, `|`, `$`) will fail the policy save with *"not a valid alias syntax"*. So the no-code option here is a **blocklist**, not an allowlist.

> If you need true allowlist semantics in a policy with no IS service involvement, you must write a **Custom Extension** (Groovy/JS) policy — at which point you've left no-code land, and you're better off with Option A or C.

**Configuration:**

1. Open the API in **API Gateway UI** → **Policies** tab.
2. Add **Request Processing → Transformation → Header Transformation**.
3. Action: **Remove Headers**.
4. List the headers to drop, one per row:

   ```
   x-amzn-trace-id
   x-amzn-requestid
   x-amzn-apigateway-api-id
   x-amz-cf-id
   x-amz-cf-pop
   x-amz-content-sha256
   x-forwarded-for
   x-forwarded-port
   x-forwarded-proto
   x-forwarded-host
   x-real-ip
   via
   cdn-loop
   cloudfront-viewer-country
   cloudfront-forwarded-proto
   cloudfront-is-mobile-viewer
   cloudfront-is-desktop-viewer
   cloudfront-is-tablet-viewer
   cloudfront-is-smarttv-viewer
   ```

5. **Some 10.15 fix-packs accept wildcard suffixes** (`x-amzn-*`, `x-amz-*`, `x-forwarded-*`, `cloudfront-*`). Behaviour varies between fix-packs — try wildcards first in your dev tenant; fall back to explicit names if the UI rejects them.
6. Save and activate the API.

**Caveat:** A blocklist drifts. When AWS adds a new `x-amzn-foo` header in a future API Gateway release, it will reach your backend until someone updates the list. Use Option C (or Option A) if you need this property to be stable over time.

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
