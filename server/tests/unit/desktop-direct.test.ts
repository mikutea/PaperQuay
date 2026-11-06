import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { checkedDesktopPdfStunUrls, SERVER_LIMITS } from '../../src/config.ts';
import { desktopBytes, desktopFixture, gate } from '../desktop-fixtures.ts';
import { completion, control, directAnswer, directAssigned, directBase as base, directCreate, directOffer,
  directOnline, finalAuthorized } from '../direct-fixtures.ts';

async function fixture(t: { after(fn: () => unknown): unknown }, timings = {}) {
  const f = desktopFixture();
  const app = await f.create({ requestTtlMs: 10000, presenceTtlMs: 30000, recheckIntervalMs: 1000, ...timings });
  t.after(() => app.close()); await directOnline(app, f); return { f, app };
}
function code(response: { statusCode: number; json(): any }, status: number, name: string) {
  assert.equal(response.statusCode, status); assert.equal(response.json().error.code, name);
}
async function cancel(app: FastifyInstance, f: ReturnType<typeof desktopFixture>, id: string) {
  return app.inject({ method: 'DELETE', url: base + '/requests/' + id, headers: f.headers() });
}

test('direct capability keeps the HTTP transport and accepts only bounded STUN configuration', async (t) => {
  const { app } = await fixture(t);
  const capability = (await app.inject('/v1/capabilities')).json();
  assert.equal(capability.features.desktopPdfTransfer, 1); assert.equal(capability.desktopPdf.transport, 'http-relay-v1');
  assert.deepEqual(capability.desktopPdf.direct, { transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls: [] });
  assert.deepEqual(checkedDesktopPdfStunUrls(undefined), []); assert.deepEqual(checkedDesktopPdfStunUrls('  '), []);
  for (const value of ['stun:example.test:3478', 'stuns:[2001:db8::1]:5349', 'stun:192.0.2.1']) assert.deepEqual(checkedDesktopPdfStunUrls(value), [value]);
  assert.deepEqual(checkedDesktopPdfStunUrls('stun:a.test, stuns:b.test:5349'), ['stun:a.test', 'stuns:b.test:5349']);
  for (const value of ['turn:a.test', 'turns:a.test', 'stun:user:secret@a.test', 'stun:a.test/path', 'stun:a.test?x=1',
    'stun:a.test#x', 'stun:a.test:0', 'stun:a.test:65536', 'stun:[bad]', 'stun:[127.0.0.1]', 'stun:999.1.1.1',
    'stun:-a.test', 'stun:a..test', 'stun:a.test,', 'stun:a,stun:b,stun:c', ' '.repeat(257), 'stun:' + 'a'.repeat(252)]) {
    assert.throws(() => checkedDesktopPdfStunUrls(value), { code: 'CONFIGURATION_INVALID' });
  }
});

test('only bounded data-only SDP is accepted and no extra request fields are stripped silently', async (t) => {
  const { f, app } = await fixture(t);
  for (const offer of ['', directOffer + 'm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n', directOffer.replace('typ host', 'typ relay'),
    directOffer + 'a=candidate:2 1 udp 1 192.0.2.1 5001 typ ReLaY\r\n', directOffer + 'a=x:私密\r\n',
    directOffer + 'a=x:' + 'a'.repeat(1025), directOffer + 'a=x\r\n'.repeat(513),
    directOffer + 'a=candidate:2 1 udp 1 192.0.2.1 5001 typ host\r\n'.repeat(32), 'x'.repeat(32769)]) {
    code(await directCreate(app, f, offer), 400, 'VALIDATION_FAILED');
  }
  for (const payload of [{ direct: false }, { direct: true, extra: true }]) {
    code(await app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers('provider'), payload }), 400, 'VALIDATION_FAILED');
  }
  const started = await directAssigned(app, f);
  code(await control(app, f, started.id, 'answer', 'provider', { sdp: directAnswer, extra: true }), 400, 'VALIDATION_FAILED');
  assert.equal((await cancel(app, f, started.id)).statusCode, 200);
});

