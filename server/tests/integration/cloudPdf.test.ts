import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { SERVER_LIMITS } from '../../src/config.ts';
import { PostgresSyncStore } from '../../src/store.ts';
import type { VerifiedIdentity } from '../../src/auth.ts';
import type { SessionView } from '../../src/types.ts';
import type { SyncOperation } from '../../../packages/sync-core/src/index.ts';
import { identity, operation, paper, version } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Use an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
const options = { pool, cursorSecret: Buffer.alloc(32, 37), cloudPdfEnabled: true };
const store = new PostgresSyncStore(options);
const bytes = Buffer.from('%PDF-1.7\nSynthetic integration content, not a full semantic PDF.\n%%EOF\n');
before(async () => { assert.equal(await store.ready(), true, 'Apply migrations and runtime grants first.'); });
after(async () => { await pool.end(); });

async function push(who: VerifiedIdentity, view: SessionView, op: SyncOperation, target = store) {
  const result = (await target.push(who, { protocolVersion: 1, deviceId: view.device.id, operations: [op] })).results[0];
  assert.equal(result.status, 'applied', result.code);
  return result;
}
async function fixture(content = bytes, target = store) {
  const who = identity();
  const view = await target.registerDevice(who, { name: 'Synthetic cloud PDF test', platform: 'web' });
  const parent = operation('paper', paper());
  const attachment = operation('attachmentVersion', { ...version(parent.entityId),
    sizeBytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') });
  await push(who, view, parent, target);
  await push(who, view, attachment, target);
  return { who, view, parent, attachment, content };
}
async function upload(f: Awaited<ReturnType<typeof fixture>>, target = store) {
  const admitted = await target.prepareCloudPdfUpload(f.who, f.attachment.entityId);
  return target.putCloudPdf(f.who, f.attachment.entityId, f.content, admitted.generation);
}
async function inAccount<T>(f: Awaited<ReturnType<typeof fixture>>, action: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('paperquay.issuer',$1,true),set_config('paperquay.subject',$2,true),set_config('paperquay.account_id',$3,true)",
      [f.who.issuer, f.who.subject, f.view.accountId]);
    return await action(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

test('cloud bytes round-trip privately, exact duplicate uploads do not charge twice, and deletion preserves sync state', async () => {
  const f = await fixture(); const before = await store.pull(f.who, undefined, 100);
  const first = await upload(f);
  assert.equal(first.replayed, false);
  assert.equal(first.copy.available, true);
  assert.equal(first.quota.usedBytes, bytes.byteLength);
  const again = await upload(f);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.copy, first.copy);
  assert.deepEqual(again.quota, first.quota);
  assert.deepEqual((await store.downloadCloudPdf(f.who, f.attachment.entityId)).content, bytes);
  assert.deepEqual((await store.listCloudPdfs(f.who)).copies, [first.copy]);
  const counters = await inAccount(f, (client) => client.query(`SELECT a.cloud_pdf_bytes,a.cloud_pdf_count,
    (SELECT coalesce(sum(size_bytes),0)::text FROM paperquay.cloud_pdfs WHERE account_id=a.id) AS actual_bytes
    FROM paperquay.accounts a WHERE id=$1`, [f.view.accountId]));
  assert.deepEqual(counters.rows[0], { cloud_pdf_bytes: String(bytes.byteLength), cloud_pdf_count: 1, actual_bytes: String(bytes.byteLength) });
  const removed = await store.deleteCloudPdf(f.who, f.attachment.entityId);
  assert.equal(removed.deleted, true);
  assert.equal(removed.quota.usedBytes, 0);
  assert.equal(removed.quota.usedCopies, 0);
  assert.equal((await store.deleteCloudPdf(f.who, f.attachment.entityId)).deleted, false);
  assert.equal((await store.getCloudPdf(f.who, f.attachment.entityId)).copy, null);
  assert.deepEqual(await store.pull(f.who, undefined, 100), before, 'cloud upload/delete never alter metadata revision, feed or cursor');
  await assert.rejects(store.downloadCloudPdf(f.who, f.attachment.entityId), { code: 'CLOUD_PDF_NOT_FOUND' });
});

test('other accounts cannot enumerate or use a cloud version, including colliding attachment UUIDs and RLS queries', async () => {
  const a = await fixture(); const b = await fixture(); await upload(a);
  assert.deepEqual((await store.listCloudPdfs(b.who)).copies, []);
  for (const action of [
    () => store.getCloudPdf(b.who, a.attachment.entityId),
    () => store.prepareCloudPdfUpload(b.who, a.attachment.entityId),
    () => store.putCloudPdf(b.who, a.attachment.entityId, bytes, '0'),
    () => store.downloadCloudPdf(b.who, a.attachment.entityId),
    () => store.deleteCloudPdf(b.who, a.attachment.entityId),
  ]) await assert.rejects(action(), { code: 'NOT_FOUND' });
  assert.equal((await pool.query('SELECT attachment_version_id FROM paperquay.cloud_pdfs')).rowCount, 0);
  assert.equal((await inAccount(b, (client) => client.query('SELECT attachment_version_id FROM paperquay.cloud_pdfs WHERE account_id=$1', [a.view.accountId]))).rowCount, 0);
  const flags = await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', ['paperquay.cloud_pdfs']);
  assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  await assert.rejects(pool.query('UPDATE paperquay.cloud_pdfs SET file_name=file_name'), (error: { code?: string }) => error.code === '42501');
  const collision = operation('attachmentVersion', { ...b.attachment.data! }, { entityId: a.attachment.entityId });
  await push(b.who, b.view, collision);
  assert.equal((await store.getCloudPdf(b.who, a.attachment.entityId)).copy, null);
  await assert.rejects(store.downloadCloudPdf(b.who, a.attachment.entityId), { code: 'CLOUD_PDF_NOT_FOUND' });
});

test('hash, full byte count, PDF markers and 64 MiB metadata limit reject before any cloud accounting', async () => {
  const f = await fixture(); const admitted = await store.prepareCloudPdfUpload(f.who, f.attachment.entityId);
  const wrongHash = Buffer.from(bytes); wrongHash[12] ^= 1;
  for (const content of [bytes.subarray(0, bytes.byteLength - 1), Buffer.concat([bytes, Buffer.from('x')]), wrongHash]) {
    await assert.rejects(store.putCloudPdf(f.who, f.attachment.entityId, content, admitted.generation), { code: 'PDF_INTEGRITY_MISMATCH' });
  }
  const invalid = await fixture(Buffer.from('This is not a PDF even though its metadata hash matches.'));
  await assert.rejects(upload(invalid), { code: 'INVALID_PDF' });
  const noEof = await fixture(Buffer.from('%PDF-1.7\nno end marker'));
  await assert.rejects(upload(noEof), { code: 'INVALID_PDF' });
  const large = operation('attachmentVersion', { ...version(f.parent.entityId), sizeBytes: SERVER_LIMITS.cloudPdfMaxFileBytes + 1 });
  await push(f.who, f.view, large);
  await assert.rejects(store.prepareCloudPdfUpload(f.who, large.entityId), { code: 'REQUEST_TOO_LARGE' });
  assert.equal((await store.listCloudPdfs(f.who)).quota.usedBytes, 0);
  await upload(f);
  await assert.rejects(store.putCloudPdf(f.who, f.attachment.entityId, wrongHash, admitted.generation), { code: 'PDF_INTEGRITY_MISMATCH' },
    'an existing copy does not bypass request-byte verification');
});

test('quota is exact under concurrent uploads and lowering it preserves existing reads, replay and cleanup', async () => {
  const limited = new PostgresSyncStore({ ...options, cloudPdfAccountBytes: bytes.byteLength });
  const f = await fixture(bytes, limited);
  const second = operation('attachmentVersion', { ...f.attachment.data!, attachmentId: randomUUID() });
  await push(f.who, f.view, second, limited);
  const admitted = await Promise.all([limited.prepareCloudPdfUpload(f.who, f.attachment.entityId), limited.prepareCloudPdfUpload(f.who, second.entityId)]);
  const results = await Promise.allSettled([
    limited.putCloudPdf(f.who, f.attachment.entityId, bytes, admitted[0].generation),
    limited.putCloudPdf(f.who, second.entityId, bytes, admitted[1].generation),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failure.reason.code, 'CLOUD_PDF_QUOTA_EXCEEDED');
  const copies = await limited.listCloudPdfs(f.who);
  assert.equal(copies.copies.length, 1); assert.equal(copies.quota.usedBytes, bytes.byteLength);
  const winner = copies.copies[0].attachmentVersionId;
  const lowered = new PostgresSyncStore({ ...options, cloudPdfAccountBytes: 1 });
  assert.equal((await lowered.downloadCloudPdf(f.who, winner)).content.byteLength, bytes.byteLength);
  const replayAdmission = await lowered.prepareCloudPdfUpload(f.who, winner);
  assert.equal((await lowered.putCloudPdf(f.who, winner, bytes, replayAdmission.generation)).replayed, true);
  assert.equal((await lowered.deleteCloudPdf(f.who, winner)).quota.usedBytes, 0);
});

test('database copy-count boundary is 512 and its trigger rolls back a 513th insert', async () => {
  const f = await fixture();
  await inAccount(f, async (client) => {
    await client.query(`INSERT INTO paperquay.entities(account_id,entity_type,entity_id,schema_version,revision,data,updated_at,created_by_device_id,modified_by_device_id)
      SELECT $1,'attachmentVersion',gen_random_uuid(),1,1,$2::jsonb,clock_timestamp(),$3,$3 FROM generate_series(1,513)`,
    [f.view.accountId, JSON.stringify({ ...f.attachment.data!, fileName: 'count-fixture.pdf' }), f.view.device.id]);
    const ids = await client.query<{ entity_id: string }>(`SELECT entity_id FROM paperquay.entities
      WHERE account_id=$1 AND entity_type='attachmentVersion' AND data->>'fileName'='count-fixture.pdf' ORDER BY entity_id`, [f.view.accountId]);
    await client.query(`INSERT INTO paperquay.cloud_pdfs(account_id,attachment_version_id,paper_id,sha256,size_bytes,file_name,content)
      SELECT $1,id,$2,$3,$4,'count-fixture.pdf',$5 FROM unnest($6::uuid[]) AS id`,
    [f.view.accountId, f.parent.entityId, f.attachment.data!.sha256, bytes.byteLength, bytes, ids.rows.slice(0, 512).map((row) => row.entity_id)]);
    await client.query('SAVEPOINT copy_limit');
    await assert.rejects(client.query(`INSERT INTO paperquay.cloud_pdfs(account_id,attachment_version_id,paper_id,sha256,size_bytes,file_name,content)
      VALUES ($1,$2,$3,$4,$5,'count-fixture.pdf',$6)`,
    [f.view.accountId, ids.rows[512].entity_id, f.parent.entityId, f.attachment.data!.sha256, bytes.byteLength, bytes]),
    (error: { constraint?: string }) => error.constraint === 'paperquay_cloud_pdf_quota');
    await client.query('ROLLBACK TO SAVEPOINT copy_limit');
    const result = await client.query('SELECT cloud_pdf_count,cloud_pdf_bytes FROM paperquay.accounts WHERE id=$1', [f.view.accountId]);
    assert.deepEqual(result.rows[0], { cloud_pdf_count: 512, cloud_pdf_bytes: String(512 * bytes.byteLength) });
  });
  assert.equal((await store.listCloudPdfs(f.who)).quota.usedCopies, 0, 'rollback-only boundary fixture does not retain 512 files');
});

test('tombstoned versions or papers keep a visible charged copy but block upload/download until explicit cleanup', async () => {
  for (const type of ['paper', 'attachmentVersion'] as const) {
    const f = await fixture(); const original = await upload(f);
    const target = type === 'paper' ? f.parent : f.attachment;
    await push(f.who, f.view, operation(type, null, { entityId: target.entityId, baseRevision: 1, mutation: 'delete' }));
    assert.deepEqual((await store.getCloudPdf(f.who, f.attachment.entityId)).copy, { ...original.copy, available: false });
    assert.equal((await store.listCloudPdfs(f.who)).quota.usedBytes, bytes.byteLength);
    await assert.rejects(store.prepareCloudPdfUpload(f.who, f.attachment.entityId), { code: 'ATTACHMENT_VERSION_UNAVAILABLE' });
    await assert.rejects(store.putCloudPdf(f.who, f.attachment.entityId, bytes, '0'), { code: 'ATTACHMENT_VERSION_UNAVAILABLE' });
    await assert.rejects(store.downloadCloudPdf(f.who, f.attachment.entityId), { code: 'ATTACHMENT_VERSION_UNAVAILABLE' });
    assert.equal((await store.deleteCloudPdf(f.who, f.attachment.entityId)).quota.usedBytes, 0);
  }
});

test('delete invalidates in-flight uploads even for absent copies, while a later explicit admission can upload', async () => {
  const f = await fixture();
  for (const existing of [false, true]) {
    if (existing) await upload(f);
    const admitted = await store.prepareCloudPdfUpload(f.who, f.attachment.entityId);
    const removed = await store.deleteCloudPdf(f.who, f.attachment.entityId);
    assert.equal(removed.deleted, existing);
    await assert.rejects(store.putCloudPdf(f.who, f.attachment.entityId, bytes, admitted.generation), { code: 'CLOUD_PDF_CHANGED' });
    assert.equal((await store.getCloudPdf(f.who, f.attachment.entityId)).copy, null);
  }
  assert.equal((await upload(f)).replayed, false);
});

test('revocation or metadata tombstone between admission and commit is rechecked, including duplicate uploads', async () => {
  const f = await fixture(); await upload(f);
  const admitted = await store.prepareCloudPdfUpload(f.who, f.attachment.entityId);
  const peer = { ...f.who, sessionId: randomUUID() };
  await store.registerDevice(peer, { name: 'Revoker', platform: 'web' });
  await store.revokeDevice(peer, f.view.device.id);
  for (const action of [
    () => store.listCloudPdfs(f.who), () => store.getCloudPdf(f.who, f.attachment.entityId),
    () => store.prepareCloudPdfUpload(f.who, f.attachment.entityId),
    () => store.putCloudPdf(f.who, f.attachment.entityId, bytes, admitted.generation),
    () => store.downloadCloudPdf(f.who, f.attachment.entityId), () => store.deleteCloudPdf(f.who, f.attachment.entityId),
  ]) await assert.rejects(action(), { code: 'SESSION_REVOKED' });
  assert.equal((await store.listCloudPdfs(peer)).quota.usedBytes, bytes.byteLength);
  const g = await fixture();
  const admission = await store.prepareCloudPdfUpload(g.who, g.attachment.entityId);
  await push(g.who, g.view, operation('attachmentVersion', null, { entityId: g.attachment.entityId, baseRevision: 1, mutation: 'delete' }));
  await assert.rejects(store.putCloudPdf(g.who, g.attachment.entityId, bytes, admission.generation), { code: 'ATTACHMENT_VERSION_UNAVAILABLE' });
  assert.equal((await store.listCloudPdfs(g.who)).quota.usedBytes, 0);
});

test('upload and delete commit faults roll back bytea, quota and generation together', async () => {
  const f = await fixture(); let fail: 'cloud-put' | 'cloud-delete' | null = 'cloud-put';
  const faulty = new PostgresSyncStore({ ...options, hooks: { beforeCommit: async ({ kind }) => {
    if (kind === fail) throw Object.assign(new Error('synthetic transient failure'), { code: '40001' });
  } } });
  await assert.rejects(upload(f, faulty), { code: '40001' });
  assert.equal((await store.listCloudPdfs(f.who)).quota.usedBytes, 0);
  fail = null; await upload(f, faulty);
  const admitted = await store.prepareCloudPdfUpload(f.who, f.attachment.entityId);
  fail = 'cloud-delete';
  await assert.rejects(faulty.deleteCloudPdf(f.who, f.attachment.entityId), { code: '40001' });
  assert.equal((await store.getCloudPdf(f.who, f.attachment.entityId)).copy?.available, true);
  assert.equal((await store.putCloudPdf(f.who, f.attachment.entityId, bytes, admitted.generation)).replayed, true,
    'failed deletion did not advance the admission generation');
  fail = null;
  assert.equal((await faulty.deleteCloudPdf(f.who, f.attachment.entityId)).quota.usedBytes, 0);
});

test('database independently enforces bytea size/hash and explicit cloud deletion does not release retained metadata budget', async () => {
  const f = await fixture();
  const retained = await inAccount(f, async (client) => (await client.query('SELECT retained_bytes FROM paperquay.accounts WHERE id=$1', [f.view.accountId])).rows[0].retained_bytes);
  await inAccount(f, async (client) => {
    await client.query('SAVEPOINT invalid_content');
    const changed = Buffer.from(bytes); changed[12] ^= 1;
    await assert.rejects(client.query(`INSERT INTO paperquay.cloud_pdfs(account_id,attachment_version_id,paper_id,sha256,size_bytes,file_name,content)
      VALUES ($1,$2,$3,$4,$5,'synthetic.pdf',$6)`,
    [f.view.accountId, f.attachment.entityId, f.parent.entityId, f.attachment.data!.sha256, bytes.byteLength, changed]),
    (error: { code?: string }) => error.code === '23514');
    await client.query('ROLLBACK TO SAVEPOINT invalid_content');
    assert.equal((await client.query('SELECT cloud_pdf_bytes FROM paperquay.accounts WHERE id=$1', [f.view.accountId])).rows[0].cloud_pdf_bytes, '0');
  });
  await upload(f); await store.deleteCloudPdf(f.who, f.attachment.entityId);
  assert.equal(await inAccount(f, async (client) => (await client.query('SELECT retained_bytes FROM paperquay.accounts WHERE id=$1', [f.view.accountId])).rows[0].retained_bytes), retained);
});
