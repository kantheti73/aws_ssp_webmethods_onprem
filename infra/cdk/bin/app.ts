#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FederatedApiGwStack } from '../lib/federated-apigw-stack';

const app = new cdk.App();

const sspCtx = app.node.tryGetContext('ssp') as {
  idpIssuer: string;
  idpJwksUri: string;
  expectedAudiences: string[];
  onpremNlbDns: string;
  primaryRegion: string;
  secondaryRegion: string;
};

const accountFromEnv = process.env.CDK_DEFAULT_ACCOUNT;

// Primary region
new FederatedApiGwStack(app, 'FederatedApiGw-Primary', {
  env: { account: accountFromEnv, region: sspCtx.primaryRegion },
  isPrimary: true,
  idpIssuer: sspCtx.idpIssuer,
  idpJwksUri: sspCtx.idpJwksUri,
  expectedAudiences: sspCtx.expectedAudiences,
  onpremNlbDns: sspCtx.onpremNlbDns,
});

// Secondary region (DR)
new FederatedApiGwStack(app, 'FederatedApiGw-Secondary', {
  env: { account: accountFromEnv, region: sspCtx.secondaryRegion },
  isPrimary: false,
  idpIssuer: sspCtx.idpIssuer,
  idpJwksUri: sspCtx.idpJwksUri,
  expectedAudiences: sspCtx.expectedAudiences,
  onpremNlbDns: sspCtx.onpremNlbDns,
});

app.synth();