test('direct signaling succeeds without HTTP content and retains an exact expiring completion receipt', async (t) => {
  const { f, app } = await fixture(t); const transfer = await directAssigned(app, f);
  assert.deepEqual(Object.keys(transfer.created).sort(), ['attachmentVersionId', 'expiresAt', 'requestId']);
  assert.ok(Date.parse(transfer.job.direct.expiresAt) <= Date.parse(transfer.created.expiresAt));
  const first = await control(app, f, transfer.id); assert.equal(first.statusCode, 200);
  assert.deepEqual(Object.keys(first.json()).sort(), ['answer', 'authorizedUntil', 'directExpiresAt', 'expiresAt', 'relayReady', 'state']);
  assert.equal(first.json().state, 'direct'); assert.equal(first.json().answer, null); assert.equal(first.json().relayReady, false);
  assert.ok(Date.parse(first.json().authorizedUntil) <= Date.now() + 2000);
  assert.equal(first.headers['cache-control'], 'no-store');
  code(await control(app, f, transfer.id, 'complete', 'consumer', completion(f)), 409, 'DESKTOP_PDF_REQUEST_IN_USE');
  code(await control(app, f, transfer.id, 'authorize', 'provider'), 409, 'DESKTOP_PDF_REQUEST_IN_USE');
  const permit = await finalAuthorized(app, f, transfer.id);
  assert.ok(Date.parse(permit.authorizedUntil) <= Date.parse(transfer.job.direct.expiresAt));
  assert.equal((await control(app, f, transfer.id)).json().answer, directAnswer);
  assert.equal((await control(app, f, transfer.id, 'answer', 'provider', { sdp: directAnswer })).statusCode, 200);
  code(await control(app, f, transfer.id, 'answer', 'provider', { sdp: directOffer }), 409, 'DESKTOP_PDF_REQUEST_IN_USE');
  code(await control(app, f, transfer.id, 'complete', 'provider', completion(f)), 404, 'NOT_FOUND');
  code(await control(app, f, transfer.id, 'complete', 'consumer', { ...completion(f), sha256: '0'.repeat(64) }), 422, 'PDF_INTEGRITY_MISMATCH');
  assert.deepEqual((await control(app, f, transfer.id, 'complete', 'consumer', completion(f))).json(), { received: true });
  for (const who of ['consumer', 'provider']) {
    const receipt = await control(app, f, transfer.id, '', who); assert.equal(receipt.statusCode, 200);
    assert.deepEqual(receipt.json(), { state: 'complete', answer: null, expiresAt: transfer.created.expiresAt,
      directExpiresAt: transfer.job.direct.expiresAt, authorizedUntil: null, relayReady: false });
  }
  assert.deepEqual((await control(app, f, transfer.id, 'complete', 'consumer', completion(f))).json(), { received: true });
  code(await control(app, f, transfer.id, 'fallback'), 409, 'DESKTOP_PDF_REQUEST_IN_USE');
  const next = await directCreate(app, f); assert.equal(next.statusCode, 201); await cancel(app, f, next.json().requestId);
});

test('completion receipt retries never renew its lifetime or permit and revalidate the original target', async (t) => {
  const { f, app } = await fixture(t, { directReceiptMs: 180 }); const { id } = await directAssigned(app, f);
  await finalAuthorized(app, f, id); assert.equal((await control(app, f, id, 'complete', 'consumer', completion(f))).statusCode, 200);
  await delay(100);
  assert.equal((await control(app, f, id, 'complete', 'consumer', completion(f))).statusCode, 200);
  await delay(100); code(await control(app, f, id), 404, 'NOT_FOUND');
  const second = await directAssigned(app, f); await finalAuthorized(app, f, second.id);
  assert.equal((await control(app, f, second.id, 'complete', 'consumer', completion(f))).statusCode, 200);
  f.target.paper.revision++;
  code(await control(app, f, second.id), 409, 'DESKTOP_PDF_CHANGED');
  code(await control(app, f, second.id), 404, 'NOT_FOUND');
});

