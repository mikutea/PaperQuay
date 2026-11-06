import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import { inspectParsedImage, verifyParsedDocument, type ParsedDocumentPackage } from '../../../packages/sync-core/src/parsedDocument.ts';
import { ParsedDocumentView, ParsedMarkdown } from '../src/components/ParsedDocumentView.tsx';
import ParsedDocumentPanel, { assertParsedTarget } from '../src/components/ParsedDocumentPanel.tsx';
import { getParsedCache, type ParsedCacheOptions, type VerifiedParsedDocument } from '../src/parsed/cache.ts';
import type { AccountScope } from '../src/storage/accountStore.ts';
import { prepareParsedAssets } from '../src/parsed/assets.ts';
import type { PdfAiContext, PdfVersion } from '../src/pdf/types.ts';
import { cancelPdfTasks } from '../src/pdf/tasks.ts';
import { PdfError } from '../src/pdf/errors.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(): ParsedDocumentPackage {
  return { format: 'paperquay-parsed-document', version: 1, paperId: id(1), attachmentVersionId: id(2),
    pdf: { sha256: 'a'.repeat(64), sizeBytes: 2048, pageCount: 2 }, parser: { name: 'mineru', model: 'vlm' },
    blocks: [{ id: 'text-1', kind: 'text', pageIndex: 0, text: 'Original parsed paragraph', markdown: 'Original **parsed** paragraph $x=1$.' },
      { id: 'math-1', kind: 'equation', pageIndex: 1, text: 'e', latex: 'E=mc^2' },
      { id: 'table-1', kind: 'table', pageIndex: 1, text: 'table', table: { caption: 'Results', rows: [
        { section: 'head', cells: [{ text: 'Name', colSpan: 2, rowSpan: 1, header: true }] },
        { section: 'body', cells: [{ text: 'A', colSpan: 1, rowSpan: 2, header: false }, { text: '$x$', colSpan: 1, rowSpan: 1, header: false }] },
        { section: 'body', cells: [{ text: 'B', colSpan: 1, rowSpan: 1, header: false }] },
        { section: 'foot', cells: [{ text: 'Footnote', colSpan: 2, rowSpan: 1, header: false }] },
      ] } }], assets: [] };
}
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
const button = (renderer: ReactTestRenderer, label: string) => {
  const value = renderer.root.findAllByType('button').find((node) => text(node) === label); assert.ok(value, `Button ${label}`); return value;
};
const flush = async () => { await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }); };
async function until(predicate: () => boolean) {
  // Digest/file work can still be pending after many empty event-loop turns.
  // Bound elapsed time and yield to that work instead of counting fast spins.
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); });
  }
  assert.fail('UI did not settle within 5 seconds');
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
function version(document = fixture()): PdfVersion { return { entityId: document.attachmentVersionId, data: {
  paperId: document.paperId, attachmentId: id(3), sha256: document.pdf.sha256, sizeBytes: document.pdf.sizeBytes,
  pageCount: document.pdf.pageCount, mediaType: 'application/pdf', fileName: 'fixture.pdf',
} }; }

