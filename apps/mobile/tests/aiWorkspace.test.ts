import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AiWorkspace } from '../src/components/AiWorkspace.tsx';
import { AI_SECRET_KEY, LocalAiConfigStore, aiSecretNamespace, defaultAiProvider } from '../src/ai/provider.ts';
import type { AiProviderConfig, AiSaveContext, AiTransport, AiWorkspaceProps, PdfAiContext, PdfCitationTarget } from '../src/ai/types.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';
import { createModelRouteProvider } from '../src/modelRouting/config.ts';
import type { NoteData } from '../../../packages/sync-core/src/index.ts';
import { createAiConversation, appendAiConversation } from '../../../packages/ai-core/src/conversation.ts';
import { validateAiArchiveItem, type AiHistoryRecord } from '../src/ai/archiveTypes.ts';

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

async function setup(options: { key?: boolean; mode?: AiWorkspaceProps['mode']; config?: AiProviderConfig; context?: PdfAiContext | null; transport?: AiTransport; onSaveNote?: AiWorkspaceProps['onSaveNote']; onSettingsDirty?: AiWorkspaceProps['onSettingsDirty']; onSettingsSaved?: AiWorkspaceProps['onSettingsSaved']; sync?:AiWorkspaceProps['sync']; modelRouter?:AiWorkspaceProps['modelRouter'] } = {}) {
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
  let props: AiWorkspaceProps = { mode: options.mode, accountScope: SCOPE, context: options.context === undefined ? CONTEXT : options.context, secretStore: secrets, transport,
    sync:options.sync, modelRouter:options.modelRouter, onSettingsDirty: options.onSettingsDirty, onSettingsSaved: options.onSettingsSaved,
    onSaveNote: options.onSaveNote ?? (async (note, source) => { saved.push({ note, source }); }), onNavigateCitation: (target) => { jumps.push(target); } };
  const password = { value: '' };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(AiWorkspace, props), { createNodeMock: (element) => element.type === 'input' && element.props.type === 'password' ? password : null });
    await tick(); await tick();
  });
  await until(() => !text(renderer.root).includes('正在检查存储…'), 'initial secret lookup');
  const button = (label: string) => {
    const result = renderer.root.findAllByType('button').find((entry) => text(entry) === label || entry.props['aria-label'] === label);
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
  const openSettings = () => act(() => button('连接自己的 AI 服务').props.onClick());
  return { renderer, button, input, update, submit, close, password, secrets, requests, saved, jumps, values, storage, openSettings };
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

test('parsed context preview, transmitted text and saved note retain their distinct source metadata', async () => {
  const textSource = { kind: 'parsed-document' as const, packageDigest: 'd'.repeat(64), parserName: 'mineru' as const, parserModel: 'vlm' };
  const context = { ...CONTEXT, complete: false, textSource };
  const ui = await setup({ context });
  try {
    assert.equal(ui.requests.length, 0);
    assert.match(text(ui.renderer.root), /当前页解析文本/); assert.match(text(ui.renderer.root), /OCR/);
    assert.match(text(ui.renderer.root), /不发送图片像素/);
    await ui.submit(); await until(() => text(ui.renderer.root).includes('响应完成'), 'parsed response');
    assert.equal(ui.requests.length, 1);
    const sent = JSON.stringify(JSON.parse(ui.requests[0].body!).messages);
    assert.ok(sent.includes(CONTEXT.pages[0].text)); assert.match(sent, /OCR/);
    assert.ok(!sent.includes(textSource.packageDigest));
    await act(async () => { ui.button('保存为文献笔记').props.onClick(); await tick(); });
    assert.equal(ui.saved.length, 1); assert.ok(ui.saved[0].note.body.includes(textSource.packageDigest));
    assert.match(ui.saved[0].note.body, /导入的 MinerU 解析包/);
    await ui.update({ context: { ...context, textSource: { ...textSource, packageDigest: 'e'.repeat(64) } } });
    assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': '模型结果' }).length, 0);
    assert.equal(ui.requests.length, 1);
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
    await act(async () => { ui.button('保存设置').props.onClick(); await tick(); await tick(); });
    await until(() => !ui.button('发送并解释').props.disabled, 'saved key availability');
    assert.equal(ui.password.value, '');
    assert.equal(await ui.secrets.get(await aiSecretNamespace(SCOPE, CONFIG), AI_SECRET_KEY), KEY);
    assert.equal(ui.button('发送并解释').props.disabled, false);
    assert.equal(JSON.stringify(ui.renderer.toJSON()).includes(KEY), false);
    assert.equal(JSON.stringify([...ui.values]).includes(KEY), false);
    await act(async () => { ui.button('获取可用模型').props.onClick(); await tick(); await tick(); });
    await until(() => text(ui.renderer.root).includes('已取得 1 个模型'), 'model discovery');
    assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].method, 'GET');
    assert.ok(text(ui.renderer.root).includes('能否生成回答和实际费用仍由服务商决定'));
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
    act(() => ui.button('保存设置').props.onClick());
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

test('a full 24-turn synchronized conversation can be viewed but cannot issue a 25th paid request',async()=>{
  const item=(n:number)=>validateAiArchiveItem({kind:'record',version:1,revision:1,id:crypto.randomUUID(),createdAt:`2026-10-28T00:00:${String(n*2).padStart(2,'0')}.000Z`,
    updatedAt:`2026-10-28T00:00:${String(n*2+1).padStart(2,'0')}.000Z`,context:CONTEXT,action:'ask',question:'问题'+n,
    provider:{id:CONFIG.id,endpoint:CONFIG.endpoint,model:CONFIG.model},result:{text:'已完成回答 [P2]',status:'complete',finishReason:'stop',usage:null,cost:'unknown',failure:null}}) as AiHistoryRecord;
  let data=createAiConversation(item(0));for(let n=1;n<24;n++)data=appendAiConversation(data,item(n));
  const ui=await setup({sync:{enabled:true,conversations:[{id:crypto.randomUUID(),revision:1,data,status:'synced',conflicted:false}],templates:[],
    async saveConversation(){throw new Error('unexpected write');},async saveTemplate(){throw new Error('unexpected write');},async remove(){throw new Error('unexpected delete');}}});
  try{
    act(()=>ui.button(CONTEXT.label+' · 24 轮').props.onClick());
    act(()=>ui.button('用已保存原文继续此会话').props.onClick());
    assert.equal(ui.button('发送并解释').props.disabled,true);
    await ui.submit();assert.equal(ui.requests.length,0);assert.match(text(ui.renderer.root),/此会话已达24轮上限/);
    act(()=>ui.button('结束继续，另开问答').props.onClick());assert.equal(ui.button('发送并解释').props.disabled,false);
  }finally{ui.close();}
});

test('settings opens with simple connection choices, hides fields until asked, and does not read or call task services', async () => {
  let activityReads = 0, inventoryReads = 0;
  const snapshot = { revision: 0, pendingIds: [] as string[] };
  const router = { current: () => true, subscribe: () => () => {}, getSnapshot: () => snapshot,
    readActivity: async () => { activityReads++; throw Error('Settings must not read task records'); },
    inventory: async () => { inventoryReads++; throw Error('Explicit only'); } } as unknown as NonNullable<AiWorkspaceProps['modelRouter']>;
  const ui = await setup({ mode: 'settings', modelRouter: router });
  try {
    assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': 'AI 服务设置' }).length, 1);
    assert.equal(ui.renderer.root.findAllByType('form').length, 0);
    assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': '选择辅助任务' }).length, 0);
    assert.equal(ui.renderer.root.findAllByProps({ className: 'ai-context' }).length, 0);
    assert.equal(ui.renderer.root.findAllByProps({ className: 'model-route-history' }).length, 0);
    assert.doesNotMatch(text(ui.renderer.root), /从正在读的内容开始|本次发送范围|同步会话与模板|本机问答记录与问题模板|先在阅读器中选择/);
    assert.equal(ui.renderer.root.findAllByType('input').length, 0);
    assert.match(text(ui.renderer.root), /使用账号或电脑上的 AI/);
    assert.equal(activityReads, 0); assert.equal(inventoryReads, 0);
    ui.openSettings();
    const fields = ui.renderer.root.findAllByType('input').filter(node => /-(endpoint|key|model)$/.test(node.props.id ?? '')).map(node => node.props.id.split('-').at(-1));
    assert.deepEqual(fields, ['endpoint', 'key', 'model']);
    const advanced = ui.renderer.root.findByProps({ className: 'ai-advanced' });
    assert.equal(Boolean(advanced.props.open), false);
    assert.equal(advanced.findAllByType('input').filter(node => node.props.type === 'checkbox').length, 3);
    assert.equal(activityReads, 0); assert.equal(inventoryReads, 0); assert.equal(ui.requests.length, 0);
    assert.equal(ui.saved.length, 0); assert.equal(ui.jumps.length, 0);
  } finally { ui.close(); }
});

test('settings has one explicit save for key and model, gives a next step, and never generates a model response', async (t) => {
  const readKey = MemorySecretStore.prototype.get;
  let initialKeyRead = true;
  t.mock.method(MemorySecretStore.prototype, 'get', async function (this: MemorySecretStore, namespace: string, key: string) {
    if (initialKeyRead) {
      initialKeyRead = false;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    return readKey.call(this, namespace, key);
  });
  const config = { ...CONFIG, model: '' };
  const ui = await setup({ mode: 'settings', context: null, config, key: false });
  const saveKey = ui.secrets.set.bind(ui.secrets);
  t.mock.method(ui.secrets, 'set', async (...args: Parameters<MemorySecretStore['set']>) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await saveKey(...args);
  });
  try {
    ui.openSettings();
    await until(() => !text(ui.renderer.root).includes('正在检查已保存的密钥'), 'initial settings key availability');
    assert.equal(ui.button('获取可用模型').props.disabled, true);
    assert.match(text(ui.renderer.root), /先填写访问密钥并保存/);
    ui.password.value = KEY;
    act(() => ui.input('key').props.onChange({ target: ui.password }));
    assert.match(text(ui.renderer.root), /先保存新输入的密钥/);
    act(() => ui.input('model').props.onChange({ target: { value: 'saved-settings-model' } }));
    assert.equal(ui.renderer.root.findAllByType('button').filter(node => text(node) === '保存设置').length, 1);
    assert.equal(await ui.secrets.get(await aiSecretNamespace(SCOPE, config), AI_SECRET_KEY), null);
    await act(async () => { ui.button('保存设置').props.onClick(); await tick(); await tick(); });
    await until(() => text(ui.renderer.root).includes('设置已保存'), 'settings save completion');
    assert.equal(ui.renderer.root.findAllByType('input').length, 0);
    assert.match(text(ui.renderer.root), /saved-settings-model/);
    ui.openSettings();
    await until(() => !ui.button('获取可用模型').props.disabled, 'single-save key availability');
    assert.equal(new LocalAiConfigStore(ui.storage).load(SCOPE).model, 'saved-settings-model');
    assert.equal(await ui.secrets.get(await aiSecretNamespace(SCOPE, config), AI_SECRET_KEY), KEY);
    assert.equal(ui.password.value, '');
    assert.equal(JSON.stringify(ui.renderer.toJSON()).includes(KEY), false);
    assert.equal(JSON.stringify([...ui.values]).includes(KEY), false);
    assert.equal(ui.requests.length, 0);
    await act(async () => { ui.button('获取可用模型').props.onClick(); await tick(); await tick(); });
    await until(() => text(ui.renderer.root).includes('已取得 1 个模型'), 'explicit settings discovery');
    assert.equal(ui.requests.length, 1); assert.equal(ui.requests[0].method, 'GET');
    assert.equal(ui.requests[0].body, undefined);
    assert.equal(ui.saved.length, 0);
  } finally { ui.close(); }
});

test('settings discovery can be cancelled without a reading composer and ignores its late response', async () => {
  const pending = deferred<Response>(), started = deferred<void>();
  let requestSignal: AbortSignal | undefined;
  const ui = await setup({ mode: 'settings', context: null, config: { ...CONFIG, requiresKey: false }, key: false,
    transport: { kind: 'fetch', supportsStreaming: false, redirectPolicy: 'error', request: async input => { requestSignal = input.signal; started.resolve(); return pending.promise; } } });
  try {
    ui.openSettings();
    act(() => ui.button('获取可用模型').props.onClick());
    await started.promise;
    assert.equal(ui.renderer.root.findAllByType('form').length, 0);
    await act(async () => { ui.button('取消获取').props.onClick(); await tick(); });
    assert.equal(requestSignal?.aborted, true);
    assert.match(text(ui.renderer.root), /已停止获取模型列表/);
    pending.resolve(new Response(JSON.stringify({ data: [{ id: 'late-cancelled-model' }] })));
    await act(async () => { await tick(); await tick(); });
    assert.equal(ui.renderer.root.findAllByType('option').some(node => node.props.value === 'late-cancelled-model'), false);
    assert.equal(ui.button('获取可用模型').props.disabled, false);
  } finally { pending.resolve(new Response('{}')); ui.close(); }
});

test('settings account changes clear password drafts and discard a previous-account model list', async () => {
  const pending = deferred<Response>(), started = deferred<void>();
  const config = { ...CONFIG, requiresKey: false };
  const ui = await setup({ mode: 'settings', context: null, config, key: false,
    transport: { kind: 'fetch', supportsStreaming: false, redirectPolicy: 'error', request: async () => { started.resolve(); return pending.promise; } } });
  try {
    ui.openSettings();
    act(() => ui.button('获取可用模型').props.onClick()); await started.promise;
    ui.password.value = 'unsaved-account-a-secret';
    act(() => ui.input('key').props.onChange({ target: ui.password }));
    await ui.update({ accountScope: { ...SCOPE, accountId: OTHER } });
    assert.equal(ui.password.value, '');
    assert.equal(ui.renderer.root.findAllByType('input').length, 0);
    ui.openSettings();
    assert.equal(ui.input('model').props.value, '');
    assert.equal(new LocalAiConfigStore(ui.storage).load({ ...SCOPE, accountId: OTHER }).model, '');
    pending.resolve(new Response(JSON.stringify({ data: [{ id: 'account-a-only-model' }] })));
    await act(async () => { await tick(); await tick(); });
    assert.equal(ui.renderer.root.findAllByType('option').some(node => node.props.value === 'account-a-only-model'), false);
    assert.doesNotMatch(text(ui.renderer.root), /已取得/);
    await ui.update({ accountScope: SCOPE });
    ui.openSettings();
    assert.equal(ui.input('model').props.value, CONFIG.model);
    assert.equal(ui.password.value, '');
    assert.equal(ui.saved.length, 0);
  } finally { pending.resolve(new Response('{}')); ui.close(); }
});

test('failed settings persistence retains editable fields and never stores a password or calls the model', async () => {
  const ui = await setup({ mode: 'settings', context: null, key: false });
  try {
    ui.openSettings();
    act(() => ui.input('model').props.onChange({ target: { value: 'unsaved-model' } }));
    ui.password.value = KEY;
    act(() => ui.input('key').props.onChange({ target: ui.password }));
    ui.storage.setItem = () => { throw Error('fixture storage failure'); };
    await act(async () => { ui.button('保存设置').props.onClick(); await tick(); });
    assert.match(text(ui.renderer.root), /设置未保存/);
    assert.equal(ui.input('model').props.value, 'unsaved-model');
    assert.equal(ui.password.value, KEY);
    assert.equal(await ui.secrets.get(await aiSecretNamespace(SCOPE, CONFIG), AI_SECRET_KEY), null);
    assert.equal(new LocalAiConfigStore(ui.storage).load(SCOPE).model, CONFIG.model);
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});

test('a failed key write is not described as a completed settings save', async () => {
  const ui = await setup({ mode: 'settings', context: null, key: false });
  try {
    ui.openSettings();
    ui.secrets.set = async () => { throw Error('fixture secure storage unavailable'); };
    ui.password.value = KEY;
    act(() => ui.input('key').props.onChange({ target: ui.password }));
    await act(async () => { ui.button('保存设置').props.onClick(); await tick(); await tick(); });
    await until(() => text(ui.renderer.root).includes('访问密钥操作未完成'), 'key-save failure');
    assert.equal(ui.password.value, '');
    assert.equal(ui.button('获取可用模型').props.disabled, true);
    assert.doesNotMatch(text(ui.renderer.root), /已保存。可回到文献/);
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});

test('cancelling a custom connection preserves the selected shared model and clears the unsaved key', async () => {
  const shared = await createModelRouteProvider(SCOPE, { kind: 'gateway' }, { id: 'reading', revision: 1, digest: 'a'.repeat(64), kind: 'chat', model: 'shared-reading', maxInputBytes: 65536, maxOutputTokens: 2048, stream: false });
  const dirty: boolean[] = [];
  const ui = await setup({ mode: 'settings', context: null, config: shared, key: false, onSettingsDirty: value => dirty.push(value) });
  try {
    ui.openSettings();
    assert.equal(new LocalAiConfigStore(ui.storage).load(SCOPE).execution?.target.kind, 'gateway');
    assert.equal(dirty.at(-1), false, 'browsing the connection form is not an unsaved edit');
    act(() => ui.input('model').props.onChange({ target: { value: 'uncommitted-custom-model' } }));
    ui.password.value = KEY;
    act(() => ui.input('key').props.onChange({ target: ui.password }));
    assert.equal(dirty.at(-1), true);
    act(() => ui.button('取消修改').props.onClick());
    assert.equal(ui.password.value, '');
    assert.equal(ui.renderer.root.findAllByType('input').length, 0);
    assert.equal(dirty.at(-1), false);
    assert.match(text(ui.renderer.root), /shared-reading/);
    assert.deepEqual(new LocalAiConfigStore(ui.storage).load(SCOPE), shared);
    assert.equal(JSON.stringify([...ui.values]).includes(KEY), false);
    assert.equal(ui.requests.length, 0);
  } finally { ui.close(); }
});


test('settings notify the task only after a complete successful save, retaining failed or incomplete fields', async () => {
  let saved = 0;
  const ui = await setup({ mode: 'settings', key: false, config: { ...CONFIG, model: '', requiresKey: false }, onSettingsSaved: () => { saved++; } });
  try {
    ui.openSettings();
    await act(async () => { ui.button('保存设置').props.onClick(); await tick(); });
    assert.equal(saved, 0); assert.equal(ui.input('model').props.value, '');
    act(() => ui.input('model').props.onChange({ target: { value: 'ready-task-model' } }));
    await act(async () => { ui.button('保存设置').props.onClick(); await tick(); });
    assert.equal(saved, 1); assert.equal(ui.requests.length, 0);
    ui.openSettings(); act(() => ui.input('model').props.onChange({ target: { value: 'not-saved-model' } }));
    ui.storage.setItem = () => { throw Error('Synthetic failed settings save'); };
    await act(async () => { ui.button('保存设置').props.onClick(); await tick(); });
    assert.equal(saved, 1); assert.equal(ui.input('model').props.value, 'not-saved-model');
    assert.match(text(ui.renderer.root), /设置未保存/);
  } finally { ui.close(); }
});
