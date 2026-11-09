import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import { ZoteroClient, ZoteroClientError, ZOTERO_LIMITS, ZOTERO_SECRET_KEY, validateZoteroApiKey, validateZoteroConfig,
  validateZoteroCursor, zoteroSecretNamespace, zoteroSourceId, type ZoteroClientErrorCode, type ZoteroCredential } from '../src/library/zoteroClient.ts';
import { refreshZoteroLibrary, validateZoteroRefreshResult } from '../src/library/zoteroRefresh.ts';
import { deferred, zoteroAccount, zoteroConfig, zoteroDeleted, zoteroItem, zoteroKey, zoteroResponse, zoteroTransport } from './helpers/zotero.ts';

const publicRead = { expectedCursor: null, credential: { mode: 'public' as const } };
const errorCode = (code: ZoteroClientErrorCode) => (error: unknown) => {
  assert.ok(error instanceof ZoteroClientError); assert.equal(error.code, code); assert.equal(error.message, code);
  assert.doesNotMatch(JSON.stringify(error), /DedicatedZoteroFixtureKey24|private response|Bearer|password/); return true;
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('configuration, cursor and secret addresses are bounded and cannot become arbitrary URL paths or account credentials', () => {
  assert.equal(zoteroSourceId(zoteroConfig), 'zotero-user:42');
  for (const libraryId of ['0', '-1', '01', '1.5', '42/items', 'https://evil.invalid', '9007199254740992'])
    assert.throws(() => validateZoteroConfig({ ...zoteroConfig, libraryId }), errorCode('INVALID_CONFIG'));
  assert.throws(() => validateZoteroConfig({ ...zoteroConfig, endpoint: 'https://evil.invalid' }), errorCode('INVALID_CONFIG'));
  assert.throws(() => validateZoteroConfig({ ...zoteroConfig, kind: 'external' }), errorCode('INVALID_CONFIG'));
  for (const cursor of [-1, 1.5, '10', undefined, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => validateZoteroCursor(cursor), errorCode('INVALID_CURSOR'));
  assert.equal(validateZoteroCursor(0), 0); assert.equal(validateZoteroCursor(null), null);
  for (const key of ['Bearer credential', 'aaa.bbb.ccc', 'short', `${zoteroKey}\r\nAuthorization: x`])
    assert.throws(() => validateZoteroApiKey(key), errorCode('INVALID_KEY'));
  let reads = 0; const accessor = { ...zoteroConfig }; Object.defineProperty(accessor, 'libraryId', { get: () => { reads++; return '42'; } });
  assert.throws(() => validateZoteroConfig(accessor), errorCode('INVALID_CONFIG')); assert.equal(reads, 0);
  const address = zoteroSecretNamespace(zoteroAccount, zoteroConfig);
  assert.notEqual(address, zoteroSecretNamespace({ ...zoteroAccount, accountId: '00000000-0000-4000-8000-000000000002' }, zoteroConfig));
  assert.notEqual(address, zoteroSecretNamespace({ ...zoteroAccount, apiBaseUrl: 'https://another.example.invalid' }, zoteroConfig));
  assert.notEqual(address, zoteroSecretNamespace(zoteroAccount, { ...zoteroConfig, kind: 'group' }));
  assert.throws(() => zoteroSecretNamespace({ ...zoteroAccount, apiBaseUrl: 'https://user:password@sync.example.invalid' }, zoteroConfig), errorCode('INVALID_CONFIG'));
});

test('user and group refreshes construct only fixed official GET requests and never advance caller cursors themselves', async () => {
  for (const kind of ['user', 'group'] as const) {
    const config = { ...zoteroConfig, kind }, initialCursor = 5;
    const fixture = zoteroTransport([zoteroResponse([zoteroItem(1, 10, config)]), zoteroDeleted(['00000009'])]);
    const result = await refreshZoteroLibrary(fixture.client, config, { expectedCursor: initialCursor, credential: { mode: 'memory', apiKey: zoteroKey } });
    assert.equal(initialCursor, 5); assert.equal(result.expectedCursor, 5); assert.equal(result.nextCursor, 10);
    assert.equal(result.snapshot.source.kind, `zotero-${kind}`); assert.equal(result.snapshot.source.name, config.name);
    assert.deepEqual(result.deletedKeys, ['00000009']); assert.equal(result.snapshot.items[0].data.title, 'Study 1');
    assert.equal(fixture.requests.length, 2);
    for (const request of fixture.requests) {
      assert.equal(request.url.origin, 'https://api.zotero.org');
      assert.match(request.url.pathname, new RegExp(`^/${kind === 'user' ? 'users' : 'groups'}/42/(items|deleted)$`));
      assert.equal(request.init.method, 'GET'); assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.referrerPolicy, 'no-referrer');
      assert.equal(request.init.redirect, 'error'); assert.equal(request.init.cache, 'no-store');
      assert.equal(request.headers.get('Zotero-API-Version'), '3'); assert.equal(request.headers.get('Zotero-API-Key'), zoteroKey);
      assert.equal(request.headers.has('Authorization'), false); assert.equal(request.url.href.includes(zoteroKey), false);
      assert.equal(request.url.searchParams.get('since'), '5'); assert.equal(request.init.body, undefined);
    }
    assert.equal(fixture.requests[0].headers.get('If-Modified-Since-Version'), '5');
    assert.equal(fixture.requests[1].headers.has('If-Modified-Since-Version'), false);
    assert.equal(JSON.stringify(result).includes(zoteroKey), false);
    assert.equal(validateZoteroRefreshResult(result), result); assert.equal(Object.isFrozen(result.snapshot.items[0].data), true);
    assert.throws(() => validateZoteroRefreshResult(JSON.parse(JSON.stringify(result))), errorCode('INVALID_RESULT'));
  }
});

test('pagination uses total counts and constructed offsets, ignoring attacker supplied Link URLs', async () => {
  const items = Array.from({ length: 201 }, (_, index) => zoteroItem(index + 1));
  const fixture = zoteroTransport([
    zoteroResponse(items.slice(0, 100), 10, { total: 201, headers: { Link: '<https://outside.invalid/collect?key=secret>; rel="next"' } }),
    zoteroResponse(items.slice(100, 200), 10, { total: 201 }), zoteroResponse(items.slice(200), 10, { total: 201 }), zoteroDeleted(),
  ]);
  const result = await refreshZoteroLibrary(fixture.client, zoteroConfig, publicRead);
  assert.equal(result.snapshot.items.length, 201); assert.equal(result.stats.itemPages, 3); assert.equal(result.stats.requests, 4);
  assert.deepEqual(fixture.requests.slice(0, 3).map(request => request.url.searchParams.get('start')), ['0', '100', '200']);
  for (const request of fixture.requests.slice(0, 3)) {
    assert.equal(request.url.searchParams.get('limit'), '100'); assert.equal(request.url.searchParams.get('includeTrashed'), '1');
    assert.equal(request.headers.has('If-Modified-Since-Version'), false); assert.equal(request.headers.has('Zotero-API-Key'), false);
  }
});

test('304 is accepted only for the exact requested library cursor and causes no deletion or item fetch', async () => {
  const fixture = zoteroTransport([zoteroResponse(null, 7, { status: 304 })]);
  const result = await refreshZoteroLibrary(fixture.client, zoteroConfig, { ...publicRead, expectedCursor: 7 });
  assert.equal(result.unchanged, true); assert.equal(result.nextCursor, 7); assert.equal(result.snapshot.items.length, 0);
  assert.deepEqual(result.deletedKeys, []); assert.equal(fixture.requests.length, 1);
  for (const [expectedCursor, version, code] of [[null, 7, 'INVALID_RESPONSE'], [7, 8, 'INVALID_RESPONSE'], [7, 6, 'INVALID_CURSOR']] as const) {
    const invalid = zoteroTransport([zoteroResponse(null, version, { status: 304 })]);
    await assert.rejects(invalid.client.download(zoteroConfig, { ...publicRead, expectedCursor }), errorCode(code));
  }
});

test('a headerless conditional 304 confirms its cursor with one unconditional read', async () => {
  const fixture = zoteroTransport([new Response(null, { status: 304 }), zoteroResponse([], 7)]);
  const result = await refreshZoteroLibrary(fixture.client, zoteroConfig, { ...publicRead, expectedCursor: 7 });
  assert.equal(result.unchanged, true); assert.equal(result.nextCursor, 7);
  assert.deepEqual(result.snapshot.items, []); assert.deepEqual(result.deletedKeys, []);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[0].url.href, fixture.requests[1].url.href);
  assert.equal(fixture.requests[0].headers.get('If-Modified-Since-Version'), '7');
  assert.equal(fixture.requests[1].headers.has('If-Modified-Since-Version'), false);
});

