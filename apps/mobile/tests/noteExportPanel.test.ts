import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { AnnotationData, AttachmentVersionData, EntityData, NoteData, PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import { createRichNoteData } from '../../../packages/sync-core/src/richNote.ts';
import { NoteExportPanel, type NoteExportPanelProps } from '../src/components/NoteExportPanel.tsx';
import { buildReadingExport, parseReadingExport } from '../src/library/readingExport.ts';
import { exportPaperQuayCitations } from '../src/library/citationTransfer.ts';
import type { ExportRuntime, TextFileExport } from '../src/platform/exportFile.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const rawBody = '# 原始正文\r\n\n<script>private source</script>\n![remote](https://outside.invalid/image.png)\n尾行  ';
function visible(entityType: VisibleEntity['entityType'], n: number, data: EntityData): VisibleEntity {
  return { entityType, entityId: id(n), data, deleted: false, revision: 1, pending: false, status: 'synced' };
}
function fixture(): VisibleEntity[] {
  const paper = (title: string, tag: string): PaperData => ({ title, doi: null, year: '2026', publication: 'Journal',
    authors: ['Stored Author'], abstractText: null, keywords: [], organization: { favorite: false, readingStatus: 'unread',
      tags: [tag], collections: [], queueRank: null } });
  const version = (hash: string): AttachmentVersionData => ({ paperId: id(1), attachmentId: id(100), sha256: hash.repeat(64),
    sizeBytes: 2048, mediaType: 'application/pdf', fileName: `${hash}.pdf`, pageCount: 4 });
  const note = (paperId: string | null, body: string): NoteData => ({ paperId, title: 'Saved reading note', format: 'markdown', body });
  const annotation = (attachmentVersionId: string, comment: string): AnnotationData => ({ paperId: id(1), attachmentVersionId,
    kind: 'highlight', color: '#ffcc00', comment, anchor: { pageIndex: 2,
      coordinateSpace: 'pdf-crop-box-unrotated-normalized', quads: [[0.1, 0.2, 0.5, 0.2, 0.5, 0.3, 0.1, 0.3]], quote: null } });
  return [visible('paper', 1, paper('Study one', '方法')), visible('paper', 2, paper('Study two', '综述')),
    visible('attachmentVersion', 11, version('a')), visible('attachmentVersion', 12, version('b')),
    visible('note', 21, note(id(1), rawBody)), visible('note', 22, note(null, 'Independent note')),
    visible('note', 23, note(id(2), 'Other saved paper note')),
    visible('annotation', 31, annotation(id(11), 'First version comment')),
    visible('annotation', 32, annotation(id(12), 'Second version comment'))];
}
function runtime(overrides: Partial<ExportRuntime> = {}) {
  const calls = { available: 0, canShare: 0, downloads: [] as TextFileExport[], writes: [] as { path: string; text: string }[],
    shares: [] as string[], removed: [] as string[] };
  const platform: ExportRuntime = { native: false,
    available: () => { calls.available++; return true; }, canShare: async () => { calls.canShare++; return true; },
    write: async (path, text) => { calls.writes.push({ path, text }); return `file:///cache/${path}`; },
    share: async (uri) => { calls.shares.push(uri); }, remove: async (path) => { calls.removed.push(path); },
    download: (file) => { calls.downloads.push(file); }, id: () => 'export-fixture', ...overrides };
  return { platform, calls };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
const flush = async () => { await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); }); };
async function setup(t: TestContext, change: Partial<NoteExportPanelProps> = {}, adapter = runtime()) {
  const busy: boolean[] = []; let active = true, disposed = false;
  let props: NoteExportPanelProps = { entities: fixture(), scopeKey: 'account-one-generation-one', accountCurrent: () => active,
    onBusyChange: value => busy.push(value), exportRuntime: adapter.platform, ...change };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(NoteExportPanel, props)); });
  const button = (label: string) => { const node = view.root.findAllByType('button').find(node => text(node) === label);
    assert.ok(node, `Missing button: ${label}`); return node; };
  const click = async (label: string) => { await act(async () => { button(label).props.onClick(); }); };
  // Resolve controls by the rendered label's for/id relationship rather than React's generated ID spelling.
  const control = (label: string) => { const node = view.root.findAllByType('label').find(node => text(node) === label);
    assert.ok(node, `Missing label: ${label}`);
    return node.props.htmlFor ? view.root.findAll(node2 => node2.props.id === node.props.htmlFor)[0] : node.findByType('input'); };
  const select = async (label: string, value: string) => { await act(async () => { control(label).props.onChange({ target: { value } }); }); };
  const toggle = async (label: string, checked: boolean) => { await act(async () => { control(label).props.onChange({ target: { checked } }); }); };
  const update = async (next: Partial<NoteExportPanelProps>) => { props = { ...props, ...next };
    await act(async () => { view.update(createElement(NoteExportPanel, props)); }); };
  const unmount = async () => { if (!disposed) { disposed = true; await act(async () => { view.unmount(); }); } };
  t.after(unmount);
  return { view, busy, button, click, control, select, toggle, update, unmount, ...adapter, signOut: () => { active = false; } };
}

