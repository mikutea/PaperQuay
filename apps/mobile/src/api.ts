import {ModelInvocationApi} from './modelRouting/api.ts';
import {ModelServiceError,isModelServiceCode} from './modelRouting/errors.ts';
import {readModelResponse,waitForModelCall} from './modelRouting/wire.ts';
import {validateModelInferenceCapability,type ModelInferenceCapability} from '../../../packages/sync-core/src/modelInference.ts';
import {
  validatePullResponse,
  validatePushResponse,
  validateSyncOperation,
  validateSyncRecord,
  SYNC_FEATURE_HEADER,
  PAPER_ORGANIZATION_FEATURE,
  RICH_NOTES_FEATURE,AI_CONVERSATIONS_FEATURE,
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
import { getPlatformCapabilities } from './platform.ts';
import type { CloudPdfCapability } from './pdf/cloudCopies.ts';
import { isDesktopPdfCapability, type DesktopPdfCapability } from './pdf/desktopCopies.ts';
import { validateRemoteTaskCapability, type RemoteTaskCapability } from '../../../packages/sync-core/src/remoteTasks.ts';

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
export const parseAccountIdentity = identity;
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

export interface ServiceCapabilitySnapshot {
  paperOrganization:boolean;richNotes:boolean;aiConversations:boolean;
  cloudPdf:CloudPdfCapability|null;desktopPdf:DesktopPdfCapability|null;remoteTasks:RemoteTaskCapability|null;modelInference:ModelInferenceCapability|null;
}
export class SyncApi {
  private capabilityGeneration=0;
  supportsPaperOrganization = false;
  supportsRichNotes=false;
  supportsAiConversations=false;
  cloudPdfCapability: CloudPdfCapability | null = null;
  desktopPdfCapability: DesktopPdfCapability | null = null;
  remoteTaskCapability: RemoteTaskCapability | null = null;
  modelInferenceCapability:ModelInferenceCapability|null=null;
  readonly modelInvocations:ModelInvocationApi;
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetcher: typeof fetch;
  private readonly getIdentityKey?: () => string | null;
  constructor(baseUrl: string, getToken: () => Promise<string>, fetcher?: typeof fetch, getIdentityKey?: () => string | null) {
    this.baseUrl = normalizeServiceUrl(baseUrl);
    this.getToken = getToken;
    this.getIdentityKey = getIdentityKey;
    this.modelInvocations=new ModelInvocationApi((path,signal,method,data)=>this.request(path,signal,method,data),()=>this.modelInferenceCapability);
    // Native Window.fetch requires its Window receiver in some browsers.
    this.fetcher = fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async request(
    path: string,
    signal: AbortSignal,
    method = 'GET',
    data?: unknown,
  ): Promise<unknown> {
    const isModel=path.startsWith('/v1/model-inference/');
    if (signal.aborted) throw new ClientError('ACCOUNT_CHANGED');
    const identityKey = this.getIdentityKey?.();
    const checkIdentity = () => {
      if (signal.aborted || this.getIdentityKey?.() !== identityKey)
        throw new ClientError('ACCOUNT_CHANGED');
    };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort('timeout'), 30_000);
    try {
      const token = await (isModel?waitForModelCall(this.getToken(),controller.signal):this.getToken());
      checkIdentity();
      const pendingResponse = this.fetcher(`${this.baseUrl}${path}`, {
        method,
        body: data === undefined ? undefined : JSON.stringify(data),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...((this.supportsPaperOrganization||this.supportsRichNotes||this.supportsAiConversations)?{[SYNC_FEATURE_HEADER]:[
            ...(this.supportsPaperOrganization?[PAPER_ORGANIZATION_FEATURE]:[]),...(this.supportsRichNotes?[RICH_NOTES_FEATURE]:[]),
            ...(this.supportsAiConversations?[AI_CONVERSATIONS_FEATURE]:[])].join(', ')}:{}),
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      const response=await(isModel?waitForModelCall(pendingResponse.then(value=>{if(controller.signal.aborted)void value.body?.cancel().catch(()=>{});return value;}),controller.signal):pendingResponse);
      checkIdentity();
      if(isModel&&(response.redirected||['opaque','opaqueredirect','error'].includes(response.type)||response.url&&response.url!==this.baseUrl+path)){void response.body?.cancel().catch(()=>{});throw new ModelServiceError('MODEL_RESPONSE_INVALID',502);}
      let body: unknown;
      try {
        body = isModel?await readModelResponse(response,controller.signal):await boundedJson(response);
      } catch (error) {
        if (response.status === 401 || response.status === 403)
          throw errorFromResponse(response.status);
        throw error;
      }
      checkIdentity();
      if (!response.ok) {
        const code =
          isObject(body) && isObject(body.error) && typeof body.error.code === 'string'
            ? body.error.code
            : undefined;
        if(isModel&&response.status!==401&&response.status!==403&&isModelServiceCode(code))throw new ModelServiceError(code,response.status);
        throw errorFromResponse(response.status, code);
      }
      return body;
    } catch (error) {
      checkIdentity();
      if (controller.signal.reason === 'timeout') throw new ClientError('REQUEST_TIMEOUT', true);
      if (error instanceof ClientError||error instanceof ModelServiceError) throw error;
      throw new ClientError('NETWORK_UNAVAILABLE', true);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async capabilities(signal: AbortSignal): Promise<{ paperOrganization: boolean }> {
    const generation=++this.capabilityGeneration;
    this.supportsRichNotes=false;this.supportsAiConversations=false;
    this.cloudPdfCapability = null;
    this.desktopPdfCapability = null;
    this.remoteTaskCapability = null;
    this.modelInferenceCapability=null;
    const body = await this.request('/v1/capabilities', signal);
    if(generation!==this.capabilityGeneration)throw new ClientError('ACCOUNT_CHANGED');
    if (!isObject(body) || body.protocolVersion !== 1) throw new ClientError('INVALID_RESPONSE');
    this.supportsPaperOrganization = isObject(body.features) && body.features.paperOrganization === 1;
    this.supportsRichNotes=isObject(body.features)&&body.features.richNotes===1;
    this.supportsAiConversations=isObject(body.features)&&body.features.aiConversations===1;
    if (isObject(body.features) && body.features.remoteTasks === 1) {
      try { this.remoteTaskCapability = validateRemoteTaskCapability(body.remoteTasks); }
      catch { throw new ClientError('INVALID_RESPONSE'); }
    }
    let modelCapability:ModelInferenceCapability|null=null;
    if(isObject(body.features)&&body.features.modelInference===1){try{modelCapability=validateModelInferenceCapability(body.modelInference);}catch{throw new ClientError('INVALID_RESPONSE');}}
    let desktopCapability: DesktopPdfCapability | null = null;
    if (isObject(body.features) && body.features.desktopPdfTransfer === 1) {
      const limits = body.desktopPdf;
      if (!isDesktopPdfCapability(limits)) throw new ClientError('INVALID_RESPONSE');
      desktopCapability = { transport: limits.transport, maxFileBytes: limits.maxFileBytes,
        requestTtlMs: limits.requestTtlMs, pollTimeoutMs: limits.pollTimeoutMs,
        ...(limits.direct ? { direct: { transport: limits.direct.transport, attemptMs: limits.direct.attemptMs,
          maxSdpBytes: limits.direct.maxSdpBytes, stunUrls: [...limits.direct.stunUrls] } } : {}) };
    }
    if (body.pdfStorage === true && isObject(body.features) && body.features.privatePdfStorage === 1) {
      const limits = body.cloudPdf;
      if (!isObject(limits) || !Number.isSafeInteger(limits.maxFileBytes) || Number(limits.maxFileBytes) < 1
        || Number(limits.maxFileBytes) > 64 * 1024 * 1024 || !Number.isSafeInteger(limits.maxAccountBytes)
        || Number(limits.maxAccountBytes) < 1 || Number(limits.maxAccountBytes) > 10 * 1024 * 1024 * 1024
        || !Number.isSafeInteger(limits.maxCopies) || Number(limits.maxCopies) < 1 || Number(limits.maxCopies) > 512)
        throw new ClientError('INVALID_RESPONSE');
      this.cloudPdfCapability = { maxFileBytes: Number(limits.maxFileBytes), maxAccountBytes: Number(limits.maxAccountBytes),
        maxCopies: Number(limits.maxCopies) };
    }
    this.desktopPdfCapability = desktopCapability;
    this.modelInferenceCapability=modelCapability;
    return { paperOrganization: this.supportsPaperOrganization };
  }

  /** Read through a detached client; a failed/cancelled inspection never changes
   * transport capabilities used by an in-flight operation. Metadata schema opt-ins
   * remain owned by workspace binding, which also resets its pull cursor. */
  async inspectCapabilities(signal:AbortSignal):Promise<ServiceCapabilitySnapshot>{
    const generation=++this.capabilityGeneration,identityKey=this.getIdentityKey?.();
    const probe=new SyncApi(this.baseUrl,this.getToken,this.fetcher,this.getIdentityKey);
    await probe.capabilities(signal);
    if(signal.aborted||generation!==this.capabilityGeneration||identityKey!==this.getIdentityKey?.())throw new ClientError('ACCOUNT_CHANGED');
    const snapshot:ServiceCapabilitySnapshot={paperOrganization:probe.supportsPaperOrganization,richNotes:probe.supportsRichNotes,aiConversations:probe.supportsAiConversations,
      cloudPdf:probe.cloudPdfCapability,desktopPdf:probe.desktopPdfCapability,remoteTasks:probe.remoteTaskCapability,modelInference:probe.modelInferenceCapability};
    this.cloudPdfCapability=structuredClone(snapshot.cloudPdf);this.desktopPdfCapability=structuredClone(snapshot.desktopPdf);this.remoteTaskCapability=structuredClone(snapshot.remoteTasks);this.modelInferenceCapability=structuredClone(snapshot.modelInference);
    return structuredClone(snapshot);
  }

  async register(name: string, signal: AbortSignal): Promise<AccountIdentity> {
    const platform = getPlatformCapabilities().platform;
    return identity(
      await this.request('/v1/devices', signal, 'POST', {
        name: name.trim().slice(0, 80) || 'Web 浏览器',
        platform: platform === 'ios' || platform === 'android' ? platform : 'web',
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
