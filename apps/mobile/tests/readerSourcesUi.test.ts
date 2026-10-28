import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import {
  createAccountState, entityKey, getVisibleEntity, queueLocalEdit,
  type AttachmentVersionData, type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import { PaperReader } from '../src/components/PaperReader.tsx';
import { sha256 } from '../src/pdf/acquisition.ts';
import { getPdfCache } from '../src/pdf/cache.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { DesktopPdfError, type DesktopPdfContext } from '../src/pdf/desktopCopies.ts';
import { cancelPdfTasks } from '../src/pdf/tasks.ts';
import { PDF_LIMITS, type PaperReaderProps, type PdfVersion } from '../src/pdf/types.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';
import { FakeDesktopPeer, TEST_SDP } from './helpers/desktopRtc.ts';

const NOW = '2026-10-27T10:00:00.000Z';
// Acquisition only inspects these bytes. Every test stops before PDF runtime loading.
const bytes = new TextEncoder().encode('%PDF-1.7\nSynthetic acquisition boundary fixture\n%%EOF\n');
const hash = await sha256(bytes);
const targetChanged = new PdfError('TARGET_CHANGED').message;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root.findAllByType('button').find((node) => text(node) === label);
  assert.ok(found, `Expected button: ${label}`); return found;
}
const busy = (renderer: ReactTestRenderer) => renderer.root.findAllByType('button').some((node) => text(node) === '取消');
async function flush(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
}
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) { if (check()) return; await flush(); }
  assert.fail(`UI did not settle: ${label}`);
}
async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  const target = button(renderer, label); assert.ok(!target.props.disabled, `Button is disabled: ${label}`);
  await act(async () => { target.props.onClick(); });
}
async function setUrl(renderer: ReactTestRenderer, value: string): Promise<void> {
  await act(async () => { renderer.root.findByProps({ type: 'url' }).props.onChange({ target: { value } }); });
}

function model() {
  const scope = { apiBaseUrl: 'https://sync.example.invalid', accountId: crypto.randomUUID() };
  const sync = createAccountState(scope.accountId, crypto.randomUUID());
  const paperId = crypto.randomUUID();
  const version: PdfVersion = { entityId: crypto.randomUUID(), data: {
    paperId, attachmentId: crypto.randomUUID(), sha256: hash, sizeBytes: bytes.length,
    mediaType: 'application/pdf', fileName: 'synthetic-source.pdf', pageCount: null,
  } };
  const metadata = { schemaVersion: 1 as const, revision: 1, deletedAt: null,
    updatedAt: NOW, modifiedByDeviceId: sync.deviceId };
  sync.serverRecords[entityKey('paper', paperId)] = { ...metadata, entityType: 'paper', entityId: paperId,
    data: { title: 'Synthetic source paper', authors: [], keywords: [], year: null, doi: null, publication: null, abstractText: null } };
  sync.serverRecords[entityKey('attachmentVersion', version.entityId)] = {
    ...metadata, entityType: 'attachmentVersion', entityId: version.entityId, data: structuredClone(version.data),
  };
  const snapshot: WorkspaceSnapshot = { status: 'ready', identity: null, workspace: { sync, pendingResolutions: {} },
    online: true, needsLogin: false, syncing: false, devices: [], conflicts: [], lastSyncedAt: null, error: null };
  const saved: unknown[] = [];
  const controller: PaperReaderProps['controller'] = {
    getSnapshot: () => snapshot,
    save: async (...args) => { saved.push(args); },
  };
  const props: PaperReaderProps = { scope, controller, accountCurrent: () => true,
    paper: getVisibleEntity(sync, 'paper', paperId)!,
    attachmentVersions: [getVisibleEntity(sync, 'attachmentVersion', version.entityId)!],
    annotations: [], positions: [], onBack: () => undefined };
  return { scope, sync, snapshot, version, saved, props };
}
type Model = ReturnType<typeof model>;
type Change = 'paper-tombstone' | 'version-tombstone' | 'hash' | 'attachment-id';
function changeTarget(data: Model, change: Change): void {
  const paper = change === 'paper-tombstone';
  const key = entityKey(paper ? 'paper' : 'attachmentVersion', paper ? data.version.data.paperId : data.version.entityId);
  const record = data.sync.serverRecords[key];
  if (change === 'paper-tombstone' || change === 'version-tombstone')
    data.sync.serverRecords[key] = { ...record, revision: record.revision + 1, data: null, deletedAt: NOW };
  else {
    const current = record as SyncRecord<'attachmentVersion'>;
    const patch: Partial<AttachmentVersionData> = change === 'hash' ? { sha256: '0'.repeat(64) } : { attachmentId: crypto.randomUUID() };
    data.sync.serverRecords[key] = { ...current, revision: current.revision + 1, data: { ...current.data!, ...patch } };
  }
  // Do not rerender: live state may advance before React commits replacement props.
}