test('parsed rendering preserves math, table spans/footer and the selected page without active HTML or remote image loads', async () => {
  const document = (await verifyParsedDocument(fixture())).document;
  const html = renderToStaticMarkup(createElement(ParsedDocumentView, { document, pageIndex: 1, offset: 0, urls: new Map(), onJump: () => {} }));
  assert.match(html, /class="katex/); assert.match(html, /colSpan="2"/i); assert.match(html, /rowSpan="2"/i);
  assert.match(html, /<tfoot>/); assert.match(html, /Footnote/); assert.doesNotMatch(html, /Original parsed/);
  const unsafe = renderToStaticMarkup(createElement(ParsedMarkdown, { text: '<script>globalThis.bad=1</script>\n\n![track](https://outside.invalid/pixel.png)\n\n[x](javascript:alert(1))\n\n$\\href{https://outside.invalid/}{x}$' }));
  assert.doesNotMatch(unsafe, /<script|<img|src="https:|href="javascript:|href="https:\/\/outside/i);
  assert.match(unsafe, /track/);
});

test('one parsed page renders bounded blocks and page targets follow block provenance', () => {
  const document = fixture(); document.blocks = Array.from({ length: 100 }, (_, i) => ({ id: `b-${i}`, kind: 'text', text: `Block ${i}`, pageIndex: 0 }));
  const html = renderToStaticMarkup(createElement(ParsedDocumentView, { document, pageIndex: 0, offset: 40, urls: new Map(), onJump: () => {} }));
  assert.equal((html.match(/data-block-id=/g) ?? []).length, 40);
  assert.match(html, /Block 40/); assert.match(html, /Block 79/); assert.doesNotMatch(html, /Block 80/);
  for (const patch of [{ paperId: id(7) }, { attachmentVersionId: id(7) }, { pdf: { ...document.pdf, pageCount: 1 } }, { pdf: { ...document.pdf, sha256: 'b'.repeat(64) } }])
    assert.throws(() => assertParsedTarget({ ...document, ...patch }, version(), 2), (e: unknown) => e instanceof PdfError && e.code === 'VERSION_MISMATCH');
});

test('continuation chains render the original table, equation and image on the continuation page', () => {
  const document = fixture();
  document.blocks[2].table!.caption = 'Results $x^2$';
  document.blocks.push({ id: 'table-next', kind: 'table', pageIndex: 0, text: '', sourceBlockId: 'table-1' },
    { id: 'table-chain', kind: 'table', pageIndex: 0, text: '', sourceBlockId: 'table-next' },
    { id: 'math-next', kind: 'equation', pageIndex: 0, text: '', sourceBlockId: 'math-1' },
    { id: 'img-origin', kind: 'image', pageIndex: 1, text: 'Figure', assetId: 'img-1' },
    { id: 'img-next', kind: 'image', pageIndex: 0, text: '', sourceBlockId: 'img-origin' });
  const html = renderToStaticMarkup(createElement(ParsedDocumentView, { document, pageIndex: 0, offset: 0, urls: new Map([['img-1', 'blob:verified-figure']]), onJump: () => {} }));
  assert.equal((html.match(/<table>/g) ?? []).length, 2);
  assert.match(html, /<caption>.*katex/); assert.match(html, /blob:verified-figure/);
  assert.match(html, /E=mc\^2/); assert.match(html, /查看 PDF 第 1 页/); assert.doesNotMatch(html, /查看 PDF 第 2 页/);
});

async function mount(t: TestContext, corrupt = false, ai = false) {
  for (const [name, value] of Object.entries({ indexedDB: new IDBFactory(), window: { confirm: () => true } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
  const cache = getParsedCache(), initial = await verifyParsedDocument(fixture());
  const scope = { apiBaseUrl: 'https://sync.example.invalid', accountId: crypto.randomUUID() };
  const stored = { current: initial, writes: 0 }; let current = true; const jumps: number[] = [];
  const aiContexts: PdfAiContext[] = [];
  const changes: (string | null)[] = [];
  t.mock.method(cache, 'read', async () => { if (corrupt) throw new PdfError('CACHE_CORRUPT'); return stored.current; });
  t.mock.method(cache, 'put', async (_scope: AccountScope, value: VerifiedParsedDocument, options: ParsedCacheOptions) => {
    if (!options.guard?.() || options.signal?.aborted) throw new PdfError('ACCOUNT_CHANGED');
    stored.current = value; stored.writes++;
  });
  t.mock.method(cache, 'remove', async (_scope: AccountScope, _versionId: string, options?: ParsedCacheOptions) => { if (!options?.guard?.()) throw new PdfError('ACCOUNT_CHANGED'); });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ParsedDocumentPanel, {
    scope, version: version(), pageCount: 2, pdfPageIndex: 0, isCurrent: () => current, onJump: (page) => jumps.push(page),
    ...(ai ? { onAskAi: (context: PdfAiContext) => { aiContexts.push(context); } } : {}),
    onPackageChange: (digest: string | null) => { changes.push(digest); },
  })); });
  t.after(() => { act(() => renderer.unmount()); });
  await until(() => corrupt ? renderer.root.findAllByProps({ role: 'alert' }).length > 0
    : renderer.root.findAllByProps({ role: 'status' }).some((node) => text(node).includes('已读取')));
  async function upload(value: unknown, bytes?: Promise<ArrayBuffer>) {
    const raw = new TextEncoder().encode(JSON.stringify(value));
    const file = { size: raw.byteLength, arrayBuffer: () => bytes ?? Promise.resolve(raw.buffer) };
    await act(async () => { renderer.root.findByProps({ 'aria-label': '导入解析包', type: 'file' }).props.onChange({ currentTarget: { files: [file], value: 'fixture.json' } }); });
  }
  return { renderer, cache, stored, scope, jumps, aiContexts, changes, upload, invalidate: () => { current = false; } };
}

test('parsed AI entry prepares only the explicitly selected page or package and preserves cache', async (t) => {
  const model = await mount(t, false, true);
  assert.equal(model.aiContexts.length, 0);
  await act(async () => { button(model.renderer, '用本页解析文本提问').props.onClick(); });
  await until(() => model.aiContexts.length === 1);
  assert.equal(model.aiContexts[0].scope, 'page');
  assert.deepEqual(model.aiContexts[0].pages.map(page => page.pageIndex), [0]);
  assert.equal(model.aiContexts[0].textSource?.packageDigest, model.stored.current.digest);
  assert.equal(model.aiContexts[0].complete, false);
  await until(() => !button(model.renderer, '用解析包文本提问').props.disabled);
  await act(async () => { button(model.renderer, '用解析包文本提问').props.onClick(); });
  await until(() => model.aiContexts.length === 2);
  assert.equal(model.aiContexts[1].scope, 'document');
  assert.deepEqual(model.aiContexts[1].pages.map(page => page.pageIndex), [0, 1]);
  assert.equal(model.stored.writes, 0);
});

test('cancelled or account-invalidated asynchronous parsed context preparation cannot hand off text', async (t) => {
  const model = await mount(t, false, true);
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let gate = deferred<void>(); let started = false;
  t.mock.method(crypto.subtle, 'digest', async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    started = true; await gate.promise; return original(algorithm, data);
  });
  await act(async () => { button(model.renderer, '用解析包文本提问').props.onClick(); });
  await until(() => started);
  await act(async () => { button(model.renderer, '取消解析操作').props.onClick(); gate.resolve(); });
  await until(() => !button(model.renderer, '用解析包文本提问').props.disabled);
  assert.equal(model.aiContexts.length, 0);
  gate = deferred<void>(); started = false;
  await act(async () => { button(model.renderer, '用解析包文本提问').props.onClick(); });
  await until(() => started);
  model.invalidate(); gate.resolve();
  await until(() => !button(model.renderer, '用解析包文本提问').props.disabled);
  assert.equal(model.aiContexts.length, 0); assert.equal(model.stored.writes, 0);
});

