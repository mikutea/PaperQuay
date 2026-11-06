import {loadModelGatewayConfig,type ModelGatewayConfig} from './model-config.ts';
import { isIP } from 'node:net';
import { ApiError } from './errors.ts';
import {loadNativeAssociations,type NativeAssociations} from './native-links.ts';

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  erasureDatabaseUrl?: string;
  privateMetricsIntervalSeconds?:number;
  oidcIssuer: string;
  oidcAudience: string;
  oidcClientIds: string[];
  allowedOrigins: string[];
  cursorSecret: Uint8Array;
  bodyLimitBytes: number;
  responseLimitBytes: number;
  entityLimitBytes: number;
  maxAccountRetainedBytes: number;
  cloudPdfEnabled: boolean;
  desktopPdfEnabled: boolean;
  remoteTasksEnabled?:boolean;
  remoteRetrievalEnabled?:boolean;
  modelInferenceEnabled?:boolean;
  modelGateway?:ModelGatewayConfig|null;
  desktopPdfStunUrls: string[];
  cloudPdfAccountBytes: number;
  requestsPerMinute: number;
  trustedProxyIps: string[];
  nativeAssociations?:NativeAssociations|null;
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
  cloudPdfMaxFileBytes: 64 * 1024 * 1024,
  cloudPdfAccountBytes: 1024 * 1024 * 1024,
  cloudPdfMaxConfiguredAccountBytes: 10 * 1024 * 1024 * 1024,
  cloudPdfMaxCopies: 512,
  cloudPdfMaxTransfers: 2,
  desktopPdfMaxFileBytes: 64 * 1024 * 1024,
  desktopPdfRequestTtlMs: 30000,
  desktopPdfPollTimeoutMs: 20000,
  desktopPdfPresenceTtlMs: 30000,
  desktopPdfClaimTimeoutMs: 10000,
  desktopPdfRecheckIntervalMs: 1000,
  desktopPdfRecheckTimeoutMs: 1500,
  desktopPdfMaxTransfers: 2,
  desktopPdfMaxProviders: 32,
  desktopPdfMaxAccountProviders: 4,
  desktopPdfByteWindowMs: 15 * 60 * 1000,
  desktopPdfAccountWindowBytes: 256 * 1024 * 1024,
  desktopPdfProcessWindowBytes: 1024 * 1024 * 1024,
  desktopPdfMaxBudgetAccounts: 256,
  desktopPdfChunkBytes: 64 * 1024,
  desktopPdfDirectAttemptMs: 6000,
  desktopPdfDirectAuthorizationMs: 2000,
  desktopPdfDirectReceiptMs: 5000,
  desktopPdfDirectMaxReceipts: 64,
  desktopPdfDirectMaxSdpBytes: 32768,
  desktopPdfDirectMaxCandidates: 32,
});

