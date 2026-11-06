import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as parsedCore from '../packages/sync-core/src/parsedDocument.ts';
import * as remoteCore from '../packages/sync-core/src/remoteTasks.ts';
export const core = { ...parsedCore, ...remoteCore };
export const require = createRequire(import.meta.url);
export const sha = (value) => createHash('sha256').update(value).digest('hex');
const { createRemoteTaskJournal } = require('../electron/backend/remoteTaskJournal.cjs');
const { createRemoteMineruMaterializer } = require('../electron/backend/remoteMineruAdapter.cjs');
const { createParsedDocumentProvenance } = require('../electron/backend/parsedDocumentProvenance.cjs');
export function pdfBytes(pageCount = 1) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents ${pageCount + 3} 0 R >>`), '<< /Length 0 >>\nstream\n\nendstream'];
  let text = '%PDF-1.7\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((value) => String(value).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(text + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
export async function fixture(t, { kind = 'parse', blocks, assets = [], pageCount = 1 } = {}) {
  const temporary = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, 'pq-remote-')));
  t.after(() => { assert.equal(path.dirname(root), temporary); assert.ok(path.basename(root).startsWith('pq-remote-')); fs.rmSync(root, { recursive: true, force: true }); });
  const profile = { id: kind === 'parse' ? 'mineru' : 'embedding', revision: 1, digest: 'b'.repeat(64), kind, model: kind === 'parse' ? 'vlm' : 'embed-synthetic' };
  const snapshot = { scope: { service: 'https://sync.example.test', accountId: randomUUID(), deviceId: randomUUID(), libraryId: 'synthetic-library-1' },
    generation: { account: 1, library: 1, profiles: 1, credentials: 1 }, profiles: [profile] };
  const pdf = pdfBytes(pageCount); const timestamp = new Date().toISOString();
  const task = { id: randomUUID(), kind, state: 'running', target: { paperId: randomUUID(), attachmentVersionId: randomUUID(), paperRevision: 1,
    versionRevision: 1, sha256: sha(pdf), sizeBytes: pdf.length, pageCount, fileName: 'synthetic.pdf' }, providerDeviceId: snapshot.scope.deviceId,
    profile, recoveryProviderDeviceId: null, indexSourceDigest: null, attempt: 1, createdAt: timestamp, updatedAt: timestamp, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), failure: null, artifact: null };
  const lease = { attempt: 1, fence: randomUUID() };
  const document = { format: 'paperquay-parsed-document', version: 1, paperId: task.target.paperId, attachmentVersionId: task.target.attachmentVersionId,
    pdf: { sha256: task.target.sha256, sizeBytes: task.target.sizeBytes, pageCount }, parser: { name: 'mineru', model: 'vlm' },
    blocks: blocks || [{ id: 'text', pageIndex: 0, kind: 'text', text: 'Synthetic parsed text.' }], assets };
  const parsed = await core.verifyParsedDocument(document); const bytes = Buffer.from(JSON.stringify(parsed.document));
  if (kind === 'index') task.indexSourceDigest = parsed.digest;
  const journal = createRemoteTaskJournal({ directory: path.join(root, 'private-journal') });
  async function checkpoint(initial = true) {
    if (initial) await journal.write(snapshot.scope, task.id, { version: 1, jobId: task.id, kind, executionKey: 'e'.repeat(64), attempt: task.attempt, stage: 'prepared' });
    return { read: () => journal.read(snapshot.scope, task.id), write: (entry) => journal.write(snapshot.scope, task.id, entry) };
  }
  const dataDir = path.join(root, 'profile', 'PaperQuay'); fs.mkdirSync(dataDir, { recursive: true });
  const context = { app: { getPath: () => path.join(root, 'profile') }, appPaths: { dataDir, configPath: path.join(dataDir, '.settings', 'paperquay.config.json'),
    mineruCacheDir: path.join(dataDir, '.mineru-cache') }, store: { load: () => ({ settings: {} }) }, authorizeLocalRead: async (file) => file,
    approvedWritePaths: new Set(), approvedWriteDirectories: new Set() };
  context.parsedDocumentProvenance = createParsedDocumentProvenance(context, { key: Buffer.alloc(32, 19) });
  const materialize = createRemoteMineruMaterializer(context, { core, converter: require('../electron/generated/desktopParsedDocument.cjs') });
  return { root, context, snapshot, task, lease, pdf, document: parsed.document, parsed, bytes, journal, checkpoint, materialize };
}
export async function body(request, maximum = 16 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > maximum) throw new Error('SYNTHETIC_BODY_LIMIT'); chunks.push(chunk); }
  return Buffer.concat(chunks, length);
}
export function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
export async function server(t, handler) {
  const instance = http.createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => { if (!response.destroyed) json(response, { error: 'SYNTHETIC_FAILURE' }, 500); }); });
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); });
  return { instance, base: `http://127.0.0.1:${instance.address().port}` };
}
export function gate() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
