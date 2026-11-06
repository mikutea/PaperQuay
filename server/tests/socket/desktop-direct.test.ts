import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { DesktopPdfTimings } from '../../src/desktop-pdf.ts';
import { desktopBytes, desktopFixture, gate } from '../desktop-fixtures.ts';
import { completion, directAnswer, directBase as base, directOffer } from '../direct-fixtures.ts';

type Fixture = ReturnType<typeof desktopFixture>;
async function application(t: { after(fn: () => unknown): unknown }, timings: Partial<DesktopPdfTimings> = {}) {
  const f = desktopFixture(); const app = await f.create({ requestTtlMs: 10000, presenceTtlMs: 15000,
    pollTimeoutMs: 20, recheckIntervalMs: 1000, recheckTimeoutMs: 1500, ...timings });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 }); t.after(() => app.close());
  return { f, app, origin };
}
async function json(origin: string, f: Fixture, path: string, method = 'GET', body?: unknown, who = 'consumer') {
  const response = await fetch(origin + path, { method, headers: { ...f.headers(who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, value: await response.json() as any };
}
const path = (id: string, action = '') => base + '/requests/' + id + '/direct' + (action ? '/' + action : '');
async function assigned(origin: string, f: Fixture) {
  const online = await json(origin, f, base + '/provider/poll', 'POST', { direct: true }, 'provider');
  assert.equal(online.status, 200); assert.equal(online.value.request, null);
  const created = await json(origin, f, base + '/requests', 'POST', { attachmentVersionId: f.target.version.entityId, direct: { offer: directOffer } });
  assert.equal(created.status, 201); const id = created.value.requestId as string;
  const polled = await json(origin, f, base + '/provider/poll', 'POST', { direct: true }, 'provider');
  assert.equal(polled.status, 200); assert.equal(polled.value.request?.requestId, id); assert.ok(polled.value.request?.direct);
  return { id, expiresAt: created.value.expiresAt as string };
}
async function authorize(origin: string, f: Fixture, id: string) {
  assert.equal((await json(origin, f, path(id, 'answer'), 'POST', { sdp: directAnswer }, 'provider')).status, 200);
  assert.equal((await json(origin, f, path(id, 'authorize'), 'POST', {}, 'provider')).status, 200);
}
async function relayReady(origin: string, f: Fixture, id: string) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const state = await json(origin, f, path(id), 'GET', undefined, 'provider');
    assert.equal(state.status, 200); assert.equal(state.value.state, 'relay');
    if (state.value.relayReady) return state.value;
    assert.ok(Date.now() < deadline, 'consumer content request never became ready'); await delay(5);
  }
}

test('a real direct-signaling completion can recover a discarded HTTP reply without uploading PDF content', { timeout: 15000 }, async (t) => {
  const { f, app, origin } = await application(t); let fileRequests = 0;
  app.server.on('request', (incoming) => { if (incoming.url?.endsWith('/content')) fileRequests++; });
  const { id } = await assigned(origin, f); await authorize(origin, f, id);
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify(completion(f));
    const request = http.request(origin + path(id, 'complete'), { method: 'POST', agent: false,
      headers: { ...f.headers(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
      assert.equal(response.statusCode, 200); response.destroy(); request.destroy(); resolve();
    });
    request.on('error', reject); request.end(body);
  });
  const state = await json(origin, f, path(id)); assert.equal(state.status, 200);
  assert.equal(state.value.state, 'complete'); assert.equal(state.value.answer, null); assert.equal(state.value.authorizedUntil, null);
  assert.equal(state.headers.get('cache-control'), 'no-store');
  const replay = await json(origin, f, path(id, 'complete'), 'POST', completion(f));
  assert.equal(replay.status, 200); assert.deepEqual(replay.value, { received: true }); assert.equal(fileRequests, 0);
});

test('real HTTP fallback transfers the exact PDF on the original request only after its consumer is ready', { timeout: 15000 }, async (t) => {
  const { f, app, origin } = await application(t); const fileRequests: string[] = [];
  app.server.on('request', (incoming) => { if (incoming.url?.endsWith('/content')) fileRequests.push(incoming.method + ' ' + incoming.url); });
  const transfer = await assigned(origin, f); const { id } = transfer;
  const fallback = await json(origin, f, path(id, 'fallback'), 'POST', {}); assert.equal(fallback.status, 200);
  assert.deepEqual(fallback.value, { state: 'relay' });
  const state = await json(origin, f, path(id), 'GET', undefined, 'provider');
  assert.equal(state.value.relayReady, false); assert.equal(state.value.expiresAt, transfer.expiresAt);
  const contentPath = base + '/requests/' + id + '/content';
  const download = fetch(origin + contentPath, { headers: f.headers() });
  const ready = await relayReady(origin, f, id); assert.equal(ready.expiresAt, transfer.expiresAt);
  const upload = await fetch(origin + contentPath, { method: 'POST', headers: { ...f.headers('provider'),
    'content-type': 'application/pdf', 'content-length': String(desktopBytes.length) }, body: desktopBytes });
  assert.equal(upload.status, 200); assert.deepEqual(await upload.json(), { sent: true });
  const received = await download; assert.equal(received.status, 200); assert.equal(received.headers.get('accept-ranges'), 'none');
  assert.deepEqual(Buffer.from(await received.arrayBuffer()), desktopBytes);
  assert.deepEqual(fileRequests, ['GET ' + contentPath, 'POST ' + contentPath]);
  assert.equal((await json(origin, f, path(id))).status, 404);
});

test('disconnecting a status socket and cancelling its lease retains admission until the DB work settles', { timeout: 15000 }, async (t) => {
  const { f, origin } = await application(t); const { id } = await assigned(origin, f);
  const held = gate(); const resume = gate(); t.after(() => resume.resolve());
  f.state.beforeCheck = async () => { held.resolve(); await resume.promise; };
  const request = http.get(origin + path(id), { agent: false, headers: f.headers('provider') });
  request.on('error', () => undefined); t.after(() => request.destroy()); await held.promise;
  request.destroy();
  assert.equal((await json(origin, f, base + '/requests/' + id, 'DELETE')).status, 200);
  const payload = { attachmentVersionId: f.target.version.entityId, direct: { offer: directOffer } };
  const blocked = await json(origin, f, base + '/requests', 'POST', payload);
  assert.equal(blocked.status, 429); assert.ok(blocked.headers.get('retry-after'));
  f.state.beforeCheck = undefined; resume.resolve(); await delay(10);
  const next = await json(origin, f, base + '/requests', 'POST', payload); assert.equal(next.status, 201);
  assert.equal((await json(origin, f, base + '/requests/' + next.value.requestId, 'DELETE')).status, 200);
});

test('a real provider revocation invalidates its completed receipt and all late control requests', { timeout: 15000 }, async (t) => {
  const { f, origin } = await application(t); const { id } = await assigned(origin, f); await authorize(origin, f, id);
  assert.equal((await json(origin, f, path(id, 'complete'), 'POST', completion(f))).status, 200);
  const providerId = f.views.get(f.identities.provider.sessionId)!.device.id;
  assert.equal((await json(origin, f, '/v1/devices/' + providerId, 'DELETE', undefined, 'peer')).status, 200);
  for (const action of ['', 'complete', 'fallback']) {
    const result = await json(origin, f, path(id, action), action ? 'POST' : 'GET', action ? action === 'complete' ? completion(f) : {} : undefined);
    assert.equal(result.status, 404); assert.equal(result.value.error.code, 'NOT_FOUND');
  }
});
