import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { decodeParsedDocument } from '../../packages/sync-core/src/parsedDocument.ts';
import { canonicalJson } from '../../packages/sync-core/src/validation.ts';
import { decodeRemoteIndexArtifact, REMOTE_TASK_LIMITS, validateRemoteTaskFailure, validateRemoteTaskId,
  validateRemoteTaskLease, validateRemoteTaskProfiles, validateRemoteTaskRequest, validateRemoteTaskResume } from '../../packages/sync-core/src/remoteTasks.ts';
import type { RemoteTask, RemoteTaskArtifact, RemoteTaskClaim, RemoteTaskFailure, RemoteTaskFailureCode, RemoteTaskLease,
  RemoteTaskProfile, RemoteTaskProvider, RemoteTaskQuota, RemoteTaskRequest, RemoteTaskResume, RemoteTaskState, RemoteTaskTarget } from '../../packages/sync-core/src/remoteTasks.ts';
import type { VerifiedIdentity } from './auth.ts';
import { ApiError } from './errors.ts';

export interface RemoteTaskTransaction { client: PoolClient; account: { id: string }; device: { id: string } }
/** Must BEGIN/COMMIT, lock the account, establish RLS and reject revoked sessions. */
export type RemoteTaskAccountRunner = <T>(identity: VerifiedIdentity, work: (context: RemoteTaskTransaction) => Promise<T>) => Promise<T>;
export interface RemoteTaskRepository {
  publishProvider(identity: VerifiedIdentity, profiles: RemoteTaskProfile[]): Promise<{ provider: RemoteTaskProvider }>;
  withdrawProvider(identity: VerifiedIdentity): Promise<{ disabled: true }>;
  listProviders(identity: VerifiedIdentity): Promise<{ providers: RemoteTaskProvider[] }>;
  createTask(identity: VerifiedIdentity, input: RemoteTaskRequest): Promise<{ task: RemoteTask; replayed: boolean; deduplicated: boolean; quota: RemoteTaskQuota }>;
  listTasks(identity: VerifiedIdentity): Promise<{ tasks: RemoteTask[]; quota: RemoteTaskQuota }>;
  getTask(identity: VerifiedIdentity, id: string): Promise<{ task: RemoteTask }>;
  cancelTask(identity: VerifiedIdentity, id: string): Promise<{ task: RemoteTask }>;
  resumeTask(identity: VerifiedIdentity, id: string, input?: RemoteTaskResume): Promise<{ task: RemoteTask }>;
  deleteTask(identity: VerifiedIdentity, id: string): Promise<{ deleted: boolean; quota: RemoteTaskQuota }>;
  claimTask(identity: VerifiedIdentity): Promise<{ claim: RemoteTaskClaim | null }>;
  heartbeatTask(identity: VerifiedIdentity, id: string, lease: RemoteTaskLease): Promise<{ task: RemoteTask }>;
  confirmRecovery(identity: VerifiedIdentity, id: string, lease: RemoteTaskLease): Promise<{ task: RemoteTask }>;
  failTask(identity: VerifiedIdentity, id: string, input: RemoteTaskFailure): Promise<{ task: RemoteTask }>;
  prepareArtifactUpload(identity: VerifiedIdentity, id: string, lease: RemoteTaskLease): Promise<void>;
  completeTask(identity: VerifiedIdentity, id: string, lease: RemoteTaskLease, content: Uint8Array): Promise<{ task: RemoteTask; replayed: boolean }>;
  downloadArtifact(identity: VerifiedIdentity, id: string): Promise<{ artifact: RemoteTaskArtifact; content: Buffer }>;
}
interface JobRow {
  id: string; kind: 'parse' | 'index'; state: RemoteTaskState; target: RemoteTaskTarget; profile: RemoteTaskProfile;
  requester_device_id: string; provider_device_id: string; index_source_digest: string | null;
  recovery_provider_device_id: string | null;
  attempt: number; fence: string | null; lease_expires_at: Date | null; failure: RemoteTaskFailureCode | null;
  created_at: Date; updated_at: Date; artifact_digest?: string | null; artifact_size?: number | null;
  lease_live: boolean;
}
const jobColumns = `j.id,j.kind,j.state,j.target,j.profile,j.requester_device_id,j.provider_device_id,j.index_source_digest,j.recovery_provider_device_id,
  j.attempt,j.fence,j.lease_expires_at,(j.lease_expires_at>clock_timestamp()) AS lease_live,j.failure,j.created_at,j.updated_at,a.digest AS artifact_digest,a.size_bytes AS artifact_size`;
