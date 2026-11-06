import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { DesktopPdfTimings } from '../../src/desktop-pdf.ts';
import { desktopFixture, gate } from '../desktop-fixtures.ts';

const base = '/v1/desktop-pdfs';
type Fixture = ReturnType<typeof desktopFixture>;
type SocketResult = { status: number; body: Buffer };
function pdf(size = 256 * 1024) {
  const content = Buffer.alloc(size, 32); content.write('%PDF-1.7\n'); content.write('\n%%EOF\n', size - 7);
  return content;
}
async function until(condition: () => boolean, reason: string, maximumMs = 3000) {
  const deadline = Date.now() + maximumMs;
  while (!condition()) { if (Date.now() >= deadline) assert.fail(reason); await delay(5); }
}
async function application(f: Fixture, timings: Partial<DesktopPdfTimings> = {}) {
  const app = await f.create({ requestTtlMs: 10000, presenceTtlMs: 15000, claimTimeoutMs: 3000,
    pollTimeoutMs: 20, recheckTimeoutMs: 1500, ...timings });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, origin };
}
async function json(origin: string, f: Fixture, path: string, method = 'GET', body?: unknown, who = 'consumer') {
  const response = await fetch(origin + path, { method, headers: { ...f.headers(who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, value: await response.json() as any };
}
async function online(origin: string, f: Fixture, who = 'provider') {
  const polled = await json(origin, f, base + '/provider/poll', 'POST', {}, who);
  assert.equal(polled.status, 200); assert.deepEqual(polled.value, { request: null });
}
async function createRequest(origin: string, f: Fixture) {
  const response = await json(origin, f, base + '/requests', 'POST', { attachmentVersionId: f.target.version.entityId });
  assert.equal(response.status, 201, JSON.stringify(response.value)); return response.value.requestId as string;
}
async function reusable(origin: string, f: Fixture) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const result = await json(origin, f, base + '/requests', 'POST', { attachmentVersionId: f.target.version.entityId });
    if (result.status !== 429) {
      assert.equal(result.status, 201, JSON.stringify(result.value));
      assert.equal((await json(origin, f, base + '/requests/' + result.value.requestId, 'DELETE')).status, 200); return;
    }
    if (Date.now() >= deadline) assert.fail('transfer slot was not released');
    await delay(10);
  }
}
function exchange(origin: string, f: Fixture, id: string, method: 'GET' | 'POST', length?: number) {
  let resolve!: (value: SocketResult) => void; let reject!: (error: Error) => void;
  const result = new Promise<SocketResult>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => undefined);
  const seen = { status: 0, bytes: 0, ended: false, error: undefined as Error | undefined };
  const fail = (error: Error) => { seen.error = error; reject(error); };
  const request = http.request(origin + base + '/requests/' + id + '/content', {
    method, agent: false, headers: { ...f.headers(method === 'GET' ? 'consumer' : 'provider'),
      ...(method === 'POST' ? { 'content-type': 'application/pdf', 'content-length': String(length) } : {}) },
  }, (reply) => {
    seen.status = reply.statusCode!; const chunks: Buffer[] = [];
    reply.on('data', (chunk: Buffer) => { seen.bytes += chunk.byteLength; chunks.push(Buffer.from(chunk)); });
    reply.on('end', () => { seen.ended = true; resolve({ status: reply.statusCode!, body: Buffer.concat(chunks) }); });
    reply.on('error', fail);
  });
  request.on('error', fail);
  if (method === 'GET') request.end();
  return { request, result, seen };
}
async function assigned(origin: string, f: Fixture, id: string, who = 'provider') {
  const polled = await json(origin, f, base + '/provider/poll', 'POST', {}, who);
  assert.equal(polled.status, 200); assert.equal(polled.value.request?.requestId, id);
}
async function startPartial(origin: string, f: Fixture, content: Buffer) {
  await online(origin, f); const id = await createRequest(origin, f);
  const download = exchange(origin, f, id, 'GET'); await assigned(origin, f, id);
  const upload = exchange(origin, f, id, 'POST', content.byteLength);
  upload.request.write(content.subarray(0, content.byteLength / 2));
  await until(() => download.seen.bytes > 0, 'partial PDF never reached the consumer');
  assert.equal(download.seen.status, 200); assert.equal(download.seen.ended, false);
  return { id, download, upload };
}

test('bounded long polling outlives the ordinary HTTP idle timeout', { timeout: 30000 }, async (t) => {
  const f = desktopFixture(); const server = await application(f, { pollTimeoutMs: 200 });
  t.after(() => server.app.close());
  server.app.server.setTimeout(50);
  const began = Date.now(); await online(server.origin, f);
  assert.ok(Date.now() - began >= 180, 'the server must return the bounded poll result instead of an idle disconnect');
});

