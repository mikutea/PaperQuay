import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_ARCHIVE_LIMITS, AiArchiveError, createAiHistoryRecord, createAiQuestionTemplate,
  deriveAiHistoryResult, summarizeAiArchiveItem, validateAiArchiveItem, validateAiArchiveSummary,
  type AiArchiveErrorCode, type AiHistoryRecord,
} from '../src/ai/archiveTypes.ts';
import { AI_LIMITS } from '../src/ai/types.ts';
import type { PdfAiContext } from '../src/pdf/types.ts';

const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const createdAt = '2026-10-28T12:00:00.000Z', updatedAt = '2026-10-28T12:00:01.001Z';
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function context(parsed = false): PdfAiContext {
  return { paperId: id(1), attachmentVersionId: id(2), sha256: 'a'.repeat(64), scope: 'document', totalPages: 3,
    pages: [{ pageIndex: 2, text: '末页材料' }, { pageIndex: 0, text: '首段 $x=1$。' }], complete: false, label: '合成文献.pdf',
    ...(parsed ? { textSource: { kind: 'parsed-document' as const, packageDigest: 'b'.repeat(64), parserName: 'mineru' as const, parserModel: 'vlm' } } : {}) };
}
function record(parsed = false): AiHistoryRecord {
  return { kind: 'record', version: 1, id: id(10), revision: 1, createdAt, updatedAt,
    context: context(parsed), action: 'ask', question: '当时实际发送的问题是什么？',
    provider: { id: 'primary', endpoint: 'https://model.example.invalid/v1', model: 'model-1' },
    result: { text: '首段依据 [P1]；本次没有第 2 页 [P2]。另一个来源 [P3]。', status: 'complete', finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, cost: 'unknown', failure: null } };
}
function history(value = record()): AiHistoryRecord { const item = validateAiArchiveItem(value); assert.equal(item.kind, 'record'); return item as AiHistoryRecord; }
function reject(code: AiArchiveErrorCode = 'INVALID_ITEM') { return (error: unknown) => error instanceof AiArchiveError && error.code === code; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('record construction captures actual request metadata and detached normalized context', () => {
  const input = history(), result = deriveAiHistoryResult(input);
  const before = structuredClone({ input, result });
  const stored = createAiHistoryRecord(input.context, result);
  assert.deepEqual(stored, input);
  assert.equal(stored.question, result.question); assert.equal(stored.id, result.requestId);
  assert.equal(stored.createdAt, result.startedAt); assert.equal(stored.updatedAt, result.finishedAt);
  assert.deepEqual(stored.context.pages.map((page) => page.pageIndex), [0, 2]);
  assert.deepEqual({ input, result }, before);
  result.provider.model = 'Changed'; result.source.pageIndices.push(1); result.usage!.totalTokens = 0;
  input.context.pages[0].text = 'Changed';
  assert.equal(stored.provider.model, 'model-1'); assert.equal(stored.context.pages[0].text, '首段 $x=1$。');
  assert.equal(stored.result.usage!.totalTokens, 30);
  const raw = JSON.stringify(stored);
  for (const forbidden of ['contextIdentity', 'citations', 'unverifiedPageNumbers', 'scopeLabel', 'pageIndices', 'characters', 'apiKey', 'headers']) assert.ok(!raw.includes(`"${forbidden}"`), forbidden);
});

test('canonical context retains coordinates and parsed origin while derived source and citations reflect actual pages', () => {
  for (const parsed of [false, true]) {
    const input = record(parsed);
    if (!parsed) input.context.pages[0].anchor = { pageIndex: 2, coordinateSpace: 'pdf-crop-box-unrotated-normalized',
      quads: [[0.1, 0.2, 0.3, 0.2, 0.3, 0.4, 0.1, 0.4]], quote: { exact: '旧选段', prefix: '前', suffix: '后' } };
    const normalized = history(input), result = deriveAiHistoryResult(normalized);
    assert.deepEqual(result.source.pageIndices, [0, 2]); assert.equal(result.source.completeDocument, false);
    assert.deepEqual(result.citations.map((citation) => citation.pageNumber), [1, 3]); assert.deepEqual(result.unverifiedPageNumbers, [2]);
    assert.equal(result.cost, 'unknown'); assert.deepEqual(result.source.textSource, normalized.context.textSource);
    if (parsed) assert.equal(result.citations.some((citation) => citation.target.quads), false);
    else {
      assert.equal(normalized.context.pages[1].anchor!.quote, null);
      assert.deepEqual(result.citations[1].target.quads, normalized.context.pages[1].anchor!.quads);
      result.citations[1].target.quads![0][0] = 0.9;
      assert.equal(normalized.context.pages[1].anchor!.quads[0][0], 0.1);
    }
    assert.deepEqual(createAiHistoryRecord(normalized.context, deriveAiHistoryResult(normalized)), normalized);
  }
});

test('context identity rejects equal-length replacement text, anchor changes and every mismatched source summary field', () => {
  const input = history(), result = deriveAiHistoryResult(input);
  const differentText = structuredClone(input.context); differentText.pages[0].text = differentText.pages[0].text.replace('首', '异');
  assert.throws(() => createAiHistoryRecord(differentText, result), reject('ITEM_CHANGED'));
  for (const change of [
    (value: typeof result) => { value.source.paperId = id(99); },
    (value: typeof result) => { value.source.attachmentVersionId = id(99); },
    (value: typeof result) => { value.source.sha256 = 'f'.repeat(64); },
    (value: typeof result) => { value.source.scope = 'selection'; },
    (value: typeof result) => { value.source.scopeLabel = '全部'; },
    (value: typeof result) => { value.source.label = '其他文件'; },
    (value: typeof result) => { value.source.pageIndices = [0, 1]; },
    (value: typeof result) => { value.source.characters++; },
    (value: typeof result) => { value.source.completeDocument = true; },
    (value: typeof result) => { value.contextIdentity += 'changed'; },
  ]) { const mutated = structuredClone(result); change(mutated); assert.throws(() => createAiHistoryRecord(input.context, mutated), reject('ITEM_CHANGED')); }
  const parsed = history(record(true)), parsedResult = deriveAiHistoryResult(parsed);
  parsedResult.source.textSource!.packageDigest = 'e'.repeat(64);
  assert.throws(() => createAiHistoryRecord(parsed.context, parsedResult), reject('ITEM_CHANGED'));
  const anchored = history(), anchoredResult = deriveAiHistoryResult(anchored);
  anchored.context.pages[0].anchor = { pageIndex: 0, coordinateSpace: 'pdf-crop-box-unrotated-normalized',
    quads: [[0, 0, 0.2, 0, 0.2, 0.2, 0, 0.2]], quote: null };
  assert.throws(() => createAiHistoryRecord(anchored.context, anchoredResult), reject('ITEM_CHANGED'));
});

test('terminal failed/cancelled empty output and incomplete partial text remain their actual status', () => {
  for (const status of ['failed', 'cancelled', 'incomplete'] as const) {
    const input = record(); input.result.status = status; input.result.text = status === 'incomplete' ? '部分输出 [P1]' : '';
    input.question = status === 'failed' ? '' : input.question;
    input.result.finishReason = null; input.result.usage = null; input.result.failure = { code: status === 'cancelled' ? 'CANCELLED' : 'NETWORK_OR_CORS' };
    const normalized = history(input), stored = createAiHistoryRecord(normalized.context, deriveAiHistoryResult(normalized));
    assert.equal(stored.result.status, status); assert.equal(stored.result.text, input.result.text); assert.equal(stored.result.cost, 'unknown');
    assert.equal(deriveAiHistoryResult(stored).finishedAt, updatedAt);
  }
  const valid = history(), result = deriveAiHistoryResult(valid);
  assert.throws(() => createAiHistoryRecord(valid.context, { ...result, status: 'running', finishedAt: null }), reject());
  assert.throws(() => createAiHistoryRecord(valid.context, { ...result, finishedAt: null }), reject());
  const emptyComplete = record(); emptyComplete.result.text = '';
  assert.throws(() => validateAiArchiveItem(emptyComplete), reject());
});

test('every persisted object is closed and credentials cannot enter through provider or copied metadata', () => {
  const mutations: ((item: AiHistoryRecord) => void)[] = [
    (item) => Object.assign(item, { apiKey: 'SECRET' }),
    (item) => Object.assign(item, { title: 'Editable title' }),
    (item) => Object.assign(item.context, { headers: { Authorization: 'SECRET' } }),
    (item) => Object.assign(item.context.pages[0], { url: 'https://secret' }),
    (item) => Object.assign(item.provider, { key: 'SECRET' }),
    (item) => Object.assign(item.provider, { headers: { Authorization: 'SECRET' } }),
    (item) => Object.assign(item.result, { citations: [] }),
    (item) => Object.assign(item.result.usage!, { cost: 1 }),
    (item) => { item.result.failure = { code: 'CANCELLED', message: 'SECRET' } as never; },
    (item) => { item.context.pages[0].anchor = { pageIndex: 0, coordinateSpace: 'pdf-crop-box-unrotated-normalized', quads: [], quote: null, token: 'SECRET' } as never; },
    (item) => { item.revision = 2 as 1; },
    (item) => { item.createdAt = '2026-02-30T00:00:00.000Z'; },
    (item) => { item.updatedAt = '2026-10-28T12:00:00Z'; },
    (item) => { item.updatedAt = '2026-10-28T12:00:00.000+00:00'; },
    (item) => { item.updatedAt = '2025-10-28T00:00:00.000Z'; },
    (item) => { item.id = 'not-a-uuid'; },
    (item) => { item.result.usage!.totalTokens = 29; },
    (item) => { item.result.failure = { code: 'UNKNOWN_CODE' } as never; },
    (item) => { item.question = '\ud800'; },
  ];
  for (const change of mutations) { const input = record(); change(input); assert.throws(() => validateAiArchiveItem(input), reject()); }
  for (const endpoint of ['https://user:password@model.invalid/v1', 'https://model.invalid/v1?api_key=SECRET', 'https://model.invalid/v1#SECRET', 'file:///private', 'https://model.invalid/v1/chat/completions']) {
    const input = record(); input.provider.endpoint = endpoint;
    assert.throws(() => validateAiArchiveItem(input), reject());
  }
  const canonical = record(); canonical.provider.endpoint = 'HTTPS://MODEL.EXAMPLE.INVALID:443/v1///';
  assert.equal(history(canonical).provider.endpoint, 'https://model.example.invalid/v1');
  const parsed = record(true); Object.assign(parsed.context.textSource!, { key: 'SECRET' });
  assert.throws(() => validateAiArchiveItem(parsed), reject());
  const current = history(), result = deriveAiHistoryResult(current); Object.assign(result.provider, { apiKey: 'SECRET' });
  assert.throws(() => createAiHistoryRecord(current.context, result), reject());
});

test('plain-JSON inspection never executes accessors or serializers and rejects hidden, cyclic or sparse data', () => {
  let calls = 0;
  const getter = record(); Object.defineProperty(getter, 'question', { enumerable: true, get() { calls++; return 'SECRET'; } });
  assert.throws(() => validateAiArchiveItem(getter), reject()); assert.equal(calls, 0);
  const serializer = record(); Object.assign(serializer, { toJSON() { calls++; return record(); } });
  assert.throws(() => validateAiArchiveItem(serializer), reject()); assert.equal(calls, 0);
  const cycle = record(); Object.assign(cycle, { cycle }); assert.throws(() => validateAiArchiveItem(cycle), reject());
  const sparse = record(); delete sparse.context.pages[0]; assert.throws(() => validateAiArchiveItem(sparse), reject());
  const hidden = record(); Object.defineProperty(hidden, 'private', { value: 'SECRET' }); assert.throws(() => validateAiArchiveItem(hidden), reject());
  const symbol = record(); Object.assign(symbol, { [Symbol('secret')]: 'SECRET' }); assert.throws(() => validateAiArchiveItem(symbol), reject());
});

test('templates have optimistic immutable identity/time and independent revisions with no model secrets', () => {
  const input = { id: id(11), title: '方法提问', action: 'ask' as const, question: '这个方法有哪些限制？' };
  const first = createAiQuestionTemplate(input, { now: createdAt });
  assert.doesNotThrow(() => createAiQuestionTemplate(input, { previous: undefined, now: createdAt }));
  assert.equal(first.revision, 1); assert.equal(first.createdAt, createdAt); assert.equal(first.updatedAt, createdAt);
  const previous = freeze(first);
  const second = createAiQuestionTemplate({ ...input, title: '更新', question: '还有哪些限制？' }, { previous, now: updatedAt });
  assert.equal(second.id, first.id); assert.equal(second.createdAt, first.createdAt); assert.equal(second.updatedAt, updatedAt); assert.equal(second.revision, 2);
  assert.equal(first.question, input.question);
  assert.throws(() => createAiQuestionTemplate({ ...input, id: id(12) }, { previous, now: updatedAt }), reject('ITEM_CHANGED'));
  assert.throws(() => createAiQuestionTemplate(input, { previous, now: createdAt }), reject('ITEM_CHANGED'));
  for (const patch of [{ question: ' ' }, { title: '' }, { title: 't'.repeat(129) }, { apiKey: 'SECRET' }, { action: 'unknown' }])
    assert.throws(() => createAiQuestionTemplate({ ...input, ...patch } as never, { now: createdAt }), (error: unknown) => error instanceof AiArchiveError);
  assert.throws(() => validateAiArchiveItem({ ...first, provider: { id: 'SECRET' } }), reject());
});

test('question/context/output and final JSON limits count UTF-8 and escaped JSON bytes, never just characters', () => {
  const input = { id: id(11), title: '边界', action: 'ask' as const, question: '文'.repeat(Math.floor(AI_LIMITS.questionBytes / 3)) };
  assert.doesNotThrow(() => createAiQuestionTemplate(input, { now: createdAt }));
  assert.throws(() => createAiQuestionTemplate({ ...input, question: input.question + '文' }, { now: createdAt }), reject('RECORD_LIMIT'));
  const short = createAiQuestionTemplate({ ...input, question: 'x' }, { now: createdAt });
  const difference = AI_ARCHIVE_LIMITS.templateBytes - jsonBytes(short), extra = difference % 2;
  const question = 'x' + 'a'.repeat(extra) + '\n'.repeat((difference - extra) / 2);
  const boundary = createAiQuestionTemplate({ ...input, question }, { now: createdAt });
  assert.equal(jsonBytes(boundary), AI_ARCHIVE_LIMITS.templateBytes);
  assert.throws(() => createAiQuestionTemplate({ ...input, question: question + '\n' }, { now: createdAt }), reject('RECORD_LIMIT'));
  for (const change of [
    (value: AiHistoryRecord) => { value.question = '文'.repeat(3000); },
    (value: AiHistoryRecord) => { value.context.pages = [{ pageIndex: 0, text: '文'.repeat(Math.floor(AI_LIMITS.contextBytes / 3) + 1) }]; },
    (value: AiHistoryRecord) => { value.result.text = '文'.repeat(Math.floor(AI_LIMITS.outputBytes / 3) + 1); },
  ]) { const value = record(); change(value); assert.throws(() => validateAiArchiveItem(value), reject('RECORD_LIMIT')); }
  const many = record(); many.result.text = 'x'; many.context.totalPages = 225;
  many.context.pages = Array.from({ length: 225 }, (_, pageIndex) => ({ pageIndex, text: 'x', anchor: {
    pageIndex, coordinateSpace: 'pdf-crop-box-unrotated-normalized', quote: null,
    quads: Array.from({ length: 200 }, () => [0, 0, 0, 0, 0, 0, 0, 0]),
  } })) as PdfAiContext['pages'];
  const normalized = history(many), available = AI_ARCHIVE_LIMITS.recordBytes - jsonBytes(normalized);
  assert.ok(available > 0 && available + 1 <= AI_LIMITS.outputBytes);
  many.result.text = 'x'.repeat(available + 1);
  assert.equal(jsonBytes(history(many)), AI_ARCHIVE_LIMITS.recordBytes);
  many.result.text += 'x'; assert.throws(() => validateAiArchiveItem(many), reject('RECORD_LIMIT'));
});

test('summaries are derived without private text and metadata-only schemas remain closed', () => {
  const input = history(record(true)), summary = summarizeAiArchiveItem(input);
  assert.equal(summary.title, '提问 · 合成文献.pdf'); assert.equal(summary.status, 'complete');
  assert.equal(summary.paperId, input.context.paperId); assert.equal(summary.attachmentVersionId, input.context.attachmentVersionId); assert.equal(summary.sha256, input.context.sha256);
  assert.deepEqual(validateAiArchiveSummary(summary), summary);
  for (const forbidden of ['question', 'context', 'provider', 'result', 'textSource']) assert.equal(Object.hasOwn(summary, forbidden), false);
  const template = createAiQuestionTemplate({ id: id(12), title: '模板', action: 'ask', question: '问题' }, { now: createdAt });
  const templateSummary = summarizeAiArchiveItem(template);
  assert.deepEqual(Object.keys(templateSummary), ['kind', 'id', 'revision', 'createdAt', 'updatedAt', 'title']);
  assert.deepEqual(validateAiArchiveSummary(templateSummary), templateSummary);
  for (const invalid of [{ ...summary, question: 'SECRET' }, { ...summary, revision: 2 }, { ...templateSummary, sha256: 'a'.repeat(64) }, { ...summary, updatedAt: 'invalid' }, { ...summary, status: 'running' }])
    assert.throws(() => validateAiArchiveSummary(invalid), reject());
  const unicode = record(); unicode.context.label = 'a'.repeat(506) + '😀tail';
  const unicodeSummary = summarizeAiArchiveItem(unicode);
  assert.ok(unicodeSummary.title.length <= 512); assert.doesNotThrow(() => validateAiArchiveSummary(unicodeSummary));
});

test('canonical validation and result derivation are pure, deterministic and do not execute network or HTML', (t) => {
  const input = freeze(history()), result = freeze(deriveAiHistoryResult(input));
  const before = JSON.stringify({ input, result }); let network = 0;
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('must not run'); });
  const stored = createAiHistoryRecord(input.context, result), normalized = validateAiArchiveItem(input);
  assert.deepEqual(stored, normalized); assert.equal(JSON.stringify({ input, result }), before); assert.equal(network, 0);
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverse(entry)])) : value;
  assert.equal(JSON.stringify(validateAiArchiveItem(reverse(input))), JSON.stringify(normalized));
  const raw = record(); raw.question = '<script>globalThis.BAD=1</script>'; raw.result.text = '<img src="https://private.invalid">';
  assert.equal(history(raw).result.text, raw.result.text); assert.equal(Object.hasOwn(globalThis, 'BAD'), false);
  try { validateAiArchiveItem({ ...record(), apiKey: 'SENTINEL_SECRET' }); assert.fail('must reject'); }
  catch (error) { assert.ok(error instanceof AiArchiveError); assert.equal(error.message, 'INVALID_ITEM'); assert.ok(!String(error).includes('SENTINEL_SECRET')); }
});

test('private routing errors serialize through the unchanged archive/sync v1 failure enum and reject extra diagnostic fields',()=>{
 const input=history(),captured=deriveAiHistoryResult(input);
 for(const code of ['REMOTE_UNAVAILABLE','REMOTE_PENDING','REMOTE_UNCONFIRMED','REMOTE_PROFILE_CHANGED','REMOTE_AUTH_REQUIRED','REMOTE_CAPACITY']as const){const raw={...captured,status:'failed' as const,failure:{code}};const stored=createAiHistoryRecord(input.context,raw);assert.equal(stored.result.failure!.code,'PROVIDER_UNAVAILABLE');assert.equal(stored.provider.id,input.provider.id);assert.throws(()=>validateAiArchiveItem({...stored,result:{...stored.result,failure:{code}}}),reject());}
 assert.throws(()=>createAiHistoryRecord(input.context,{...captured,status:'failed',failure:{code:'REMOTE_UNAVAILABLE',message:'must-not-serialize'}}as any),reject());
});