/** Admin-only STUN configuration. This never accepts peer-supplied servers or credentials. */
export function checkedDesktopPdfStunUrls(value: string | undefined): string[] {
  if (value === undefined) return [];
  if (value.length > 256) throw new ApiError('CONFIGURATION_INVALID', 500);
  if (value.trim() === '') return [];
  const urls = value.split(',').map((item) => item.trim());
  if (urls.length > 2 || urls.some((item) => {
    const match = /^(stuns?):(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(item);
    if (!match || (match[3] && Number(match[3]) > 65535)) return true;
    const host = match[2];
    if (host.startsWith('[')) return isIP(host.slice(1, -1)) !== 6;
    if (/^[0-9.]+$/.test(host)) return isIP(host) !== 4;
    return host.length > 253 || host.split('.').some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
  })) throw new ApiError('CONFIGURATION_INVALID', 500);
  return [...new Set(urls)];
}

export function checkedCloudPdfByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > SERVER_LIMITS.cloudPdfMaxConfiguredAccountBytes) {
    throw new ApiError('CONFIGURATION_INVALID', 500);
  }
  return value;
}

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
  // No fallback to runtime credentials: SQL access as the ordinary role must
  // never confer account-erasure authority. Missing optional config fails closed.
  const erasureDatabaseUrl = env.PAPERQUAY_ERASURE_DATABASE_URL?.trim() || undefined;
  if (erasureDatabaseUrl) {
    try {
      const erasure = new URL(erasureDatabaseUrl), runtime = new URL(databaseUrl);
      if (erasure.protocol !== runtime.protocol || erasure.host !== runtime.host || erasure.pathname !== runtime.pathname
        || decodeURIComponent(erasure.username) !== 'paperquay_erasure' || erasure.search || erasure.hash
        || !erasure.password || erasure.password === runtime.password || erasure.username === runtime.username) throw new Error('invalid');
    } catch { throw new ApiError('CONFIGURATION_INVALID', 500); }
  }
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
  const privateMetricsIntervalSeconds=Number(env.PAPERQUAY_PRIVATE_METRICS_INTERVAL_SECONDS??0);
  if(!Number.isInteger(privateMetricsIntervalSeconds)||privateMetricsIntervalSeconds!==0
    &&(privateMetricsIntervalSeconds<15||privateMetricsIntervalSeconds>3600))throw new ApiError('CONFIGURATION_INVALID',500);
  const cloudPdfEnabled = env.PAPERQUAY_CLOUD_PDF_ENABLED ?? '0';
  if (!['0', '1'].includes(cloudPdfEnabled)) throw new ApiError('CONFIGURATION_INVALID', 500);
  const desktopPdfEnabled = env.PAPERQUAY_DESKTOP_PDF_ENABLED ?? '0';
  if (!['0', '1'].includes(desktopPdfEnabled)) throw new ApiError('CONFIGURATION_INVALID', 500);
  const remoteTasksEnabled=env.PAPERQUAY_REMOTE_TASKS_ENABLED??'0';
  if(!['0','1'].includes(remoteTasksEnabled))throw new ApiError('CONFIGURATION_INVALID',500);
  const remoteRetrievalEnabled=env.PAPERQUAY_REMOTE_RETRIEVAL_ENABLED??'0';
  if(!['0','1'].includes(remoteRetrievalEnabled))throw new ApiError('CONFIGURATION_INVALID',500);
  const modelInferenceEnabled=env.PAPERQUAY_MODEL_INFERENCE_ENABLED??'0';
  if(!['0','1'].includes(modelInferenceEnabled))throw new ApiError('CONFIGURATION_INVALID',500);
  return {
    host, port, databaseUrl, erasureDatabaseUrl, privateMetricsIntervalSeconds, oidcIssuer, oidcAudience, oidcClientIds, allowedOrigins, cursorSecret,
    bodyLimitBytes: SERVER_LIMITS.bodyLimitBytes,
    responseLimitBytes: SERVER_LIMITS.responseLimitBytes,
    entityLimitBytes: SERVER_LIMITS.entityLimitBytes,
    maxAccountRetainedBytes: checkedRetainedByteLimit(Number(env.PAPERQUAY_MAX_ACCOUNT_RETAINED_BYTES ?? SERVER_LIMITS.maxAccountRetainedBytes)),
    cloudPdfEnabled: cloudPdfEnabled === '1',
    desktopPdfEnabled: desktopPdfEnabled === '1',
    remoteTasksEnabled:remoteTasksEnabled==='1',
    remoteRetrievalEnabled:remoteRetrievalEnabled==='1',
    modelInferenceEnabled:modelInferenceEnabled==='1',
    modelGateway:loadModelGatewayConfig(env,modelInferenceEnabled==='1'),
    desktopPdfStunUrls: checkedDesktopPdfStunUrls(env.PAPERQUAY_DESKTOP_PDF_STUN_URLS),
    cloudPdfAccountBytes: checkedCloudPdfByteLimit(Number(env.PAPERQUAY_CLOUD_PDF_ACCOUNT_BYTES ?? SERVER_LIMITS.cloudPdfAccountBytes)),
    requestsPerMinute, trustedProxyIps: trustedProxyIps(env.PAPERQUAY_TRUSTED_PROXY_IPS),
    nativeAssociations:loadNativeAssociations(env),
  };
}
