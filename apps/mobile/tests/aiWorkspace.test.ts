import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AiWorkspace } from '../src/components/AiWorkspace.tsx';
import { AI_SECRET_KEY, LocalAiConfigStore, aiSecretNamespace, defaultAiProvider } from '../src/ai/provider.ts';
import type { AiProviderConfig, AiSaveContext, AiTransport, AiWorkspaceProps, PdfAiContext, PdfCitationTarget } from '../src/ai/types.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import type { NoteData } from '../../../packages/sync-core/src/index.ts';

const KEY = 'ui-fixture-secret-never-live';
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SCOPE = { apiBaseUrl: 'https://sync.example.invalid/v1', accountId: ACCOUNT };
const CONTEXT: PdfAiContext = { paperId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', attachmentVersionId: VERSION, sha256: 'a'.repeat(64),
  scope: 'page', totalPages: 3, pages: [{ pageIndex: 1, text: '真实传入组件的合成文字。' }], complete: true, label: '组件合成文献' };
const CONFIG: AiProviderConfig = { ...defaultAiProvider(), endpoint: 'https://provider.example.invalid/v1', model: 'ui-fixture', stream: false };
function text(node: ReactTestInstance | string | number): string { return typeof node === 'object' ? node.children.map(text).join('') : String(node); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const jsonResponse = (body: string) => new Response(JSON.stringify({ choices: [{ index: 0, message: { content: body }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for ' + description);
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); });
  }
}

async function setup(options: { key?: boolean; config?: AiProviderConfig; transport?: AiTransport; onSaveNote?: AiWorkspaceProps['onSaveNote'] } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const config = options.config ?? CONFIG;
  new LocalAiConfigStore(storage).save(SCOPE, config);
  const secrets = new MemorySecretStore();
  if (options.key !== false) await secrets.set(await aiSecretNamespace(SCOPE, config), AI_SECRET_KEY, KEY);
  const requests: Parameters<AiTransport['request']>[0][] = [];
  const transport = options.transport ?? { kind: 'fetch' as const, supportsStreaming: true, redirectPolicy: 'error' as const,
    request: async (input: Parameters<AiTransport['request']>[0]) => {
      requests.push(input);
      return input.method === 'GET' ? new Response(JSON.stringify({ data: [{ id: 'ui-fixture' }] })) : jsonResponse('<img src=x onerror=alert(1)> 引用 [P2]，未知 [P99]。' + KEY);
    } };
  const saved: { note: NoteData; source: AiSaveContext }[] = []; const jumps: PdfCitationTarget[] = [];
  let props: AiWorkspaceProps = { accountScope: SCOPE, context: CONTEXT, secretStore: secrets, transport,
    onSaveNote: options.onSaveNote ?? (async (note, source) => { saved.push({ note, source }); }), onNavigateCitation: (target) => { jumps.push(target); } };
  const password = { value: '' };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(AiWorkspace, props), { createNodeMock: (element) => element.type === 'input' && element.props.type === 'password' ? password : null });
    await tick(); await tick();
  });
  await until(() => !text(renderer.root).includes('正在检查存储…'), 'initial secret lookup');
  const button = (label: string) => {
    const result = renderer.root.findAllByType('button').find((entry) => text(entry) === label);
    assert.ok(result, 'Missing button: ' + label); return result;
  };
  const input = (suffix: string) => {
    const result = renderer.root.findAll((entry) => (entry.type === 'input' || entry.type === 'textarea') && typeof entry.props.id === 'string' && entry.props.id.endsWith('-' + suffix))[0];
    assert.ok(result, 'Missing input: ' + suffix); return result;
  };
  const update = async (change: Partial<AiWorkspaceProps>) => {
    props = { ...props, ...change };
    await act(async () => { renderer.update(createElement(AiWorkspace, props)); await tick(); await tick(); });
  };
  const submit = async () => { await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); await tick(); await tick(); }); };
  const close = () => {
    act(() => renderer.unmount());
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage');
  };
  return { renderer, button, input, update, submit, close, password, secrets, requests, saved, jumps, values };
}