test('replacement becomes visible only after cache commit; a wrong version preserves the last valid package', async (t) => {
  const model = await mount(t), gate = deferred<void>();
  t.mock.method(model.cache, 'put', async (_scope: AccountScope, value: VerifiedParsedDocument, options: ParsedCacheOptions) => { await gate.promise; assert.ok(options.guard?.()); model.stored.current = value; model.stored.writes++; });
  const next = fixture(); next.blocks[0].text = 'Replacement'; next.blocks[0].markdown = 'Replacement';
  await model.upload(next); await flush();
  assert.match(text(model.renderer.root), /Original parsed/); assert.doesNotMatch(text(model.renderer.root), /Replacement/);
  assert.equal(model.changes.length, 1);
  gate.resolve(); await until(() => text(model.renderer.root).includes('解析包已保存'));
  assert.match(text(model.renderer.root), /Replacement/);
  await model.upload({ ...next, attachmentVersionId: id(8) });
  await until(() => text(model.renderer.root).includes('版本不一致'));
  assert.equal(model.stored.writes, 1); assert.match(text(model.renderer.root), /Replacement/);
  assert.deepEqual(model.changes, [model.changes[0], model.stored.current.digest]);
});

test('cancelled or account-invalidated file reads never persist and retain the previous valid display', async (t) => {
  const model = await mount(t), file = deferred<ArrayBuffer>();
  await model.upload(fixture(), file.promise);
  await act(async () => { button(model.renderer, '取消解析操作').props.onClick(); });
  await until(() => text(model.renderer.root).includes('已取消'));
  file.resolve(new TextEncoder().encode(JSON.stringify(fixture())).buffer); await flush();
  assert.equal(model.stored.writes, 0); assert.match(text(model.renderer.root), /Original parsed/);
  const second = deferred<ArrayBuffer>(); await model.upload(fixture(), second.promise); model.invalidate();
  second.resolve(new TextEncoder().encode(JSON.stringify(fixture())).buffer);
  await until(() => text(model.renderer.root).includes('账号或阅读会话'));
  assert.equal(model.stored.writes, 0);
});

