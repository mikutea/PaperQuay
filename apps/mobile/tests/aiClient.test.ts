import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { validateEntityData } from '../../../packages/sync-core/src/index.ts';
import { AiClient } from '../src/ai/client.ts';
import { aiResultNote, buildAiMessages, citedPages, prepareAiContext } from '../src/ai/context.ts';
import { AiSessionController } from '../src/ai/controller.ts';
import { AiError } from '../src/ai/errors.ts';
import { AI_SECRET_KEY, LocalAiConfigStore, aiSecretNamespace, canonicalAiEndpoint, defaultAiProvider, parseAiProvider } from '../src/ai/provider.ts';
import { AiSseParser, KeyRedactor, actualAiUsage } from '../src/ai/stream.ts';
import { boundedAiLimits } from '../src/ai/transport.ts';
import { AI_LIMITS, type AiAccountScope, type AiLimits, type AiProviderConfig, type AiTransport, type PdfAiContext, type SecretStore } from '../src/ai/types.ts';
import { MemorySecretStore } from '../src/platform/secretStore.ts';

const KEY = 'fixture-secret-only-not-a-live-credential';
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAPER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const HASH = 'a'.repeat(64);
const SCOPE: AiAccountScope = { apiBaseUrl: 'https://sync.example.invalid/v1', accountId: ACCOUNT };
const pdfContext = (change: Partial<PdfAiContext> = {}): PdfAiContext => ({ paperId: PAPER, attachmentVersionId: VERSION,
  sha256: HASH, scope: 'page', totalPages: 3, pages: [{ pageIndex: 1, text: 'Synthetic research text. 合成材料，仅供测试。' }], complete: true, label: '合成文献', ...change });
const configAt = (endpoint: string, change: Partial<AiProviderConfig> = {}): AiProviderConfig => ({ ...defaultAiProvider(), endpoint, model: 'fixture-model', ...change });
const delta = (content: string, finishReason: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] });
const sse = (value: unknown) => 'data: ' + JSON.stringify(value) + '\r\n\r\n';
const finalFrame = sse(delta('', 'stop')) + 'data: [DONE]\r\n\r\n';
const completion = (text = '结果 [P2]', reason = 'stop') => ({ choices: [{ index: 0, message: { content: text }, finish_reason: reason }] });
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