test('workspace performs no automatic model request; explicit question, result, verified citation and note save stay scoped', async () => {
  const ui = await setup();
  try {
    assert.equal(ui.requests.length, 0);
    assert.ok(text(ui.renderer.root).includes('当前页可提取文本'));
    assert.ok(text(ui.renderer.root).includes('不代表已阅读全文'));
    act(() => ui.button('提问').props.onClick());
    assert.equal(ui.button('发送并提问').props.disabled, true);
    act(() => ui.input('question').props.onChange({ target: { value: '研究方法是什么？' } }));
    assert.equal(ui.button('发送并提问').props.disabled, false);
    await ui.submit();
    await until(() => text(ui.renderer.root).includes('响应完成'), 'first response');
    assert.equal(ui.requests.length, 1);
    const request = JSON.parse(ui.requests[0].body!);
    assert.ok(request.messages[1].content.includes(CONTEXT.pages[0].text));
    assert.ok(request.messages[1].content.includes('研究方法是什么？'));
    assert.equal(ui.requests[0].headers.Authorization, 'Bearer ' + KEY);
    assert.equal(ui.renderer.root.findAllByType('img').length, 0);
    assert.ok(text(ui.renderer.root).includes('<img src=x onerror=alert(1)>'));
    assert.equal(JSON.stringify(ui.renderer.toJSON()).includes(KEY), false);
    assert.ok(text(ui.renderer.root).includes('这些引用未经核验，不能跳转'));
    assert.equal(ui.renderer.root.findAllByType('button').some((entry) => text(entry) === '第 99 页'), false);
    act(() => ui.button('第 2 页').props.onClick());
    assert.equal(ui.jumps.length, 1); assert.equal(ui.jumps[0].attachmentVersionId, VERSION); assert.equal(ui.jumps[0].sha256, CONTEXT.sha256);
    await act(async () => { ui.button('保存为文献笔记').props.onClick(); await tick(); });
    assert.equal(ui.saved.length, 1); assert.deepEqual(ui.saved[0].source.accountScope, SCOPE);
    assert.equal(ui.saved[0].note.paperId, CONTEXT.paperId); assert.ok(ui.saved[0].note.body.includes(VERSION));
    assert.equal(JSON.stringify(ui.saved).includes(KEY), false);
    assert.equal(JSON.stringify([...ui.values]).includes(KEY), false);
    assert.ok(text(ui.renderer.root).includes('已保存为文献笔记'));
  } finally { ui.close(); }
});

test('password input is never prefilled or placed in rendered state; saving/removing and endpoint changes are explicit', async () => {
  const ui = await setup({ key: false });
  try {
    assert.equal(ui.input('key').props.value, undefined);
    assert.equal(ui.button('发送并解释').props.disabled, true);
    ui.password.value = KEY;
    act(() => ui.input('key').props.onChange({ target: ui.password }));
    assert.equal(await ui.secrets.get(await aiSecretNamespace(SCOPE, CONFIG), AI_SECRET_KEY), null);
    assert.equal(ui.requests.length, 0);
    await act(async () => { ui.button('保存本设备密钥').props.onClick(); await tick(); await tick(); });
    await until(() => !ui.button('发送并解释').props.disabled, 'saved key availability');
    assert.equal(ui.password.value, '');
    assert.equal(await ui.secrets.get(await aiSecretNamespace(SCOPE, CONFIG), AI_SECRET_KEY), KEY);
    assert.equal(ui.button('发送并解释').props.disabled, false);
    assert.equal(JSON.stringify(ui.renderer.toJSON()).includes(KEY), false);
    assert.equal(JSON.stringify([...ui.values]).includes(KEY), false);
    await act(async () => { ui.button('测试连接 / 获取模型').props.onClick(); await tick(); await tick(); });
    await until(() => text(ui.renderer.root).includes('已连通模型列表接口'), 'model discovery');
    assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].method, 'GET');
    assert.ok(text(ui.renderer.root).includes('推理权限与费用仍需向服务商确认'));
    await act(async () => { ui.button('移除密钥').props.onClick(); await tick(); await tick(); });
    await until(() => text(ui.renderer.root).includes('已移除此服务'), 'key removal');
    assert.equal(await ui.secrets.get(await aiSecretNamespace(SCOPE, CONFIG), AI_SECRET_KEY), null);
    ui.password.value = KEY; act(() => ui.input('key').props.onChange({ target: ui.password }));
    await act(async () => { ui.input('endpoint').props.onChange({ target: { value: 'https://another-provider.example.invalid/v1' } }); await tick(); });
    assert.equal(ui.password.value, ''); assert.equal(ui.button('发送并解释').props.disabled, true);
    assert.equal(ui.requests.length, 1);
  } finally { ui.close(); }
});

test('changing attachment or account discards a pending response and never targets the new account with its save callback', async () => {
  const pending = deferred<Response>(); const started = deferred<void>();
  const transport: AiTransport = { kind: 'fetch', supportsStreaming: false, redirectPolicy: 'error', request: async () => { started.resolve(); return pending.promise; } };
  const ui = await setup({ transport });
  try {
    await ui.submit(); await started.promise;
    assert.ok(text(ui.renderer.root).includes('正在等待模型响应'));
    await ui.update({ context: { ...CONTEXT, attachmentVersionId: OTHER, sha256: 'b'.repeat(64), pages: [{ pageIndex: 2, text: '新版本文字' }] } });
    pending.resolve(jsonResponse('旧版本的迟到结果 [P2]'));
    await act(async () => { await tick(); await tick(); });
    assert.equal(text(ui.renderer.root).includes('旧版本的迟到结果'), false);
    assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': '模型结果' }).length, 0);
    await ui.update({ accountScope: { ...SCOPE, accountId: OTHER } });
    assert.equal(ui.input('question').props.value, '');
    assert.equal(ui.input('model').props.value, '');
    assert.equal(ui.saved.length, 0);
  } finally { ui.close(); }
});