async function mount(testContext: TestContext, data: Model, readCache: () => Promise<Uint8Array | null> = async () => null) {
  const names = ['window', 'document', 'indexedDB'] as const;
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const values = { window: Object.assign(new EventTarget(), { confirm: () => true }),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }), indexedDB: new IDBFactory() };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  const cache = getPdfCache(); let writes = 0; let reads = 0;
  const read = async () => { reads++; return readCache(); };
  testContext.mock.method(cache, 'read', read);
  testContext.mock.method(cache, 'peek', read);
  testContext.mock.method(cache, 'list', async () => []);
  testContext.mock.method(cache, 'put', async () => { writes++; });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(PaperReader, data.props)); });
  return { renderer, writes: () => writes, reads: () => reads, async close() {
    await act(async () => { renderer.unmount(); await new Promise<void>((resolve) => setImmediate(resolve)); });
    for (const name of names) {
      const original = originals.get(name);
      if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name);
    }
  } };
}
function assertNoAdoption(env: Awaited<ReturnType<typeof mount>>, data: Model): void {
  assert.equal(env.writes(), 0);
  assert.deepEqual(data.saved, []);
  assert.equal(data.sync.outbox.length, 0);
  assert.equal(env.renderer.root.findByProps({ 'aria-label': 'PDF 阅读器' }).props['data-document-loaded'], false);
}
function responseBody() {
  let consumed = 0; let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { consumed++; controller.enqueue(bytes); controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } });
  return { response, consumed: () => consumed, cancelled: () => cancelled };
}
function pendingFile() {
  const release = deferred<void>(); let reading = false; let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      reading = true; await release.promise;
      if (!cancelled) { controller.enqueue(bytes); controller.close(); }
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const file = new File([bytes], 'synthetic-source.pdf', { type: 'application/pdf' });
  Object.defineProperty(file, 'stream', { value: () => stream });
  return { file, release: () => release.resolve(), reading: () => reading, cancelled: () => cancelled };
}
async function chooseFile(renderer: ReactTestRenderer, file: File): Promise<void> {
  await act(async () => { renderer.root.findByProps({ type: 'file' }).props.onChange({ target: { files: [file], value: 'selected.pdf' } }); });
}

for (const change of ['paper-tombstone', 'version-tombstone', 'hash', 'attachment-id'] as const) {
  test(`actual reader rejects cached bytes when live ${change} changes during the cache wait`, async (t) => {
    const data = model(); const read = deferred<Uint8Array | null>();
    const env = await mount(t, data, () => read.promise);
    try {
      await until(() => env.reads() === 1, 'initial cache read');
      changeTarget(data, change); read.resolve(bytes);
      await until(() => !busy(env.renderer), 'stale cache read rejected');
      assert.ok(text(env.renderer.root).includes(targetChanged), 'the target guard must reject before attempting the PDF runtime');
      assertNoAdoption(env, data);
    } finally { read.resolve(null); await env.close(); }
  });

  test(`actual reader rejects local file bytes when live ${change} changes during the body wait`, async (t) => {
    const data = model(); const env = await mount(t, data); const file = pendingFile();
    try {
      await until(() => !busy(env.renderer), 'initial cache miss');
      await chooseFile(env.renderer, file.file);
      await until(file.reading, 'local body read started');
      changeTarget(data, change); file.release();
      await until(() => !busy(env.renderer), 'stale local bytes rejected');
      assert.ok(text(env.renderer.root).includes(targetChanged), 'a runtime loading error is not evidence of target validation');
      assertNoAdoption(env, data);
    } finally { file.release(); await env.close(); }
  });

  test(`actual reader rejects a public response before consuming its body after live ${change}`, async (t) => {
    const data = model(); const waiting = deferred<Response>(); let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return requests === 1 ? responseBody().response : waiting.promise;
    });
    const env = await mount(t, data);
    try {
      await until(() => !busy(env.renderer), 'initial cache miss');
      await setUrl(env.renderer, 'https://papers.example.invalid/fulltext.pdf');
      await click(env.renderer, '检查链接');
      await until(() => !busy(env.renderer), 'public probe completed');
      await click(env.renderer, '读取完整 PDF 并打开');
      await until(() => requests === 2, 'public download awaiting response');
      changeTarget(data, change);
      const body = responseBody(); waiting.resolve(body.response);
      await until(() => !busy(env.renderer), 'stale public response rejected');
      assert.equal(body.consumed(), 0, 'reject before decoding bytes or trying the PDF runtime');
      assert.equal(body.cancelled(), true);
      assert.ok(text(env.renderer.root).includes(targetChanged));
      assertNoAdoption(env, data);
    } finally { waiting.resolve(responseBody().response); await env.close(); }
  });
}

