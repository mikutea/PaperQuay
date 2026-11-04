import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import { AccountStore } from '../src/storage/accountStore.ts';
import { WorkspaceController, decodeWorkspace, type StoredWorkspace } from '../src/sync/workspace.ts';
import { ClientError } from '../src/errors.ts';
import { createRetrievalSession } from '../src/retrieval/session.ts';
import { remoteRetrievalDigest, runRemoteLexicalRetrieval, type RemoteRetrievalReceipt, type RemoteRetrievalRequest } from '../../../packages/sync-core/src/remoteRetrieval.ts';
import type { SyncOperation } from '../../../packages/sync-core/src/index.ts';
import { LocalAiConfigStore, defaultAiProvider } from '../src/ai/provider.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import type { AiTransport } from '../src/ai/types.ts';
import type { TextFileExport } from '../src/platform/exportFile.ts';
import { completion, deferred } from './reviewFixtures.ts';
import { retrievalFixture, retrievalRecords, retrievalCapability, retrievalScope as scope, retrievalAt, retrievalDevice } from './retrievalFixtures.ts';

registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { RemoteRetrievalSheet } = await import('../src/components/RemoteRetrievalSheet.tsx');
const { ResearchWorkspace } = await import('../src/components/ResearchWorkspace.tsx');
const { AgentModelWorkspace } = await import('../src/components/AgentModelWorkspace.tsx');
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
function button(r: ReactTestRenderer, label: string) { const b = r.root.findAllByType('button').find(n => text(n) === label); assert(b, 'Missing button: ' + label); return b; }
async function click(r: ReactTestRenderer, label: string) { const b = button(r, label); assert(!b.props.disabled, label + ' disabled'); await act(async () => b.props.onClick()); }
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); }); } assert.fail('Retrieval UI did not settle'); }
const checks = (r: ReactTestRenderer) => r.root.findByProps({ className: 'remote-retrieval' }).findAllByType('input').filter(n => n.props.type === 'checkbox');
async function check(r: ReactTestRenderer, index = 0) { await until(() => !!checks(r)[index] && !checks(r)[index].props.disabled); const c = checks(r)[index]; await act(async () => c.props.onChange({ target: { checked: !c.props.checked } })); }
async function field(r: ReactTestRenderer, label: string, value: string) {
  const row = r.root.findAllByType('label').find(n => text(n).startsWith(label)); assert(row, 'Missing field: ' + label);
  const input = row.findAll(n => ['textarea', 'select', 'input'].includes(String(n.type)))[0]; await act(async () => input.props.onChange({ target: { value } }));
}

