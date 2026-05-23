# 06 — Network Architecture (AWS + On-Premises)

End-to-end network design backing the federated APIGW. Covers VPC layout, hybrid connectivity (Direct Connect + VPN), cross-region failover, and the security/port matrix the network team needs to provision.

---

## Rendered architecture (official AWS icons)

![SSP Federated APIGW — Network Architecture](img/network-architecture.png)

> Generated from [`docs/diagrams/network_architecture.py`](diagrams/network_architecture.py) using the [`diagrams`](https://diagrams.mingrammer.com) Python library against the official AWS Architecture Icon set. Regenerate with:
>
> ```powershell
> # one-time
> winget install Graphviz.Graphviz
> python -m pip install --user diagrams
> # whenever the diagram changes
> python docs/diagrams/network_architecture.py
> ```

The Mermaid versions below are kept alongside the PNG so changes are reviewable in diffs (PRs can't diff PNGs meaningfully).

---

## 1. Top-level topology (Mermaid)

```mermaid
flowchart TB
    subgraph Users["Public Internet"]
        U1["SSP Users<br/>Web / Mobile"]
        U2["Partner Apps"]
    end

    subgraph Edge["AWS Global Edge"]
        R53["Route 53<br/>(failover + health checks)"]
        CF["Amazon CloudFront<br/>(edge cache + TLS)"]
        WAF["AWS WAF<br/>+ Shield Standard"]
    end

    subgraph PrimaryRegion["AWS Region: us-east-1 (PRIMARY)"]
        direction TB
        ACM1["AWS Certificate Manager<br/>(public cert + private cert)"]
        APIGW1["AWS API Gateway<br/>(HTTP v2 + REST v1)<br/>custom domain api.ssp.example.com"]

        subgraph VPC1["VPC vpc-prod-east  10.10.0.0/16"]
            direction TB
            LAMBDA1["AWS Lambda<br/>Authorizer + TX + Sample<br/>(in private subnets)"]
            REDIS1["Amazon ElastiCache<br/>for Redis 7.1<br/>(multi-AZ, TLS)"]
            NLB1["Internal Network<br/>Load Balancer"]
            VPCE1["Interface VPC Endpoints<br/>(Secrets Manager, KMS,<br/>CloudWatch Logs, STS)"]
            S3E1["Gateway VPC Endpoint<br/>(S3)"]
        end

        TGW1["AWS Transit Gateway<br/>tgw-prod-east"]
    end

    subgraph SecondaryRegion["AWS Region: us-west-2 (DR)"]
        APIGW2["AWS API Gateway<br/>(weight=0 until failover)"]
        VPC2["VPC vpc-prod-west<br/>10.20.0.0/16"]
        TGW2["AWS Transit Gateway<br/>tgw-prod-west"]
    end

    DXGW["AWS Direct Connect Gateway"]
    DX["Direct Connect<br/>10 Gbps dedicated<br/>BGP — primary"]
    VPN["AWS Site-to-Site VPN<br/>BGP — secondary"]

    subgraph OnPrem["On-Premises"]
        direction TB
        F5GSLB["F5 BIG-IP DNS<br/>(GSLB)"]
        subgraph DC1["DC-1  10.100.0.0/16"]
            WM1["webMethods APIGW<br/>10.15 (active)"]
            BE1["Backend services<br/>REST / SOAP / MQ / DB2"]
        end
        subgraph DC2["DC-2  10.200.0.0/16"]
            WM2["webMethods APIGW<br/>10.15 (active)"]
            BE2["Backend services<br/>(replicated)"]
        end
    end

    IDP["SSP IdP (SaaS or HA on-prem)<br/>OAuth2 / OIDC<br/>JWKS endpoint"]

    U1 --> R53
    U2 --> R53
    R53 --> CF
    CF --> WAF
    WAF --> APIGW1
    WAF -. failover .-> APIGW2

    APIGW1 --- ACM1
    APIGW1 -- "/aws/*" --> LAMBDA1
    APIGW1 -- "/onprem/*<br/>(VPC Link)" --> NLB1
    APIGW1 -- "/onprem-tx/*" --> LAMBDA1
    LAMBDA1 --> REDIS1
    LAMBDA1 --> VPCE1
    LAMBDA1 --> S3E1
    LAMBDA1 -- "TX path → wm" --> NLB1

    NLB1 --> TGW1
    TGW1 --> DXGW
    TGW1 -. backup .-> VPN
    TGW1 <-->|"peered"| TGW2
    VPC2 --- TGW2

    DXGW --> DX
    DX --> F5GSLB
    VPN --> F5GSLB
    F5GSLB --> WM1
    F5GSLB --> WM2
    WM1 --> BE1
    WM2 --> BE2

    APIGW1 -. validates JWT .-> IDP
    LAMBDA1 -. exchanges token .-> IDP
    WM1 -. validates JWT .-> IDP
    WM2 -. validates JWT .-> IDP
```

---

## 2. VPC layout — primary region zoom

```mermaid
flowchart TB
    subgraph VPC["VPC vpc-prod-east  10.10.0.0/16"]
        direction TB

        subgraph AZ_A["AZ us-east-1a"]
            PUB_A["Public subnet<br/>10.10.0.0/24<br/>(reserved — not used in this design)"]
            APP_A["Private (with egress)<br/>10.10.10.0/24<br/>Lambda ENI, NLB ENI"]
            DATA_A["Isolated<br/>10.10.20.0/24<br/>ElastiCache node"]
        end

        subgraph AZ_B["AZ us-east-1b"]
            APP_B["Private (with egress)<br/>10.10.11.0/24<br/>Lambda ENI, NLB ENI"]
            DATA_B["Isolated<br/>10.10.21.0/24<br/>ElastiCache node"]
        end

        subgraph AZ_C["AZ us-east-1c"]
            APP_C["Private (with egress)<br/>10.10.12.0/24<br/>NLB ENI"]
            DATA_C["Isolated<br/>10.10.22.0/24<br/>(spare for scaling)"]
        end

        VPCE_SM["Interface Endpoint<br/>com.amazonaws.us-east-1.secretsmanager"]
        VPCE_KMS["Interface Endpoint<br/>com.amazonaws.us-east-1.kms"]
        VPCE_LOG["Interface Endpoint<br/>com.amazonaws.us-east-1.logs"]
        VPCE_STS["Interface Endpoint<br/>com.amazonaws.us-east-1.sts"]
        VPCE_S3["Gateway Endpoint<br/>com.amazonaws.us-east-1.s3<br/>(route-table entry)"]

        NAT["NAT (optional, off by default)<br/>— Lambda uses endpoints, no NAT needed"]
        TGW_ATTACH["TGW Attachment<br/>(routes 10.100.0.0/16, 10.200.0.0/16<br/>via Transit Gateway)"]
    end

    APP_A --- VPCE_SM
    APP_A --- VPCE_KMS
    APP_A --- VPCE_LOG
    APP_A --- VPCE_STS
    APP_A --- VPCE_S3
    APP_B --- VPCE_SM
    APP_A -- "redis :6379" --> DATA_A
    APP_B -- "redis :6379" --> DATA_B
    APP_A --- TGW_ATTACH
    APP_B --- TGW_ATTACH
    APP_C --- TGW_ATTACH
```

### Subnet plan

| Tier | CIDR (per AZ) | What lives here | NACL stance | Route table |
|---|---|---|---|---|
| Public | 10.10.{0,1,2}.0/24 | **Reserved** — no public ingress in this design | Deny all by default | IGW (unused) |
| Private (with egress) | 10.10.{10,11,12}.0/24 | Lambda ENIs, NLB ENIs, Interface VPC Endpoints | Allow 443 ↔ VPC, 6379 → Data, 443 → on-prem CIDRs | TGW route for 10.100/16, 10.200/16 |
| Isolated | 10.10.{20,21,22}.0/24 | ElastiCache nodes only | Allow 6379 from App tier SG; deny all else | No external route |

### CIDR allocation (full plan)

| Block | Use | Notes |
|---|---|---|
| **10.10.0.0/16** | VPC us-east-1 (primary) | 65k addresses; never exhausted at this design size |
| **10.20.0.0/16** | VPC us-west-2 (DR) | Mirror layout |
| **10.30.0.0/16** | Reserved | Future region / shared services VPC |
| **10.100.0.0/16** | On-prem DC-1 | Owned by network team |
| **10.200.0.0/16** | On-prem DC-2 | Owned by network team |
| **100.64.0.0/16** | Transit Gateway transit CIDR | RFC 6598 — non-routable on public internet |

**Rule:** no CIDR overlap between any VPC and any on-prem DC. Validated by an `aws ec2 describe-transit-gateway-route-tables` check in the network team's CI.

---

## 3. Cross-region & failover

```mermaid
flowchart LR
    R53["Route 53<br/>api.ssp.example.com"]

    subgraph East["us-east-1 (PRIMARY)"]
        HC_E["Health check<br/>GET /health"]
        CF_E["CloudFront<br/>distribution"]
        APIGW_E["API Gateway<br/>primary"]
    end

    subgraph West["us-west-2 (DR)"]
        HC_W["Health check<br/>GET /health"]
        CF_W["CloudFront<br/>distribution"]
        APIGW_W["API Gateway<br/>secondary"]
    end

    R53 -- "PRIMARY<br/>weight=100" --> CF_E
    R53 -. "SECONDARY<br/>weight=0 until failover" .-> CF_W
    HC_E --> APIGW_E
    HC_W --> APIGW_W
    R53 -. "monitors" .-> HC_E
    R53 -. "monitors" .-> HC_W

    TGW_E["TGW us-east-1"]
    TGW_W["TGW us-west-2"]
    TGW_E <-->|"inter-region peering<br/>encrypted"| TGW_W

    DXGW_E["DX Gateway us-east-1"]
    DXGW_W["DX Gateway us-west-2<br/>(BGP standby)"]
    TGW_E --- DXGW_E
    TGW_W --- DXGW_W
    DXGW_E -- "Direct Connect" --> ONPREM["On-prem F5 GSLB"]
    DXGW_W -. "VPN backup" .-> ONPREM
```

### Failover triggers (in order of detection speed)

| Failure | Detected by | Recovery RTO |
|---|---|---|
| Primary APIGW 5xx > 5% over 60s | Route 53 health check | ~60s (DNS TTL) |
| us-east-1 region down | CloudWatch composite alarm + Route 53 | ~120s |
| Direct Connect BGP down | BGP keepalive (3s × 3) | ~30s — VPN takes over |
| DC-1 down | F5 GSLB probes | ~30s — DC-2 takes over (on-prem-managed) |
| ElastiCache primary down | Multi-AZ automatic failover | ~30–60s |

---

## 4. On-prem network (informational)

Owned by the on-prem network team — included so the AWS-side design aligns with it.

```mermaid
flowchart TB
    subgraph DXEdge["DX Customer Gateway"]
        CR["DX Router (customer)"]
        FW["Perimeter FW<br/>(stateful)"]
    end

    F5["F5 BIG-IP DNS / LTM<br/>GSLB + load balance"]

    subgraph DC1["DC-1  10.100.0.0/16"]
        WM1A["webMethods APIGW node 1"]
        WM1B["webMethods APIGW node 2"]
        BE1["Backends: REST / SOAP / MQ / DB2"]
    end

    subgraph DC2["DC-2  10.200.0.0/16"]
        WM2A["webMethods APIGW node 1"]
        WM2B["webMethods APIGW node 2"]
        BE2["Backends (replicated)"]
    end

    AWS["AWS<br/>(via DX VIF or VPN)"]
    AWS --> CR --> FW --> F5
    F5 --> WM1A
    F5 --> WM1B
    F5 --> WM2A
    F5 --> WM2B
    WM1A --> BE1
    WM1B --> BE1
    WM2A --> BE2
    WM2B --> BE2

    DC1 <-. data replication .-> DC2
```

---

## 5. Port / protocol matrix

Use this when filing firewall change tickets.

| From | To | Port | Protocol | Why | Where enforced |
|---|---|---|---|---|---|
| Internet | CloudFront | 443 | HTTPS | User → SSP | AWS WAF |
| CloudFront | API Gateway custom domain | 443 | HTTPS (mTLS optional) | Edge → origin | APIGW + ACM |
| API Gateway | Lambda (Authorizer/TX/Sample) | n/a | invoke | AWS-native call | IAM resource policy |
| API Gateway | NLB (VPC Link) | 443 | HTTPS (mTLS) | Option 1 → webMethods | VPC Link + SG |
| Lambda ENI | ElastiCache Redis | 6379 | TCP (TLS) | Token cache | SG |
| Lambda ENI | VPCE Secrets Manager | 443 | HTTPS | Pull SSP edge client secret | SG + endpoint policy |
| Lambda ENI | VPCE KMS | 443 | HTTPS | Decrypt secret | SG |
| Lambda ENI | VPCE CloudWatch Logs | 443 | HTTPS | Structured logs | SG |
| Lambda ENI | IdP `/token`, `/jwks` | 443 | HTTPS | RFC 8693 exchange + JWKS | NAT or VPCE (if PrivateLink IdP) |
| NLB | TGW → DX → F5 GSLB | 443 | HTTPS (mTLS) | Outbound to on-prem webMethods | TGW route + on-prem FW |
| F5 GSLB | webMethods APIGW nodes | 443 | HTTPS (mTLS) | Health checks + traffic | On-prem |
| webMethods | Backends | varies | REST/SOAP/MQ/JDBC | Service-specific | On-prem |
| Operator laptops | API Gateway admin | n/a | SigV4 over 443 | Operations | IAM |

---

## 6. Security groups (logical model)

| SG | Inbound | Outbound | Attached to |
|---|---|---|---|
| `sg-edge-apigw` | (managed by AWS) | — | API Gateway VPC Link ENI |
| `sg-lambda` | None (Lambda is invoked, not addressed) | 443/anywhere, 6379→`sg-redis`, 443→`sg-vpce-*`, 443→on-prem CIDRs | All in-VPC Lambdas |
| `sg-redis` | 6379 from `sg-lambda` only | — | ElastiCache nodes |
| `sg-nlb-internal` | 443 from `sg-edge-apigw` and `sg-lambda` | — (NLB is L4 pass-through) | Internal NLB ENIs |
| `sg-vpce-secretsmanager` | 443 from `sg-lambda` | — | Interface endpoint ENIs |
| `sg-vpce-kms` | 443 from `sg-lambda` | — | Interface endpoint ENIs |
| `sg-vpce-logs` | 443 from `sg-lambda` | — | Interface endpoint ENIs |

**Principle:** SGs reference other SGs, never CIDR ranges, for intra-VPC traffic. CIDR rules are reserved for on-prem traffic where SG references aren't possible.

---

## 7. VPC Endpoints (PrivateLink)

| Service | Type | Why we keep traffic off the internet |
|---|---|---|
| Secrets Manager | Interface | SSP-edge client secret + DB passwords; PCI/PII concerns |
| KMS | Interface | Decrypt Secrets Manager + ElastiCache transit keys |
| CloudWatch Logs | Interface | Lambda log shipping |
| STS | Interface | Lambda assume-role token refresh |
| S3 | Gateway | Build artifacts, OpenAPI spec storage — gateway endpoint is free |
| Lambda (cross-region invoke) | Interface | Only if cross-region warm-up is wired up — optional |
| (Optional) IdP via PrivateLink | Interface | If the IdP vendor supports PrivateLink (Okta does for the org); otherwise NAT |

**Endpoint policy pattern:** each Interface Endpoint has a least-privilege policy allowing only the specific actions the Lambdas need (e.g., `secretsmanager:GetSecretValue` on a specific ARN), not `*`.

---

## 8. Trust boundaries

```mermaid
flowchart LR
    subgraph PUB["Public — untrusted"]
        IN["Internet"]
    end
    subgraph EDGE["Edge — WAF / TLS only"]
        E1["CloudFront + WAF"]
    end
    subgraph AWSPRIV["AWS Private — authenticated"]
        A1["APIGW + Lambda + Redis"]
    end
    subgraph HYBRID["Hybrid path — encrypted + mTLS"]
        H1["TGW → DX/VPN → F5"]
    end
    subgraph ONPREM["On-prem Private — authenticated"]
        O1["webMethods + Backends"]
    end

    IN --> E1
    E1 --> A1
    A1 --> H1
    H1 --> O1
```

Crossing **any** boundary requires:
- TLS in transit (1.2+, prefer 1.3)
- Identity check (JWT at A1, mTLS at H1, JWT again at O1)
- An explicit policy decision (WAF rules, API Gateway resource policies, SGs, NACLs, on-prem FW rules)

---

## 9. Out of scope (intentionally)

These are referenced for context but **owned and provisioned outside this stack**:

- **DX physical circuit + VIF** — Network team, via the AWS DX console / partner.
- **AS numbers and BGP communities** — Network team's NOC documentation.
- **On-prem F5 GSLB config** — On-prem network/integration teams.
- **On-prem firewall rule tickets** — submitted using the port matrix in §5.
- **IdP itself** — IAM team (Cognito user pool / Okta / Ping config).
- **DNS for `api.ssp.example.com`** — Platform DNS team (Route 53 hosted zone delegation).

---

## Related docs

- [01 — System Architecture](01-architecture.md) — logical view (what calls what)
- [02 — OAuth Flow](02-oauth-flow.md) — Options 1 & 2 token flows
- [03 — Routing](03-routing.md) — path classification rules
- [04 — Failover](04-failover.md) — application-layer resilience patterns
