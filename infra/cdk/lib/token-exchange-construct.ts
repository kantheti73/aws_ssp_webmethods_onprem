import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export interface TokenExchangeProps {
  /** VPC the Lambda + Redis live in (same as the VPC Link to webMethods) */
  vpc: ec2.IVpc;
  /** Internal HTTPS base URL of webMethods APIGW (DC-aware DNS) */
  wmBaseUrl: string;
  /** IdP token endpoint, e.g. https://idp.ssp.example.com/oauth2/token */
  idpTokenUrl: string;
  /** SSP edge client id (the actor performing the exchange) */
  idpClientId: string;
  /**
   * If true, create a placeholder secret with a fake value. In production,
   * pass an existing Secret via `existingClientSecret` so this stack never
   * touches the real credential.
   */
  createPlaceholderSecret?: boolean;
  /** Pre-existing secret (preferred in non-dev environments) */
  existingClientSecret?: secretsmanager.ISecret;
  /** Redis node type. Defaults to cache.t4g.small (cheap, fine for non-prod) */
  redisNodeType?: string;
  /** Whether to enable in-transit + at-rest encryption (default true) */
  redisEncryption?: boolean;
}

/**
 * Bundles together everything needed for Option-2 token exchange:
 *
 *   - ElastiCache (Redis) replication group, multi-AZ, TLS, in private subnets
 *   - Security group + ingress from the Lambda SG only
 *   - Token Exchange Lambda in the VPC
 *   - Secret reference for the SSP-edge client credentials
 *
 * The Lambda is **not** wired into API Gateway here — the caller (the main
 * stack) does that, because the API Gateway is the orchestrating resource.
 */
export class TokenExchange extends Construct {
  public readonly lambda: nodejs.NodejsFunction;
  public readonly redis: elasticache.CfnReplicationGroup;
  public readonly redisEndpoint: string;
  public readonly clientSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: TokenExchangeProps) {
    super(scope, id);

    // ---- 1. Client secret -------------------------------------------------
    if (props.existingClientSecret) {
      this.clientSecret = props.existingClientSecret;
    } else if (props.createPlaceholderSecret) {
      this.clientSecret = new secretsmanager.Secret(this, 'SspEdgeClientSecret', {
        description: 'SSP edge client credentials for RFC 8693 token exchange',
        secretObjectValue: {
          clientId: cdk.SecretValue.unsafePlainText(props.idpClientId),
          clientSecret: cdk.SecretValue.unsafePlainText('REPLACE_ME_IN_PROD'),
        },
      });
    } else {
      throw new Error(
        'TokenExchange: provide either existingClientSecret or set createPlaceholderSecret=true',
      );
    }

    // ---- 2. Security groups ----------------------------------------------
    const lambdaSg = new ec2.SecurityGroup(this, 'TxLambdaSg', {
      vpc: props.vpc,
      description: 'Token Exchange Lambda — egress to Redis and IdP',
      allowAllOutbound: true,
    });

    const redisSg = new ec2.SecurityGroup(this, 'TxRedisSg', {
      vpc: props.vpc,
      description: 'ElastiCache Redis for exchanged token cache',
      allowAllOutbound: false,
    });
    redisSg.addIngressRule(
      ec2.Peer.securityGroupId(lambdaSg.securityGroupId),
      ec2.Port.tcp(6379),
      'Token exchange Lambda',
    );

    // ---- 3. ElastiCache Redis (replication group) ------------------------
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'TxRedisSubnets', {
      description: 'Private subnets for token exchange Redis',
      subnetIds: props.vpc.privateSubnets.length > 0
        ? props.vpc.privateSubnets.map((s) => s.subnetId)
        : props.vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    const encryption = props.redisEncryption !== false;

    this.redis = new elasticache.CfnReplicationGroup(this, 'TxRedis', {
      replicationGroupDescription: 'Exchanged token cache',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: props.redisNodeType ?? 'cache.t4g.small',
      numCacheClusters: 2, // primary + 1 replica
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [redisSg.securityGroupId],
      transitEncryptionEnabled: encryption,
      atRestEncryptionEnabled: encryption,
      port: 6379,
    });
    this.redis.addDependency(subnetGroup);

    this.redisEndpoint = `${this.redis.attrPrimaryEndPointAddress}:${this.redis.attrPrimaryEndPointPort}`;

    // ---- 4. Token Exchange Lambda ----------------------------------------
    this.lambda = new nodejs.NodejsFunction(this, 'TokenExchangeFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(
        __dirname, '..', '..', '..',
        'services', 'token-exchange-lambda', 'src', 'index.ts',
      ),
      handler: 'handler',
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      vpc: props.vpc,
      vpcSubnets: { subnetType: props.vpc.privateSubnets.length > 0
        ? ec2.SubnetType.PRIVATE_WITH_EGRESS
        : ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      environment: {
        IDP_TOKEN_URL: props.idpTokenUrl,
        IDP_CLIENT_ID: props.idpClientId,
        IDP_CLIENT_SECRET_ARN: this.clientSecret.secretArn,
        REDIS_ENDPOINT: this.redisEndpoint,
        REDIS_TLS: encryption ? 'true' : 'false',
        WM_BASE_URL: props.wmBaseUrl,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'], // provided by the runtime
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    this.clientSecret.grantRead(this.lambda);

    new cdk.CfnOutput(this, 'TxRedisEndpoint', { value: this.redisEndpoint });
    new cdk.CfnOutput(this, 'TxLambdaArn', { value: this.lambda.functionArn });
  }
}
