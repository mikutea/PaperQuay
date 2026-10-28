import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import { AiArchivePanel, type AiArchivePanelProps } from '../src/components/AiArchivePanel.tsx';
import { WebAiArchiveStore } from '../src/ai/archiveStore.ts';
import { AiArchiveError, createAiHistoryRecord, createAiQuestionTemplate, deriveAiHistoryResult, type AiHistoryRecord } from '../src/ai/archiveTypes.ts';
import type { PdfCitationTarget } from '../src/ai/types.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { apiBaseUrl: 'https://sync.example.invalid', accountId: id(1) };
function record(): AiHistoryRecord {
  return { kind: 'record', version: 1, id: id(2), revision: 1,
    createdAt: '2026-10-28T12:00:00.000Z', updatedAt: '2026-10-28T12:00:01.000Z',
    context: { paperId: id(3), attachmentVersionId: id(4), sha256: 'a'.repeat(64), label: 'Archived source',
      scope: 'page', totalPages: 3, complete: false, pages: [{ pageIndex: 1, text: 'The original input text.' }] },
    action: 'ask', question: 'Original sent question', provider: { id: 'primary', endpoint: 'https://provider.example.invalid/v1', model: 'fixture' },
    result: { text: 'Historical answer [P2], unsupported [P9]. <img src="https://outside.invalid/x">', status: 'complete',
      finishReason: 'stop', usage: null, cost: 'unknown', failure: null } };
}
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
const flush = async () => { await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 5)); }); };
async function until(check: () => boolean) { const limit = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < limit, 'UI did not settle'); await flush(); } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(t: TestContext, initial = false) {
  const archive = new WebAiArchiveStore({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() });
  const value = record(), result = deriveAiHistoryResult(value), applied: { action: string; question: string }[] = [], jumps: PdfCitationTarget[] = [];
  if (initial) await archive.put(scope, value, { expectedRevision: 0 });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const confirmations = { allow: true, calls: 0 };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => { confirmations.calls++; return confirmations.allow; } } });
  let props: AiArchivePanelProps = { accountScope: scope, currentContext: value.context, contextIdentity: result.contextIdentity,
    currentResult: result, busy: false, draft: { action: 'explain', question: 'Later unsent draft' },
    captureRecord: () => createAiHistoryRecord(value.context, result), canCaptureRecord: () => true,
    onApplyDraft: (action, question) => { applied.push({ action, question }); }, onNavigateCitation: target => { jumps.push(target); }, archiveStore: archive };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(AiArchivePanel, props)); });
  const button = (label: string) => { const node = renderer.root.findAllByType('button').find(node => text(node) === label); assert.ok(node, `Missing ${label}`); return node; };
  const click = async (label: string) => { await act(async () => { button(label).props.onClick(); }); };
  const open = async () => {
    await act(async () => { renderer.root.findAllByType('details')[0].props.onToggle({ currentTarget: { open: true } }); });
    await until(() => !button('重新读取').props.disabled);
  };
  const update = async (change: Partial<AiArchivePanelProps>) => { props = { ...props, ...change }; await act(async () => { renderer.update(createElement(AiArchivePanel, props)); }); };
  t.after(async () => { act(() => renderer.unmount()); await archive.close(); if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window'); });
  return { archive, value, result, renderer, button, click, open, update, applied, jumps, confirmations };
}

test('only an explicit history save stores the captured request rather than the current question draft', async t => {
  const ui = await setup(t); let reads = 0;
  const list = ui.archive.list.bind(ui.archive); t.mock.method(ui.archive, 'list', async (...args: Parameters<typeof list>) => { reads++; return list(...args); });
  await flush(); assert.equal(reads, 0); assert.deepEqual(await list(scope), []);
  await ui.click('保存此问答到本机记录'); await until(() => text(ui.renderer.root).includes('问答已保存'));
  const saved = await ui.archive.read(scope, 'record', ui.value.id);
  assert.equal(saved?.kind, 'record'); assert.equal((saved as AiHistoryRecord).question, 'Original sent question');
  assert.equal(JSON.stringify(saved).includes('Later unsent draft'), false);
  await ui.click('保存此问答到本机记录'); await until(() => text(ui.renderer.root).includes('问答已保存'));
  assert.equal((await ui.archive.list(scope)).length, 1);
  await ui.open(); await ui.click('提问 · Archived source完成 · ' + new Date(ui.value.updatedAt).toLocaleString());
  await until(() => text(ui.renderer.root).includes('Historical answer'));
  assert.equal(ui.renderer.root.findAllByType('img').length, 0); assert.equal(ui.renderer.root.findAllByType('script').length, 0);
  const oldCitation = ui.button('查看 PDF 第 2 页').props.onClick;
  await ui.click('查看 PDF 第 2 页'); assert.equal(ui.jumps[0].attachmentVersionId, ui.value.context.attachmentVersionId);
  await ui.update({ currentContext: { ...ui.value.context, sha256: 'b'.repeat(64) } });
  assert.equal(ui.button('查看 PDF 第 2 页').props.disabled, true);
  act(() => oldCitation()); assert.equal(ui.jumps.length, 1);
  assert.equal(ui.renderer.root.findAllByType('button').some(node => text(node) === '查看 PDF 第 9 页'), false);
  await ui.update({ accountScope: { ...scope, accountId: id(9) }, currentContext: null, contextIdentity: null, currentResult: null });
  act(() => oldCitation()); assert.equal(ui.jumps.length, 1);
});

test('question templates create, update with CAS and require explicit replacement of an existing draft', async t => {
  const ui = await setup(t); await ui.open(); await ui.click('问题模板'); await ui.click('从当前问题创建模板');
  const form = () => ui.renderer.root.findByProps({ 'aria-label': '编辑问题模板' });
  const edit = (suffix: string, value: string) => { const node = form().findAll(node => typeof node.props.id === 'string' && node.props.id.endsWith('-' + suffix))[0]; assert.ok(node); act(() => node.props.onChange({ target: { value } })); };
  edit('title', '方法审视'); edit('question', '用五行解释研究方法。'); edit('action', 'ask');
  await act(async () => { form().props.onSubmit({ preventDefault() {} }); });
  await until(() => text(ui.renderer.root).includes('问题模板已保存'));
  let summaries = await ui.archive.list(scope); assert.equal(summaries.length, 1); assert.equal(summaries[0].revision, 1);
  ui.confirmations.allow = false; await ui.click('填入当前问题'); assert.equal(ui.applied.length, 0);
  ui.confirmations.allow = true; await ui.click('填入当前问题'); assert.deepEqual(ui.applied, [{ action: 'ask', question: '用五行解释研究方法。' }]);
  await ui.click('编辑此模板'); edit('question', '更新后的模板问题');
  await act(async () => { form().props.onSubmit({ preventDefault() {} }); }); await until(() => text(ui.renderer.root).includes('问题模板已保存'));
  summaries = await ui.archive.list(scope); assert.equal(summaries[0].revision, 2);
  await ui.click('编辑此模板'); edit('question', '尚未保存的当前草稿');
  const previous = await ui.archive.read(scope, 'template', summaries[0].id); assert.equal(previous?.kind, 'template');
  if (previous?.kind !== 'template') assert.fail();
  const concurrent = createAiQuestionTemplate({ id: previous.id, title: previous.title, action: previous.action, question: '另一个窗口的修改' },
    { previous, now: new Date(Date.parse(previous.updatedAt) + 1).toISOString() });
  await ui.archive.put(scope, concurrent, { expectedRevision: previous.revision });
  await act(async () => { form().props.onSubmit({ preventDefault() {} }); });
  await until(() => text(ui.renderer.root).includes('其他窗口变化'));
  assert.equal(form().findByType('textarea').props.value, '尚未保存的当前草稿');
  assert.deepEqual(await ui.archive.read(scope, 'template', previous.id), concurrent);
});

test('account switches discard prior views and late archive reads cannot reveal the old account', async t => {
  const ui = await setup(t, true); await ui.open(); const gate = deferred();
  const read = ui.archive.read.bind(ui.archive); let entered = false;
  t.mock.method(ui.archive, 'read', async (...args: Parameters<typeof read>) => { entered = true; await gate.promise; return read(...args); });
  const row = ui.renderer.root.findAllByType('button').find(node => text(node).startsWith('提问 · Archived source')); assert.ok(row);
  await act(async () => { row.props.onClick(); }); await until(() => entered);
  await ui.update({ accountScope: { ...scope, accountId: id(9) }, currentContext: null, contextIdentity: null, currentResult: null });
  gate.resolve(); await flush(); await ui.open();
  await until(() => text(ui.renderer.root).includes('此账号在本设备还没有保存的问答'));
  assert.doesNotMatch(text(ui.renderer.root), /Historical answer|Archived source/);
  assert.equal((await ui.archive.list(scope)).length, 1);
});

test('a queued explicit history save cannot persist after the current request source changes', async t => {
  const ui = await setup(t), gate = deferred(); let entered = false;
  const put = ui.archive.put.bind(ui.archive);
  t.mock.method(ui.archive, 'put', async (...args: Parameters<typeof put>) => { entered = true; await gate.promise; return put(...args); });
  await ui.click('保存此问答到本机记录'); await until(() => entered);
  await ui.update({ currentContext: null, contextIdentity: null, currentResult: null });
  gate.resolve(); await until(() => text(ui.renderer.root).includes('本机记录集合已变化'));
  assert.equal((await ui.archive.list(scope)).length, 0);
});

test('failed writes and cancelled clear preserve stored content, while confirmed clear affects only its account', async t => {
  const ui = await setup(t, true); await ui.open();
  const other = { ...scope, accountId: id(9) }; await ui.archive.put(other, ui.value, { expectedRevision: 0 });
  t.mock.method(ui.archive, 'put', async () => { throw new AiArchiveError('ARCHIVE_UNAVAILABLE'); });
  await ui.click('保存此问答到本机记录'); await until(() => text(ui.renderer.root).includes('无法访问本机问答存储'));
  assert.equal((await ui.archive.list(scope)).length, 1);
  ui.confirmations.allow = false; await ui.click('清空此账号的本机问答与模板'); assert.equal((await ui.archive.list(scope)).length, 1);
  ui.confirmations.allow = true; await ui.click('清空此账号的本机问答与模板'); await until(() => text(ui.renderer.root).includes('本机问答记录与问题模板已清空'));
  assert.equal((await ui.archive.list(scope)).length, 0); assert.equal((await ui.archive.list(other)).length, 1);
  assert.equal(ui.result.text.includes('Historical answer'), true);
});

test('a generated template name preserves emoji across its title boundary', async t => {
  const ui = await setup(t);
  await ui.update({ draft: { action: 'ask', question: 'a'.repeat(63) + '😀问题' } });
  await ui.open(); await ui.click('问题模板'); await ui.click('从当前问题创建模板');
  const form = ui.renderer.root.findByProps({ 'aria-label': '编辑问题模板' });
  assert.equal(form.findByType('input').props.value, 'a'.repeat(63) + '😀');
  await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
  await until(() => text(ui.renderer.root).includes('问题模板已保存'));
  assert.equal((await ui.archive.list(scope)).length, 1);
});

test('a completed account-wide clear retires an already opened history view', async t => {
  const ui = await setup(t, true); await ui.open();
  const row = ui.renderer.root.findAllByType('button').find(node => text(node).startsWith('提问 · Archived source')); assert.ok(row);
  await act(async () => { row.props.onClick(); }); await until(() => text(ui.renderer.root).includes('Historical answer'));
  await ui.archive.clear(scope); await ui.update({ resetEpoch: 1 });
  assert.doesNotMatch(text(ui.renderer.root), /Historical answer/);
  await ui.open(); await until(() => text(ui.renderer.root).includes('此账号在本设备还没有保存的问答'));
});