async function setup(t: TestContext, kind: 'sheet' | 'research' | 'agent' = 'sheet', options: { seeded?: 'prepared' | 'uncertain' | 'complete'; extraPaper?: boolean; allReceiptSources?: boolean; paperIds?: string[] } = {}) {
  const f = retrievalFixture(), extra = options.extraPaper ? retrievalFixture() : null, store = new AccountStore<StoredWorkspace>({ decode: decodeWorkspace, indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() });
  if (options.allReceiptSources && extra) f.request = { ...f.request, sources: [f.source, extra.source] };
  async function makeReceipt(request = f.request): Promise<RemoteRetrievalReceipt> {
    const result = await runRemoteLexicalRetrieval(request, request.sources.map(source => source.taskId === f.source.taskId ? f.artifact : extra!.artifact));
    return { version: 1, request, requestDigest: await remoteRetrievalDigest(request), result, resultDigest: await remoteRetrievalDigest(result), createdAt: retrievalAt };
  }
  const controller = new WorkspaceController({ apiBaseUrl: scope.apiBaseUrl, store, online: false, now: () => retrievalAt, api: {
    register: async () => ({ accountId: scope.accountId, device: { id: retrievalDevice, name: 'Retrieval UI', platform: 'web' as const, createdAt: retrievalAt, lastSeenAt: retrievalAt, revokedAt: null } }),
    devices: async () => [], revokeDevice: async () => {}, conflicts: async () => ({ conflicts: [], nextCursor: '', hasMore: false }),
    push: async () => { throw Error('No sync expected'); }, pull: async () => { throw Error('No sync expected'); }, resolveConflict: async () => { throw Error('No sync expected'); },
  } }); await controller.bind('Retrieval UI');
  const records = [...retrievalRecords(f), ...(extra ? retrievalRecords(extra).map(row => row.entityType === 'paper' ? { ...row, data: { ...row.data, title: 'Second paper' } } : row) : [])];
  await store.update(scope, w => ({ ...w!, sync: { ...w!.sync, serverRecords: Object.fromEntries(records.map(row => [row.entityType + ':' + row.entityId, row])) } }));
  await controller.refreshRetrievalSession();
  if (options.seeded) {
    const s = createRetrievalSession(f.request, retrievalAt); await controller.saveRetrievalSession(s, null);
    if (options.seeded !== 'prepared') { const begun = await controller.beginRetrievalRequest({ requestId: s.request.requestId, revision: s.revision });
      if (options.seeded === 'complete') await controller.saveRetrievalSession({ ...begun, revision: begun.revision + 1, status: 'complete', receipt: await makeReceipt() }, { requestId: begun.request.requestId, revision: begun.revision });
    }
  }
  const fetchBefore = globalThis.fetch, storageBefore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } });
  new LocalAiConfigStore(localStorage).save(scope, { ...defaultAiProvider(), model: 'retrieval-test-model', requiresKey: false, stream: false });
  const calls: { method: string; url: string; body?: RemoteRetrievalRequest }[] = [], adopted: { receipt: RemoteRetrievalReceipt; evidenceIds: string[] }[] = [], exports: TextFileExport[] = [];
  const owner = { valid: true }, network = { absent: false, fail: false, wait: null as Promise<Response> | null, sourcePages: [[f.source]] };
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET'; calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (network.wait) return network.wait;
    if (network.fail) throw new TypeError('Synthetic network interruption');
    if (url.includes('/sources?')) { const sources = network.sourcePages.shift() ?? []; return Response.json({ sources, hasMore: network.sourcePages.length > 0, nextCursor: network.sourcePages.length ? sources.at(-1)!.taskId : null }); }
    const request = method === 'POST' ? JSON.parse(String(init?.body)) as RemoteRetrievalRequest : controller.getSnapshot().workspace!.retrievalSession!.request;
    const receipt = await makeReceipt(request);
    if (method === 'POST') { assert.equal((await store.read(scope))!.retrievalSession!.status, 'uncertain'); return Response.json({ replayed: false, receipt }); }
    return Response.json({ requestId: request.requestId, status: method === 'DELETE' ? 'removed' : network.absent ? 'absent' : 'complete', requestDigest: network.absent ? null : receipt.requestDigest, receipt: method === 'DELETE' || network.absent ? null : receipt });
  };
  const modelBodies: any[] = [], modelReplies: string[] = [];
  const transport: AiTransport = { kind: 'fetch', supportsStreaming: false, redirectPolicy: 'error', request: async req => { modelBodies.push(JSON.parse(req.body!)); return Response.json(completion(modelReplies.shift() ?? 'Result [S1E1]')); } };
  const sync = controller.getSnapshot().workspace!.sync, context = { apiBaseUrl: scope.apiBaseUrl, getAccessToken: async () => 'synthetic-retrieval-ui', getCapability: retrievalCapability, identityKey: () => owner.valid ? 'same-owner' : 'changed-owner' };
  const props = { context, scopeKey: JSON.stringify([sync.accountId, sync.deviceId, sync.generation]), controller, accountCurrent: () => owner.valid,
    onClose() {}, onUse: (receipt: RemoteRetrievalReceipt, evidenceIds: string[]) => adopted.push({ receipt, evidenceIds }), paperIds: options.paperIds,
    exportRuntime: { native: false, available: () => true, canShare: async () => true, write: async () => '', share: async () => {}, remove: async () => {}, download: (file: TextFileExport) => exports.push(file), id: () => crypto.randomUUID() } };
  const workspaceProps = { ...props, scope, retrieval: context, secretStore: new MemorySecretStore(), transport, initialIds: [f.source.target.paperId, ...(extra ? [extra.source.target.paperId] : [])], onReviewPlan() {} };
  let r!: ReactTestRenderer;
  const render = () => kind === 'sheet' ? createElement(RemoteRetrievalSheet, props) : kind === 'research' ? createElement(ResearchWorkspace, workspaceProps) : createElement(AgentModelWorkspace, workspaceProps);
  await act(async () => { r = create(render()); });
  if (kind === 'sheet') await until(() => !button(r, '刷新本机检索记录').props.disabled);
  if (kind === 'agent') await until(() => !button(r, '用已选' + workspaceProps.initialIds.length + '篇建立会话').props.disabled);
  t.after(async () => { await act(async () => r.unmount()); controller.deactivate(); await store.close(); globalThis.fetch = fetchBefore;
    if (storageBefore) Object.defineProperty(globalThis, 'localStorage', storageBefore); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  async function changeSource() { await act(async () => { await store.update(scope, w => { const key = 'paper:' + f.source.target.paperId;
    return { ...w!, sync: { ...w!.sync, serverRecords: { ...w!.sync.serverRecords, [key]: { ...w!.sync.serverRecords[key], revision: 2 } } } }; }); await controller.refreshRetrievalSession(); }); }
  async function blockSource(entityType: 'paper' | 'attachmentVersion', blockedBy: 'retained-conflict' | 'pending-resolution', source = f.source) {
    await act(async () => { await store.update(scope, w => {
      const entityId = entityType === 'paper' ? source.target.paperId : source.target.attachmentVersionId, conflictId = crypto.randomUUID(), record = w!.sync.serverRecords[entityType + ':' + entityId];
      if (blockedBy === 'pending-resolution') return { ...w!, pendingResolutions: { ...w!.pendingResolutions, [conflictId]: { entityType, entityId, request: { opId: crypto.randomUUID(), expectedRevision: 1, choice: 'current' } } } };
      const attempted = { opId: crypto.randomUUID(), entityType, entityId, mutation: 'put', data: record.data, baseRevision: 1, schemaVersion: 1, clientCreatedAt: retrievalAt } as SyncOperation;
      return { ...w!, sync: { ...w!.sync, conflicts: { ...w!.sync.conflicts, [conflictId]: { conflictId, attempted, current: record } } } };
    }); await controller.refreshRetrievalSession(); });
    assert.equal(controller.getSnapshot().workspace!.sync.outbox.length, 0);
  }
  return { f, extra, r, controller, store, calls, adopted, exports, network, owner, props, modelBodies, modelReplies, workspaceProps, changeSource, blockSource, rerender: async () => { await act(async () => r.update(render())); } };
}
async function search(a: Awaited<ReturnType<typeof setup>>, query = 'urban') {
  await click(a.r, '查看可用来源'); await until(() => checks(a.r).length > 0); await check(a.r); await field(a.r, '检索词', query);
  await click(a.r, '预览检索范围'); await until(() => a.r.root.findAllByProps({ 'aria-label': '检索请求预览' }).length > 0);
  await click(a.r, '确认检索这些来源'); await until(() => a.r.root.findAllByProps({ 'aria-label': '检索原文结果' }).length > 0 && !button(a.r, '刷新本机检索记录').props.disabled);
}

test('actual retrieval sheet opens locally, selects no source or excerpt, previews exact scope, and sends once only on confirmation', async t => {
  const a = await setup(t); assert.equal(a.calls.length, 0);
  await click(a.r, '查看可用来源'); await until(() => checks(a.r).length === 1); assert.equal(checks(a.r)[0].props.checked, false);
  assert.equal(a.calls[0].method, 'GET'); assert(button(a.r, '预览检索范围').props.disabled);
  await check(a.r); await field(a.r, '检索词', 'urban'); await click(a.r, '预览检索范围'); await until(() => !!a.controller.getSnapshot().workspace!.retrievalSession);
  assert.equal(a.calls.length, 1); const saved = a.controller.getSnapshot().workspace!.retrievalSession!; assert.equal(saved.request.query, 'urban'); assert.deepEqual(saved.request.sources, [a.f.source]);
  const send = button(a.r, '确认检索这些来源').props.onClick; await act(async () => { send(); send(); }); await until(() => a.controller.getSnapshot().workspace!.retrievalSession!.status === 'complete');
  assert.equal(a.calls.filter(c => c.method === 'POST').length, 1); assert.equal(a.modelBodies.length, 0); assert(checks(a.r).every(c => !c.props.checked));
  assert(button(a.r, '采用所选片段').props.disabled); await check(a.r); await click(a.r, '采用所选片段');
  assert.equal(a.adopted.length, 1); assert.equal(a.adopted[0].evidenceIds.length, 1); assert.equal(a.adopted[0].receipt.request.requestId, saved.request.requestId);
  assert.match(text(a.r.root), /命中词项数/); assert.doesNotMatch(text(a.r.root), /相似度|可信度/);
});

test('reopened unknown request is query-only until absence is confirmed, then executes the same immutable request', async t => {
  const a = await setup(t, 'sheet', { seeded: 'uncertain' }); assert.equal(a.calls.length, 0); assert.match(text(a.r.root), /先查询原请求/);
  assert(!a.r.root.findAllByType('button').some(n => /^(执行原请求|清除本机记录)/.test(text(n))));
  a.network.absent = true; await click(a.r, '查询原请求'); await until(() => a.controller.getSnapshot().workspace!.retrievalSession!.status === 'absent');
  a.network.absent = false; await click(a.r, '执行原请求'); await until(() => a.controller.getSnapshot().workspace!.retrievalSession!.status === 'complete');
  const post = a.calls.find(call => call.method === 'POST')!; assert.deepEqual(post.body, a.f.request); assert.equal(a.calls.length, 2);
});

test('received but unsaved receipt exposes only local save recovery and export, including after source changes', async t => {
  const a = await setup(t, 'sheet', { seeded: 'prepared' }), update = a.store.update.bind(a.store); let fail = true;
  a.store.update = (scope, reducer, guard) => update(scope, value => { const next = reducer(value); if (fail && next.retrievalSession?.status === 'complete') throw new ClientError('STORAGE_FAILED'); return next; }, guard);
  await click(a.r, '确认检索这些来源'); await until(() => a.r.root.findAllByProps({ 'aria-label': '检索结果待保存' }).length === 1 && !button(a.r, '仅保存已收结果').props.disabled);
  assert.equal(a.calls.length, 1); assert(button(a.r, '刷新本机检索记录').props.disabled); assert(!a.r.root.findAllByType('button').some(n => text(n) === '查询原请求'));
  await a.changeSource(); await click(a.r, '导出未保存记录'); await until(() => a.exports.length === 1);
  assert.equal(JSON.parse(a.exports[0].text).unconfirmedSave, true); assert.equal(JSON.parse(a.exports[0].text).session.receipt.request.requestId, a.f.request.requestId);
  fail = false; await click(a.r, '仅保存已收结果'); await until(() => a.r.root.findAllByProps({ 'aria-label': '检索结果待保存' }).length === 0);
  assert.equal(a.calls.length, 1); assert(checks(a.r).every(n => n.props.disabled));
});

test('a lost intent acknowledgement can refresh the actual local ledger, never resend from the obsolete prepared callback', async t => {
  const a = await setup(t, 'sheet', { seeded: 'prepared' }), update = a.store.update.bind(a.store); let lose = true;
  a.store.update = async (...args) => { const next = await update(...args); if (lose && next.retrievalSession?.status === 'uncertain') { lose = false; throw new ClientError('STORAGE_FAILED'); } return next; };
  const stale = button(a.r, '确认检索这些来源').props.onClick; await act(async () => stale()); await until(() => !button(a.r, '刷新本机检索记录').props.disabled);
  assert.equal(a.calls.length, 0); await click(a.r, '刷新本机检索记录'); await until(() => a.controller.getSnapshot().workspace!.retrievalSession!.status === 'uncertain');
  await act(async () => stale()); assert.equal(a.calls.length, 0); assert(button(a.r, '查询原请求'));
});

test('source revisions and account changes retire captured execute/use callbacks and delayed source responses', async t => {
  const a = await setup(t, 'sheet', { seeded: 'prepared' }), send = button(a.r, '确认检索这些来源').props.onClick;
  await a.changeSource(); await act(async () => send()); await until(() => !button(a.r, '刷新本机检索记录').props.disabled); assert.equal(a.calls.length, 0);
  a.owner.valid = false; await act(async () => send()); assert.equal(a.calls.length, 0);
});

test('changing owner while a page is in flight cannot display or select its old-account sources', async t => {
  const a = await setup(t), pending = deferred<Response>(); a.network.wait = pending.promise;
  await click(a.r, '查看可用来源'); await until(() => a.calls.length === 1); a.owner.valid = false; await a.rerender();
  await act(async () => pending.resolve(Response.json({ sources: [a.f.source], nextCursor: null, hasMore: false })));
  assert.equal(checks(a.r).length, 0); assert.equal(a.adopted.length, 0);
});

test('explicit server cleanup preserves the full local receipt and clears neither evidence nor original request identity', async t => {
  const a = await setup(t, 'sheet', { seeded: 'complete' }), before = a.controller.getSnapshot().workspace!.retrievalSession!.receipt;
  await click(a.r, '清理服务端结果'); assert.equal(a.calls.length, 0); assert.match(text(a.r.root.findByProps({ 'aria-label': '确认清理检索记录' })), /本机已保存的完整结果仍保留/);
  await click(a.r, '确认清理服务端结果'); await until(() => a.controller.getSnapshot().workspace!.retrievalSession!.status === 'removed');
  assert.equal(a.calls.length, 1); assert.equal(a.calls[0].method, 'DELETE'); assert.deepEqual(a.controller.getSnapshot().workspace!.retrievalSession!.receipt, before);
  await check(a.r); const use = button(a.r, '采用所选片段').props.onClick; a.owner.valid = false; await act(async () => use()); assert.equal(a.adopted.length, 0);
});

test('empty keyword results are successful empty evidence without metadata fallback or model calls', async t => {
  const a = await setup(t); await search(a, 'noSuchLexicalToken'); assert.match(text(a.r.root), /检索完成，没有匹配片段/);
  assert.equal(a.controller.getSnapshot().workspace!.retrievalSession!.status, 'complete'); assert.equal(checks(a.r).length, 0); assert.equal(a.adopted.length + a.modelBodies.length, 0);
});

test('Research retains the selected remote text through question and AI settings edits, and sends it only after its normal preview', async t => {
  const a = await setup(t, 'research', { seeded: 'complete' }); await field(a.r, '2 · 问题', '保留我的问题'); await click(a.r, '到账号索引中查找');
  await until(() => a.r.root.findAllByProps({ 'aria-label': '检索原文结果' }).length === 1); assert.equal(a.calls.length, 0); await check(a.r); await click(a.r, '采用所选片段');
  await until(() => a.r.root.findAllByProps({ 'aria-label': '已选远程关键词原文' }).length === 1 && a.r.root.findAllByProps({ className: 'remote-retrieval' }).length === 0);
  assert.equal(a.modelBodies.length, 0); assert.equal(a.r.root.findAllByType('textarea').find(n => n.props.id?.endsWith('-question'))!.props.value, '保留我的问题');
  await field(a.r, '2 · 问题', '修改后的问题仍采用这些原文'); await click(a.r, '准备并预览发送内容'); await until(() => a.r.root.findAllByProps({ 'aria-label': '实际发送内容' }).length === 1);
  assert.match(text(a.r.root), /远程关键词检索原文/); const staleSend = button(a.r, '发送以上片段并提问').props.onClick;
  await click(a.r, '更换 AI'); await click(a.r, '返回多篇问答'); await act(async () => staleSend()); assert.equal(a.modelBodies.length, 0);
  assert.equal(a.r.root.findAllByProps({ 'aria-label': '已选远程关键词原文' }).length, 1);
  await click(a.r, '准备并预览发送内容'); await until(() => a.r.root.findAllByProps({ 'aria-label': '实际发送内容' }).length === 1); await click(a.r, '发送以上片段并提问'); await until(() => a.modelBodies.length === 1);
  const receipt = a.controller.getSnapshot().workspace!.retrievalSession!.receipt!, payload = JSON.stringify(a.modelBodies[0]);
  assert(payload.includes(receipt.result.evidence[0].text)); assert(payload.includes(receipt.resultDigest)); assert(payload.includes('remote-index')); assert(payload.includes('修改后的问题仍采用这些原文'));
  await until(() => !button(a.r, '改选本机来源').props.disabled); await click(a.r, '改选本机来源');
  assert.equal(a.r.root.findAllByProps({ 'aria-label': '已选远程关键词原文' }).length, 0); assert(a.r.root.findAllByType('input').filter(n => n.props.type === 'checkbox').every(n => !n.props.checked));
});

test('Research refuses to prepare selected remote evidence after a source revision changes', async t => {
  const a = await setup(t, 'research', { seeded: 'complete' }); await click(a.r, '到账号索引中查找'); await until(() => checks(a.r).length > 0); await check(a.r); await click(a.r, '采用所选片段');
  await until(() => a.r.root.findAllByProps({ 'aria-label': '已选远程关键词原文' }).length === 1); await a.changeSource(); await click(a.r, '准备并预览发送内容');
  await until(() => text(a.r.root).includes('文献、PDF 或索引版本已变化')); assert.equal(a.modelBodies.length, 0); assert.equal(a.r.root.findAllByProps({ 'aria-label': '实际发送内容' }).length, 0);
});

test('Agent explicitly mixes approved remote excerpts and a chosen local abstract in its actual next model payload', async t => {
  const a = await setup(t, 'agent', { seeded: 'complete', extraPaper: true }); await click(a.r, '用已选2篇建立会话'); await until(() => !!a.controller.getSnapshot().workspace!.agentConversation);
  await field(a.r, '给模型的指令', '比较两篇方法'); await click(a.r, '预览下一次模型请求'); await until(() => a.r.root.findAllByProps({ className: 'agent-model-preview' }).length === 1);
  a.modelReplies.push(JSON.stringify({ kind: 'context-request', summary: '需要方法原文', mode: 'pdf-text', reason: '核对材料', paperIds: a.workspaceProps.initialIds }));
  await click(a.r, '发送这一次请求'); await until(() => a.r.root.findAllByType('button').some(n => text(n) === '到账号索引中查找'));
  assert(button(a.r, '预览所选补充材料').props.disabled); await click(a.r, '到账号索引中查找'); await until(() => checks(a.r).length > 0); await check(a.r); await click(a.r, '采用所选片段');
  await until(() => a.r.root.findAllByProps({ className: 'remote-retrieval' }).length === 0); assert(button(a.r, '预览所选补充材料').props.disabled, 'Missing paper gets no implicit abstract');
  await field(a.r, 'Second paper的补充来源', 'metadata'); await click(a.r, '预览所选补充材料'); await until(() => a.r.root.findAllByProps({ className: 'agent-model-context-preview' }).length === 1);
  assert.equal(a.controller.getSnapshot().workspace!.agentConversation!.contexts.length, 0); assert.equal(a.modelBodies.length, 1); assert.match(text(a.r.root.findByProps({ className: 'agent-model-context-preview' })), /远程关键词检索原文/);
  await click(a.r, '确认保存在本次会话'); await until(() => a.controller.getSnapshot().workspace!.agentConversation!.contexts.length === 2 && !button(a.r, '预览下一次模型请求').props.disabled);
  assert.equal(a.modelBodies.length, 1); await click(a.r, '预览下一次模型请求'); await until(() => a.r.root.findAllByProps({ className: 'agent-model-preview' }).length === 1);
  a.modelReplies.push('已核对材料'); await click(a.r, '发送这一次请求'); await until(() => a.modelBodies.length === 2);
  const payload = JSON.parse(a.modelBodies[1].messages[1].content), remote = payload.approvedContextExcerpts.find((c: any) => c.kind === 'remote-index');
  const receipt = a.controller.getSnapshot().workspace!.retrievalSession!.receipt!;
  assert.equal(remote.text, receipt.result.evidence[0].text); assert.equal(remote.remoteRetrieval.resultDigest, receipt.resultDigest); assert.deepEqual(remote.pages, [receipt.result.evidence[0].pageIndex + 1]);
  assert.equal(payload.approvedContextExcerpts.find((c: any) => c.paperId === a.extra!.source.target.paperId).kind, 'metadata'); assert.equal(a.calls.length, 0);
});

async function adoptResearch(a: Awaited<ReturnType<typeof setup>>) {
  await click(a.r, '到账号索引中查找'); await until(() => a.r.root.findAllByProps({ className: 'remote-retrieval' }).length === 1);
  await check(a.r); await click(a.r, '采用所选片段');
  await until(() => a.r.root.findAllByProps({ 'aria-label': '已选远程关键词原文' }).length === 1 && a.r.root.findAllByProps({ className: 'remote-retrieval' }).length === 0);
}
async function previewResearch(a: Awaited<ReturnType<typeof setup>>) { await click(a.r, '准备并预览发送内容'); await until(() => a.r.root.findAllByProps({ 'aria-label': '实际发送内容' }).length === 1); }

for (const entityType of ['paper', 'attachmentVersion'] as const) {
  for (const blockedBy of ['retained-conflict', 'pending-resolution'] as const) {
    test(`Research actual send rejects selected ${entityType} ${blockedBy} after preview, with no outbox or text change`, async t => {
      const a = await setup(t, 'research', { seeded: 'complete' }); await adoptResearch(a); await previewResearch(a);
      const send = button(a.r, '发送以上片段并提问').props.onClick, digest = a.controller.getSnapshot().workspace!.retrievalSession!.receipt!.resultDigest;
      await a.blockSource(entityType, blockedBy); await act(async () => send());
      await until(() => text(a.r.root).includes('文献、PDF 或索引版本已变化'));
      assert.equal(a.modelBodies.length + a.calls.length, 0); assert.equal(a.controller.getSnapshot().workspace!.retrievalSession!.receipt!.resultDigest, digest);
    });

    test(`late credential cannot send Research excerpts when selected ${entityType} gains ${blockedBy}`, async t => {
      const a = await setup(t, 'research', { seeded: 'complete' }); await adoptResearch(a);
      const provider = new LocalAiConfigStore(localStorage).load(scope); new LocalAiConfigStore(localStorage).save(scope, { ...provider, requiresKey: true });
      const key = deferred<string>(); let reads = 0; a.workspaceProps.secretStore.get = async () => { reads++; return key.promise; };
      await previewResearch(a); await click(a.r, '发送以上片段并提问'); await until(() => reads === 1);
      await a.blockSource(entityType, blockedBy); await act(async () => key.resolve('synthetic-only-test-key'));
      await until(() => text(a.r.root).includes('文献、PDF 或索引版本已变化'));
      assert.equal(a.modelBodies.length, 0); assert.equal(a.controller.getSnapshot().workspace!.retrievalSession!.status, 'complete');
    });
  }
}

test('a conflict on an unselected source in the same receipt does not block the selected Research evidence', async t => {
  const a = await setup(t, 'research', { seeded: 'complete', extraPaper: true, allReceiptSources: true }); await adoptResearch(a); await previewResearch(a);
  await a.blockSource('attachmentVersion', 'retained-conflict', a.extra!.source); await a.blockSource('paper', 'pending-resolution', a.extra!.source);
  await click(a.r, '发送以上片段并提问'); await until(() => a.modelBodies.length === 1);
  const payload = JSON.parse(a.modelBodies[0].messages[1].content); assert.equal(payload.sources.length, 1); assert.equal(payload.sources[0].paperId, a.f.source.target.paperId);
});

test('selected conflicted evidence remains exportable but a captured adoption cannot use it', async t => {
  const a = await setup(t, 'sheet', { seeded: 'complete' }); await check(a.r); const use = button(a.r, '采用所选片段').props.onClick;
  const receipt = a.controller.getSnapshot().workspace!.retrievalSession!.receipt;
  await a.blockSource('attachmentVersion', 'pending-resolution'); await act(async () => use());
  assert.equal(a.adopted.length, 0); assert.match(text(a.r.root), /文献、PDF 或索引版本已变化/);
  await click(a.r, '导出完整检索记录'); await until(() => a.exports.length === 1); assert.deepEqual(JSON.parse(a.exports[0].text).session.receipt, receipt);
});

test('available source pages obey the caller paper range, load only on click, and never preselect another page', async t => {
  const a = await setup(t, 'sheet', { extraPaper: true }); a.props.paperIds = [a.f.source.target.paperId];
  a.network.sourcePages = [[a.extra!.source], [a.f.source]]; await a.rerender(); await click(a.r, '查看可用来源');
  await until(() => a.r.root.findAllByType('button').some(n => text(n) === '查看下一页来源'));
  assert.equal(checks(a.r).length, 0); assert.equal(a.calls.length, 1); assert(!text(a.r.root).includes('Second paper'));
  await click(a.r, '查看下一页来源'); await until(() => checks(a.r).length === 1); assert.equal(a.calls.length, 2); assert.equal(checks(a.r)[0].props.checked, false);
});

test('Research can replace an obsolete remote selection with currently valid evidence from another source', async t => {
  const a = await setup(t, 'research', { seeded: 'complete', extraPaper: true, allReceiptSources: true }); await adoptResearch(a);
  await a.blockSource('paper', 'pending-resolution'); await click(a.r, '到账号索引中查找');
  const receipt = a.controller.getSnapshot().workspace!.retrievalSession!.receipt!, otherIndex = receipt.result.evidence.findIndex(row => row.sourceIndex === 1);
  await check(a.r, otherIndex); await click(a.r, '采用所选片段'); await until(() => a.r.root.findAllByProps({ className: 'remote-retrieval' }).length === 0);
  assert.match(text(a.r.root.findByProps({ 'aria-label': '已选远程关键词原文' })), /Second paper/);
  await previewResearch(a); await click(a.r, '发送以上片段并提问'); await until(() => a.modelBodies.length === 1);
  const payload = JSON.parse(a.modelBodies[0].messages[1].content); assert.equal(payload.sources.length, 1); assert.equal(payload.sources[0].paperId, a.extra!.source.target.paperId);
});

test('replacing Agent remote results retires the old material approval and clears uncovered remote choices without adding a fallback', async t => {
  const a = await setup(t, 'agent', { seeded: 'complete', extraPaper: true, allReceiptSources: true }); await click(a.r, '用已选2篇建立会话'); await until(() => !!a.controller.getSnapshot().workspace!.agentConversation);
  await field(a.r, '给模型的指令', '比较两篇方法'); await click(a.r, '预览下一次模型请求'); await until(() => a.r.root.findAllByProps({ className: 'agent-model-preview' }).length === 1);
  a.modelReplies.push(JSON.stringify({ kind: 'context-request', summary: '需要方法原文', mode: 'pdf-text', reason: '核对材料', paperIds: a.workspaceProps.initialIds }));
  await click(a.r, '发送这一次请求'); await until(() => a.r.root.findAllByType('button').some(n => text(n) === '到账号索引中查找'));
  await click(a.r, '到账号索引中查找'); await check(a.r); const receipt = a.controller.getSnapshot().workspace!.retrievalSession!.receipt!;
  await check(a.r, receipt.result.evidence.findIndex(row => row.sourceIndex === 1)); await click(a.r, '采用所选片段'); await until(() => a.r.root.findAllByProps({ className: 'remote-retrieval' }).length === 0);
  await click(a.r, '预览所选补充材料'); await until(() => a.r.root.findAllByProps({ className: 'agent-model-context-preview' }).length === 1); const oldApproval = button(a.r, '确认保存在本次会话').props.onClick;
  await click(a.r, '到账号索引中查找'); await check(a.r); await click(a.r, '采用所选片段'); await until(() => a.r.root.findAllByProps({ className: 'remote-retrieval' }).length === 0);
  await act(async () => oldApproval()); assert.equal(a.controller.getSnapshot().workspace!.agentConversation!.contexts.length, 0);
  assert(button(a.r, '预览所选补充材料').props.disabled); const other = a.r.root.findAllByType('label').find(n => text(n).startsWith('Second paper的补充来源'))!;
  assert.equal(other.findByType('select').props.value, ''); assert.equal(a.modelBodies.length, 1);
});
