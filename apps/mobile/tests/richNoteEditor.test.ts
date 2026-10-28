import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Editor, getSchema } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { createRichNoteData, validateRichNoteData, RichNoteError, type RichNoteAsset, type RichNoteData, type RichNoteNode } from '../../../packages/sync-core/src/richNote.ts';
import { RichNoteEditor, RichNotePreview } from '../src/components/RichNoteEditor.tsx';
import { createRichNoteExtensions, RICH_NOTE_MATH_OPTIONS } from '../src/components/richNoteExtensions.ts';
import { RichNoteImageError, RichNoteImagePool, readRichNoteImage, type RichNoteImageRuntime } from '../src/components/richNoteImages.ts';
import { RichNoteSession } from '../src/components/richNoteSession.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
const digest = createHash('sha256').update(png).digest('hex');
const asset = (): RichNoteAsset => ({ id: digest, sha256: digest, mediaType: 'image/png', sizeBytes: png.length, base64: png.toString('base64'), width: 1, height: 1 });
const p = (text = '原文'): RichNoteNode => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
function value(content: RichNoteNode[] = [p()], assets: RichNoteAsset[] = []): RichNoteData {
  return createRichNoteData({ paperId: null, title: '测试', document: { type: 'doc', content }, assets,
    metadata: { type: 'standalone', anchors: [], tags: [], color: '#fef08a', isFavorite: false, isPinned: false,
      createdAt: 1, updatedAt: 2, linkedNoteIds: [], linkedPaperIds: [], unresolvedReferences: [] } });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function runtime(decode: RichNoteImageRuntime['decode'] = async () => ({ width: 1, height: 1 })) {
  let counter = 0; const created: string[] = [], revoked: string[] = [];
  const implementation: RichNoteImageRuntime = { create: () => { const url = `blob:test-${++counter}`; created.push(url); return url; }, revoke: (url) => revoked.push(url), decode };
  return { implementation, created, revoked };
}
const imageNode = (): RichNoteNode => ({ type: 'image', attrs: { src: `asset:sha256:${digest}`, alt: '本地图片', title: null, width: 1, height: 1 } });
const tick = async () => { await act(async () => { await new Promise<void>((done) => setImmediate(done)); }); };

test('session construction and controlled acks never normalize/replace or emit the original document', () => {
  const original = value(); const snapshot = JSON.stringify(original), session = new RichNoteSession(original);
  assert.equal(session.isDirty, false);
  assert.equal(JSON.stringify(session.current), snapshot);
  session.prepare(original.document); assert.equal(session.isDirty, false);
  assert.deepEqual(session.receive(structuredClone(original)), { replace: false, resources: false });
  const edited = session.edit({ type: 'doc', content: [p('实际编辑')] })!;
  assert.equal(session.isDirty, true);
  assert.equal(edited.body, '实际编辑');
  assert.equal(session.receive({ ...original, title: '只改标题' }).replace, false);
  assert.equal(session.current.body, '实际编辑'); assert.equal(session.current.title, '只改标题');
  assert.equal(session.receive({ ...edited, title: '只改标题' }).replace, false);
  assert.equal(session.isDirty, true);
  const external = value([p('外部新版本')]); assert.equal(session.receive(external).replace, true);
  assert.equal(session.isDirty, false);
  assert.equal(session.current.body, '外部新版本'); assert.equal(JSON.stringify(original), snapshot);
});

test('failed edits preserve the last valid payload, retired sessions cannot publish', () => {
  const original = value(), session = new RichNoteSession(original);
  assert.throws(() => session.edit({ type: 'doc', content: [{ type: 'video' }] }), RichNoteError);
  assert.equal(session.isDirty, true);
  assert.deepEqual(session.current, original);
  session.close(); assert.equal(session.edit({ type: 'doc', content: [p('迟到输入')] }), null);
  assert.deepEqual(session.current, original);
});

test('undo can restore a removed image without exporting unreferenced resources', () => {
  const original = value([p(), imageNode()], [asset()]), session = new RichNoteSession(original);
  const removed = session.edit({ type: 'doc', content: [p()] })!; assert.equal(removed.assets.length, 0);
  session.receive(removed);
  const restored = session.edit(original.document)!;
  assert.equal(restored.assets.length, 1); assert.equal(restored.assets[0].sha256, digest);
  assert.deepEqual(validateRichNoteData(restored), restored);
});

test('image pool decodes before revealing any URL and revokes each owned URL on close', async () => {
  const pending = deferred<{ width: number; height: number }>(), env = runtime(() => pending.promise), pool = new RichNoteImagePool(env.implementation);
  const result = pool.replace([asset()]); assert.equal(pool.get(digest), undefined);
  pending.resolve({ width: 1, height: 1 }); assert.equal(await result, true);
  assert.equal(pool.get(digest), env.created[0]); pool.close(); pool.close();
  assert.deepEqual(env.revoked, env.created); assert.equal(pool.get(digest), undefined);
});

test('replacement and close fence late decode even if an injected decoder ignores abort', async () => {
  const pending = deferred<{ width: number; height: number }>(), env = runtime(() => pending.promise), pool = new RichNoteImagePool(env.implementation);
  const old = pool.replace([asset()]); const newer = pool.replace([]);
  assert.deepEqual(env.revoked, env.created); assert.equal(await newer, true);
  pool.close(); pending.resolve({ width: 1, height: 1 }); assert.equal(await old, false);
  assert.equal(pool.get(digest), undefined); assert.deepEqual(env.revoked, env.created);
  assert.equal(await pool.replace([asset()]), false);
});

test('bad decode dimensions and decode failures cannot become valid image views', async () => {
  for (const decode of [async () => ({ width: 2, height: 1 }), async () => { throw new Error('C:/private/secret'); }]) {
    const env = runtime(decode), pool = new RichNoteImagePool(env.implementation);
    await assert.rejects(pool.replace([asset()]), (error: unknown) => error instanceof RichNoteImageError && error.message === 'RICH_IMAGE_UNAVAILABLE');
    assert.equal(pool.get(digest), undefined); assert.deepEqual(env.revoked, env.created); pool.close();
  }
});

test('local image import hashes actual bounded bytes and checks actual decoder dimensions', async () => {
  const env = runtime(), controller = new AbortController();
  const result = await readRichNoteImage(new Blob([png]), controller.signal, env.implementation);
  assert.deepEqual(result, asset()); assert.deepEqual(env.created, env.revoked);
  await assert.rejects(readRichNoteImage(new Blob([Buffer.from('private')]), controller.signal, env.implementation), RichNoteImageError);
  await assert.rejects(readRichNoteImage(new Blob([new Uint8Array(524_289)]), controller.signal, env.implementation), RichNoteImageError);
  const mismatch = runtime(async () => ({ width: 0, height: 0 }));
  await assert.rejects(readRichNoteImage(new Blob([png]), controller.signal, mismatch.implementation), RichNoteImageError);
  assert.deepEqual(mismatch.created, mismatch.revoked);
});

test('aborted local image imports immediately revoke URLs and never return a late resource', async () => {
  const pending = deferred<{ width: number; height: number }>(), env = runtime(() => pending.promise), controller = new AbortController();
  const result = readRichNoteImage(new Blob([png]), controller.signal, env.implementation);
  while (!env.created.length) await new Promise<void>((done) => setImmediate(done));
  controller.abort(); assert.deepEqual(env.created, env.revoked);
  pending.resolve({ width: 1, height: 1 }); await assert.rejects(result, RichNoteImageError);
  assert.deepEqual(env.created, env.revoked);
});

test('actual extensions preserve custom attrs and schema changes only the edited text', () => {
  const original = value([p('开头'), { type: 'noteComponentBlock', attrs: { title: '组件', variant: 'note' }, content: [p('内部')] },
    { type: 'blockMath', attrs: { latex: 'x^2' } }, imageNode()], [asset()]);
  const pool = new RichNoteImagePool(runtime().implementation);
  const extensions = createRichNoteExtensions({ images: pool, metadata: () => original.metadata });
  const schema = getSchema(extensions); const model = schema.nodeFromJSON(original.document); model.check();
  const actual = new Editor({ element: null, extensions, content: original.document, injectCSS: false });
  try {
    const before = actual.getJSON(); actual.view.dispatch(actual.state.tr.insertText('新', 2));
    const next = createRichNoteData({ paperId: null, title: original.title, document: actual.getJSON(), metadata: original.metadata, assets: original.assets });
    assert.deepEqual(next.document.content!.slice(1), JSON.parse(JSON.stringify(before.content!.slice(1))));
    assert.match(next.body, /新/);
    assert.equal(RICH_NOTE_MATH_OPTIONS.trust, false); assert.equal(RICH_NOTE_MATH_OPTIONS.maxExpand, 100);
  } finally { actual.destroy(); pool.close(); }
});

test('actual table commands merge/split cells and retain rich cell math', () => {
  const original = value([{ type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [100], align: 'left' }, content: [p('A')] },
    { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [100], align: null }, content: [{ type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: 'x_i' } }] }] },
  ] }] }]);
  const pool = new RichNoteImagePool(runtime().implementation), actual = new Editor({ element: null, content: original.document, injectCSS: false,
    extensions: createRichNoteExtensions({ images: pool, metadata: () => original.metadata }) });
  try {
    const cells: number[] = []; actual.state.doc.descendants((node, pos) => { if (node.type.name === 'tableCell') cells.push(pos); });
    actual.view.dispatch(actual.state.tr.setSelection(CellSelection.create(actual.state.doc, cells[0], cells[1])));
    assert.equal(actual.commands.mergeCells(), true);
    const merged = createRichNoteData({ paperId: original.paperId, title: original.title, document: actual.getJSON(), metadata: original.metadata, assets: [] });
    assert.equal(merged.document.content![0].content![0].content![0].attrs!.colspan, 2); assert.match(merged.body, /x_i/);
    assert.equal(actual.commands.splitCell(), true);
    assert.equal(actual.state.doc.firstChild!.firstChild!.childCount, 2);
  } finally { actual.destroy(); pool.close(); }
});

