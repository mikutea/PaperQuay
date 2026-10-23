import {
  validatePullResponse,
  validatePushResponse,
  validateSyncOperation,
  validateSyncRecord,
  type EntityType,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type PushResult,
  type SyncMutation,
  type SyncOperation,
  type SyncRecord,
  type EntityData,
} from '../../../packages/sync-core/src/index.ts';
import { normalizeServiceUrl } from './config.ts';
import { ClientError, errorFromResponse } from './errors.ts';

export interface DeviceSession {
  id: string;
  name: string;
  platform: 'web' | 'windows' | 'macos' | 'linux' | 'ios' | 'android';
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}
export interface AccountIdentity {
  accountId: string;
  device: DeviceSession;
}
export interface ServerConflict {
  conflictId: string;
  entityType: EntityType;
  entityId: string;
  createdAt: string;
  attemptedOperation: SyncOperation;
  observedRecord: SyncRecord | null;
  currentRecord: SyncRecord | null;
}
export type ConflictResolution =
  | {
      opId: string;
      expectedRevision: number;
      choice: 'current' | 'attempted';
    }
  | {
      opId: string;
      expectedRevision: number;
      choice: 'merged';
      mutation: SyncMutation;
      data: EntityData | null;
    };
export interface ConflictPage {
  conflicts: ServerConflict[];
  nextCursor: string;
  hasMore: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ClientError('INVALID_RESPONSE');
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new ClientError('INVALID_RESPONSE');
  return value;
}
function device(value: unknown): DeviceSession {
  if (
    !isObject(value) ||
    typeof value.name !== 'string' ||
    value.name.length > 80 ||
    !['web', 'windows', 'macos', 'linux', 'ios', 'android'].includes(String(value.platform))
  )
    throw new ClientError('INVALID_RESPONSE');
  return {
    id: uuid(value.id),
    name: value.name,
    platform: value.platform as DeviceSession['platform'],
    createdAt: timestamp(value.createdAt),
    lastSeenAt: timestamp(value.lastSeenAt),
    revokedAt: value.revokedAt === null ? null : timestamp(value.revokedAt),
  };
}
function identity(value: unknown): AccountIdentity {
  if (!isObject(value)) throw new ClientError('INVALID_RESPONSE');
  return { accountId: uuid(value.accountId), device: device(value.device) };
}
function syncRecord(value: unknown): SyncRecord | null {
  if (value === null) return null;
  const parsed = validateSyncRecord(value);
  if (!parsed.ok) throw new ClientError('INVALID_RESPONSE');
  return parsed.value;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES)
    throw new ClientError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ClientError('INVALID_RESPONSE');
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError('INVALID_RESPONSE');
  } finally {
    reader.releaseLock();
  }
}

