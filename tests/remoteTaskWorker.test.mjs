import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { body, fixture, gate, json, require, server, sha } from './remoteTaskFixtures.mjs';
const { createRemoteTaskWorker, remoteTaskExecutionKey } = require('../electron/backend/remoteTaskWorker.cjs');
const { createRemoteMineruAdapter } = require('../electron/backend/remoteMineruAdapter.cjs');

test('worker offline service-named holder wins on A to B to A recovery', async (t) => {
  const { core } = await import('./remoteTaskFixtures.mjs');
  const modes = ['batch_known', 'submit_pending', 'missing-holder', 'mismatched-credential', 'mismatched-source',
    'mismatched-profile', 'stale-current-key', 'current-holder-missing', 'fresh-null-holder'];
  for (const mode of modes) await t.test(mode, async (subtest) => {
    const f = await fixture(subtest); const snapshot = structuredClone(f.snapshot); const holderB = randomUUID();
    f.task.attempt = mode === 'fresh-null-holder' ? 1 : 3; f.lease.attempt = f.task.attempt;
    f.task.recoveryProviderDeviceId = mode === 'fresh-null-holder' ? null : mode === 'current-holder-missing' ? snapshot.scope.deviceId : holderB;
    const oldScope = { ...snapshot.scope, deviceId: holderB }; const stableDataId = `pq_${f.task.id.replaceAll('-', '')}`;
    if (!['fresh-null-holder', 'current-holder-missing'].includes(mode)) await f.journal.write(snapshot.scope, f.task.id,
      { version: 1, jobId: f.task.id, kind: 'parse', attempt: 1, stage: 'prepared',
        executionKey: remoteTaskExecutionKey(mode === 'stale-current-key' ? { ...snapshot, generation: { ...snapshot.generation, credentials: 999 } } : snapshot, f.task) });
    if (!['missing-holder', 'current-holder-missing', 'fresh-null-holder'].includes(mode)) {
      const oldSnapshot = { ...snapshot, scope: oldScope,
        ...(mode === 'mismatched-credential' ? { generation: { ...snapshot.generation, credentials: 999 } } : {}) };
      const proofTask = { ...f.task,
        ...(mode === 'mismatched-source' ? { target: { ...f.task.target, sha256: '0'.repeat(64) } } : {}),
        ...(mode === 'mismatched-profile' ? { profile: { ...f.task.profile, digest: '0'.repeat(64) } } : {}) };
      await f.journal.write(oldScope, f.task.id, { version: 1, jobId: f.task.id, kind: 'parse', attempt: 2,
        stage: mode === 'submit_pending' ? 'submit_pending' : 'batch_known', executionKey: remoteTaskExecutionKey(oldSnapshot, proofTask),
        dataId: stableDataId, ...(mode === 'submit_pending' ? {} : { batchId: 'already-paid-batch' }) });
    }
    let claimed = false, freshSubmissionCalls = 0, confirms = 0, completions = 0, sourceReads = 0, fetchCalls = 0;
    const journalReads = [];
    const journal = { read: (scope, id) => { journalReads.push(scope.deviceId); return f.journal.read(scope, id); }, write: f.journal.write };
    const adapter = createRemoteMineruAdapter({ getConfig: async () => ({ apiBaseUrl: 'https://offline-mineru.example.test/api', apiToken: 'synthetic-key', modelVersion: 'vlm' }),
      materialize: async () => f.bytes, fetch: async (url, init = {}) => {
        fetchCalls++;
        if (init.method === 'POST') { freshSubmissionCalls++; return Response.json({ code: 0, data: { batch_id: 'new-paid-batch', file_urls: ['https://offline-mineru.example.test/upload'] } }); }
        if (init.method === 'PUT') return new Response(null);
        if (String(url).includes('/extract-results/batch/')) return Response.json({ code: 0, data: { extract_result: [{ data_id: stableDataId, state: 'done', full_zip_url: 'https://offline-mineru.example.test/result.zip' }] } });
        return new Response(Buffer.from('synthetic-offline-zip'));
      } });
    const worker = createRemoteTaskWorker({ core, journal, adapters: { parse: adapter }, capture: async () => structuredClone(snapshot), check: async () => {},
      readPdf: async () => { sourceReads++; return f.pdf; }, api: async (_snapshot, input) => {
        if (input.path.endsWith('/claim')) { if (claimed) return { claim: null }; claimed = true; return { claim: { task: structuredClone(f.task), lease: { ...f.lease } } }; }
        if (input.path.endsWith('/recovery-confirm')) { confirms++; f.task.recoveryProviderDeviceId = snapshot.scope.deviceId; return { task: structuredClone(f.task) }; }
        if (input.path.endsWith('/heartbeat')) return { task: structuredClone(f.task) };
        if (input.path.endsWith('/complete')) { completions++; f.task.state = 'succeeded'; f.task.artifact = { digest: sha(input.bytes), sizeBytes: input.bytes.length, mediaType: 'application/json' }; return { task: structuredClone(f.task), replayed: false }; }
        if (input.path.endsWith('/fail')) { f.task.state = input.body.code === 'EXTERNAL_OUTCOME_UNKNOWN' ? 'interrupted' : 'failed'; return { task: structuredClone(f.task) }; }
        return {};
      } });
    subtest.after(() => worker.stop()); await worker.start({ manual: true }); const result = await worker.runOnce();
    const readServiceNamedHolder = journalReads.includes(holderB);
    const diagnostic = JSON.stringify({ freshSubmissionCalls, readServiceNamedHolder, confirms, result });
    assert.equal(freshSubmissionCalls, mode === 'fresh-null-holder' ? 1 : 0, diagnostic);
    if (!['current-holder-missing', 'fresh-null-holder'].includes(mode)) assert.equal(readServiceNamedHolder, true, diagnostic);
    if (['batch_known', 'stale-current-key', 'fresh-null-holder'].includes(mode)) {
      assert.equal(result.state, 'succeeded', diagnostic); assert.equal(confirms, 1); assert.equal(completions, 1);
    } else if (mode === 'submit_pending') {
      assert.equal(result.errorCode, 'EXTERNAL_OUTCOME_UNKNOWN', diagnostic); assert.equal(confirms, 1); assert.equal(fetchCalls, 0);
      assert.equal((await f.journal.read(snapshot.scope, f.task.id)).stage, 'submit_pending');
    } else {
      assert.equal(result.errorCode, mode.startsWith('mismatched-') ? 'PROFILE_CHANGED' : 'SOURCE_UNAVAILABLE', diagnostic);
      assert.equal(confirms, 0); assert.equal(completions, 0); assert.equal(sourceReads, 0); assert.equal(fetchCalls, 0);
      assert.equal((await f.journal.read(snapshot.scope, f.task.id))?.stage ?? null, mode === 'current-holder-missing' ? null : 'prepared');
    }
  });
});

