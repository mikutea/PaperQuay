import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture, require, sha } from './remoteTaskFixtures.mjs';
const { createRemoteTaskJournal, journalArtifact } = require('../electron/backend/remoteTaskJournal.cjs');
const native = require('../electron/backend/nativeFs.cjs');

test('private journal atomically reloads detached records and isolates account/service/library/device', async (t) => {
  const f = await fixture(t); const checkpoint = await f.checkpoint(); const record = await checkpoint.read();
  const artifact = journalArtifact(f.bytes); await checkpoint.write({ ...record, stage: 'complete_pending', artifact });
  const restarted = createRemoteTaskJournal({ directory: path.join(f.root, 'private-journal') });
  const restored = await restarted.read(f.snapshot.scope, f.task.id);
  assert.equal(restored.artifact.digest, sha(f.bytes)); assert.equal(restored.stage, 'complete_pending');
  restored.stage = 'completed'; assert.equal((await checkpoint.read()).stage, 'complete_pending');
  for (const changed of [{ accountId: randomUUID() }, { deviceId: randomUUID() }, { libraryId: 'other-library' }, { service: 'https://other.example.test' }]) {
    assert.equal(await restarted.read({ ...f.snapshot.scope, ...changed }, f.task.id), null);
  }
  assert.equal((await restarted.read({ ...f.snapshot.scope, service: f.snapshot.scope.service + '/' }, f.task.id)).stage, 'complete_pending');
});
test('journal rejects secrets, malformed payloads and corruption while a failed replacement preserves prior bytes', async (t) => {
  const f = await fixture(t); const checkpoint = await f.checkpoint(); const entry = await checkpoint.read();
  for (const key of ['authorization', 'accessToken', 'apiToken', 'apiKey', 'endpoint', 'headers', 'url', 'filePath']) {
    await assert.rejects(checkpoint.write({ ...entry, [key]: 'synthetic-secret' }), { code: 'REMOTE_JOURNAL_INVALID' });
  }
  const fault = createRemoteTaskJournal({ directory: path.join(f.root, 'private-journal'), nativeFs: { ...native, write: async () => { throw Object.assign(new Error('SYNTHETIC_DISK_FULL'), { code: 'ENOSPC' }); } } });
  await assert.rejects(fault.write(f.snapshot.scope, f.task.id, { ...entry, stage: 'submit_pending' }));
  assert.equal((await checkpoint.read()).stage, 'prepared');
  const files = fs.readdirSync(path.join(f.root, 'private-journal')); assert.equal(files.length, 1);
  const destination = path.join(f.root, 'private-journal', files[0]); const envelope = JSON.parse(fs.readFileSync(destination));
  envelope.record.stage = 'completed'; fs.writeFileSync(destination, JSON.stringify(envelope));
  await assert.rejects(checkpoint.read(), { code: 'REMOTE_JOURNAL_CORRUPT' });
});
test('journal commits concurrent stage writes in order and stores no private provider transport', async (t) => {
  const f = await fixture(t); const checkpoint = await f.checkpoint(); const entry = await checkpoint.read();
  await Promise.all([checkpoint.write({ ...entry, stage: 'submit_pending', dataId: 'pq_synthetic' }),
    checkpoint.write({ ...entry, stage: 'batch_known', dataId: 'pq_synthetic', batchId: 'synthetic-batch' })]);
  assert.equal((await checkpoint.read()).batchId, 'synthetic-batch');
  const contents = fs.readdirSync(path.join(f.root, 'private-journal')).map((name) => fs.readFileSync(path.join(f.root, 'private-journal', name), 'utf8')).join('');
  for (const marker of ['Bearer', 'apiKey', 'apiToken', 'https://sync', 'accessToken', 'filePath']) assert.equal(contents.includes(marker), false);
});
