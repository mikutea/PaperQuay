import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import { ZoteroRefreshPanel, type ZoteroRefreshPanelProps } from '../src/components/ZoteroRefreshPanel.tsx';
import { materializeExternalLibraryImport, parseExternalLibrary, planExternalLibraryImport, type ExternalLibraryRegistry } from '../src/library/externalLibrary.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import { zoteroSecretNamespace, ZOTERO_SECRET_KEY } from '../src/library/zoteroClient.ts';
import { deferred, zoteroAccount, zoteroConfig, zoteroDeleted, zoteroItem, zoteroKey, zoteroResponse, zoteroTransport, type ZoteroReply } from './helpers/zotero.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
const flush = async () => { await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); }); };
async function setup(t: TestContext, replies: ZoteroReply[], options: { conflict?: boolean; props?: Partial<ZoteroRefreshPanelProps> } = {}) {
  const transport = zoteroTransport(replies), store = new MemorySecretStore(), keyInput = { value: '' };
  const state: { cursor: number | null; registry?: ExternalLibraryRegistry; entities: VisibleEntity[] } = { cursor: null, entities: [] };
  let active = true, activeScope = 'account-one-generation-one', disposed = false, nextId = 100;
  const busy: boolean[] = [], adoptions: Parameters<ZoteroRefreshPanelProps['onAdopt']>[] = [];
  let previewCalls = 0;
  if (options.conflict) {
    const snapshot = parseExternalLibrary(JSON.stringify([zoteroItem(1, 1, zoteroConfig, { title: 'Base title' })])).snapshot;
    state.registry = materializeExternalLibraryImport(planExternalLibraryImport(snapshot, undefined, []), () => id(10)).newRegistry;
    state.entities = [{ entityType: 'paper', entityId: id(10), revision: 2, pending: false, deleted: false, status: 'synced',
      data: { ...snapshot.items[0].data, title: 'Local title' } }];
    state.cursor = 1;
  }
  let props: ZoteroRefreshPanelProps = { scopeKey: activeScope, accountScope: zoteroAccount, accountCurrent: () => active,
    secretStore: store, initialConfig: zoteroConfig, client: transport.client, onBusyChange: value => busy.push(value),
    getCursor: () => state.cursor,
    preview: (result, decisions) => { previewCalls++; return planExternalLibraryImport(result.snapshot, state.registry, state.entities, decisions); },
    onAdopt: async (...args) => {
      adoptions.push(args); const [result, decisions, signature, scopeKey] = args;
      assert.equal(scopeKey, activeScope); assert.equal(result.expectedCursor, state.cursor);
      const plan = planExternalLibraryImport(result.snapshot, state.registry, state.entities, decisions);
      assert.equal(signature, plan.signature);
      const saved = materializeExternalLibraryImport(plan, () => id(nextId++));
      const next = [...state.entities];
      for (const edit of saved.edits) {
        const entity: VisibleEntity = { entityType: 'paper', entityId: edit.entityId, data: edit.data!, deleted: false,
          pending: true, status: 'queued', revision: 0 };
        const index = next.findIndex(item => item.entityId === edit.entityId);
        if (index < 0) next.push(entity); else next[index] = entity;
      }
      state.entities = next; state.registry = saved.newRegistry; state.cursor = result.nextCursor;
      return saved.summary;
    }, ...options.props };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(ZoteroRefreshPanel, props), { createNodeMock: node =>
    node.props['aria-label'] === '专用 Zotero API 密钥' ? keyInput : null }); });
  const button = (label: string) => { const node = view.root.findAllByType('button').find(node => text(node) === label);
    assert.ok(node, `Missing button: ${label}`); return node; };
  const control = (label: string) => { const node = view.root.findAllByType('label').find(node => text(node) === label);
    assert.ok(node, `Missing label: ${label}`); const target = view.root.findAll(node2 => node2.props.id === node.props.htmlFor)[0];
    assert.ok(target, `Missing field: ${label}`); return target; };
  const click = async (label: string) => { await act(async () => { button(label).props.onClick(); }); };
  const change = async (label: string, value: string) => { await act(async () => { control(label).props.onChange({ target: { value } }); }); };
  const update = async (next: Partial<ZoteroRefreshPanelProps> = {}) => {
    props = { ...props, ...next }; activeScope = props.scopeKey;
    await act(async () => { view.update(createElement(ZoteroRefreshPanel, props)); });
  };
  const unmount = async () => { if (!disposed) { disposed = true; await act(async () => { view.unmount(); }); } };
  t.after(unmount);
  return { ...transport, view, store, keyInput, state, busy, adoptions, button, control, click, change, update, unmount,
    signOut: () => { active = false; }, previewCalls: () => previewCalls };
}