test('a 304 may omit its API header when its explicit library version is exact', async () => {
  const fixture = zoteroTransport([new Response(null, { status: 304, headers: { 'Last-Modified-Version': '7' } })]);
  const result = await fixture.client.download(zoteroConfig, { ...publicRead, expectedCursor: 7 });
  assert.equal(result.unchanged, true); assert.equal(result.nextCursor, 7); assert.equal(fixture.requests.length, 1);
});

test('a changed library during headerless 304 confirmation uses the complete normal download', async () => {
  const fixture = zoteroTransport([new Response(null, { status: 304 }), zoteroResponse([zoteroItem(1, 8)], 8), zoteroDeleted([], 8)]);
  const result = await refreshZoteroLibrary(fixture.client, zoteroConfig, { ...publicRead, expectedCursor: 7 });
  assert.equal(result.unchanged, false); assert.equal(result.nextCursor, 8);
  assert.equal(result.snapshot.items[0].data.title, 'Study 1'); assert.equal(fixture.requests.length, 3);
});

test('headerless 304 confirmation rejects rollback, contradictory metadata and another 304', async () => {
  const cases: [Response, number, ZoteroClientErrorCode][] = [
    [zoteroResponse([], 6), 7, 'INVALID_CURSOR'],
    [new Response(null, { status: 304 }), 7, 'INVALID_RESPONSE'],
    [zoteroResponse([], 7, { headers: { 'Zotero-API-Version': '2' } }), 7, 'INVALID_RESPONSE'],
    [new Response('[]', { headers: { 'Zotero-API-Version': '3', 'Total-Results': '0', 'Content-Type': 'application/json' } }), 7, 'INVALID_RESPONSE'],
    [zoteroResponse([zoteroItem(1, 0)], 0), 0, 'INVALID_RESPONSE'],
  ];
  for (const [probe, cursor, code] of cases) {
    const fixture = zoteroTransport([new Response(null, { status: 304 }), probe]);
    await assert.rejects(fixture.client.download(zoteroConfig, { ...publicRead, expectedCursor: cursor }), errorCode(code));
    assert.equal(fixture.requests.length, 2);
  }
  const invalidHeaders: Record<string, string>[] = [{ 'Zotero-API-Version': '2' }, { 'Last-Modified-Version': 'invalid' }];
  for (const headers of invalidHeaders) {
    const fixture = zoteroTransport([new Response(null, { status: 304, headers })]);
    await assert.rejects(fixture.client.download(zoteroConfig, { ...publicRead, expectedCursor: 7 }), errorCode('INVALID_RESPONSE'));
    assert.equal(fixture.requests.length, 1);
  }
});