test('preview and filtering are inert; each explicit web export keeps the saved text and rendered source scope', async t => {
  const ui = await setup(t);
  assert.deepEqual(structuredClone(ui.calls), { available: 0, canShare: 0, downloads: [], writes: [], shares: [], removed: [] });
  assert.equal(ui.view.root.findAllByType('img').length, 0); assert.equal(ui.view.root.findAllByType('script').length, 0);
  assert.match(text(ui.view.root), /3 条笔记 · 2 条批注/);
  await ui.select('文献范围', id(1)); await ui.select('批注的 PDF 版本', id(12));
  assert.equal(ui.calls.downloads.length, 0); assert.deepEqual(ui.busy, []);
  await ui.click('导出阅读汇总 Markdown');
  const expected = buildReadingExport(fixture(), { paperId: id(1), attachmentVersionId: id(12) });
  assert.deepEqual(ui.calls.downloads[0], { name: 'PaperQuay-阅读汇总.md', mime: 'text/markdown', text: expected.markdown });
  assert.match(text(ui.view.root), /已开始下载/);
  await ui.click('导出阅读汇总 JSON');
  const archive = parseReadingExport(ui.calls.downloads[1].text);
  assert.equal(archive.notes[0].body, rawBody); assert.equal(archive.notes.length, 1);
  assert.equal(archive.annotations.length, 1); assert.equal(archive.annotations[0].comment, 'Second version comment');
  assert.equal(archive.versions[0].data!.sha256, 'b'.repeat(64));
  await ui.select('检索笔记与批注内容', 'does not exist');
  assert.equal(ui.button('导出阅读汇总 Markdown').props.disabled, true);
  assert.equal(ui.button('导出 PaperQuay 编号引用').props.disabled, false);
  await ui.click('导出 PaperQuay 编号引用');
  assert.equal(ui.calls.downloads[2].text, exportPaperQuayCitations(fixture(), [id(1)]).markdown);
  assert.deepEqual(ui.busy, [true, false, true, false, true, false]);
});

