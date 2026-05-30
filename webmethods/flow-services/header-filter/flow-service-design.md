# Flow Service Design — `myorg.api.util.headers:cleanInboundHeaders`

A pure-Flow wrapper around the Java helper. Create this in Software AG Designer (webMethods 10.15) by following the steps below — there's nothing fancy, just the standard Designer drag-and-drop.

The Java helper does the iteration in one shot; the Flow wrapper makes the call drop-in for any other Flow service.

---

## Service signature

```
Service: myorg.api.util.headers:cleanInboundHeaders
Type:    Flow

Input:
    (none)

Output:
    filteredHeaders   Document
    removedNames      String List
    removedCount      String
    keptCount         String
```

> **Why no input?** This service reads the inbound transport headers directly via `pub.flow:getTransportInfo`. If you want to filter an arbitrary header bag, call the Java service `filterAllowed` instead — it accepts an explicit `headers` input.

---

## Designer step-by-step

1. **Right-click** your package's namespace folder → **New → Flow Service** → name it `cleanInboundHeaders`.
2. Open the service. In the **Input/Output** tab, add the four output variables shown above (no inputs).
3. In the flow editor, add these steps in order:

```
SEQUENCE  (Exit on: SUCCESS)
│
├── 1. INVOKE  pub.flow:getTransportInfo
│             └─ Output: transport (Document)
│
├── 2. MAP
│             └─ transport/http/requestHdrs   →   headers
│
├── 3. INVOKE  myorg.api.util.headers:filterAllowed
│             ├─ Input:  headers (already in pipeline)
│             └─ Output: filteredHeaders, removedNames,
│                        removedCount, keptCount
│
└── 4. MAP   (drop transient variables from the pipeline so callers
              get a clean output)
              └─ DROP: transport, headers
```

4. **Save** (Ctrl-S). Designer compiles the Flow + the Java service together. If the Java source isn't yet present, see [README.md](README.md) for the install path.

5. **Right-click → Run** to test against a service triggered by an HTTP request (Designer's "Run with Input" works only for direct invocation — for a real test, hit the endpoint that calls this service and check the pipeline trace).

---

## Companion service — `myorg.api.util.headers:filterForOutbound`

When you're about to call `pub.client:http`, you usually want to **build** a clean header bag rather than filter the inbound one. This second Flow wraps the Java service for that case:

```
Service: myorg.api.util.headers:filterForOutbound
Type:    Flow

Input:
    sourceHeaders     Document       (the bag you intend to forward)
    additionalAllowed String List    (optional, appended to defaults)

Output:
    filteredHeaders   Document
    removedNames      String List
```

Steps:

```
SEQUENCE
│
├── 1. (Optional) BRANCH on /additionalAllowed
│        ├── %additionalAllowed% is null  →  no-op
│        └── default                      →  pub.list:appendToStringList
│                                            (append defaults to additionalAllowed)
│
├── 2. INVOKE  myorg.api.util.headers:filterAllowed
│             ├─ Input:  headers       = %sourceHeaders%
│             ├─ Input:  allowedNames  = %mergedAllowed%   (or omit for defaults)
│             └─ Output: filteredHeaders, removedNames, ...
│
└── 3. MAP — drop intermediate variables
```

---

## Wiring it into a proxy flow (real usage example)

```
SEQUENCE — myorg.api.orders:proxyToBackend
│
├── 1. INVOKE myorg.api.util.headers:cleanInboundHeaders
│             └─ Output: filteredHeaders
│
├── 2. MAP
│             └─ filteredHeaders → outboundCall/headers
│             └─ "https://orders.onprem.example.com" + transport/http/requestPath
│                 → outboundCall/url
│
├── 3. INVOKE pub.client:http
│             ├─ Input:  url, method, headers (= outboundCall/headers)
│             └─ Output: header, content
│
└── 4. MAP — extract and return response
```

The two lines that matter:

- Step 1 produces `filteredHeaders` containing **only** `Authorization`, `Content-Type`, `Accept`, `X-Correlation-ID`, `X-Request-ID`, `SOAPAction`.
- Step 2 maps it into the outbound call so any `x-amzn-*`, `x-forwarded-*`, or other intermediary noise from AWS API Gateway never reaches the on-prem backend.

---

## What `pub.flow:setTransportInfo` is NOT used for

You'll see some older webMethods snippets calling `setTransportInfo` to mutate the inbound request. **Don't.** By the time your Flow runs, the request has already been dispatched, and modifications to `transport/http/requestHdrs` don't propagate to anything useful. The correct pattern is to **produce** a filtered headers document and pass it explicitly to the next step — exactly what this Flow does.
