# Flow Service Design — `myorg.api.util.headers:filterRequestHeaders`

**Pure-Flow** header filter for use as an **Invoke webMethods IS service** request-processing policy in API Gateway 10.15. No Java service required.

This is the right shape when:

- You're already inside `pub.apigateway.invokeISService.specifications.RequestSpec`, so `request/headers` is exposed as a `Document` with each header name as a child field.
- The allowlist is **fixed** (the 6 SSP headers — not dynamic per call).
- You don't need to call the same filter from non-APIGW contexts.

If any of those don't fit, use the Java-backed service in [code/source/myorg/api/util/headers/HeaderFilter.java](code/source/myorg/api/util/headers/HeaderFilter.java) instead.

---

## Service signature

```
Service: myorg.api.util.headers:filterRequestHeaders
Type:    Flow

Input  (must match pub.apigateway.invokeISService.specifications.RequestSpec):
    request   Document
      ├── headers      Document
      ├── method       String
      ├── path         String
      ├── query        Document
      ├── body         Object (String / byte[])
      └── pathParams   Document

Output (must match pub.apigateway.invokeISService.specifications.ResponseSpec):
    request   Document      (same shape; only headers changes)
```

---

## Designer steps

```
SEQUENCE  (Exit on: SUCCESS)
│
├── 1. MAP — preserve original headers
│         COPY     request/headers   →   savedHeaders
│
├── 2. MAP — clear the request headers field
│         SET VALUE   request/headers   =   (empty Document)
│
├── 3. MAP — selectively re-add allowed headers
│         LINK   savedHeaders/Authorization      →  request/headers/Authorization
│         LINK   savedHeaders/Content-Type       →  request/headers/Content-Type
│         LINK   savedHeaders/Accept             →  request/headers/Accept
│         LINK   savedHeaders/X-Correlation-ID   →  request/headers/X-Correlation-ID
│         LINK   savedHeaders/X-Request-ID       →  request/headers/X-Request-ID
│         LINK   savedHeaders/SOAPAction         →  request/headers/SOAPAction
│
└── 4. MAP — drop the scratch variable
          DROP   savedHeaders
```

That's the whole service.

---

## Two non-obvious bits

### LINK, not COPY/ASSIGN, in step 3

`LINK` only fires when the source field exists. `COPY`/`ASSIGN` would create empty entries for any allowlisted header that wasn't actually present, and the backend would receive `Content-Type: ""` — strictly worse than absence.

In Designer: click the line in the Pipeline tab, choose **Link** from the toolbar (the arrow icon). Confirm the link appears in the right pane's "Transformer" panel, not the "Set Value" panel.

### Header name casing

`RequestSpec` exposes header keys **exactly as sent on the wire**. If your client (e.g., AWS API Gateway) lowercases them, your LINK source paths must be lowercase too:

```
LINK   savedHeaders/authorization     →  request/headers/authorization
LINK   savedHeaders/content-type      →  request/headers/content-type
...
```

If you control the client OR you front this with something that preserves case (Postman, internal callers), use the canonical casing shown in §Designer steps.

**Mixed-casing reality check:** if you can't guarantee the casing, add LINKs for both common variants:

```
LINK   savedHeaders/Authorization     →  request/headers/Authorization
LINK   savedHeaders/authorization     →  request/headers/Authorization   ← same target
```

The same-target form is safe because LINK only fires for whichever source exists.

---

## Wiring it into API Gateway

1. API Gateway UI → your API → **Policies** tab.
2. Add **Request Processing → Invoke webMethods IS service**.
3. **IS Service** field: `myorg.api.util.headers:filterRequestHeaders`
4. **Run as user**: a service account with execute permission on the service.
5. Drag this policy **above** any "Routing" / "HTTP Endpoint" policy so the filter runs before the backend call.
6. Save → Activate.

After activation, any header not in the allowlist (`x-amzn-trace-id`, `x-forwarded-for`, `via`, `x-amz-cf-id`, etc.) is dropped before the backend sees the request.

---

## Verifying

Easiest path: deploy to a non-prod API tied to a request bin (e.g., `https://webhook.site`) and send a request through API Gateway. The bin will show exactly the headers the backend would receive — should be only the 6 allowed, plus any platform-injected ones like `Host` that webMethods adds on the outbound leg.

For step-debugging in Designer:

```
INVOKE pub.flow:tracePipeline    ← drop at the start AND end of the service
```

Compare the `request/headers` keys before vs after.

---

## When this Flow won't help

- **Outbound-only filtering** (you're calling `pub.client:http` directly from an IS flow, no APIGW involvement) — use the Java service's `filterAllowed` and pass `filteredHeaders` to `pub.client:http`.
- **Dynamic per-route allowlist** — encode the allowed list as a route property and use the Java service's `allowedNames` input.
- **Header transformation beyond drop** (renaming, value mutation) — neither this Flow nor the Java service handles that; write a dedicated Flow or use a JS/Groovy custom policy.