test('preview escapes arbitrary text/attrs, preserves merged tables and does not request images', () => {
  const original = value([p('<img src="https://outside.invalid/private">'), { type: 'blockMath', attrs: { latex: '\\href{javascript:alert(1)}{x}' } },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [100, 100], align: 'center' }, content: [p('跨列')] }] }] }, imageNode()], [asset()]);
  const markup = renderToStaticMarkup(createElement(RichNotePreview, { value: original }));
  assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img[^>]+src=/);
  assert.match(markup, /colSpan="2"|colspan="2"/); assert.match(markup, /跨列/);
  assert.doesNotMatch(markup, /dangerouslySetInnerHTML/); assert.match(markup, /图片正在校验/);
});

test('React preview validates without emitting normalization and rejects invalid input as a whole', async () => {
  const original = value(), snapshot = JSON.stringify(original), changes: RichNoteData[] = [], validity: boolean[] = [], dirty: boolean[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(RichNoteEditor, { value: original, readOnly: true, sessionKey: 'accountA:note', onChange: (next) => changes.push(next), onValidityChange: (valid) => validity.push(valid), onDirtyChange: (next) => dirty.push(next) })); });
  await tick(); assert.equal(changes.length, 0); assert.equal(dirty.length, 0); assert.equal(validity.at(-1), true); assert.equal(JSON.stringify(original), snapshot);
  await act(async () => { renderer.update(createElement(RichNoteEditor, { value: { ...original, body: 'bad' }, readOnly: true, sessionKey: 'accountB:note', onChange: (next) => changes.push(next), onValidityChange: (valid) => validity.push(valid), onDirtyChange: (next) => dirty.push(next) })); });
  await tick(); assert.equal(validity.at(-1), false); assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1);
  assert.equal(changes.length, 0); act(() => renderer.unmount());
  assert.deepEqual(dirty, [false]);
});

