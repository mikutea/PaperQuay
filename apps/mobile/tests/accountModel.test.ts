import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCOUNT_MODEL_ID, parseAccountModelSettings, type AccountModelSettings } from '../../../packages/ai-core/src/accountModel.ts';
import { AccountModelSession } from '../src/ai/accountModelSession.ts';
import { AI_SECRET_KEY, LocalAiConfigStore, aiSecretNamespace, defaultAiProvider } from '../src/ai/provider.ts';
import { ClientError } from '../src/errors.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';

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
  const store = new LocalAiConfigStore({
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  });
  return { api, store, values };
}

test('a model saved by one signed-in workspace is usable by the other while local presets stay editable', async () => {
  const { api, store, values } = fixture();
  const writer = new AccountModelSession(scope, api, () => true);
  const reader = new AccountModelSession(scope, api, () => true);
  const local = new MemorySecretStore();
  const secrets = reader.secretStore(local);
  try {
    const localConfig = { ...defaultAiProvider(), model: 'local-fixture' };
    store.save(scope, localConfig);
    await writer.refresh();
    await writer.write(connection);
    await reader.refresh();
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
    await writer.write(null);
    await assert.rejects(secrets.get(namespace, AI_SECRET_KEY), { code: 'ACCOUNT_MODEL_CHANGED' });
    assert.equal(store.load(scope).model, localConfig.model);
  } finally {
    writer.close();
    reader.close();
  }
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
