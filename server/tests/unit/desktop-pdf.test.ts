import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { SERVER_LIMITS } from '../../src/config.ts';
import { desktopBytes, desktopFixture, gate } from '../desktop-fixtures.ts';
import { identity, testConfig } from '../fixtures.ts';

const base = '/v1/desktop-pdfs';
type Fixture = ReturnType<typeof desktopFixture>;
async function online(app: FastifyInstance, f: Fixture, provider = 'provider') {
  const result = await app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers(provider), payload: {} });
  assert.equal(result.statusCode, 200, result.body); assert.deepEqual(result.json(), { request: null });
}
async function createRequest(app: FastifyInstance, f: Fixture) {
  const result = await app.inject({ method: 'POST', url: base + '/requests', headers: f.headers(), payload: { attachmentVersionId: f.target.version.entityId } });
  assert.equal(result.statusCode, 201, result.body);
  return result.json() as { requestId: string; attachmentVersionId: string; expiresAt: string };
}
async function dispatch(app: FastifyInstance, f: Fixture, requestId: string, provider = 'provider') {
  const download = app.inject({ method: 'GET', url: base + '/requests/' + requestId + '/content', headers: f.headers() }).then((result) => result);
  const polled = await app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers(provider), payload: {} });
  assert.equal(polled.statusCode, 200, polled.body); assert.equal(polled.json().request?.requestId, requestId);
  return { download, job: polled.json().request };
}
function upload(app: FastifyInstance, f: Fixture, id: string, body = desktopBytes, provider = 'provider') {
  return app.inject({ method: 'POST', url: base + '/requests/' + id + '/content', payload: body,
    headers: { ...f.headers(provider), 'content-type': 'application/pdf', 'content-length': String(body.byteLength) } });
}

test('desktop transport is independently opt-in and exposes bounded, non-persistent capability limits', async (t) => {
  assert.equal(testConfig().desktopPdfEnabled, false);
  for (const value of ['true', 'yes', '', '2', ' 1']) assert.throws(() => testConfig({ PAPERQUAY_DESKTOP_PDF_ENABLED: value }), { code: 'CONFIGURATION_INVALID' });
  const f = desktopFixture(); const off = await f.create({}, false); const app = await f.create();
  t.after(async () => { await off.close(); await app.close(); });
  await assert.rejects(buildApp({ config: testConfig({ PAPERQUAY_DESKTOP_PDF_ENABLED: '1' }), repository: f.repository, verifyToken: async () => identity() }), { code: 'CONFIGURATION_INVALID' });
  const old = (await off.inject('/v1/capabilities')).json(); const current = (await app.inject('/v1/capabilities')).json();
  assert.equal(old.desktopPdf, undefined); assert.deepEqual(old.features, { paperOrganization: 1,richNotes:1,aiConversations:1 });
  assert.deepEqual(current.features, { paperOrganization: 1,richNotes:1,aiConversations:1, desktopPdfTransfer: 1 });
  assert.equal(current.pdfStorage, false); assert.equal(current.cloudPdf, undefined);
  assert.equal(current.desktopPdf.transport, 'http-relay-v1');
  assert.equal(current.desktopPdf.maxFileBytes, 64 * 1024 * 1024);
  assert.equal(current.desktopPdf.accountWindowBytes, 256 * 1024 * 1024);
  assert.equal(current.limits.maxRequestBytes, old.limits.maxRequestBytes);
  const disabled = await off.inject({ url: base + '/versions', headers: f.headers() });
  assert.equal(disabled.statusCode, 503); assert.equal(disabled.json().error.code, 'DESKTOP_PDF_TRANSFER_DISABLED');
});

test('metadata endpoints expose only the active account PDF target and bounded UUID keyset pagination', async (t) => {
  const f = desktopFixture(); const app = await f.create(); t.after(() => app.close());
  const detail = await app.inject({ url: base + '/versions/' + f.target.version.entityId, headers: f.headers() });
  assert.equal(detail.statusCode, 200); assert.deepEqual(detail.json(), f.target);
  const list = await app.inject({ url: base + '/versions?limit=25', headers: f.headers() });
  assert.deepEqual(list.json(), { items: [f.target], nextAfter: null, hasMore: false });
  for (const query of ['limit=101', 'limit=0', 'limit=01', 'after=not-a-uuid', 'path=private']) {
    assert.equal((await app.inject({ url: base + '/versions?' + query, headers: f.headers() })).statusCode, 400);
  }
  assert.deepEqual((await app.inject({ url: base + '/versions', headers: f.headers('other') })).json().items, []);
  for (const id of [f.target.version.entityId, randomUUID()]) {
    const result = await app.inject({ url: base + '/versions/' + id, headers: f.headers('other') });
    assert.equal(result.statusCode, 404); assert.equal(result.json().error.code, 'NOT_FOUND');
  }
  f.state.paperDeleted = true;
  assert.equal((await app.inject({ url: base + '/versions/' + f.target.version.entityId, headers: f.headers() })).statusCode, 410);
  assert.deepEqual((await app.inject({ url: base + '/versions', headers: f.headers() })).json().items, []);
});