test('React account replacement revokes pending image views and ignores the old decode callback', async (t) => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL, created: string[] = [], revoked: string[] = [], instances: FakeImage[] = [];
  class FakeImage {
    naturalWidth = 1; naturalHeight = 1; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_url: string) { instances.push(this); }
    removeAttribute(_key: string) {}
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: FakeImage });
  URL.createObjectURL = () => { const url = `blob:react-${created.length}`; created.push(url); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  let renderer: ReactTestRenderer | undefined;
  t.after(() => { if (renderer) act(() => renderer!.unmount()); URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
    if (prior) Object.defineProperty(globalThis, 'Image', prior); else Reflect.deleteProperty(globalThis, 'Image'); });
  const events: string[] = [], changes: RichNoteData[] = [];
  await act(async () => { renderer = create(createElement(RichNoteEditor, { value: value([p('账号A'), imageNode()], [asset()]), readOnly: true, sessionKey: 'A:note',
    onChange: (next) => changes.push(next), onValidityChange: (valid) => events.push(`A:${valid}`) })); });
  assert.equal(instances.length, 1); const late = instances[0].onload!;
  await act(async () => { renderer!.update(createElement(RichNoteEditor, { value: value([p('账号B')]), readOnly: true, sessionKey: 'B:note',
    onChange: (next) => changes.push(next), onValidityChange: (valid) => events.push(`B:${valid}`) })); });
  await tick(); assert.deepEqual(revoked, created); assert.equal(events.at(-1), 'B:true');
  const count = events.length; await act(async () => { late(); }); await tick();
  assert.equal(events.length, count); assert.deepEqual(changes, []);
  assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /账号A|blob:react/);
});
