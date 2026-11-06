import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VerifiedIdentity } from './auth.ts';
import { ApiError } from './errors.ts';
import { UUID_PATTERN } from '../../packages/sync-core/src/index.ts';

export interface AccountPrivacyStatus {
  accountId: string;
  state: 'active' | 'closed';
  closedAt: string | null;
  closureRequestId: string | null;
  deviceErasure: { requested: boolean; pending: number; acknowledged: number; thisDevicePending: boolean };
}
export interface AccountClosureRequest {
  accountId: string;
  requestId: string;
  confirmation: string;
  deleteCloudCopies: true;
  eraseDevices: boolean;
}
interface PrivacyAccount {
  id: string;
  closed_at: Date | null;
  closure_request_id: string | null;
  erase_devices_requested: boolean;
}
export interface PrivacyContext { client: PoolClient; account: PrivacyAccount; device: { id: string } }
export interface AccountPrivacyRepository {
  status(identity: VerifiedIdentity): Promise<AccountPrivacyStatus>;
  close(identity: VerifiedIdentity, request: AccountClosureRequest): Promise<AccountPrivacyStatus>;
  acknowledgeErasure(identity: VerifiedIdentity, deviceId: string): Promise<{ acknowledged: true }>;
  exportData(identity: VerifiedIdentity, signal: AbortSignal): AsyncIterable<Buffer>;
}
interface Options {
  pool: Pool;
  withAccount<T>(identity: VerifiedIdentity, action: (context: PrivacyContext) => Promise<T>): Promise<T>;
  checkAccess(identity: VerifiedIdentity): Promise<unknown>;
  beforeCloseCommit?(context: PrivacyContext): Promise<void>;
}

const tables = ['accounts', 'devices', 'entities', 'changes', 'operation_receipts', 'conflicts',
  'cloud_pdfs', 'remote_task_providers', 'remote_tasks', 'remote_task_requests', 'remote_task_artifacts',
  'model_inference_providers', 'model_inference_jobs', 'remote_retrieval_requests', 'account_erasure_devices'] as const;
const files = [
  { table: 'cloud_pdfs', id: 'attachment_version_id', digest: 'sha256' },
  { table: 'remote_task_artifacts', id: 'job_id', digest: 'digest' },
] as const;
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

function currentToken(identity: VerifiedIdentity) {
  if (identity.expiresAtMs !== undefined && identity.expiresAtMs <= Date.now()) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
}
function recentAuthentication(identity: VerifiedIdentity) {
  currentToken(identity);
  const time = identity.authenticatedAtMs;
  if (!Number.isSafeInteger(time) || time! > Date.now() + 5000 || time! < Date.now() - 5 * 60_000) {
    throw new ApiError('RECENT_AUTHENTICATION_REQUIRED', 401);
  }
}

