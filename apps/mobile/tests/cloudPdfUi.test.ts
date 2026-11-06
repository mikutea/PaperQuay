import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import { createAccountState, entityKey, getVisibleEntity, type EntityType, type SyncRecord } from '../../../packages/sync-core/src/index.ts';
import { CloudPdfPanel } from '../src/components/CloudPdfPanel.tsx';
import { PaperReader } from '../src/components/PaperReader.tsx';
import { sha256 } from '../src/pdf/acquisition.ts';
import { getPdfCache } from '../src/pdf/cache.ts';
import { PDF_LIMITS, type PaperReaderProps, type PdfVersion } from '../src/pdf/types.ts';
import type { CloudPdfContext, CloudPdfCopy } from '../src/pdf/cloudCopies.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';

const NOW = '2026-10-26T12:00:00.000Z';
const capability = { maxFileBytes: PDF_LIMITS.maxFileBytes, maxAccountBytes: 1024 ** 3, maxCopies: 512 };
const encode = (value: string) => new TextEncoder().encode(value);
function syntheticPdf(): Uint8Array {
  const content = 'BT /F1 12 Tf 30 300 Td (Synthetic private cloud regression) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${encode(content).length} >>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.7\n'; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(encode(pdf).length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(pdf);
}
const bytes = syntheticPdf();
const hash = await sha256(bytes);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const result = renderer.root.findAllByType('button').find((node) => text(node) === label);
  assert.ok(result, `Expected button: ${label}`); return result;
}
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!check()) {
    if (performance.now() >= deadline) assert.fail(`UI did not settle: ${label}`);
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 2)); });
  }
}
async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  const target = button(renderer, label); assert.ok(!target.props.disabled, `Button is disabled: ${label}`);
  await act(async () => { target.props.onClick(); });
}

function model() {
  const scope = { apiBaseUrl: 'https://sync.example.invalid', accountId: crypto.randomUUID() };
  const sync = createAccountState(scope.accountId, crypto.randomUUID());
  const paperId = crypto.randomUUID();
  const version: PdfVersion = { entityId: crypto.randomUUID(), data: { paperId, attachmentId: crypto.randomUUID(),
    sha256: hash, sizeBytes: bytes.length, mediaType: 'application/pdf', fileName: 'synthetic-cloud.pdf', pageCount: 1 } };
  const record = <T extends EntityType>(entityType: T, entityId: string, data: SyncRecord<T>['data']): SyncRecord<T> => ({
    entityType, entityId, data, schemaVersion: 1, revision: 1, deletedAt: null, updatedAt: NOW, modifiedByDeviceId: sync.deviceId,
  } as SyncRecord<T>);
  sync.serverRecords[entityKey('paper', paperId)] = record('paper', paperId,
    { title: 'Synthetic cloud paper', authors: [], keywords: [], year: null, doi: null, publication: null, abstractText: null });
  sync.serverRecords[entityKey('attachmentVersion', version.entityId)] = record('attachmentVersion', version.entityId, version.data);
  const snapshot: WorkspaceSnapshot = { status: 'ready', identity: null, workspace: { sync, pendingResolutions: {} },
    online: true, needsLogin: false, syncing: false, devices: [], conflicts: [], lastSyncedAt: null, error: null };
  const saved: unknown[] = [];
  const controller: PaperReaderProps['controller'] = {
    syncNow: async () => {},
    getSnapshot: () => snapshot,
    save: async (...args) => { saved.push(args); return undefined; },
  };
  let current = true;
  let getToken = async () => 'synthetic-access-token';
  const context: CloudPdfContext = { apiBaseUrl: scope.apiBaseUrl,
    getAccessToken: () => getToken(), getCloudPdfCapability: () => capability };
  const copy: CloudPdfCopy = { attachmentVersionId: version.entityId, paperId, sha256: hash,
    sizeBytes: bytes.length, fileName: version.data.fileName, createdAt: NOW, available: true };
  const quota = (present: boolean) => ({ usedBytes: present ? bytes.length : 0, maxBytes: capability.maxAccountBytes,
    usedCopies: present ? 1 : 0, maxCopies: capability.maxCopies });
  return { scope, sync, snapshot, version, context, copy, saved, controller, quota,
    accountCurrent: () => current, changeBinding: () => { current = false; },
    token: (get: () => Promise<string>) => { getToken = get; },
    status: (present = false) => json({ copy: present ? copy : null, quota: quota(present) }),
    uploaded: () => json({ copy, replayed: false, quota: quota(true) }),
    panelProps: (): ComponentProps<typeof CloudPdfPanel> => ({ context, scope, controller, version,
      synced: true, hasBytes: true, getBytes: () => bytes, reading: false, onRead: () => undefined,
      accountCurrent: () => current }),
    readerProps: (): PaperReaderProps => ({ scope, controller, cloudPdf: context, accountCurrent: () => current,
      paper: getVisibleEntity(sync, 'paper', paperId)!, attachmentVersions: [getVisibleEntity(sync, 'attachmentVersion', version.entityId)!],
      annotations: [], positions: [], onBack: () => undefined }),
  };
}