async function workerFixture(t, options = {}) {
  const f = await fixture(t); let queued = true; let loseCompletion = false; let cancelHeartbeat = false;
  const requests = []; const states = []; let lease = { ...f.lease };
  const apiServer = await server(t, async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer SYNTHETIC_SESSION_TOKEN');
    const data = request.method === 'GET' ? Buffer.alloc(0) : await body(request);
    requests.push({ method: request.method, path: request.url, data: data.toString('utf8') });
    if (request.url === '/v1/remote-tasks/provider') {
      if (request.method === 'DELETE') {
        if (['running', 'cancel_requested'].includes(f.task.state)) f.task.state = 'interrupted';
        return json(response, { disabled: true });
      }
      const input = JSON.parse(data); assert.deepEqual(Object.keys(input), ['profiles']);
      return json(response, { provider: { deviceId: f.snapshot.scope.deviceId, profiles: input.profiles, expiresAt: new Date(Date.now() + 45000).toISOString() } });
    }
    if (request.url === '/v1/remote-tasks/provider/claim') {
      if (!queued) return json(response, { claim: null }); queued = false; f.task.state = 'running';
      return json(response, { claim: { task: f.task, lease } });
    }
    if (request.url.endsWith('/heartbeat')) {
      const input = JSON.parse(data); assert.deepEqual(input, lease);
      await options.beforeHeartbeat?.();
      if (cancelHeartbeat || f.task.state === 'cancel_requested') f.task.state = 'cancelled';
      return json(response, { task: f.task });
    }
    if (request.url.endsWith('/recovery-confirm')) {
      const input = JSON.parse(data); assert.deepEqual(input, lease);
      f.task.recoveryProviderDeviceId = f.task.providerDeviceId;
      if (options.loseRecoveryConfirm) { options.loseRecoveryConfirm = false; request.socket.destroy(); return; }
      if (options.cancelRecoveryConfirm) f.task.state = 'cancel_requested';
      return json(response, { task: f.task });
    }
    if (request.url.endsWith('/complete')) {
      assert.equal(request.headers['x-paperquay-remote-fence'], lease.fence);
      assert.equal(request.headers['x-paperquay-remote-attempt'], String(lease.attempt));
      if (loseCompletion) { loseCompletion = false; request.socket.destroy(); return; }
      f.task.state = 'succeeded'; f.task.artifact = { digest: sha(data), sizeBytes: data.length, mediaType: 'application/json' };
      return json(response, { task: f.task, replayed: false });
    }
    if (request.url.endsWith('/fail')) {
      const input = JSON.parse(data);
      if (f.task.state === 'succeeded') return json(response, { error: { code: 'REMOTE_TASK_LEASE_CHANGED' } }, 409);
      f.task.state = input.code === 'EXTERNAL_OUTCOME_UNKNOWN' ? 'interrupted' : 'failed'; f.task.failure = input.code;
      return json(response, { task: f.task });
    }
    json(response, { error: { code: 'NOT_FOUND' } }, 404);
  });
  f.snapshot.scope.service = apiServer.base;
  const api = async (_snapshot, input) => {
    const response = await fetch(apiServer.base + input.path, { method: input.method, redirect: 'error', signal: input.signal,
      headers: { Authorization: 'Bearer SYNTHETIC_SESSION_TOKEN', ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...input.headers },
      ...(input.body === undefined && !input.bytes ? {} : { body: input.bytes || JSON.stringify(input.body) }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error.code), { code: result.error.code }); return result;
  };
  const factory = (adapter, extra = {}) => createRemoteTaskWorker({ core: options.core, journal: f.journal, adapters: { parse: adapter },
    capture: async () => structuredClone(f.snapshot), check: async () => {}, api,
    readPdf: async () => f.pdf, timings: { pollMs: 5, presenceMs: 30, heartbeatMs: 20, guardMs: 5 }, onState: (state) => states.push(state), ...extra });
  return { ...f, requests, states, api, factory,
    loseCompletion: () => { loseCompletion = true; }, cancel: () => { cancelHeartbeat = true; },
    resume: () => { f.task.attempt++; f.task.state = 'queued'; f.task.failure = null; queued = true; lease = { attempt: f.task.attempt, fence: randomUUID() }; } };
}
test('worker explicit start/stop publishes only public profiles and completes through real HTTP with the current fence', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core });
  let executed = 0;
  const external = await server(t, (_request, response) => { executed++; response.end(f.bytes); });
  const worker = f.factory({ execute: async ({ signal }) => Buffer.from(await (await fetch(external.base, { signal })).arrayBuffer()) });
  t.after(() => worker.stop()); assert.equal(f.requests.length, 0); assert.equal(worker.snapshot().running, false);
  await worker.start({ manual: true }); const result = await worker.runOnce();
  assert.equal(result.state, 'succeeded'); assert.equal(executed, 1);
  const complete = f.requests.find((request) => request.path.endsWith('/complete')); assert.deepEqual(Buffer.from(complete.data), f.bytes);
  const provider = JSON.parse(f.requests.find((request) => request.method === 'PUT').data);
  assert.deepEqual(provider, { profiles: f.snapshot.profiles });
  assert.equal(JSON.stringify(provider).includes('SYNTHETIC_SESSION_TOKEN'), false); assert.equal(JSON.stringify(provider).includes(external.base), false);
  await worker.stop(); assert.equal(worker.snapshot().running, false); assert.ok(f.requests.some((request) => request.method === 'DELETE'));
});
test('worker stop aborts a real MinerU submission socket; its journal prevents a paid resubmit after restart', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core });
  const submitted = gate(), closed = gate(); let submissions = 0;
  const upstream = await server(t, async (request, response) => { await body(request); submissions++; response.once('close', () => closed.resolve()); submitted.resolve(); });
  const adapter = () => createRemoteMineruAdapter({ getConfig: async () => ({ apiBaseUrl: upstream.base, apiToken: 'synthetic-private-key', modelVersion: 'vlm' }), materialize: f.materialize });
  const first = f.factory(adapter()); t.after(() => first.stop()); await first.start({ manual: true });
  const active = first.runOnce(); await submitted.promise; await first.stop(); await active; await closed.promise;
  assert.equal(submissions, 1); assert.equal((await f.journal.read(f.snapshot.scope, f.task.id)).stage, 'submit_pending');
  f.resume(); f.snapshot.generation.account++;
  const restarted = f.factory(adapter()); t.after(() => restarted.stop()); await restarted.start({ manual: true });
  const result = await restarted.runOnce(); assert.equal(result.errorCode, 'EXTERNAL_OUTCOME_UNKNOWN'); assert.equal(submissions, 1);
});
test('completion response loss keeps a canonical artifact and explicit resumed work does not rerun the adapter', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core }); let externalCalls = 0; let reads = 0;
  const upstream = await server(t, (_request, response) => { externalCalls++; response.end(f.bytes); });
  const adapter = { execute: async ({ signal }) => Buffer.from(await (await fetch(upstream.base, { signal })).arrayBuffer()) };
  const first = f.factory(adapter, { readPdf: async () => { reads++; return f.pdf; } }); t.after(() => first.stop());
  await first.start({ manual: true }); f.loseCompletion(); const failed = await first.runOnce();
  assert.equal(failed.state, 'interrupted'); assert.equal((await f.journal.read(f.snapshot.scope, f.task.id)).stage, 'complete_pending');
  await first.stop(); f.resume(); f.snapshot.generation.account++;
  const second = f.factory(adapter, { readPdf: async () => { reads++; return f.pdf; } }); t.after(() => second.stop());
  await second.start({ manual: true }); assert.equal((await second.runOnce()).state, 'succeeded');
  assert.equal(externalCalls, 1); assert.equal(reads, 2, 'cached output still revalidates the selected pinned PDF');
  assert.equal(f.requests.filter((request) => request.path.endsWith('/complete')).length, 2);
});
test('credential/account generation change aborts an actual pending request and sends nothing under the new binding', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core }); const started = gate(), closed = gate();
  const upstream = await server(t, (_request, response) => { response.once('close', () => closed.resolve()); started.resolve(); });
  const worker = f.factory({ execute: async ({ signal }) => Buffer.from(await (await fetch(upstream.base, { signal })).arrayBuffer()) });
  t.after(() => worker.stop()); await worker.start({ manual: true }); const active = worker.runOnce(); await started.promise;
  const before = f.requests.length; f.snapshot.generation.credentials++; f.snapshot.generation.account++;
  await closed.promise; const result = await active; assert.equal(result.state, 'interrupted'); assert.equal(worker.snapshot().running, false);
  await worker.stop(); assert.equal(f.requests.slice(before).some((request) => request.method === 'DELETE' || request.path.endsWith('/fail')), false);
  assert.ok(f.states.some((state) => state.errorCode === 'REMOTE_BINDING_CHANGED'));
});
test('server cancellation through heartbeat aborts actual upstream work and never submits an artifact', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core }); const started = gate(), closed = gate();
  const upstream = await server(t, (_request, response) => { response.once('close', () => closed.resolve()); started.resolve(); });
  const worker = f.factory({ execute: async ({ signal }) => Buffer.from(await (await fetch(upstream.base, { signal })).arrayBuffer()) });
  t.after(() => worker.stop()); await worker.start({ manual: true }); const active = worker.runOnce(); await started.promise; f.cancel();
  await closed.promise; assert.equal((await active).state, 'cancelled');
  assert.equal(f.requests.some((request) => request.path.endsWith('/complete') || request.path.endsWith('/fail')), false);
});
test('worker rejects changed PDF bytes and credential revisions before cached artifact reuse', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core }); let calls = 0;
  const first = f.factory({ execute: async () => { calls++; return f.bytes; } }, { readPdf: async () => Buffer.alloc(f.pdf.length) });
  t.after(() => first.stop()); await first.start({ manual: true }); assert.equal((await first.runOnce()).errorCode, 'SOURCE_UNAVAILABLE');
  assert.equal(calls, 0); await first.stop(); f.resume();
  const second = f.factory({ execute: async () => { calls++; return f.bytes; } }); t.after(() => second.stop()); await second.start({ manual: true });
  f.loseCompletion(); assert.equal((await second.runOnce()).state, 'interrupted'); await second.stop(); f.resume(); f.snapshot.generation.credentials++;
  const third = f.factory({ execute: async () => { calls++; return f.bytes; } }); t.after(() => third.stop()); await third.start({ manual: true });
  assert.equal((await third.runOnce()).errorCode, 'PROFILE_CHANGED'); assert.equal(calls, 1);
});
test('worker drains an in-flight heartbeat before renewing and uploading completion', async (t) => {
  const entered = gate(), releaseHeartbeat = gate(), releaseOutput = gate(); let heartbeats = 0;
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core,
    beforeHeartbeat: async () => { if (++heartbeats === 1) { entered.resolve(); await releaseHeartbeat.promise; } } });
  const upstream = await server(t, async (_request, response) => { await releaseOutput.promise; response.end(f.bytes); });
  const worker = f.factory({ execute: async ({ signal }) => Buffer.from(await (await fetch(upstream.base, { signal })).arrayBuffer()) });
  t.after(() => worker.stop()); await worker.start({ manual: true }); const active = worker.runOnce();
  try {
    await entered.promise; releaseOutput.resolve(); await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.requests.some((request) => request.path.endsWith('/complete')), false);
  } finally { releaseOutput.resolve(); releaseHeartbeat.resolve(); }
  assert.equal((await active).state, 'succeeded'); assert.ok(heartbeats >= 2);
});
test('worker rejects an oversized adapter result before canonical parsing or artifact upload', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core });
  const worker = f.factory({ execute: async () => Buffer.alloc(16 * 1024 * 1024 + 1) }); t.after(() => worker.stop());
  await worker.start({ manual: true }); assert.equal((await worker.runOnce()).errorCode, 'REMOTE_TASK_ARTIFACT_LIMIT');
  assert.equal(f.requests.some((request) => request.path.endsWith('/complete')), false);
});
test('explicit new-session reassignment recovers only the server-named known MinerU batch', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core });
  const uploaded = gate(), closed = gate(); let submissions = 0, uploads = 0, polls = 0, dataId;
  const upstream = await server(t, async (request, response) => {
    if (request.url.startsWith('/file-urls/batch')) {
      submissions++; dataId = JSON.parse(await body(request)).files[0].data_id;
      return json(response, { code: 0, data: { batch_id: 'reassigned-batch', file_urls: [upstream.base + '/upload'] } });
    }
    if (request.url === '/upload') { uploads++; await body(request); response.once('close', () => closed.resolve()); uploaded.resolve(); return; }
    if (request.url.startsWith('/extract-results/batch/')) { polls++; return json(response, { code: 0,
      data: { extract_result: [{ data_id: dataId, state: 'done', full_zip_url: upstream.base + '/zip' }] } }); }
    const zip = new (require('adm-zip'))(); zip.addFile('content_list.json', Buffer.from(JSON.stringify([{ type: 'text', page_idx: 0, text: 'Recovered output.' }]))); response.end(zip.toBuffer());
  });
  const adapter = () => createRemoteMineruAdapter({ getConfig: async () => ({ apiBaseUrl: upstream.base, apiToken: 'synthetic-key', modelVersion: 'vlm' }), materialize: f.materialize });
  const oldScope = structuredClone(f.snapshot.scope); const first = f.factory(adapter()); t.after(() => first.stop());
  await first.start({ manual: true }); const pending = first.runOnce(); await uploaded.promise; await first.stop(); await pending; await closed.promise;
  f.resume(); f.snapshot.scope.deviceId = randomUUID(); f.snapshot.generation.account++;
  f.task.providerDeviceId = f.snapshot.scope.deviceId; f.task.recoveryProviderDeviceId = oldScope.deviceId;
  const second = f.factory(adapter()); t.after(() => second.stop()); await second.start({ manual: true });
  assert.equal((await second.runOnce()).state, 'succeeded'); assert.equal(submissions, 1); assert.equal(uploads, 1); assert.equal(polls, 1);
  assert.equal((await f.journal.read(oldScope, f.task.id)).stage, 'completed');
  assert.equal((await f.journal.read(f.snapshot.scope, f.task.id)).stage, 'completed');
});
test('reassignment without matching local proof never creates a fresh execution journal or paid request', async (t) => {
  for (const mode of ['missing', 'missing-current-holder', 'credential-mismatch']) {
    const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core }); let executed = 0, reads = 0;
    const oldScope = { ...f.snapshot.scope, deviceId: mode === 'missing-current-holder' ? f.snapshot.scope.deviceId : randomUUID() }; f.task.recoveryProviderDeviceId = oldScope.deviceId;
    if (mode === 'credential-mismatch') {
      const wrongSnapshot = { ...f.snapshot, scope: oldScope, generation: { ...f.snapshot.generation, credentials: 999 } };
      await f.journal.write(oldScope, f.task.id, { version: 1, jobId: f.task.id, kind: 'parse', attempt: 1, stage: 'prepared',
        executionKey: remoteTaskExecutionKey(wrongSnapshot, f.task) });
    }
    const worker = f.factory({ execute: async () => { executed++; return f.bytes; } }, { readPdf: async () => { reads++; return f.pdf; } });
    t.after(() => worker.stop()); await worker.start({ manual: true });
    assert.equal((await worker.runOnce()).errorCode, mode === 'credential-mismatch' ? 'PROFILE_CHANGED' : 'SOURCE_UNAVAILABLE');
    assert.equal(executed, 0); assert.equal(reads, 0); assert.equal(await f.journal.read(f.snapshot.scope, f.task.id), null);
  }
});
test('an incorrect machine cannot replace the recovery holder before a correct new local session adopts its artifact', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core }); let paidCalls = 0;
  const upstream = await server(t, (_request, response) => { paidCalls++; response.end(f.bytes); });
  const adapter = { execute: async ({ signal }) => Buffer.from(await (await fetch(upstream.base, { signal })).arrayBuffer()) };
  const first = f.factory(adapter); t.after(() => first.stop()); await first.start({ manual: true }); f.loseCompletion(); await first.runOnce();
  const holderA = f.snapshot.scope.deviceId; assert.equal(f.task.recoveryProviderDeviceId, holderA); await first.stop();
  f.resume(); f.snapshot.scope.deviceId = randomUUID(); f.task.providerDeviceId = f.snapshot.scope.deviceId;
  const foreign = require('../electron/backend/remoteTaskJournal.cjs').createRemoteTaskJournal({ directory: require('node:path').join(f.root, 'foreign-machine-journal') });
  const wrong = f.factory(adapter, { journal: foreign }); t.after(() => wrong.stop()); await wrong.start({ manual: true });
  assert.equal((await wrong.runOnce()).errorCode, 'SOURCE_UNAVAILABLE'); assert.equal(f.task.recoveryProviderDeviceId, holderA); await wrong.stop();
  f.resume(); f.snapshot.scope.deviceId = randomUUID(); f.task.providerDeviceId = f.snapshot.scope.deviceId; f.snapshot.generation.account++;
  const correct = f.factory(adapter); t.after(() => correct.stop()); await correct.start({ manual: true });
  assert.equal((await correct.runOnce()).state, 'succeeded'); assert.equal(paidCalls, 1);
  assert.equal(f.task.recoveryProviderDeviceId, f.snapshot.scope.deviceId);
});
test('a confirmed intermediate holder preserves newer batch progress for the next session instead of using older prepared evidence', async (t) => {
  const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core });
  const holderA = structuredClone(f.snapshot); const uploaded = gate(), closed = gate(); let submissions = 0, uploads = 0, dataId;
  await f.journal.write(holderA.scope, f.task.id, { version: 1, jobId: f.task.id, kind: 'parse', attempt: 1, stage: 'prepared', executionKey: remoteTaskExecutionKey(holderA, f.task) });
  f.task.recoveryProviderDeviceId = holderA.scope.deviceId;
  const upstream = await server(t, async (request, response) => {
    if (request.url.startsWith('/file-urls/batch')) { submissions++; dataId = JSON.parse(await body(request)).files[0].data_id;
      return json(response, { code: 0, data: { batch_id: 'newer-holder-batch', file_urls: [upstream.base + '/upload'] } }); }
    if (request.url === '/upload') { uploads++; await body(request); response.once('close', () => closed.resolve()); uploaded.resolve(); return; }
    if (request.url.startsWith('/extract-results/batch/')) return json(response, { code: 0, data: { extract_result: [{ data_id: dataId, state: 'done', full_zip_url: upstream.base + '/zip' }] } });
    const zip = new (require('adm-zip'))(); zip.addFile('content_list.json', Buffer.from(JSON.stringify([{ type: 'text', page_idx: 0, text: 'Latest batch.' }]))); response.end(zip.toBuffer());
  });
  const adapter = () => createRemoteMineruAdapter({ getConfig: async () => ({ apiBaseUrl: upstream.base, apiToken: 'synthetic-key', modelVersion: 'vlm' }), materialize: f.materialize });
  f.resume(); f.snapshot.scope.deviceId = randomUUID(); f.task.providerDeviceId = f.snapshot.scope.deviceId;
  const holderB = f.snapshot.scope.deviceId; const second = f.factory(adapter()); t.after(() => second.stop()); await second.start({ manual: true });
  const active = second.runOnce(); await uploaded.promise; assert.equal(f.task.recoveryProviderDeviceId, holderB); await second.stop(); await active; await closed.promise;
  assert.equal((await f.journal.read(holderA.scope, f.task.id)).stage, 'prepared');
  f.resume(); f.snapshot.scope.deviceId = randomUUID(); f.task.providerDeviceId = f.snapshot.scope.deviceId;
  const reads = []; const recording = { read: (scope, id) => { reads.push(scope.deviceId); return f.journal.read(scope, id); }, write: f.journal.write };
  const third = f.factory(adapter(), { journal: recording }); t.after(() => third.stop()); await third.start({ manual: true });
  assert.equal((await third.runOnce()).state, 'succeeded'); assert.equal(submissions, 1); assert.equal(uploads, 1);
  assert.ok(reads.includes(holderB)); assert.equal(reads.includes(holderA.scope.deviceId), false);
});
test('uncertain recovery confirmation and cancellation authorize no paid external work', async (t) => {
  for (const mode of ['lost-ack', 'cancelled']) {
    const f = await workerFixture(t, { core: (await import('./remoteTaskFixtures.mjs')).core,
      loseRecoveryConfirm: mode === 'lost-ack', cancelRecoveryConfirm: mode === 'cancelled' }); let executed = 0;
    const worker = f.factory({ execute: async () => { executed++; return f.bytes; } }); t.after(() => worker.stop()); await worker.start({ manual: true });
    const result = await worker.runOnce(); assert.equal(executed, 0); assert.equal(result.state, mode === 'cancelled' ? 'cancelled' : 'interrupted');
    assert.equal((await f.journal.read(f.snapshot.scope, f.task.id)).stage, 'prepared');
    assert.equal(f.task.recoveryProviderDeviceId, f.snapshot.scope.deviceId);
  }
});