async function provider<T>(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, run: (endpoint: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => { if (!response.destroyed) response.destroy(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try { return await run('http://127.0.0.1:' + address.port + '/v1'); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function configured(endpoint: string, limits: Partial<AiLimits> = {}, transport?: AiTransport) {
  const config = configAt(endpoint);
  const secrets = new MemorySecretStore();
  await secrets.set(await aiSecretNamespace(SCOPE, config), AI_SECRET_KEY, KEY);
  return { config, secrets, client: new AiClient(secrets, transport, limits) };
}

async function requestBody(request: IncomingMessage): Promise<Record<string, any>> {
  const buffers: Buffer[] = [];
  for await (const chunk of request) buffers.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}
function generate(client: AiClient, config: AiProviderConfig, extra: Partial<Parameters<AiClient['generate']>[0]> = {}) {
  return client.generate({ accountScope: SCOPE, config, context: prepareAiContext(pdfContext()), action: 'explain', question: '', onText: () => {}, ...extra });
}
function code(expected: string) { return (error: unknown) => error instanceof AiError && error.code === expected && !JSON.stringify(error).includes(KEY); }

test('provider URLs reject credential/query/fragment and non-HTTP ambiguities; public settings isolate accounts and services', async () => {
  assert.equal(canonicalAiEndpoint('HTTPS://Example.COM:443/v1///'), 'https://example.com/v1');
  for (const url of ['file:///x', 'ftp://x/v1', 'javascript:alert(1)', '//host/v1', 'https://u:p@host/v1',
    'https://host/v1?key=x', 'https://host/v1?', 'https://host/v1#x', 'https://host/v1#', 'https://host/v1%0d',
    'https://host\\other/v1', 'https://host/v1/chat/completions', 'https://host/v1/models', ' https://host/v1']) {
    assert.throws(() => canonicalAiEndpoint(url), code('CONFIG_INVALID'));
  }
  const config = configAt('https://provider.example.invalid/v1');
  assert.throws(() => parseAiProvider({ ...config, apiKey: KEY }), code('CONFIG_INVALID'));
  assert.throws(() => parseAiProvider({ ...config, model: '<script>' }), code('CONFIG_INVALID'));
  const namespace = await aiSecretNamespace(SCOPE, config);
  assert.equal(namespace, await aiSecretNamespace(SCOPE, { ...config, endpoint: config.endpoint + '/' }));
  for (const [scope, providerConfig] of [[{ ...SCOPE, accountId: SECOND }, config],
    [{ ...SCOPE, apiBaseUrl: 'https://other-sync.example.invalid/v1' }, config], [SCOPE, { ...config, endpoint: 'https://other-provider.example.invalid/v1' }]] as const) {
    assert.notEqual(await aiSecretNamespace(scope, providerConfig), namespace);
  }
  const values = new Map<string, string>();
  const store = new LocalAiConfigStore({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } });
  store.save(SCOPE, config);
  assert.deepEqual(store.load(SCOPE), config);
  assert.equal(store.load({ ...SCOPE, accountId: SECOND }).model, '');
  assert.equal(JSON.stringify([...values]).includes(KEY), false);
  assert.throws(() => boundedAiLimits({ outputBytes: 0 }), code('CONFIG_INVALID'));
  assert.equal(boundedAiLimits({ outputBytes: Number.MAX_SAFE_INTEGER }).outputBytes, AI_LIMITS.outputBytes);
});

test('scope claims require full coverage; UTF-8 limits and page citations bind to the actual source version', () => {
  const partial = prepareAiContext(pdfContext({ scope: 'document', complete: true, pages: [{ pageIndex: 1, text: 'partial' }] }));
  assert.equal(partial.completeDocument, false); assert.match(partial.scopeLabel, /部分/);
  const full = prepareAiContext(pdfContext({ scope: 'document', pages: [{ pageIndex: 2, text: '尾页' }, { pageIndex: 0, text: '' }, { pageIndex: 1, text: '正文' }] }));
  assert.equal(full.completeDocument, true); assert.deepEqual(full.pageIndices, [0, 1, 2]);
  assert.equal(full.characters, 4); assert.equal(full.bytes, 12);
  const messages = JSON.stringify(buildAiMessages(full, 'summarize', '概括方法'));
  assert.ok(messages.includes('正文') && messages.includes('[P3]'));
  assert.ok(!messages.includes(PAPER) && !messages.includes(VERSION) && !messages.includes(HASH));
  assert.throws(() => prepareAiContext(pdfContext({ pages: [{ pageIndex: 1, text: 'a' }, { pageIndex: 1, text: 'b' }] })), code('CONTEXT_INVALID'));
  assert.throws(() => prepareAiContext(pdfContext({ pages: [{ pageIndex: 1, text: '文'.repeat(65537) }] })), code('CONTEXT_TOO_LARGE'));
  assert.equal(prepareAiContext(pdfContext({ pages: [{ pageIndex: 1, text: '文'.repeat(65536) }] })).bytes, AI_LIMITS.contextBytes);
  assert.throws(() => prepareAiContext(pdfContext({ pages: [{ pageIndex: 1, text: '  ' }] })), code('TEXT_MISSING'));
  assert.throws(() => buildAiMessages(full, 'ask', ''), code('QUESTION_REQUIRED'));
  assert.throws(() => buildAiMessages(full, 'ask', '文'.repeat(2731)), code('INPUT_TOO_LARGE'));
  const targets = citedPages('依据 [P2]、[p.3]、[第1页]、[P99]、[P2]', full, 'request-fixture');
  assert.deepEqual(targets.citations.map((entry) => entry.pageNumber), [2, 3]);
  assert.deepEqual(targets.unverifiedPageNumbers, [1, 99]);
  assert.equal(targets.citations[0].target.attachmentVersionId, VERSION);
  assert.equal(targets.citations[0].target.sha256, HASH);
  assert.deepEqual(actualAiUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }), { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal(actualAiUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 99 }), null);
});

test('redactor handles overlapping prefixes and credentials split between every character', () => {
  for (const secret of ['ababaca', KEY, 'aaab', 'a']) {
    const redactor = new KeyRedactor(secret);
    const input = 'before ' + secret + ' / ' + secret + ' after';
    const output = [...input].map((character) => redactor.push(character)).join('') + redactor.finish();
    assert.equal(output, input.split(secret).join('[已隐藏凭据]'));
    assert.equal(output.includes(secret), false);
  }
  const parserValues: unknown[] = [];
  const parser = new AiSseParser(boundedAiLimits(), (value) => parserValues.push(value));
  const frame = ': heartbeat\r\ndata: {"choices":\r\ndata: [] , "usage": null}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const character of frame) parser.feed(character);
  parser.finish(); assert.deepEqual(parserValues, [{ choices: [], usage: null }]);
});

test('real HTTP SSE emits before completion, handles split UTF-8, and never exposes reflected key fragments as a complete key', async () => {
  const partialSeen = deferred<void>(); const release = deferred<void>();
  let calls = 0; let posted: Record<string, any> | undefined;
  await provider(async (request, response) => {
    calls++; assert.equal(request.headers.authorization, 'Bearer ' + KEY);
    posted = await requestBody(request);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const first = Buffer.from(': heartbeat\r\n\r\n' + sse(delta('先说中文 ')));
    const split = first.indexOf(Buffer.from('中')) + 1;
    response.write(first.subarray(0, split)); await pause(); response.write(first.subarray(split));
    await partialSeen.promise;
    response.write(sse(delta(KEY.slice(0, 12)))); await pause(); response.write(sse(delta(KEY.slice(12) + ' [P2]')));
    await release.promise;
    response.end(sse(delta('', 'stop')) + sse({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }) + 'data: [DONE]\r\n\r\n');
  }, async (endpoint) => {
    const { client, config } = await configured(endpoint);
    const updates: string[] = [];
    const pending = generate(client, config, { onText: (text) => { updates.push(text); if (text.includes('中文')) partialSeen.resolve(); } });
    await partialSeen.promise;
    assert.ok(updates.length > 0); assert.equal(calls, 1);
    release.resolve();
    const result = await pending;
    assert.equal(result.text, '先说中文 [已隐藏凭据] [P2]');
    assert.ok(updates.every((text) => !text.includes(KEY)));
    assert.deepEqual(result.usage, { promptTokens: 9, completionTokens: 4, totalTokens: 13 });
    assert.equal(posted?.stream, true); assert.deepEqual(posted?.stream_options, { include_usage: true });
    assert.equal(posted?.max_completion_tokens, 2048); assert.equal(posted?.n, 1);
    assert.equal(JSON.stringify(posted).includes(KEY), false);
    assert.equal(JSON.stringify(posted).includes(ACCOUNT), false);
  });
});

test('model discovery is explicit; manual model IDs, anonymous requests and honest non-stream responses work', async () => {
  let calls = 0; let posted: Record<string, any> | undefined;
  await provider(async (request, response) => {
    calls++;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') response.end(JSON.stringify({ data: [{ id: 'fixture-b' }, { id: 'fixture-a' }, { id: KEY }, { id: '<script>' }, { id: 'fixture-a', apiKey: KEY }] }));
    else {
      assert.equal(request.headers.authorization, undefined);
      posted = await requestBody(request); response.end(JSON.stringify(completion('完整非流式响应')));
    }
  }, async (endpoint) => {
    const { client, config } = await configured(endpoint);
    assert.equal(calls, 0);
    assert.deepEqual(await client.listModels({ accountScope: SCOPE, config }), ['fixture-a', 'fixture-b']);
    const result = await generate(client, { ...config, stream: false, requiresKey: false, model: 'manual/model', tokenParameter: 'max_tokens' });
    assert.equal(result.text, '完整非流式响应'); assert.equal(result.usage, null);
    assert.equal(posted?.stream, false); assert.equal(posted?.stream_options, undefined);
    assert.equal(posted?.max_tokens, 2048); assert.equal(posted?.max_completion_tokens, undefined);
    assert.equal(posted?.model, 'manual/model'); assert.equal(calls, 2);
  });
});

test('HTTP errors are static and bounded; 401, 429/quota and retry-after never expose raw error bodies or auto-retry', async () => {
  let calls = 0; let status = 401; let quota = false;
  await provider((_request, response) => {
    calls++;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '7' });
    response.end(JSON.stringify({ error: { code: quota ? 'insufficient_quota' : 'provider_error', message: KEY + ' raw upstream diagnostic' } }));
  }, async (endpoint) => {
    const { client, config } = await configured(endpoint);
    for (const [nextStatus, expected, isQuota] of [[401, 'AUTHENTICATION_FAILED', false], [403, 'ACCESS_DENIED', false],
      [429, 'RATE_LIMITED', false], [429, 'QUOTA_EXCEEDED', true], [400, 'MODEL_OR_REQUEST_REJECTED', false],
      [404, 'ENDPOINT_NOT_FOUND', false], [503, 'PROVIDER_UNAVAILABLE', false]] as const) {
      status = nextStatus; quota = isQuota;
      await assert.rejects(generate(client, config), (error) => {
        assert.ok(code(expected)(error)); assert.ok(error instanceof AiError);
        assert.equal(error.message.includes(KEY), false);
        if (status === 429) assert.equal(error.retryAfterSeconds, 7);
        return true;
      });
    }
    assert.equal(calls, 7);
  });
});