test('real sockets deliver exact bytes only after the final authorization check completes', { timeout: 15000 }, async (t) => {
  const content = pdf(); const f = desktopFixture(content); const server = await application(f, { recheckIntervalMs: 1000 });
  t.after(() => server.app.close());
  const held = gate(); const resume = gate();
  let transfer: Awaited<ReturnType<typeof startPartial>> | undefined;
  t.after(async () => { resume.resolve(); transfer?.upload.request.destroy(); transfer?.download.request.destroy(); await server.app.close(); });
  transfer = await startPartial(server.origin, f, content);
  f.state.beforeCheck = async () => { held.resolve(); await resume.promise; };
  transfer.upload.request.end(content.subarray(content.byteLength / 2));
  await held.promise;
  assert.equal(transfer.download.seen.ended, false);
  assert.ok(transfer.download.seen.bytes < content.byteLength, 'final bytes must be held while live authorization is unresolved');
  resume.resolve();
  const [received, sent] = await Promise.all([transfer.download.result, transfer.upload.result]);
  assert.equal(received.status, 200); assert.deepEqual(received.body, content);
  assert.equal(createHash('sha256').update(received.body).digest('hex'), f.target.version.data.sha256);
  assert.equal(sent.status, 200); assert.deepEqual(JSON.parse(sent.body.toString()), { sent: true });
  f.state.beforeCheck = undefined; await reusable(server.origin, f);
});

test('midstream cancellation closes both real sockets and late provider content cannot reopen the request', { timeout: 15000 }, async (t) => {
  const content = pdf(); const f = desktopFixture(content); const server = await application(f);
  t.after(() => server.app.close());
  const transfer = await startPartial(server.origin, f, content);
  t.after(async () => { transfer.upload.request.destroy(); transfer.download.request.destroy(); await server.app.close(); });
  const removed = await json(server.origin, f, base + '/requests/' + transfer.id, 'DELETE');
  assert.equal(removed.status, 200); assert.deepEqual(removed.value, { cancelled: true });
  await Promise.all([assert.rejects(transfer.download.result), assert.rejects(transfer.upload.result)]);
  assert.ok(transfer.download.seen.bytes < content.byteLength); assert.equal(transfer.download.seen.ended, false);
  const late = exchange(server.origin, f, transfer.id, 'POST', content.byteLength); late.request.end(content);
  const rejected = await late.result; assert.equal(rejected.status, 404); assert.equal(JSON.parse(rejected.body.toString()).error.code, 'NOT_FOUND');
  await reusable(server.origin, f);
});

test('revoking the provider through the device route interrupts an active body immediately', { timeout: 15000 }, async (t) => {
  const content = pdf(); const f = desktopFixture(content); const server = await application(f, { recheckIntervalMs: 1000 });
  t.after(() => server.app.close());
  const transfer = await startPartial(server.origin, f, content);
  t.after(async () => { transfer.upload.request.destroy(); transfer.download.request.destroy(); await server.app.close(); });
  const providerId = f.views.get(f.identities.provider.sessionId)!.device.id;
  const revoked = await json(server.origin, f, '/v1/devices/' + providerId, 'DELETE', undefined, 'peer');
  assert.equal(revoked.status, 200);
  await Promise.all([assert.rejects(transfer.download.result), assert.rejects(transfer.upload.result)]);
  assert.ok(transfer.download.seen.bytes < content.byteLength);
  await online(server.origin, f, 'provider2'); await reusable(server.origin, f);
});

test('a consumer disconnect aborts the unfinished provider body and releases its account slot', { timeout: 15000 }, async (t) => {
  const content = pdf(); const f = desktopFixture(content); const server = await application(f);
  t.after(() => server.app.close());
  const transfer = await startPartial(server.origin, f, content);
  t.after(async () => { transfer.upload.request.destroy(); transfer.download.request.destroy(); await server.app.close(); });
  transfer.download.request.destroy(new Error('intentional synthetic consumer disconnect'));
  await Promise.all([assert.rejects(transfer.download.result), assert.rejects(transfer.upload.result)]);
  await reusable(server.origin, f);
});