test('mount/configuration never fetch and a complete read remains a preview until explicit adoption', async t => {
  const title = '<img src="https://outside.invalid/private"> Source title';
  const ui = await setup(t, [zoteroResponse([zoteroItem(1, 2, zoteroConfig, { title })], 2), zoteroDeleted([], 2)]);
  assert.equal(ui.requests.length, 0); assert.equal(ui.adoptions.length, 0); assert.equal(ui.state.cursor, null);
  await ui.change('本机显示名称', '明确选择的来源'); assert.equal(ui.requests.length, 0);
  await ui.click('读取 Zotero 更新');
  assert.equal(ui.requests.length, 2); assert.equal(ui.adoptions.length, 0); assert.equal(ui.state.cursor, null); assert.equal(ui.state.entities.length, 0);
  assert.match(text(ui.view.root), /Source title/); assert.equal(ui.view.root.findAllByType('img').length, 0);
  assert.equal(ui.view.root.findAllByType('script').length, 0); assert.equal(ui.button('确认采用这轮更新').props.disabled, false);
  await ui.click('确认采用这轮更新');
  assert.equal(ui.adoptions.length, 1); assert.equal(ui.state.cursor, 2); assert.equal(ui.state.entities.length, 1);
  assert.equal((ui.state.entities[0].data as PaperData).title, title); assert.match(text(ui.view.root), /已采用本轮更新/);
  assert.deepEqual(ui.busy, [true, false, true, false]);
});

test('conflicting local/source fields need an explicit decision which is passed with the reviewed signature', async t => {
  const ui = await setup(t, [zoteroResponse([zoteroItem(1, 2, zoteroConfig, { title: 'Incoming title' })], 2), zoteroDeleted([], 2)], { conflict: true });
  await ui.click('读取 Zotero 更新');
  assert.equal(ui.button('确认采用这轮更新').props.disabled, true);
  assert.match(text(ui.view.root), /来源：Incoming title/); assert.match(text(ui.view.root), /当前：Local title/);
  await ui.click('确认采用这轮更新'); assert.equal(ui.adoptions.length, 0);
  await ui.change('冲突字段的处理', 'prefer-source'); assert.equal(ui.button('确认采用这轮更新').props.disabled, false);
  await ui.click('确认采用这轮更新');
  assert.deepEqual(ui.adoptions[0][1], [{ itemKey: '00000001', action: 'import', resolution: 'prefer-source' }]);
  assert.equal((ui.state.entities[0].data as PaperData).title, 'Incoming title'); assert.equal(ui.state.cursor, 2);
});

test('a changed local revision invalidates prior conflict choices and old adopt callbacks until explicit recompare', async t => {
  const ui = await setup(t, [zoteroResponse([zoteroItem(1, 2, zoteroConfig, { title: 'Incoming title' })], 2), zoteroDeleted([], 2)], { conflict: true });
  await ui.click('读取 Zotero 更新'); await ui.change('冲突字段的处理', 'prefer-source');
  const oldAdopt = ui.button('确认采用这轮更新').props.onClick;
  ui.state.entities = [{ ...ui.state.entities[0], revision: 3, data: { ...(ui.state.entities[0].data as PaperData), title: 'New local title' } }];
  await ui.update();
  assert.equal(ui.button('确认采用这轮更新').props.disabled, true); assert.match(text(ui.view.root), /本地文库在预览后已变化/);
  await act(async () => { oldAdopt(); }); assert.equal(ui.adoptions.length, 0);
  await ui.click('重新比较当前文库'); assert.equal(ui.control('冲突字段的处理').props.value, '');
  assert.equal(ui.button('确认采用这轮更新').props.disabled, true);
  await ui.change('冲突字段的处理', 'prefer-local'); await ui.click('确认采用这轮更新');
  assert.equal(ui.adoptions.length, 1); assert.equal((ui.state.entities[0].data as PaperData).title, 'New local title');
});