test('cross-origin redirects never receive the model Authorization header or request body', async () => {
  let leakedRequests = 0;
  await provider((_request, response) => { leakedRequests++; response.end('unexpected'); }, async (target) => {
    await provider((_request, response) => { response.writeHead(307, { Location: target + '/capture' }); response.end(); }, async (endpoint) => {
      const { client, config } = await configured(endpoint);
      await assert.rejects(generate(client, config), code('NETWORK_OR_CORS'));
      await assert.rejects(client.listModels({ accountScope: SCOPE, config }), code('NETWORK_OR_CORS'));
      assert.equal(leakedRequests, 0);
    });
  });
  const { client, config } = await configured('https://fixture.invalid/v1', {}, {
    kind: 'native', supportsStreaming: true, redirectPolicy: 'error', request: async () => new Response(null, { status: 302 }),
  });
  await assert.rejects(generate(client, config), code('REDIRECT_BLOCKED'));
});

test('EOF, malformed events and unsupported tools cannot be presented as complete output', async () => {
  let payload = sse(delta('已有部分输出'));
  await provider((_request, response) => { response.setHeader('Content-Type', 'text/event-stream'); response.end(payload); }, async (endpoint) => {
    const { client, config } = await configured(endpoint);
    let shown = '';
    await assert.rejects(generate(client, config, { onText: (text) => { shown = text; } }), code('STREAM_INTERRUPTED'));
    assert.equal(shown, '已有部分输出');
    payload = 'data: {invalid json}\n\n'; await assert.rejects(generate(client, config), code('INVALID_RESPONSE'));
    payload = sse({ choices: [{ index: 0, delta: { tool_calls: [{ name: 'unexpected' }] }, finish_reason: null }] });
    await assert.rejects(generate(client, config), code('UNSUPPORTED_RESPONSE'));
    payload = sse(delta('没有统计也能完成')) + finalFrame;
    assert.equal((await generate(client, config)).usage, null);
    payload = sse(delta('部分输出', 'length')) + 'data: [DONE]\n\n';
    const controller = new AiSessionController(client); controller.bind(SCOPE, config, pdfContext());
    await controller.start('summarize');
    assert.equal(controller.getSnapshot().result?.status, 'incomplete');
    assert.equal(controller.getSnapshot().result?.failure?.code, 'OUTPUT_TRUNCATED');
    assert.equal(controller.getSnapshot().result?.cost, 'unknown'); controller.dispose();
  });
});