test('an unconditional or later-page 304 never uses the confirmation fallback', async () => {
  const first = zoteroTransport([new Response(null, { status: 304 })]);
  await assert.rejects(first.client.download(zoteroConfig, publicRead), errorCode('INVALID_RESPONSE'));
  assert.equal(first.requests.length, 1);
  const records = Array.from({ length: 100 }, (_, index) => zoteroItem(index + 1, 10));
  const later = zoteroTransport([zoteroResponse(records, 10, { total: 101 }), new Response(null, { status: 304 })]);
  await assert.rejects(later.client.download(zoteroConfig, { ...publicRead, expectedCursor: 7 }), errorCode('INVALID_RESPONSE'));
  assert.equal(later.requests.length, 2);
});

test('deletion-only and unsupported/trash-only rounds preserve explicit ignored records without synthesizing local deletes', async () => {
  const deletion = zoteroTransport([zoteroResponse([], 11), zoteroDeleted(['00000009'], 11)]);
  const removed = await refreshZoteroLibrary(deletion.client, zoteroConfig, { ...publicRead, expectedCursor: 10 });
  assert.equal(removed.snapshot.items.length, 0); assert.deepEqual(removed.deletedKeys, ['00000009']); assert.equal(removed.nextCursor, 11);
  const records = [zoteroItem(1, 11, zoteroConfig, { itemType: 'attachment', path: '/private/local.pdf' }),
    zoteroItem(2, 11, zoteroConfig, { itemType: 'note', note: '<script>private note</script>' }),
    zoteroItem(3, 11, zoteroConfig, { itemType: 'annotation' }), zoteroItem(4, 11, zoteroConfig, { parentItem: '00000009' }),
    zoteroItem(5, 11, zoteroConfig, { deleted: 1 })];
  const fixture = zoteroTransport([zoteroResponse(records, 11), zoteroDeleted([], 11)]);
  const result = await refreshZoteroLibrary(fixture.client, zoteroConfig, { ...publicRead, expectedCursor: 10 });
  assert.equal(result.snapshot.items.length, 0);
  assert.deepEqual(result.ignored.map(item => item.reason), ['attachment', 'note', 'annotation', 'child', 'trashed']);
  assert.equal(JSON.stringify(result).includes('/private/local.pdf'), false); assert.equal(JSON.stringify(result).includes('<script>private note'), false);
});

