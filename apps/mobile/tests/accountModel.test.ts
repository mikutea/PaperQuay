import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCOUNT_MODEL_ID, parseAccountModelSettings, type AccountModelSettings } from '../../../packages/ai-core/src/accountModel.ts';
import { AccountModelSession } from '../src/ai/accountModelSession.ts';
import { AI_SECRET_KEY, LocalAiConfigStore, aiSecretNamespace, defaultAiProvider } from '../src/ai/provider.ts';
import { ClientError } from '../src/errors.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import { AiClient } from '../src/ai/client.ts';
import { prepareAiContext } from '../src/ai/context.ts';

const scope = { apiBaseUrl: 'https://sync.example.test', accountId: '77777777-7777-4777-8777-777777777777' };
const other = { ...scope, accountId: '88888888-8888-4888-8888-888888888888' };
const provider = { ...defaultAiProvider(), endpoint: 'https://model.example.test/v1', model: 'fixture-model',
  apiMode: 'responses' as const };
const connection = { provider, apiKey: 'fixture-model-key' };

function fixture() {
  let settings: AccountModelSettings = { revision: 0, connection: null };
  const api = {
    readAccountModel: async () => structuredClone(settings),
    writeAccountModel: async (next: AccountModelSettings) => {
      if (next.revision !== settings.revision) throw new ClientError('ACCOUNT_MODEL_CHANGED');
      settings = parseAccountModelSettings({ ...next, revision: settings.revision + 1 });
      return settings.revision;
    },
  };
  const values = new Map<string, string>();
  const storage = {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  const store = new LocalAiConfigStore(storage);
  return { api, store, values, storage };
}

test('a model saved by one signed-in workspace is usable by the other while local presets stay editable', async () => {
  const { api, store, values, storage } = fixture();
  const writer = new AccountModelSession(scope, api, () => true);
  const reader = new AccountModelSession(scope, api, () => true, storage);
  const local = new MemorySecretStore();
  const secrets = reader.secretStore(local);
  try {
    const localConfig = { ...defaultAiProvider(), model: 'local-fixture' };
    store.save(scope, localConfig);
    await writer.refresh();
    await writer.write(connection, 0);
    await reader.refresh();
    assert.equal(reader.getSnapshot().approved, false);
    assert.equal(store.load(scope).model, localConfig.model);
    const shared = reader.getSnapshot().provider!;
    await assert.rejects(secrets.get(await aiSecretNamespace(scope, shared), AI_SECRET_KEY),
      { code: 'ACCOUNT_MODEL_APPROVAL_REQUIRED' });
    reader.approve(reader.getSnapshot().revision);
    assert.equal(store.load(scope).model, localConfig.model);
    store.useAccount(scope);
    const active = store.load(scope);
    assert.equal(active.id, ACCOUNT_MODEL_ID);
    assert.equal(active.model, provider.model);
    const namespace = await aiSecretNamespace(scope, active);
    assert.equal(await secrets.get(namespace, AI_SECRET_KEY), connection.apiKey);
    assert.equal(await local.get(namespace, AI_SECRET_KEY), null);
    assert.equal(store.load(other).model, '');
    assert.equal(store.loadLocal(scope).model, localConfig.model);
    assert.ok(!JSON.stringify([...values]).includes(connection.apiKey));
    assert.ok(!JSON.stringify(reader.getSnapshot()).includes(connection.apiKey));

    store.save(scope, localConfig);
    assert.equal(store.load(scope).model, localConfig.model);
    store.useAccount(scope);
    assert.equal(store.load(scope).id, ACCOUNT_MODEL_ID);
    await writer.write(null, writer.getSnapshot().revision);
    await assert.rejects(secrets.get(namespace, AI_SECRET_KEY), { code: 'ACCOUNT_MODEL_CHANGED' });
    assert.equal(store.load(scope).model, localConfig.model);
    store.clear(scope);
    assert.equal(values.size, 0);
  } finally {
    writer.close();
    reader.close();
  }
});

test('saving a local model before account discovery keeps it selected after the account model loads', async () => {
  const { api, store, storage } = fixture();
  const previous = new AccountModelSession(scope, api, () => true, storage);
  try {
    await previous.refresh();
    await previous.write(connection, 0);
    store.useAccount(scope);
    assert.equal(store.load(scope).id, ACCOUNT_MODEL_ID);
  } finally { previous.close(); }

  const next = new AccountModelSession(scope, api, () => true, storage);
  const localConfig = { ...defaultAiProvider(), model: 'new-local-fixture' };
  try {
    assert.equal(next.getSnapshot().provider, null);
    store.save(scope, localConfig);
    await next.refresh();
    assert.equal(next.getSnapshot().approved, true);
    assert.deepEqual(store.load(scope), localConfig);
    store.useAccount(scope);
    assert.equal(store.load(scope).id, ACCOUNT_MODEL_ID);
  } finally { next.close(); }
});

test('a remotely replaced account endpoint cannot receive document text before local revision approval, including keyless models', async () => {
  const { api } = fixture();
  const writer = new AccountModelSession(scope, api, () => true);
  const reader = new AccountModelSession(scope, api, () => true);
  let calls = 0;
  const client = new AiClient(reader.secretStore(new MemorySecretStore()), {
    kind: 'fetch', redirectPolicy: 'error', supportsStreaming: false,
    async request() {
      calls++;
      return Response.json({ status: 'completed', output_text: 'Synthetic answer [P1]' });
    },
  });
  const context = prepareAiContext({
    paperId: '99999999-9999-4999-8999-999999999999',
    attachmentVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sha256: 'a'.repeat(64), scope: 'page', totalPages: 1,
    pages: [{ pageIndex: 0, text: 'Private fixture text' }], complete: true, label: 'Private fixture',
  });
  const generate = () => client.generate({
    accountScope: scope, config: reader.getSnapshot().provider!, context,
    action: 'explain', question: '', onText: () => {},
  });
  try {
    await writer.refresh();
    await writer.write(connection, 0);
    await reader.refresh();
    await assert.rejects(generate(), { code: 'ACCOUNT_MODEL_APPROVAL_REQUIRED' });
    assert.equal(calls, 0);
    reader.approve(reader.getSnapshot().revision);
    await generate();
    assert.equal(calls, 1);
    await api.writeAccountModel({
      revision: reader.getSnapshot().revision,
      connection: { provider: { ...provider, requiresKey: false, endpoint: 'https://replacement.example.test/v1' }, apiKey: null },
    });
    await assert.rejects(generate(), { code: 'ACCOUNT_MODEL_CHANGED' });
    await assert.rejects(generate(), { code: 'ACCOUNT_MODEL_APPROVAL_REQUIRED' });
    assert.equal(calls, 1);
    assert.equal(reader.getSnapshot().approved, false);
    reader.approve(reader.getSnapshot().revision);
    await generate();
    assert.equal(calls, 2);
  } finally {
    writer.close();
    reader.close();
  }
});

test('a draft pins its original revision when background refresh observes another device update', async () => {
  const { api } = fixture();
  const session = new AccountModelSession(scope, api, () => true);
  try {
    await session.refresh();
    await session.write(connection, 0);
    const editingRevision = session.getSnapshot().revision;
    const rotated = { ...connection, apiKey: 'new-fixture-key-from-another-device' };
    await api.writeAccountModel({ revision: editingRevision, connection: rotated });
    await session.refresh();
    await assert.rejects(session.write(connection, editingRevision), { code: 'ACCOUNT_MODEL_CHANGED' });
    await assert.rejects(session.write(null, editingRevision), { code: 'ACCOUNT_MODEL_CHANGED' });
    assert.equal((await api.readAccountModel()).connection?.apiKey, rotated.apiKey);
    assert.equal(session.getSnapshot().revision, editingRevision + 1);
  } finally { session.close(); }
});

test('a credential response in flight is discarded when the workspace owner changes', async () => {
  const { api } = fixture();
  const settings = parseAccountModelSettings({ revision: 1, connection });
  let current = true;
  let finish!: (settings: AccountModelSettings) => void;
  const later = new Promise<AccountModelSettings>(resolve => { finish = resolve; });
  const reader = new AccountModelSession(scope, {
    ...api,
    readAccountModel: async () => later,
  }, () => current);
  const refreshing = reader.refresh();
  current = false;
  finish(settings);
  await refreshing;
  assert.equal(reader.getSnapshot().provider, null);
  reader.close();
});
