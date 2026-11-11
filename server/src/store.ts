import {GRAPH_RELATION_LIMITS} from '../../packages/sync-core/src/graphRelation.ts';
import { createAccountModelRepository, type AccountModelRepository } from './account-model.ts';
import {createModelInferenceRepository,type ModelInferenceRepository,type ModelInferenceRepositoryOptions} from './model-inference-store.ts';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import {
  validateOperation, validatePushRequest,canonicalJson,LEGACY_SYNC_FEATURES,supportsSyncRecord,
} from '../../packages/sync-core/src/index.ts';
import type {
  AttachmentVersionData, EntityData, EntityType, PaperData, PullResponse, PushRequest, PushResponse,
  PushResult, ReadingPositionData, SyncOperation, SyncRecord,SyncFeatureSet,
} from '../../packages/sync-core/src/index.ts';
import type { VerifiedIdentity } from './auth.ts';
import { CursorCodec } from './cursor.ts';
import { ApiError, isTransientDatabaseError } from './errors.ts';
import { checkedCloudPdfByteLimit, checkedRetainedByteLimit, SERVER_LIMITS } from './config.ts';
import type { CloudPdfCopy, CloudPdfQuota, CloudPdfRepository, CloudPdfStatus, ConflictPage, DesktopPdfAccess, DesktopPdfRepository, DesktopPdfTarget, DesktopPdfVersionPage, Device, DevicePlatform, DeviceRegistration, ResolveRequest, SessionView, SyncRepository } from './types.ts';
import {createRemoteTaskRepository,type RemoteTaskRepository} from './remote-task-store.ts';
import {createRemoteRetrievalRepository,type RemoteRetrievalRepository} from './remote-retrieval-store.ts';
import {createAccountPrivacyRepository,type AccountPrivacyRepository} from './account-privacy.ts';

interface AccountRow {
  id: string; epoch: string; last_seq: string; last_conflict_seq: string; entity_count: number; receipt_count: number; retained_bytes: string;
  closed_at: Date | null; closure_request_id: string | null; erase_devices_requested: boolean;
}
interface DeviceRow {
  id: string; name: string; platform: DevicePlatform; created_at: Date; last_seen_at: Date; revoked_at: Date | null;
}
interface EntityRow {
  entity_type: EntityType; entity_id: string; schema_version: 1; revision: string;
  data: EntityData; deleted_at: Date | null; updated_at: Date;
  created_by_device_id: string; modified_by_device_id: string;
  cloud_pdf_generation: string;
}
interface CloudPdfRow {
  attachment_version_id: string; paper_id: string; sha256: string; size_bytes: number;
  file_name: string; created_at: Date; available: boolean; content?: Buffer;
}
interface ConflictRow {
  id: string; seq: string; entity_type: EntityType; entity_id: string;
  attempted_operation: SyncOperation; observed_record: SyncRecord;
  created_at: Date; resolved_at: Date | null;
}
interface TransactionContext {
  client: PoolClient; account: AccountRow; device: DeviceRow;
  preflightedReceiptOpId?: string;
}
interface DesktopReadContext { client: PoolClient; accountId: string; device: DeviceRow }
interface DesktopTargetRow {
  version_id: string; version_revision: string; version_data: AttachmentVersionData; version_deleted: Date | null;
  paper_id: string | null; paper_revision: string | null; paper_title: string | null; paper_deleted: Date | null;
}
type ResponsePreflight = (result: PushResult) => void;
type RetainedWriteKind = 'entity' | 'conflict' | 'change' | 'receipt';
interface StoreHooks {
  /** Fault/concurrency injection for isolated integration tests, never configured from HTTP or environment. */
  beforeCommit?: (event: { kind: 'push' | 'resolve' | 'revoke' | 'cloud-put' | 'cloud-delete' | 'account-close'; opId?: string;
    attachmentVersionId?: string; accountId: string; deviceId: string }) => Promise<void>;
}
interface StoreOptions {
  connectionString?: string;
  pool?: pg.Pool;
  erasureConnectionString?: string;
  erasurePool?: pg.Pool;
  cursorSecret: Uint8Array;
  hooks?: StoreHooks;
  responseLimitBytes?: number;
  maxAccountRetainedBytes?: number;
  cloudPdfEnabled?: boolean;
  cloudPdfAccountBytes?: number;
}

class ResponseBudgetExceeded extends Error {}
class AccountStorageLimitExceeded extends Error {}

function isAccountStorageLimit(error: unknown): boolean {
  if (error instanceof AccountStorageLimitExceeded) return true;
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23514'
    && 'constraint' in error && error.constraint === 'paperquay_account_retained_bytes_limit';
}

const entityColumns = 'entity_type, entity_id, schema_version, revision, data, deleted_at, updated_at, created_by_device_id, modified_by_device_id, cloud_pdf_generation';
const deviceColumns = 'id, name, platform, created_at, last_seen_at, revoked_at';
const cloudPdfColumns = `c.attachment_version_id, c.paper_id, c.sha256, c.size_bytes, c.file_name, c.created_at,
  (v.deleted_at IS NULL AND p.deleted_at IS NULL) AS available`;
const cloudPdfJoins = `JOIN paperquay.entities v ON v.account_id = c.account_id
    AND v.entity_type = 'attachmentVersion' AND v.entity_id = c.attachment_version_id
  JOIN paperquay.entities p ON p.account_id = c.account_id AND p.entity_type = 'paper' AND p.entity_id = c.paper_id`;
const desktopTargetColumns = 'v.entity_id AS version_id, v.revision AS version_revision, v.data AS version_data, v.deleted_at AS version_deleted, '
  + 'p.entity_id AS paper_id, p.revision AS paper_revision, p.data ->> \'title\' AS paper_title, p.deleted_at AS paper_deleted';
const desktopTargetFrom = ' FROM paperquay.entities v LEFT JOIN paperquay.entities p ON p.account_id = v.account_id '
  + 'AND p.entity_type = \'paper\' AND p.entity_id = (v.data ->> \'paperId\')::uuid ';

function toDesktopTarget(row: DesktopTargetRow): DesktopPdfTarget {
  const data = row.version_data;
  return { paper: { entityId: row.paper_id!, revision: Number(row.paper_revision), title: row.paper_title! },
    version: { entityId: row.version_id, revision: Number(row.version_revision), data: {
      paperId: data.paperId, attachmentId: data.attachmentId, sha256: data.sha256, sizeBytes: data.sizeBytes,
      mediaType: data.mediaType, fileName: data.fileName, pageCount: data.pageCount,
    } } };
}