export class SyncApi {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetcher: typeof fetch;
  constructor(baseUrl: string, getToken: () => Promise<string>, fetcher?: typeof fetch) {
    this.baseUrl = normalizeServiceUrl(baseUrl);
    this.getToken = getToken;
    // Native Window.fetch requires its Window receiver in some browsers.
    this.fetcher = fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async request(
    path: string,
    signal: AbortSignal,
    method = 'GET',
    data?: unknown,
  ): Promise<unknown> {
    if (signal.aborted) throw new ClientError('ACCOUNT_CHANGED');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort('timeout'), 30_000);
    try {
      const token = await this.getToken();
      if (signal.aborted) throw new ClientError('ACCOUNT_CHANGED');
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        body: data === undefined ? undefined : JSON.stringify(data),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      let body: unknown;
      try {
        body = await boundedJson(response);
      } catch (error) {
        if (response.status === 401 || response.status === 403)
          throw errorFromResponse(response.status);
        throw error;
      }
      if (!response.ok) {
        const code =
          isObject(body) && isObject(body.error) && typeof body.error.code === 'string'
            ? body.error.code
            : undefined;
        throw errorFromResponse(response.status, code);
      }
      return body;
    } catch (error) {
      if (signal.aborted) throw new ClientError('ACCOUNT_CHANGED');
      if (controller.signal.reason === 'timeout') throw new ClientError('REQUEST_TIMEOUT', true);
      if (error instanceof ClientError) throw error;
      throw new ClientError('NETWORK_UNAVAILABLE', true);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async register(name: string, signal: AbortSignal): Promise<AccountIdentity> {
    return identity(
      await this.request('/v1/devices', signal, 'POST', {
        name: name.trim().slice(0, 80) || 'Web 浏览器',
        platform: 'web',
      }),
    );
  }
  async me(signal: AbortSignal): Promise<AccountIdentity> {
    return identity(await this.request('/v1/me', signal));
  }
  async devices(signal: AbortSignal): Promise<DeviceSession[]> {
    const body = await this.request('/v1/devices', signal);
    if (!isObject(body) || !Array.isArray(body.devices)) throw new ClientError('INVALID_RESPONSE');
    return body.devices.map(device);
  }
  async revokeDevice(deviceId: string, signal: AbortSignal): Promise<void> {
    const body = await this.request(`/v1/devices/${uuid(deviceId)}`, signal, 'DELETE');
    if (!isObject(body) || body.revoked !== true || body.deviceId !== deviceId)
      throw new ClientError('INVALID_RESPONSE');
  }
  async push(request: PushRequest, signal: AbortSignal): Promise<PushResponse> {
    const result = validatePushResponse(
      await this.request('/v1/sync/push', signal, 'POST', request),
    );
    if (!result.ok) throw new ClientError('INVALID_RESPONSE');
    return result.value;
  }
  async pull(cursor: string | null, signal: AbortSignal): Promise<PullResponse> {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor !== null) query.set('cursor', cursor);
    const result = validatePullResponse(await this.request(`/v1/sync/pull?${query}`, signal));
    if (!result.ok) throw new ClientError('INVALID_RESPONSE');
    return result.value;
  }
  async conflicts(cursor: string | null, signal: AbortSignal): Promise<ConflictPage> {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor !== null) query.set('cursor', cursor);
    const body = await this.request(`/v1/conflicts?${query}`, signal);
    if (
      !isObject(body) ||
      !Array.isArray(body.conflicts) ||
      typeof body.nextCursor !== 'string' ||
      typeof body.hasMore !== 'boolean'
    )
      throw new ClientError('INVALID_RESPONSE');
    const conflicts = body.conflicts.map((value): ServerConflict => {
      if (!isObject(value)) throw new ClientError('INVALID_RESPONSE');
      const operation = validateSyncOperation(value.attemptedOperation);
      if (
        !operation.ok ||
        operation.value.entityId !== value.entityId ||
        operation.value.entityType !== value.entityType
      )
        throw new ClientError('INVALID_RESPONSE');
      const observedRecord = syncRecord(value.observedRecord);
      const currentRecord = syncRecord(value.currentRecord);
      if (
        [observedRecord, currentRecord].some(
          (record) =>
            record &&
            (record.entityType !== operation.value.entityType ||
              record.entityId !== operation.value.entityId),
        )
      )
        throw new ClientError('INVALID_RESPONSE');
      return {
        conflictId: uuid(value.conflictId),
        entityId: uuid(value.entityId),
        entityType: operation.value.entityType,
        createdAt: timestamp(value.createdAt),
        attemptedOperation: operation.value,
        observedRecord,
        currentRecord,
      };
    });
    return { conflicts, nextCursor: body.nextCursor, hasMore: body.hasMore };
  }
  async resolveConflict(
    conflictId: string,
    choice: ConflictResolution,
    signal: AbortSignal,
  ): Promise<PushResult> {
    const body = await this.request(
      `/v1/conflicts/${uuid(conflictId)}/resolve`,
      signal,
      'POST',
      choice,
    );
    const result = validatePushResponse({ protocolVersion: 1, results: [body] });
    if (!result.ok || result.value.results[0]?.opId !== choice.opId)
      throw new ClientError('INVALID_RESPONSE');
    return result.value.results[0];
  }
}