test('real fetch cancellation closes the stream, while idle and total deadlines remain distinct', async () => {
  let mode = 'cancel'; let closed: ReturnType<typeof deferred<void>>;
  await provider((_request, response) => {
    closed = deferred<void>(); response.on('close', () => closed.resolve());
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sse(delta('partial')));
    if (mode === 'total') {
      const timer = setInterval(() => response.write(': ping\n\n'), 10);
      response.once('close', () => clearInterval(timer));
    }
  }, async (endpoint) => {
    let { client, config } = await configured(endpoint, { idleTimeoutMs: 100, totalTimeoutMs: 500 });
    const abort = new AbortController();
    await assert.rejects(generate(client, config, { signal: abort.signal, onText: () => abort.abort() }), code('CANCELLED'));
    await Promise.race([closed!.promise, pause(1000).then(() => assert.fail('cancel did not close stream'))]);
    mode = 'idle'; ({ client, config } = await configured(endpoint, { idleTimeoutMs: 35, totalTimeoutMs: 500 }));
    await assert.rejects(generate(client, config), code('IDLE_TIMEOUT'));
    mode = 'total'; ({ client, config } = await configured(endpoint, { idleTimeoutMs: 100, totalTimeoutMs: 70 }));
    await assert.rejects(generate(client, config), code('TIMEOUT'));
  });
});

