import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { AccountStore, type AccountScope } from '../src/storage/accountStore.ts';
import { ClientError } from '../src/errors.ts';

type State = { revision: number; edits: string[]; cursor: string };
function decode(value: unknown): State {
  const state = value as State;
  if (
    !state ||
    !Number.isSafeInteger(state.revision) ||
    !Array.isArray(state.edits) ||
    typeof state.cursor !== 'string'
  )
    throw new Error('invalid');
  return state;
}
const accountA: AccountScope = {
  apiBaseUrl: 'https://sync.example.test',
  accountId: '11111111-1111-4111-8111-111111111111',
};
const accountB: AccountScope = { ...accountA, accountId: '22222222-2222-4222-8222-222222222222' };
const empty = (): State => ({ revision: 0, edits: [], cursor: '' });

test('committed edits and cursor survive closing and reopening the database', async () => {
  const factory = new IDBFactory();
  const first = new AccountStore({ indexedDB: factory, decode });
  await first.update(accountA, () => ({
    revision: 1,
    edits: ['offline note'],
    cursor: 'opaque-1',
  }));
  await first.close();
  const second = new AccountStore({ indexedDB: factory, decode });
  assert.deepEqual(await second.read(accountA), {
    revision: 1,
    edits: ['offline note'],
    cursor: 'opaque-1',
  });
  await second.close();
});

test('accounts and API installations are isolated even when entity contents match', async () => {
  const store = new AccountStore({ indexedDB: new IDBFactory(), decode });
  await store.update(accountA, () => ({ ...empty(), edits: ['A private note'] }));
  await store.update(accountB, () => ({ ...empty(), edits: ['B private note'] }));
  assert.deepEqual((await store.read(accountB))?.edits, ['B private note']);
  assert.equal(await store.read({ ...accountA, apiBaseUrl: 'https://other.example.test' }), null);
  await store.remove(accountB);
  assert.deepEqual((await store.read(accountA))?.edits, ['A private note']);
  assert.equal(await store.read(accountB), null);
  await store.close();
});

test('concurrent transactions preserve every edit rather than overwrite a stale snapshot', async () => {
  const store = new AccountStore({ indexedDB: new IDBFactory(), decode });
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      store.update(accountA, (current) => {
        const state = current ?? empty();
        return { ...state, revision: state.revision + 1, edits: [...state.edits, String(index)] };
      }),
    ),
  );
  const state = await store.read(accountA);
  assert.equal(state?.revision, 40);
  assert.equal(new Set(state?.edits).size, 40);
  await store.close();
});

test('failed reducer or invalid state commits neither cursor nor edits', async () => {
  const store = new AccountStore({ indexedDB: new IDBFactory(), decode });
  await store.update(accountA, empty);
  await assert.rejects(
    store.update(accountA, () => {
      throw new Error('token=private');
    }),
    { code: 'STORAGE_FAILED' },
  );
  await assert.rejects(
    store.update(accountA, () => ({ ...empty(), revision: NaN })),
    { code: 'STORAGE_FAILED' },
  );
  assert.deepEqual(await store.read(accountA), empty());
  await store.close();
});

test('account-switch guard stops a queued stale response before any write', async () => {
  const store = new AccountStore({ indexedDB: new IDBFactory(), decode });
  await store.update(accountA, empty);
  let active = true;
  const pending = store.update(
    accountA,
    () => ({ ...empty(), edits: ['old response'] }),
    () => active,
  );
  active = false;
  await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual(await store.read(accountA), empty());
  await store.close();
});

test('an unavailable database is a visible failure, never a memory-only success', async () => {
  const failing = {
    open() {
      throw new Error('private browser failure');
    },
  } as unknown as IDBFactory;
  const store = new AccountStore({ indexedDB: failing, decode });
  await assert.rejects(
    store.update(accountA, empty),
    (error) => error instanceof ClientError && error.code === 'STORAGE_UNAVAILABLE',
  );
});
