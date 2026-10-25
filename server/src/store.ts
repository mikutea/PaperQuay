import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import {
  validateOperation, validatePushRequest,
} from '../../packages/sync-core/src/index.ts';
import type {
  AttachmentVersionData, EntityData, EntityType, PullResponse, PushRequest, PushResponse,
  PushResult, ReadingPositionData, SyncOperation, SyncRecord,
} from '../../packages/sync-core/src/index.ts';
import type { VerifiedIdentity } from './auth.ts';
import { CursorCodec } from './cursor.ts';
import { ApiError, isTransientDatabaseError } from './errors.ts';
import { checkedRetainedByteLimit, SERVER_LIMITS } from './config.ts';
import type { ConflictPage, Device, DevicePlatform, DeviceRegistration, ResolveRequest, SessionView, SyncRepository } from './types.ts';

interface AccountRow {
  id: string; epoch: string; last_seq: string; last_conflict_seq: string; entity_count: number; receipt_count: number; retained_bytes: string;
}
interface DeviceRow {
  id: string; name: string; platform: DevicePlatform; created_at: Date; last_seen_at: Date; revoked_at: Date | null;
}
interface EntityRow {
  entity_type: EntityType; entity_id: string; schema_version: 1; revision: string;
  data: EntityData; deleted_at: Date | null; updated_at: Date;
  created_by_device_id: string; modified_by_device_id: string;
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
type ResponsePreflight = (result: PushResult) => void;
type RetainedWriteKind = 'entity' | 'conflict' | 'change' | 'receipt';
interface StoreHooks {
  /** Fault/concurrency injection for isolated integration tests, never configured from HTTP or environment. */
  beforeCommit?: (event: { kind: 'push' | 'resolve' | 'revoke'; opId?: string; accountId: string; deviceId: string }) => Promise<void>;
}
interface StoreOptions {
  connectionString?: string;
  pool?: pg.Pool;
  cursorSecret: Uint8Array;
  hooks?: StoreHooks;
  responseLimitBytes?: number;
  maxAccountRetainedBytes?: number;
}

class ResponseBudgetExceeded extends Error {}
class AccountStorageLimitExceeded extends Error {}

function isAccountStorageLimit(error: unknown): boolean {
  if (error instanceof AccountStorageLimitExceeded) return true;
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23514'
    && 'constraint' in error && error.constraint === 'paperquay_account_retained_bytes_limit';
}

const entityColumns = 'entity_type, entity_id, schema_version, revision, data, deleted_at, updated_at, created_by_device_id, modified_by_device_id';
const deviceColumns = 'id, name, platform, created_at, last_seen_at, revoked_at';

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
export class PostgresSyncStore implements SyncRepository {
  readonly pool: pg.Pool;
  readonly cursors: CursorCodec;
  readonly hooks: StoreHooks;
  readonly responseLimitBytes: number;
  readonly maxAccountRetainedBytes: number;
  private readonly ownsPool: boolean;

  constructor(options: StoreOptions) {
    this.maxAccountRetainedBytes = checkedRetainedByteLimit(options.maxAccountRetainedBytes ?? SERVER_LIMITS.maxAccountRetainedBytes);
    this.ownsPool = !options.pool;
    const poolOptions: PoolConfig = {
      connectionString: options.connectionString, max: 10, connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000, application_name: 'paperquay-sync',
    };
    this.pool = options.pool ?? new pg.Pool(poolOptions);
    // A disconnected idle client must not crash the server or print driver errors/credentials.
    this.pool.on('error', () => undefined);
    this.cursors = new CursorCodec(options.cursorSecret);
    this.hooks = options.hooks ?? {};
    this.responseLimitBytes = options.responseLimitBytes ?? SERVER_LIMITS.responseLimitBytes;
  }

  async close(): Promise<void> { if (this.ownsPool) await this.pool.end(); }