export function createAccountPrivacyRepository(options: Options): AccountPrivacyRepository {
  async function status(context: PrivacyContext, identity: VerifiedIdentity): Promise<AccountPrivacyStatus> {
    const row = await context.client.query<PrivacyAccount>(
      'SELECT id,closed_at,closure_request_id,erase_devices_requested FROM paperquay.accounts WHERE id=$1', [context.account.id]);
    const account = row.rows[0];
    const pending = await context.client.query<{ pending: string; acknowledged: string; mine: boolean }>(
      `SELECT count(*) FILTER(WHERE acknowledged_at IS NULL) AS pending,
        count(*) FILTER(WHERE acknowledged_at IS NOT NULL) AS acknowledged,
        coalesce(bool_or(acknowledged_at IS NULL AND session_hash=$2),false) AS mine
        FROM paperquay.account_erasure_devices WHERE account_id=$1`,
      [account.id, createHash('sha256').update(identity.sessionId).digest()]);
    return { accountId: account.id, state: account.closed_at ? 'closed' : 'active',
      closedAt: account.closed_at?.toISOString() ?? null, closureRequestId: account.closure_request_id,
      deviceErasure: { requested: account.erase_devices_requested, pending: Number(pending.rows[0].pending),
        acknowledged: Number(pending.rows[0].acknowledged), thisDevicePending: pending.rows[0].mine } };
  }
  return {
    status: identity => options.withAccount(identity, context => status(context, identity)),
    close: (identity, request) => options.withAccount(identity, async context => {
      if (request.accountId !== context.account.id || request.confirmation !== '注销 ' + context.account.id
        || request.deleteCloudCopies !== true || typeof request.eraseDevices !== 'boolean'
        || !new RegExp('^' + UUID_PATTERN + '$').test(request.requestId)) throw new ApiError('VALIDATION_FAILED', 400);
      if (context.account.closed_at) {
        if (context.account.closure_request_id !== request.requestId
          || context.account.erase_devices_requested !== request.eraseDevices) throw new ApiError('ACCOUNT_ALREADY_CLOSED', 409);
        return status(context, identity);
      }
      recentAuthentication(identity);
      await context.client.query('SELECT paperquay.erase_account($1,$2,$3,$4)',
        [context.account.id, request.requestId, identity.sessionId, request.eraseDevices]);
      await options.beforeCloseCommit?.(context);
      return status(context, identity);
    }),
    acknowledgeErasure: (identity, deviceId) => options.withAccount(identity, async context => {
      if (!context.account.closed_at || !context.account.erase_devices_requested) throw new ApiError('ERASURE_NOT_REQUESTED', 409);
      const result = await context.client.query<{ acknowledged: boolean }>(
        'SELECT paperquay.acknowledge_account_erasure($1,$2,$3) AS acknowledged', [context.account.id, deviceId, identity.sessionId]);
      if (!result.rows[0].acknowledged) throw new ApiError('ERASURE_SESSION_MISMATCH', 403);
      return { acknowledged: true };
    }),
    async *exportData(identity, signal) {
      let client: PoolClient | undefined;
      const hash = createHash('sha256');
      const started = Date.now();
      let nextCheck = 0, records = 0, fileCount = 0, totalBytes = 0;
      const line = (value: unknown) => { const bytes = Buffer.from(JSON.stringify(value) + '\n'); hash.update(bytes); return bytes; };
      const guard = async () => {
        if (signal.aborted) throw new ApiError('EXPORT_CANCELLED', 409);
        currentToken(identity);
        if (Date.now() - started > 15 * 60_000) throw new ApiError('EXPORT_TIME_LIMIT', 409);
        if (Date.now() >= nextCheck) { await options.checkAccess(identity); nextCheck = Date.now() + 1000; }
      };
      try {
        await guard();
        client = await options.pool.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout='15s'");
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SELECT set_config('paperquay.issuer',$1,true),set_config('paperquay.subject',$2,true)", [identity.issuer, identity.subject]);
        const accounts = await client.query<PrivacyAccount>('SELECT id,closed_at,closure_request_id,erase_devices_requested FROM paperquay.accounts WHERE issuer=$1 AND subject=$2',
          [identity.issuer, identity.subject]);
        const account = accounts.rows[0];
        if (!account || account.closed_at) throw new ApiError('ACCOUNT_CLOSED', 410);
        await client.query("SELECT set_config('paperquay.account_id',$1,true)", [account.id]);
        const device = await client.query('SELECT id FROM paperquay.devices WHERE account_id=$1 AND session_id=$2 AND revoked_at IS NULL', [account.id, identity.sessionId]);
        if (!device.rows.length) throw new ApiError('SESSION_REVOKED', 403);
        yield line({ kind: 'header', format: 'paperquay-personal-data', version: 1, accountId: account.id,
          exportedAt: new Date().toISOString(), consistency: 'repeatable-read', scope: 'application-server',
          excludes: ['identity-provider credentials', 'operator backups', 'other devices local-only data'] });
        for (const table of tables) {
          await guard();
          const columns = await client.query<{ name: string; binary: boolean }>(
            `SELECT attname AS name,atttypid='bytea'::regtype AS binary FROM pg_attribute
             WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, ['paperquay.' + table]);
          const binary = columns.rows.filter(column => column.binary);
          if (!columns.rows.length || binary.some(column => column.name !== 'content' || !files.some(file => file.table === table))) {
            throw new ApiError('EXPORT_SCHEMA_UNSUPPORTED', 409);
          }
          const names = columns.rows.filter(column => !column.binary).map(column => identifier(column.name)).join(',');
          const query = `SELECT to_jsonb(exported) AS data FROM (SELECT ${names} FROM paperquay.${identifier(table)}
            WHERE ${table === 'accounts' ? 'id' : 'account_id'}=$1) AS exported`;
          await client.query('DECLARE privacy_rows NO SCROLL CURSOR FOR ' + query, [account.id]);
          try {
            for (;;) {
              await guard();
              const row = await client.query<{ data: unknown }>('FETCH FORWARD 1 FROM privacy_rows');
              if (!row.rows.length) break;
              const bytes = line({ kind: 'record', table, data: row.rows[0].data });
              if (bytes.byteLength > 8 * 1024 * 1024) throw new ApiError('EXPORT_ROW_LIMIT', 409);
              records++; yield bytes;
            }
          } finally { await client.query('CLOSE privacy_rows'); }
        }
        for (const file of files) {
          await client.query(`DECLARE privacy_files NO SCROLL CURSOR FOR SELECT ${identifier(file.id)} AS id,
            size_bytes,${identifier(file.digest)} AS digest FROM paperquay.${identifier(file.table)} WHERE account_id=$1`, [account.id]);
          try {
            for (;;) {
              await guard();
              const page = await client.query<{ id: string; size_bytes: number; digest: string }>('FETCH FORWARD 1 FROM privacy_files');
              const item = page.rows[0]; if (!item) break;
              const contentHash = createHash('sha256');
              for (let offset = 0; offset < item.size_bytes;) {
                await guard();
                const part = await client.query<{ content: Buffer }>(`SELECT substring(content FROM $3 FOR $4) AS content
                  FROM paperquay.${identifier(file.table)} WHERE account_id=$1 AND ${identifier(file.id)}=$2`,
                [account.id, item.id, offset + 1, 65536]);
                const bytes = part.rows[0]?.content;
                if (!bytes?.length || bytes.length > 65536 || offset + bytes.length > item.size_bytes) throw new ApiError('EXPORT_FILE_CHANGED', 409);
                contentHash.update(bytes); totalBytes += bytes.length;
                yield line({ kind: 'file-chunk', table: file.table, id: item.id, offset, bytes: bytes.length, base64: bytes.toString('base64') });
                offset += bytes.length;
              }
              if (contentHash.digest('hex') !== item.digest) throw new ApiError('EXPORT_FILE_CHANGED', 409);
              fileCount++;
              yield line({ kind: 'file-complete', table: file.table, id: item.id, bytes: item.size_bytes, sha256: item.digest });
            }
          } finally { await client.query('CLOSE privacy_files'); }
        }
        await guard();
        await client.query('COMMIT');
        // The completion record is outside its own digest. A missing final
        // record or an interrupted transport is always an incomplete export.
        yield Buffer.from(JSON.stringify({ kind: 'complete', records, files: fileCount, fileBytes: totalBytes,
          sha256: hash.digest('hex') }) + '\n');
      } finally {
        if (client) { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
      }
    },
  };
}

export function registerAccountPrivacyRoutes(app: FastifyInstance, repository: AccountPrivacyRepository,
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  const uuid = { type: 'string', pattern: UUID_PATTERN };
  app.get('/v1/privacy/status', { onRequest: authenticate }, request => repository.status(request.identity!));
  app.post<{ Body: AccountClosureRequest }>('/v1/privacy/close', { onRequest: authenticate,
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['accountId', 'requestId', 'confirmation', 'deleteCloudCopies', 'eraseDevices'],
      properties: { accountId: uuid, requestId: uuid, confirmation: { type: 'string', minLength: 1, maxLength: 80 },
        deleteCloudCopies: { const: true }, eraseDevices: { type: 'boolean' } } } },
  }, request => repository.close(request.identity!, request.body));
  app.post<{ Body: { deviceId: string } }>('/v1/privacy/erasure-ack', { onRequest: authenticate,
    schema: { body: { type: 'object', additionalProperties: false, required: ['deviceId'], properties: { deviceId: uuid } } },
  }, request => repository.acknowledgeErasure(request.identity!, request.body.deviceId));
  app.get('/v1/privacy/export', { onRequest: authenticate }, async (request, reply) => {
    const status = await repository.status(request.identity!);
    if (status.state !== 'active') throw new ApiError('ACCOUNT_CLOSED', 410);
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    request.raw.once('aborted', abort); reply.raw.once('close', abort);
    const stream = Readable.from(repository.exportData(request.identity!, cancellation.signal), { objectMode: false, highWaterMark: 128 * 1024 });
    stream.once('close', () => { request.raw.off('aborted', abort); reply.raw.off('close', abort); });
    return reply.header('Content-Disposition', 'attachment; filename="PaperQuay-personal-data.jsonl"')
      .type('application/x-ndjson; charset=utf-8').send(stream);
  });
}