const jobFrom = ` FROM paperquay.remote_tasks j LEFT JOIN paperquay.remote_task_artifacts a ON a.account_id=j.account_id AND a.job_id=j.id`;
const terminal = (state: RemoteTaskState) => !['queued', 'running', 'cancel_requested'].includes(state);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function dedupeDigest(kind:RemoteTask['kind'],target:RemoteTaskTarget,providerDeviceId:string,profile:RemoteTaskProfile,indexSourceDigest:string|null){
  return sha(canonicalJson({kind,target:{paperId:target.paperId,attachmentVersionId:target.attachmentVersionId,sha256:target.sha256,sizeBytes:target.sizeBytes},providerDeviceId,profile,indexSourceDigest}));
}
function present(row: JobRow): RemoteTask {
  return { id: row.id, kind: row.kind, state: row.state, target: row.target, providerDeviceId: row.provider_device_id,
    profile: row.profile, indexSourceDigest: row.index_source_digest, attempt: row.attempt,
    recoveryProviderDeviceId: row.recovery_provider_device_id,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null, failure: row.failure,
    artifact: row.artifact_digest ? { digest: row.artifact_digest, sizeBytes: row.artifact_size!, mediaType: 'application/json' } : null };
}
async function quota({ client, account }: RemoteTaskTransaction): Promise<RemoteTaskQuota> {
  const result = await client.query<{ active: string; queued: string; retained: string; receipts: string; artifact_bytes: string }>(`SELECT
    count(*) FILTER (WHERE state IN ('running','cancel_requested')) AS active,
    count(*) FILTER (WHERE state='queued') AS queued,count(*) AS retained,
    (SELECT count(*) FROM paperquay.remote_task_requests WHERE account_id=$1) AS receipts,
    (SELECT coalesce(sum(size_bytes),0) FROM paperquay.remote_task_artifacts WHERE account_id=$1) AS artifact_bytes
    FROM paperquay.remote_tasks WHERE account_id=$1`, [account.id]);
  const row = result.rows[0];
  return { active: Number(row.active), queued: Number(row.queued), retained: Number(row.retained), receipts: Number(row.receipts),
    artifactBytes: Number(row.artifact_bytes), maxActive: REMOTE_TASK_LIMITS.active, maxQueued: REMOTE_TASK_LIMITS.queued,
    maxRetained: REMOTE_TASK_LIMITS.retained, maxReceipts: REMOTE_TASK_LIMITS.receipts, maxArtifactBytes: REMOTE_TASK_LIMITS.accountArtifactBytes };
}
async function sweep({ client, account }: RemoteTaskTransaction): Promise<void> {
  // A lease is never returned to the queue automatically. External side effects
  // may already have happened; only a human's explicit resume can try again.
  await client.query(`UPDATE paperquay.remote_tasks j SET state=CASE WHEN state='cancel_requested' THEN 'cancelled' ELSE 'interrupted' END,
    failure=CASE WHEN EXISTS (SELECT 1 FROM paperquay.devices d WHERE d.account_id=j.account_id
      AND d.id IN (j.provider_device_id,j.requester_device_id) AND d.revoked_at IS NOT NULL)
      THEN 'SESSION_REVOKED' ELSE 'LEASE_EXPIRED' END,fence=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE j.account_id=$1 AND j.state IN ('running','cancel_requested') AND (j.lease_expires_at<=clock_timestamp()
      OR EXISTS (SELECT 1 FROM paperquay.devices d WHERE d.account_id=j.account_id
        AND d.id IN (j.provider_device_id,j.requester_device_id) AND d.revoked_at IS NOT NULL))`, [account.id]);
  await client.query(`UPDATE paperquay.remote_tasks j SET state='interrupted',failure='SESSION_REVOKED',updated_at=clock_timestamp()
    WHERE j.account_id=$1 AND j.state='queued' AND EXISTS (SELECT 1 FROM paperquay.devices d WHERE d.account_id=j.account_id
      AND d.id IN (j.provider_device_id,j.requester_device_id) AND d.revoked_at IS NOT NULL)`, [account.id]);
}
async function job(context: RemoteTaskTransaction, id: string): Promise<JobRow> {
  const result = await context.client.query<JobRow>(`SELECT ${jobColumns}${jobFrom} WHERE j.account_id=$1 AND j.id=$2`, [context.account.id, id]);
  if (!result.rows[0]) throw new ApiError('REMOTE_TASK_NOT_FOUND', 404);
  return result.rows[0];
}
async function target({ client, account }: RemoteTaskTransaction, id: string): Promise<RemoteTaskTarget> {
  const result = await client.query<{ version_id: string; version_revision: string; data: Record<string, unknown>;
    paper_id: string | null; paper_revision: string | null; version_deleted: Date | null; paper_deleted: Date | null }>(`SELECT
    v.entity_id AS version_id,v.revision AS version_revision,v.data,v.deleted_at AS version_deleted,
    p.entity_id AS paper_id,p.revision AS paper_revision,p.deleted_at AS paper_deleted FROM paperquay.entities v
    LEFT JOIN paperquay.entities p ON p.account_id=v.account_id AND p.entity_type='paper' AND p.entity_id=(v.data->>'paperId')::uuid
    WHERE v.account_id=$1 AND v.entity_type='attachmentVersion' AND v.entity_id=$2`, [account.id, id]);
  const row = result.rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 404);
  if (row.version_deleted || !row.paper_id || row.paper_deleted) throw new ApiError('REMOTE_TASK_VERSION_UNAVAILABLE', 410);
  if (row.data.mediaType !== 'application/pdf' || typeof row.data.sizeBytes !== 'number'
    || row.data.sizeBytes < 1 || row.data.sizeBytes > 64 * 1024 * 1024
    || (row.data.pageCount !== null && (typeof row.data.pageCount !== 'number' || row.data.pageCount < 1 || row.data.pageCount > 2000))) {
    throw new ApiError('REMOTE_TASK_TARGET_UNSUPPORTED', 415);
  }
  return { paperId: row.paper_id, attachmentVersionId: row.version_id, paperRevision: Number(row.paper_revision),
    versionRevision: Number(row.version_revision), sha256: row.data.sha256 as string, sizeBytes: row.data.sizeBytes,
    pageCount: row.data.pageCount as number | null, fileName: row.data.fileName as string };
}
async function currentTarget(context: RemoteTaskTransaction, row: JobRow): Promise<RemoteTaskTarget> {
  const current = await target(context, row.target.attachmentVersionId);
  // Entity revisions also change for titles, file names and newly learned page
  // counts. The immutable PDF identity, live ownership and known counts decide
  // whether an expensive result is still usable; revisions are audit metadata.
  if (current.paperId !== row.target.paperId || current.attachmentVersionId !== row.target.attachmentVersionId
    || current.sha256 !== row.target.sha256 || current.sizeBytes !== row.target.sizeBytes
    || (current.pageCount !== null && row.target.pageCount !== null && current.pageCount !== row.target.pageCount)) {
    throw new ApiError('REMOTE_TASK_VERSION_CHANGED', 409);
  }
  return current;
}
async function desktop(context: RemoteTaskTransaction): Promise<void> {
  const result = await context.client.query<{ platform: string }>('SELECT platform FROM paperquay.devices WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL',
    [context.account.id, context.device.id]);
  if (!['windows', 'macos', 'linux'].includes(result.rows[0]?.platform)) throw new ApiError('REMOTE_TASK_PROVIDER_REQUIRED', 403);
}
async function provider(context: RemoteTaskTransaction, deviceId: string, profile?: RemoteTaskProfile | RemoteTaskRequest): Promise<RemoteTaskProvider> {
  const result = await context.client.query<{ device_id: string; profiles: RemoteTaskProfile[]; expires_at: Date }>(`SELECT p.device_id,p.profiles,p.expires_at
    FROM paperquay.remote_task_providers p JOIN paperquay.devices d ON d.account_id=p.account_id AND d.id=p.device_id
    WHERE p.account_id=$1 AND p.device_id=$2 AND p.expires_at>clock_timestamp() AND d.revoked_at IS NULL
      AND d.platform IN ('windows','macos','linux')`, [context.account.id, deviceId]);
  const row = result.rows[0]; if (!row) throw new ApiError('REMOTE_TASK_PROVIDER_UNAVAILABLE', 409);
  const profiles = validateRemoteTaskProfiles(row.profiles);
  if (profile) {
    const ref = 'profileRef' in profile ? profile.profileRef : profile;
    if (!profiles.some((value) => value.id === ref.id && value.revision === ref.revision && value.digest === ref.digest
      && value.kind === profile.kind && (!('model' in profile) || value.model === profile.model))) {
      throw new ApiError('REMOTE_TASK_PROFILE_CHANGED', 409);
    }
  }
  return { deviceId: row.device_id, profiles, expiresAt: row.expires_at.toISOString() };
}
function ownsLease(context: RemoteTaskTransaction, row: JobRow, lease: RemoteTaskLease): void {
  if (row.provider_device_id !== context.device.id || row.attempt !== lease.attempt || row.fence !== lease.fence
    || !['running', 'cancel_requested'].includes(row.state) || !row.lease_live) {
    throw new ApiError('REMOTE_TASK_LEASE_CHANGED', 409);
  }
}
async function finish(context: RemoteTaskTransaction, id: string, state: RemoteTaskState, failure: RemoteTaskFailureCode | null): Promise<RemoteTask> {
  await context.client.query(`UPDATE paperquay.remote_tasks SET state=$3,failure=$4,fence=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2`, [context.account.id, id, state, failure]);
  return present(await job(context, id));
}
export function createRemoteTaskRepository(options: { withAccount: RemoteTaskAccountRunner }): RemoteTaskRepository {
  if (typeof options.withAccount !== 'function') throw new ApiError('CONFIGURATION_INVALID', 500);
  const run = options.withAccount;
  return {
    async publishProvider(identity, value) {
      const profiles = validateRemoteTaskProfiles(value);
      return run(identity, async (context) => {
        await desktop(context);
        const expiresMs = Math.min(Date.now() + REMOTE_TASK_LIMITS.providerPresenceSeconds * 1000, identity.expiresAtMs ?? Infinity);
        if (expiresMs <= Date.now()) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
        const expiresAt = new Date(expiresMs).toISOString();
        await context.client.query(`INSERT INTO paperquay.remote_task_providers(account_id,device_id,profiles,expires_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(account_id,device_id) DO UPDATE SET profiles=excluded.profiles,expires_at=excluded.expires_at`,
        [context.account.id, context.device.id, JSON.stringify(profiles), expiresAt]);
        return { provider: { deviceId: context.device.id, profiles, expiresAt } };
      });
    },
    async withdrawProvider(identity) {
      return run(identity, async (context) => {
        await context.client.query('DELETE FROM paperquay.remote_task_providers WHERE account_id=$1 AND device_id=$2', [context.account.id, context.device.id]);
        await context.client.query(`UPDATE paperquay.remote_tasks SET state=CASE WHEN state='cancel_requested' THEN 'cancelled' ELSE 'interrupted' END,
          failure='PROFILE_CHANGED',fence=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE account_id=$1 AND provider_device_id=$2 AND state IN ('queued','running','cancel_requested')`, [context.account.id, context.device.id]);
        return { disabled: true };
      });
    },
    async listProviders(identity) {
      return run(identity, async (context) => {
        const rows = await context.client.query<{ device_id: string; profiles: RemoteTaskProfile[]; expires_at: Date }>(`SELECT p.device_id,p.profiles,p.expires_at
          FROM paperquay.remote_task_providers p JOIN paperquay.devices d ON d.account_id=p.account_id AND d.id=p.device_id
          WHERE p.account_id=$1 AND p.expires_at>clock_timestamp() AND d.revoked_at IS NULL
          AND d.platform IN ('windows','macos','linux') ORDER BY p.device_id`, [context.account.id]);
        return { providers: rows.rows.map((row) => ({ deviceId: row.device_id, profiles: validateRemoteTaskProfiles(row.profiles), expiresAt: row.expires_at.toISOString() })) };
      });
    },
    async createTask(identity, value) {
      const input = validateRemoteTaskRequest(value); const inputDigest = sha(JSON.stringify(input));
      return run(identity, async (context) => {
        await sweep(context);
        const receipt = await context.client.query<{ input_digest: string; job_id: string | null }>(`SELECT input_digest,job_id FROM paperquay.remote_task_requests
          WHERE account_id=$1 AND request_id=$2`, [context.account.id, input.requestId]);
        if (receipt.rows[0]) {
          if (receipt.rows[0].input_digest !== inputDigest) throw new ApiError('REMOTE_TASK_REQUEST_REUSED', 409);
          if (!receipt.rows[0].job_id) throw new ApiError('REMOTE_TASK_GONE', 410);
          return { task: present(await job(context, receipt.rows[0].job_id)), replayed: true, deduplicated: receipt.rows[0].job_id !== input.requestId, quota: await quota(context) };
        }
        const current = await target(context, input.versionId);
        const available = await provider(context, input.providerDeviceId, input);
        const profile = available.profiles.find((profile) => profile.id === input.profileRef.id)!;
        const dedupe = dedupeDigest(input.kind,current,input.providerDeviceId,profile,input.indexSourceDigest??null);
        const existing = await context.client.query<{ id: string }>('SELECT id FROM paperquay.remote_tasks WHERE account_id=$1 AND dedupe_digest=$2', [context.account.id, dedupe]);
        const usage = await quota(context);
        if (usage.receipts >= usage.maxReceipts) throw new ApiError('REMOTE_TASK_HISTORY_FULL', 409);
        const id = existing.rows[0]?.id ?? input.requestId;
        if (!existing.rows[0]) {
          if (usage.retained >= usage.maxRetained) throw new ApiError('REMOTE_TASK_HISTORY_FULL', 409);
          if (usage.queued >= usage.maxQueued) throw new ApiError('REMOTE_TASK_QUEUE_FULL', 429);
          await context.client.query(`INSERT INTO paperquay.remote_tasks(account_id,id,requester_device_id,provider_device_id,kind,state,target,profile,index_source_digest,dedupe_digest)
            VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9)`, [context.account.id, id, context.device.id, input.providerDeviceId, input.kind,
            JSON.stringify(current), JSON.stringify(profile), input.indexSourceDigest ?? null, dedupe]);
        }
        await context.client.query(`INSERT INTO paperquay.remote_task_requests(account_id,request_id,input_digest,job_id) VALUES($1,$2,$3,$4)`,
          [context.account.id, input.requestId, inputDigest, id]);
        return { task: present(await job(context, id)), replayed: false, deduplicated: Boolean(existing.rows[0]), quota: await quota(context) };
      });
    },
    async listTasks(identity) {
      return run(identity, async (context) => {
        await sweep(context);
        const rows = await context.client.query<JobRow>(`SELECT ${jobColumns}${jobFrom} WHERE j.account_id=$1 ORDER BY j.created_at DESC,j.id LIMIT 200`, [context.account.id]);
        return { tasks: rows.rows.map(present), quota: await quota(context) };
      });
    },
    async getTask(identity, value) {
      const id = validateRemoteTaskId(value);
      return run(identity, async (context) => { await sweep(context); return { task: present(await job(context, id)) }; });
    },
    async cancelTask(identity, value) {
      const id = validateRemoteTaskId(value);
      return run(identity, async (context) => {
        await sweep(context); const row = await job(context, id);
        if (row.state === 'queued') return { task: await finish(context, id, 'cancelled', null) };
        if (row.state === 'running') await context.client.query(`UPDATE paperquay.remote_tasks SET state='cancel_requested',updated_at=clock_timestamp()
          WHERE account_id=$1 AND id=$2`, [context.account.id, id]);
        return { task: present(await job(context, id)) };
      });
    },
    async resumeTask(identity, value, options = {}) {
      const id = validateRemoteTaskId(value), input = validateRemoteTaskResume(options);
      return run(identity, async (context) => {
        await sweep(context); const row = await job(context, id);
        if (input.profileRef && (input.profileRef.id!==row.profile.id || input.profileRef.revision!==row.profile.revision || input.profileRef.digest!==row.profile.digest))
          throw new ApiError('REMOTE_TASK_PROFILE_CHANGED',409);
        if (row.state === 'queued') {
          if (input.providerDeviceId && input.providerDeviceId!==row.provider_device_id) throw new ApiError('REMOTE_TASK_NOT_RESUMABLE',409);
          return { task: present(row) };
        }
        if (!['failed', 'cancelled', 'interrupted'].includes(row.state) || row.attempt >= REMOTE_TASK_LIMITS.attempts) throw new ApiError('REMOTE_TASK_NOT_RESUMABLE', 409);
        await currentTarget(context, row);
        const providerDeviceId=input.providerDeviceId??row.provider_device_id;
        await provider(context, providerDeviceId, row.profile);
        const dedupe=dedupeDigest(row.kind,row.target,providerDeviceId,row.profile,row.index_source_digest);
        const duplicate=await context.client.query('SELECT id FROM paperquay.remote_tasks WHERE account_id=$1 AND dedupe_digest=$2 AND id<>$3',[context.account.id,dedupe,id]);
        if(duplicate.rowCount)throw new ApiError('REMOTE_TASK_TARGET_BUSY',409);
        if ((await quota(context)).queued >= REMOTE_TASK_LIMITS.queued) throw new ApiError('REMOTE_TASK_QUEUE_FULL', 429);
        await context.client.query(`UPDATE paperquay.remote_tasks SET state='queued',requester_device_id=$3,provider_device_id=$4,
          recovery_provider_device_id=$5,dedupe_digest=$6,failure=NULL,updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2`,
          [context.account.id,id,context.device.id,providerDeviceId,row.recovery_provider_device_id??(row.attempt>0?row.provider_device_id:null),dedupe]);
        return { task: present(await job(context, id)) };
      });
    },
    async confirmRecovery(identity,value,options) {
      const id=validateRemoteTaskId(value),lease=validateRemoteTaskLease(options);
      return run(identity,async context=>{
        await sweep(context);const row=await job(context,id);ownsLease(context,row,lease);
        if(row.state==='cancel_requested')return{task:await finish(context,id,'cancelled',null)};
        await currentTarget(context,row);await provider(context,context.device.id,row.profile);
        ownsLease(context,await job(context,id),lease);
        await context.client.query('UPDATE paperquay.remote_tasks SET recovery_provider_device_id=$3,updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2',[context.account.id,id,context.device.id]);
        return{task:present(await job(context,id))};
      });
    },
    async deleteTask(identity, value) {
      const id = validateRemoteTaskId(value);
      return run(identity, async (context) => {
        await sweep(context);
        const existing = await context.client.query<{ state: RemoteTaskState }>('SELECT state FROM paperquay.remote_tasks WHERE account_id=$1 AND id=$2', [context.account.id, id]);
        if (!existing.rows[0]) return { deleted: false, quota: await quota(context) };
        if (!terminal(existing.rows[0].state)) throw new ApiError('REMOTE_TASK_ACTIVE', 409);
        await context.client.query('UPDATE paperquay.remote_task_requests SET job_id=NULL WHERE account_id=$1 AND job_id=$2', [context.account.id, id]);
        await context.client.query('DELETE FROM paperquay.remote_tasks WHERE account_id=$1 AND id=$2', [context.account.id, id]);
        return { deleted: true, quota: await quota(context) };
      });
    },
    async claimTask(identity) {
      return run(identity, async (context) => {
        await desktop(context); await sweep(context); await provider(context, context.device.id);
        if ((await quota(context)).active >= REMOTE_TASK_LIMITS.active) return { claim: null };
        const next = await context.client.query<{ id: string }>(`SELECT id FROM paperquay.remote_tasks WHERE account_id=$1 AND provider_device_id=$2
          AND state='queued' ORDER BY created_at,id LIMIT 1`, [context.account.id, context.device.id]);
        if (!next.rows[0]) return { claim: null };
        const row = await job(context, next.rows[0].id);
        try { await currentTarget(context, row); await provider(context, context.device.id, row.profile); }
        catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await finish(context, row.id, 'interrupted', error.code === 'REMOTE_TASK_PROFILE_CHANGED' ? 'PROFILE_CHANGED' : 'VERSION_CHANGED');
          return { claim: null };
        }
        if (row.attempt >= REMOTE_TASK_LIMITS.attempts) { await finish(context, row.id, 'failed', 'EXECUTION_FAILED'); return { claim: null }; }
        const lease: RemoteTaskLease = { attempt: row.attempt + 1, fence: randomUUID() };
        await context.client.query(`UPDATE paperquay.remote_tasks SET state='running',attempt=$3,fence=$4,
          lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp(),failure=NULL WHERE account_id=$1 AND id=$2`,
        [context.account.id, row.id, lease.attempt, lease.fence]);
        return { claim: { task: present(await job(context, row.id)), lease } };
      });
    },
    async heartbeatTask(identity, value, input) {
      const id = validateRemoteTaskId(value); const lease = validateRemoteTaskLease(input);
      return run(identity, async (context) => {
        await sweep(context); const row = await job(context, id); ownsLease(context, row, lease);
        // A cancellation response acknowledges and invalidates the execution;
        // it never grants an indefinitely renewable cancellation lease.
        if (row.state === 'cancel_requested') return { task: await finish(context, id, 'cancelled', null) };
        await currentTarget(context, row); await provider(context, context.device.id, row.profile);
        await context.client.query(`UPDATE paperquay.remote_tasks SET lease_expires_at=clock_timestamp()+interval '60 seconds',
          updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2`, [context.account.id, id]);
        return { task: present(await job(context, id)) };
      });
    },
    async failTask(identity, value, input) {
      const id = validateRemoteTaskId(value); const failure = validateRemoteTaskFailure(input);
      return run(identity, async (context) => {
        await sweep(context); const row = await job(context, id); ownsLease(context, row, failure);
        return { task: await finish(context, id, row.state === 'cancel_requested' ? 'cancelled'
          : failure.code === 'EXTERNAL_OUTCOME_UNKNOWN' ? 'interrupted' : 'failed', failure.code) };
      });
    },
    async completeTask(identity, value, input, raw) {
      const id = validateRemoteTaskId(value); const lease = validateRemoteTaskLease(input);
      if (!(raw instanceof Uint8Array) || !raw.byteLength || raw.byteLength > REMOTE_TASK_LIMITS.artifactBytes) throw new ApiError('REMOTE_TASK_ARTIFACT_LIMIT', 413);
      // Detach a caller-owned buffer before either validation or a transaction.
      const content = Buffer.from(raw);
      return run(identity, async (context) => {
        await sweep(context); const row = await job(context, id);
        // Exact canonical artifact replay is safe after a lost completion reply.
        // A fence from another attempt or another device is never sufficient.
        const completedReplay = row.state === 'succeeded' && row.provider_device_id === context.device.id && row.attempt === lease.attempt;
        if (!completedReplay) ownsLease(context, row, lease);
        const current = await currentTarget(context, row);
        if (row.state === 'cancel_requested') return { task: await finish(context, id, 'cancelled', null), replayed: false };
          if (!completedReplay && row.recovery_provider_device_id && row.recovery_provider_device_id!==context.device.id)
            throw new ApiError('REMOTE_TASK_RECOVERY_REQUIRED',409);
        if (!completedReplay) await provider(context, context.device.id, row.profile);
        let canonical: Buffer; let digest: string; let actualPageCount: number;
        try {
          if (row.kind === 'parse') {
            const parsed = await decodeParsedDocument(content); const document = parsed.document;
            if (document.paperId !== row.target.paperId || document.attachmentVersionId !== row.target.attachmentVersionId
              || document.pdf.sha256 !== row.target.sha256 || document.pdf.sizeBytes !== row.target.sizeBytes
              || ((row.target.pageCount ?? current.pageCount) !== null && document.pdf.pageCount !== (row.target.pageCount ?? current.pageCount))
              || document.parser.model !== row.profile.model) throw new ApiError('REMOTE_TASK_ARTIFACT_TARGET_MISMATCH', 409);
            canonical = Buffer.from(JSON.stringify(document)); digest = parsed.digest; actualPageCount = document.pdf.pageCount;
          } else {
            const parsed = await decodeRemoteIndexArtifact(content); const document = parsed.document;
            if (document.paperId !== row.target.paperId || document.attachmentVersionId !== row.target.attachmentVersionId
              || document.pdf.sha256 !== row.target.sha256 || document.pdf.sizeBytes !== row.target.sizeBytes
              || ((row.target.pageCount ?? current.pageCount) !== null && document.pdf.pageCount !== (row.target.pageCount ?? current.pageCount))
              || document.parseDigest !== row.index_source_digest || document.model !== row.profile.model) throw new ApiError('REMOTE_TASK_ARTIFACT_TARGET_MISMATCH', 409);
            canonical = Buffer.from(parsed.bytes); digest = parsed.digest; actualPageCount = document.pdf.pageCount;
          }
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError('REMOTE_TASK_ARTIFACT_INVALID', 400);
        }
        if (completedReplay) {
          const saved = await context.client.query<{ completion_fence: string }>(`SELECT completion_fence FROM paperquay.remote_task_artifacts WHERE account_id=$1 AND job_id=$2`, [context.account.id, id]);
          if (row.artifact_digest !== digest || saved.rows[0]?.completion_fence !== lease.fence) throw new ApiError('REMOTE_TASK_LEASE_CHANGED', 409);
          return { task: present(row), replayed: true };
        }
        if ((await quota(context)).artifactBytes > REMOTE_TASK_LIMITS.accountArtifactBytes - canonical.byteLength) throw new ApiError('REMOTE_TASK_ARTIFACT_QUOTA', 409);
        // Validation is asynchronous. Time passing cannot turn an expired lease
        // into permission to commit, even while this transaction holds the lock.
        ownsLease(context, await job(context, id), lease);
        if (row.target.pageCount === null) await context.client.query(`UPDATE paperquay.remote_tasks
          SET target=jsonb_set(target,'{pageCount}',to_jsonb($3::integer)) WHERE account_id=$1 AND id=$2`, [context.account.id, id, actualPageCount]);
        await context.client.query(`INSERT INTO paperquay.remote_task_artifacts(account_id,job_id,digest,size_bytes,content,completion_fence)
          VALUES($1,$2,$3,$4,$5,$6)`, [context.account.id, id, digest, canonical.byteLength, canonical, lease.fence]);
        return { task: await finish(context, id, 'succeeded', null), replayed: false };
      });
    },
    async prepareArtifactUpload(identity, value, input) {
      const id = validateRemoteTaskId(value); const lease = validateRemoteTaskLease(input);
      return run(identity, async (context) => {
        await sweep(context); const row = await job(context, id);
        if (row.state === 'succeeded' && row.provider_device_id === context.device.id && row.attempt === lease.attempt) {
          const artifact = await context.client.query<{ completion_fence: string }>('SELECT completion_fence FROM paperquay.remote_task_artifacts WHERE account_id=$1 AND job_id=$2', [context.account.id, id]);
          if (artifact.rows[0]?.completion_fence !== lease.fence) throw new ApiError('REMOTE_TASK_LEASE_CHANGED', 409);
        } else ownsLease(context, row, lease);
          if (row.state!=='succeeded' && row.state!=='cancel_requested' && row.recovery_provider_device_id && row.recovery_provider_device_id!==context.device.id)
            throw new ApiError('REMOTE_TASK_RECOVERY_REQUIRED',409);
        await currentTarget(context, row);
      });
    },
    async downloadArtifact(identity, value) {
      const id = validateRemoteTaskId(value);
      return run(identity, async (context) => {
        const row = await job(context, id); await currentTarget(context, row);
        if (row.state !== 'succeeded' || !row.artifact_digest) throw new ApiError('REMOTE_TASK_ARTIFACT_NOT_FOUND', 404);
        const result = await context.client.query<{ digest: string; size_bytes: number; content: Buffer }>(`SELECT digest,size_bytes,content
          FROM paperquay.remote_task_artifacts WHERE account_id=$1 AND job_id=$2`, [context.account.id, id]);
        const artifact = result.rows[0];
        if (!artifact || artifact.content.byteLength !== artifact.size_bytes || sha(artifact.content) !== artifact.digest) throw new ApiError('REMOTE_TASK_ARTIFACT_CORRUPT', 500);
        return { artifact: { digest: artifact.digest, sizeBytes: artifact.size_bytes, mediaType: 'application/json' }, content: artifact.content };
      });
    },
  };
}
