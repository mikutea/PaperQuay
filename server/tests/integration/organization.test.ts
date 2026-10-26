import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { PostgresSyncStore } from '../../src/store.ts';
import type { ResolveRequest } from '../../src/types.ts';
import type { PaperData, PaperOrganization, SyncOperation } from '../../../packages/sync-core/src/index.ts';
import { identity, operation, paper } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1')
  throw new Error('Use an isolated migrated database and explicitly enable synthetic integration writes.');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const store = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 61) });
before(async () => { assert.equal(await store.ready(), true); });
after(async () => { await pool.end(); });
const organization: PaperOrganization = { favorite: true, readingStatus: 'reading', tags: ['fieldwork'], collections: ['thesis'], queueRank: 2 };
const emptyOrganization: PaperOrganization = { favorite: false, readingStatus: 'unread', tags: [], collections: [], queueRank: null };
async function session() {
  const who = identity();
  const view = await store.registerDevice(who, { name: 'Synthetic organization session', platform: 'android' });
  return { who, view, push: async (op: SyncOperation) => (await store.push(who, { protocolVersion: 1, deviceId: view.device.id, operations: [op] })).results[0] };
}

test('legacy edits and restoration preserve organization, exact replay stays immutable, and explicit defaults can clear it', async () => {
  const env = await session();
  const initial = operation('paper', { ...paper(), organization });
  assert.equal((await env.push(initial)).status, 'applied');
  const legacy = operation('paper', paper('Legacy edit'), { entityId: initial.entityId, baseRevision: 1 });
  const edited = await env.push(legacy);
  assert.deepEqual((edited.record?.data as PaperData).organization, organization);
  const changedOrganization = { ...organization, favorite: false };
  assert.equal((await env.push(operation('paper', { ...paper('Current'), organization: changedOrganization }, { entityId: initial.entityId, baseRevision: 2 }))).record?.revision, 3);
  const replay = await env.push(legacy);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.record, edited.record);
  const deletion = await env.push(operation('paper', null, { entityId: initial.entityId, mutation: 'delete', baseRevision: 3 }));
  assert.equal(deletion.record?.data, null);
  const restored = await env.push(operation('paper', paper('Legacy restoration'), { entityId: initial.entityId, mutation: 'restore', baseRevision: 4 }));
  assert.deepEqual((restored.record?.data as PaperData).organization, changedOrganization);
  const cleared = await env.push(operation('paper', { ...paper(), organization: emptyOrganization }, { entityId: initial.entityId, baseRevision: 5 }));
  assert.deepEqual((cleared.record?.data as PaperData).organization, emptyOrganization);
  assert.equal(cleared.record?.revision, 6);
  assert.deepEqual((await store.pull(env.who, undefined, 100)).records.at(-1), cleared.record);
});

for (const choice of ['attempted', 'merged'] as const) {
  test(`a legacy ${choice} conflict resolution preserves the current organization`, async () => {
    const env = await session();
    const initial = operation('paper', { ...paper(), organization });
    await env.push(initial);
    const changed = { ...organization, tags: ['new-tag'] };
    await env.push(operation('paper', { ...paper('Current'), organization: changed }, { entityId: initial.entityId, baseRevision: 1 }));
    const conflict = await env.push(operation('paper', paper('Legacy conflict'), { entityId: initial.entityId, baseRevision: 1 }));
    assert.ok(conflict.conflictId);
    const request: ResolveRequest = choice === 'merged'
      ? { opId: randomUUID(), expectedRevision: 2, choice, mutation: 'put', data: paper('Merged legacy') }
      : { opId: randomUUID(), expectedRevision: 2, choice };
    const resolved = await store.resolveConflict(env.who, conflict.conflictId, request);
    assert.equal(resolved.status, 'applied');
    assert.deepEqual((resolved.record?.data as PaperData).organization, changed);
    assert.deepEqual((await store.resolveConflict(env.who, conflict.conflictId, request)).record, resolved.record);
  });
}
