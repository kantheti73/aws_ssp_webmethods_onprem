import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { TokenExchange } from './token-exchange-construct';

export interface FederatedApiGwStackProps extends cdk.StackProps {
  isPrimary: boolean;
  idpIssuer: string;
  idpJwksUri: string;
  expectedAudiences: string[];
  onpremNlbDns: string;
  /**
   * Whether to deploy the Option-2 (RFC 8693 Token Exchange) path:
   * ElastiCache Redis + Token Exchange Lambda + /onprem-tx/{proxy+} route.
   * Default true for primary, false for secondary (cost — secondary inherits
   * from a shared regional Redis when used).
   */
  enableTokenExchange?: boolean;
  /** IdP token endpoint, used only when enableTokenExchange=true */
  idpTokenUrl?: string;
  /** Client id of the SSP edge actor in the IdP */
  idpEdgeClientId?: string;
}

/**
 * Federated API Gateway stack.
 *
 *  - HTTP API (v2) with native JWT authorizer for /aws/* routes
 *  - REST API (v1) with Lambda authorizer + VPC Link to webMethods for /onprem/* routes
 *
 * Two APIs because:
 *   - HTTP API has native JWT (cheaper, faster) but lacks VPC Link to NLB in some integration shapes.
 *   - REST API integrates cleanly with a VPC Link → NLB → on-prem path.
 *
 * In production you'd front both with a single domain via custom domain + base path mappings
 * so the consumer sees one URL.
 */