test('a producer disconnect truncates the consumer stream and frees the transfer slot', { timeout: 15000 }, async (t) => {
  const content = pdf(); const f = desktopFixture(content); const server = await application(f);
  t.after(() => server.app.close());
  const transfer = await startPartial(server.origin, f, content);
  t.after(async () => { transfer.upload.request.destroy(); transfer.download.request.destroy(); await server.app.close(); });
  transfer.upload.request.destroy(new Error('intentional synthetic producer disconnect'));
  await Promise.all([assert.rejects(transfer.download.result), assert.rejects(transfer.upload.result)]);
  assert.ok(transfer.download.seen.bytes < content.byteLength); await reusable(server.origin, f);
});

test('the absolute deadline interrupts a provider that keeps its body unfinished', { timeout: 15000 }, async (t) => {
  const content = pdf(); const f = desktopFixture(content); const server = await application(f, { requestTtlMs: 700 });
  t.after(() => server.app.close());
  const began = Date.now(); const transfer = await startPartial(server.origin, f, content);
  t.after(async () => { transfer.upload.request.destroy(); transfer.download.request.destroy(); await server.app.close(); });
  await Promise.all([assert.rejects(transfer.download.result), assert.rejects(transfer.upload.result)]);
  assert.ok(Date.now() - began < 3000, 'unfinished bytes cannot extend the fixed request deadline');
  assert.ok(transfer.download.seen.bytes < content.byteLength); await reusable(server.origin, f);
});

test('integrity failure withholds final bytes on a real HTTP response', { timeout: 15000 }, async (t) => {
  const content = pdf(); const f = desktopFixture(content); const server = await application(f);
  t.after(() => server.app.close());
  const transfer = await startPartial(server.origin, f, content);
  t.after(async () => { transfer.upload.request.destroy(); transfer.download.request.destroy(); await server.app.close(); });
  const corrupt = Buffer.from(content.subarray(content.byteLength / 2)); corrupt[10] ^= 1;
  transfer.upload.request.end(corrupt);
  await assert.rejects(transfer.download.result);
  const rejected = await transfer.upload.result;
  assert.equal(rejected.status, 422); assert.equal(JSON.parse(rejected.body.toString()).error.code, 'PDF_INTEGRITY_MISMATCH');
  assert.ok(transfer.download.seen.bytes < content.byteLength); assert.equal(transfer.download.seen.ended, false);
  await reusable(server.origin, f);
});

test('a paused 64 MiB consumer halts upstream reading and retains the transfer slot', { timeout: 25000 }, async (t) => {
  const content = pdf(64 * 1024 * 1024); const f = desktopFixture(content);
  const server = await application(f); const socket = new net.Socket(); socket.pause();
  let upload: ReturnType<typeof exchange> | undefined;
  let sending: ServerResponse | undefined; let receiving: IncomingMessage | undefined;
  t.after(async () => { socket.destroy(); upload?.request.destroy(); await server.app.close(); });
  server.app.server.on('request', (incoming, reply) => {
    if (incoming.url?.endsWith('/content')) {
      if (incoming.method === 'GET') sending = reply;
      else if (incoming.method === 'POST') receiving = incoming;
    }
  });
  await online(server.origin, f); const id = await createRequest(server.origin, f);
  const target = new URL(server.origin); const connected = once(socket, 'connect');
  socket.connect(Number(target.port), target.hostname); await connected;
  socket.write('GET ' + base + '/requests/' + id + '/content HTTP/1.1\r\nHost: ' + target.host
    + '\r\nAuthorization: Bearer consumer\r\nConnection: close\r\n\r\n');
  await assigned(server.origin, f, id);
  upload = exchange(server.origin, f, id, 'POST', content.byteLength); upload.request.end(content);
  await until(() => Boolean(sending?.headersSent), 'the relay never started the downstream response');
  await delay(150);
  assert.equal(sending!.statusCode, 200);
  assert.equal(sending!.writableFinished, false, 'the downstream socket must be genuinely backpressured');
  assert.equal(receiving!.complete, false, 'the broker must not buffer the complete upstream body');
  // Windows may accept the complete client write into OS TCP buffers even
  // while the server stops reading. Assert the observable application bounds.
  assert.ok(receiving!.readableLength <= 2 * 65536, 'the unread application buffer must remain bounded');
  assert.equal(upload.seen.ended, false, 'provider acknowledgement must wait for the consumer response to finish');
  const metadata = await json(server.origin, f, base + '/versions'); assert.equal(metadata.status, 200);
  const blocked = await json(server.origin, f, base + '/requests', 'POST', { attachmentVersionId: f.target.version.entityId });
  assert.equal(blocked.status, 429); assert.equal(blocked.value.error.code, 'DESKTOP_PDF_TRANSFER_BUSY');
  assert.ok(blocked.headers.get('retry-after'));
  socket.destroy(); await assert.rejects(upload.result); await reusable(server.origin, f);
});
