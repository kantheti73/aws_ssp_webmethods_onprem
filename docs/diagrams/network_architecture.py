"""
Generates docs/img/network-architecture.png using the official AWS Architecture
Icon set via the mingrammer 'diagrams' Python library.

Run:
    pip install --user diagrams
    # Graphviz binary must be on PATH (winget install Graphviz.Graphviz)
    python docs/diagrams/network_architecture.py

Output:
    docs/img/network-architecture.png
"""

from diagrams import Diagram, Cluster, Edge
from diagrams.aws.network import (
    CloudFront,
    APIGateway,
    Route53,
    TransitGateway,
    DirectConnect,
    NLB,
    Endpoint,
    SiteToSiteVpn,
)
from diagrams.aws.security import WAF, SecretsManager, KMS, Shield
from diagrams.aws.compute import Lambda
from diagrams.aws.database import ElastiCache
from diagrams.aws.management import Cloudwatch
from diagrams.aws.storage import S3
from diagrams.onprem.client import Users
from diagrams.generic.network import Router
from diagrams.onprem.compute import Server
from diagrams.saas.identity import Okta


graph_attr = {
    "fontsize": "20",
    "bgcolor": "white",
    "pad": "1.0",
    "ranksep": "1.4",
    "nodesep": "0.9",
    "splines": "ortho",
    "concentrate": "false",
    "compound": "true",
}

node_attr = {
    "fontsize": "14",
}

edge_attr = {
    "fontsize": "12",
}

with Diagram(
    "SSP Federated APIGW - Network Architecture",
    show=False,
    direction="LR",
    filename="docs/img/network-architecture",
    outformat="png",
    graph_attr=graph_attr,
    node_attr=node_attr,
    edge_attr=edge_attr,
):
    users = Users("SSP Users\n& Partners")
    idp = Okta("SSP IdP (OIDC)\nJWKS endpoint")

    with Cluster("AWS Global Edge"):
        r53 = Route53("Route 53\nfailover + health")
        cf = CloudFront("CloudFront\nedge cache + TLS")
        shield = Shield("Shield Std")
        waf = WAF("AWS WAF")

    # ------------------------ PRIMARY REGION -----------------------------
    with Cluster("AWS Region: us-east-1  (PRIMARY)"):
        apigw_p = APIGateway("API Gateway\nHTTP v2 + REST v1\napi.ssp.example.com")

        with Cluster("VPC vpc-prod-east  10.10.0.0/16"):
            with Cluster("Private subnets (3 AZs)"):
                authz = Lambda("JWT Authorizer\nLambda")
                tx = Lambda("Token Exchange\nLambda (Opt 2)")
                sample = Lambda("Sample Backend\nLambda")
                nlb = NLB("Internal NLB\n(VPC Link target)")

            with Cluster("Isolated subnets"):
                redis = ElastiCache("ElastiCache\nRedis 7.1 (multi-AZ, TLS)")

            with Cluster("Interface Endpoints (PrivateLink)"):
                ep_sm = Endpoint("Secrets Mgr\nendpoint")
                ep_kms = Endpoint("KMS endpoint")
                ep_logs = Endpoint("Logs endpoint")
                ep_s3 = Endpoint("S3 gateway\nendpoint")

            with Cluster("Regional AWS Services"):
                sm = SecretsManager("SSP Edge\nClient Secret")
                kms = KMS("KMS CMK")
                cw = Cloudwatch("CloudWatch\nLogs + Metrics")
                s3 = S3("OpenAPI specs\nbuild artifacts")

        tgw_p = TransitGateway("Transit Gateway\ntgw-prod-east")

    # ------------------------ SECONDARY REGION ---------------------------
    with Cluster("AWS Region: us-west-2  (DR)"):
        apigw_s = APIGateway("API Gateway\n(standby - weight=0)")
        tgw_s = TransitGateway("Transit Gateway\ntgw-prod-west")

    # ------------------------ HYBRID CONNECTIVITY ------------------------
    dxgw = DirectConnect("DX Gateway")
    dx = DirectConnect("Direct Connect\n10 Gbps - primary")
    vpn = SiteToSiteVpn("Site-to-Site VPN\nBGP - backup")

    # ------------------------ ON-PREMISES --------------------------------
    with Cluster("On-Premises"):
        f5 = Router("F5 BIG-IP\nGSLB + LTM")
        with Cluster("DC-1   10.100.0.0/16"):
            wm1 = Server("webMethods APIGW\n10.15 (active)")
            be1 = Server("Backends\nREST/SOAP/MQ/DB2")
        with Cluster("DC-2   10.200.0.0/16"):
            wm2 = Server("webMethods APIGW\n10.15 (active)")
            be2 = Server("Backends\n(replicated)")

    # --------------- Edges ---------------
    users >> r53 >> cf
    cf >> shield
    cf >> waf >> apigw_p
    waf >> Edge(style="dashed", label="failover") >> apigw_s

    apigw_p >> Edge(label="invoke (auth)") >> authz
    apigw_p >> Edge(label="/aws/*") >> sample
    apigw_p >> Edge(label="/onprem/*  VPC Link") >> nlb
    apigw_p >> Edge(label="/onprem-tx/*") >> tx

    tx >> Edge(label="cache") >> redis
    tx >> ep_sm >> sm
    tx >> ep_kms >> kms
    authz >> ep_logs >> cw
    sample >> ep_s3 >> s3
    tx >> Edge(label="proxy w/\nexchanged JWT") >> nlb

    nlb >> tgw_p
    tgw_p >> dxgw
    tgw_p >> Edge(style="dashed") >> vpn
    tgw_p >> Edge(style="dashed", label="inter-region\npeering") >> tgw_s
    apigw_s >> tgw_s

    dxgw >> dx >> f5
    vpn >> f5
    f5 >> wm1 >> be1
    f5 >> wm2 >> be2

    # JWT validation arrows (all gateways validate independently)
    apigw_p >> Edge(style="dotted", color="darkgreen", label="JWKS") >> idp
    tx >> Edge(style="dotted", color="darkgreen", label="RFC 8693\ntoken exchange") >> idp
    wm1 >> Edge(style="dotted", color="darkgreen", label="JWKS") >> idp
    wm2 >> Edge(style="dotted", color="darkgreen") >> idp