test('direct controls hide requests from foreign accounts, another SID and the wrong client binding', async (t) => {
  const { f, app } = await fixture(t); const { id } = await directAssigned(app, f);
  f.identities.wrongClient = { ...f.identities.consumer, clientId: 'unbound-client' };
  for (const who of ['other', 'otherProvider', 'peer', 'provider2', 'wrongClient']) {
    code(await control(app, f, id, '', who), 404, 'NOT_FOUND');
    code(await control(app, f, id, 'answer', who, { sdp: directAnswer }), 404, 'NOT_FOUND');
    code(await control(app, f, id, 'authorize', who), 404, 'NOT_FOUND');
    code(await control(app, f, id, 'complete', who, completion(f)), 404, 'NOT_FOUND');
    code(await control(app, f, id, 'fallback', who), 404, 'NOT_FOUND');
  }
  code(await control(app, f, id, 'answer', 'consumer', { sdp: directAnswer }), 404, 'NOT_FOUND');
  code(await control(app, f, id, 'authorize', 'consumer'), 404, 'NOT_FOUND');
  await finalAuthorized(app, f, id); await control(app, f, id, 'complete', 'consumer', completion(f));
  for (const who of ['other', 'peer', 'wrongClient']) code(await control(app, f, id, '', who), 404, 'NOT_FOUND');
});

test('a legacy provider gets the original relay job and direct requests immediately downgrade', async (t) => {
  const f = desktopFixture(); const app = await f.create({ requestTtlMs: 5000 }); t.after(() => app.close());
  await directOnline(app, f, false); const created = await directCreate(app, f); assert.equal(created.statusCode, 201);
  const id = created.json().requestId; const state = await control(app, f, id);
  assert.equal(state.json().state, 'relay'); assert.equal(state.json().authorizedUntil, null); assert.equal(state.json().relayReady, false);
  const download = app.inject({ url: base + '/requests/' + id + '/content', headers: f.headers() }).then((r) => r);
  const polled = await app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers('provider'), payload: {} });
  assert.deepEqual(Object.keys(polled.json().request).sort(), ['attachmentVersionId', 'expiresAt', 'requestId', 'sha256', 'sizeBytes']);
  const upload = await app.inject({ method: 'POST', url: base + '/requests/' + id + '/content', payload: desktopBytes,
    headers: { ...f.headers('provider'), 'content-type': 'application/pdf', 'content-length': String(desktopBytes.length) } });
  assert.equal(upload.statusCode, 200, upload.body); assert.deepEqual((await download).rawPayload, desktopBytes);
});

test('explicit fallback is irreversible, preserves its lease and charges the shared byte budget once', async (t) => {
  const { f, app } = await fixture(t);
  f.target.version.data.sizeBytes = SERVER_LIMITS.desktopPdfMaxFileBytes;
  for (let index = 0; index < 4; index++) {
    const transfer = await directAssigned(app, f);
    code(await app.inject({ url: base + '/requests/' + transfer.id + '/content', headers: f.headers() }), 409, 'DESKTOP_PDF_REQUEST_IN_USE');
    assert.deepEqual((await control(app, f, transfer.id, 'fallback')).json(), { state: 'relay' });
    assert.deepEqual((await control(app, f, transfer.id, 'fallback', 'provider')).json(), { state: 'relay' });
    const state = (await control(app, f, transfer.id)).json();
    assert.equal(state.state, 'relay'); assert.equal(state.expiresAt, transfer.created.expiresAt);
    assert.equal(state.answer, null); assert.equal(state.authorizedUntil, null);
    for (const [action, body, who] of [['answer', { sdp: directAnswer }, 'provider'], ['authorize', {}, 'provider'], ['complete', completion(f), 'consumer']] as const) {
      code(await control(app, f, transfer.id, action, who, body), 409, 'DESKTOP_PDF_DIRECT_FALLBACK');
    }
    assert.equal((await cancel(app, f, transfer.id)).statusCode, 200);
  }
  code(await directCreate(app, f), 429, 'DESKTOP_PDF_TRANSFER_BUSY');
});

test('the fixed direct timer downgrades once and clips short authorization permits', async (t) => {
  const { f, app } = await fixture(t, { directAttemptMs: 180, directAuthorizationMs: 100 }); const { id, created, job } = await directAssigned(app, f);
  const state = (await control(app, f, id)).json();
  assert.ok(Date.parse(state.authorizedUntil) <= Date.now() + 100);
  assert.ok(Date.parse(state.authorizedUntil) <= Date.parse(job.direct.expiresAt));
  await delay(220);
  const fallback = (await control(app, f, id)).json();
  assert.equal(fallback.state, 'relay'); assert.equal(fallback.expiresAt, created.expiresAt); assert.equal(fallback.authorizedUntil, null);
  code(await control(app, f, id, 'answer', 'provider', { sdp: directAnswer }), 409, 'DESKTOP_PDF_DIRECT_FALLBACK');
});

