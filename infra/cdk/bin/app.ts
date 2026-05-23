#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FederatedApiGwStack } from '../lib/federated-apigw-stack';

const app = new cdk.App();

const sspCtx = app.node.tryGetContext('ssp') as {
  idpIssuer: string;
  idpJwksUri: string;
  idpTokenUrl: string;
  idpEdgeClientId: string;
  expectedAudiences: string[];
  onpremNlbDns: string;
  primaryRegion: string;
  secondaryRegion: string;
  enableTokenExchange: { primary: boolean; secondary: boolean };
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
  enableTokenExchange: sspCtx.enableTokenExchange?.primary ?? false,
  idpTokenUrl: sspCtx.idpTokenUrl,
  idpEdgeClientId: sspCtx.idpEdgeClientId,
});

// Secondary region (DR)
new FederatedApiGwStack(app, 'FederatedApiGw-Secondary', {
  env: { account: accountFromEnv, region: sspCtx.secondaryRegion },
  isPrimary: false,
  idpIssuer: sspCtx.idpIssuer,
  idpJwksUri: sspCtx.idpJwksUri,
  expectedAudiences: sspCtx.expectedAudiences,
  onpremNlbDns: sspCtx.onpremNlbDns,
  enableTokenExchange: sspCtx.enableTokenExchange?.secondary ?? false,
  idpTokenUrl: sspCtx.idpTokenUrl,
  idpEdgeClientId: sspCtx.idpEdgeClientId,
});

app.synth();
