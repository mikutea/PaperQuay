import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { core, fixture, require, sha } from './remoteTaskFixtures.mjs';
const { createDesktopRemoteTasks, createCredentialRevisionStore, remoteConfiguration, publicDescriptors } = require('../electron/backend/desktopRemoteTasks.cjs');
const { createRemoteTaskJournal, journalArtifact } = require('../electron/backend/remoteTaskJournal.cjs');
const secure = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'synthetic-os',
  encryptString: (text) => Buffer.from('OS-SEALED:' + Buffer.from(text).toString('base64')),
  decryptString: (bytes) => Buffer.from(bytes.toString().slice('OS-SEALED:'.length), 'base64').toString() };
const capability = { protocolVersion: 1, transport: 'persistent-jobs-v1', maxArtifactBytes: 16777216, maxAccountArtifactBytes: 67108864,
  maxActive: 1, maxQueued: 16, maxRetained: 200, maxReceipts: 2000, maxProfiles: 8, leaseSeconds: 60, providerPresenceSeconds: 45 };
const config = () => ({ settings: { mineruApiBaseUrl: 'https://mineru.example.test/api', embeddingBaseUrl: 'https://embedding.example.test/v1',
  embeddingModel: 'synthetic-model', embeddingDimensions: 2, embeddingInputFormat: 'plain' }, secrets: { mineruApiToken: 'SYNTHETIC_MINERU_KEY', embeddingApiKey: 'SYNTHETIC_EMBEDDING_KEY' } });
