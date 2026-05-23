import { request } from 'undici';

/**
 * RFC 8693 OAuth 2.0 Token Exchange client.
 *
 * Exchanges the user's access token for a downstream-scoped token at the IdP.
 * The returned token has:
 *  - aud = target audience (single value)
 *  - scope = narrowed to what the operation needs
 *  - exp = typically 300s
 *  - act = { sub: <ssp-edge client id>, iss: <idp> }
 */
export interface ExchangeRequest {
  /** The user's JWT access token */
  subjectToken: string;
  /** Target downstream audience (e.g. "onprem-orders-api") */
  audience: string;
  /** Space-separated scopes the downstream needs */
  scope: string;
}

export interface ExchangeResponse {
  /** The new downstream-scoped JWT */
  accessToken: string;
  /** Lifetime in seconds reported by the IdP */
  expiresIn: number;
  /** Token type, always "Bearer" for our flows */
  tokenType: string;
  /** Absolute epoch-seconds when the token expires (computed locally) */
  expiresAtEpoch: number;
}

export interface ExchangeClientConfig {
  /** IdP token endpoint, e.g. https://idp.ssp.example.com/oauth2/token */
  tokenUrl: string;
  /** Client ID of the SSP edge (the actor performing the exchange) */
  clientId: string;
  /** Client secret — pulled from Secrets Manager at startup, not from env */
  clientSecret: string;
  /** HTTP timeout in milliseconds */
  timeoutMs?: number;
}

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export async function exchangeToken(
  cfg: ExchangeClientConfig,
  req: ExchangeRequest,
): Promise<ExchangeResponse> {
  const body = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: req.subjectToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    audience: req.audience,
    scope: req.scope,
  }).toString();

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const { statusCode, body: respBody } = await request(cfg.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
      'Accept': 'application/json',
    },
    body,
    bodyTimeout: cfg.timeoutMs ?? 3000,
    headersTimeout: cfg.timeoutMs ?? 3000,
  });

  const text = await respBody.text();

  if (statusCode < 200 || statusCode >= 300) {
    // Truncate body to avoid logging tokens or secrets if echoed back.
    throw new TokenExchangeError(
      `Token exchange failed: HTTP ${statusCode}`,
      statusCode,
      text.slice(0, 200),
    );
  }

  const json = JSON.parse(text) as {
    access_token: string;
    expires_in: number;
    token_type?: string;
    issued_token_type?: string;
  };

  if (json.issued_token_type && json.issued_token_type !== ACCESS_TOKEN_TYPE) {
    throw new TokenExchangeError(
      `Unexpected issued_token_type: ${json.issued_token_type}`,
      500,
      '',
    );
  }

  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    tokenType: json.token_type ?? 'Bearer',
    expiresAtEpoch: Math.floor(Date.now() / 1000) + json.expires_in,
  };
}

export class TokenExchangeError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly bodySnippet: string,
  ) {
    super(message);
    this.name = 'TokenExchangeError';
  }
}