test('misbehaving SecretStore and transport promises cannot defeat a deadline; no key is sent to anonymous services', async () => {
  const secrets: SecretStore = { persistence: 'memory', get: async () => new Promise(() => {}), set: async () => {}, remove: async () => {} };
  const config = configAt('https://fixture.invalid/v1');
  const client = new AiClient(secrets, undefined, { totalTimeoutMs: 30 });
  await assert.rejects(generate(client, config), code('TIMEOUT'));
  let calls = 0;
  const transport: AiTransport = { kind: 'native', supportsStreaming: false, redirectPolicy: 'error', request: async (input) => {
    calls++; assert.equal(input.headers.Authorization, undefined); return new Promise(() => {});
  } };
  const hung = new AiClient(secrets, transport, { totalTimeoutMs: 30 });
  await assert.rejects(generate(hung, { ...config, requiresKey: false }), code('TIMEOUT')); assert.equal(calls, 1);
});

test('input, event, stream, model list and output byte ceilings are enforced before unbounded work', async () => {
  let calls = 0; let payload = sse(delta('文'.repeat(100))) + finalFrame;
  await provider((request, response) => {
    calls++;
    if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'model' }], padding: 'x'.repeat(100) })); }
    else { response.setHeader('Content-Type', 'text/event-stream'); response.end(payload); }
  }, async (endpoint) => {
    for (const [limits, expected] of [[{ contextBytes: 1 }, 'CONTEXT_TOO_LARGE'], [{ requestBytes: 1 }, 'INPUT_TOO_LARGE'],
      [{ eventBytes: 40 }, 'RESPONSE_TOO_LARGE'], [{ streamBytes: 50 }, 'RESPONSE_TOO_LARGE'], [{ outputBytes: 20 }, 'OUTPUT_LIMIT']] as const) {
      const { client, config } = await configured(endpoint, limits);
      await assert.rejects(generate(client, config), code(expected));
    }
    assert.equal(calls, 3);
    const { client, config } = await configured(endpoint, { modelListBytes: 40 });
    await assert.rejects(client.listModels({ accountScope: SCOPE, config }), code('RESPONSE_TOO_LARGE'));
    payload = sse(delta('a')) + sse(delta('b')) + finalFrame;
    const limited = await configured(endpoint, { events: 1 });
    await assert.rejects(generate(limited.client, limited.config), code('RESPONSE_TOO_LARGE'));
  });
});