test('tag and category choices apply only after an explicit click and account scopes clear private filters', async t => {
  const ui = await setup(t);
  await ui.select('关联文献标签', '方法'); await ui.select('检索笔记与批注内容', 'First version');
  await ui.toggle('包含笔记（Markdown 与富文本）', false);
  assert.equal(ui.calls.downloads.length, 0);
  await ui.click('导出阅读汇总 JSON');
  const archive = parseReadingExport(ui.calls.downloads[0].text);
  assert.equal(archive.notes.length, 0); assert.equal(archive.annotations.length, 1);
  assert.equal(archive.scope.paperTag, '方法'); assert.equal(archive.scope.includeStandalone, false);
  await ui.update({ scopeKey: 'account-two-generation-one', entities: [] });
  assert.equal(ui.control('关联文献标签').props.value, ''); assert.equal(ui.control('检索笔记与批注内容').props.value, '');
  assert.equal(ui.control('包含笔记（Markdown 与富文本）').props.checked, true);
  assert.doesNotMatch(text(ui.view.root), /已开始下载|First version/);
  assert.equal(ui.button('导出阅读汇总 JSON').props.disabled, true);
  await ui.click('导出阅读汇总 JSON'); assert.equal(ui.calls.downloads.length, 1);
});

test('rich-note export is explicit and discloses v2 structures while narrower scopes retain the v1 format', async t => {
  const source = fixture();
  const rich = createRichNoteData({ paperId: id(1), title: 'Rich saved note',
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep rich structure', marks: [{ type: 'bold' }] }] }] },
    metadata: { type: 'standalone', anchors: [], tags: [], color: '#fef08a', isFavorite: false, isPinned: false,
      linkedNoteIds: [], linkedPaperIds: [], createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, unresolvedReferences: [] }, assets: [] });
  source[4] = visible('note', 21, rich);
  const before = structuredClone(source), ui = await setup(t, { entities: source });
  assert.match(text(ui.view.root), /阅读汇总 JSON v2/); assert.match(text(ui.view.root), /原始文献、笔记等引用标识保留/);
  assert.equal(ui.button('导出阅读汇总 JSON').props.disabled, false); assert.equal(ui.calls.downloads.length, 0);
  await ui.click('导出阅读汇总 JSON');
  const complete = parseReadingExport(ui.calls.downloads[0].text), saved = complete.notes.find(note => note.format === 'tiptap-json');
  assert.equal(complete.version, 2); assert.ok(saved && saved.format === 'tiptap-json');
  assert.deepEqual(saved.document, rich.document); assert.deepEqual(saved.metadata, rich.metadata); assert.deepEqual(saved.assets, rich.assets);
  await ui.toggle('包含笔记（Markdown 与富文本）', false); await ui.click('导出阅读汇总 JSON');
  const archive = parseReadingExport(ui.calls.downloads[1].text);
  assert.equal(archive.version, 1);
  assert.equal(archive.notes.length, 0); assert.equal(archive.annotations.length, 2);
  assert.doesNotMatch(ui.calls.downloads[1].text, /Keep rich structure/);
  await ui.toggle('包含笔记（Markdown 与富文本）', true); await ui.select('文献范围', id(2));
  await ui.click('导出阅读汇总 JSON');
  assert.equal(parseReadingExport(ui.calls.downloads[2].text).notes[0].body, 'Other saved paper note');
  assert.deepEqual(source, before);
});

test('old click callbacks cannot export a superseded preview even after the selection returns to the same content', async t => {
  const ui = await setup(t), oldClick = ui.button('导出阅读汇总 JSON').props.onClick;
  await ui.select('文献范围', id(1)); await ui.select('文献范围', '');
  await act(async () => { oldClick(); });
  assert.equal(ui.calls.downloads.length, 0); assert.match(text(ui.view.root), /本次导出已取消/);
  await ui.click('导出阅读汇总 JSON'); assert.equal(ui.calls.downloads.length, 1);
  const previousScopeClick = ui.button('导出 PaperQuay 编号引用').props.onClick;
  await ui.update({ scopeKey: 'account-two-generation-one', entities: [] });
  await act(async () => { previousScopeClick(); });
  assert.equal(ui.calls.downloads.length, 1); assert.doesNotMatch(text(ui.view.root), /本次导出已取消|已开始下载/);
});

