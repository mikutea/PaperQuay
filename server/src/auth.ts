import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey, JWTPayload } from 'jose';
import { ApiError } from './errors.ts';
import { checkedHttpUrl } from './config.ts';

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  sessionId: string;
  clientId: string;
}
export type TokenVerifier = (authorization: string | undefined) => Promise<VerifiedIdentity>;

export interface OidcOptions {
  issuer: string;
  audience: string;
  clientIds: readonly string[];
  /** Test seam only. Normal startup obtains a pinned issuer's JWKS discovery URL. */
  keyResolver?: JWTVerifyGetKey;
}

function boundedClaim(payload: JWTPayload, key: string, maxLength: number): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError('AUTHENTICATION_REQUIRED', 401);
  }
  return value;
}

async function readDiscovery(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('discovery');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 65536) { await reader.cancel(); throw new Error('discovery'); }
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export async function createOidcVerifier(options: OidcOptions): Promise<TokenVerifier> {
  const issuer = checkedHttpUrl(options.issuer, true).href.replace(/\/$/, '');
  let keyResolver = options.keyResolver;
  if (!keyResolver) {
    let metadata: unknown;
    try {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10000), redirect: 'error', headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('discovery');
      metadata = await readDiscovery(response);
    } catch { throw new ApiError('IDENTITY_PROVIDER_UNAVAILABLE', 503); }
    if (!metadata || typeof metadata !== 'object' || !('issuer' in metadata) || metadata.issuer !== issuer
      || !('jwks_uri' in metadata) || typeof metadata.jwks_uri !== 'string') {
      throw new ApiError('IDENTITY_PROVIDER_CONFIGURATION_INVALID', 503);
    }
    const jwksUrl = checkedHttpUrl(metadata.jwks_uri, true);
    // This reference deployment pins Keycloak and does not follow cross-origin discovery.
    if (jwksUrl.origin !== new URL(issuer).origin) throw new ApiError('IDENTITY_PROVIDER_CONFIGURATION_INVALID', 503);
    keyResolver = createRemoteJWKSet(jwksUrl, { timeoutDuration: 5000, cooldownDuration: 30000 });
  }
  const resolveKey = keyResolver;
  return async (authorization) => {
    if (!authorization || authorization.length > 16384 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) {
      throw new ApiError('AUTHENTICATION_REQUIRED', 401);
    }
    try {
      const { payload } = await jwtVerify(authorization.slice(7), resolveKey, {
        issuer, audience: options.audience, algorithms: ['RS256', 'PS256', 'ES256'],
        requiredClaims: ['iss', 'sub', 'sid', 'aud', 'exp', 'iat'], clockTolerance: 5,
      });
      const subject = boundedClaim(payload, 'sub', 255);
      const sessionId = boundedClaim(payload, 'sid', 512);
      const clientId = typeof payload.azp === 'string' ? payload.azp : boundedClaim(payload, 'client_id', 255);
      if (!options.clientIds.includes(clientId)
        || (typeof payload.client_id === 'string' && payload.client_id !== clientId)
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
        || (payload.iat as number) > Math.floor(Date.now() / 1000) + 5) {
        throw new ApiError('AUTHENTICATION_REQUIRED', 401);
      }
      return { issuer, subject, sessionId, clientId };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      const cause = error instanceof Error ? error.cause : undefined;
      const causeCode = cause && typeof cause === 'object' && 'code' in cause ? cause.code : '';
      if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JOSE_GENERIC'
        || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(code))
        || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(causeCode))) {
        throw new ApiError('IDENTITY_PROVIDER_UNAVAILABLE', 503);
      }
      throw new ApiError('AUTHENTICATION_REQUIRED', 401);
    }
  };
}