test('the desktop routes require a verified token expiry without breaking existing non-desktop seams', async (t) => {
  const f = desktopFixture(); delete f.identities.consumer.expiresAtMs;
  const app = await f.create(); t.after(() => app.close());
  assert.equal((await app.inject({ url: '/v1/me', headers: f.headers() })).statusCode, 200);
  assert.equal((await app.inject({ url: base + '/versions', headers: f.headers() })).statusCode, 401);
  f.identities.consumer.expiresAtMs = Date.now() + 1000;
  const response = await app.inject({ method: 'POST', url: base + '/requests', headers: f.headers(), payload: { attachmentVersionId: f.target.version.entityId } });
  assert.equal(response.statusCode, 401);
  f.identities.provider.expiresAtMs = Date.now() + 1000;
  const provider = await app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers('provider'), payload: {} });
  assert.equal(provider.statusCode, 401);
});

test('same-account distinct sessions exchange exactly one verified file with no cloud copy', async (t) => {
  const f = desktopFixture(); const app = await f.create(); t.after(() => app.close());
  await online(app, f); const request = await createRequest(app, f);
  const { download, job } = await dispatch(app, f, request.requestId);
  assert.deepEqual(Object.keys(job).sort(), ['attachmentVersionId', 'expiresAt', 'requestId', 'sha256', 'sizeBytes']);
  const posted = await upload(app, f, request.requestId); assert.equal(posted.statusCode, 200, posted.body);
  assert.deepEqual(posted.json(), { sent: true });
  const content = await download; assert.equal(content.statusCode, 200, content.body);
  assert.deepEqual(content.rawPayload, desktopBytes); assert.equal(content.headers['accept-ranges'], 'none');
  assert.equal(Number(content.headers['content-length']), desktopBytes.byteLength); assert.equal(content.headers['cache-control'], 'no-store');
  assert.ok(String(content.headers['access-control-expose-headers']).includes('Accept-Ranges'));
  assert.ok(f.state.checks >= 4, 'admission, consumer, provider, and final checks must run');
  assert.equal((await upload(app, f, request.requestId)).statusCode, 404);
  assert.equal((await app.inject({ url: base + '/requests/' + request.requestId + '/content', headers: f.headers() })).statusCode, 404);
  const next = await createRequest(app, f);
  assert.notEqual(next.requestId, request.requestId);
  await app.inject({ method: 'DELETE', url: base + '/requests/' + next.requestId, headers: f.headers() });
});

test('foreign accounts, other same-account sessions and unassigned providers cannot inspect or consume requests', async (t) => {
  const f = desktopFixture(); const app = await f.create(); t.after(() => app.close());
  await online(app, f); const request = await createRequest(app, f);
  for (const name of ['other', 'peer', 'provider2']) for (const id of [request.requestId, randomUUID()]) {
    for (const method of ['GET', 'DELETE'] as const) {
      const result = await app.inject({ method, url: base + '/requests/' + id + (method === 'GET' ? '/content' : ''), headers: f.headers(name) });
      assert.equal(result.statusCode, 404); assert.equal(result.json().error.code, 'NOT_FOUND');
    }
    assert.equal((await upload(app, f, id, desktopBytes, name)).statusCode, 404);
  }
  await app.inject({ method: 'DELETE', url: base + '/requests/' + request.requestId, headers: f.headers() });
  f.views.get(f.identities.consumer.sessionId)!.device.platform = 'windows';
  await app.inject({ method: 'DELETE', url: base + '/provider', headers: f.headers('provider') });
  await online(app, f, 'consumer');
  const same = await app.inject({ method: 'POST', url: base + '/requests', headers: f.headers(), payload: { attachmentVersionId: f.target.version.entityId } });
  assert.equal(same.statusCode, 404); assert.equal(same.json().error.code, 'DESKTOP_PDF_UNAVAILABLE');
});

