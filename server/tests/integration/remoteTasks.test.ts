import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import type { RemoteIndexArtifact, RemoteTaskRequest } from '../../../packages/sync-core/src/remoteTasks.ts';
import { ApiError } from '../../src/errors.ts';
import { createRemoteTaskRepository } from '../../src/remote-task-store.ts';
import type { RemoteTaskAccountRunner, RemoteTaskTransaction } from '../../src/remote-task-store.ts';
import { PostgresSyncStore } from '../../src/store.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import { identity, operation, paper, version } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Use an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
const sync = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 53) });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Exercise the injected contract with the same account lock, RLS and current
// registration checks as production. No queue or persistence is mocked here.
const withAccount: RemoteTaskAccountRunner = async <T>(who: VerifiedIdentity, work: (context: RemoteTaskTransaction) => Promise<T>) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SELECT set_config('paperquay.issuer',$1,true),set_config('paperquay.subject',$2,true)", [who.issuer, who.subject]);
    const owner = await client.query<{ id: string }>('SELECT id FROM paperquay.accounts WHERE issuer=$1 AND subject=$2 FOR UPDATE', [who.issuer, who.subject]);
    if (!owner.rows[0]) throw new ApiError('DEVICE_NOT_REGISTERED', 403);
    const account = owner.rows[0];
    await client.query("SELECT set_config('paperquay.account_id',$1,true)", [account.id]);
    const registration = await client.query<{ id: string; revoked_at: Date | null }>('SELECT id,revoked_at FROM paperquay.devices WHERE account_id=$1 AND session_id=$2', [account.id, who.sessionId]);
    if (!registration.rows[0]) throw new ApiError('DEVICE_NOT_REGISTERED', 403);
    if (registration.rows[0].revoked_at) throw new ApiError('SESSION_REVOKED', 403);
    const result = await work({ client, account, device: { id: registration.rows[0].id } });
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};
const repository = createRemoteTaskRepository({ withAccount });
before(async () => { assert.equal(await sync.ready(), true, 'Apply all migrations and runtime grants first.'); });
after(async () => { await pool.end(); });
const profiles = [
  { id: 'mineru', revision: 1, digest: 'b'.repeat(64), kind: 'parse' as const, model: 'vlm' },
  { id: 'embedding', revision: 1, digest: 'c'.repeat(64), kind: 'index' as const, model: 'synthetic-embedding' },
];
async function fixture(pageCount: number | null = 2) {
  const who = identity(); const desktop = { ...identity(), subject: who.subject, expiresAtMs: Date.now() + 3600000 };
  const consumer = await sync.registerDevice(who, { name: 'Synthetic remote consumer', platform: 'web' });
  const provider = await sync.registerDevice(desktop, { name: 'Synthetic remote provider', platform: 'linux' });
  const parent = operation('paper', paper()); const attachment = operation('attachmentVersion', version(parent.entityId, pageCount));
  for (const op of [parent, attachment]) assert.equal((await sync.push(who, { protocolVersion: 1, deviceId: consumer.device.id, operations: [op] })).results[0].status, 'applied');
  await repository.publishProvider(desktop, profiles);
  const request: RemoteTaskRequest = { requestId: randomUUID(), kind: 'parse', versionId: attachment.entityId,
    providerDeviceId: provider.device.id, profileRef: { id: profiles[0].id, revision: 1, digest: profiles[0].digest } };
  const document = { format: 'paperquay-parsed-document', version: 1, paperId: parent.entityId, attachmentVersionId: attachment.entityId,
    pdf: { sha256: attachment.data!.sha256, sizeBytes: attachment.data!.sizeBytes, pageCount: 2 }, parser: { name: 'mineru', model: 'vlm' },
    blocks: [{ id: 'p1', pageIndex: 0, kind: 'text', text: 'Synthetic parse output.' }], assets: [] };
  return { who, desktop, consumer, provider, parent, attachment, request, document, content: Buffer.from(JSON.stringify(document)) };
}
test('persistent tasks survive repository recreation and canonical completion replay without duplicate execution', async () => {
  const f = await fixture();
  const first = await repository.createTask(f.who, f.request); assert.equal(first.task.state, 'queued');
  const replay = await repository.createTask(f.who, f.request); assert.equal(replay.replayed, true); assert.equal(replay.task.id, first.task.id);
  await assert.rejects(repository.createTask(f.who, { ...f.request, profileRef: { ...f.request.profileRef, revision: 2 } }), { code: 'REMOTE_TASK_REQUEST_REUSED' });
  const duplicate = await repository.createTask(f.who, { ...f.request, requestId: randomUUID() });
  assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.task.id, first.task.id); assert.equal(duplicate.quota.retained, 1);
  const claim = (await repository.claimTask(f.desktop)).claim!;
  assert.equal(claim.task.state, 'running'); assert.equal(claim.lease.attempt, 1);
  assert.equal((await repository.claimTask(f.desktop)).claim, null, 'one active task per account');
  const restarted = createRemoteTaskRepository({ withAccount });
  assert.equal((await restarted.getTask(f.who, first.task.id)).task.state, 'running');
  assert.equal((await restarted.heartbeatTask(f.desktop, first.task.id, claim.lease)).task.attempt, 1);
  await restarted.prepareArtifactUpload(f.desktop, first.task.id, claim.lease);
  const completed = await restarted.completeTask(f.desktop, first.task.id, claim.lease, f.content);
  assert.equal(completed.task.state, 'succeeded'); assert.equal(completed.replayed, false);
  const again = await restarted.completeTask(f.desktop, first.task.id, claim.lease, Buffer.from(' \n' + f.content.toString() + '\n'));
  assert.equal(again.replayed, true); assert.equal(again.task.artifact!.digest, hash(f.content));
  const downloaded = await repository.downloadArtifact(f.who, first.task.id);
  assert.deepEqual(downloaded.content, f.content); assert.equal(downloaded.artifact.digest, hash(f.content));
  assert.equal((await repository.listTasks(f.who)).quota.artifactBytes, f.content.byteLength);
  await assert.rejects(repository.completeTask(f.desktop, first.task.id, { ...claim.lease, fence: randomUUID() }, f.content), { code: 'REMOTE_TASK_LEASE_CHANGED' });
  await assert.rejects(repository.completeTask(f.desktop, first.task.id, claim.lease,
    Buffer.from(JSON.stringify({ ...f.document, blocks: [{ ...f.document.blocks[0], text: 'Changed valid parse output.' }] }))), { code: 'REMOTE_TASK_LEASE_CHANGED' });
});
test('cancellation fences late results and completion/cancel races never retain an artifact for a cancelled task', async () => {
  const f = await fixture(); const task = (await repository.createTask(f.who, f.request)).task;
  const claim = (await repository.claimTask(f.desktop)).claim!;
  assert.equal((await repository.cancelTask(f.who, task.id)).task.state, 'cancel_requested');
  assert.equal((await repository.completeTask(f.desktop, task.id, claim.lease, f.content)).task.state, 'cancelled');
  await assert.rejects(repository.downloadArtifact(f.who, task.id), { code: 'REMOTE_TASK_ARTIFACT_NOT_FOUND' });
  await assert.rejects(repository.heartbeatTask(f.desktop, task.id, claim.lease), { code: 'REMOTE_TASK_LEASE_CHANGED' });
  assert.equal((await repository.resumeTask(f.who, task.id)).task.state, 'queued');
  const next = (await repository.claimTask(f.desktop)).claim!; assert.equal(next.lease.attempt, 2); assert.notEqual(next.lease.fence, claim.lease.fence);
  const settled = await Promise.all([repository.cancelTask(f.who, task.id), repository.completeTask(f.desktop, task.id, next.lease, f.content)]);
  const final = (await repository.getTask(f.who, task.id)).task;
  assert.ok(['succeeded', 'cancelled'].includes(final.state));
  if (final.state === 'cancelled') assert.equal(final.artifact, null);
  else assert.equal(final.artifact!.digest, hash(f.content));
  assert.equal(settled.length, 2);
});
test('title/file-name revisions and newly learned page counts preserve paid work while known counts still bind artifacts', async () => {
  const f = await fixture(null); const first = (await repository.createTask(f.who, f.request)).task;
  const claim = (await repository.claimTask(f.desktop)).claim!;
  for (const change of [
    operation('paper', { ...f.parent.data!, title: 'Renamed synthetic paper' }, { entityId: f.parent.entityId, baseRevision: 1 }),
    operation('attachmentVersion', { ...f.attachment.data!, fileName: 'renamed.pdf', pageCount: 2 }, { entityId: f.attachment.entityId, baseRevision: 1 }),
  ]) assert.equal((await sync.push(f.who, { protocolVersion: 1, deviceId: f.consumer.device.id, operations: [change] })).results[0].status, 'applied');
  const duplicate = await repository.createTask(f.who, { ...f.request, requestId: randomUUID() });
  assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.task.id, first.id);
  await assert.rejects(repository.completeTask(f.desktop, first.id, claim.lease,
    Buffer.from(JSON.stringify({ ...f.document, pdf: { ...f.document.pdf, pageCount: 3 } }))), { code: 'REMOTE_TASK_ARTIFACT_TARGET_MISMATCH' });
  const completed = (await repository.completeTask(f.desktop, first.id, claim.lease, f.content)).task;
  assert.equal(completed.state, 'succeeded'); assert.equal(completed.target.pageCount, 2, 'an unknown count adopts the verified artifact count');
  assert.deepEqual((await repository.downloadArtifact(f.who, first.id)).content, f.content);
});
test('expired and uncertain attempts persist interruption and require explicit resume with a fresh fence', async () => {
  const f = await fixture(); const task = (await repository.createTask(f.who, f.request)).task;
  const claim = (await repository.claimTask(f.desktop)).claim!;
  await withAccount(f.who, ({ client, account }) => client.query(`UPDATE paperquay.remote_tasks SET lease_expires_at=clock_timestamp()-interval '1 second'
    WHERE account_id=$1 AND id=$2`, [account.id, task.id]));
  const expired = (await repository.getTask(f.who, task.id)).task;
  assert.equal(expired.state, 'interrupted'); assert.equal(expired.failure, 'LEASE_EXPIRED');
  assert.equal((await repository.claimTask(f.desktop)).claim, null, 'interruption never automatically requeues');
  await assert.rejects(repository.completeTask(f.desktop, task.id, claim.lease, f.content), { code: 'REMOTE_TASK_LEASE_CHANGED' });
  await repository.resumeTask(f.who, task.id); const second = (await repository.claimTask(f.desktop)).claim!;
  assert.equal(second.lease.attempt, 2);
  const uncertain = await repository.failTask(f.desktop, task.id, { ...second.lease, code: 'EXTERNAL_OUTCOME_UNKNOWN' });
  assert.equal(uncertain.task.state, 'interrupted'); assert.equal(uncertain.task.failure, 'EXTERNAL_OUTCOME_UNKNOWN');
  assert.equal((await repository.claimTask(f.desktop)).claim, null);
});
test('only explicitly published desktop profiles can execute and configuration changes cannot complete old work', async () => {
  const f = await fixture();
  await assert.rejects(repository.publishProvider(f.who, profiles), { code: 'REMOTE_TASK_PROVIDER_REQUIRED' });
  await assert.rejects(repository.createTask(f.who, { ...f.request, profileRef: { ...f.request.profileRef, digest: '0'.repeat(64) } }), { code: 'REMOTE_TASK_PROFILE_CHANGED' });
  const task = (await repository.createTask(f.who, f.request)).task; const claim = (await repository.claimTask(f.desktop)).claim!;
  await repository.publishProvider(f.desktop, [{ ...profiles[0], revision: 2, digest: 'e'.repeat(64) }]);
  await assert.rejects(repository.completeTask(f.desktop, task.id, claim.lease, f.content), { code: 'REMOTE_TASK_PROFILE_CHANGED' });
  await repository.withdrawProvider(f.desktop);
  assert.equal((await repository.getTask(f.who, task.id)).task.state, 'interrupted');
  assert.deepEqual((await repository.listProviders(f.who)).providers, []);
  await assert.rejects(repository.resumeTask(f.who, task.id), { code: 'REMOTE_TASK_PROVIDER_UNAVAILABLE' });
});
test('source binding, artifact integrity and account/RLS isolation are checked before committing success', async () => {
  const a = await fixture(); const b = await fixture();
  const task = (await repository.createTask(a.who, a.request)).task; const claim = (await repository.claimTask(a.desktop)).claim!;
  await assert.rejects(repository.createTask(b.who, { ...a.request, requestId: randomUUID() }), { code: 'NOT_FOUND' });
  await assert.rejects(repository.getTask(b.who, task.id), { code: 'REMOTE_TASK_NOT_FOUND' });
  await assert.rejects(repository.completeTask(b.desktop, task.id, claim.lease, a.content), { code: 'REMOTE_TASK_NOT_FOUND' });
  await assert.rejects(repository.completeTask(a.desktop, task.id, claim.lease,
    Buffer.from(JSON.stringify({ ...a.document, paperId: b.parent.entityId }))), { code: 'REMOTE_TASK_ARTIFACT_TARGET_MISMATCH' });
  await assert.rejects(repository.completeTask(a.desktop, task.id, claim.lease, Buffer.from('{"version":1,"version":1}')), { code: 'REMOTE_TASK_ARTIFACT_INVALID' });
  assert.equal((await repository.getTask(a.who, task.id)).task.state, 'running');
  assert.equal((await repository.listTasks(a.who)).quota.artifactBytes, 0);
  for (const table of ['remote_tasks', 'remote_task_requests', 'remote_task_providers', 'remote_task_artifacts']) {
    assert.equal((await pool.query(`SELECT 1 FROM paperquay.${table}`)).rowCount, 0);
    assert.equal((await withAccount(b.who, ({ client }) => client.query(`SELECT 1 FROM paperquay.${table} WHERE account_id=$1`, [a.consumer.accountId]))).rowCount, 0);
    const flags = await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', ['paperquay.' + table]);
    assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  }
  await sync.revokeDevice(a.who, a.provider.device.id);
  const revoked = (await repository.getTask(a.who, task.id)).task;
  assert.equal(revoked.state, 'interrupted'); assert.equal(revoked.failure, 'SESSION_REVOKED');
  await assert.rejects(repository.completeTask(a.desktop, task.id, claim.lease, a.content), { code: 'SESSION_REVOKED' });
});
test('index artifacts bind PDF, parse digest, model, chunker, dimensions, count and content hash', async () => {
  const f = await fixture(); const parseDigest = hash(f.content);
  const input: RemoteTaskRequest = { ...f.request, kind: 'index', indexSourceDigest: parseDigest,
    profileRef: { id: profiles[1].id, revision: 1, digest: profiles[1].digest } };
  const task = (await repository.createTask(f.who, input)).task; const claim = (await repository.claimTask(f.desktop)).claim!;
  const chunks = [{ id: 'c0', pageIndex: 0, text: 'Synthetic chunk', vector: [0.25, -0.5] }];
  const document: RemoteIndexArtifact = { format: 'paperquay-vector-index', version: 1, paperId: f.parent.entityId,
    attachmentVersionId: f.attachment.entityId, pdf: f.document.pdf, parseDigest, model: profiles[1].model,
    chunker: { id: 'parsed-v1', revision: 1, digest: 'd'.repeat(64) }, dimension: 2, chunkCount: 1, contentHash: hash(JSON.stringify(chunks)), chunks };
  for (const [patch, code] of [
    [{ parseDigest: '0'.repeat(64) }, 'REMOTE_TASK_ARTIFACT_TARGET_MISMATCH'],
    [{ model: 'wrong-model' }, 'REMOTE_TASK_ARTIFACT_TARGET_MISMATCH'],
    [{ contentHash: '0'.repeat(64) }, 'REMOTE_TASK_ARTIFACT_INVALID'],
    [{ dimension: 3 }, 'REMOTE_TASK_ARTIFACT_INVALID'],
    [{ chunkCount: 2 }, 'REMOTE_TASK_ARTIFACT_INVALID'],
  ] as const) await assert.rejects(repository.completeTask(f.desktop, task.id, claim.lease, Buffer.from(JSON.stringify({ ...document, ...patch }))), { code });
  assert.equal((await repository.completeTask(f.desktop, task.id, claim.lease, Buffer.from(JSON.stringify(document)))).task.state, 'succeeded');
  assert.deepEqual(JSON.parse((await repository.downloadArtifact(f.who, task.id)).content.toString()), document);
});
test('bounded queue and retained request tombstones prevent silent eviction and paid replay after cleanup', async () => {
  const f = await fixture(); const task = (await repository.createTask(f.who, f.request)).task;
  await repository.cancelTask(f.who, task.id);
  assert.equal((await repository.deleteTask(f.who, task.id)).deleted, true);
  assert.equal((await repository.listTasks(f.who)).quota.receipts, 1);
  await assert.rejects(repository.createTask(f.who, f.request), { code: 'REMOTE_TASK_GONE' });
  const replacement = { ...f.request, requestId: randomUUID() };
  await repository.createTask(f.who, replacement);
  for (let i = 1; i < 16; i++) {
    const attachment = operation('attachmentVersion', version(f.parent.entityId, 2));
    assert.equal((await sync.push(f.who, { protocolVersion: 1, deviceId: f.consumer.device.id, operations: [attachment] })).results[0].status, 'applied');
    await repository.createTask(f.who, { ...f.request, requestId: randomUUID(), versionId: attachment.entityId });
  }
  assert.equal((await repository.listTasks(f.who)).quota.queued, 16);
  const extra = operation('attachmentVersion', version(f.parent.entityId, 2));
  await sync.push(f.who, { protocolVersion: 1, deviceId: f.consumer.device.id, operations: [extra] });
  await assert.rejects(repository.createTask(f.who, { ...f.request, requestId: randomUUID(), versionId: extra.entityId }), { code: 'REMOTE_TASK_QUEUE_FULL' });
});
test('SQL artifact quotas are independent, immutable and release atomically with explicit terminal cleanup', async () => {
  const f = await fixture(); const task = (await repository.createTask(f.who, f.request)).task;
  await repository.cancelTask(f.who, task.id);
  const ids = [task.id, randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await withAccount(f.who, async ({ client, account, device }) => {
    for (const id of ids.slice(1)) await client.query(`INSERT INTO paperquay.remote_tasks(account_id,id,requester_device_id,provider_device_id,
      kind,state,target,profile,dedupe_digest) VALUES($1,$2,$3,$4,'parse','cancelled',$5,$6,$7)`,
    [account.id, id, device.id, f.provider.device.id, JSON.stringify(task.target), JSON.stringify(profiles[0]), hash(id)]);
  });
  // Deliberately exercise bytea constraints directly, independently of the
  // stricter application-level portable-package validator.
  const content = Buffer.alloc(16 * 1024 * 1024, 32); const digest = hash(content);
  await withAccount(f.who, async ({ client, account }) => {
    for (const id of ids.slice(0, 4)) await client.query(`INSERT INTO paperquay.remote_task_artifacts(account_id,job_id,digest,size_bytes,content,completion_fence)
      VALUES($1,$2,$3,$4,$5,$6)`, [account.id, id, digest, content.byteLength, content, randomUUID()]);
  });
  assert.equal((await repository.listTasks(f.who)).quota.artifactBytes, 64 * 1024 * 1024);
  await assert.rejects(withAccount(f.who, ({ client, account }) => client.query(`INSERT INTO paperquay.remote_task_artifacts(account_id,job_id,digest,size_bytes,content,completion_fence)
    VALUES($1,$2,$3,1,$4,$5)`, [account.id, ids[4], hash(Buffer.from('x')), Buffer.from('x'), randomUUID()])),
  (error: { code?: string; constraint?: string }) => error.code === '23514' && error.constraint === 'remote_task_artifact_quota');
  await assert.rejects(withAccount(f.who, ({ client, account }) => client.query('UPDATE paperquay.remote_task_artifacts SET digest=digest WHERE account_id=$1', [account.id])),
    (error: { code?: string }) => error.code === '23514');
  await repository.deleteTask(f.who, ids[0]);
  assert.equal((await repository.listTasks(f.who)).quota.artifactBytes, 48 * 1024 * 1024);
});
test('SQL retained and idempotency budgets reject rather than silently dropping old work', async () => {
  const f = await fixture(); const original = (await repository.createTask(f.who, f.request)).task;
  await repository.cancelTask(f.who, original.id);
  const ids = Array.from({ length: 199 }, () => randomUUID());
  await withAccount(f.who, ({ client, account, device }) => client.query(`INSERT INTO paperquay.remote_tasks(account_id,id,requester_device_id,provider_device_id,
    kind,state,target,profile,dedupe_digest) SELECT $1,value::uuid,$2,$3,'parse','cancelled',$4,$5,
      encode(pg_catalog.sha256(convert_to(value,'UTF8')),'hex') FROM jsonb_array_elements_text($6::jsonb)`,
  [account.id, device.id, f.provider.device.id, JSON.stringify(original.target), JSON.stringify(profiles[0]), JSON.stringify(ids)]));
  const extra = operation('attachmentVersion', version(f.parent.entityId, 2));
  await sync.push(f.who, { protocolVersion: 1, deviceId: f.consumer.device.id, operations: [extra] });
  await assert.rejects(repository.createTask(f.who, { ...f.request, requestId: randomUUID(), versionId: extra.entityId }), { code: 'REMOTE_TASK_HISTORY_FULL' });
  const receipts = Array.from({ length: 1999 }, () => randomUUID());
  await withAccount(f.who, ({ client, account }) => client.query(`INSERT INTO paperquay.remote_task_requests(account_id,request_id,input_digest,job_id)
    SELECT $1,value::uuid,$2,NULL FROM jsonb_array_elements_text($3::jsonb)`, [account.id, 'a'.repeat(64), JSON.stringify(receipts)]));
  assert.equal((await repository.listTasks(f.who)).quota.receipts, 2000);
  await assert.rejects(repository.createTask(f.who, { ...f.request, requestId: randomUUID() }), { code: 'REMOTE_TASK_HISTORY_FULL' });
  assert.equal((await repository.createTask(f.who, f.request)).replayed, true, 'full budgets still permit exact idempotent replay');
});

test('a desktop new login session can explicitly take over an interrupted task while request replay, source and fencing remain stable',async()=>{
  const f=await fixture(),task=(await repository.createTask(f.who,f.request)).task,old=(await repository.claimTask(f.desktop)).claim!;
  const login={...identity(),subject:f.who.subject,expiresAtMs:Date.now()+3600000};
  const device=await sync.registerDevice(login,{name:'Synthetic desktop new login',platform:'windows'});assert.notEqual(device.device.id,f.provider.device.id);
  await repository.publishProvider(login,profiles);
  await withAccount(f.who,({client,account})=>client.query("UPDATE paperquay.remote_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND id=$2",[account.id,task.id]));
  assert.equal((await repository.getTask(f.who,task.id)).task.state,'interrupted');
  const choice={providerDeviceId:device.device.id,profileRef:{id:profiles[0].id,revision:profiles[0].revision,digest:profiles[0].digest}};
  const moved=(await repository.resumeTask(f.who,task.id,choice)).task;
  assert.equal(moved.providerDeviceId,device.device.id);assert.equal(moved.recoveryProviderDeviceId,f.provider.device.id);assert.equal(moved.state,'queued');
  assert.deepEqual((await repository.resumeTask(f.who,task.id,choice)).task,moved,'response-loss retry does not reassign again');
  const replay=await repository.createTask(f.who,f.request);assert.equal(replay.replayed,true);assert.equal(replay.task.id,task.id);assert.equal(replay.task.providerDeviceId,device.device.id);assert.equal(replay.quota.retained,1);
  const fresh=await repository.createTask(f.who,{...f.request,requestId:randomUUID(),providerDeviceId:device.device.id});assert.equal(fresh.deduplicated,true);assert.equal(fresh.task.id,task.id);
  assert.equal((await repository.claimTask(f.desktop)).claim,null);
  const claim=(await repository.claimTask(login)).claim!;assert.equal(claim.lease.attempt,2);assert.equal(claim.task.recoveryProviderDeviceId,f.provider.device.id);
  await assert.rejects(repository.completeTask(login,task.id,claim.lease,f.content),{code:'REMOTE_TASK_RECOVERY_REQUIRED'});
  assert.equal((await repository.confirmRecovery(login,task.id,claim.lease)).task.recoveryProviderDeviceId,device.device.id);
  await assert.rejects(repository.completeTask(f.desktop,task.id,old.lease,f.content),{code:'REMOTE_TASK_LEASE_CHANGED'});
  assert.equal((await repository.completeTask(login,task.id,claim.lease,f.content)).task.state,'succeeded');
});

test('handover cannot change a live lease, profile, account or collide with another retained paid target',async()=>{
  const f=await fixture(),task=(await repository.createTask(f.who,f.request)).task;
  const login={...identity(),subject:f.who.subject,expiresAtMs:Date.now()+3600000};
  const device=await sync.registerDevice(login,{name:'Synthetic alternate desktop',platform:'linux'});await repository.publishProvider(login,profiles);
  const choice={providerDeviceId:device.device.id,profileRef:{id:profiles[0].id,revision:1,digest:profiles[0].digest}};
  const active=(await repository.claimTask(f.desktop)).claim!;
  await assert.rejects(repository.resumeTask(f.who,task.id,choice),{code:'REMOTE_TASK_NOT_RESUMABLE'});
  await repository.failTask(f.desktop,task.id,{...active.lease,code:'EXTERNAL_OUTCOME_UNKNOWN'});
  await assert.rejects(repository.resumeTask(f.who,task.id,{...choice,profileRef:{...choice.profileRef,revision:2}}),{code:'REMOTE_TASK_PROFILE_CHANGED'});
  const foreign=await fixture();await assert.rejects(repository.resumeTask(f.who,task.id,{...choice,providerDeviceId:foreign.provider.device.id}),{code:'REMOTE_TASK_PROVIDER_UNAVAILABLE'});
  const duplicate=await repository.createTask(f.who,{...f.request,requestId:randomUUID(),providerDeviceId:device.device.id});assert.notEqual(duplicate.task.id,task.id);
  await assert.rejects(repository.resumeTask(f.who,task.id,choice),{code:'REMOTE_TASK_TARGET_BUSY'});
  assert.equal((await repository.getTask(f.who,task.id)).task.providerDeviceId,f.provider.device.id);
});

test('a failed handover preserves the last confirmed journal source and only a current fenced confirmation advances it',async()=>{
  const f=await fixture(),task=(await repository.createTask(f.who,f.request)).task,first=(await repository.claimTask(f.desktop)).claim!;
  await repository.confirmRecovery(f.desktop,task.id,first.lease);
  await repository.failTask(f.desktop,task.id,{...first.lease,code:'EXTERNAL_OUTCOME_UNKNOWN'});
  async function desktopSession(label:string){const who={...identity(),subject:f.who.subject,expiresAtMs:Date.now()+3600000};const device=await sync.registerDevice(who,{name:label,platform:'windows'});await repository.publishProvider(who,profiles);return{who,id:device.device.id};}
  const choice=(id:string)=>({providerDeviceId:id,profileRef:{id:profiles[0].id,revision:profiles[0].revision,digest:profiles[0].digest}});
  const wrong=await desktopSession('Synthetic wrong physical computer');await repository.resumeTask(f.who,task.id,choice(wrong.id));
  const second=(await repository.claimTask(wrong.who)).claim!;
  await repository.failTask(wrong.who,task.id,{...second.lease,code:'SOURCE_UNAVAILABLE'});
  assert.equal((await repository.getTask(f.who,task.id)).task.recoveryProviderDeviceId,f.provider.device.id,'missing journal did not overwrite the known holder');
  const correct=await desktopSession('Synthetic original computer new session');await repository.resumeTask(f.who,task.id,choice(correct.id));
  const third=(await repository.claimTask(correct.who)).claim!;assert.equal(third.task.recoveryProviderDeviceId,f.provider.device.id);
  const stranger=await fixture();await assert.rejects(repository.confirmRecovery(stranger.desktop,task.id,third.lease),{code:'REMOTE_TASK_NOT_FOUND'});
  await assert.rejects(repository.confirmRecovery(wrong.who,task.id,second.lease),{code:'REMOTE_TASK_LEASE_CHANGED'});
  await assert.rejects(repository.confirmRecovery(correct.who,task.id,{...third.lease,fence:randomUUID()}),{code:'REMOTE_TASK_LEASE_CHANGED'});
  assert.equal((await repository.confirmRecovery(correct.who,task.id,third.lease)).task.recoveryProviderDeviceId,correct.id);
  await repository.failTask(correct.who,task.id,{...third.lease,code:'EXTERNAL_OUTCOME_UNKNOWN'});
  const final=await desktopSession('Synthetic latest session');
  assert.equal((await repository.resumeTask(f.who,task.id,choice(final.id))).task.recoveryProviderDeviceId,correct.id,'next recovery uses progress held by the last confirmed recipient');
});

test('an unclaimed task can transfer after revocation without a nonexistent old journal, while cancel and expiry fence recovery confirmation',async()=>{
  const f=await fixture(),task=(await repository.createTask(f.who,f.request)).task;
  await sync.revokeDevice(f.who,f.provider.device.id);assert.equal((await repository.getTask(f.who,task.id)).task.state,'interrupted');
  const login={...identity(),subject:f.who.subject,expiresAtMs:Date.now()+3600000},device=await sync.registerDevice(login,{name:'Synthetic first executor',platform:'linux'});await repository.publishProvider(login,profiles);
  const moved=(await repository.resumeTask(f.who,task.id,{providerDeviceId:device.device.id,profileRef:{id:profiles[0].id,revision:1,digest:profiles[0].digest}})).task;
  assert.equal(moved.attempt,0);assert.equal(moved.recoveryProviderDeviceId,null);
  const replay=await repository.createTask(f.who,f.request);assert.equal(replay.replayed,true);assert.equal(replay.task.providerDeviceId,device.device.id);assert.equal(replay.task.recoveryProviderDeviceId,null);assert.equal(replay.quota.retained,1);
  const claim=(await repository.claimTask(login)).claim!;assert.equal(claim.lease.attempt,1);
  await repository.cancelTask(f.who,task.id);
  assert.equal((await repository.confirmRecovery(login,task.id,claim.lease)).task.state,'cancelled');
  await repository.resumeTask(f.who,task.id);const next=(await repository.claimTask(login)).claim!;
  await withAccount(f.who,({client,account})=>client.query("UPDATE paperquay.remote_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND id=$2",[account.id,task.id]));
  await assert.rejects(repository.confirmRecovery(login,task.id,next.lease),{code:'REMOTE_TASK_LEASE_CHANGED'});
});
