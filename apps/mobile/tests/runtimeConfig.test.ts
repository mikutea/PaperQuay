import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedRuntimeConfig, loadRuntimeConfig } from '../src/runtimeConfig.ts';
import { PUBLIC_CONFIG_STORAGE_KEY } from '../src/config.ts';

const origin = 'https://reader.example.test';
const input = { apiBaseUrl: origin + '/api/', oidcAuthority: origin + '/identity/realms/library', oidcClientId: 'paperquay-mobile' };
test('operator defaults contain only validated public connection fields', () => {
  assert.equal(checkedRuntimeConfig(input, origin).apiBaseUrl, origin + '/api');
  for (const invalid of [null, [], { ...input, token: 'secret-sentinel' }, { ...input, apiBaseUrl: 'https://user:secret@example.test' },
    { ...input, oidcAuthority: 'http://identity.example.test' }, { apiBaseUrl: origin }]) {
    assert.throws(() => checkedRuntimeConfig(invalid, origin));
  }
});
test('runtime defaults are read without cookies, redirects or cache; broken and oversized files use the connection form', async () => {
  const run = (response: Response) => loadRuntimeConfig(origin, async (url, options) => {
    assert.equal(String(url), origin + '/runtime-config.json');
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store');
    return response;
  });
  assert.equal((await run(Response.json(input))).oidcClientId, input.oidcClientId);
  assert.deepEqual(await run(Response.json({})), {});
  assert.deepEqual(await run(new Response('<html>login</html>')), {});
  assert.deepEqual(await run(Response.json({ ...input, padding: 'x'.repeat(5000) })), {});
  assert.deepEqual(await run(new Response('', { status: 404 })), {});
  assert.deepEqual(await loadRuntimeConfig(origin, async () => { throw new Error('offline'); }), {});
});

test('native and already configured clients do not wait for or replace public deployment defaults', async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return Response.json(input); };
  assert.deepEqual(await loadRuntimeConfig('capacitor://localhost', fetcher), {});
  assert.deepEqual(await loadRuntimeConfig('null', fetcher), {});
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: (key: string) => { assert.equal(key, PUBLIC_CONFIG_STORAGE_KEY); return JSON.stringify(input); } } });
  try { assert.deepEqual(await loadRuntimeConfig(origin, fetcher), {}); assert.equal(requests, 0); }
  finally { if (before) Object.defineProperty(globalThis, 'localStorage', before); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

async function withPublicConfigStorage(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  run: () => Promise<void>,
): Promise<void> {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    await run();
  } finally {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('first-run public defaults survive an unavailable config file on the login return', async () => {
  let saved: string | null = null;
  const expected = { ...input, apiBaseUrl: origin + '/api' };
  await withPublicConfigStorage({
    getItem(key) {
      assert.equal(key, PUBLIC_CONFIG_STORAGE_KEY);
      return saved;
    },
    setItem(key, value) {
      assert.equal(key, PUBLIC_CONFIG_STORAGE_KEY);
      saved = value;
    },
  }, async () => {
    assert.deepEqual(await loadRuntimeConfig(origin, async () => Response.json(input)), expected);
    assert.equal(saved, JSON.stringify(expected));
    let callbackRequests = 0;
    assert.deepEqual(await loadRuntimeConfig(origin, async () => {
      callbackRequests++;
      throw new Error('config file temporarily unavailable');
    }), {});
    assert.equal(callbackRequests, 0);
    assert.equal(saved, JSON.stringify(expected));
  });
});

test('public defaults preserve connection settings saved while the file is loading', async () => {
  let saved: string | null = null;
  const selected = JSON.stringify({ ...input, oidcClientId: 'another-reader' });
  await withPublicConfigStorage({
    getItem: () => saved,
    setItem: (_key, value) => { saved = value; },
  }, async () => {
    await loadRuntimeConfig(origin, async () => {
      saved = selected;
      return Response.json(input);
    });
    assert.equal(saved, selected);
  });
});

test('unavailable public settings storage still permits the fetched login defaults', async () => {
  await withPublicConfigStorage({
    getItem: () => null,
    setItem() { throw new Error('storage quota exceeded'); },
  }, async () => {
    assert.deepEqual(await loadRuntimeConfig(origin, async () => Response.json(input)), {
      ...input, apiBaseUrl: origin + '/api',
    });
  });
});
