import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { body, core, fixture, gate, json, require, server, sha } from './remoteTaskFixtures.mjs';
const { createRemoteMineruAdapter, createRemoteMineruMaterializer } = require('../electron/backend/remoteMineruAdapter.cjs');
const { createRemoteVectorAdapter, buildRemoteVectorChunks, REMOTE_VECTOR_CHUNKER } = require('../electron/backend/remoteVectorAdapter.cjs');
const AdmZip = require('adm-zip');
function zip() {
  const archive = new AdmZip(); archive.addFile('content_list.json', Buffer.from(JSON.stringify([
    { type: 'text', text: 'Real synthetic MinerU output.', page_idx: 0 }, { type: 'equation', text: 'E=mc^2', page_idx: 0 },
  ]))); return archive.toBuffer();
}
function context(f, checkpoint, signal = new AbortController().signal) {
  return { task: f.task, lease: f.lease, snapshot: f.snapshot, pdf: f.pdf, checkpoint, signal,
    check: async () => { if (signal.aborted) throw Object.assign(new Error('DESKTOP_OPERATION_CANCELLED'), { code: 'DESKTOP_OPERATION_CANCELLED' }); } };
}
test('MinerU offline submission keeps missing or invalid business codes uncertain across explicit recovery', async (t) => {
  const cases = [
    ['missing-code', { data: { batch_id: 'accepted-batch' } }],
    ['string-zero', { code: '0', data: { batch_id: 'accepted-batch' } }],
    ['string-error', { code: '400', data: { batch_id: 'accepted-batch' } }],
    ['boolean-code', { code: true, data: { batch_id: 'accepted-batch' } }],
    ['null-code', { code: null, data: { batch_id: 'accepted-batch' } }],
    ['fractional-code', { code: 0.5, data: { batch_id: 'accepted-batch' } }],
    ['unsafe-integer-code', { code: 1e20, data: { batch_id: 'accepted-batch' } }],
    ['nonfinite-code', '{"code":1e309,"data":{"batch_id":"accepted-batch"}}'],
  ];
  for (const [name, envelope] of cases) await t.test(name, async (subtest) => {
    const f = await fixture(subtest); const checkpoint = await f.checkpoint(); let posts = 0;
    const options = { getConfig: async () => ({ apiBaseUrl: 'https://offline-mineru.example.test/api', apiToken: 'synthetic-key', modelVersion: 'vlm' }),
      materialize: async () => f.bytes,
      fetch: async (_url, init) => { assert.equal(init.method, 'POST'); posts++;
        return typeof envelope === 'string' ? new Response(envelope, { headers: { 'content-type': 'application/json' } }) : Response.json(envelope); } };
    const outcomes = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const restored = attempt ? await f.checkpoint(false) : checkpoint;
      try { await createRemoteMineruAdapter(options).execute(context(f, restored)); outcomes.push('unexpected-success'); }
      catch (error) { outcomes.push(error.code); }
    }
    const stage = (await checkpoint.read()).stage;
    assert.deepEqual(outcomes, ['EXTERNAL_OUTCOME_UNKNOWN', 'EXTERNAL_OUTCOME_UNKNOWN'], JSON.stringify({ posts, outcomes, stage }));
    assert.equal(posts, 1); assert.equal(stage, 'submit_pending');
  });
});
test('MinerU offline submission keeps incomplete success and transport-only rejection uncertain', async (t) => {
  const cases = [
    ['missing-batch', { code: 0, data: { file_urls: ['https://offline-mineru.example.test/upload'] } }, 200],
    ['missing-upload-url', { code: 0, data: { batch_id: 'accepted-batch' } }, 200],
    ['empty-upload-urls', { code: 0, data: { batch_id: 'accepted-batch', file_urls: [] } }, 200],
    ['invalid-upload-url', { code: 0, data: { batch_id: 'accepted-batch', file_urls: ['javascript:invalid'] } }, 200],
    ['unexpected-upload-count', { code: 0, data: { batch_id: 'accepted-batch', file_urls: ['https://offline-mineru.example.test/one', 'https://offline-mineru.example.test/two'] } }, 200],
    ['http-rejection-without-business-proof', { data: { batch_id: 'accepted-batch' } }, 409],
  ];
  for (const [name, envelope, status] of cases) await t.test(name, async (subtest) => {
    const f = await fixture(subtest); const checkpoint = await f.checkpoint(); let posts = 0;
    const options = { getConfig: async () => ({ apiBaseUrl: 'https://offline-mineru.example.test/api', apiToken: 'synthetic-key', modelVersion: 'vlm' }),
      materialize: async () => f.bytes, fetch: async (_url, init) => { assert.equal(init.method, 'POST'); posts++; return Response.json(envelope, { status }); } };
    const outcomes = [];
    for (let attempt = 0; attempt < 2; attempt++) try {
      await createRemoteMineruAdapter(options).execute(context(f, attempt ? await f.checkpoint(false) : checkpoint)); outcomes.push('unexpected-success');
    } catch (error) { outcomes.push(error.code); }
    const stage = (await checkpoint.read()).stage;
    assert.deepEqual(outcomes, ['EXTERNAL_OUTCOME_UNKNOWN', 'EXTERNAL_OUTCOME_UNKNOWN'], JSON.stringify({ posts, outcomes, stage }));
    assert.equal(posts, 1); assert.equal(stage, 'submit_pending');
  });
});
test('MinerU offline submission preserves explicit success and numeric business rejection behavior', async (t) => {
  await t.test('complete-success-is-durable-and-not-resubmitted', async (subtest) => {
    const f = await fixture(subtest); const checkpoint = await f.checkpoint(); let posts = 0, uploads = 0, dataId;
    const options = { getConfig: async () => ({ apiBaseUrl: 'https://offline-mineru.example.test/api', apiToken: 'synthetic-key', modelVersion: 'vlm' }),
      materialize: async () => f.bytes, fetch: async (url, init) => {
        if (init.method === 'POST') { posts++; dataId = JSON.parse(init.body).files[0].data_id;
          return Response.json({ code: 0, data: { batch_id: 'accepted-batch', file_urls: ['https://offline-mineru.example.test/upload'] } }); }
        if (init.method === 'PUT') { uploads++; assert.deepEqual(Buffer.from(init.body), f.pdf); assert.equal((await checkpoint.read()).batchId, 'accepted-batch'); return new Response(null); }
        if (String(url).includes('/extract-results/')) return Response.json({ code: 0, data: { extract_result: [{ data_id: dataId, state: 'done', full_zip_url: 'https://offline-mineru.example.test/result.zip' }] } });
        return new Response(Buffer.from('synthetic-offline-zip'));
      } };
    assert.deepEqual(await createRemoteMineruAdapter(options).execute(context(f, checkpoint)), f.bytes);
    assert.deepEqual(await createRemoteMineruAdapter(options).execute(context(f, await f.checkpoint(false))), f.bytes);
    assert.equal(posts, 1); assert.equal(uploads, 1); assert.equal((await checkpoint.read()).stage, 'artifact_ready');
  });
  for (const code of [400, -5001]) await t.test(`explicit-business-rejection-${code}`, async (subtest) => {
    const f = await fixture(subtest); const checkpoint = await f.checkpoint(); let posts = 0;
    const options = { getConfig: async () => ({ apiBaseUrl: 'https://offline-mineru.example.test/api', apiToken: 'synthetic-key', modelVersion: 'vlm' }),
      materialize: async () => f.bytes, fetch: async () => { posts++; return Response.json({ code, message: 'Synthetic explicit business rejection' }); } };
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(createRemoteMineruAdapter(options).execute(context(f, attempt ? await f.checkpoint(false) : checkpoint)), { code: 'EXECUTION_FAILED' });
    assert.equal(posts, 2); assert.equal((await checkpoint.read()).stage, 'prepared');
  });
});
test('MinerU executes actual staged HTTP, pins exact uploaded bytes and reuses safe ZIP/provenance/portable export', async (t) => {
  const f = await fixture(t); const checkpoint = await f.checkpoint(); let submits = 0, uploads = 0, polls = 0, dataId;
  const upstream = await server(t, async (request, response) => {
    if (request.url.startsWith('/api/file-urls/batch')) {
      submits++; assert.equal((await checkpoint.read()).stage, 'submit_pending');
      assert.equal(request.headers.authorization, 'Bearer SYNTHETIC_MINERU_SECRET');
      const input = JSON.parse(await body(request)); dataId = input.files[0].data_id; assert.equal(input.model_version, 'vlm');
      return json(response, { code: 0, data: { batch_id: 'synthetic-batch', file_urls: [upstream.base + '/upload?signature=PRIVATE_SYNTHETIC'] } });
    }
    if (request.url.startsWith('/upload')) {
      uploads++; assert.equal(request.headers.authorization, undefined); assert.equal((await checkpoint.read()).batchId, 'synthetic-batch');
      assert.deepEqual(await body(request), f.pdf); response.end(); return;
    }
    if (request.url === '/api/extract-results/batch/synthetic-batch') {
      polls++; return json(response, { code: 0, data: { extract_result: [{ data_id: dataId, state: 'done', full_zip_url: upstream.base + '/result.zip?signature=PRIVATE_SYNTHETIC' }] } });
    }
    assert.equal(request.headers.authorization, undefined); response.end(zip());
  });
  const adapter = createRemoteMineruAdapter({ getConfig: async () => ({ apiBaseUrl: upstream.base + '/api', apiToken: 'SYNTHETIC_MINERU_SECRET', modelVersion: 'vlm', pollIntervalMs: 1 }), materialize: f.materialize });
  const result = await adapter.execute(context(f, checkpoint));
  const parsed = await core.decodeParsedDocument(new Uint8Array(result));
  assert.equal(parsed.document.pdf.sha256, f.task.target.sha256); assert.equal(parsed.document.pdf.pageCount, 1);
  assert.match(parsed.document.blocks.map((block) => block.text).join(' '), /Real synthetic/);
  assert.equal(submits, 1); assert.equal(uploads, 1); assert.equal(polls, 1);
  assert.equal((await checkpoint.read()).stage, 'artifact_ready');
  const stored = JSON.stringify(await checkpoint.read());
  assert.equal(stored.includes('SYNTHETIC_MINERU_SECRET'), false); assert.equal(stored.includes('PRIVATE_SYNTHETIC'), false); assert.equal(stored.includes(upstream.base), false);
});
test('MinerU submission response loss is durable uncertainty and a new adapter never submits it again', async (t) => {
  const f = await fixture(t); const checkpoint = await f.checkpoint(); let submits = 0;
  const upstream = await server(t, async (request) => { await body(request); submits++; request.socket.destroy(); });
  const options = { getConfig: async () => ({ apiBaseUrl: upstream.base, apiToken: 'synthetic-key', modelVersion: 'vlm' }), materialize: f.materialize };
  await assert.rejects(createRemoteMineruAdapter(options).execute(context(f, checkpoint)), { code: 'EXTERNAL_OUTCOME_UNKNOWN' });
  assert.equal((await checkpoint.read()).stage, 'submit_pending');
  await assert.rejects(createRemoteMineruAdapter(options).execute(context(f, await f.checkpoint(false))), { code: 'EXTERNAL_OUTCOME_UNKNOWN' });
  assert.equal(submits, 1);
});
test('a received batch whose journal commit fails remains uncertain and cannot be submitted twice', async (t) => {
  const f = await fixture(t); const checkpoint = await f.checkpoint(); let submits = 0;
  const upstream = await server(t, async (request, response) => { await body(request); submits++;
    json(response, { code: 0, data: { batch_id: 'known-but-not-durable', file_urls: [upstream.base + '/upload'] } }); });
  const adapter = createRemoteMineruAdapter({ getConfig: async () => ({ apiBaseUrl: upstream.base, apiToken: 'synthetic-key', modelVersion: 'vlm' }), materialize: f.materialize });
  const fault = { read: checkpoint.read, write: (entry) => entry.stage === 'batch_known' ? Promise.reject(new Error('SYNTHETIC_DISK_FULL')) : checkpoint.write(entry) };
  await assert.rejects(adapter.execute(context(f, fault)), { code: 'EXTERNAL_OUTCOME_UNKNOWN' });
  assert.equal((await checkpoint.read()).stage, 'submit_pending');
  await assert.rejects(adapter.execute(context(f, await f.checkpoint(false))), { code: 'EXTERNAL_OUTCOME_UNKNOWN' }); assert.equal(submits, 1);
});
test('known MinerU batch survives a real aborted upload and recovery only queries/downloads', async (t) => {
  const f = await fixture(t); const checkpoint = await f.checkpoint(); const uploaded = gate(), closed = gate(); let submits = 0, uploads = 0, dataId;
  const upstream = await server(t, async (request, response) => {
    if (request.url.startsWith('/file-urls/batch')) {
      submits++; dataId = JSON.parse(await body(request)).files[0].data_id;
      return json(response, { code: 0, data: { batch_id: 'known-batch', file_urls: [upstream.base + '/upload'] } });
    }
    if (request.url === '/upload') { uploads++; await body(request); response.once('close', () => closed.resolve()); uploaded.resolve(); return; }
    if (request.url.startsWith('/extract-results/batch/')) return json(response, { code: 0, data: { extract_result: [{ data_id: dataId, state: 'done', full_zip_url: upstream.base + '/zip' }] } });
    response.end(zip());
  });
  const options = { getConfig: async () => ({ apiBaseUrl: upstream.base, apiToken: 'synthetic-key', modelVersion: 'vlm', pollIntervalMs: 1 }), materialize: f.materialize };
  const controller = new AbortController(); const pending = createRemoteMineruAdapter(options).execute(context(f, checkpoint, controller.signal));
  await uploaded.promise; controller.abort(); await assert.rejects(pending); await closed.promise;
  assert.equal((await checkpoint.read()).batchId, 'known-batch');
  const output = await createRemoteMineruAdapter(options).execute(context(f, await f.checkpoint(false)));
  assert.equal((await core.decodeParsedDocument(new Uint8Array(output))).document.pdf.pageCount, 1);
  assert.equal(submits, 1); assert.equal(uploads, 1);
});
test('materializer rejects duplicate paths before extraction', async (t) => {
  const f = await fixture(t);
  const archive = new AdmZip(); archive.addFile('A.json', Buffer.from('[]')); archive.addFile('a.json', Buffer.from('[]'));
  await assert.rejects(f.materialize({ zipBytes: archive.toBuffer(), pdf: f.pdf, task: f.task, signal: new AbortController().signal,
    check: async () => {}, runId: 'synthetic' }), { code: 'REMOTE_PROVIDER_RESPONSE_INVALID' });
});
test('remote-only cache budget counts existing bytes and refuses before submitting paid work without deleting files', async (t) => {
  const f = await fixture(t); const checkpoint = await f.checkpoint(); const cache = path.join(f.context.appPaths.mineruCacheDir, 'remote-tasks');
  fs.mkdirSync(cache, { recursive: true }); const existing = path.join(cache, 'existing-synthetic.bin'); fs.writeFileSync(existing, 'retained');
  const materialize = createRemoteMineruMaterializer(f.context, { core, converter: require('../electron/generated/desktopParsedDocument.cjs'), maxCacheBytes: 64 * 1024 * 1024 });
  let requests = 0; const upstream = await server(t, (_request, response) => { requests++; json(response, {}); });
  const adapter = createRemoteMineruAdapter({ getConfig: async () => ({ apiBaseUrl: upstream.base, apiToken: 'synthetic-key', modelVersion: 'vlm' }), materialize });
  await assert.rejects(adapter.execute(context(f, checkpoint)), { code: 'REMOTE_MINERU_CACHE_FULL' });
  assert.equal(requests, 0); assert.equal((await checkpoint.read()).stage, 'prepared');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'retained'); assert.deepEqual(fs.readdirSync(cache), ['existing-synthetic.bin']);
  const usage = await materialize.inspectCache(); assert.equal(usage.usedBytes, 8); assert.equal(usage.maxBytes, 64 * 1024 * 1024);
});
test('vector chunks preserve continuation pages, equations, tables and visible image/link text without resource targets', async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fKQAAAAASUVORK5CYII=', 'base64');
  const f = await fixture(t, { kind: 'index', pageCount: 2, assets: [{ id: 'figure', mediaType: 'image/png', base64: png.toString('base64'), sha256: sha(png), sizeBytes: png.length, width: 1, height: 1 }], blocks: [
    { id: 'equation', pageIndex: 0, kind: 'equation', text: '', latex: 'E=mc^2' },
    { id: 'math', pageIndex: 0, kind: 'text', text: '', markdown: 'Math $\\{x\\}$ and $\\alpha \\setminus \\{0\\}$.' },
    { id: 'table', pageIndex: 0, kind: 'table', text: 'Additional table prose.', table: { caption: 'Caption $x$', rows: [{ section: 'head', cells: [{ text: 'Cell', rowSpan: 1, colSpan: 2, header: true }] }] } },
    { id: 'continued', pageIndex: 1, kind: 'table', text: '', sourceBlockId: 'table' },
    { id: 'image', pageIndex: 1, kind: 'image', text: '', assetId: 'figure', markdown: '![Visible image](https://resource.example.test/secret.png) and [Link label](file:///private/path)', caption: 'Figure caption.' },
  ] });
  const chunks = await buildRemoteVectorChunks(f.document); const text = chunks.map((item) => item.text).join('\n');
  assert.match(text, /E=mc\^2/); assert.match(text, /rowspan=1 colspan=2/); assert.match(text, /\[head\]/);
  assert.ok(text.includes('$\\{x\\}$')); assert.ok(text.includes('$\\alpha \\setminus \\{0\\}$'));
  assert.match(text, /Additional table prose/); assert.match(text, /Visible image/); assert.match(text, /Link label/);
  assert.equal(text.includes('secret.png'), false); assert.equal(text.includes('/private/path'), false); assert.equal(text.includes('assetId'), false);
  assert.ok(chunks.some((item) => item.pageIndex === 1 && item.text.includes('Additional table prose')));
  assert.equal(text.includes(png.toString('base64')), false);
  await assert.rejects(buildRemoteVectorChunks({ ...f.document, blocks: [{ id: 'html', pageIndex: 0, kind: 'text', text: '', markdown: '<div>Unrepresentable content</div>' }] }), { code: 'SOURCE_UNAVAILABLE' });
  await assert.rejects(buildRemoteVectorChunks({ ...f.document, blocks: [{ id: 'html', pageIndex: 0, kind: 'text', text: '', markdown: '<!-- first -->\n<div>Visible content</div>\n<!-- last -->' }] }), { code: 'SOURCE_UNAVAILABLE' });
});
test('actual embedding HTTP validates index ordering/dimensions and emits the bound portable artifact without old-index writes', async (t) => {
  const f = await fixture(t, { kind: 'index', blocks: [{ id: 'long', pageIndex: 0, kind: 'text', text: 'X'.repeat(1800) }] });
  const checkpoint = await f.checkpoint(); const inputs = [];
  const upstream = await server(t, async (request, response) => {
    assert.equal(request.url, '/v1/embeddings'); assert.equal(request.headers.authorization, 'Bearer SYNTHETIC_EMBEDDING_SECRET');
    const input = JSON.parse(await body(request)); inputs.push(input.input); assert.equal(input.dimensions, 3);
    json(response, { data: input.input.map((_text, index) => ({ index, embedding: [index + 0.25, 0.5, 0.75] })).reverse() });
  });
  const adapter = createRemoteVectorAdapter({ core, getConfig: async () => ({ baseUrl: upstream.base + '/v1', apiKey: 'SYNTHETIC_EMBEDDING_SECRET', model: f.task.profile.model, dimensions: 3, batchSize: 2 }), readParsed: async () => f.bytes });
  const artifact = await core.decodeRemoteIndexArtifact(new Uint8Array(await adapter.execute(context(f, checkpoint))));
  assert.equal(inputs.length, 2); assert.equal(artifact.document.parseDigest, f.parsed.digest);
  assert.equal(artifact.document.dimension, 3); assert.deepEqual(artifact.document.chunker, REMOTE_VECTOR_CHUNKER);
  assert.deepEqual(artifact.document.chunks[0].vector, [0.25, 0.5, 0.75]);
  assert.equal(JSON.stringify(artifact.document).includes('SYNTHETIC_EMBEDDING_SECRET'), false);
  assert.equal(JSON.stringify(await checkpoint.read()).includes(upstream.base), false);
});
test('durable received embedding batches resume without billing them again; unresolved responses never replay', async (t) => {
  const f = await fixture(t, { kind: 'index', blocks: [{ id: 'long', pageIndex: 0, kind: 'text', text: 'X'.repeat(1800) }] });
  const checkpoint = await f.checkpoint(); let requests = 0; let loseResponse = false;
  const upstream = await server(t, async (request, response) => {
    const input = JSON.parse(await body(request)); requests++;
    if (loseResponse) { request.socket.destroy(); return; }
    json(response, { data: input.input.map((_text, index) => ({ index, embedding: [0.25, 0.5] })) });
  });
  const options = { core, getConfig: async () => ({ baseUrl: upstream.base, apiKey: 'synthetic-key', model: f.task.profile.model, dimensions: 2, batchSize: 2 }), readParsed: async () => f.bytes };
  const controller = new AbortController();
  const stopAfterResult = { read: checkpoint.read, write: async (entry) => { const saved = await checkpoint.write(entry);
    if (saved.stage === 'embedding_progress' && saved.vectorProgress.vectors.length === 2) controller.abort(); return saved; } };
  await assert.rejects(createRemoteVectorAdapter(options).execute(context(f, stopAfterResult, controller.signal)), { code: 'DESKTOP_OPERATION_CANCELLED' });
  assert.equal(requests, 1);
  await createRemoteVectorAdapter(options).execute(context(f, await f.checkpoint(false))); assert.equal(requests, 2);
  const other = await fixture(t, { kind: 'index' }); const otherCheckpoint = await other.checkpoint(); loseResponse = true;
  const lost = { ...options, getConfig: async () => ({ baseUrl: upstream.base, apiKey: 'synthetic-key', model: other.task.profile.model, dimensions: 2 }), readParsed: async () => other.bytes };
  await assert.rejects(createRemoteVectorAdapter(lost).execute(context(other, otherCheckpoint)), { code: 'EXTERNAL_OUTCOME_UNKNOWN' });
  const before = requests;
  await assert.rejects(createRemoteVectorAdapter(lost).execute(context(other, await other.checkpoint(false))), { code: 'EXTERNAL_OUTCOME_UNKNOWN' });
  assert.equal(requests, before);
});
test('embedding rejects source mismatch, preflight over-budget work and invalid vector dimensions', async (t) => {
  const f = await fixture(t, { kind: 'index' }); const checkpoint = await f.checkpoint(); let requests = 0;
  const upstream = await server(t, async (request, response) => { await body(request); requests++; json(response, { data: [{ index: 0, embedding: [1] }] }); });
  const options = { core, getConfig: async () => ({ baseUrl: upstream.base, apiKey: 'synthetic-key', model: f.task.profile.model, dimensions: 2 }), readParsed: async () => f.bytes };
  const wrong = context(f, checkpoint); wrong.task = { ...f.task, indexSourceDigest: '0'.repeat(64) };
  await assert.rejects(createRemoteVectorAdapter(options).execute(wrong), { code: 'SOURCE_UNAVAILABLE' }); assert.equal(requests, 0);
  await assert.rejects(createRemoteVectorAdapter(options).execute(context(f, checkpoint)), { code: 'EXTERNAL_OUTCOME_UNKNOWN' }); assert.equal(requests, 1);
  const large = await fixture(t, { kind: 'index', blocks: Array.from({ length: 20 }, (_, index) => ({ id: 'b' + index, pageIndex: 0, kind: 'text', text: 'X'.repeat(100000) })) });
  await assert.rejects(createRemoteVectorAdapter({ ...options, getConfig: async () => ({ baseUrl: upstream.base, apiKey: 'synthetic-key', model: large.task.profile.model, dimensions: 4096 }),
    readParsed: async () => large.bytes }).execute(context(large, await large.checkpoint())), { code: 'REMOTE_TASK_ARTIFACT_LIMIT' });
  assert.equal(requests, 1);
});
test('embedding refuses model mismatch, duplicate response indices and non-finite vectors without retrying a paid batch', async (t) => {
  let mode = 'model'; let requests = 0;
  const upstream = await server(t, async (request, response) => {
    const input = JSON.parse(await body(request)); requests++;
    const data = input.input.map((_value, index) => ({ index: mode === 'duplicate' ? 0 : index, embedding: mode === 'nonfinite' ? [null, 1] : [0.25, 0.5] }));
    json(response, { model: mode === 'model' ? 'different-model' : input.model, data });
  });
  for (mode of ['model', 'duplicate', 'nonfinite']) {
    const f = await fixture(t, { kind: 'index', blocks: [{ id: 'long', pageIndex: 0, kind: 'text', text: 'X'.repeat(1800) }] });
    const checkpoint = await f.checkpoint(); const adapter = createRemoteVectorAdapter({ core,
      getConfig: async () => ({ baseUrl: upstream.base, apiKey: 'synthetic-key', model: f.task.profile.model, dimensions: 2, batchSize: 2 }), readParsed: async () => f.bytes });
    await assert.rejects(adapter.execute(context(f, checkpoint)), { code: 'EXTERNAL_OUTCOME_UNKNOWN' });
    const before = requests;
    await assert.rejects(adapter.execute(context(f, await f.checkpoint(false))), { code: 'EXTERNAL_OUTCOME_UNKNOWN' });
    assert.equal(requests, before);
  }
  assert.equal(requests, 3);
});
