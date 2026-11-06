import { createHash } from 'node:crypto';
import { canonicalJson } from '../../packages/sync-core/src/validation.ts';
import { decodeRemoteIndexArtifact, validateRemoteTaskTarget, validateRemoteTaskProfiles } from '../../packages/sync-core/src/remoteTasks.ts';
import type { RemoteIndexArtifact, RemoteTaskTarget, RemoteTaskProfile } from '../../packages/sync-core/src/remoteTasks.ts';
import { REMOTE_RETRIEVAL_LIMITS as L, RemoteRetrievalValidationError, remoteRetrievalId, remoteRetrievalDigest,
  validateRemoteRetrievalRequest, validateRemoteRetrievalSource, validateRemoteRetrievalReceipt, assertRemoteRetrievalArtifact } from '../../packages/sync-core/src/remoteRetrieval.ts';
import type { RemoteRetrievalRequest, RemoteRetrievalSource, RemoteRetrievalReceipt, RemoteRetrievalStatus } from '../../packages/sync-core/src/remoteRetrieval.ts';
import type { VerifiedIdentity } from './auth.ts';
import type { RemoteTaskAccountRunner, RemoteTaskTransaction } from './remote-task-store.ts';
import { runRemoteRetrieval } from './remote-retrieval-worker.ts';
import { ApiError } from './errors.ts';