test('a note save already in progress retains its captured source and cannot report success in another attachment', async () => {
  const save = deferred<void>(); const captured: AiSaveContext[] = [];
  const ui = await setup({ onSaveNote: async (_note, source) => { captured.push(source); await save.promise; } });
  try {
    await ui.submit();
    await until(() => text(ui.renderer.root).includes('响应完成'), 'response before save');
    act(() => ui.button('保存为文献笔记').props.onClick());
    assert.equal(captured.length, 1); assert.equal(captured[0].attachmentVersionId, VERSION);
    await ui.update({ context: { ...CONTEXT, attachmentVersionId: OTHER, sha256: 'b'.repeat(64) } });
    await act(async () => { save.resolve(); await tick(); });
    assert.equal(text(ui.renderer.root).includes('已保存为文献笔记'), false);
    assert.equal(captured.length, 1); assert.deepEqual(captured[0].accountScope, SCOPE);
  } finally { ui.close(); }
});

test('cancel control preserves partial output with unknown usage, and explicit save labels it incomplete', async () => {
  let cancelled = false;
  const transport: AiTransport = { kind: 'fetch', supportsStreaming: true, redirectPolicy: 'error', request: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '已收到部分文字 [P2]' }, finish_reason: null }] }) + '\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) };
  const ui = await setup({ config: { ...CONFIG, stream: true }, transport });
  try {
    await ui.submit();
    await until(() => text(ui.renderer.root).includes('已收到部分文字'), 'partial stream output');
    assert.ok(text(ui.renderer.root).includes('已收到部分文字'));
    let prevented = false;
    await act(async () => { ui.button('取消生成').props.onClick({ preventDefault() { prevented = true; } }); await tick(); });
    assert.equal(prevented, true);
    assert.equal(cancelled, true); assert.ok(text(ui.renderer.root).includes('部分结果'));
    assert.ok(text(ui.renderer.root).includes('用量未知'));
    await act(async () => { ui.button('将部分结果保存为笔记').props.onClick(); await tick(); });
    assert.equal(ui.saved.length, 1); assert.ok(ui.saved[0].note.body.includes('可能不完整'));
  } finally { ui.close(); }
});

test('a failed new request exposes a labeled previous-result switch and saves the selected original output', async () => {
  let requests = 0;
  const transport: AiTransport = { kind: 'fetch', supportsStreaming: false, redirectPolicy: 'error', request: async () => {
    requests++;
    return requests === 1 ? jsonResponse('上一次的解释正文 [P2]') : new Response('raw failure ' + KEY, { status: 401 });
  } };
  const ui = await setup({ transport });
  try {
    await ui.submit();
    await until(() => text(ui.renderer.root).includes('响应完成'), 'retained original response');
    act(() => ui.button('摘要').props.onClick());
    await ui.submit();
    await until(() => text(ui.renderer.root).includes('服务拒绝了 API 密钥'), 'failed subsequent request');
    assert.ok(text(ui.renderer.root).includes('服务拒绝了 API 密钥'));
    assert.ok(text(ui.renderer.root).includes('未取得结果'));
    act(() => ui.button('上一次结果').props.onClick());
    assert.ok(text(ui.renderer.root).includes('上一次 · 解释结果'));
    assert.ok(text(ui.renderer.root).includes('上一次的解释正文'));
    assert.ok(text(ui.renderer.root).includes('版本 ' + VERSION.slice(0, 8)));
    await act(async () => { ui.button('保存为文献笔记').props.onClick(); await tick(); });
    assert.equal(ui.saved.length, 1); assert.ok(ui.saved[0].note.body.startsWith('上一次的解释正文'));
    act(() => ui.button('第 2 页').props.onClick());
    assert.equal(ui.jumps[0].requestId, ui.saved[0].source.requestId);
    await ui.update({ context: { ...CONTEXT, attachmentVersionId: OTHER } });
    assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': '切换内存中的结果' }).length, 0);
    assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': '模型结果' }).length, 0);
  } finally { ui.close(); }
});

test('a pending device-key save settles after model/context changes without leaving the controls locked', async () => {
  const ui = await setup({ key: false });
  const entered = deferred<void>(); const release = deferred<void>();
  const originalSet = ui.secrets.set.bind(ui.secrets);
  ui.secrets.set = async (namespace, key, value) => { entered.resolve(); await release.promise; await originalSet(namespace, key, value); };
  try {
    ui.password.value = KEY;
    act(() => ui.input('key').props.onChange({ target: ui.password }));
    act(() => ui.button('保存本设备密钥').props.onClick());
    await entered.promise;
    act(() => ui.input('model').props.onChange({ target: { value: 'changed-model' } }));
    await ui.update({ context: { ...CONTEXT, attachmentVersionId: OTHER } });
    await act(async () => { release.resolve(); await tick(); await tick(); });
    await until(() => !ui.button('发送并解释').props.disabled, 'key save after model/context change');
    assert.equal(ui.input('key').props.disabled, false);
    assert.equal(ui.button('发送并解释').props.disabled, false);
    assert.equal(await ui.secrets.get(await aiSecretNamespace(SCOPE, CONFIG), AI_SECRET_KEY), KEY);
    assert.equal(ui.requests.length, 0);
  } finally { release.resolve(); ui.close(); }
});
