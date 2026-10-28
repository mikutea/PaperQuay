import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { createAccountState, type LocalEdit, type VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import { createRichNoteData, type RichNoteData } from '../../../packages/sync-core/src/richNote.ts';
import { EntityEditor, ContentPreview } from '../src/components/EntityEditor.tsx';
import { RichNoteEditor, RichNotePreview } from '../src/components/RichNoteEditor.tsx';
import { ClientError } from '../src/errors.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', NOTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const text = (node: ReactTestInstance | string | number): string => typeof node === 'object' ? node.children.map(text).join('') : String(node);
const tick = async () => { await act(async () => { await new Promise<void>((done) => setImmediate(done)); }); };
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < deadline); await tick(); } }
function rich(body = '完整正文'): RichNoteData {
  return createRichNoteData({ paperId: null, title: '结构标题', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body, marks: [{ type: 'bold' }] }] },
    { type: 'blockMath', attrs: { latex: 'E=mc^2' } }, { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [120, 130], align: 'center' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '合并表格' }] }] },
    ] }] }] }, assets: [], metadata: { type: 'standalone', anchors: [], tags: ['中文'], color: '#fef08a', isFavorite: true, isPinned: false,
      linkedNoteIds: [], linkedPaperIds: [], createdAt: 100, updatedAt: 200, unresolvedReferences: [] } });
}
function entity(data: RichNoteData | { paperId: null; title: string; body: string; format: 'markdown' } = rich()): VisibleEntity {
  return { entityType: 'note', entityId: NOTE, revision: 2, deleted: false, pending: false, status: 'synced', data };
}
function gate() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function setup(t: TestContext, initial: VisibleEntity | null = entity(), enabled = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = Object.assign(new EventTarget(), { confirm: () => true });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  const snapshot: WorkspaceSnapshot = { status: 'ready', identity: null,
    workspace: { sync: createAccountState(ACCOUNT, DEVICE), pendingResolutions: {}, richNotesVersion: 1 }, syncing: false, online: true,
    needsLogin: false, devices: [], conflicts: [], lastSyncedAt: null, error: null };
  const calls: { edit: LocalEdit; revision?: number; wait: ReturnType<typeof gate> }[] = [], dirty: boolean[] = [];
  const controller = { getSnapshot: () => snapshot, save: async (edit: LocalEdit, revision?: number) => {
    const call = { edit: structuredClone(edit), revision, wait: gate() }; calls.push(call); await call.wait.promise;
  } };
  let props: ComponentProps<typeof EntityEditor> = { type: 'note', entityId: NOTE, entity: initial, controller, papers: [], hasConflict: false,
    onBack() {}, onConflicts() {}, onDirty: (value) => dirty.push(value), richNotesEnabled: enabled, accountSessionKey: 'https://sync.example.test:A' };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(EntityEditor, props)); }); await tick();
  t.after(() => { act(() => renderer.unmount()); for (const call of calls) call.wait.resolve();
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const button = (label: string) => { const found = renderer.root.findAllByType('button').find((entry) => text(entry) === label); assert.ok(found, label); return found; };
  const child = () => renderer.root.findByType(RichNoteEditor);
  const update = async (change: Partial<ComponentProps<typeof EntityEditor>>) => { props = { ...props, ...change }; await act(async () => { renderer.update(createElement(EntityEditor, props)); }); await tick(); };
  return { renderer, calls, dirty, child, button, browser, update,
    save: async () => { await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); }); },
    ready: async () => { await until(() => renderer.root.findAllByType(RichNoteEditor).length === 1); act(() => child().props.onValidityChange(true)); },
  };
}

test('only a blank new note can actively choose rich format and unsupported capability blocks it', async (t) => {
  const ui = await setup(t, null, false);
  assert.equal(ui.button('结构笔记').props.disabled, true);
  act(() => ui.button('结构笔记').props.onClick()); assert.equal(ui.renderer.root.findAllByType(RichNoteEditor).length, 0);
  await ui.update({ richNotesEnabled: true });
  const oldMarkdownChange = ui.renderer.root.findByProps({ id: 'note-body' }).props.onChange;
  act(() => ui.button('结构笔记').props.onClick()); await ui.ready();
  assert.equal(ui.child().props.value.format, 'tiptap-json'); assert.equal(ui.calls.length, 0);
  act(() => oldMarkdownChange({ target: { value: '迟到 Markdown 正文' } }));
  assert.equal(ui.child().props.value.body, ''); assert.equal(ui.calls.length, 0);
});

test('existing Markdown stays Markdown and saves the original syntax without rich conversion', async (t) => {
  const body = '**bold** $x$ ![image](https://example.test/a.png)', ui = await setup(t, entity({ paperId: null, title: 'Markdown', body, format: 'markdown' }));
  assert.equal(ui.renderer.root.findAllByType(RichNoteEditor).length, 0);
  assert.equal(ui.renderer.root.findByProps({ id: 'note-body' }).props.value, body);
  act(() => ui.renderer.root.findByProps({ id: 'note-body' }).props.onChange({ target: { value: `${body}\nnew` } })); await ui.save();
  assert.equal((ui.calls[0].edit.data as { format: string }).format, 'markdown');
  assert.equal('body' in ui.calls[0].edit.data! ? ui.calls[0].edit.data.body : '', `${body}\nnew`);
});

