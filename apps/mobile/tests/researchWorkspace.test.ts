import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { IDBFactory } from 'fake-indexeddb';
import { AccountStore } from '../src/storage/accountStore.ts';
import { decodeWorkspace, WorkspaceController } from '../src/sync/workspace.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import { LocalAiConfigStore, defaultAiProvider } from '../src/ai/provider.ts';
import type { AiTransport } from '../src/ai/types.ts';
import { id, scope, paper, now, completion } from './reviewFixtures.ts';

registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);
} });
const { ResearchWorkspace } = await import('../src/components/ResearchWorkspace.tsx');
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
function button(renderer: ReactTestRenderer, label: string) {
  const found = renderer.root.findAllByType('button').find(node => text(node) === label || node.props['aria-label'] === label);
  assert.ok(found, 'Missing button: ' + label); return found;
}
async function click(renderer: ReactTestRenderer, label: string) {
  const found = button(renderer, label); assert.ok(!found.props.disabled, label + ' disabled');
  await act(async () => { found.props.onClick(); });
}
async function until(check: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (check()) return;
    await act(async () => { await delay(5); });
  }
  assert.fail('Research UI did not settle within 5 seconds');
}
async function setup(t: TestContext, configured = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  if (configured) new LocalAiConfigStore(localStorage).save(scope, { ...defaultAiProvider(), model: 'previous-model', requiresKey: false, stream: false });
  const store = new AccountStore({ decode: decodeWorkspace, indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() });
  const controller = new WorkspaceController({ apiBaseUrl: scope.apiBaseUrl, store, online: false, api: {
    register: async () => ({ accountId: scope.accountId, device: { id: id(20), name: 'Research UI', platform: 'web', createdAt: now, lastSeenAt: now, revokedAt: null } }),
    devices: async () => [], revokeDevice: async () => {}, conflicts: async () => ({ conflicts: [], nextCursor: 'done', hasMore: false }),
    push: async () => { throw Error('No sync request expected'); }, pull: async () => { throw Error('No sync request expected'); }, resolveConflict: async () => { throw Error('No sync request expected'); },
  } });
  await controller.bind('Research UI');
  await controller.save({ entityType: 'paper', entityId: id(2), mutation: 'put', data: paper }, 0);
  let calls = 0;
  const transport: AiTransport = { kind: 'fetch', supportsStreaming: false, redirectPolicy: 'error', request: async () => {
    calls++; return new Response(JSON.stringify(completion('Synthetic comparison [S1E1].')), { headers: { 'content-type': 'application/json' } });
  } };
  const sync = controller.getSnapshot().workspace!.sync;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ResearchWorkspace, {
    scope, scopeKey: JSON.stringify([sync.accountId, sync.deviceId, sync.generation]), controller,
    secretStore: new MemorySecretStore(), transport, accountCurrent: () => true, onClose() {},
  })); });
  t.after(async () => { await act(async () => renderer.unmount()); controller.deactivate(); await store.close(); });
  const question = () => renderer.root.findAllByType('textarea').find(node => node.props.id?.endsWith('-question'))!;
  const selected = () => renderer.root.findAllByType('input').find(node => node.props.type === 'checkbox')!;
  await act(async () => {
    selected().props.onChange({ target: { checked: true } });
    question().props.onChange({ target: { value: '比较这些材料的研究方法' } });
    renderer.root.findAllByType('select').find(node => node.props.id?.endsWith('-mode'))!.props.onChange({ target: { value: 'selected' } });
  });
  return { renderer, controller, calls: () => calls, question, selected };
}