test('ready offline access with needsLogin still starts a local file read', async (t) => {
  const data = model(); data.snapshot.needsLogin = true; data.snapshot.online = false;
  const env = await mount(t, data); const file = pendingFile();
  try {
    await until(() => !busy(env.renderer), 'offline initial cache miss');
    await chooseFile(env.renderer, file.file);
    await until(file.reading, 'offline file read is permitted');
    assert.equal(busy(env.renderer), true);
    assert.ok(!text(env.renderer.root).includes(new PdfError('ACCOUNT_CHANGED').message));
    await click(env.renderer, '取消');
    await until(file.cancelled, 'cancelled offline file released');
    assertNoAdoption(env, data);
  } finally { file.release(); await env.close(); }
});

test('a public link probe also rejects stale identity before consuming its response', async (t) => {
  const data = model(); const waiting = deferred<Response>(); let requested = false;
  t.mock.method(globalThis, 'fetch', async () => { requested = true; return waiting.promise; });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache miss');
    await setUrl(env.renderer, 'https://papers.example.invalid/probe.pdf');
    await click(env.renderer, '检查链接');
    await until(() => requested, 'public probe awaiting response');
    changeTarget(data, 'hash');
    const body = responseBody(); waiting.resolve(body.response);
    await until(() => !busy(env.renderer), 'stale public probe rejected');
    assert.equal(body.consumed(), 0);
    assert.equal(body.cancelled(), true);
    assert.ok(text(env.renderer.root).includes(targetChanged));
    assert.ok(!text(env.renderer.root).includes('核对版本将读取'));
    assertNoAdoption(env, data);
  } finally { waiting.resolve(responseBody().response); await env.close(); }
});

test('a cancelled old public probe cannot unlock a new probe or remove its account cleanup registration', async (t) => {
  const data = model(); const first = deferred<Response>(); const second = deferred<Response>();
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    signals.push(init!.signal!); return signals.length === 1 ? first.promise : second.promise;
  });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache miss');
    await setUrl(env.renderer, 'https://papers.example.invalid/first.pdf');
    await click(env.renderer, '检查链接');
    await until(() => signals.length === 1, 'first probe pending');
    await click(env.renderer, '取消');
    assert.equal(signals[0].aborted, true);
    await until(() => !busy(env.renderer), 'cancel releases the first task immediately');
    await setUrl(env.renderer, 'https://papers.example.invalid/second.pdf');
    await click(env.renderer, '检查链接');
    await until(() => signals.length === 2, 'second probe pending');
    const late = responseBody(); first.resolve(late.response);
    await until(late.cancelled, 'late first response discarded');
    assert.equal(late.consumed(), 0);
    assert.equal(busy(env.renderer), true, 'old completion must not release the current task');
    assert.equal(signals[1].aborted, false);
    assert.ok(!text(env.renderer.root).includes('核对版本将读取'));
    cancelPdfTasks(data.scope);
    assert.equal(signals[1].aborted, true, 'the current task must remain registered for account cleanup');
    const last = responseBody(); second.resolve(last.response);
    await until(() => !busy(env.renderer), 'second probe cancelled by account cleanup');
    assert.equal(last.consumed(), 0);
    assertNoAdoption(env, data);
  } finally { first.resolve(responseBody().response); second.resolve(responseBody().response); await env.close(); }
});