test('a direct deadline during assignment validation reuses the waiting provider for the later relay GET', async (t) => {
  const { f, app } = await fixture(t, { directAttemptMs: 120, pollTimeoutMs: 500, recheckTimeoutMs: 1000 });
  const created = await directCreate(app, f); assert.equal(created.statusCode, 201); const id = created.json().requestId;
  const held = gate(); const resume = gate(); t.after(() => resume.resolve());
  f.state.beforeCheck = async () => { held.resolve(); await resume.promise; };
  const polling = app.inject({ method: 'POST', url: base + '/provider/poll', headers: f.headers('provider'), payload: { direct: true } }).then((r) => r);
  await held.promise; f.state.beforeCheck = undefined; await delay(160);
  assert.equal((await control(app, f, id)).json().state, 'relay'); resume.resolve(); await delay(0);
  const download = app.inject({ url: base + '/requests/' + id + '/content', headers: f.headers() }).then((r) => r);
  const job = await polling; assert.equal(job.statusCode, 200); assert.equal(job.json().request?.requestId, id);
  assert.equal(job.json().request.direct, undefined);
  const upload = await app.inject({ method: 'POST', url: base + '/requests/' + id + '/content', payload: desktopBytes,
    headers: { ...f.headers('provider'), 'content-type': 'application/pdf', 'content-length': String(desktopBytes.length) } });
  assert.equal(upload.statusCode, 200, upload.body); assert.deepEqual((await download).rawPayload, desktopBytes);
});

test('a fallback that wins a pending final check prevents completion and keeps the same relay lease', async (t) => {
  const { f, app } = await fixture(t, { recheckTimeoutMs: 1000 }); const { id, created } = await directAssigned(app, f);
  await finalAuthorized(app, f, id); const held = gate(); const resume = gate(); t.after(() => resume.resolve());
  f.state.beforeCheck = async () => { held.resolve(); await resume.promise; };
  const completing = control(app, f, id, 'complete', 'consumer', completion(f)).then((r) => r); await held.promise;
  f.state.beforeCheck = undefined;
  assert.equal((await control(app, f, id, 'fallback', 'provider')).statusCode, 200); resume.resolve();
  code(await completing, 409, 'DESKTOP_PDF_DIRECT_FALLBACK');
  const state = (await control(app, f, id)).json(); assert.equal(state.state, 'relay'); assert.equal(state.expiresAt, created.expiresAt);
});

test('a completion that wins a pending fallback returns the receipt conflict, never a second outcome', async (t) => {
  const { f, app } = await fixture(t, { recheckTimeoutMs: 1000 }); const { id } = await directAssigned(app, f);
  await finalAuthorized(app, f, id); const held = gate(); const resume = gate(); t.after(() => resume.resolve());
  f.state.beforeCheck = async () => { held.resolve(); await resume.promise; };
  const falling = control(app, f, id, 'fallback', 'provider').then((r) => r); await held.promise;
  f.state.beforeCheck = undefined;
  assert.equal((await control(app, f, id, 'complete', 'consumer', completion(f))).statusCode, 200); resume.resolve();
  code(await falling, 409, 'DESKTOP_PDF_REQUEST_IN_USE');
  assert.equal((await control(app, f, id)).json().state, 'complete');
});

test('a status check finishing after completion observes the receipt while unresolved DB work retains admission', async (t) => {
  const { f, app } = await fixture(t, { recheckTimeoutMs: 1000 }); const { id } = await directAssigned(app, f);
  await finalAuthorized(app, f, id); const held = gate(); const resume = gate(); t.after(() => resume.resolve());
  f.state.beforeCheck = async () => { held.resolve(); await resume.promise; };
  const polling = control(app, f, id, '', 'provider').then((r) => r); await held.promise;
  code(await control(app, f, id, '', 'provider'), 409, 'DESKTOP_PDF_REQUEST_IN_USE');
  f.state.beforeCheck = undefined;
  assert.equal((await control(app, f, id, 'complete', 'consumer', completion(f))).statusCode, 200);
  code(await directCreate(app, f), 429, 'DESKTOP_PDF_TRANSFER_BUSY');
  code(await control(app, f, id, '', 'provider'), 409, 'DESKTOP_PDF_REQUEST_IN_USE');
  resume.resolve(); const polled = await polling; assert.equal(polled.statusCode, 200); assert.equal(polled.json().state, 'complete');
  const next = await directCreate(app, f); assert.equal(next.statusCode, 201); await cancel(app, f, next.json().requestId);
});

