import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { ClientRequest } from 'node:http';
import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { buildApp } from '../../src/app.ts';
import { ApiError } from '../../src/errors.ts';
import { PostgresSyncStore } from '../../src/store.ts';
import type { CloudPdfRepository } from '../../src/types.ts';
import { identity, operation, paper, testConfig, version } from '../fixtures.ts';

const databaseUrl = process.env.PAPERQUAY_DATABASE_URL;
if (!databaseUrl || process.env.PAPERQUAY_TEST_ALLOW_DATABASE_WRITES !== '1') {
  throw new Error('Use an isolated migrated database and PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1.');
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
const store = new PostgresSyncStore({ pool, cursorSecret: Buffer.alloc(32, 41), cloudPdfEnabled: true });
before(async () => { assert.equal(await store.ready(), true); });
after(async () => { await pool.end(); });
const bytes = Buffer.from('%PDF-1.7\nSynthetic socket fixture\n%%EOF\n');

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(content = bytes) {
  const who = identity();
  const view = await store.registerDevice(who, { name: 'Synthetic socket test', platform: 'web' });
  const parent = operation('paper', paper());
  const attachment = operation('attachmentVersion', { ...version(parent.entityId), sizeBytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex') });
  const result = await store.push(who, { protocolVersion: 1, deviceId: view.device.id, operations: [parent, attachment] });
  assert.ok(result.results.every((row) => row.status === 'applied'));
  return { who, view, attachment, content };
}
async function application(f: Awaited<ReturnType<typeof fixture>>, cloud: CloudPdfRepository = store, timeoutMs?: number) {
  const app = await buildApp({ config: testConfig({ PAPERQUAY_CLOUD_PDF_ENABLED: '1' }), repository: store, cloudPdfRepository: cloud,
    cloudPdfTransferTimeoutMs: timeoutMs, rateLimitEnabled: false, verifyToken: async (header) => {
      if (header !== 'Bearer synthetic') throw new ApiError('AUTHENTICATION_REQUIRED', 401);
      return f.who;
    } });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, url: origin + '/v1/cloud-pdfs/' + f.attachment.entityId };
}
const headers = { authorization: 'Bearer synthetic', 'content-type': 'application/pdf' };

function pausedUpload(url: string, content: Buffer): { request: ClientRequest; response: Promise<{ status: number; body: string }> } {
  let resolve!: (result: { status: number; body: string }) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<{ status: number; body: string }>((yes, no) => { resolve = yes; reject = no; });
  // Attach a rejection handler immediately; intentional aborts are awaited later.
  void response.catch(() => undefined);
  const request = http.request(url, { method: 'PUT', headers: { ...headers, 'content-length': content.byteLength }, agent: false }, (reply) => {
    const chunks: Buffer[] = [];
    reply.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    reply.on('end', () => resolve({ status: reply.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
    reply.on('error', reject);
  });
  request.on('error', reject);
  request.write(content.subarray(0, 8));
  return { request, response };
}
function observeAdmission(onAdmit: () => void): CloudPdfRepository {
  return {
    listCloudPdfs: (...args) => store.listCloudPdfs(...args), getCloudPdf: (...args) => store.getCloudPdf(...args),
    prepareCloudPdfUpload: async (...args) => { const result = await store.prepareCloudPdfUpload(...args); onAdmit(); return result; },
    putCloudPdf: (...args) => store.putCloudPdf(...args), downloadCloudPdf: (...args) => store.downloadCloudPdf(...args),
    deleteCloudPdf: (...args) => store.deleteCloudPdf(...args),
  };
}

async function nextUpload(url: string, content: Buffer, maximumMs = 3000): Promise<Response> {
  const until = Date.now() + maximumMs;
  for (;;) {
    const response = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(content) });
    if (response.status !== 429) return response;
    await response.arrayBuffer();
    if (Date.now() >= until) assert.fail('transfer slot was not released');
    await delay(25);
  }
}

test('real HTTP DELETE during a partially received PUT prevents a late cloud copy from reappearing', { timeout: 15000 }, async (t) => {
  const f = await fixture(); const admitted = gate(); const server = await application(f, observeAdmission(admitted.resolve));
  const upload = pausedUpload(server.url, f.content);
  t.after(async () => { upload.request.destroy(); await server.app.close(); });
  await admitted.promise;
  const removed = await fetch(server.url, { method: 'DELETE', headers });
  assert.equal(removed.status, 200); assert.equal((await removed.json() as { deleted: boolean }).deleted, false);
  upload.request.end(f.content.subarray(8));
  const result = await upload.response;
  assert.equal(result.status, 409); assert.equal(JSON.parse(result.body).error.code, 'CLOUD_PDF_CHANGED');
  assert.equal((await store.getCloudPdf(f.who, f.attachment.entityId)).copy, null);
  const retry = await nextUpload(server.url, f.content);
  assert.equal(retry.status, 200); await retry.arrayBuffer();
});

test('real HTTP aborted uploads release the account slot and retain no partial content', { timeout: 15000 }, async (t) => {
  const f = await fixture(); const admitted = gate(); const server = await application(f, observeAdmission(admitted.resolve));
  const upload = pausedUpload(server.url, f.content);
  t.after(async () => { upload.request.destroy(); await server.app.close(); });
  await admitted.promise;
  upload.request.destroy(new Error('intentional synthetic abort'));
  await assert.rejects(upload.response);
  assert.equal((await store.getCloudPdf(f.who, f.attachment.entityId)).copy, null);
  const retry = await nextUpload(server.url, f.content);
  assert.equal(retry.status, 200); await retry.arrayBuffer();
  assert.equal((await store.listCloudPdfs(f.who)).quota.usedCopies, 1);
});

test('disconnect during awaited preflight cannot create a ghost transfer slot after the connection closed', { timeout: 15000 }, async (t) => {
  const f = await fixture(); const waiting = gate(); const resume = gate(); const settled = gate(); const disconnected = gate();
  const cloud = observeAdmission(() => undefined); let first = true;
  cloud.prepareCloudPdfUpload = async (...args) => {
    const result = await store.prepareCloudPdfUpload(...args);
    if (first) { first = false; waiting.resolve(); await resume.promise; settled.resolve(); }
    return result;
  };
  const server = await application(f, cloud);
  server.app.server.on('request', (_request, reply) => {
    reply.once('close', () => { if (!reply.writableFinished) disconnected.resolve(); });
  });
  const upload = pausedUpload(server.url, f.content);
  t.after(async () => { resume.resolve(); upload.request.destroy(); await server.app.close(); });
  await waiting.promise;
  upload.request.destroy(new Error('intentional disconnect while preflight is pending'));
  await assert.rejects(upload.response); await disconnected.promise;
  resume.resolve(); await settled.promise; await delay(25);
  const retry = await nextUpload(server.url, f.content);
  assert.equal(retry.status, 200); await retry.arrayBuffer();
  assert.equal((await store.listCloudPdfs(f.who)).quota.usedCopies, 1);
});

test('real HTTP upload rechecks session revocation after the body was admitted', { timeout: 15000 }, async (t) => {
  const f = await fixture(); const peer = { ...f.who, sessionId: randomUUID() };
  await store.registerDevice(peer, { name: 'Synthetic revoker', platform: 'web' });
  const admitted = gate(); const server = await application(f, observeAdmission(admitted.resolve));
  const upload = pausedUpload(server.url, f.content);
  t.after(async () => { upload.request.destroy(); await server.app.close(); });
  await admitted.promise;
  await store.revokeDevice(peer, f.view.device.id);
  upload.request.end(f.content.subarray(8));
  const result = await upload.response;
  assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).error.code, 'SESSION_REVOKED');
  assert.equal((await store.listCloudPdfs(peer)).quota.usedBytes, 0);
});

test('a real slow download keeps its slot after the DB read, and client disconnect releases it', { timeout: 30000 }, async (t) => {
  // Loopback TCP buffers can absorb a paused 16 MiB response on Windows. Use
  // the permitted 64 MiB boundary and assert the server really is backpressured.
  const large = Buffer.alloc(64 * 1024 * 1024, 32); large.write('%PDF-1.7\n'); large.write('\n%%EOF\n', large.byteLength - 7);
  const f = await fixture(large);
  const admitted = await store.prepareCloudPdfUpload(f.who, f.attachment.entityId);
  await store.putCloudPdf(f.who, f.attachment.entityId, f.content, admitted.generation);
  const small = operation('attachmentVersion', { ...version(f.attachment.data!.paperId), sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  const pushed = await store.push(f.who, { protocolVersion: 1, deviceId: f.view.device.id, operations: [small] });
  assert.equal(pushed.results[0].status, 'applied');
  const server = await application(f);
  let sending: ServerResponse | undefined;
  server.app.server.on('request', (incoming, reply) => {
    if (incoming.url?.endsWith('/content') && !sending) sending = reply;
  });
  // Pause before sending the request: pausing IncomingMessage at its response
  // event leaves a loopback window in which the OS may already buffer the file.
  const socket = new net.Socket(); socket.pause();
  t.after(async () => { socket.destroy(); await server.app.close(); });
  const target = new URL(server.url + '/content');
  const connected = once(socket, 'connect');
  socket.connect(Number(target.port), target.hostname); await connected;
  socket.write('GET ' + target.pathname + ' HTTP/1.1\r\nHost: ' + target.host
    + '\r\nAuthorization: Bearer synthetic\r\nConnection: close\r\n\r\n');
  const until = Date.now() + 5000;
  while (!sending?.headersSent) {
    if (Date.now() >= until) assert.fail('download never started writing its response');
    await delay(5);
  }
  assert.equal(sending.statusCode, 200);
  const status = await fetch(server.url, { headers });
  assert.equal(status.status, 200); await status.arrayBuffer();
  assert.equal(sending?.writableFinished, false, 'fixture must establish real socket backpressure before testing the lease');
  const blocked = await fetch(server.url + '/content', { headers });
  assert.equal(blocked.status, 429); assert.equal((await blocked.json() as { error: { code: string } }).error.code, 'CLOUD_PDF_TRANSFER_BUSY');
  socket.destroy();
  const retry = await nextUpload(server.url.replace(f.attachment.entityId, small.entityId), bytes);
  assert.equal(retry.status, 200); await retry.arrayBuffer();
});

test('the absolute transfer deadline closes an unfinished socket and frees its slot', { timeout: 15000 }, async (t) => {
  const f = await fixture(); const admitted = gate();
  const server = await application(f, observeAdmission(admitted.resolve), 300);
  const upload = pausedUpload(server.url, f.content);
  t.after(async () => { upload.request.destroy(); await server.app.close(); });
  await admitted.promise;
  await assert.rejects(upload.response, 'incomplete body must lose its connection at the deadline');
  assert.equal((await store.getCloudPdf(f.who, f.attachment.entityId)).copy, null);
  const retry = await nextUpload(server.url, f.content);
  assert.equal(retry.status, 200); await retry.arrayBuffer();
});