test('account, attachment, selection, model and credential changes fence delayed callbacks and discard old save targets', async () => {
  for (const change of ['account', 'version', 'selection', 'model', 'key', 'cancel'] as const) {
    const pending = deferred<Response>(); const entered = deferred<void>(); let calls = 0;
    const transport: AiTransport = { kind: 'native', supportsStreaming: false, redirectPolicy: 'error', request: async () => { calls++; entered.resolve(); return pending.promise; } };
    const { client, config } = await configured('https://fixture.invalid/v1', {}, transport);
    const controller = new AiSessionController(client); controller.bind(SCOPE, config, pdfContext());
    assert.equal(calls, 0);
    const running = controller.start('explain'); await entered.promise;
    const oldRequest = controller.getSnapshot().result!.requestId;
    if (change === 'account') controller.bind({ ...SCOPE, accountId: SECOND }, config, pdfContext());
    if (change === 'version') controller.bind(SCOPE, config, pdfContext({ attachmentVersionId: SECOND, sha256: 'b'.repeat(64) }));
    if (change === 'selection') controller.bind(SCOPE, config, pdfContext({ scope: 'selection', pages: [{ pageIndex: 1, text: 'different selected text' }] }));
    if (change === 'model') controller.bind(SCOPE, { ...config, model: 'different-model' }, pdfContext());
    if (change === 'key') controller.credentialsChanged();
    if (change === 'cancel') controller.cancel();
    await running;
    pending.resolve(new Response(JSON.stringify(completion('late output ' + KEY)), { headers: { 'content-type': 'application/json' } }));
    await pause();
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.result?.text ?? '', ''); assert.equal(snapshot.busy, null); assert.equal(JSON.stringify(snapshot).includes(KEY), false);
    if (change === 'cancel') assert.equal(snapshot.result?.status, 'cancelled');
    else { assert.equal(snapshot.result, null); assert.throws(() => controller.saveContext(oldRequest), code('CONTEXT_INVALID')); }
    assert.equal(calls, 1); controller.dispose();
  }
});

test('saved notes preserve version/scope and actual usage without keys, fabricated fees or oversized note bodies', async () => {
  const transport: AiTransport = { kind: 'native', supportsStreaming: false, redirectPolicy: 'error', request: async () => new Response(JSON.stringify(completion('观察 [P2] 与未提供 [P99] ' + KEY))) };
  const { client, config } = await configured('https://fixture.invalid/v1', {}, transport);
  const controller = new AiSessionController(client); controller.bind(SCOPE, config, pdfContext()); await controller.start('summarize');
  const result = controller.getSnapshot().result!;
  assert.equal(result.status, 'complete'); assert.deepEqual(result.citations.map((item) => item.pageNumber), [2]);
  assert.deepEqual(result.unverifiedPageNumbers, [99]);
  const note = aiResultNote(result);
  assert.equal(validateEntityData('note', note).ok, true);
  assert.equal(note.body.includes(KEY), false); assert.ok(note.body.includes(VERSION) && note.body.includes(HASH));
  assert.ok(note.body.includes('费用未知') && note.body.includes('未返回完整用量'));
  assert.deepEqual(controller.saveContext(result.requestId).accountScope, SCOPE);
  const maximal = { ...result, text: 'x'.repeat(AI_LIMITS.outputBytes), source: { ...result.source, label: 'x'.repeat(512), pageIndices: Array.from({ length: 2000 }, (_, index) => index) } };
  assert.equal(validateEntityData('note', aiResultNote(maximal)).ok, true);
  controller.dispose();
});