test('storage failure leaves the previous package visible and account cleanup retires its view', async (t) => {
  const model = await mount(t);
  t.mock.method(model.cache, 'put', async () => { throw new PdfError('CACHE_UNAVAILABLE'); });
  const next = fixture(); next.blocks[0].text = 'Uncommitted'; next.blocks[0].markdown = 'Uncommitted';
  await model.upload(next); await until(() => text(model.renderer.root).includes('无法保存解析缓存'));
  assert.match(text(model.renderer.root), /Original parsed/); assert.doesNotMatch(text(model.renderer.root), /Uncommitted/);
  await act(async () => { cancelPdfTasks(model.scope); });
  assert.doesNotMatch(text(model.renderer.root), /Original parsed/);
});

test('a successful cache commit acknowledged after cancellation retires the old AI source and permits explicit reload', {timeout:5000}, async (t) => {
  const model = await mount(t, false, true), gate = deferred<void>(), entered=deferred<void>();
  t.mock.method(model.cache, 'put', async (_scope: AccountScope, value: VerifiedParsedDocument) => {
    model.stored.current = value; model.stored.writes++; entered.resolve(); await gate.promise;
  });
  const replacement = fixture(); replacement.blocks[0].text = 'Committed replacement'; replacement.blocks[0].markdown = 'Committed replacement';
  const fileBytes = new TextEncoder().encode(JSON.stringify(replacement)).buffer;
  const delayedRead = new Promise<ArrayBuffer>((resolve) => setTimeout(() => resolve(fileBytes), 50));
  // Wait for the actual commit entry after asynchronous file/crypto work.
  await model.upload(replacement, delayedRead); await act(async()=>entered.promise);
  await act(async () => { button(model.renderer, '取消解析操作').props.onClick(); });
  await until(() => text(model.renderer.root).includes('已取消'));
  gate.resolve();
  await until(() => model.changes.includes(model.stored.current.digest));
  assert.doesNotMatch(text(model.renderer.root), /Original parsed/);
  assert.equal(model.renderer.root.findAllByType('button').some(node => text(node) === '用本页解析文本提问'), false);
  await act(async () => { button(model.renderer, '重新载入解析缓存').props.onClick(); });
  await until(() => text(model.renderer.root).includes('Committed replacement'));
});

test('committed remove and account clear also invalidate text when cancellation precedes their acknowledgment', async (t) => {
  for (const method of ['remove', 'clear'] as const) await t.test(method, async (t) => {
    const model = await mount(t, false, true), gate = deferred<void>(); let committed = false;
    t.mock.method(model.cache, method, async () => { committed = true; await gate.promise; });
    const label = method === 'remove' ? '清理此版本解析缓存' : '清除此账号的全部解析缓存';
    await act(async () => { button(model.renderer, label).props.onClick(); });
    await until(() => committed);
    await act(async () => { button(model.renderer, '取消解析操作').props.onClick(); });
    await until(() => text(model.renderer.root).includes('已取消'));
    gate.resolve(); await until(() => model.changes.includes(null));
    assert.doesNotMatch(text(model.renderer.root), /Original parsed/);
    t.mock.method(model.cache, 'read', async () => null);
    await act(async () => { button(model.renderer, '重新载入解析缓存').props.onClick(); });
    await until(() => text(model.renderer.root).includes('此版本还没有解析包'));
    assert.equal(model.aiContexts.length, 0);
  });
});