export class FederatedApiGwStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FederatedApiGwStackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // 1. Lambda JWT authorizer (used by the REST /onprem/* API)
    // ------------------------------------------------------------------
    const authorizerFn = new nodejs.NodejsFunction(this, 'JwtAuthorizerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', '..', '..', 'services', 'authorizer-lambda', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        SSP_IDP_ISSUER: props.idpIssuer,
        SSP_IDP_JWKS_URI: props.idpJwksUri,
        EXPECTED_AUDIENCES: props.expectedAudiences.join(','),
        JWKS_CACHE_TTL_SECONDS: '3600',
        JWKS_MAX_STALE_SECONDS: '21600',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // ------------------------------------------------------------------
    // 2. Sample AWS-native backend (Lambda for /aws/profile)
    // ------------------------------------------------------------------
    const profileFn = new nodejs.NodejsFunction(this, 'ProfileFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', '..', '..', 'services', 'sample-lambda', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // ------------------------------------------------------------------
    // 3. HTTP API v2 (for /aws/*) with native JWT authorizer
    // ------------------------------------------------------------------
    const jwtAuth = new apigwv2Authorizers.HttpJwtAuthorizer(
      'SspJwtAuthorizer',
      props.idpIssuer,
      {
        jwtAudience: props.expectedAudiences,
        identitySource: ['$request.header.Authorization'],
      },
    );

    const httpApi = new apigwv2.HttpApi(this, 'AwsRoutesHttpApi', {
      apiName: `ssp-aws-routes-${props.isPrimary ? 'primary' : 'secondary'}`,
      defaultAuthorizer: jwtAuth,
      corsPreflight: {
        allowOrigins: ['https://ssp.example.com'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'traceparent'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    httpApi.addRoutes({
      path: '/aws/profile',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('ProfileIntegration', profileFn),
      authorizationScopes: ['profile'],
    });

    // ------------------------------------------------------------------
    // 4. REST API v1 (for /onprem/*) with VPC Link to webMethods
    // ------------------------------------------------------------------
    // VPC + NLB shown here as a placeholder — in production you'd import an existing VPC
    // and an existing internal NLB whose targets are the webMethods APIGW nodes via DX/VPN.
    const vpc = new ec2.Vpc(this, 'FederationVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const nlb = new elbv2.NetworkLoadBalancer(this, 'WmNlb', {
      vpc,
      internetFacing: false,
      crossZoneEnabled: true,
    });
    // NOTE: target group population (pointing at webMethods over DX/VPN) is managed
    // out-of-band by the network team and added to this NLB via a separate stack.

    const restApi = new apigw.RestApi(this, 'OnpremRoutesRestApi', {
      restApiName: `ssp-onprem-routes-${props.isPrimary ? 'primary' : 'secondary'}`,
      deployOptions: {
        stageName: 'live',
        throttlingBurstLimit: 200,
        throttlingRateLimit: 100,
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        dataTraceEnabled: false, // never log request bodies (PII)
      },
    });

    const lambdaAuthorizer = new apigw.RequestAuthorizer(this, 'OnpremLambdaAuthorizer', {
      handler: authorizerFn,
      identitySources: [apigw.IdentitySource.header('Authorization')],
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    const vpcLink = new apigw.VpcLink(this, 'WmVpcLink', {
      targets: [nlb],
    });

    const onprem = restApi.root.addResource('onprem');
    const proxy = onprem.addResource('{proxy+}');

    proxy.addMethod(
      'ANY',
      new apigw.Integration({
        type: apigw.IntegrationType.HTTP_PROXY,
        integrationHttpMethod: 'ANY',
        uri: `https://${props.onpremNlbDns}/{proxy}`,
        options: {
          connectionType: apigw.ConnectionType.VPC_LINK,
          vpcLink,
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy',
            'integration.request.header.Authorization': 'method.request.header.Authorization',
            'integration.request.header.traceparent': 'method.request.header.traceparent',
            'integration.request.header.Idempotency-Key': 'method.request.header.Idempotency-Key',
          },
          timeout: cdk.Duration.seconds(29),
        },
      }),
      {
        authorizer: lambdaAuthorizer,
        authorizationType: apigw.AuthorizationType.CUSTOM,
        requestParameters: {
          'method.request.path.proxy': true,
          'method.request.header.Authorization': true,
          'method.request.header.traceparent': false,
          'method.request.header.Idempotency-Key': false,
        },
      },
    );

    // ------------------------------------------------------------------
    // 5. (Optional) Option-2 token exchange path: /onprem-tx/{proxy+}
    // ------------------------------------------------------------------
    let tokenExchange: TokenExchange | undefined;
    if (props.enableTokenExchange) {
      if (!props.idpTokenUrl || !props.idpEdgeClientId) {
        throw new Error(
          'enableTokenExchange=true requires idpTokenUrl and idpEdgeClientId',
        );
      }

      tokenExchange = new TokenExchange(this, 'TokenExchange', {
        vpc,
        wmBaseUrl: `https://${props.onpremNlbDns}`,
        idpTokenUrl: props.idpTokenUrl,
        idpClientId: props.idpEdgeClientId,
        createPlaceholderSecret: true, // dev default; pass existingClientSecret in prod
      });

      // Per-route mapping: /onprem-tx/{aud}/{scope}/{proxy+}
      //   - {aud}  → x-target-audience header injected by integration request mapping
      //   - {scope}→ x-required-scope  header  ”
      //   - {proxy+}→ forwarded as-is to webMethods (Lambda strips the /onprem-tx prefix)
      const onpremTx = restApi.root.addResource('onprem-tx');
      const audSeg   = onpremTx.addResource('{aud}');
      const scopeSeg = audSeg.addResource('{scope}');
      const txProxy  = scopeSeg.addResource('{proxy+}');

      const txIntegration = new apigw.LambdaIntegration(tokenExchange.lambda, {
        proxy: true,
        requestParameters: {
          'integration.request.header.x-target-audience': 'method.request.path.aud',
          'integration.request.header.x-required-scope':  'method.request.path.scope',
        },
      });

      txProxy.addMethod('ANY', txIntegration, {
        authorizer: lambdaAuthorizer,
        authorizationType: apigw.AuthorizationType.CUSTOM,
        requestParameters: {
          'method.request.path.aud':   true,
          'method.request.path.scope': true,
          'method.request.path.proxy': true,
          'method.request.header.Authorization':   true,
          'method.request.header.traceparent':     false,
          'method.request.header.Idempotency-Key': false,
        },
      });
    }

    // ------------------------------------------------------------------
    // 6. Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'RestApiUrl', { value: restApi.url });
    new cdk.CfnOutput(this, 'VpcLinkId',  { value: vpcLink.vpcLinkId });
    new cdk.CfnOutput(this, 'StackRegion',{ value: cdk.Stack.of(this).region });
    new cdk.CfnOutput(this, 'RoleHint', {
      value: props.isPrimary ? 'PRIMARY - Route53 weight=100' : 'SECONDARY - Route53 weight=0 until failover',
    });
    if (tokenExchange) {
      new cdk.CfnOutput(this, 'TokenExchangeEnabled', { value: 'true' });
    }
  }
}