test('the actual source action shows separate cache, unconfigured-cloud, and missing-link outcomes', async (t) => {
  const data = model(); let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('No source should dispatch a network request'); });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache miss');
    await click(env.renderer, '从可用来源打开');
    await until(() => !busy(env.renderer), 'all unavailable sources reported');
    const content = text(env.renderer.root);
    assert.ok(content.includes(new PdfError('CACHE_MISSING').message));
    assert.ok(content.includes('尚未配置在线电脑来源'));
    assert.ok(content.includes('尚未配置云副本来源'));
    assert.ok(content.includes('未提供公开 PDF 链接'));
    const attempts = env.renderer.root.findByProps({ 'aria-label': '全文来源尝试' });
    assert.equal(attempts.findByProps({ 'data-source': 'cache' }).props['data-status'], 'failed');
    assert.equal(attempts.findByProps({ 'data-source': 'desktop' }).props['data-status'], 'skipped');
    assert.equal(attempts.findByProps({ 'data-source': 'cloud' }).props['data-status'], 'skipped');
    assert.equal(attempts.findByProps({ 'data-source': 'public' }).props['data-status'], 'skipped');
    assert.equal(requests, 0);
    assertNoAdoption(env, data);
  } finally { await env.close(); }
});

test('the actual source action falls through a missing cloud copy to the supplied public URL and retains both failures', async (t) => {
  const data = model(); const publicUrl = 'https://papers.example.invalid/public-fallback.pdf';
  data.props.cloudPdf = { apiBaseUrl: data.scope.apiBaseUrl, getAccessToken: async () => 'synthetic-access-token',
    getCloudPdfCapability: () => ({ maxFileBytes: PDF_LIMITS.maxFileBytes, maxAccountBytes: 1024 ** 3, maxCopies: 512 }) };
  const requests: { url: string; authorization: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input); requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
    if (url.startsWith(data.scope.apiBaseUrl)) return new Response(JSON.stringify({ error: { code: 'CLOUD_PDF_NOT_FOUND' } }),
      { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response('Source is unavailable', { status: 404 });
  });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache miss');
    assert.equal(requests.length, 0, 'mounting the reader must not fetch cloud or public sources');
    await setUrl(env.renderer, publicUrl);
    await click(env.renderer, '从可用来源打开');
    await until(() => !busy(env.renderer), 'cloud and public failures reported');
    assert.deepEqual(requests.map((request) => request.url), [
      `${data.scope.apiBaseUrl}/v1/cloud-pdfs/${data.version.entityId}/content`, publicUrl,
    ]);
    assert.equal(requests[0].authorization, 'Bearer synthetic-access-token');
    assert.equal(requests[1].authorization, null, 'public fallback must not receive the cloud token');
    const content = text(env.renderer.root);
    assert.ok(content.includes(new PdfError('CACHE_MISSING').message));
    assert.ok(content.includes('此版本暂无可用云副本'));
    assert.ok(content.includes(new PdfError('HTTP').message));
    const attempts = env.renderer.root.findByProps({ 'aria-label': '全文来源尝试' });
    for (const source of ['cache', 'cloud', 'public'])
      assert.equal(attempts.findByProps({ 'data-source': source }).props['data-status'], 'failed');
    assertNoAdoption(env, data);
  } finally { await env.close(); }
});