async function mountPanel(data: ReturnType<typeof model>) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(CloudPdfPanel, data.panelProps())); });
  await until(() => !button(renderer, '刷新云副本状态').props.disabled, 'initial cloud status');
  return { renderer, close: async () => { await act(async () => renderer.unmount()); } };
}

for (const change of ['needs-login', 'account', 'binding'] as const) {
  test(`actual cloud panel blocks upload dispatch when ${change} changes during token refresh`, async (testContext) => {
    const data = model(); const methods: string[] = [];
    testContext.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET'); return data.status();
    });
    const env = await mountPanel(data);
    try {
      const token = deferred<string>(); let waiting = false;
      data.token(() => { waiting = true; return token.promise; });
      await click(env.renderer, '上传此 PDF 到私有云');
      await until(() => waiting, 'upload waiting for refreshed token');
      if (change === 'needs-login') data.snapshot.needsLogin = true;
      else if (change === 'account') data.snapshot.workspace!.sync = createAccountState(crypto.randomUUID(), crypto.randomUUID());
      else data.changeBinding();
      token.resolve('replacement-session-token');
      await until(() => !button(env.renderer, '刷新云副本状态').props.disabled, 'rejected stale upload');
      assert.deepEqual(methods, ['GET'], 'the token must never authorize an upload for the retired session');
      assert.deepEqual(data.saved, []);
      assert.ok(!text(env.renderer.root).includes('云副本已保存，同一账号的其他设备可以下载'));
    } finally { await env.close(); }
  });
}

test('cancelling a real panel upload cannot let its late completion unlock or overwrite the next operation', async (testContext) => {
  const data = model(); const upload = deferred<Response>(); const refresh = deferred<Response>();
  let uploads = 0; let statuses = 0; let oldBodyCancelled = false;
  testContext.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') { uploads++; return upload.promise; }
    statuses++; return statuses === 1 ? data.status() : refresh.promise;
  });
  const env = await mountPanel(data);
  try {
    data.token(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      return 'synthetic-access-token';
    });
    await click(env.renderer, '上传此 PDF 到私有云');
    await until(() => uploads === 1, 'upload request dispatched');
    await click(env.renderer, '取消等待');
    await until(() => !button(env.renderer, '刷新云副本状态').props.disabled, 'cancelled upload released');
    assert.match(text(env.renderer.root), /可能已在服务端完成/);
    await click(env.renderer, '刷新云副本状态');
    await until(() => statuses === 2, 'new status request dispatched');
    assert.equal(button(env.renderer, '刷新云副本状态').props.disabled, true);
    upload.resolve(new Response(new ReadableStream({ cancel() { oldBodyCancelled = true; } }),
      { headers: { 'content-type': 'application/json' } }));
    await until(() => oldBodyCancelled, 'late upload response disposed');
    assert.equal(button(env.renderer, '刷新云副本状态').props.disabled, true, 'old completion must not release the active operation');
    assert.match(text(env.renderer.root), /正在查询云副本/);
    assert.ok(!text(env.renderer.root).includes('云副本已保存，同一账号的其他设备可以下载'));
    refresh.resolve(data.status(true));
    await until(() => !button(env.renderer, '刷新云副本状态').props.disabled, 'new status completed');
    assert.equal(button(env.renderer, '下载云副本并阅读').props.disabled, false);
    assert.equal(uploads, 1); assert.deepEqual(data.saved, []);
  } finally { await env.close(); }
});