test('a failed retry retains the last output in memory, bounds the history to two results and clears it at a scope boundary', async () => {
  let request = 0;
  const transport: AiTransport = { kind: 'fetch', supportsStreaming: false, redirectPolicy: 'error', request: async () => {
    request++;
    return request === 2 || request === 3 ? new Response('untrusted error ' + KEY, { status: 401 })
      : new Response(JSON.stringify(completion('结果 ' + request + ' [P2]')));
  } };
  const { client, config } = await configured('https://fixture.invalid/v1', {}, transport);
  const controller = new AiSessionController(client); controller.bind(SCOPE, config, pdfContext());
  await controller.start('explain'); const first = controller.getSnapshot().result!;
  await controller.start('translate');
  assert.equal(controller.getSnapshot().result?.status, 'failed');
  assert.equal(controller.getSnapshot().previousResult?.requestId, first.requestId);
  assert.equal(aiResultNote(controller.getSnapshot().previousResult!).body.startsWith('结果 1'), true);
  assert.equal(controller.saveContext(first.requestId).attachmentVersionId, VERSION);
  await controller.start('ask', '重试');
  assert.equal(controller.getSnapshot().previousResult?.requestId, first.requestId);
  await controller.start('summarize'); const fourth = controller.getSnapshot().result!;
  await controller.start('rewrite');
  assert.equal(controller.getSnapshot().previousResult?.requestId, fourth.requestId);
  assert.equal(controller.getSnapshot().result?.text, '结果 5 [P2]');
  assert.equal(controller.hasResult(first.requestId), false);
  assert.throws(() => controller.saveContext(first.requestId), code('CONTEXT_INVALID'));
  controller.bind(SCOPE, config, pdfContext({ attachmentVersionId: SECOND }));
  assert.equal(controller.getSnapshot().result, null); assert.equal(controller.getSnapshot().previousResult, null);
  controller.dispose();
});

test('switching destinations while a key lookup is pending cannot send the old key to either destination', async () => {
  const firstLookup = deferred<string>(); const entered = deferred<void>();
  const firstConfig = configAt('https://one.example.invalid/v1');
  const secondConfig = configAt('https://two.example.invalid/v1');
  const firstNamespace = await aiSecretNamespace(SCOPE, firstConfig);
  const secondNamespace = await aiSecretNamespace(SCOPE, secondConfig);
  const nextKey = 'another-synthetic-key-only';
  const secrets: SecretStore = { persistence: 'memory', get: async (namespace) => {
    if (namespace === firstNamespace) { entered.resolve(); return firstLookup.promise; }
    assert.equal(namespace, secondNamespace); return nextKey;
  }, set: async () => {}, remove: async () => {} };
  const requests: { url: string; authorization?: string }[] = [];
  const transport: AiTransport = { kind: 'fetch', supportsStreaming: false, redirectPolicy: 'error', request: async (input) => {
    requests.push({ url: input.url, authorization: input.headers.Authorization }); return new Response(JSON.stringify(completion()));
  } };
  const controller = new AiSessionController(new AiClient(secrets, transport));
  controller.bind(SCOPE, firstConfig, pdfContext()); const oldRequest = controller.start('explain'); await entered.promise;
  controller.bind(SCOPE, secondConfig, pdfContext()); await oldRequest;
  await controller.start('explain'); firstLookup.resolve(KEY); await pause();
  assert.deepEqual(requests, [{ url: secondConfig.endpoint + '/chat/completions', authorization: 'Bearer ' + nextKey }]);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(KEY), false);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(nextKey), false);
  controller.dispose();
});

test('abrupt socket loss retains only already decoded text, and invalid UTF-8 never becomes a successful response', async () => {
  let malformed = false; const firstText = deferred<void>();
  await provider(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (malformed) { response.end(Buffer.from([0xff, 0xfe, 0xff])); return; }
    response.write(sse(delta('中断前已收到的文字')));
    await firstText.promise; response.destroy();
  }, async (endpoint) => {
    const { client, config } = await configured(endpoint);
    let shown = '';
    await assert.rejects(generate(client, config, { onText: (text) => { shown = text; firstText.resolve(); } }), code('STREAM_INTERRUPTED'));
    assert.equal(shown, '中断前已收到的文字');
    malformed = true; shown = '';
    await assert.rejects(generate(client, config, { onText: (text) => { shown = text; } }), code('STREAM_INTERRUPTED'));
    assert.equal(shown, '');
  });
});
