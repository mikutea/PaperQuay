import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import { identity, operation, paper, version } from '../fixtures.ts';
import type { SyncOperation } from '../../../packages/sync-core/src/index.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Use an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const store = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 67) });
before(async () => { assert.equal(await store.ready(), true); });
after(async () => { await pool.end(); });

async function fixture() {
  const consumer = identity(); const provider = { ...consumer, sessionId: randomUUID() };
  const consumerView = await store.registerDevice(consumer, { name: 'Synthetic desktop consumer', platform: 'web' });
  const providerView = await store.registerDevice(provider, { name: 'Synthetic desktop provider', platform: 'windows' });
  const parent = operation('paper', { ...paper(), abstractText: 'Excluded private body' });
  const attachment = operation('attachmentVersion', version(parent.entityId));
  const push = async (operations: SyncOperation[]) => {
    const result = await store.push(consumer, { protocolVersion: 1, deviceId: consumerView.device.id, operations });
    assert.ok(result.results.every((item) => item.status === 'applied'), JSON.stringify(result));
    return result;
  };
  await push([parent, attachment]);
  const target = await store.getDesktopPdfVersion(consumer, attachment.entityId);
  return { consumer, provider, consumerView, providerView, parent, attachment, push, target };
}

test('real Postgres desktop metadata is account-scoped, projected, keyset-paginated and read-only', async () => {
  const f = await fixture();
  const second = operation('attachmentVersion', version(f.parent.entityId));
  const third = operation('attachmentVersion', version(f.parent.entityId));
  await f.push([second, third]);
  const before = await store.desktopPdfSession(f.consumer);
  const found = await store.getDesktopPdfVersion(f.consumer, f.attachment.entityId);
  assert.deepEqual(Object.keys(found.paper).sort(), ['entityId', 'revision', 'title']);
  assert.ok(!JSON.stringify(found).includes('Excluded private body'));
  const one = await store.listDesktopPdfVersions(f.consumer, undefined, 2);
  assert.equal(one.items.length, 2); assert.equal(one.hasMore, true); assert.equal(one.nextAfter, one.items[1].version.entityId);
  const two = await store.listDesktopPdfVersions(f.consumer, one.nextAfter!, 2);
  assert.equal(two.items.length, 1); assert.equal(two.hasMore, false); assert.equal(two.nextAfter, null);
  assert.equal(new Set([...one.items, ...two.items].map((item) => item.version.entityId)).size, 3);
  assert.equal((await store.desktopPdfSession(f.consumer)).device.lastSeenAt, before.device.lastSeenAt);
  await assert.rejects(store.listDesktopPdfVersions(f.consumer, undefined, 101), { code: 'VALIDATION_FAILED' });
  const other = identity(); await store.registerDevice(other, { name: 'Other synthetic account', platform: 'web' });
  assert.deepEqual((await store.listDesktopPdfVersions(other, undefined, 25)).items, []);
  for (const id of [f.attachment.entityId, randomUUID()]) await assert.rejects(store.getDesktopPdfVersion(other, id), { code: 'NOT_FOUND' });
});

test('real transfer checks require two active sessions in the same account and preserve consumer login on provider revocation', async () => {
  const f = await fixture(); const before = await store.desktopPdfSession(f.consumer);
  const result = await store.checkDesktopPdfTransfer(f.consumer, f.provider, f.target);
  assert.deepEqual(result, { accountId: f.consumerView.accountId, consumerDeviceId: f.consumerView.device.id, providerDeviceId: f.providerView.device.id });
  assert.equal((await store.desktopPdfSession(f.consumer)).device.lastSeenAt, before.device.lastSeenAt);
  await assert.rejects(store.checkDesktopPdfTransfer(f.consumer, f.consumer, f.target), { code: 'NOT_FOUND' });
  const other = identity(); await store.registerDevice(other, { name: 'Other provider', platform: 'windows' });
  await assert.rejects(store.checkDesktopPdfTransfer(f.consumer, other, f.target), { code: 'NOT_FOUND' });
  await store.revokeDevice(f.consumer, f.providerView.device.id);
  await assert.rejects(store.checkDesktopPdfTransfer(f.consumer, f.provider, f.target), { code: 'DESKTOP_PDF_UNAVAILABLE' });
  assert.equal((await store.desktopPdfSession(f.consumer)).device.revokedAt, null);
  await store.revokeDevice(f.consumer, f.consumerView.device.id);
  await assert.rejects(store.checkDesktopPdfTransfer(f.consumer, null, f.target), { code: 'SESSION_REVOKED' });
});

test('version delete/restore and parent mutation cannot revive an older transfer authorization', async () => {
  const f = await fixture();
  await f.push([operation('attachmentVersion', null, { entityId: f.attachment.entityId, mutation: 'delete', baseRevision: 1 })]);
  assert.deepEqual((await store.listDesktopPdfVersions(f.consumer, undefined, 25)).items, []);
  await assert.rejects(store.checkDesktopPdfTransfer(f.consumer, f.provider, f.target), { code: 'ATTACHMENT_VERSION_UNAVAILABLE' });
  await f.push([operation('attachmentVersion', f.attachment.data, { entityId: f.attachment.entityId, mutation: 'restore', baseRevision: 2 })]);
  await assert.rejects(store.checkDesktopPdfTransfer(f.consumer, f.provider, f.target), { code: 'DESKTOP_PDF_CHANGED' });
  const fresh = await store.getDesktopPdfVersion(f.consumer, f.attachment.entityId);
  await store.checkDesktopPdfTransfer(f.consumer, f.provider, fresh);
  await f.push([operation('paper', null, { entityId: f.parent.entityId, mutation: 'delete', baseRevision: 1 })]);
  await assert.rejects(store.getDesktopPdfVersion(f.consumer, f.attachment.entityId), { code: 'ATTACHMENT_VERSION_UNAVAILABLE' });
  assert.deepEqual((await store.listDesktopPdfVersions(f.consumer, undefined, 25)).items, []);
});

test('stream revalidation does not wait behind an unrelated account write lock', async () => {
  const f = await fixture(); const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '2s'");
    await client.query("SELECT set_config('paperquay.issuer',$1,true), set_config('paperquay.subject',$2,true), set_config('paperquay.account_id',$3,true)",
      [f.consumer.issuer, f.consumer.subject, f.consumerView.accountId]);
    await client.query('SELECT id FROM paperquay.accounts WHERE id = $1 FOR UPDATE', [f.consumerView.accountId]);
    const start = performance.now();
    await store.checkDesktopPdfTransfer(f.consumer, f.provider, f.target);
    assert.ok(performance.now() - start < 1500, 'read-only validation must not join the account write-lock queue');
  } finally { await client.query('ROLLBACK'); client.release(); }
});