test('duplicate native clicks share once and a successful share is described without claiming a saved file', async t => {
  const gate = deferred<boolean>(), adapter = runtime({ native: true });
  adapter.platform.canShare = async () => { adapter.calls.canShare++; return gate.promise; };
  const ui = await setup(t, {}, adapter), handler = ui.button('导出阅读汇总 Markdown').props.onClick;
  await act(async () => { handler(); handler(); });
  assert.equal(ui.calls.canShare, 1); assert.equal(ui.button('导出阅读汇总 Markdown').props.disabled, true);
  assert.equal(ui.control('文献范围').props.disabled, true);
  await act(async () => { gate.resolve(true); }); await flush();
  assert.equal(ui.calls.writes.length, 1); assert.equal(ui.calls.shares.length, 1); assert.deepEqual(ui.calls.removed, []);
  assert.equal(ui.calls.writes[0].text, buildReadingExport(fixture()).markdown);
  assert.match(text(ui.view.root), /系统分享面板已关闭；保存结果请在所选应用中确认/);
  assert.deepEqual(ui.busy, [true, false]);
});

test('a scope switch while native availability is pending prevents writing or sharing the previous account', async t => {
  const gate = deferred<boolean>(), adapter = runtime({ native: true });
  adapter.platform.canShare = async () => { adapter.calls.canShare++; return gate.promise; };
  const ui = await setup(t, {}, adapter);
  await ui.click('导出阅读汇总 JSON');
  await ui.update({ scopeKey: 'account-two-generation-one', entities: [] });
  await act(async () => { gate.resolve(true); }); await flush();
  assert.equal(ui.calls.writes.length, 0); assert.equal(ui.calls.shares.length, 0); assert.equal(ui.calls.removed.length, 0);
  assert.doesNotMatch(text(ui.view.root), /private source|已关闭|已开始下载|本次导出已取消/);
  assert.deepEqual(ui.busy, [true, false]);
});

test('sign-out during native file preparation removes the temporary file without sharing or a late status', async t => {
  const gate = deferred<string>(), adapter = runtime({ native: true });
  adapter.platform.write = async (path, text) => { adapter.calls.writes.push({ path, text }); return gate.promise; };
  const ui = await setup(t, {}, adapter);
  await ui.click('导出阅读汇总 JSON'); assert.equal(ui.calls.writes.length, 1);
  ui.signOut(); await act(async () => { gate.resolve('file:///cache/late.json'); }); await flush();
  assert.equal(ui.calls.shares.length, 0); assert.deepEqual(ui.calls.removed, [ui.calls.writes[0].path]);
  assert.equal(ui.view.root.findAllByProps({ role: 'status' }).length, 0);
  assert.equal(ui.view.root.findAllByProps({ role: 'alert' }).length, 0);
  await ui.click('导出阅读汇总 JSON'); assert.equal(ui.calls.writes.length, 1);
});

test('a changed saved preview retires native preparation, including a later return to the original revision', async t => {
  const gate = deferred<string>(), adapter = runtime({ native: true });
  adapter.platform.write = async (path, text) => { adapter.calls.writes.push({ path, text }); return gate.promise; };
  const ui = await setup(t, {}, adapter);
  await ui.click('导出阅读汇总 JSON');
  const changed = fixture(); changed[4] = { ...changed[4], revision: 2,
    data: { ...(changed[4].data as NoteData), body: 'New saved preview' } as NoteData };
  await ui.update({ entities: changed }); await ui.update({ entities: fixture() });
  await act(async () => { gate.resolve('file:///cache/late.json'); }); await flush();
  assert.equal(ui.calls.shares.length, 0); assert.deepEqual(ui.calls.removed, [ui.calls.writes[0].path]);
  assert.match(text(ui.view.root), /本次导出已取消/);
  assert.equal(ui.button('导出阅读汇总 JSON').props.disabled, false);
});