test('timed-out validation and cancellation cannot create unbounded outstanding checks', async (t) => {
  const { f, app } = await fixture(t, { recheckTimeoutMs: 50 }); const { id } = await directAssigned(app, f);
  const held = gate(); const resume = gate(); t.after(() => resume.resolve());
  f.state.beforeCheck = async () => { held.resolve(); await resume.promise; };
  const polling = control(app, f, id, '', 'provider').then((r) => r); await held.promise;
  assert.equal((await cancel(app, f, id)).statusCode, 200);
  code(await polling, 503, 'SERVICE_TEMPORARILY_UNAVAILABLE');
  code(await directCreate(app, f), 429, 'DESKTOP_PDF_TRANSFER_BUSY');
  f.state.beforeCheck = undefined; resume.resolve(); await delay(0);
  const next = await directCreate(app, f); assert.equal(next.statusCode, 201); await cancel(app, f, next.json().requestId);
});

test('revocation, target changes, provider stop and cancellation terminate direct leases instead of downgrading', async (t) => {
  for (const mutation of ['version', 'parent', 'provider', 'consumer', 'stop', 'cancel'] as const) {
    const { f, app } = await fixture(t); const { id } = await directAssigned(app, f);
    if (mutation === 'version') f.target.version.revision++;
    if (mutation === 'parent') f.state.paperDeleted = true;
    if (mutation === 'provider' || mutation === 'consumer') f.views.get(f.identities[mutation].sessionId)!.device.revokedAt = new Date().toISOString();
    if (mutation === 'stop') await app.inject({ method: 'DELETE', url: base + '/provider', headers: f.headers('provider') });
    if (mutation === 'cancel') await cancel(app, f, id);
    const state = await control(app, f, id); assert.notEqual(state.statusCode, 200);
    code(await control(app, f, id), 404, 'NOT_FOUND');
    code(await control(app, f, id, 'fallback'), 404, 'NOT_FOUND');
  }
});

test('completion receipts are capped before admission and a legacy relay does not require a receipt slot', async (t) => {
  const { f, app } = await fixture(t, { requestTtlMs: 30000, pollTimeoutMs: 5 });
  const ids: string[] = []; const began = Date.now();
  for (let index = 0; index < SERVER_LIMITS.desktopPdfDirectMaxReceipts; index++) {
    const { id } = await directAssigned(app, f); await finalAuthorized(app, f, id);
    assert.equal((await control(app, f, id, 'complete', 'consumer', completion(f))).statusCode, 200); ids.push(id);
  }
  assert.ok(Date.now() - began < SERVER_LIMITS.desktopPdfDirectReceiptMs, 'the capacity test must finish before any receipt expires');
  code(await directCreate(app, f), 429, 'DESKTOP_PDF_TRANSFER_BUSY');
  const relay = await app.inject({ method: 'POST', url: base + '/requests', headers: f.headers(), payload: { attachmentVersionId: f.target.version.entityId } });
  assert.equal(relay.statusCode, 201); await cancel(app, f, relay.json().requestId);
  const providerId = f.views.get(f.identities.provider.sessionId)!.device.id;
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/devices/' + providerId, headers: f.headers('peer') })).statusCode, 200);
  for (const id of [ids[0], ids.at(-1)!]) code(await control(app, f, id), 404, 'NOT_FOUND');
});

test('the same OIDC session cannot serve its own direct request even under a second client ID', async (t) => {
  const f = desktopFixture(); const app = await f.create(); t.after(() => app.close());
  f.identities.provider = { ...f.identities.consumer, clientId: 'another-client' };
  f.views.get(f.identities.consumer.sessionId)!.device.platform = 'windows';
  await directOnline(app, f);
  code(await directCreate(app, f), 404, 'DESKTOP_PDF_UNAVAILABLE');
  code(await control(app, f, randomUUID()), 404, 'NOT_FOUND');
});