test('cross-page version changes discard earlier data and restart from the original cursor with bounded delay', async () => {
  const old = Array.from({ length: 100 }, (_, index) => zoteroItem(index + 1, 10));
  const fixture = zoteroTransport([zoteroResponse(old, 10, { total: 101 }), zoteroResponse([zoteroItem(101, 11)], 11, { total: 101 }),
    zoteroResponse([zoteroItem(202, 11)], 11), zoteroDeleted([], 11)]);
  const result = await refreshZoteroLibrary(fixture.client, zoteroConfig, { ...publicRead, expectedCursor: 5 });
  assert.deepEqual(result.snapshot.items.map(item => item.data.title), ['Study 202']); assert.equal(result.nextCursor, 11);
  assert.equal(result.retry.attempts, 2); assert.equal(result.retry.versionRestarts, 1); assert.deepEqual(fixture.delays, [250]);
  assert.deepEqual(fixture.requests.map(request => request.url.searchParams.get('since')), ['5', '5', '5', '5']);
  assert.equal(fixture.requests[2].url.searchParams.get('start'), '0');
});

test('a changed deletion response restarts the entire round and persistent changes fail after the fixed retry budget', async () => {
  const fixture = zoteroTransport([zoteroResponse([zoteroItem(1)]), zoteroDeleted(['00000009'], 11),
    zoteroResponse([zoteroItem(2, 11)], 11), zoteroDeleted([], 11)]);
  const result = await refreshZoteroLibrary(fixture.client, zoteroConfig, publicRead);
  assert.deepEqual(result.snapshot.items.map(item => item.key), ['00000002']); assert.deepEqual(result.deletedKeys, []);
  const unstable = zoteroTransport([zoteroResponse([], 10), zoteroDeleted([], 11), zoteroResponse([], 12), zoteroDeleted([], 13),
    zoteroResponse([], 14), zoteroDeleted([], 15)]);
  await assert.rejects(unstable.client.download(zoteroConfig, publicRead), errorCode('VERSION_CHANGED'));
  assert.equal(unstable.requests.length, 6); assert.deepEqual(unstable.delays, [250, 500]);
});

test('library identity, item versions, duplicate keys and mandatory version/count headers fail closed', async () => {
  const cases = [
    zoteroResponse([{ ...zoteroItem(), library: { type: 'group', id: 42 } }]),
    zoteroResponse([{ ...zoteroItem(), library: { type: 'user', id: 43 } }]),
    zoteroResponse([zoteroItem(1, 11)], 10), zoteroResponse([zoteroItem(1, 4)], 10),
    zoteroResponse([{ ...zoteroItem(), data: { ...zoteroItem().data, version: 9 } }]),
    zoteroResponse([zoteroItem(), zoteroItem()]), zoteroResponse([zoteroItem()], 10, { total: 2 }),
  ];
  for (const response of cases) {
    const fixture = zoteroTransport([response]);
    await assert.rejects(fixture.client.download(zoteroConfig, { ...publicRead, expectedCursor: 5 }), errorCode('INVALID_RESPONSE'));
    assert.equal(fixture.requests.length, 1);
  }
  for (const header of ['Last-Modified-Version', 'Total-Results', 'Zotero-API-Version']) {
    const response = zoteroResponse([zoteroItem()]); response.headers.delete(header);
    const fixture = zoteroTransport([response]);
    await assert.rejects(fixture.client.download(zoteroConfig, publicRead), errorCode('INVALID_RESPONSE'));
  }
  const rollback = zoteroTransport([zoteroResponse([], 4)]);
  await assert.rejects(rollback.client.download(zoteroConfig, { ...publicRead, expectedCursor: 5 }), errorCode('INVALID_CURSOR'));
});