test('closing the source panel finalizes every attempt and a late cloud response cannot change terminal rows', async (t) => {
  const data = model(); const waiting = deferred<Response>(); let signal: AbortSignal | undefined;
  data.props.cloudPdf = { apiBaseUrl: data.scope.apiBaseUrl, getAccessToken: async () => 'synthetic-access-token',
    getCloudPdfCapability: () => ({ maxFileBytes: PDF_LIMITS.maxFileBytes, maxAccountBytes: 1024 ** 3, maxCopies: 512 }) };
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    requests.push(String(input));
    signal = init!.signal!; return waiting.promise;
  });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache miss');
    await setUrl(env.renderer, 'https://papers.example.invalid/close-panel.pdf');
    await click(env.renderer, '从可用来源打开');
    await until(() => Boolean(signal), 'cloud download awaiting response');
    const attemptRows = () => env.renderer.root.findByProps({ 'aria-label': '全文来源尝试' }).findAllByType('li')
      .map((row) => ({ source: row.props['data-source'], status: row.props['data-status'], content: text(row) }));
    const active = attemptRows();
    assert.deepEqual(active.map(({ source, status }) => ({ source, status })), [
      { source: 'cache', status: 'failed' }, { source: 'desktop', status: 'skipped' },
      { source: 'cloud', status: 'downloading' }, { source: 'public', status: 'pending' },
    ]);
    assert.equal(env.renderer.root.findAllByType('progress').length, 1);
    await act(async () => { env.renderer.root.findByProps({ 'aria-label': '关闭面板' }).props.onClick(); });
    assert.equal(signal!.aborted, true);
    await until(() => !busy(env.renderer), 'closed panel task released before its response arrives');
    await click(env.renderer, '文件');
    const terminal = attemptRows();
    assert.deepEqual(terminal.map(({ source, status }) => ({ source, status })), [
      { source: 'cache', status: 'failed' }, { source: 'desktop', status: 'skipped' },
      { source: 'cloud', status: 'failed' }, { source: 'public', status: 'skipped' },
    ]);
    assert.deepEqual(terminal[0], active[0], 'the earlier cache failure must retain its original explanation');
    assert.deepEqual(terminal[1], active[1], 'the unavailable desktop row must keep its explanation');
    assert.ok(terminal[2].content.includes(new PdfError('CANCELLED').message));
    assert.ok(terminal[3].content.includes('本次检查已停止，未尝试此来源。'));
    assert.ok(terminal.every((row) => !['pending', 'checking', 'downloading', 'verifying'].includes(row.status)));
    assert.equal(env.renderer.root.findAllByType('progress').length, 0);
    const body = responseBody(); waiting.resolve(body.response);
    await until(body.cancelled, 'closed panel late cloud response disposed');
    await flush();
    assert.deepEqual(attemptRows(), terminal, 'late completion must not replace cancelled or skipped source outcomes');
    assert.equal(env.renderer.root.findAllByType('progress').length, 0);
    assert.equal(busy(env.renderer), false);
    assert.deepEqual(requests, [`${data.scope.apiBaseUrl}/v1/cloud-pdfs/${data.version.entityId}/content`]);
    assert.equal(body.consumed(), 0);
    assertNoAdoption(env, data);
  } finally { waiting.resolve(responseBody().response); await env.close(); }
});

function desktopContext(data: Model): DesktopPdfContext {
  return { apiBaseUrl: data.scope.apiBaseUrl, getAccessToken: async () => 'synthetic-desktop-token',
    getDesktopPdfCapability: () => ({ transport: 'http-relay-v1', maxFileBytes: PDF_LIMITS.maxFileBytes,
      requestTtlMs: 30_000, pollTimeoutMs: 20_000 }) };
}
const desktopCreated = (data: Model, requestId: string) => new Response(JSON.stringify({
  requestId, attachmentVersionId: data.version.entityId, expiresAt: new Date(Date.now() + 30_000).toISOString(),
}), { status: 201, headers: { 'content-type': 'application/json' } });
const sourceFailure = (status: number, code: string) => new Response(JSON.stringify({ error: { code } }),
  { status, headers: { 'content-type': 'application/json' } });