test('rich save retains the full AST, marks, merged table, tags and timestamps', async (t) => {
  const original = rich(), ui = await setup(t, entity(original)); await ui.ready();
  const next = rich('实际新正文');
  act(() => { ui.child().props.onDirtyChange(true); ui.child().props.onChange(next); });
  await ui.save(); assert.equal(ui.calls.length, 1);
  const saved = ui.calls[0].edit.data as RichNoteData;
  assert.equal(saved.format, 'tiptap-json'); assert.deepEqual(saved.document, next.document); assert.deepEqual(saved.metadata.tags, ['中文']);
  assert.equal(saved.metadata.createdAt, original.metadata.createdAt); assert.ok(saved.metadata.updatedAt > original.metadata.updatedAt);
  assert.equal(ui.calls[0].revision, 2); assert.deepEqual(original, rich());
});

test('invalid un-emitted rich drafts block manual, background and automatic save and preview', async (t) => {
  const ui = await setup(t); await ui.ready();
  act(() => { ui.child().props.onDirtyChange(true); ui.child().props.onValidityChange(false); });
  assert.equal(ui.button('保存').props.disabled, true); assert.equal(ui.button('预览').props.disabled, true); assert.equal(ui.dirty.at(-1), true);
  await ui.save(); act(() => { ui.browser.dispatchEvent(new Event('pagehide')); });
  await act(async () => { await new Promise((done) => setTimeout(done, 650)); });
  assert.equal(ui.calls.length, 0); assert.equal(ui.renderer.root.findAllByType(RichNoteEditor).length, 1);
  assert.equal(ui.child().props.readOnly, undefined);
});

test('an earlier autosave completion cannot clear a later invalid rich draft', async (t) => {
  const ui = await setup(t); await ui.ready();
  act(() => { ui.child().props.onDirtyChange(true); ui.child().props.onChange(rich('先前有效正文')); });
  await act(async () => { await new Promise((done) => setTimeout(done, 650)); }); assert.equal(ui.calls.length, 1);
  assert.equal(ui.renderer.root.findByType('fieldset').props.disabled, false);
  act(() => { ui.child().props.onDirtyChange(true); ui.child().props.onValidityChange(false); });
  await act(async () => { ui.calls[0].wait.resolve(); });
  assert.equal(ui.dirty.at(-1), true); assert.equal(ui.button('保存').props.disabled, true);
  assert.match(ui.child().props.value.body, /先前有效正文/);
  act(() => { ui.browser.dispatchEvent(new Event('pagehide')); }); assert.equal(ui.calls.length, 1);
});

test('valid controlled echoes do not declare persistence; the writer remains mounted while previewing', async (t) => {
  const ui = await setup(t); await ui.ready(); const current = rich('未保存修改');
  act(() => { ui.child().props.onDirtyChange(true); ui.child().props.onChange(current); });
  assert.equal(ui.dirty.at(-1), true);
  act(() => ui.button('预览').props.onClick()); await tick();
  assert.equal(ui.renderer.root.findAllByType(RichNoteEditor).length, 1); assert.equal(ui.child().props.disabled, true);
  assert.equal(ui.renderer.root.findAllByType(RichNotePreview).length, 1);
  act(() => ui.button('编辑').props.onClick()); assert.equal(ui.child().props.disabled, false); assert.equal(ui.dirty.at(-1), true);
});

test('account/session replacement rejects old rich callbacks and old persistence acknowledgements', async (t) => {
  const ui = await setup(t); await ui.ready();
  act(() => { ui.child().props.onDirtyChange(true); ui.child().props.onChange(rich('账号A草稿')); }); await ui.save();
  const old = ui.child().props; const replacement = rich('账号B正文'); replacement.title = '账号B标题';
  await ui.update({ entity: entity(replacement), accountSessionKey: 'https://sync.example.test:B' }); await ui.ready();
  const before = [...ui.dirty];
  act(() => { old.onDirtyChange(true); old.onValidityChange(true); old.onChange(rich('迟到A正文')); });
  await act(async () => { ui.calls[0].wait.reject(new ClientError('STORAGE_UNAVAILABLE')); });
  assert.equal(ui.child().props.value.title, '账号B标题'); assert.match(ui.child().props.value.body, /账号B正文/);
  assert.deepEqual(ui.dirty, before); assert.equal(ui.renderer.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('capability loss disables rich writing and blocks retained callbacks and save', async (t) => {
  const ui = await setup(t); await ui.ready(); const old = ui.child().props;
  await ui.update({ richNotesEnabled: false });
  assert.equal(ui.child().props.disabled, true); assert.equal(ui.renderer.root.findByType('fieldset').props.disabled, true);
  act(() => { old.onDirtyChange(true); old.onChange(rich('不应写入')); }); await ui.save();
  assert.equal(ui.calls.length, 0); assert.match(ui.child().props.value.body, /完整正文/);
});

test('conflict ContentPreview renders full rich structures rather than derived plain body', async (t) => {
  const original = rich(); let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ContentPreview, { data: original, sessionKey: 'account:conflict:2' })); });
  t.after(() => act(() => renderer.unmount())); await until(() => renderer.root.findAllByType(RichNotePreview).length === 1); await tick();
  assert.equal(renderer.root.findAllByType('table').length, 1); assert.equal(renderer.root.findAllByType('th')[0].props.colSpan, 2);
  assert.equal(renderer.root.findAllByType('strong').length, 1); assert.match(text(renderer.root), /E=mc\^2/);
  assert.deepEqual(renderer.root.findByType(RichNotePreview).props.value.document, original.document);
  assert.equal(renderer.root.findAllByProps({ className: 'content-preview' }).length, 0);
});