test('an old adoption callback cannot reuse a conflict choice after the user reviews a different choice', async t => {
  const ui = await setup(t, [zoteroResponse([zoteroItem(1, 2, zoteroConfig, { title: 'Incoming title' })], 2), zoteroDeleted([], 2)], { conflict: true });
  await ui.click('读取 Zotero 更新'); await ui.change('冲突字段的处理', 'prefer-source');
  const previous = ui.button('确认采用这轮更新').props.onClick;
  await ui.change('冲突字段的处理', 'prefer-local');
  await act(async () => { previous(); }); assert.equal(ui.adoptions.length, 0);
  await ui.click('确认采用这轮更新');
  assert.equal(ui.adoptions.length, 1); assert.equal((ui.state.entities[0].data as PaperData).title, 'Local title');
});

test('a concurrently adopted cursor requires a fresh network round rather than rebasing an old snapshot', async t => {
  const ui = await setup(t, [zoteroResponse([zoteroItem(1, 2)], 2), zoteroDeleted([], 2), zoteroResponse(null, 3, { status: 304 })]);
  await ui.click('读取 Zotero 更新'); const oldAdopt = ui.button('确认采用这轮更新').props.onClick;
  ui.state.cursor = 3; await ui.update();
  assert.match(text(ui.view.root), /来源版本已被其他操作更新/); assert.equal(ui.button('确认采用这轮更新').props.disabled, true);
  await act(async () => { oldAdopt(); }); assert.equal(ui.adoptions.length, 0);
  assert.equal(ui.view.root.findAllByType('button').some(node => text(node) === '重新比较当前文库'), false);
  await ui.click('重新读取来源');
  assert.equal(ui.requests[2].headers.get('If-Modified-Since-Version'), '3'); assert.match(text(ui.view.root), /没有新的变化/);
  assert.equal(ui.state.cursor, 3); assert.equal(ui.adoptions.length, 0);
});

test('304 and deletion-only updates have distinct behavior: unchanged does not adopt, deletion notices still require a click', async t => {
  const unchanged = await setup(t, [zoteroResponse(null, 1, { status: 304 })], { conflict: true });
  await unchanged.click('读取 Zotero 更新'); assert.equal(unchanged.previewCalls(), 0); assert.equal(unchanged.adoptions.length, 0);
  assert.match(text(unchanged.view.root), /没有新的变化/);
  const deletion = await setup(t, [zoteroResponse([], 2), zoteroDeleted(['00000001'], 2)], { conflict: true });
  await deletion.click('读取 Zotero 更新');
  assert.match(text(deletion.view.root), /远端删除，本地保留/); assert.equal(deletion.state.entities.length, 1);
  assert.equal(deletion.adoptions.length, 0); await deletion.click('确认采用这轮更新');
  assert.equal(deletion.state.entities.length, 1); assert.equal(deletion.state.cursor, 2); assert.equal(deletion.adoptions.length, 1);
});