test('the actual reader remains cache-only on mount and shows desktop, cloud and public fallback reasons in order', async (t) => {
  const data = model(); data.props.desktopPdf = desktopContext(data);
  data.props.cloudPdf = { apiBaseUrl: data.scope.apiBaseUrl, getAccessToken: async () => 'synthetic-cloud-token',
    getCloudPdfCapability: () => ({ maxFileBytes: PDF_LIMITS.maxFileBytes, maxAccountBytes: 1024 ** 3, maxCopies: 512 }) };
  const requests: { url: string; method: string; authorization: string | null; body: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input); requests.push({ url, method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('Authorization'), body: String(init?.body ?? '') });
    if (url.includes('/desktop-pdfs/')) return sourceFailure(404, 'DESKTOP_PDF_UNAVAILABLE');
    if (url.includes('/cloud-pdfs/')) return sourceFailure(404, 'CLOUD_PDF_NOT_FOUND');
    return new Response('Unavailable', { status: 404 });
  });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache-only restoration'); assert.equal(requests.length, 0);
    const publicUrl = 'https://papers.example.invalid/synthetic.pdf?private-local-only=1';
    await setUrl(env.renderer, publicUrl); await click(env.renderer, '从可用来源打开');
    await until(() => !busy(env.renderer), 'all four source outcomes settled');
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ['POST', `${data.scope.apiBaseUrl}/v1/desktop-pdfs/requests`],
      ['GET', `${data.scope.apiBaseUrl}/v1/cloud-pdfs/${data.version.entityId}/content`], ['GET', publicUrl],
    ]);
    assert.equal(requests[0].authorization, 'Bearer synthetic-desktop-token');
    assert.equal(requests[1].authorization, 'Bearer synthetic-cloud-token'); assert.equal(requests[2].authorization, null);
    assert.deepEqual(JSON.parse(requests[0].body), { attachmentVersionId: data.version.entityId });
    const attempts = env.renderer.root.findByProps({ 'aria-label': '全文来源尝试' });
    assert.deepEqual(attempts.findAllByType('li').map((row) => row.props['data-source']), ['cache', 'desktop', 'cloud', 'public']);
    assert.ok(text(attempts).includes(new DesktopPdfError('UNAVAILABLE').message));
    assert.ok(!text(attempts).includes('private-local-only')); assertNoAdoption(env, data);
  } finally { await env.close(); }
});

for (const mode of ['feature-disabled', 'needs-login', 'pending-edit', 'new-version'] as const) {
  test(`actual reader skips desktop for ${mode} without acquiring credentials or probing availability`, async (t) => {
    const data = model(); let tokens = 0; let requests = 0;
    const desktop = desktopContext(data);
    data.props.desktopPdf = { ...desktop, getAccessToken: async () => { tokens++; return 'token'; },
      getDesktopPdfCapability: () => mode === 'feature-disabled' ? null : desktop.getDesktopPdfCapability() };
    if (mode === 'needs-login') data.snapshot.needsLogin = true;
    if (mode === 'pending-edit' || mode === 'new-version') {
      if (mode === 'new-version') delete data.sync.serverRecords[entityKey('attachmentVersion', data.version.entityId)];
      const state = queueLocalEdit(data.sync, { entityType: 'attachmentVersion', entityId: data.version.entityId,
        mutation: 'put', data: { ...data.version.data, fileName: 'local-pending.pdf' } }, { opId: crypto.randomUUID(), clientCreatedAt: NOW });
      data.snapshot.workspace!.sync = state;
      data.props.attachmentVersions = [getVisibleEntity(state, 'attachmentVersion', data.version.entityId)!];
    }
    t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('disabled source cannot fetch'); });
    const env = await mount(t, data);
    try {
      await until(() => !busy(env.renderer), 'initial cache miss'); await click(env.renderer, '从可用来源打开');
      await until(() => !busy(env.renderer), 'unavailable remote source settled');
      const row = env.renderer.root.findByProps({ 'data-source': 'desktop' });
      assert.equal(row.props['data-status'], 'skipped');
      const expected = mode === 'feature-disabled' ? '账号服务尚未开放在线电脑取文件'
        : mode === 'needs-login' ? '当前登录不可用于从在线电脑取文件' : '此版本尚未同步';
      assert.ok(text(row).includes(expected)); assert.equal(tokens, 0); assert.equal(requests, 0);
      assert.equal(env.writes(), 0); assert.deepEqual(data.saved, []);
      assert.equal(data.snapshot.workspace!.sync.outbox.length, mode === 'pending-edit' || mode === 'new-version' ? 1 : 0);
    } finally { await env.close(); }
  });
}