test('duplicates across pages, malformed deletion keys and overlap with live items never yield a partial result', async () => {
  const page = Array.from({ length: 100 }, (_, index) => zoteroItem(index + 1));
  const duplicate = zoteroTransport([zoteroResponse(page, 10, { total: 101 }), zoteroResponse([page[0]], 10, { total: 101 })]);
  await assert.rejects(duplicate.client.download(zoteroConfig, publicRead), errorCode('INVALID_RESPONSE'));
  for (const deleted of [['00000001'], ['BAD'], ['00000009', '00000009']]) {
    const fixture = zoteroTransport([zoteroResponse([zoteroItem()]), zoteroDeleted(deleted)]);
    await assert.rejects(fixture.client.download(zoteroConfig, publicRead), errorCode('INVALID_RESPONSE'));
  }
});

test('the 500-key bound includes ignored and deleted items and never truncates a larger library', async () => {
  const over = zoteroTransport([zoteroResponse([], 10, { total: 501 })]);
  await assert.rejects(over.client.download(zoteroConfig, publicRead), errorCode('LIMIT')); assert.equal(over.requests.length, 1);
  const records = Array.from({ length: 500 }, (_, index) => zoteroItem(index + 1));
  const pages = Array.from({ length: 5 }, (_, page) => zoteroResponse(records.slice(page * 100, page * 100 + 100), 10, { total: 500 }));
  const limit = zoteroTransport([...pages, zoteroDeleted(['AAAAAAAA'])]);
  await assert.rejects(limit.client.download(zoteroConfig, publicRead), errorCode('LIMIT')); assert.equal(limit.requests.length, 6);
});

test('declared and streamed byte limits cancel the body and cannot return a truncated JSON snapshot', async () => {
  const large = zoteroResponse([], 10, { headers: { 'Content-Length': String(ZOTERO_LIMITS.maxBytes + 1) } });
  const declared = zoteroTransport([large]); await assert.rejects(declared.client.download(zoteroConfig, publicRead), errorCode('LIMIT'));
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(ZOTERO_LIMITS.maxBytes + 1)); }, cancel() { cancelled++; } });
  const response = new Response(body, { headers: { 'Content-Type': 'application/json', 'Zotero-API-Version': '3', 'Last-Modified-Version': '10', 'Total-Results': '0' } });
  const streamed = zoteroTransport([response]); await assert.rejects(streamed.client.download(zoteroConfig, publicRead), errorCode('LIMIT'));
  await flush(); assert.equal(cancelled, 1);
});

test('the byte budget spans discarded version attempts instead of restarting on every retry', async () => {
  const first = { ...zoteroItem(), padding: 'x'.repeat(3 * 1024 * 1024) };
  const second = { ...zoteroItem(2, 11), padding: 'x'.repeat(2 * 1024 * 1024) };
  const fixture = zoteroTransport([zoteroResponse([first]), zoteroDeleted([], 11), zoteroResponse([second], 11)]);
  await assert.rejects(fixture.client.download(zoteroConfig, publicRead), errorCode('LIMIT')); assert.equal(fixture.requests.length, 3);
});

test('invalid UTF-8, JSON and content types fail without exposing remote error content', async () => {
  const headers = { 'Content-Type': 'application/json', 'Zotero-API-Version': '3', 'Last-Modified-Version': '10', 'Total-Results': '0' };
  for (const response of [new Response(new Uint8Array([0xff]), { headers }), new Response('private response', { headers }),
    new Response('private response', { headers: { ...headers, 'Content-Type': 'text/html' } })]) {
    const fixture = zoteroTransport([response]); await assert.rejects(fixture.client.download(zoteroConfig, publicRead), errorCode('INVALID_RESPONSE'));
  }
});