test('parsed paging and block navigation preserve page indices', async (t) => {
  const model = await mount(t);
  await act(async () => { model.renderer.root.findByProps({ 'aria-label': '下一解析页' }).props.onClick(); });
  assert.match(text(model.renderer.root), /Results/);
  await act(async () => { button(model.renderer, '查看 PDF 第 2 页').props.onClick(); });
  assert.deepEqual(model.jumps, [1]);
});

test('corrupt cache remains explicitly removable before a parsed document is ready', async (t) => {
  const model = await mount(t, true); let removed = '';
  t.mock.method(model.cache, 'remove', async (_scope: AccountScope, versionId: string, options?: ParsedCacheOptions) => {
    assert.ok(options?.guard?.()); removed = versionId;
  });
  assert.doesNotMatch(text(model.renderer.root), /Original parsed/);
  await act(async () => { button(model.renderer, '清理此版本解析缓存').props.onClick(); });
  await until(() => text(model.renderer.root).includes('本机解析缓存已清理'));
  assert.equal(removed, version().entityId);
  await model.upload(fixture()); await until(() => text(model.renderer.root).includes('解析包已保存'));
  assert.equal(model.stored.writes, 1); assert.match(text(model.renderer.root), /Original parsed/);
});

test('clearing all parsed packages requires confirmation, scopes the request and preserves the view on failure', async (t) => {
  const model = await mount(t); const calls: AccountScope[] = []; let allow = false; let fail = true;
  t.mock.method(window, 'confirm', () => allow);
  t.mock.method(model.cache, 'clear', async (scope: AccountScope, options?: ParsedCacheOptions) => {
    assert.ok(options?.guard?.()); calls.push(scope); if (fail) throw new PdfError('CACHE_UNAVAILABLE');
  });
  const label = '清除此账号的全部解析缓存';
  await act(async () => { button(model.renderer, label).props.onClick(); }); assert.equal(calls.length, 0);
  allow = true; await act(async () => { button(model.renderer, label).props.onClick(); });
  await until(() => text(model.renderer.root).includes('无法保存解析缓存'));
  assert.match(text(model.renderer.root), /Original parsed/); assert.deepEqual(calls, [model.scope]);
  fail = false; await act(async () => { button(model.renderer, label).props.onClick(); });
  await until(() => text(model.renderer.root).includes('此账号的本机解析缓存已清理'));
  assert.doesNotMatch(text(model.renderer.root), /Original parsed/); assert.deepEqual(calls, [model.scope, model.scope]);
});

test('actual asset preparation revokes URLs on invalid decode dimensions, cancellation and explicit release', async (t) => {
  const document = fixture(); const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3sAAAAASUVORK5CYII=', 'base64'));
  document.assets = [{ id: 'img', ...inspectParsedImage(bytes), base64: Buffer.from(bytes).toString('base64'), sizeBytes: bytes.length, sha256: 'a'.repeat(64) }];
  let mode: 'valid' | 'bad' | 'pending' = 'bad'; const revoked: string[] = []; let made = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  class ImageStub { onload: (() => void) | null = null; onerror: (() => void) | null = null; naturalWidth = 1; naturalHeight = 1;
    set src(_value: string) { this.naturalWidth = mode === 'bad' ? 2 : 1; if (mode !== 'pending') queueMicrotask(() => this.onload?.()); }
    removeAttribute() {}
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: ImageStub });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Image', original); else Reflect.deleteProperty(globalThis, 'Image'); });
  t.mock.method(URL, 'createObjectURL', () => `blob:qa-${++made}`); t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  await assert.rejects(prepareParsedAssets(document, new AbortController().signal)); assert.equal(revoked.length, 1);
  mode = 'pending'; const cancel = new AbortController(), pending = prepareParsedAssets(document, cancel.signal); cancel.abort();
  await assert.rejects(pending); assert.equal(revoked.length, 2);
  mode = 'valid'; const assets = await prepareParsedAssets(document, new AbortController().signal); assert.equal(assets.urls.size, 1);
  assets.release(); assets.release(); assert.equal(revoked.length, 3);
});