test('actual reader target invalidation from desktop ends the chain and displays a specific terminal reason', async (t) => {
  const data = model(); data.props.desktopPdf = desktopContext(data); const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    requests.push(String(input)); assert.ok(String(input).includes('/desktop-pdfs/'));
    return sourceFailure(409, 'DESKTOP_PDF_CHANGED');
  });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache miss');
    await setUrl(env.renderer, 'https://papers.example.invalid/should-not-fetch.pdf');
    await click(env.renderer, '从可用来源打开'); await until(() => !busy(env.renderer), 'terminal desktop error');
    assert.equal(requests.length, 1); assert.ok(text(env.renderer.root).includes(new DesktopPdfError('CHANGED').message));
    for (const source of ['cloud', 'public']) {
      const row = env.renderer.root.findByProps({ 'data-source': source }); assert.equal(row.props['data-status'], 'skipped');
      assert.ok(text(row).includes('本次检查已停止，未尝试此来源。'));
    }
    assertNoAdoption(env, data);
  } finally { await env.close(); }
});

test('closing the source panel during desktop content cancels its own request promptly and keeps late rows terminal', async (t) => {
  const data = model(); data.props.desktopPdf = desktopContext(data); const requestId = crypto.randomUUID();
  const reply = deferred<Response>(); const cleanup = deferred<Response>(); const requests: { method: string; url: string }[] = [];
  let contentSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; requests.push({ method, url: String(input) });
    assert.ok(String(input).includes('/desktop-pdfs/'));
    if (method === 'POST') return desktopCreated(data, requestId);
    if (method === 'DELETE') return cleanup.promise;
    contentSignal = init!.signal!; return reply.promise;
  });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache miss');
    await setUrl(env.renderer, 'https://papers.example.invalid/never-fallback.pdf');
    await click(env.renderer, '从可用来源打开'); await until(() => Boolean(contentSignal), 'desktop content waiting');
    await act(async () => { env.renderer.root.findByProps({ 'aria-label': '关闭面板' }).props.onClick(); });
    await until(() => !busy(env.renderer), 'UI released without waiting for DELETE'); assert.equal(contentSignal!.aborted, true);
    await click(env.renderer, '文件');
    const rows = () => env.renderer.root.findByProps({ 'aria-label': '全文来源尝试' }).findAllByType('li')
      .map((row) => ({ source: row.props['data-source'], status: row.props['data-status'], message: text(row) }));
    const terminal = rows();
    assert.deepEqual(terminal.map(({ source, status }) => [source, status]), [
      ['cache', 'failed'], ['desktop', 'failed'], ['cloud', 'skipped'], ['public', 'skipped'],
    ]);
    assert.ok(terminal[1].message.includes('已取消')); assert.equal(env.renderer.root.findAllByType('progress').length, 0);
    assert.deepEqual(requests, [
      { method: 'POST', url: `${data.scope.apiBaseUrl}/v1/desktop-pdfs/requests` },
      { method: 'GET', url: `${data.scope.apiBaseUrl}/v1/desktop-pdfs/requests/${requestId}/content` },
      { method: 'DELETE', url: `${data.scope.apiBaseUrl}/v1/desktop-pdfs/requests/${requestId}` },
    ]);
    const body = responseBody(); reply.resolve(body.response); cleanup.resolve(sourceFailure(404, 'NOT_FOUND'));
    await until(body.cancelled, 'late desktop response disposed'); await flush();
    assert.equal(body.consumed(), 0); assert.deepEqual(rows(), terminal); assertNoAdoption(env, data);
  } finally { reply.resolve(responseBody().response); cleanup.resolve(sourceFailure(404, 'NOT_FOUND')); await env.close(); }
});

test('login eligibility lost during desktop creation prevents content and fallback even before React rerenders', async (t) => {
  const data = model(); data.props.desktopPdf = desktopContext(data); const reply = deferred<Response>(); let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return reply.promise; });
  const env = await mount(t, data);
  try {
    await until(() => !busy(env.renderer), 'initial cache miss');
    await setUrl(env.renderer, 'https://papers.example.invalid/never-fallback.pdf'); await click(env.renderer, '从可用来源打开');
    await until(() => requests === 1, 'desktop creation pending'); data.snapshot.needsLogin = true;
    reply.resolve(desktopCreated(data, crypto.randomUUID())); await until(() => !busy(env.renderer), 'login eligibility loss stopped the chain');
    assert.equal(requests, 1); assert.ok(text(env.renderer.root).includes('登录已过期'));
    assertNoAdoption(env, data);
  } finally { reply.resolve(sourceFailure(404, 'NOT_FOUND')); await env.close(); }
});

