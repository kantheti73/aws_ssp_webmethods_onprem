import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Loads the SSP-edge client secret from AWS Secrets Manager.
 *
 * Cached in module scope so we only hit Secrets Manager on cold start.
 * If the secret is rotated, the Lambda will eventually pick it up on next
 * cold start; for immediate pickup, set a CloudWatch Events rule that fires
 * a rotation Lambda to update SSM Parameter and invoke an explicit refresh.
 */
let cached: { value: string; loadedAt: number } | null = null;
const REFRESH_AFTER_MS = 60 * 60 * 1000; // 1 hour

const client = new SecretsManagerClient({});

export async function getClientSecret(secretArnOrName: string): Promise<string> {
  if (cached && Date.now() - cached.loadedAt < REFRESH_AFTER_MS) {
    return cached.value;
  }
  const resp = await client.send(new GetSecretValueCommand({ SecretId: secretArnOrName }));
  const secret = resp.SecretString;
  if (!secret) {
    throw new Error(`Secret ${secretArnOrName} has no SecretString`);
  }
  // Support both raw string and JSON-wrapped { clientSecret: "..." }.
  let value = secret;
  try {
    const parsed = JSON.parse(secret) as { clientSecret?: string };
    if (parsed.clientSecret) value = parsed.clientSecret;
  } catch {
    /* not JSON — use raw */
  }
  cached = { value, loadedAt: Date.now() };
  return value;
}
