import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Sample AWS-native backend behind the HTTP API v2 JWT authorizer.
 *
 * The JWT has already been validated by API Gateway by the time we run.
 * Claims are surfaced via event.requestContext.authorizer.jwt.claims.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const claims =
    (event.requestContext as any)?.authorizer?.jwt?.claims ??
    {};

  const sub = String(claims.sub ?? 'unknown');
  const tenant = String(claims.tenant ?? '');

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service: 'profile',
      sub,
      tenant,
      message: `Hello ${sub}`,
      timestamp: new Date().toISOString(),
    }),
  };
};