test('research configures AI in place and keeps the question and source without sending a request', async t => {
  const ui = await setup(t);
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  let firstDigest = true;
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<typeof nativeDigest>) => {
    if (firstDigest) { firstDigest = false; await delay(200); }
    return nativeDigest(...args);
  });
  await click(ui.renderer, '准备并预览发送内容');
  await until(() => ui.renderer.root.findAllByProps({ 'aria-label': '实际发送内容' }).length === 1);
  await click(ui.renderer, '设置 AI');
  assert.equal(ui.question().props.value, '比较这些材料的研究方法');
  assert.equal(ui.selected().props.checked, true);
  assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': '实际发送内容' }).length, 0);
  await click(ui.renderer, '连接自己的 AI 服务');
  await act(async () => {
    ui.renderer.root.findAllByType('input').find(node => node.props.id?.endsWith('-model'))!.props.onChange({ target: { value: 'new-research-model' } });
    const keyOption = ui.renderer.root.findAllByType('label').find(node => text(node) === '此服务需要访问密钥')!;
    keyOption.findByType('input').props.onChange({ target: { checked: false } });
  });
  await click(ui.renderer, '保存设置');
  await until(() => ui.renderer.root.findAllByProps({ 'aria-label': 'AI 服务设置' }).length === 0);
  assert.equal(ui.question().props.value, '比较这些材料的研究方法');
  assert.equal(ui.selected().props.checked, true);
  assert.equal(ui.calls(), 0);
  await click(ui.renderer, '准备并预览发送内容');
  await until(() => text(ui.renderer.root).includes('模型：new-research-model'));
  assert.equal(ui.calls(), 0);
  await click(ui.renderer, '发送以上片段并提问');
  await until(() => text(ui.renderer.root).includes('Synthetic comparison'));
  assert.equal(ui.calls(), 1);
});

test('opening and cancelling AI settings retires an earlier research send callback and retains received output', async t => {
  const ui = await setup(t, true);
  await click(ui.renderer, '准备并预览发送内容');
  await until(() => text(ui.renderer.root).includes('模型：previous-model'));
  const oldSend = button(ui.renderer, '发送以上片段并提问').props.onClick;
  await click(ui.renderer, '更换 AI');
  await click(ui.renderer, '返回多篇问答');
  await act(async () => { oldSend(); });
  assert.equal(ui.calls(), 0);
  assert.equal(ui.question().props.value, '比较这些材料的研究方法');
  assert.equal(ui.selected().props.checked, true);
  await click(ui.renderer, '准备并预览发送内容');
  await until(() => text(ui.renderer.root).includes('模型：previous-model'));
  await click(ui.renderer, '发送以上片段并提问');
  await until(() => text(ui.renderer.root).includes('Synthetic comparison'));
  await click(ui.renderer, '更换 AI');
  await click(ui.renderer, '返回多篇问答');
  assert.ok(text(ui.renderer.root).includes('Synthetic comparison'));
  assert.equal(ui.calls(), 1);
});

test('task settings protect unsaved fields on close and refresh without changing the research draft', async t => {
  const ui = await setup(t, true), originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = Object.assign(new EventTarget(), { confirm: (): boolean => false });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  t.after(() => { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); });
  await click(ui.renderer, '更换 AI'); await click(ui.renderer, '连接自己的 AI 服务');
  await act(async () => {
    ui.renderer.root.findAllByType('input').find(node => node.props.id?.endsWith('-model'))!.props.onChange({ target: { value: 'unsaved-model' } });
  });
  const event = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(event, 'returnValue', { writable: true, value: 'original' });
  browser.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  await click(ui.renderer, '关闭AI 设置');
  assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': 'AI 服务设置' }).length, 1);
  assert.equal(ui.renderer.root.findAllByType('input').find(node => node.props.id?.endsWith('-model'))!.props.value, 'unsaved-model');
  assert.equal(new LocalAiConfigStore(localStorage).load(scope).model, 'previous-model');
  browser.confirm = () => true; await click(ui.renderer, '关闭AI 设置');
  assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': 'AI 服务设置' }).length, 0);
  assert.equal(ui.question().props.value, '比较这些材料的研究方法'); assert.equal(ui.selected().props.checked, true);
  assert.equal(ui.calls(), 0);
  const after = new Event('beforeunload', { cancelable: true }); browser.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
});