test('pre-aborted and obsolete accounts make no fetch or secret request', async () => {
  const controller = new AbortController(); controller.abort();
  const store = new MemorySecretStore(); let reads = 0; store.get = async () => { reads++; return zoteroKey; };
  const fixture = zoteroTransport([]);
  await assert.rejects(fixture.client.download(zoteroConfig, { ...publicRead, signal: controller.signal,
    credential: { mode: 'stored', store, accountScope: zoteroAccount } }), errorCode('CANCELLED'));
  await assert.rejects(fixture.client.download(zoteroConfig, { ...publicRead, current: () => false }), errorCode('CHANGED'));
  assert.equal(reads, 0); assert.equal(fixture.requests.length, 0);
});

test('the total deadline bounds a non-cooperative fetch and cancels its late response body', async () => {
  const gate = deferred<Response>(); let cancelled = 0;
  const client = new ZoteroClient({ fetch: async () => gate.promise, deadlineMs: 15 });
  await assert.rejects(client.download(zoteroConfig, publicRead), errorCode('TIMEOUT'));
  gate.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await flush(); assert.equal(cancelled, 1);
});

test('the same deadline bounds secret lookup and body reads which ignore cancellation', async () => {
  const secret = deferred<string>(), store = new MemorySecretStore(); let fetched = 0;
  store.get = async () => secret.promise;
  const client = new ZoteroClient({ fetch: async () => { fetched++; return zoteroResponse([]); }, deadlineMs: 15 });
  await assert.rejects(client.download(zoteroConfig, { ...publicRead, credential: { mode: 'stored', store, accountScope: zoteroAccount } }), errorCode('TIMEOUT'));
  secret.resolve(zoteroKey); await flush(); assert.equal(fetched, 0);
  let cancelled = 0;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: {
    'Content-Type': 'application/json', 'Zotero-API-Version': '3', 'Last-Modified-Version': '10', 'Total-Results': '0' } });
  const streamClient = new ZoteroClient({ fetch: async () => stalled, deadlineMs: 15 });
  await assert.rejects(streamClient.download(zoteroConfig, publicRead), errorCode('TIMEOUT'));
  await flush(); assert.equal(cancelled, 1);
});

test('a current-scope failure after fetch prevents processing even a completed response', async () => {
  let current = true;
  const fixture = zoteroTransport([() => { current = false; return zoteroResponse([zoteroItem()]); }]);
  await assert.rejects(fixture.client.download(zoteroConfig, { ...publicRead, current: () => current }), errorCode('CHANGED'));
  assert.equal(fixture.requests.length, 1);
});

test('transport redirects, response origin changes and all HTTP failures are sanitized', async () => {
  const rejected = zoteroTransport([() => { throw new Error(`private response ${zoteroKey}`); }]);
  await assert.rejects(rejected.client.download(zoteroConfig, publicRead), errorCode('NETWORK'));
  for (const field of ['url', 'redirected']) {
    const response = zoteroResponse([]); Object.defineProperty(response, field, { value: field === 'url' ? 'https://outside.invalid/' : true });
    const fixture = zoteroTransport([response]); await assert.rejects(fixture.client.download(zoteroConfig, publicRead), errorCode('INVALID_RESPONSE'));
  }
  for (const [status, code] of [[401, 'AUTHORIZATION'], [403, 'AUTHORIZATION'], [404, 'NOT_FOUND'], [500, 'HTTP_ERROR']] as const) {
    const fixture = zoteroTransport([new Response(`private response ${zoteroKey}`, { status })]);
    await assert.rejects(fixture.client.download(zoteroConfig, publicRead), errorCode(code));
  }
});