test('scope changes abort pending reads and suppress late prior-account results even after returning to the same scope', async t => {
  const gate = deferred<Response>(), ui = await setup(t, [() => gate.promise]);
  await ui.click('读取 Zotero 更新'); assert.equal(ui.requests.length, 1);
  await ui.update({ scopeKey: 'account-two-generation-one', accountScope: { ...zoteroAccount, accountId: id(2) } });
  assert.equal(ui.requests[0].init.signal?.aborted, true);
  await ui.update({ scopeKey: 'account-one-generation-one', accountScope: zoteroAccount });
  gate.resolve(zoteroResponse([zoteroItem(1, 2, zoteroConfig, { title: 'Private old account title' })], 2)); await flush();
  assert.doesNotMatch(text(ui.view.root), /Private old account title|已采用|本次操作未完成/);
  assert.equal(ui.requests.length, 1); assert.equal(ui.adoptions.length, 0); assert.equal(ui.state.cursor, null);
});

test('stale input handlers and signed-out accounts cannot initiate a read for an earlier configuration', async t => {
  const ui = await setup(t, []), oldRead = ui.button('读取 Zotero 更新').props.onClick;
  await ui.change('Zotero 文库 ID', '43'); await ui.change('Zotero 文库 ID', '42');
  await act(async () => { oldRead(); }); assert.equal(ui.requests.length, 0);
  ui.signOut(); await ui.click('读取 Zotero 更新'); assert.equal(ui.requests.length, 0);
});

test('explicit cancellation and duplicate read clicks do not fetch or adopt a partial snapshot', async t => {
  const gate = deferred<Response>(), ui = await setup(t, [() => gate.promise]);
  const read = ui.button('读取 Zotero 更新').props.onClick;
  await act(async () => { read(); read(); }); assert.equal(ui.requests.length, 1);
  await ui.click('取消读取'); await flush();
  assert.equal(ui.requests[0].init.signal?.aborted, true); assert.match(text(ui.view.root), /已取消本次读取/);
  assert.equal(ui.button('读取 Zotero 更新').props.disabled, false);
  gate.resolve(zoteroResponse([zoteroItem()])); await flush();
  assert.equal(ui.requests.length, 1); assert.equal(ui.state.cursor, null); assert.equal(ui.adoptions.length, 0);
});

test('one-time keys are cleared from the uncontrolled input before fetch and never appear in previews or configuration', async t => {
  const ui = await setup(t, [zoteroResponse([zoteroItem(1, 2)], 2), zoteroDeleted([], 2)]);
  await ui.change('读取凭据', 'memory'); ui.keyInput.value = zoteroKey;
  await ui.click('读取 Zotero 更新');
  assert.equal(ui.keyInput.value, ''); assert.equal(ui.control('专用 Zotero API 密钥').props.value, undefined);
  assert.equal(ui.requests[0].headers.get('Zotero-API-Key'), zoteroKey); assert.equal(ui.requests[0].url.href.includes(zoteroKey), false);
  assert.equal(text(ui.view.root).includes(zoteroKey), false); assert.equal(ui.adoptions.length, 0);
  await ui.click('确认采用这轮更新'); assert.equal(JSON.stringify(ui.adoptions[0][0]).includes(zoteroKey), false);
  assert.equal(await ui.store.get(zoteroSecretNamespace(zoteroAccount, zoteroConfig), ZOTERO_SECRET_KEY), null);
});

test('saving/removing a key is explicit, account/source-scoped, and does not start an API read', async t => {
  const ui = await setup(t, [zoteroResponse([]), zoteroDeleted()]);
  ui.keyInput.value = zoteroKey; await ui.click('保存此文库密钥');
  const namespace = zoteroSecretNamespace(zoteroAccount, zoteroConfig);
  assert.equal(await ui.store.get(namespace, ZOTERO_SECRET_KEY), zoteroKey); assert.equal(ui.requests.length, 0); assert.equal(ui.keyInput.value, '');
  assert.match(text(ui.view.root), /仅保存在当前应用内存/);
  await ui.change('读取凭据', 'stored'); await ui.click('读取 Zotero 更新');
  assert.equal(ui.requests[0].headers.get('Zotero-API-Key'), zoteroKey); assert.equal(ui.state.cursor, null);
  await ui.click('移除此文库密钥'); assert.equal(await ui.store.get(namespace, ZOTERO_SECRET_KEY), null);
  assert.equal(ui.requests.length, 2);
});