for (const mode of ['complete-wait', 'relay-wait'] as const) {
  test(`actual reader shows ${mode} transport and cancel prevents both early adoption and late revival`, async (t) => {
    const data = model(); const legacy = desktopContext(data); const requestId = crypto.randomUUID();
    const peer = new FakeDesktopPeer(); const hold = deferred<Response>(); let waiting = false; const paths: string[] = [];
    const expiresAt = new Date(Date.now() + 30000).toISOString(), directExpiresAt = new Date(Date.now() + 6000).toISOString();
    data.props.desktopPdf = { ...legacy, getDesktopPdfCapability: () => ({ ...legacy.getDesktopPdfCapability()!,
      direct: { transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls: [] } }) };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: function () { return peer; } });
    t.after(() => { if (original) Object.defineProperty(globalThis, 'RTCPeerConnection', original); else Reflect.deleteProperty(globalThis, 'RTCPeerConnection'); });
    peer.onAnswer = () => {
      if (mode === 'complete-wait') peer.deliver(data.version, requestId, bytes);
      else {
        peer.channel.receive(JSON.stringify({ type: 'metadata', requestId, attachmentVersionId: data.version.entityId,
          sha256: hash, sizeBytes: bytes.length }));
        peer.channel.receive(bytes.slice(0, 8).buffer); peer.fail();
      }
    };
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
      const path = String(input).slice(data.scope.apiBaseUrl.length); paths.push(path);
      if (init?.method === 'DELETE') return reply({ cancelled: true });
      if (path === '/v1/desktop-pdfs/requests') return reply({ requestId, attachmentVersionId: data.version.entityId, expiresAt }, 201);
      if (path.endsWith('/direct')) return reply({ state: 'direct', answer: TEST_SDP, expiresAt, directExpiresAt, relayReady: false,
        authorizedUntil: new Date(Date.now() + 1900).toISOString() });
      if (path.endsWith('/fallback')) return reply({ state: 'relay' });
      assert.ok(path.endsWith(mode === 'complete-wait' ? '/complete' : '/content'));
      waiting = true; return hold.promise;
    });
    const env = await mount(t, data);
    try {
      await until(() => !busy(env.renderer), 'initial cache miss'); assert.equal(paths.length, 0); assert.equal(peer.created.length, 0);
      await click(env.renderer, '从可用来源打开'); await until(() => waiting, 'transport awaiting verified receipt or relay');
      const row = env.renderer.root.findByProps({ 'data-source': 'desktop' });
      assert.equal(row.props['data-transfer'], mode === 'complete-wait' ? 'direct-connecting' : 'relay-fallback');
      assert.ok(text(row).includes(mode === 'complete-wait' ? '正在尝试设备直连' : '直连未建立，使用临时中继'));
      if (mode === 'relay-wait') assert.equal(row.findByType('progress').props.value, 0);
      assert.deepEqual(peer.channel.sent, []); assertNoAdoption(env, data);
      await act(async () => { env.renderer.root.findByProps({ 'aria-label': '关闭面板' }).props.onClick(); });
      await until(() => !busy(env.renderer), 'cancelled direct task released the reader');
      assert.equal(peer.closed, 1); await click(env.renderer, '文件');
      const terminal = text(env.renderer.root.findByProps({ 'data-source': 'desktop' })); assert.ok(terminal.includes('已取消'));
      hold.resolve(reply({ received: true })); await flush();
      assert.equal(text(env.renderer.root.findByProps({ 'data-source': 'desktop' })), terminal);
      assert.equal(paths.filter((path) => path === '/v1/desktop-pdfs/requests').length, 1); assertNoAdoption(env, data);
      assert.equal(paths.some((path) => path.includes('/cloud-pdfs/')), false);
    } finally { hold.resolve(sourceFailure(410, 'ATTACHMENT_VERSION_UNAVAILABLE')); await env.close(); }
  });
}