test('stored credentials use only the explicit account/source namespace and public mode never loads one', async () => {
  const store = new MemorySecretStore(), namespace = zoteroSecretNamespace(zoteroAccount, zoteroConfig);
  await store.set(namespace, ZOTERO_SECRET_KEY, zoteroKey);
  await store.set(zoteroSecretNamespace(zoteroAccount, { ...zoteroConfig, libraryId: '43' }), ZOTERO_SECRET_KEY, 'DifferentFixtureApiKey24');
  const addresses: [string, string][] = [], get = store.get.bind(store);
  store.get = async (space, key) => { addresses.push([space, key]); return get(space, key); };
  const fixture = zoteroTransport([zoteroResponse([]), zoteroDeleted(), zoteroResponse([]), zoteroDeleted()]);
  await fixture.client.download(zoteroConfig, { ...publicRead, credential: { mode: 'stored', store, accountScope: zoteroAccount } });
  assert.deepEqual(addresses, [[namespace, ZOTERO_SECRET_KEY]]); assert.equal(fixture.requests[0].headers.get('Zotero-API-Key'), zoteroKey);
  await fixture.client.download(zoteroConfig, publicRead); assert.equal(addresses.length, 1); assert.equal(fixture.requests[2].headers.has('Zotero-API-Key'), false);
  const invalid = zoteroTransport([]);
  await assert.rejects(invalid.client.download(zoteroConfig, { ...publicRead,
    credential: { mode: 'public', token: 'PaperQuayToken' } as unknown as ZoteroCredential }), errorCode('INVALID_KEY'));
  assert.equal(invalid.requests.length, 0);
});

test('429 and 503 honor Retry-After seconds and HTTP dates before retrying GET', async () => {
  const fixture = zoteroTransport([new Response('private response', { status: 429, headers: { 'Retry-After': '2' } }),
    new Response('private response', { status: 503, headers: { 'Retry-After': new Date(1_800_000_005_000).toUTCString() } }),
    zoteroResponse([]), zoteroDeleted()]);
  const result = await refreshZoteroLibrary(fixture.client, zoteroConfig, publicRead);
  assert.deepEqual(fixture.delays, [2000, 3000]); assert.equal(result.retry.rateLimitRetries, 2); assert.equal(fixture.requests.length, 4);
  assert.ok(fixture.requests.every(request => request.init.method === 'GET'));
});

test('missing Retry-After uses bounded exponential backoff and long cooldowns are returned instead of bypassed', async () => {
  const repeated = zoteroTransport(Array.from({ length: 3 }, () => new Response('private response', { status: 429 })));
  await assert.rejects(repeated.client.download(zoteroConfig, publicRead), errorCode('RATE_LIMIT'));
  assert.deepEqual(repeated.delays, [1000, 2000]); assert.equal(repeated.requests.length, 3);
  const long = zoteroTransport([new Response(null, { status: 429, headers: { 'Retry-After': '3600' } })]);
  await assert.rejects(long.client.download(zoteroConfig, publicRead), error => {
    assert.ok(error instanceof ZoteroClientError); assert.equal(error.code, 'RATE_LIMIT'); assert.equal(error.retryAt, long.now() + 3_600_000); return true;
  });
  await assert.rejects(long.client.download(zoteroConfig, publicRead), errorCode('RATE_LIMIT'));
  assert.equal(long.requests.length, 1); assert.deepEqual(long.delays, []);
});

test('successful Backoff applies to subsequent pages and subsequent refreshes on the same client', async () => {
  const end = zoteroDeleted(); end.headers.set('Backoff', '10');
  const fixture = zoteroTransport([zoteroResponse([], 10, { headers: { Backoff: '3' } }), end, zoteroResponse(null, 10, { status: 304 })]);
  const first = await refreshZoteroLibrary(fixture.client, zoteroConfig, publicRead);
  assert.deepEqual(fixture.delays, [3000]); assert.equal(first.retry.notBefore, fixture.now() + 10_000);
  const second = await refreshZoteroLibrary(fixture.client, zoteroConfig, { ...publicRead, expectedCursor: 10 });
  assert.equal(second.unchanged, true); assert.deepEqual(fixture.delays, [3000, 10_000]);
});

test('conversion failure discards the entire download and never treats invalid paper metadata as ignored success', async () => {
  for (const data of [{ title: '' }, { DOI: 'not a doi' }, { creators: [{ creatorType: 'author', firstName: '', lastName: '' }] }]) {
    const fixture = zoteroTransport([zoteroResponse([zoteroItem(1), zoteroItem(2, 10, zoteroConfig, data)]), zoteroDeleted()]);
    await assert.rejects(refreshZoteroLibrary(fixture.client, zoteroConfig, publicRead), errorCode('INVALID_METADATA'));
  }
});