test('a late secret-storage completion cannot clear a new account key draft or show the old account status', async t => {
  const gate = deferred<void>(), store = new MemorySecretStore(), saved: [string, string, string][] = [];
  store.set = async (namespace, key, value) => { saved.push([namespace, key, value]); return gate.promise; };
  const ui = await setup(t, [], { props: { secretStore: store } });
  ui.keyInput.value = zoteroKey; await ui.click('保存此文库密钥');
  assert.equal(ui.keyInput.value, ''); assert.equal(saved.length, 1);
  await ui.update({ scopeKey: 'account-two-generation-one', accountScope: { ...zoteroAccount, accountId: id(2) } });
  ui.keyInput.value = 'NewAccountDraftKey23456789';
  gate.resolve(); await flush();
  assert.equal(ui.keyInput.value, 'NewAccountDraftKey23456789'); assert.doesNotMatch(text(ui.view.root), /密钥仅保存在|密钥已写入/);
  assert.equal(saved[0][0], zoteroSecretNamespace(zoteroAccount, zoteroConfig)); assert.equal(ui.requests.length, 0);
});

test('duplicate adopt clicks call the transaction once and a late result cannot announce success in another account', async t => {
  const gate = deferred<ReturnType<typeof materializeExternalLibraryImport>['summary']>(); let commits = 0;
  const ui = await setup(t, [zoteroResponse([zoteroItem(1, 2)], 2), zoteroDeleted([], 2)], { props: {
    onAdopt: async () => { commits++; return gate.promise; },
  } });
  await ui.click('读取 Zotero 更新'); const adopt = ui.button('确认采用这轮更新').props.onClick;
  await act(async () => { adopt(); adopt(); }); assert.equal(commits, 1);
  await ui.update({ scopeKey: 'account-two-generation-one', accountScope: { ...zoteroAccount, accountId: id(2) } });
  const summary = planExternalLibraryImport(parseExternalLibrary(JSON.stringify([zoteroItem(1, 2)])).snapshot, undefined, []).summary;
  gate.resolve(summary); await flush();
  assert.equal(commits, 1); assert.doesNotMatch(text(ui.view.root), /已采用本轮更新/); assert.equal(ui.state.cursor, null);
});

test('rate-limit and transaction failures show safe actionable messages without remote/private diagnostics', async t => {
  const limited = await setup(t, [new Response('private response details', { status: 429, headers: { 'Retry-After': '3600' } })]);
  await limited.click('读取 Zotero 更新'); assert.match(text(limited.view.root), /Zotero 要求暂缓请求/);
  assert.match(text(limited.view.root), /最早重试时间/); assert.doesNotMatch(text(limited.view.root), /private response details/);
  await limited.click('读取 Zotero 更新'); assert.equal(limited.requests.length, 1);
  const failed = await setup(t, [zoteroResponse([zoteroItem(1, 2)], 2), zoteroDeleted([], 2)], { props: {
    onAdopt: async () => { throw new Error('private transaction details'); },
  } });
  await failed.click('读取 Zotero 更新'); await failed.click('确认采用这轮更新');
  assert.match(text(failed.view.root), /本次操作未完成/); assert.doesNotMatch(text(failed.view.root), /private transaction details/);
  assert.equal(failed.state.cursor, null); assert.equal(failed.state.entities.length, 0);
  assert.equal(failed.button('确认采用这轮更新').props.disabled, false);
});

test('unmount aborts a pending read and no late busy event or secret input remains', async t => {
  const gate = deferred<Response>(), ui = await setup(t, [() => gate.promise]);
  await ui.click('读取 Zotero 更新'); ui.keyInput.value = zoteroKey;
  await ui.unmount(); assert.equal(ui.requests[0].init.signal?.aborted, true); assert.equal(ui.keyInput.value, '');
  const count = ui.busy.length; gate.resolve(zoteroResponse([zoteroItem()])); await flush();
  assert.equal(ui.busy.length, count); assert.equal(ui.requests.length, 1); assert.equal(ui.adoptions.length, 0);
});