async function mountReader(testContext: TestContext, data: ReturnType<typeof model>) {
  const names = ['window', 'document', 'indexedDB'] as const;
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const replacements = { window: Object.assign(new EventTarget(), { confirm: () => true }),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }), indexedDB: new IDBFactory() };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: replacements[name] });
  const cache = getPdfCache(); let cacheWrites = 0;
  testContext.mock.method(cache, 'put', async () => { cacheWrites++; });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(PaperReader, data.readerProps()));
    await cache.list(data.scope);
  });
  await until(() => !button(renderer, '查看此版本的云副本').props.disabled, 'initial empty cache lookup');
  await click(renderer, '查看此版本的云副本');
  await until(() => renderer.root.findAllByType('button').some((entry) => text(entry) === '下载云副本并阅读'), 'cloud status available');
  return { renderer, writes: () => cacheWrites, async close() {
    await act(async () => { renderer.unmount(); await new Promise<void>((resolve) => setImmediate(resolve)); });
    for (const name of names) {
      const original = originals.get(name);
      if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name);
    }
  } };
}

test('actual reader blocks cloud content dispatch when login expires during token acquisition', async (testContext) => {
  const data = model(); const urls: string[] = [];
  testContext.mock.method(globalThis, 'fetch', async (url: unknown) => { urls.push(String(url)); return data.status(true); });
  const env = await mountReader(testContext, data);
  try {
    const token = deferred<string>(); let waiting = false;
    data.token(() => { waiting = true; return token.promise; });
    await click(env.renderer, '下载云副本并阅读');
    await until(() => waiting, 'reader waiting for refreshed token');
    data.snapshot.needsLogin = true; token.resolve('replacement-session-token');
    await until(() => !button(env.renderer, '刷新云副本状态').props.disabled, 'reader download rejected');
    assert.equal(urls.length, 1); assert.ok(urls.every((url) => !url.endsWith('/content')));
    assert.equal(env.writes(), 0); assert.deepEqual(data.saved, []);
    assert.equal(env.renderer.root.findByProps({ 'aria-label': 'PDF 阅读器' }).props['data-document-loaded'], false);
  } finally { await env.close(); }
});

for (const change of ['attachment-tombstone', 'paper-tombstone', 'hash', 'size', 'paper-id'] as const) {
  test(`actual reader discards an in-flight cloud download after live ${change} changes in the same account`, async (testContext) => {
    const data = model(); const response = deferred<Response>(); let downloads = 0;
    testContext.mock.method(globalThis, 'fetch', async (url: unknown) => {
      if (String(url).endsWith('/content')) { downloads++; return response.promise; }
      return data.status(true);
    });
    const env = await mountReader(testContext, data);
    try {
      await click(env.renderer, '下载云副本并阅读');
      await until(() => downloads === 1, 'cloud download dispatched');
      const key = entityKey(change === 'paper-tombstone' ? 'paper' : 'attachmentVersion',
        change === 'paper-tombstone' ? data.version.data.paperId : data.version.entityId);
      const existing = data.sync.serverRecords[key];
      const changed = change === 'hash' ? { ...data.version.data, sha256: '0'.repeat(64) }
        : change === 'size' ? { ...data.version.data, sizeBytes: bytes.length + 1 }
          : change === 'paper-id' ? { ...data.version.data, paperId: crypto.randomUUID() } : null;
      if (changed) {
        assert.equal(existing.entityType, 'attachmentVersion');
        data.sync.serverRecords[key] = { ...existing, entityType: 'attachmentVersion', revision: existing.revision + 1,
          data: changed, deletedAt: null };
      } else {
        data.sync.serverRecords[key] = { ...existing, revision: existing.revision + 1, data: null, deletedAt: NOW };
      }
      // Deliberately do not rerender: a pull can replace live state before React commits new props.
      let consumed = 0; let cancelled = false;
      response.resolve(new Response(new ReadableStream<Uint8Array>({
        pull(stream) { consumed++; stream.enqueue(bytes); stream.close(); }, cancel() { cancelled = true; },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } }));
      await until(() => !button(env.renderer, '刷新云副本状态').props.disabled, 'stale download discarded');
      assert.equal(consumed, 0, 'reject before parsing or decoding; a later PDF runtime failure must not mask this guard');
      assert.equal(cancelled, true); assert.equal(env.writes(), 0); assert.deepEqual(data.saved, []);
      assert.equal(Object.values(data.sync.serverRecords).filter((record) => record.entityType === 'readingPosition').length, 0);
      assert.equal(env.renderer.root.findByProps({ 'aria-label': 'PDF 阅读器' }).props['data-document-loaded'], false);
      assert.equal(downloads, 1);
    } finally { await env.close(); }
  });
}
