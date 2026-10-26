import { isIP } from 'node:net';
import { ApiError } from './errors.ts';

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  oidcIssuer: string;
  oidcAudience: string;
  oidcClientIds: string[];
  allowedOrigins: string[];
  cursorSecret: Uint8Array;
  bodyLimitBytes: number;
  responseLimitBytes: number;
  entityLimitBytes: number;
  maxAccountRetainedBytes: number;
  requestsPerMinute: number;
  trustedProxyIps: string[];
}

export const SERVER_LIMITS = Object.freeze({
  bodyLimitBytes: 4 * 1024 * 1024,
  responseLimitBytes: 4 * 1024 * 1024,
  entityLimitBytes: 1024 * 1024,
  maxAccountEntities: 100000,
  maxAccountChanges: 1000000,
  maxAccountConflicts: 100000,
  maxAccountReceipts: 2000000,
  maxAccountRetainedBytes: 256 * 1024 * 1024,
  maxConfiguredAccountRetainedBytes: 10 * 1024 * 1024 * 1024,
  retainedRowOverheadBytes: 512,
  maxDevices: 100,
  maxRetainedDeviceSessions: 1000,
  maxPullRecords: 1000,
  maxConflictRecords: 100,
  maxCursorLength: 4096,
});

export function checkedRetainedByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > SERVER_LIMITS.maxConfiguredAccountRetainedBytes) {
    throw new ApiError('CONFIGURATION_INVALID', 500);
  }
  return value;
}

function trustedProxyIps(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const addresses = value.split(',').map((item) => item.trim());
  if (addresses.length > 32 || addresses.some((address) => {
    const family = isIP(address);
    if (!family || address.includes('%')) return true;
    const canonical = family === 6 ? new URL('http://[' + address + ']/').hostname : address;
    return ['0.0.0.0', '[::]', '[::ffff:0:0]'].includes(canonical);
  })) {
    throw new ApiError('CONFIGURATION_INVALID', 500);
  }
  return [...new Set(addresses)];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ApiError('CONFIGURATION_INVALID', 500);
  return value;
}

function localUrl(url: URL): boolean {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}

export function checkedHttpUrl(value: string, allowPath: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('CONFIGURATION_INVALID', 500); }
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && localUrl(url)))
    || (!allowPath && url.pathname !== '/')) {
    throw new ApiError('CONFIGURATION_INVALID', 500);
  }
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.PAPERQUAY_HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    if (env.PAPERQUAY_ALLOW_NON_LOOPBACK !== '1' || (!isIP(host) && host !== '0.0.0.0')) {
      throw new ApiError('NON_LOOPBACK_NOT_ENABLED', 500);
    }
  }
  const port = Number(env.PAPERQUAY_PORT || 4311);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError('CONFIGURATION_INVALID', 500);
  const databaseUrl = required(env, 'PAPERQUAY_DATABASE_URL');
  try {
    const database = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname.replace('/', '')) {
      throw new Error('invalid');
    }
  } catch { throw new ApiError('CONFIGURATION_INVALID', 500); }
  const issuer = checkedHttpUrl(required(env, 'PAPERQUAY_OIDC_ISSUER'), true);
  const oidcIssuer = issuer.href.replace(/\/$/, '');
  const oidcAudience = required(env, 'PAPERQUAY_OIDC_AUDIENCE');
  const oidcClientIds = required(env, 'PAPERQUAY_OIDC_CLIENT_IDS').split(',').map((item) => item.trim()).filter(Boolean);
  if (!oidcClientIds.length || oidcClientIds.some((item) => item.length > 255)) throw new ApiError('CONFIGURATION_INVALID', 500);
  const allowedOrigins = (env.PAPERQUAY_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean)
    .map((item) => item === 'capacitor://localhost' ? item : checkedHttpUrl(item, false).origin);
  const secret = required(env, 'PAPERQUAY_CURSOR_SECRET');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new ApiError('CONFIGURATION_INVALID', 500);
  const cursorSecret = Buffer.from(secret, 'base64');
  if (cursorSecret.length < 32 || cursorSecret.length > 128 || cursorSecret.toString('base64') !== secret) {
    throw new ApiError('CONFIGURATION_INVALID', 500);
  }
  const requestsPerMinute = Number(env.PAPERQUAY_REQUESTS_PER_MINUTE || 120);
  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 10000) {
    throw new ApiError('CONFIGURATION_INVALID', 500);
  }
  return {
    host, port, databaseUrl, oidcIssuer, oidcAudience, oidcClientIds, allowedOrigins, cursorSecret,
    bodyLimitBytes: SERVER_LIMITS.bodyLimitBytes,
    responseLimitBytes: SERVER_LIMITS.responseLimitBytes,
    entityLimitBytes: SERVER_LIMITS.entityLimitBytes,
    maxAccountRetainedBytes: checkedRetainedByteLimit(Number(env.PAPERQUAY_MAX_ACCOUNT_RETAINED_BYTES ?? SERVER_LIMITS.maxAccountRetainedBytes)),
    requestsPerMinute, trustedProxyIps: trustedProxyIps(env.PAPERQUAY_TRUSTED_PROXY_IPS),
  };
}