test('cancellation frees a request and neither a late upload nor old GET can reopen it', async (t) => {
  const f = desktopFixture(); const app = await f.create(); t.after(() => app.close());
  await online(app, f); const request = await createRequest(app, f);
  const { download } = await dispatch(app, f, request.requestId);
  const duplicate = await app.inject({ url: base + '/requests/' + request.requestId + '/content', headers: f.headers() });
  assert.equal(duplicate.statusCode, 409);
  const cancelled = await app.inject({ method: 'DELETE', url: base + '/requests/' + request.requestId, headers: f.headers() });
  assert.deepEqual(cancelled.json(), { cancelled: true });
  assert.equal((await download).statusCode, 409);
  assert.equal((await upload(app, f, request.requestId)).statusCode, 404);
  const next = await createRequest(app, f); assert.notEqual(next.requestId, request.requestId);
  assert.equal((await app.inject({ method: 'DELETE', url: base + '/requests/' + request.requestId, headers: f.headers() })).statusCode, 404);
  await app.inject({ method: 'DELETE', url: base + '/requests/' + next.requestId, headers: f.headers() });
});

test('a provider decline advances only to a different online session, with no reused claim', async (t) => {
  const f = desktopFixture(); const app = await f.create(); t.after(() => app.close());
  await online(app, f); await online(app, f, 'provider2');
  const request = await createRequest(app, f); const { download } = await dispatch(app, f, request.requestId);
  const nextPoll = app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers('provider2'), payload: {} }).then((response) => response);
  const declined = await app.inject({ method: 'POST', url: base + '/requests/' + request.requestId + '/unavailable', headers: f.headers('provider'), payload: {} });
  assert.equal(declined.statusCode, 200); assert.equal((await nextPoll).json().request.requestId, request.requestId);
  assert.equal((await upload(app, f, request.requestId)).statusCode, 404);
  assert.equal((await upload(app, f, request.requestId, desktopBytes, 'provider2')).statusCode, 200);
  assert.deepEqual((await download).rawPayload, desktopBytes);
});

test('integrity failure cannot send the held final bytes or report a successful transfer', async (t) => {
  const f = desktopFixture(); const app = await f.create(); t.after(() => app.close());
  await online(app, f); const request = await createRequest(app, f); const { download } = await dispatch(app, f, request.requestId);
  const corrupt = Buffer.from(desktopBytes); corrupt[15] ^= 1;
  const posted = await upload(app, f, request.requestId, corrupt);
  assert.equal(posted.statusCode, 422, posted.body); assert.equal(posted.json().error.code, 'PDF_INTEGRITY_MISMATCH');
  const received = await download; assert.notEqual(received.statusCode, 200);
  assert.ok(received.rawPayload.byteLength < desktopBytes.byteLength || received.headers['content-type'] !== 'application/pdf');
});

test('provider session churn cannot extend a request beyond four distinct candidate attempts', async (t) => {
  const f = desktopFixture();
  const names = ['provider', 'provider2', 'provider3', 'provider4', 'provider5'];
  for (const name of names.slice(2)) {
    const who = { ...f.identities.provider, sessionId: randomUUID() }; f.identities[name] = who;
    const view = structuredClone(f.views.get(f.identities.provider.sessionId)!); view.device.id = randomUUID();
    f.views.set(who.sessionId, view);
  }
  const app = await f.create({ requestTtlMs: 5000, presenceTtlMs: 10000, claimTimeoutMs: 1000 }); t.after(() => app.close());
  await online(app, f); const request = await createRequest(app, f); const { download } = await dispatch(app, f, request.requestId);
  for (let index = 0; index < 4; index++) {
    const current = names[index]; const next = names[index + 1];
    await online(app, f, next);
    const polling = app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers(next), payload: {} }).then((result) => result);
    const declined = await app.inject({ method: 'POST', url: base + '/requests/' + request.requestId + '/unavailable', headers: f.headers(current), payload: {} });
    assert.equal(declined.statusCode, 200);
    const result = await polling; assert.equal(result.statusCode, 200);
    if (index === 3) assert.deepEqual(result.json(), { request: null });
    else assert.equal(result.json().request?.requestId, request.requestId);
    assert.equal((await app.inject({ method: 'DELETE', url: base + '/provider', headers: f.headers(current) })).statusCode, 200);
  }
  const result = await download; assert.equal(result.statusCode, 404); assert.equal(result.json().error.code, 'DESKTOP_PDF_UNAVAILABLE');
});