async function managerFixture(t) {
  const f = await fixture(t); let configuration = config(); const calls = [];
  const base = { config: { apiBaseUrl: f.snapshot.scope.service }, account: { accountId: f.snapshot.scope.accountId, deviceId: f.snapshot.scope.deviceId }, epoch: 1,
    library: { libraryBindingId: f.snapshot.scope.libraryId, anchor: { identity: 'synthetic-pinned-library' } },
    bindings: [{ bindingId: randomUUID(), paperId: f.task.target.paperId, attachmentVersionId: f.task.target.attachmentVersionId, sha256: f.task.target.sha256, sizeBytes: f.task.target.sizeBytes }] };
  const options = { core, secure, manual: true, getContext: () => structuredClone(base),
    checkContext: (captured) => { if (captured.epoch !== base.epoch || captured.account.accountId !== base.account?.accountId
      || captured.library.libraryBindingId !== base.library.libraryBindingId) throw Object.assign(new Error('DESKTOP_OPERATION_CANCELLED'), { code: 'DESKTOP_OPERATION_CANCELLED' }); },
    readConfiguration: async () => structuredClone(configuration), readPdf: async () => f.pdf,
    api: async (snapshot, input) => { calls.push({ snapshot, input }); if (input.path.endsWith('/claim')) return { claim: null }; return {}; },
    withdrawPresence: async (snapshot) => { calls.push({ withdraw: snapshot }); }, timings: { guardMs: 5, presenceMs: 30, heartbeatMs: 20, pollMs: 5 } };
  const managers = []; const create = (extra = {}) => { const manager = createDesktopRemoteTasks(f.context, { ...options, ...extra }); managers.push(manager); manager.setCapability(capability); return manager; };
  t.after(async () => { for (const manager of managers) await manager.stop(); });
  return { ...f, base, options, calls, create, get config() { return configuration; }, set config(value) { configuration = value; } };
}
test('encrypted credential revision survives restart while secrets/endpoints never influence public profile digests', async (t) => {
  const f = await fixture(t); const directory = path.join(f.root, 'encrypted-revisions'); const firstConfig = remoteConfiguration(config());
  const first = await createCredentialRevisionStore(directory, { secure }).update(f.snapshot.scope, sha(JSON.stringify(firstConfig)), publicDescriptors(firstConfig).descriptors);
  const restart = await createCredentialRevisionStore(directory, { secure }).update(f.snapshot.scope, sha(JSON.stringify(firstConfig)), publicDescriptors(firstConfig).descriptors);
  assert.equal(first.revision, restart.revision); assert.deepEqual(first.profiles, restart.profiles);
  const newDevice = { ...f.snapshot.scope, deviceId: randomUUID() };
  const newSession = await createCredentialRevisionStore(directory, { secure }).update(newDevice, sha(JSON.stringify(firstConfig)), publicDescriptors(firstConfig).descriptors);
  assert.equal(newSession.revision, first.revision); assert.equal(fs.readdirSync(directory).length, 1);
  assert.deepEqual(new Set(newSession.devices), new Set([f.snapshot.scope.deviceId, newDevice.deviceId]));
  const changed = structuredClone(firstConfig); changed.parse.apiToken = 'ROTATED_PRIVATE_KEY'; changed.index.baseUrl = 'https://different-private-endpoint.test/v1';
  const rotated = await createCredentialRevisionStore(directory, { secure }).update(f.snapshot.scope, sha(JSON.stringify(changed)), publicDescriptors(changed).descriptors);
  assert.notEqual(rotated.revision, first.revision); assert.deepEqual(rotated.profiles, first.profiles);
  changed.index.model = 'different-public-model';
  const model = await createCredentialRevisionStore(directory, { secure }).update(f.snapshot.scope, sha(JSON.stringify(changed)), publicDescriptors(changed).descriptors);
  assert.equal(model.profiles.find((item) => item.kind === 'index').revision, 2);
  for (const privateValue of ['SYNTHETIC_MINERU_KEY', 'SYNTHETIC_EMBEDDING_KEY', 'ROTATED_PRIVATE_KEY', firstConfig.parse.apiBaseUrl, changed.index.baseUrl, f.root]) {
    assert.equal(JSON.stringify(rotated.profiles).includes(privateValue), false);
    assert.equal(fs.readdirSync(directory).some((name) => fs.readFileSync(path.join(directory, name)).includes(Buffer.from(privateValue))), false);
  }
  await assert.rejects(createCredentialRevisionStore(directory, { secure: { isEncryptionAvailable: () => false } }).update(f.snapshot.scope, 'a'.repeat(64), []), { code: 'REMOTE_CREDENTIAL_STORAGE_UNAVAILABLE' });
  await assert.rejects(createCredentialRevisionStore(path.join(f.root, 'failed-encryption'), { secure: { ...secure,
    encryptString() { throw new Error('SYNTHETIC_PRIVATE_CRYPTO_FAILURE'); } } }).update(f.snapshot.scope, 'a'.repeat(64), []), { code: 'REMOTE_CREDENTIAL_STORAGE_UNAVAILABLE' });
});
test('desktop helper is explicitly enabled, guards consent/configuration and never restarts automatically', async (t) => {
  const f = await managerFixture(t); const manager = f.create(); await manager.refreshStatus();
  assert.equal(manager.status().enabled, false); assert.equal(f.calls.length, 0);
  const original = manager.status(); assert.equal(original.profiles.length, 2);
  await assert.rejects(manager.setEnabled({ enabled: true, consent: false, configurationToken: original.configurationToken }), { code: 'DESKTOP_ARGUMENT_INVALID' });
  await manager.setEnabled({ enabled: true, consent: true, configurationToken: original.configurationToken });
  assert.equal(manager.status().enabled, true); assert.equal(f.calls[0].input.method, 'PUT');
  assert.deepEqual(Object.keys(f.calls[0].input.body), ['profiles']);
  const publicText = JSON.stringify(f.calls[0].input.body); assert.equal(publicText.includes('SYNTHETIC'), false); assert.equal(publicText.includes('https://'), false);
  await manager.setEnabled({ enabled: true, consent: true, configurationToken: original.configurationToken });
  assert.equal(f.calls.filter((item) => item.input?.method === 'PUT').length, 1, 'repeated enable cannot orphan a second worker');
  await manager.configurationWillChange(JSON.stringify({ ...f.config, leftSidebarCollapsed: true })); assert.equal(manager.status().enabled, true);
  const changed = structuredClone(f.config); changed.secrets.mineruApiToken = 'CHANGED_SECRET';
  await manager.configurationWillChange(JSON.stringify(changed)); assert.equal(manager.status().enabled, false);
  f.config = changed; await manager.refreshStatus();
  await assert.rejects(manager.setEnabled({ enabled: true, consent: true, configurationToken: original.configurationToken }), { code: 'REMOTE_CONFIGURATION_CHANGED' });
  const restarted = f.create(); await restarted.refreshStatus(); assert.equal(restarted.status().enabled, false);
  assert.notEqual(restarted.status().configurationToken, original.configurationToken);
  assert.ok(f.calls.some((item) => item.withdraw));
});
test('remote profile negotiation omits unknown dimensions and unsupported embedding input formats', async (t) => {
  const f = await managerFixture(t); f.config.settings.embeddingDimensions = null; const manager = f.create(); await manager.refreshStatus();
  assert.deepEqual(manager.status().profiles.map((item) => item.kind), ['parse']); assert.equal(manager.status().unavailable.index, 'REMOTE_INDEX_DIMENSION_REQUIRED');
  f.config.settings.embeddingDimensions = 2; f.config.settings.embeddingInputFormat = 'query-passage'; await manager.refreshStatus();
  assert.deepEqual(manager.status().profiles.map((item) => item.kind), ['parse']); assert.equal(manager.status().unavailable.index, 'REMOTE_INDEX_INPUT_UNSUPPORTED');
});
test('capability withdrawal immediately disables the local worker and hides profile publication', async (t) => {
  const f = await managerFixture(t); const manager = f.create(); await manager.refreshStatus();
  await manager.setEnabled({ enabled: true, consent: true, configurationToken: manager.status().configurationToken });
  manager.setCapability(null); assert.equal(manager.status().enabled, false); assert.deepEqual(manager.status().profiles, []);
  assert.equal(manager.status().configurationToken, null); await manager.settled();
  assert.equal(manager.status().errorCode, 'REMOTE_TASKS_DISABLED'); assert.ok(f.calls.some((item) => item.withdraw));
});
test('explicit completed-journal cleanup is scoped and preserves uncertain/incomplete execution evidence', async (t) => {
  const f = await managerFixture(t); const manager = f.create(); const scope = { service: f.base.config.apiBaseUrl,
    accountId: f.base.account.accountId, deviceId: f.base.account.deviceId, libraryId: f.base.library.libraryBindingId };
  const journal = createRemoteTaskJournal({ directory: path.join(path.dirname(f.context.appPaths.configPath), 'account-sync', 'remote-tasks', 'journal') });
  const record = { version: 1, jobId: f.task.id, kind: 'parse', executionKey: 'e'.repeat(64), attempt: 1, stage: 'completed', artifact: journalArtifact(f.bytes) };
  await journal.write(scope, f.task.id, record);
  const uncertainId = randomUUID(); await journal.write(scope, uncertainId, { ...record, jobId: uncertainId, stage: 'submit_pending' });
  const other = { ...scope, accountId: randomUUID() }; await journal.write(other, f.task.id, record);
  await assert.rejects(manager.clearCompleted({ confirmed: false }), { code: 'DESKTOP_ARGUMENT_INVALID' });
  await assert.rejects(manager.clearCompleted({ confirmed: true, accountId: other.accountId }), { code: 'DESKTOP_ARGUMENT_INVALID' });
  assert.deepEqual(await manager.clearCompleted({ confirmed: true }), { removed: 1 });
  assert.equal(await journal.read(scope, f.task.id), null); assert.equal((await journal.read(scope, uncertainId)).stage, 'submit_pending');
  assert.equal((await journal.read(other, f.task.id)).stage, 'completed');
});