  async ready(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ version: string }>('SELECT version FROM paperquay.schema_migrations ORDER BY version');
      return result.rows.map((row) => row.version).join(',') === '001_initial.sql,002_receipt_quota.sql,003_retained_bytes_quota.sql';
    } catch { return false; }
  }

  private async withAccount<T>(identity: VerifiedIdentity, create: boolean,
    action: (context: TransactionContext) => Promise<T>, requireDevice = true): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SELECT set_config('paperquay.issuer', $1, true), set_config('paperquay.subject', $2, true)", [identity.issuer, identity.subject]);
      await client.query("SELECT set_config('paperquay.retained_byte_limit', $1, true)", [String(this.maxAccountRetainedBytes)]);
      if (create) {
        await client.query(`INSERT INTO paperquay.accounts(id, issuer, subject, epoch)
          VALUES ($1,$2,$3,$4) ON CONFLICT (issuer, subject) DO NOTHING`, [randomUUID(), identity.issuer, identity.subject, randomUUID()]);
      }
      const accounts = await client.query<AccountRow>(`SELECT id, epoch, last_seq, last_conflict_seq, entity_count, receipt_count, retained_bytes
        FROM paperquay.accounts WHERE issuer = $1 AND subject = $2 FOR UPDATE`, [identity.issuer, identity.subject]);
      const account = accounts.rows[0];
      if (!account) throw new ApiError('DEVICE_NOT_REGISTERED', 403);
      await client.query("SELECT set_config('paperquay.account_id', $1, true)", [account.id]);
      let device: DeviceRow | undefined;
      if (requireDevice) {
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
        modified_by_device_id: context.device.id,
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
    if ('paperId' in data && data.paperId) {
      const paper = await this.entity(context, 'paper', data.paperId);
      if (!paper) return rejected(operation.opId, 'DEPENDENCY_NOT_READY', true);
      // Notes survive removal of their bibliographic record and may still be edited.
      if (paper.deleted_at && operation.entityType !== 'note') return rejected(operation.opId, 'REFERENCE_DELETED');
    }
    if (operation.entityType === 'annotation' || operation.entityType === 'readingPosition') {
      const location = operation.data;
      const attachment = await this.entity(context, 'attachmentVersion', location.attachmentVersionId);
      if (!attachment) return rejected(operation.opId, 'DEPENDENCY_NOT_READY', true);
      if (attachment.deleted_at) return rejected(operation.opId, 'REFERENCE_DELETED');
      const version = attachment.data as AttachmentVersionData;
      if (version.paperId !== location.paperId) return rejected(operation.opId, 'REFERENCE_MISMATCH');
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

  private async applyMutation(context: TransactionContext, operation: SyncOperation, preflight?: ResponsePreflight): Promise<PushResult> {
    const existing = await this.entity(context, operation.entityType, operation.entityId);
    if (existing && operation.entityType === 'readingPosition' && existing.created_by_device_id !== context.device.id) {
      return rejected(operation.opId, 'CHECKPOINT_DEVICE_MISMATCH');
    }
    if (!existing && (operation.baseRevision !== 0 || operation.mutation !== 'put')) return rejected(operation.opId, 'ENTITY_NOT_FOUND');
    if (existing && operation.baseRevision !== Number(existing.revision)) return this.makeConflict(context, operation, existing, preflight);
    if (existing?.deleted_at && operation.mutation === 'put') return rejected(operation.opId, 'RESTORE_REQUIRED');
    if (existing && !existing.deleted_at && operation.mutation === 'restore') return rejected(operation.opId, 'ENTITY_NOT_DELETED');
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

  async push(identity: VerifiedIdentity, request: PushRequest): Promise<PushResponse> {
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
          const hash = operationHash({ kind: 'push', operation });
          const previous = await this.receipt(context, operation.opId, hash);
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
            : await this.applyMutation(context, operation, checkResponseBudget));
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

  async resolveConflict(identity: VerifiedIdentity, conflictId: string, request: ResolveRequest): Promise<PushResult> {
    try {
      return await this.withAccount(identity, false, async (context) => {
        const hash = operationHash({ kind: 'resolve', conflictId, request });
        const previous = await this.receipt(context, request.opId, hash);
        if (previous) return previous;
        if (context.account.receipt_count >= SERVER_LIMITS.maxAccountReceipts) return rejected(request.opId, 'ACCOUNT_RECEIPT_LIMIT');
        this.requireStorageHeadroom(context);
        const found = await context.client.query<ConflictRow>(`SELECT id,seq,entity_type,entity_id,attempted_operation,observed_record,created_at,resolved_at
          FROM paperquay.conflicts WHERE account_id = $1 AND id = $2`, [context.account.id, conflictId]);
        const conflict = found.rows[0];
        if (!conflict) throw new ApiError('NOT_FOUND', 404);
        if (conflict.resolved_at) return this.remember(context, hash, rejected(request.opId, 'CONFLICT_ALREADY_RESOLVED'));
        const current = await this.entity(context, conflict.entity_type, conflict.entity_id);
        if (!current) throw new ApiError('STORAGE_INVARIANT_FAILED', 500);
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
          result = await this.applyMutation(context, operation);
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