test('version changes, parent tombstones, provider stop, and device revocation invalidate waiting transfers', async (t) => {
  for (const change of ['version', 'parent', 'stop', 'consumer-revoke', 'provider-revoke'] as const) {
    const f = desktopFixture(); const app = await f.create(); t.after(() => app.close());
    await online(app, f); const request = await createRequest(app, f); const { download } = await dispatch(app, f, request.requestId);
    if (change === 'version') f.target.version.revision++;
    else if (change === 'parent') f.state.paperDeleted = true;
    else if (change === 'stop') await app.inject({ method: 'DELETE', url: base + '/provider', headers: f.headers('provider') });
    else {
      const who = change === 'consumer-revoke' ? 'consumer' : 'provider';
      const id = f.views.get(f.identities[who].sessionId)!.device.id;
      const result = await app.inject({ method: 'DELETE', url: '/v1/devices/' + id, headers: f.headers('peer') });
      assert.equal(result.statusCode, 200);
    }
    const result = await download;
    assert.equal(result.statusCode, change === 'version' ? 409 : change === 'parent' ? 410 : change === 'consumer-revoke' ? 403 : 404);
    assert.equal((await upload(app, f, request.requestId)).statusCode, 404);
  }
});

test('a stalled authorization check fails closed and keeps its slot until the unfinished DB work settles', async (t) => {
  const f = desktopFixture(); const app = await f.create({ recheckTimeoutMs: 40 }); t.after(() => app.close());
  await online(app, f); const request = await createRequest(app, f);
  const blocked = gate(); const started = gate(); f.state.beforeCheck = async () => { started.resolve(); await blocked.promise; };
  const download = app.inject({ url: base + '/requests/' + request.requestId + '/content', headers: f.headers() }).then((result) => result);
  await started.promise;
  assert.equal((await download).statusCode, 503);
  const stillBusy = await app.inject({ method: 'POST', url: base + '/requests', headers: f.headers(), payload: { attachmentVersionId: f.target.version.entityId } });
  assert.equal(stillBusy.statusCode, 429);
  blocked.resolve(); f.state.beforeCheck = undefined; await delay(1);
  const next = await createRequest(app, f);
  await app.inject({ method: 'DELETE', url: base + '/requests/' + next.requestId, headers: f.headers() });
});

test('account admission, poll concurrency, and pessimistic byte budgets remain bounded after cancellation', async (t) => {
  const f = desktopFixture(); const app = await f.create({ pollTimeoutMs: 100 }); t.after(() => app.close());
  const firstPoll = app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers('provider'), payload: {} }).then((result) => result);
  await delay(1);
  const duplicatePoll = await app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers('provider'), payload: {} });
  assert.equal(duplicatePoll.statusCode, 409); await firstPoll;
  f.target.version.data.sizeBytes = SERVER_LIMITS.desktopPdfMaxFileBytes;
  for (let index = 0; index < 4; index++) {
    const request = await createRequest(app, f);
    const second = await app.inject({ method: 'POST', url: base + '/requests', headers: f.headers(), payload: { attachmentVersionId: f.target.version.entityId } });
    assert.equal(second.statusCode, 429);
    await app.inject({ method: 'DELETE', url: base + '/requests/' + request.requestId, headers: f.headers() });
  }
  const exhausted = await app.inject({ method: 'POST', url: base + '/requests', headers: f.headers(), payload: { attachmentVersionId: f.target.version.entityId } });
  assert.equal(exhausted.statusCode, 429); assert.ok(Number(exhausted.headers['retry-after']) > 1);
});

test('short fixed leases expire without permitting a late provider upload', async (t) => {
  const f = desktopFixture(); const app = await f.create({ requestTtlMs: 100, claimTimeoutMs: 100 }); t.after(() => app.close());
  await online(app, f); const request = await createRequest(app, f); const { download } = await dispatch(app, f, request.requestId);
  const expired = await download; assert.equal(expired.statusCode, 408);
  assert.equal((await upload(app, f, request.requestId)).statusCode, 404);
  const next = await createRequest(app, f);
  await app.inject({ method: 'DELETE', url: base + '/requests/' + next.requestId, headers: f.headers() });
});