export interface RemoteRetrievalCall { signal?: AbortSignal }
export interface RemoteRetrievalRepository {
  listSources(identity: VerifiedIdentity, page?: { cursor?: string; limit?: number }, options?: RemoteRetrievalCall): Promise<{ sources: RemoteRetrievalSource[]; nextCursor: string | null; hasMore: boolean }>;
  source(identity: VerifiedIdentity, taskId: string, options?: RemoteRetrievalCall): Promise<{ source: RemoteRetrievalSource }>;
  retrieve(identity: VerifiedIdentity, request: RemoteRetrievalRequest, options?: RemoteRetrievalCall): Promise<{ replayed: boolean; receipt: RemoteRetrievalReceipt }>;
  lookup(identity: VerifiedIdentity, requestId: string): Promise<RemoteRetrievalStatus>;
  remove(identity: VerifiedIdentity, requestId: string): Promise<RemoteRetrievalStatus>;
}
interface SourceRow {
  id: string; kind: string; state: string; target: RemoteTaskTarget; profile: RemoteTaskProfile; index_source_digest: string | null;
  artifact_digest: string | null; artifact_bytes: number | null; version_id: string | null; version_revision: string | null;
  version_data: Record<string, unknown> | null; version_deleted: Date | null; paper_id: string | null; paper_revision: string | null; paper_deleted: Date | null;
}
interface SourceHeader { row: SourceRow; current: RemoteTaskTarget }
interface ReceiptRow {
  request_id: string; request_digest: string; state: 'complete' | 'removed'; request_payload: RemoteRetrievalRequest | null;
  result_payload: RemoteRetrievalReceipt['result'] | null; result_digest: string; created_at: Date;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const check = (options: RemoteRetrievalCall) => { if (options.signal?.aborted) throw new ApiError('REMOTE_RETRIEVAL_STOPPED', 409); };
function unavailable(): never { throw new ApiError('REMOTE_RETRIEVAL_SOURCE_UNAVAILABLE', 404); }
function sourceChanged(): never { throw new ApiError('REMOTE_RETRIEVAL_SOURCE_CHANGED', 409); }
function corrupt(): never { throw new ApiError('REMOTE_RETRIEVAL_SOURCE_INVALID', 500); }
async function checked<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) {
    if (e instanceof RemoteRetrievalValidationError) throw new ApiError(e.code, e.code === 'REMOTE_RETRIEVAL_LIMIT' ? 413 : e.code === 'REMOTE_RETRIEVAL_SOURCE_CHANGED' ? 409 : 400);
    if (e && typeof e === 'object' && 'code' in e && e.code === '23514' && 'constraint' in e
      && typeof e.constraint === 'string' && e.constraint.startsWith('remote_retrieval_') && e.constraint.endsWith('_quota')) throw new ApiError('REMOTE_RETRIEVAL_STORAGE_FULL', 507);
    throw e;
  }
}
async function header(context: RemoteTaskTransaction, taskId: string): Promise<SourceHeader> {
  const { client, account } = context;
  const selected = await client.query<SourceRow>(`SELECT j.id,j.kind,j.state,j.target,j.profile,j.index_source_digest,
    a.digest AS artifact_digest,a.size_bytes AS artifact_bytes,v.entity_id AS version_id,v.revision AS version_revision,
    v.data AS version_data,v.deleted_at AS version_deleted,p.entity_id AS paper_id,p.revision AS paper_revision,p.deleted_at AS paper_deleted
    FROM paperquay.remote_tasks j LEFT JOIN paperquay.remote_task_artifacts a ON a.account_id=j.account_id AND a.job_id=j.id
    LEFT JOIN paperquay.entities v ON v.account_id=j.account_id AND v.entity_type='attachmentVersion' AND v.entity_id=(j.target->>'attachmentVersionId')::uuid
    LEFT JOIN paperquay.entities p ON p.account_id=v.account_id AND p.entity_type='paper' AND p.entity_id=(v.data->>'paperId')::uuid
    WHERE j.account_id=$1 AND j.id=$2`, [account.id, taskId]);
  const row = selected.rows[0];
  // Unknown and foreign identifiers have the same response. A historical artifact is never authority for a deleted source.
  if (!row || row.kind !== 'index' || row.state !== 'succeeded' || !row.artifact_digest || !row.artifact_bytes
    || !row.version_id || !row.paper_id || row.version_deleted || row.paper_deleted || !row.version_data) unavailable();
  let target: RemoteTaskTarget, profile: RemoteTaskProfile;
  try { target = validateRemoteTaskTarget(row.target); profile = validateRemoteTaskProfiles([row.profile])[0]; } catch { corrupt(); }
  if (profile.kind !== 'index' || !row.index_source_digest) corrupt();
  const data = row.version_data;
  if (data.mediaType !== 'application/pdf' || row.paper_id !== target.paperId || row.version_id !== target.attachmentVersionId
    || data.sha256 !== target.sha256 || data.sizeBytes !== target.sizeBytes
    || data.pageCount !== null && target.pageCount !== null && data.pageCount !== target.pageCount) sourceChanged();
  let current: RemoteTaskTarget;
  try { current = validateRemoteTaskTarget({ ...target, paperRevision: Number(row.paper_revision), versionRevision: Number(row.version_revision),
    fileName: data.fileName, pageCount: data.pageCount ?? target.pageCount }); } catch { corrupt(); }
  if (current.pageCount === null || row.artifact_bytes > L.sourceBytes) throw new ApiError('REMOTE_RETRIEVAL_LIMIT', 413);
  return { row, current };
}
async function loadSource(context: RemoteTaskTransaction, taskId: string, options: RemoteRetrievalCall,
  pinned?: RemoteRetrievalSource): Promise<{ source: RemoteRetrievalSource; artifact: RemoteIndexArtifact }> {
  check(options); const selected = await header(context, taskId); check(options);
  if (pinned) assertHeader(selected, pinned);
  const found = await context.client.query<{ content: Buffer }>('SELECT content FROM paperquay.remote_task_artifacts WHERE account_id=$1 AND job_id=$2', [context.account.id, taskId]);
  check(options); const bytes = found.rows[0]?.content;
  if (!bytes || bytes.byteLength !== selected.row.artifact_bytes || sha(bytes) !== selected.row.artifact_digest) corrupt();
  let decoded: Awaited<ReturnType<typeof decodeRemoteIndexArtifact>>;
  try { decoded = await decodeRemoteIndexArtifact(bytes); } catch { corrupt(); } check(options);
  if (decoded.digest !== selected.row.artifact_digest || decoded.document.parseDigest !== selected.row.index_source_digest
    || decoded.document.model !== selected.row.profile.model) corrupt();
  const a = decoded.document;
  const source = validateRemoteRetrievalSource({ taskId, artifactDigest: decoded.digest, artifactBytes: bytes.byteLength, target: selected.current,
    parseDigest: a.parseDigest, model: a.model, dimension: a.dimension, chunker: a.chunker, chunkCount: a.chunkCount,
    contentHash: a.contentHash, textCharacters: a.chunks.reduce((n,c) => n+c.text.length,0) });
  assertRemoteRetrievalArtifact(source, a);
  if (pinned && canonicalJson(source) !== canonicalJson(pinned)) sourceChanged();
  return { source, artifact: a };
}
function assertHeader(actual: SourceHeader, expected: RemoteRetrievalSource): void {
  if (actual.row.id !== expected.taskId || actual.row.artifact_digest !== expected.artifactDigest
    || actual.row.artifact_bytes !== expected.artifactBytes || actual.row.index_source_digest !== expected.parseDigest
    || actual.row.profile.model !== expected.model || canonicalJson(actual.current) !== canonicalJson(expected.target)) sourceChanged();
}
async function assertSourcesCurrent(context: RemoteTaskTransaction, request: RemoteRetrievalRequest): Promise<void> {
  for (const source of request.sources) assertHeader(await header(context, source.taskId), source);
}
async function saved(context: RemoteTaskTransaction, id: string): Promise<ReceiptRow | null> {
  const result = await context.client.query<ReceiptRow>(`SELECT request_id,request_digest,state,request_payload,result_payload,result_digest,created_at
    FROM paperquay.remote_retrieval_requests WHERE account_id=$1 AND request_id=$2`, [context.account.id, id]); return result.rows[0] ?? null;
}
async function receipt(row: ReceiptRow): Promise<RemoteRetrievalReceipt> {
  try { return await validateRemoteRetrievalReceipt({ version:1,request:row.request_payload,requestDigest:row.request_digest,
    result:row.result_payload,resultDigest:row.result_digest,createdAt:row.created_at.toISOString() }); }
  catch { throw new ApiError('REMOTE_RETRIEVAL_RECEIPT_INVALID',500); }
}
function emptyStatus(id: string, row: ReceiptRow | null): RemoteRetrievalStatus {
  return {requestId:id,status:row?'removed':'absent',requestDigest:row?.request_digest??null,receipt:null};
}
async function reserve(context: RemoteTaskTransaction, request: RemoteRetrievalRequest): Promise<void> {
  const q = await context.client.query<{ receipts: string; retained: string; bytes: string }>(`SELECT count(*) AS receipts,
    count(*) FILTER(WHERE state='complete') AS retained,
    coalesce(sum(coalesce(octet_length(request_payload::text),0)+coalesce(octet_length(result_payload::text),0)),0) AS bytes
    FROM paperquay.remote_retrieval_requests WHERE account_id=$1`, [context.account.id]);
  const row=q.rows[0], required=Buffer.byteLength(JSON.stringify(request))+L.resultBytes+8192;
  if(Number(row.receipts)>=L.receipts||Number(row.retained)>=L.retained||Number(row.bytes)>L.accountBytes-required)throw new ApiError('REMOTE_RETRIEVAL_STORAGE_FULL',507);
}
export function createRemoteRetrievalRepository(options: { withAccount: RemoteTaskAccountRunner; worker?: typeof runRemoteRetrieval }): RemoteRetrievalRepository {
  const run=options.withAccount,worker=options.worker??runRemoteRetrieval;
  if(typeof run!=='function'||typeof worker!=='function')throw new ApiError('CONFIGURATION_INVALID',500);
  return {
    listSources(identity,page={},call={}) { return checked(async()=>{
      const cursor=page.cursor===undefined?null:remoteRetrievalId(page.cursor),count=page.limit??L.sources;
      if(!Number.isSafeInteger(count)||count<1||count>L.sources)throw new ApiError('REMOTE_RETRIEVAL_INVALID',400);
      return run(identity,async context=>{
        check(call);
        const rows=(await context.client.query<{id:string;size_bytes:number}>(`SELECT j.id,a.size_bytes FROM paperquay.remote_tasks j
          JOIN paperquay.remote_task_artifacts a ON a.account_id=j.account_id AND a.job_id=j.id
          JOIN paperquay.entities v ON v.account_id=j.account_id AND v.entity_type='attachmentVersion' AND v.entity_id=(j.target->>'attachmentVersionId')::uuid AND v.deleted_at IS NULL
          JOIN paperquay.entities p ON p.account_id=v.account_id AND p.entity_type='paper' AND p.entity_id=(v.data->>'paperId')::uuid AND p.deleted_at IS NULL
          WHERE j.account_id=$1 AND j.kind='index' AND j.state='succeeded' AND ($2::uuid IS NULL OR j.id>$2::uuid)
          AND v.data->>'mediaType'='application/pdf' AND v.data->>'sha256'=j.target->>'sha256'
          AND v.data->>'sizeBytes'=j.target->>'sizeBytes' AND p.entity_id=(j.target->>'paperId')::uuid
          ORDER BY j.id LIMIT $3`,[context.account.id,cursor,count+1])).rows;
        const sources:RemoteRetrievalSource[]=[];let processed=0,bytes=0,last=cursor;
        for(const row of rows.slice(0,count)){
          check(call);if(bytes+row.size_bytes>L.sourceBytes)break;bytes+=row.size_bytes;
          try{sources.push((await loadSource(context,row.id,call)).source);}
          catch(e){if(!(e instanceof ApiError)||!['REMOTE_RETRIEVAL_SOURCE_UNAVAILABLE','REMOTE_RETRIEVAL_SOURCE_CHANGED','REMOTE_RETRIEVAL_SOURCE_INVALID'].includes(e.code))throw e;}
          processed++;last=row.id;
        }
        const hasMore=processed<rows.length;
        if(hasMore&&processed===0)throw new ApiError('REMOTE_RETRIEVAL_LIMIT',413);
        return{sources,nextCursor:hasMore?last:null,hasMore};
      });
    }); },
    source(identity,id,call={}) { return checked(async()=>{const taskId=remoteRetrievalId(id);return run(identity,async context=>({source:(await loadSource(context,taskId,call)).source}));}); },
    retrieve(identity,input,call={}) { return checked(async()=>{
      const request=validateRemoteRetrievalRequest(input),digest=await remoteRetrievalDigest(request);check(call);
      return run(identity,async context=>{
        check(call);const prior=await saved(context,request.requestId);
        if(prior){
          if(prior.request_digest!==digest)throw new ApiError('REMOTE_RETRIEVAL_REQUEST_REUSED',409);
          if(prior.state==='removed')throw new ApiError('REMOTE_RETRIEVAL_REMOVED',410);
          const value=await receipt(prior);await assertSourcesCurrent(context,value.request);check(call);return{replayed:true,receipt:value};
        }
        await reserve(context,request);check(call);const artifacts:RemoteIndexArtifact[]=[];
        for(const source of request.sources){const loaded=await loadSource(context,source.taskId,call,source);artifacts.push(loaded.artifact);}
        const result=await worker(request,artifacts,{signal:call.signal});check(call);
        const resultDigest=await remoteRetrievalDigest(result);
        const created=await context.client.query<ReceiptRow>(`INSERT INTO paperquay.remote_retrieval_requests
          (account_id,request_id,requester_device_id,request_digest,state,request_payload,result_payload,result_digest)
          VALUES($1,$2,$3,$4,'complete',$5,$6,$7)
          RETURNING request_id,request_digest,state,request_payload,result_payload,result_digest,created_at`,
          [context.account.id,request.requestId,context.device.id,digest,JSON.stringify(request),JSON.stringify(result),resultDigest]);
        const value=await receipt(created.rows[0]);check(call);return{replayed:false,receipt:value};
      });
    }); },
    lookup(identity,value) { return checked(async()=>{const id=remoteRetrievalId(value);return run(identity,async context=>{
      const row=await saved(context,id);if(!row||row.state==='removed')return emptyStatus(id,row);
      const result=await receipt(row);await assertSourcesCurrent(context,result.request);return{requestId:id,status:'complete',requestDigest:row.request_digest,receipt:result};
    });}); },
    remove(identity,value) { return checked(async()=>{const id=remoteRetrievalId(value);return run(identity,async context=>{
      const row=await saved(context,id);if(!row||row.state==='removed')return emptyStatus(id,row);
      await context.client.query("UPDATE paperquay.remote_retrieval_requests SET state='removed',request_payload=NULL,result_payload=NULL WHERE account_id=$1 AND request_id=$2",[context.account.id,id]);
      return emptyStatus(id,row);
    });}); },
  };
}