function toCloudPdf(row: CloudPdfRow): CloudPdfCopy {
  return { attachmentVersionId: row.attachment_version_id, paperId: row.paper_id, sha256: row.sha256,
    sizeBytes: row.size_bytes, fileName: row.file_name, createdAt: row.created_at.toISOString(), available: row.available };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function operationHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id, name: row.name, platform: row.platform,
    createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

function toRecord(row: EntityRow): SyncRecord {
  return {
    entityType: row.entity_type, entityId: row.entity_id, schemaVersion: 1,
    revision: Number(row.revision), deletedAt: row.deleted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(), modifiedByDeviceId: row.modified_by_device_id,
    data: row.deleted_at ? null : row.data,
  } as SyncRecord;
}

function rejected(opId: string, code: string, retryable = false): PushResult {
  return { opId, status: 'rejected', replayed: false, code, retryable };
}

/** Every request uses a transaction-local identity; a pooled connection never carries tenant state. */
export class PostgresSyncStore implements SyncRepository, CloudPdfRepository, DesktopPdfRepository {
  readonly pool: pg.Pool;
  readonly cursors: CursorCodec;
  readonly hooks: StoreHooks;
  readonly responseLimitBytes: number;
  readonly maxAccountRetainedBytes: number;
  readonly cloudPdfEnabled: boolean;
  readonly cloudPdfAccountBytes: number;
  private readonly ownsPool: boolean;
  private readonly erasurePool?: pg.Pool;
  private readonly ownsErasurePool: boolean;

  constructor(options: StoreOptions) {
    this.maxAccountRetainedBytes = checkedRetainedByteLimit(options.maxAccountRetainedBytes ?? SERVER_LIMITS.maxAccountRetainedBytes);
    this.cloudPdfEnabled = options.cloudPdfEnabled ?? false;
    this.cloudPdfAccountBytes = checkedCloudPdfByteLimit(options.cloudPdfAccountBytes ?? SERVER_LIMITS.cloudPdfAccountBytes);
    this.ownsPool = !options.pool;
    const poolOptions: PoolConfig = {
      connectionString: options.connectionString, max: 10, connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000, application_name: 'paperquay-sync',
    };
    this.pool = options.pool ?? new pg.Pool(poolOptions);
    // A disconnected idle client must not crash the server or print driver errors/credentials.
    this.pool.on('error', () => undefined);
    this.ownsErasurePool = Boolean(options.erasureConnectionString && !options.erasurePool);
    this.erasurePool = options.erasurePool ?? (options.erasureConnectionString ? new pg.Pool({
      ...poolOptions, connectionString: options.erasureConnectionString, max: 2, application_name: 'paperquay-erasure',
    }) : undefined);
    this.erasurePool?.on('error', () => undefined);
    this.cursors = new CursorCodec(options.cursorSecret);
    this.hooks = options.hooks ?? {};
    this.responseLimitBytes = options.responseLimitBytes ?? SERVER_LIMITS.responseLimitBytes;
  }

  async close(): Promise<void> {
    await Promise.all([this.ownsPool ? this.pool.end() : undefined,
      this.ownsErasurePool ? this.erasurePool?.end() : undefined]);
  }

  async ready(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ version: string }>('SELECT version FROM paperquay.schema_migrations ORDER BY version');
      return result.rows.map((row) => row.version).join(',') === '001_initial.sql,002_receipt_quota.sql,003_retained_bytes_quota.sql,004_private_cloud_pdfs.sql,005_remote_tasks.sql,006_extended_sync_content.sql,007_remote_task_recovery.sql,008_remote_journal_holder.sql,009_remote_request_cancellation.sql,010_model_inference.sql,011_graph_relations.sql,012_remote_retrieval.sql,013_account_privacy.sql,014_account_model_settings.sql';
    } catch { return false; }
  }

  modelInference(options:Pick<ModelInferenceRepositoryOptions,'gateway'>={}):ModelInferenceRepository{
    return createModelInferenceRepository({...options,withAccount:(identity,work)=>this.withAccount(identity,false,context=>work(context))});
  }

  remoteTasks():RemoteTaskRepository{
    return createRemoteTaskRepository({withAccount:(identity,work)=>this.withAccount(identity,false,context=>work(context))});
  }

  remoteRetrieval():RemoteRetrievalRepository{
    return createRemoteRetrievalRepository({withAccount:(identity,work)=>this.withAccount(identity,false,context=>work(context))});
  }

  accountModel(key: Uint8Array): AccountModelRepository {
    return createAccountModelRepository((identity, work) => this.withAccount(identity, false, work), key);
  }

  privacy(): AccountPrivacyRepository {
    return createAccountPrivacyRepository({pool:this.pool,
      withAccount:(identity,work)=>this.withAccount(identity,false,work,true,true),
      withClosureAccount:async(identity,work)=>{
        if (!this.erasurePool) throw new ApiError('ACCOUNT_CLOSURE_UNAVAILABLE',503);
        return this.withAccount(identity,false,work,true,true,this.erasurePool);
      },
      checkAccess:identity=>this.me(identity),
      beforeCloseCommit:context=>this.hooks.beforeCommit?.({kind:'account-close',accountId:context.account.id,deviceId:context.device.id})
        ?? Promise.resolve()});
  }

  private async withAccount<T>(identity: VerifiedIdentity, create: boolean,
    action: (context: TransactionContext) => Promise<T>, requireDevice = true, allowClosed = false, pool = this.pool): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SELECT set_config('paperquay.issuer', $1, true), set_config('paperquay.subject', $2, true)", [identity.issuer, identity.subject]);
      await client.query("SELECT set_config('paperquay.retained_byte_limit', $1, true)", [String(this.maxAccountRetainedBytes)]);
      await client.query("SELECT set_config('paperquay.cloud_pdf_byte_limit', $1, true)", [String(this.cloudPdfAccountBytes)]);
      if (create) {
        await client.query(`INSERT INTO paperquay.accounts(id, issuer, subject, epoch)
          VALUES ($1,$2,$3,$4) ON CONFLICT (issuer, subject) DO NOTHING`, [randomUUID(), identity.issuer, identity.subject, randomUUID()]);
      }
      const accounts = await client.query<AccountRow>(`SELECT id, epoch, last_seq, last_conflict_seq, entity_count, receipt_count, retained_bytes,
        closed_at,closure_request_id,erase_devices_requested
        FROM paperquay.accounts WHERE issuer = $1 AND subject = $2 FOR UPDATE`, [identity.issuer, identity.subject]);
      const account = accounts.rows[0];
      if (!account) throw new ApiError('DEVICE_NOT_REGISTERED', 403);
      if (account.closed_at && !allowClosed) throw new ApiError('ACCOUNT_CLOSED', 410);
      await client.query("SELECT set_config('paperquay.account_id', $1, true)", [account.id]);
      let device: DeviceRow | undefined;
      if (requireDevice && !account.closed_at) {
        const devices = await client.query<DeviceRow>(`SELECT ${deviceColumns} FROM paperquay.devices
          WHERE account_id = $1 AND session_id = $2`, [account.id, identity.sessionId]);
        device = devices.rows[0];
        if (!device) throw new ApiError('DEVICE_NOT_REGISTERED', 403);
        if (device.revoked_at) throw new ApiError('SESSION_REVOKED', 403);
        const touch = await client.query<DeviceRow>(`UPDATE paperquay.devices SET last_seen_at = clock_timestamp()
          WHERE account_id = $1 AND id = $2 RETURNING ${deviceColumns}`, [account.id, device.id]);
        device = touch.rows[0];
      }
      // Registration supplies its own device, and never calls mutation helpers before doing so.
      const result = await action({ client, account, device: device as DeviceRow });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async registerDevice(identity: VerifiedIdentity, registration: DeviceRegistration): Promise<SessionView> {
    return this.withAccount(identity, true, async ({ client, account }) => {
      const previous = await client.query<DeviceRow>(`SELECT ${deviceColumns} FROM paperquay.devices
        WHERE account_id = $1 AND session_id = $2`, [account.id, identity.sessionId]);
      if (previous.rows[0]?.revoked_at) throw new ApiError('SESSION_REVOKED', 403);
      if (previous.rows[0]) {
        const updated = await client.query<DeviceRow>(`UPDATE paperquay.devices
          SET name = $3, platform = $4, last_seen_at = clock_timestamp()
          WHERE account_id = $1 AND id = $2 RETURNING ${deviceColumns}`,
        [account.id, previous.rows[0].id, registration.name, registration.platform]);
        return { accountId: account.id, device: toDevice(updated.rows[0]) };
      }
      const count = await client.query<{ active: string; retained: string }>(`SELECT
        count(*) FILTER (WHERE revoked_at IS NULL) AS active, count(*) AS retained
        FROM paperquay.devices WHERE account_id = $1`, [account.id]);
      if (Number(count.rows[0].active) >= SERVER_LIMITS.maxDevices) throw new ApiError('DEVICE_LIMIT_REACHED', 409);
      if (Number(count.rows[0].retained) >= SERVER_LIMITS.maxRetainedDeviceSessions) throw new ApiError('SESSION_HISTORY_LIMIT_REACHED', 409);
      const created = await client.query<DeviceRow>(`INSERT INTO paperquay.devices(account_id,id,session_id,name,platform)
        VALUES ($1,$2,$3,$4,$5) RETURNING ${deviceColumns}`,
      [account.id, randomUUID(), identity.sessionId, registration.name, registration.platform]);
      return { accountId: account.id, device: toDevice(created.rows[0]) };
    }, false);
  }

  async me(identity: VerifiedIdentity): Promise<SessionView> {
    return this.withAccount(identity, false, async ({ account, device }) => ({ accountId: account.id, device: toDevice(device) }));
  }

  /** Streaming checks must not hold the account write lock or mutate last_seen_at. */
  private async withDesktopAccount<T>(identity: VerifiedIdentity, action: (context: DesktopReadContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '1s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('paperquay.issuer', $1, true), set_config('paperquay.subject', $2, true)", [identity.issuer, identity.subject]);
      const accounts = await client.query<{ id: string; closed_at: Date | null }>('SELECT id,closed_at FROM paperquay.accounts WHERE issuer = $1 AND subject = $2', [identity.issuer, identity.subject]);
      const accountId = accounts.rows[0]?.id;
      if (!accountId) throw new ApiError('DEVICE_NOT_REGISTERED', 403);
      if (accounts.rows[0].closed_at) throw new ApiError('ACCOUNT_CLOSED', 410);
      await client.query("SELECT set_config('paperquay.account_id', $1, true)", [accountId]);
      const devices = await client.query<DeviceRow>('SELECT ' + deviceColumns + ' FROM paperquay.devices WHERE account_id = $1 AND session_id = $2', [accountId, identity.sessionId]);
      const device = devices.rows[0];
      if (!device) throw new ApiError('DEVICE_NOT_REGISTERED', 403);
      if (device.revoked_at) throw new ApiError('SESSION_REVOKED', 403);
      const result = await action({ client, accountId, device });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async desktopPdfSession(identity: VerifiedIdentity): Promise<SessionView> {
    return this.withDesktopAccount(identity, async ({ accountId, device }) => ({ accountId, device: toDevice(device) }));
  }

  private async desktopPdfTarget(context: DesktopReadContext, attachmentVersionId: string): Promise<DesktopPdfTarget> {
    const result = await context.client.query<DesktopTargetRow>('SELECT ' + desktopTargetColumns + desktopTargetFrom
      + "WHERE v.account_id = $1 AND v.entity_type = 'attachmentVersion' AND v.entity_id = $2", [context.accountId, attachmentVersionId]);
    const row = result.rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 404);
    if (row.version_deleted || !row.paper_id || row.paper_deleted) throw new ApiError('ATTACHMENT_VERSION_UNAVAILABLE', 410);
    if (row.version_data.mediaType !== 'application/pdf') throw new ApiError('INVALID_PDF', 415);
    if (row.version_data.sizeBytes > SERVER_LIMITS.desktopPdfMaxFileBytes) throw new ApiError('REQUEST_TOO_LARGE', 413);
    return toDesktopTarget(row);
  }

  async getDesktopPdfVersion(identity: VerifiedIdentity, attachmentVersionId: string): Promise<DesktopPdfTarget> {
    return this.withDesktopAccount(identity, (context) => this.desktopPdfTarget(context, attachmentVersionId));
  }

  async listDesktopPdfVersions(identity: VerifiedIdentity, after: string | undefined, limit: number): Promise<DesktopPdfVersionPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('VALIDATION_FAILED');
    return this.withDesktopAccount(identity, async (context) => {
      const result = await context.client.query<DesktopTargetRow>('SELECT ' + desktopTargetColumns + desktopTargetFrom
        + "WHERE v.account_id = $1 AND v.entity_type = 'attachmentVersion' AND v.deleted_at IS NULL "
        + "AND p.entity_id IS NOT NULL AND p.deleted_at IS NULL AND v.data ->> 'mediaType' = 'application/pdf' "
        + "AND (v.data ->> 'sizeBytes')::bigint <= $2 AND ($3::uuid IS NULL OR v.entity_id > $3::uuid) "
        + 'ORDER BY v.entity_id LIMIT $4', [context.accountId, SERVER_LIMITS.desktopPdfMaxFileBytes, after ?? null, limit + 1]);
      const items = result.rows.slice(0, limit).map(toDesktopTarget);
      const hasMore = result.rows.length > limit;
      return { items, hasMore, nextAfter: hasMore ? items[items.length - 1].version.entityId : null };
    });
  }

  async checkDesktopPdfTransfer(consumer: VerifiedIdentity, provider: VerifiedIdentity | null, target: DesktopPdfTarget): Promise<DesktopPdfAccess> {
    if (provider && (consumer.issuer !== provider.issuer || consumer.subject !== provider.subject || consumer.sessionId === provider.sessionId)) {
      throw new ApiError('NOT_FOUND', 404);
    }
    return this.withDesktopAccount(consumer, async (context) => {
      // Both devices and both entities are observed by one statement. A long
      // stream never holds this transaction or an account row lock open.
      const result = await context.client.query<DesktopTargetRow & {
        consumer_device_id: string; consumer_revoked_at: Date | null;
        provider_device_id: string | null; provider_revoked_at: Date | null; provider_platform: DevicePlatform | null;
      }>('SELECT ' + desktopTargetColumns + ', c.id AS consumer_device_id, c.revoked_at AS consumer_revoked_at, '
        + 'd.id AS provider_device_id, d.revoked_at AS provider_revoked_at, d.platform AS provider_platform'
        + desktopTargetFrom
        + 'JOIN paperquay.devices c ON c.account_id = v.account_id AND c.session_id = $3 '
        + 'LEFT JOIN paperquay.devices d ON d.account_id = v.account_id AND d.session_id = $4 '
        + "WHERE v.account_id = $1 AND v.entity_type = 'attachmentVersion' AND v.entity_id = $2",
      [context.accountId, target.version.entityId, consumer.sessionId, provider?.sessionId ?? null]);
      const row = result.rows[0];
      if (!row) throw new ApiError('NOT_FOUND', 404);
      if (row.consumer_revoked_at) throw new ApiError('SESSION_REVOKED', 403);
      if (row.version_deleted || !row.paper_id || row.paper_deleted) throw new ApiError('ATTACHMENT_VERSION_UNAVAILABLE', 410);
      const current = toDesktopTarget(row);
      if (current.paper.entityId !== target.paper.entityId || current.paper.revision !== target.paper.revision
        || current.version.revision !== target.version.revision || current.version.data.sha256 !== target.version.data.sha256
        || current.version.data.sizeBytes !== target.version.data.sizeBytes) throw new ApiError('DESKTOP_PDF_CHANGED', 409);
      if (provider && (!row.provider_device_id || row.provider_revoked_at
        || !['windows', 'macos', 'linux'].includes(row.provider_platform ?? '')
        || row.provider_device_id === row.consumer_device_id)) throw new ApiError('DESKTOP_PDF_UNAVAILABLE', 404);
      return { accountId: context.accountId, consumerDeviceId: row.consumer_device_id, providerDeviceId: row.provider_device_id };
    });
  }

  async listDevices(identity: VerifiedIdentity): Promise<{ devices: Device[] }> {
    return this.withAccount(identity, false, async ({ client, account }) => {
      const result = await client.query<DeviceRow>(`SELECT ${deviceColumns} FROM paperquay.devices
        WHERE account_id = $1 ORDER BY created_at, id`, [account.id]);
      return { devices: result.rows.map(toDevice) };
    });
  }

  async revokeDevice(identity: VerifiedIdentity, deviceId: string): Promise<{ revoked: true; deviceId: string }> {
    return this.withAccount(identity, false, async ({ client, account, device }) => {
      const result = await client.query(`UPDATE paperquay.devices SET revoked_at = coalesce(revoked_at, clock_timestamp())
        WHERE account_id = $1 AND id = $2 RETURNING id`, [account.id, deviceId]);
      if (result.rowCount !== 1) throw new ApiError('NOT_FOUND', 404);
      await this.hooks.beforeCommit?.({ kind: 'revoke', accountId: account.id, deviceId: device.id });
      return { revoked: true, deviceId };
    });
  }

  private async entity(context: TransactionContext, type: EntityType, id: string): Promise<EntityRow | undefined> {
    const result = await context.client.query<EntityRow>(`SELECT ${entityColumns} FROM paperquay.entities
      WHERE account_id = $1 AND entity_type = $2 AND entity_id = $3`, [context.account.id, type, id]);
    return result.rows[0];
  }

  private requireCloudPdfs(): void {
    if (!this.cloudPdfEnabled) throw new ApiError('CLOUD_PDF_STORAGE_DISABLED', 503);
  }

  private async cloudPdfQuota(context: TransactionContext): Promise<CloudPdfQuota> {
    const result = await context.client.query<{ cloud_pdf_bytes: string; cloud_pdf_count: number }>(
      'SELECT cloud_pdf_bytes, cloud_pdf_count FROM paperquay.accounts WHERE id = $1', [context.account.id]);
    return { usedBytes: Number(result.rows[0].cloud_pdf_bytes), maxBytes: this.cloudPdfAccountBytes,
      usedCopies: result.rows[0].cloud_pdf_count, maxCopies: SERVER_LIMITS.cloudPdfMaxCopies };
  }

  private async cloudPdfVersion(context: TransactionContext, id: string, active: boolean): Promise<EntityRow> {
    const version = await this.entity(context, 'attachmentVersion', id);
    if (!version) throw new ApiError('NOT_FOUND', 404);
    if (active) {
      const paper = await this.entity(context, 'paper', (version.data as AttachmentVersionData).paperId);
      if (version.deleted_at || !paper || paper.deleted_at) throw new ApiError('ATTACHMENT_VERSION_UNAVAILABLE', 410);
    }
    return version;
  }

  private async cloudPdfRow(context: TransactionContext, id: string, content = false): Promise<CloudPdfRow | undefined> {
    const result = await context.client.query<CloudPdfRow>(`SELECT ${cloudPdfColumns}${content ? ', c.content' : ''}
      FROM paperquay.cloud_pdfs c ${cloudPdfJoins} WHERE c.account_id = $1 AND c.attachment_version_id = $2`, [context.account.id, id]);
    return result.rows[0];
  }

  private checkCloudPdfHeadroom(quota: CloudPdfQuota, size: number): void {
    if (size > SERVER_LIMITS.cloudPdfMaxFileBytes) throw new ApiError('REQUEST_TOO_LARGE', 413);
    if (quota.usedCopies >= quota.maxCopies || size > quota.maxBytes - quota.usedBytes) {
      throw new ApiError('CLOUD_PDF_QUOTA_EXCEEDED', 409);
    }
  }

  async listCloudPdfs(identity: VerifiedIdentity): Promise<{ copies: CloudPdfCopy[]; quota: CloudPdfQuota }> {
    this.requireCloudPdfs();
    return this.withAccount(identity, false, async (context) => {
      const result = await context.client.query<CloudPdfRow>(`SELECT ${cloudPdfColumns}
        FROM paperquay.cloud_pdfs c ${cloudPdfJoins} WHERE c.account_id = $1
        ORDER BY c.created_at, c.attachment_version_id`, [context.account.id]);
      return { copies: result.rows.map(toCloudPdf), quota: await this.cloudPdfQuota(context) };
    });
  }

  async getCloudPdf(identity: VerifiedIdentity, attachmentVersionId: string): Promise<CloudPdfStatus> {
    this.requireCloudPdfs();
    return this.withAccount(identity, false, async (context) => {
      await this.cloudPdfVersion(context, attachmentVersionId, false);
      const row = await this.cloudPdfRow(context, attachmentVersionId);
      return { copy: row ? toCloudPdf(row) : null, quota: await this.cloudPdfQuota(context) };
    });
  }

  async prepareCloudPdfUpload(identity: VerifiedIdentity, attachmentVersionId: string): Promise<{ accountId: string; sizeBytes: number; generation: string }> {
    this.requireCloudPdfs();
    return this.withAccount(identity, false, async (context) => {
      const version = await this.cloudPdfVersion(context, attachmentVersionId, true);
      const data = version.data as AttachmentVersionData;
      if (data.sizeBytes > SERVER_LIMITS.cloudPdfMaxFileBytes) throw new ApiError('REQUEST_TOO_LARGE', 413);
      const existing = await this.cloudPdfRow(context, attachmentVersionId);
      if (!existing) this.checkCloudPdfHeadroom(await this.cloudPdfQuota(context), data.sizeBytes);
      return { accountId: context.account.id, sizeBytes: data.sizeBytes, generation: version.cloud_pdf_generation };
    });
  }

  async putCloudPdf(identity: VerifiedIdentity, attachmentVersionId: string, content: Buffer, generation: string): Promise<{ copy: CloudPdfCopy; replayed: boolean; quota: CloudPdfQuota }> {
    this.requireCloudPdfs();
    try {
      return await this.withAccount(identity, false, async (context) => {
        const version = await this.cloudPdfVersion(context, attachmentVersionId, true);
        if (generation !== version.cloud_pdf_generation) throw new ApiError('CLOUD_PDF_CHANGED', 409);
        const data = version.data as AttachmentVersionData;
        if (!Buffer.isBuffer(content) || content.byteLength !== data.sizeBytes
          || createHash('sha256').update(content).digest('hex') !== data.sha256) throw new ApiError('PDF_INTEGRITY_MISMATCH', 422);
        if (content.byteLength > SERVER_LIMITS.cloudPdfMaxFileBytes) throw new ApiError('REQUEST_TOO_LARGE', 413);
        // Marker checks do not claim complete PDF parsing, page validation or safety.
        if (content.subarray(0, 5).toString('ascii') !== '%PDF-'
          || !content.subarray(Math.max(0, content.byteLength - 1024)).includes(Buffer.from('%%EOF'))) {
          throw new ApiError('INVALID_PDF', 415);
        }
        const existing = await this.cloudPdfRow(context, attachmentVersionId);
        if (existing) return { copy: toCloudPdf(existing), replayed: true, quota: await this.cloudPdfQuota(context) };
        this.checkCloudPdfHeadroom(await this.cloudPdfQuota(context), content.byteLength);
        await context.client.query(`INSERT INTO paperquay.cloud_pdfs(account_id,attachment_version_id,paper_id,sha256,size_bytes,file_name,content)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [context.account.id, attachmentVersionId, data.paperId, data.sha256, data.sizeBytes, data.fileName, content]);
        await this.hooks.beforeCommit?.({ kind: 'cloud-put', attachmentVersionId, accountId: context.account.id, deviceId: context.device.id });
        return { copy: toCloudPdf((await this.cloudPdfRow(context, attachmentVersionId))!), replayed: false,
          quota: await this.cloudPdfQuota(context) };
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'constraint' in error && error.constraint === 'paperquay_cloud_pdf_quota') {
        throw new ApiError('CLOUD_PDF_QUOTA_EXCEEDED', 409);
      }
      throw error;
    }
  }

  async downloadCloudPdf(identity: VerifiedIdentity, attachmentVersionId: string): Promise<{ copy: CloudPdfCopy; content: Buffer }> {
    this.requireCloudPdfs();
    return this.withAccount(identity, false, async (context) => {
      await this.cloudPdfVersion(context, attachmentVersionId, true);
      const row = await this.cloudPdfRow(context, attachmentVersionId, true);
      if (!row) throw new ApiError('CLOUD_PDF_NOT_FOUND', 404);
      return { copy: toCloudPdf(row), content: row.content! };
    });
  }

  async deleteCloudPdf(identity: VerifiedIdentity, attachmentVersionId: string): Promise<{ attachmentVersionId: string; deleted: boolean; quota: CloudPdfQuota }> {
    this.requireCloudPdfs();
    return this.withAccount(identity, false, async (context) => {
      const version = await this.cloudPdfVersion(context, attachmentVersionId, false);
      if (BigInt(version.cloud_pdf_generation) >= BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError('CLOUD_PDF_CHANGED', 409);
      // Even an absent-copy delete invalidates already-admitted uploads. Only an
      // explicit later request can obtain this new generation and create a copy.
      await context.client.query(`UPDATE paperquay.entities SET cloud_pdf_generation = cloud_pdf_generation + 1
        WHERE account_id = $1 AND entity_type = 'attachmentVersion' AND entity_id = $2`, [context.account.id, attachmentVersionId]);
      const deleted = await context.client.query('DELETE FROM paperquay.cloud_pdfs WHERE account_id = $1 AND attachment_version_id = $2',
        [context.account.id, attachmentVersionId]);
      await this.hooks.beforeCommit?.({ kind: 'cloud-delete', attachmentVersionId, accountId: context.account.id, deviceId: context.device.id });
      return { attachmentVersionId, deleted: deleted.rowCount === 1, quota: await this.cloudPdfQuota(context) };
    });
  }

  private async receipt(context: TransactionContext, opId: string, hash: string): Promise<PushResult | undefined> {
    const result = await context.client.query<{ request_hash: string; result: PushResult }>(`SELECT request_hash, result
      FROM paperquay.operation_receipts WHERE account_id = $1 AND op_id = $2`, [context.account.id, opId]);
    if (!result.rows[0]) return undefined;
    if (result.rows[0].request_hash !== hash) return rejected(opId, 'IDEMPOTENCY_MISMATCH');
    return { ...result.rows[0].result, replayed: true };
  }

  private requireStorageHeadroom(context: TransactionContext): void {
    // Replays are looked up before this check. A full/legacy-over-limit account
    // remains readable, but must not start another mutation or rejection receipt.
    if (BigInt(context.account.retained_bytes) >= BigInt(this.maxAccountRetainedBytes)) {
      throw new AccountStorageLimitExceeded();
    }
    // The write-plan preflight checks every retained copy before content writes.
    // BEFORE-row triggers remain the final enforcement and rollback boundary.
  }

  private async checkRetainedWritePlan(context: TransactionContext, result: PushResult,
    kind: RetainedWriteKind, operation?: SyncOperation): Promise<void> {
    // Every plan includes the final receipt. PostgreSQL measures the same JSONB
    // representation as migration 003; this SELECT never reserves or charges bytes.
    // Existing record bodies stay in PostgreSQL rather than crossing the wire again.
    const record = result.record;
    const storedRecord = kind !== 'entity' && record !== undefined;
    const hydrateRecord = storedRecord && record.deletedAt === null;
    const candidate = storedRecord ? { ...result, record: { ...record, data: null } } : result;
    const measured = await context.client.query<{ used_bytes: string; byte_delta: string | null; has_stored_entity: boolean }>(`
      WITH stored_entity AS MATERIALIZED (
        SELECT data FROM paperquay.entities
        WHERE account_id = $1 AND entity_type = $2 AND entity_id = $3
          AND (($4::text = 'entity' AND $5::text <> 'delete') OR $6::boolean)
      ), input AS (
        SELECT $7::jsonb AS result, $8::jsonb AS attempted_operation,
          (SELECT data FROM stored_entity) AS stored_data
      ), complete AS (
        SELECT CASE WHEN $6::boolean AND result #>> '{record,deletedAt}' IS NULL
          THEN jsonb_set(result, '{record,data}', stored_data) ELSE result END AS result,
          attempted_operation, stored_data FROM input
      ), cost AS (
        SELECT
          CASE WHEN $4::text = 'entity' AND $5::text <> 'delete' THEN
            CASE WHEN stored_data IS NULL THEN 512::bigint ELSE 0::bigint END
            + octet_length(convert_to((result -> 'record' -> 'data')::text, 'UTF8'))
            - coalesce(octet_length(convert_to(stored_data::text, 'UTF8')), 0)
          ELSE 0::bigint END
          + CASE WHEN $4::text IN ('entity', 'change') THEN
            512::bigint + octet_length(convert_to((result -> 'record')::text, 'UTF8'))
          ELSE 0::bigint END
          + CASE WHEN $4::text = 'conflict' THEN
            512::bigint + octet_length(convert_to(attempted_operation::text, 'UTF8'))
            + octet_length(convert_to((result -> 'record')::text, 'UTF8'))
          ELSE 0::bigint END
          + 512::bigint + octet_length(convert_to(result::text, 'UTF8')) AS byte_delta,
          stored_data IS NOT NULL AS has_stored_entity
        FROM complete
      ) SELECT account.retained_bytes::text AS used_bytes, cost.byte_delta::text AS byte_delta,
          cost.has_stored_entity
        FROM paperquay.accounts AS account CROSS JOIN cost WHERE account.id = $1`,
    [context.account.id, record?.entityType ?? null, record?.entityId ?? null, kind,
      operation?.mutation ?? null, hydrateRecord, JSON.stringify(candidate),
      kind === 'conflict' ? JSON.stringify(operation) : null]);
    const bytes = measured.rows[0];
    if (!bytes || bytes.byte_delta === null || (hydrateRecord && !bytes.has_stored_entity)) {
      throw new ApiError('STORAGE_INVARIANT_FAILED', 500);
    }
    // A shrinking replacement can free bytes before its change and receipt are
    // written. Preserve that signed delta and compare against the live ledger.
    if (BigInt(bytes.used_bytes) + BigInt(bytes.byte_delta) > BigInt(this.maxAccountRetainedBytes)) {
      throw new AccountStorageLimitExceeded();
    }
    context.preflightedReceiptOpId = result.opId;
  }

  private async remember(context: TransactionContext, hash: string, result: PushResult): Promise<PushResult> {
    if (result.status !== 'rejected' || !result.retryable) {
      if (context.account.receipt_count >= SERVER_LIMITS.maxAccountReceipts) throw new ApiError('ACCOUNT_RECEIPT_LIMIT', 409);
      if (context.preflightedReceiptOpId !== result.opId) await this.checkRetainedWritePlan(context, result, 'receipt');
      await context.client.query('INSERT INTO paperquay.operation_receipts(account_id,op_id,request_hash,result) VALUES ($1,$2,$3,$4::jsonb)',
        [context.account.id, result.opId, hash, JSON.stringify(result)]);
      // The database trigger increments the durable counter atomically, including
      // inserts from an older server during a rolling local upgrade.
      context.account.receipt_count++;
    }
    return result;
  }

  private async appendChange(context: TransactionContext, record: SyncRecord): Promise<void> {
    const incremented = await context.client.query<{ last_seq: string }>('UPDATE paperquay.accounts SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq', [context.account.id]);
    context.account.last_seq = incremented.rows[0].last_seq;
    await context.client.query(`INSERT INTO paperquay.changes(account_id,seq,entity_type,entity_id,record)
      VALUES ($1,$2,$3,$4,$5::jsonb)`, [context.account.id, context.account.last_seq, record.entityType, record.entityId, JSON.stringify(record)]);
  }

  private async saveEntity(context: TransactionContext, operation: SyncOperation, existing: EntityRow | undefined,
    data: EntityData, deletedAt: string | null, preflight?: ResponsePreflight): Promise<SyncRecord> {
    const revision = existing ? Number(existing.revision) + 1 : 1;
    const updatedAt = new Date().toISOString();
    // Use the same revision, timestamps and device as the row below. A rejected
    // response must not first write the entity or its full change-feed copy.
    const candidate: PushResult = {
      opId: operation.opId, status: 'applied', replayed: false,
      record: toRecord({
        entity_type: operation.entityType, entity_id: operation.entityId, schema_version: 1,
        revision: String(revision), data, deleted_at: deletedAt ? new Date(deletedAt) : null,
        updated_at: new Date(updatedAt), created_by_device_id: existing?.created_by_device_id ?? context.device.id,
        modified_by_device_id: context.device.id, cloud_pdf_generation: existing?.cloud_pdf_generation ?? '0',
      }),
    };
    preflight?.(candidate);
    await this.checkRetainedWritePlan(context, candidate, 'entity', operation);
    const result = await context.client.query<EntityRow>(`INSERT INTO paperquay.entities
      (account_id,entity_type,entity_id,schema_version,revision,data,deleted_at,updated_at,created_by_device_id,modified_by_device_id)
      VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$7,$8,$9)
      ON CONFLICT (account_id,entity_type,entity_id) DO UPDATE SET
        revision = EXCLUDED.revision, data = EXCLUDED.data, deleted_at = EXCLUDED.deleted_at,
        updated_at = EXCLUDED.updated_at, modified_by_device_id = EXCLUDED.modified_by_device_id
      RETURNING ${entityColumns}`, [context.account.id, operation.entityType, operation.entityId, revision,
      JSON.stringify(data), deletedAt, updatedAt, existing?.created_by_device_id ?? context.device.id, context.device.id]);
    if (!existing) {
      await context.client.query('UPDATE paperquay.accounts SET entity_count = entity_count + 1 WHERE id = $1', [context.account.id]);
      context.account.entity_count++;
    }
    const record = toRecord(result.rows[0]);
    await this.appendChange(context, record);
    return record;
  }

  private async makeConflict(context: TransactionContext, operation: SyncOperation, existing: EntityRow,
    preflight?: ResponsePreflight): Promise<PushResult> {
    if (BigInt(context.account.last_conflict_seq) >= BigInt(SERVER_LIMITS.maxAccountConflicts)) return rejected(operation.opId, 'ACCOUNT_CONFLICT_LIMIT');
    const conflictId = randomUUID();
    const record = toRecord(existing);
    const result: PushResult = { opId: operation.opId, status: 'conflict', replayed: false, conflictId, record };
    // Check the complete snapshot before advancing the sequence or inserting
    // either retained copy. Rollback cannot undo the database work itself.
    preflight?.(result);
    await this.checkRetainedWritePlan(context, result, 'conflict', operation);
    const incremented = await context.client.query<{ last_conflict_seq: string }>(`UPDATE paperquay.accounts
      SET last_conflict_seq = last_conflict_seq + 1 WHERE id = $1 RETURNING last_conflict_seq`, [context.account.id]);
    context.account.last_conflict_seq = incremented.rows[0].last_conflict_seq;
    await context.client.query(`INSERT INTO paperquay.conflicts
      (account_id,id,seq,entity_type,entity_id,attempted_operation,observed_record,created_by_device_id)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [context.account.id, conflictId,
      context.account.last_conflict_seq, operation.entityType, operation.entityId,
      JSON.stringify(operation), JSON.stringify(record), context.device.id]);
    return result;
  }

  private async validateReferences(context: TransactionContext, operation: SyncOperation): Promise<PushResult | undefined> {
    if (!operation.data || operation.mutation === 'delete' || operation.entityType === 'paper') return undefined;
    const data = operation.data;

    if(operation.entityType==='graphRelation'){
      for(const endpoint of [operation.data.source,operation.data.target]){
        const target=await this.entity(context,endpoint.entityType,endpoint.entityId);
        if(!target)return rejected(operation.opId,'DEPENDENCY_NOT_READY',true);
        if(target.deleted_at)return rejected(operation.opId,'REFERENCE_DELETED');
      }
      return undefined;
    }

    if ('paperId' in data && data.paperId) {
      const paper = await this.entity(context, 'paper', data.paperId);
      if (!paper) return rejected(operation.opId, 'DEPENDENCY_NOT_READY', true);
      // Notes survive removal of their bibliographic record and may still be edited.
      if (paper.deleted_at && operation.entityType !== 'note') return rejected(operation.opId, 'REFERENCE_DELETED');
    }
    if (operation.entityType === 'annotation' || operation.entityType === 'readingPosition' || operation.entityType==='aiConversation') {
      const location = operation.data;
      const attachment = await this.entity(context, 'attachmentVersion', location.attachmentVersionId);
      if (!attachment) return rejected(operation.opId, 'DEPENDENCY_NOT_READY', true);
      if (attachment.deleted_at) return rejected(operation.opId, 'REFERENCE_DELETED');
      const version = attachment.data as AttachmentVersionData;
      if (version.paperId !== location.paperId) return rejected(operation.opId, 'REFERENCE_MISMATCH');
      if(operation.entityType==='aiConversation'){
        if(version.sha256!==operation.data.sha256||version.pageCount!==null&&version.pageCount!==operation.data.context.totalPages)return rejected(operation.opId,'IMMUTABLE_VERSION_BINDING');
        return undefined;
      }
      const page = operation.entityType === 'annotation' ? operation.data.anchor.pageIndex : operation.data.pageIndex;
      const furthest = operation.entityType === 'readingPosition' ? operation.data.furthestPageIndex : page;
      if (version.pageCount !== null && (page >= version.pageCount || furthest >= version.pageCount)) return rejected(operation.opId, 'PAGE_OUT_OF_RANGE');
      if (operation.entityType === 'readingPosition'
        && (operation.data.pageIndex > operation.data.furthestPageIndex
          || (operation.data.pageIndex === operation.data.furthestPageIndex && operation.data.offsetRatio > operation.data.furthestOffsetRatio))) {
        return rejected(operation.opId, 'INVALID_READING_POSITION');
      }
    }
    return undefined;
  }

  private async applyMutation(context: TransactionContext, operation: SyncOperation, preflight?: ResponsePreflight,features:SyncFeatureSet=LEGACY_SYNC_FEATURES): Promise<PushResult> {
    const existing = await this.entity(context, operation.entityType, operation.entityId);
    if(!supportsSyncRecord(features,operation)||existing&&!supportsSyncRecord(features,{entityType:existing.entity_type,data:existing.data}))return rejected(operation.opId,'FEATURE_NOT_NEGOTIATED');
    if(existing?.entity_type==='note'&&'format'in existing.data&&existing.data.format==='tiptap-json'&&operation.mutation!=='delete'&&operation.data&&'format'in operation.data&&operation.data.format!=='tiptap-json')return rejected(operation.opId,'RICH_NOTE_DOWNGRADE_FORBIDDEN');
    if (existing && operation.entityType === 'readingPosition' && existing.created_by_device_id !== context.device.id) {
      return rejected(operation.opId, 'CHECKPOINT_DEVICE_MISMATCH');
    }
    if (!existing && (operation.baseRevision !== 0 || operation.mutation !== 'put')) return rejected(operation.opId, 'ENTITY_NOT_FOUND');
    if (existing && operation.baseRevision !== Number(existing.revision)) return this.makeConflict(context, operation, existing, preflight);
    if (existing?.deleted_at && operation.mutation === 'put') return rejected(operation.opId, 'RESTORE_REQUIRED');
    if (existing && !existing.deleted_at && operation.mutation === 'restore') return rejected(operation.opId, 'ENTITY_NOT_DELETED');
    if (existing && operation.entityType === 'paper' && operation.data
      && operation.mutation !== 'delete' && operation.data.organization === undefined) {
      // M1 clients cannot represent organization. Their bibliographic edits
      // must not erase it; M2 clears it by explicitly sending empty defaults.
      const organization = (existing.data as PaperData).organization;
      if (organization) operation = { ...operation, data: { ...operation.data, organization } };
    }
    if (operation.data && Buffer.byteLength(JSON.stringify(operation.data)) > SERVER_LIMITS.entityLimitBytes) return rejected(operation.opId, 'ENTITY_TOO_LARGE');
    if (BigInt(context.account.last_seq) >= BigInt(SERVER_LIMITS.maxAccountChanges)) return rejected(operation.opId, 'ACCOUNT_CHANGE_LIMIT');
    if (!existing && context.account.entity_count >= SERVER_LIMITS.maxAccountEntities) return rejected(operation.opId, 'ACCOUNT_ENTITY_LIMIT');
    if (existing && Number(existing.revision) >= Number.MAX_SAFE_INTEGER) return rejected(operation.opId, 'REVISION_LIMIT');
    if (existing && operation.data && operation.mutation !== 'delete') {
      const before = existing.data as unknown as Record<string, unknown>;
      const after = operation.data as unknown as Record<string, unknown>;
      const immutable = operation.entityType === 'attachmentVersion'
        ? ['paperId', 'attachmentId', 'sha256', 'sizeBytes', 'mediaType']
        : (operation.entityType === 'annotation' || operation.entityType === 'readingPosition') ? ['paperId', 'attachmentVersionId'] : [];
      if (immutable.some((field) => before[field] !== after[field])) return rejected(operation.opId, 'IMMUTABLE_VERSION_BINDING');
      if(operation.entityType==='graphRelation'&&['source','target','relationType','createdAt'].some(field=>canonicalJson(before[field])!==canonicalJson(after[field])))return rejected(operation.opId,'IMMUTABLE_GRAPH_BINDING');
      if(operation.entityType==='aiConversation'&&canonicalJson(before.context)!==canonicalJson(after.context))return rejected(operation.opId,'IMMUTABLE_AI_SOURCE');
      if (operation.entityType === 'attachmentVersion' && before.pageCount !== null && before.pageCount !== after.pageCount) return rejected(operation.opId, 'IMMUTABLE_VERSION_BINDING');
      if (operation.entityType === 'readingPosition') {
        const previous = existing.data as ReadingPositionData;
        const next = operation.data;
        if (next.deviceSequence <= previous.deviceSequence) return rejected(operation.opId, 'STALE_DEVICE_SEQUENCE');
        if (next.furthestPageIndex < previous.furthestPageIndex
          || (next.furthestPageIndex === previous.furthestPageIndex && next.furthestOffsetRatio < previous.furthestOffsetRatio)) {
          return rejected(operation.opId, 'READING_PROGRESS_REGRESSION');
        }
      }
    }
    const invalidReference = await this.validateReferences(context, operation);
    if (invalidReference) return invalidReference;

    if(operation.entityType==='graphRelation'&&operation.mutation!=='delete'&&operation.data){
      // withAccount serializes writes, including concurrent creates/restores.
      // Deleted row copies remain covered by the account retained-byte quota.
      const totals=await context.client.query<{count:string;bytes:string}>(
        "SELECT count(*) AS count, COALESCE(sum(octet_length(data::text)),0) AS bytes FROM paperquay.entities WHERE account_id=$1 AND entity_type='graphRelation' AND deleted_at IS NULL AND entity_id<>$2",
        [context.account.id,operation.entityId]);
      if(Number(totals.rows[0].count)>=GRAPH_RELATION_LIMITS.relations)return rejected(operation.opId,'GRAPH_COLLECTION_LIMIT');
      const size=await context.client.query<{bytes:number}>('SELECT octet_length($1::jsonb::text) AS bytes',[JSON.stringify(operation.data)]);
      if(Number(totals.rows[0].bytes)+Number(size.rows[0].bytes)>GRAPH_RELATION_LIMITS.accountBytes)return rejected(operation.opId,'GRAPH_COLLECTION_LIMIT');
    }

    if((operation.entityType==='aiConversation'||operation.entityType==='aiTemplate')&&operation.mutation!=='delete'&&(!existing||existing.deleted_at)){
      const count=await context.client.query<{count:string}>(`SELECT count(*) FROM paperquay.entities WHERE account_id=$1 AND entity_type=$2 AND deleted_at IS NULL`,[context.account.id,operation.entityType]);
      if(Number(count.rows[0].count)>=(operation.entityType==='aiConversation'?50:100))return rejected(operation.opId,'AI_COLLECTION_LIMIT');
    }
    if (!existing && operation.entityType === 'readingPosition' && operation.data) {
      const duplicate = await context.client.query(`SELECT 1 FROM paperquay.entities
        WHERE account_id = $1 AND entity_type = 'readingPosition' AND created_by_device_id = $2
          AND data ->> 'attachmentVersionId' = $3`, [context.account.id, context.device.id, operation.data.attachmentVersionId]);
      if (duplicate.rowCount) return rejected(operation.opId, 'CHECKPOINT_ALREADY_EXISTS');
    }
    if (operation.mutation === 'delete' && existing?.deleted_at) {
      return { opId: operation.opId, status: 'applied', replayed: false, record: toRecord(existing) };
    }
    const data = operation.mutation === 'delete' ? existing!.data : operation.data!;
    const record = await this.saveEntity(context, operation, existing, data,
      operation.mutation === 'delete' ? new Date().toISOString() : null, preflight);
    return { opId: operation.opId, status: 'applied', replayed: false, record };
  }

  async push(identity: VerifiedIdentity, request: PushRequest,features:SyncFeatureSet=LEGACY_SYNC_FEATURES): Promise<PushResponse> {
    if (!validatePushRequest(request).ok) throw new ApiError('VALIDATION_FAILED');
    const results: PushResult[] = [];
    // Leave room for the envelope and small retryable results for every remaining
    // operation. A tiny stale-delete request can otherwise return many large
    // current documents as conflict snapshots.
    const recordBudget = this.responseLimitBytes - 1024 - request.operations.length * 256;
    let responseBytes = 0;
    let responseBudgetExhausted = false;
    let storageLimited = false;
    const checkResponseBudget: ResponsePreflight = (result) => {
      if (responseBytes + Buffer.byteLength(JSON.stringify(result)) > recordBudget) throw new ResponseBudgetExceeded();
    };
    for (const operation of request.operations) {
      if (responseBudgetExhausted) {
        // Preserve every opId in order without another transaction or snapshot
        // read after the first result that cannot fit this response.
        results.push(rejected(operation.opId, 'RESPONSE_LIMIT_REACHED', true));
        continue;
      }
      try {
        const result = await this.withAccount(identity, false, async (context) => {
          if (context.device.id !== request.deviceId) throw new ApiError('DEVICE_SESSION_MISMATCH', 403);
          if(!supportsSyncRecord(features,operation))return rejected(operation.opId,'FEATURE_NOT_NEGOTIATED');
          const hash = operationHash({ kind: 'push', operation });
          const previous = await this.receipt(context, operation.opId, hash);
          if(previous?.record&&!supportsSyncRecord(features,previous.record))return rejected(operation.opId,'FEATURE_NOT_NEGOTIATED');
          if (!previous && !storageLimited && context.account.receipt_count >= SERVER_LIMITS.maxAccountReceipts) {
            const result = rejected(operation.opId, 'ACCOUNT_RECEIPT_LIMIT');
            checkResponseBudget(result);
            return result;
          }
          if (!previous && !storageLimited) this.requireStorageHeadroom(context);
          // After one quota failure, only replay existing receipts in this batch.
          // New operations must not repeat large reads or rolled-back writes.
          const result = previous ?? (storageLimited
            ? rejected(operation.opId, 'ACCOUNT_STORAGE_LIMIT', true)
            : await this.applyMutation(context, operation, checkResponseBudget,features));
          // Replays and small rejections also need a check. For mutations this
          // rechecks the actual database result against the same budget.
          checkResponseBudget(result);
          if (!previous) await this.remember(context, hash, result);
          await this.hooks.beforeCommit?.({ kind: 'push', opId: operation.opId, accountId: context.account.id, deviceId: context.device.id });
          return result;
        });
        responseBytes += Buffer.byteLength(JSON.stringify(result));
        results.push(result);
      } catch (error) {
        if (isAccountStorageLimit(error)) {
          storageLimited = true;
          results.push(rejected(operation.opId, 'ACCOUNT_STORAGE_LIMIT', true));
        }
        else if (error instanceof ResponseBudgetExceeded) {
          responseBudgetExhausted = true;
          results.push(rejected(operation.opId, 'RESPONSE_LIMIT_REACHED', true));
        }
        else if (isTransientDatabaseError(error)) results.push(rejected(operation.opId, 'SERVICE_TEMPORARILY_UNAVAILABLE', true));
        else throw error;
      }
    }
    return { protocolVersion: 1, results };
  }

  async pull(identity: VerifiedIdentity, cursor: string | undefined, limit: number): Promise<PullResponse> {
    return this.withAccount(identity, false, async ({ client, account }) => {
      const sequence = this.cursors.decode(cursor, 'changes', account.id, account.epoch);
      if (sequence > BigInt(account.last_seq)) throw new ApiError('CURSOR_INVALID');
      const result = await client.query<{ seq: string; record: SyncRecord }>(`WITH candidates AS MATERIALIZED (
        SELECT seq, octet_length(record::text) AS bytes FROM paperquay.changes
        WHERE account_id = $1 AND seq > $2 ORDER BY seq LIMIT $3
      ), budgeted AS (
        SELECT seq, sum(bytes) OVER (ORDER BY seq) AS running_bytes FROM candidates
      ) SELECT change.seq, change.record FROM budgeted
        JOIN paperquay.changes AS change ON change.account_id = $1 AND change.seq = budgeted.seq
        WHERE running_bytes <= $4 ORDER BY change.seq`,
      [account.id, sequence.toString(), limit, this.responseLimitBytes - 2048]);
      if (!result.rows.length && sequence < BigInt(account.last_seq)) throw new ApiError('RESPONSE_RECORD_TOO_LARGE', 503);
      const last = result.rows.at(-1)?.seq ?? sequence.toString();
      return {
        protocolVersion: 1, records: result.rows.map((row) => row.record),
        nextCursor: this.cursors.encode('changes', account.id, account.epoch, last),
        hasMore: BigInt(last) < BigInt(account.last_seq),
      };
    });
  }

  async listConflicts(identity: VerifiedIdentity, cursor: string | undefined, limit: number): Promise<ConflictPage> {
    return this.withAccount(identity, false, async (context) => {
      const { client, account } = context;
      const sequence = this.cursors.decode(cursor, 'conflicts', account.id, account.epoch);
      if (sequence > BigInt(account.last_conflict_seq)) throw new ApiError('CURSOR_INVALID');
      // Budget IDs before loading JSON into the application. In particular, a
      // page of 100 conflicts can contain three large document snapshots each.
      const eligible = await client.query<{ id: string; seq: string }>(`WITH candidates AS MATERIALIZED (
        SELECT conflict.id, conflict.seq,
          octet_length(conflict.attempted_operation::text) + octet_length(conflict.observed_record::text)
          + CASE WHEN entity.deleted_at IS NULL THEN octet_length(entity.data::text) ELSE 4 END + 1024 AS bytes
        FROM paperquay.conflicts AS conflict JOIN paperquay.entities AS entity
          ON entity.account_id = conflict.account_id AND entity.entity_type = conflict.entity_type AND entity.entity_id = conflict.entity_id
        WHERE conflict.account_id = $1 AND conflict.seq > $2 AND conflict.resolved_at IS NULL ORDER BY conflict.seq LIMIT $3
      ), budgeted AS (
        SELECT id, seq, sum(bytes) OVER (ORDER BY seq) AS running_bytes FROM candidates
      ) SELECT id, seq FROM budgeted WHERE running_bytes <= $4 ORDER BY seq`,
      [account.id, sequence.toString(), limit, this.responseLimitBytes - 2048]);
      const lastEligible = eligible.rows.at(-1)?.seq ?? sequence.toString();
      const remaining = await client.query<{ more: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM paperquay.conflicts WHERE account_id = $1 AND seq > $2 AND resolved_at IS NULL
      ) AS more`, [account.id, lastEligible]);
      if (!eligible.rows.length && remaining.rows[0].more) throw new ApiError('RESPONSE_RECORD_TOO_LARGE', 503);
      const result = await client.query<ConflictRow>(`SELECT id,seq,entity_type,entity_id,attempted_operation,observed_record,created_at,resolved_at
        FROM paperquay.conflicts WHERE account_id = $1 AND id = ANY($2::uuid[]) ORDER BY seq`,
      [account.id, eligible.rows.map((row) => row.id)]);
      const page = result.rows;
      const conflicts = [];
      let bytes = 0;
      for (const row of page) {
        const current = await this.entity(context, row.entity_type, row.entity_id);
        if (!current) throw new ApiError('STORAGE_INVARIANT_FAILED', 500);
        const value = { conflictId: row.id, entityType: row.entity_type, entityId: row.entity_id,
          createdAt: row.created_at.toISOString(), attemptedOperation: row.attempted_operation,
          observedRecord: row.observed_record, currentRecord: toRecord(current) };
        const nextBytes = bytes + Buffer.byteLength(JSON.stringify(value));
        if (nextBytes > this.responseLimitBytes - 2048) {
          if (!conflicts.length) throw new ApiError('RESPONSE_RECORD_TOO_LARGE', 503);
          break;
        }
        bytes = nextBytes;
        conflicts.push(value);
      }
      const last = page[conflicts.length - 1]?.seq ?? sequence.toString();
      return {
        conflicts, nextCursor: this.cursors.encode('conflicts', account.id, account.epoch, last),
        hasMore: remaining.rows[0].more || result.rows.length > conflicts.length,
      };
    });
  }

  async resolveConflict(identity: VerifiedIdentity, conflictId: string, request: ResolveRequest,features:SyncFeatureSet=LEGACY_SYNC_FEATURES): Promise<PushResult> {
    try {
      return await this.withAccount(identity, false, async (context) => {
        const hash = operationHash({ kind: 'resolve', conflictId, request });
        const previous = await this.receipt(context, request.opId, hash);
        if (previous) return previous.record&&!supportsSyncRecord(features,previous.record)?rejected(request.opId,'FEATURE_NOT_NEGOTIATED'):previous;
        if (context.account.receipt_count >= SERVER_LIMITS.maxAccountReceipts) return rejected(request.opId, 'ACCOUNT_RECEIPT_LIMIT');
        this.requireStorageHeadroom(context);
        const found = await context.client.query<ConflictRow>(`SELECT id,seq,entity_type,entity_id,attempted_operation,observed_record,created_at,resolved_at
          FROM paperquay.conflicts WHERE account_id = $1 AND id = $2`, [context.account.id, conflictId]);
        const conflict = found.rows[0];
        if (!conflict) throw new ApiError('NOT_FOUND', 404);
        if (conflict.resolved_at) return this.remember(context, hash, rejected(request.opId, 'CONFLICT_ALREADY_RESOLVED'));
        const current = await this.entity(context, conflict.entity_type, conflict.entity_id);
        if (!current) throw new ApiError('STORAGE_INVARIANT_FAILED', 500);
        if(!supportsSyncRecord(features,conflict.attempted_operation)||!supportsSyncRecord(features,{entityType:current.entity_type,data:current.data}))return rejected(request.opId,'FEATURE_NOT_NEGOTIATED');
        if (Number(current.revision) !== request.expectedRevision) {
          return this.remember(context, hash, { opId: request.opId, status: 'conflict', replayed: false,
            conflictId, record: toRecord(current) });
        }
        let result: PushResult;
        if (request.choice === 'current') {
          if (BigInt(context.account.last_seq) >= BigInt(SERVER_LIMITS.maxAccountChanges)) return this.remember(context, hash, rejected(request.opId, 'ACCOUNT_CHANGE_LIMIT'));
          const record = toRecord(current);
          // An explicit keep-current decision records a feed receipt without editing another
          // device's checkpoint or resurrecting a tombstone. Its entity revision stays unchanged.
          result = { opId: request.opId, status: 'applied', replayed: false, record };
          await this.checkRetainedWritePlan(context, result, 'change');
          await this.appendChange(context, record);
        } else {
          const operation = {
            ...conflict.attempted_operation, opId: request.opId, baseRevision: request.expectedRevision,
            ...(request.choice === 'merged' ? { mutation: request.mutation, data: request.data } : {}),
            clientCreatedAt: new Date().toISOString(),
          } as SyncOperation;
          if (!validateOperation(operation).ok) return this.remember(context, hash, rejected(request.opId, 'VALIDATION_FAILED'));
          result = await this.applyMutation(context, operation,undefined,features);
        }
        if (result.status === 'applied') {
          // An already-deleted no-op still closes the conflict and needs its
          // receipt budget checked before that row's UPDATE trigger runs.
          if (context.preflightedReceiptOpId !== result.opId) {
            await this.checkRetainedWritePlan(context, result, 'receipt');
          }
          await context.client.query('UPDATE paperquay.conflicts SET resolved_at = clock_timestamp(), resolution_op_id = $3 WHERE account_id = $1 AND id = $2',
            [context.account.id, conflictId, request.opId]);
        }
        await this.remember(context, hash, result);
        await this.hooks.beforeCommit?.({ kind: 'resolve', opId: request.opId, accountId: context.account.id, deviceId: context.device.id });
        return result;
      });
    } catch (error) {
      if (isAccountStorageLimit(error)) return rejected(request.opId, 'ACCOUNT_STORAGE_LIMIT', true);
      if (isTransientDatabaseError(error)) return rejected(request.opId, 'SERVICE_TEMPORARILY_UNAVAILABLE', true);
      throw error;
    }
  }
}