test('citation preparation remains valid when only unrelated saved note content changes', async t => {
  const gate = deferred<boolean>(), adapter = runtime({ native: true });
  adapter.platform.canShare = async () => { adapter.calls.canShare++; return gate.promise; };
  const ui = await setup(t, {}, adapter);
  await ui.click('导出 PaperQuay 编号引用');
  const changed = fixture(); changed[4] = { ...changed[4], revision: 2,
    data: { ...(changed[4].data as NoteData), body: 'New saved preview' } as NoteData };
  await ui.update({ entities: changed });
  await act(async () => { gate.resolve(true); }); await flush();
  assert.equal(ui.calls.shares.length, 1); assert.equal(ui.calls.writes[0].text, exportPaperQuayCitations(fixture(), [id(1), id(2)]).markdown);
  assert.match(text(ui.view.root), /系统分享面板已关闭/);
});

test('a stale native share failure cannot overwrite a changed reading preview with a previous failure', async t => {
  const gate = deferred<void>(), adapter = runtime({ native: true });
  adapter.platform.share = async uri => { adapter.calls.shares.push(uri); return gate.promise; };
  const ui = await setup(t, {}, adapter);
  await ui.click('导出阅读汇总 JSON'); assert.equal(ui.calls.shares.length, 1);
  const changed = fixture(); changed[4] = { ...changed[4], revision: 2,
    data: { ...(changed[4].data as NoteData), body: 'New saved preview' } as NoteData };
  await ui.update({ entities: changed });
  await act(async () => { gate.reject(new Error('private plugin failure')); }); await flush();
  assert.equal(ui.view.root.findAllByProps({ role: 'alert' }).length, 0);
  assert.equal(ui.view.root.findAllByProps({ role: 'status' }).length, 0);
  assert.match(text(ui.view.root), /New saved preview/); assert.equal(ui.calls.removed.length, 0);
});

test('late share success does not reappear after an account switch and returning to the same scope key', async t => {
  const gate = deferred<void>(), adapter = runtime({ native: true });
  adapter.platform.share = async uri => { adapter.calls.shares.push(uri); return gate.promise; };
  const ui = await setup(t, {}, adapter);
  await ui.click('导出阅读汇总 JSON');
  await ui.update({ scopeKey: 'account-two-generation-one', entities: [] });
  await ui.update({ scopeKey: 'account-one-generation-one', entities: fixture() });
  await act(async () => { gate.resolve(); }); await flush();
  assert.equal(ui.view.root.findAllByProps({ role: 'status' }).length, 0);
  assert.equal(ui.calls.shares.length, 1); assert.equal(ui.calls.removed.length, 0);
});

test('unmount retires pending native preparation and no late busy notification escapes the component', async t => {
  const gate = deferred<string>(), adapter = runtime({ native: true });
  adapter.platform.write = async (path, text) => { adapter.calls.writes.push({ path, text }); return gate.promise; };
  const ui = await setup(t, {}, adapter);
  await ui.click('导出阅读汇总 Markdown'); await ui.unmount();
  assert.deepEqual(ui.busy, [true, false]);
  await act(async () => { gate.resolve('file:///cache/late.md'); }); await flush();
  assert.deepEqual(ui.busy, [true, false]); assert.equal(ui.calls.shares.length, 0);
  assert.deepEqual(ui.calls.removed, [ui.calls.writes[0].path]);
});

test('current native failures show a bounded message without plugin details or changing saved records', async t => {
  const source = fixture(), before = structuredClone(source), adapter = runtime({ native: true,
    write: async () => { throw new Error('private plugin path and credentials'); } });
  const ui = await setup(t, { entities: source }, adapter);
  await ui.click('导出阅读汇总 JSON'); await flush();
  assert.match(text(ui.view.root), /文件准备或分享失败/);
  assert.doesNotMatch(text(ui.view.root), /private plugin path and credentials/);
  assert.deepEqual(source, before); assert.equal(ui.calls.shares.length, 0);
  assert.equal(ui.button('导出阅读汇总 JSON').props.disabled, false);
});
