import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as core from '../packages/sync-core/src/modelInference.ts';

const require = createRequire(import.meta.url);
const { createComputerModelWorker } = require('../electron/backend/computerModelWorker.cjs');
const profile = { id: 'chat-default', revision: 1, digest: 'a'.repeat(64), kind: 'chat', model: 'synthetic', maxInputBytes: 192 * 1024, maxOutputTokens: 2048, stream: false };
const rateLimited = () => Object.assign(Error('RATE_LIMITED'), { code: 'RATE_LIMITED', statusCode: 429 });

function idleWorker(t, api, { accountId = randomUUID(), timings, check = async () => {} } = {}) {
  const snapshot = { scope: { service: 'https://sync.fixture.test', accountId, deviceId: randomUUID(), libraryId: randomUUID() }, profiles: [profile], generation: 'b'.repeat(64) };
  const worker = createComputerModelWorker({
    core, capture: async () => structuredClone(snapshot), check, api, timings,
    journal: { list: async () => [], capacity: async () => ({ retained: 0, maxRetained: 16 }), put: async () => assert.fail('Idle polling cannot write a model intent') },
    getPrivate: async () => assert.fail('Idle polling cannot read private model settings'),
  });
  t.after(() => worker.stop());
  return worker;
}

function fakeClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_800_000_000_000 });
}
async function advance(t, workers, seconds) {
  for (let i = 0; i < seconds; i++) {
    t.mock.timers.tick(1000);
    await Promise.all(workers.map(worker => worker.settled()));
  }
}
const idleReply = input => input.path.endsWith('/provider/claim') ? { claim: null } : { provider: {} };

test('four idle computer providers stay below the shared default account budget in every rolling minute', async t => {
  fakeClock(t);
  const accountId = randomUUID(), requests = [];
  let throttles = 0, maximum = 0;
  const api = async (snapshot, input) => {
    assert.equal(snapshot.scope.accountId, accountId);
    const now = Date.now(), count = requests.filter(row => row.at > now - 60_000).length;
    if (count >= 120) { throttles++; throw rateLimited(); }
    requests.push({ at: now, deviceId: snapshot.scope.deviceId, path: input.path });
    maximum = Math.max(maximum, count + 1);
    return idleReply(input);
  };
  const workers = Array.from({ length: 4 }, () => idleWorker(t, api, { accountId }));
  await Promise.all(workers.map(worker => worker.start()));
  await advance(t, workers, 180);
  assert.equal(throttles, 0);
  assert(maximum <= 68, 'Idle providers leave room for account actions below the 120/minute limit');
  assert.equal(new Set(requests.map(row => row.deviceId)).size, 4);
  assert(requests.some(row => row.path.endsWith('/provider/claim')));
  assert(workers.every(worker => worker.snapshot().running));
});

test('a throttled claim preserves enablement, pauses requests, then renews presence before polling again', async t => {
  fakeClock(t);
  const calls = [];
  let claims = 0;
  const worker = idleWorker(t, async (_snapshot, input) => {
    calls.push(input.path);
    if (input.path.endsWith('/provider/claim') && ++claims === 1) throw rateLimited();
    return idleReply(input);
  });
  await worker.start({ manual: true });
  assert.deepEqual(await worker.runOnce(), { worked: false });
  assert.equal(worker.snapshot().running, true);
  assert.equal(worker.snapshot().errorCode, 'RATE_LIMITED');
  const before = calls.length;
  await advance(t, [worker], 59); await worker.runOnce();
  assert.equal(calls.length, before);
  await advance(t, [worker], 1); await worker.runOnce();
  assert.deepEqual(calls.slice(before), ['/v1/model-inference/provider', '/v1/model-inference/provider/claim']);
  assert.equal(worker.snapshot().running, true);
  assert.equal(worker.snapshot().errorCode, null);
});

test('initial presence throttling waits without disabling the explicitly started provider', async t => {
  fakeClock(t);
  let presence = 0, claims = 0;
  const worker = idleWorker(t, async (_snapshot, input) => {
    if (input.path.endsWith('/provider') && ++presence === 1) throw rateLimited();
    if (input.path.endsWith('/provider/claim')) claims++;
    return idleReply(input);
  });
  await worker.start();
  assert.equal(worker.snapshot().running, true);
  assert.equal(worker.snapshot().errorCode, 'RATE_LIMITED');
  await advance(t, [worker], 59); assert.equal(presence, 1); assert.equal(claims, 0);
  await advance(t, [worker], 1); assert.equal(presence, 2); assert.equal(claims, 1);
  assert.equal(worker.snapshot().errorCode, null);
});

test('repeated throttling lengthens the quiet period and still permits later recovery', async t => {
  fakeClock(t);
  let claims = 0, requests = 0;
  const worker = idleWorker(t, async (_snapshot, input) => {
    requests++;
    if (input.path.endsWith('/provider/claim') && ++claims <= 2) throw rateLimited();
    return idleReply(input);
  });
  await worker.start({ manual: true }); await worker.runOnce();
  await advance(t, [worker], 60); await worker.runOnce(); assert.equal(claims, 2);
  const before = requests;
  await advance(t, [worker], 119); await worker.runOnce(); assert.equal(requests, before);
  await advance(t, [worker], 1); await worker.runOnce(); assert.equal(claims, 3);
  assert.equal(worker.snapshot().running, true); assert.equal(worker.snapshot().errorCode, null);
});

test('owner retirement during throttling stops locally and cannot republish the retired provider', async t => {
  fakeClock(t);
  let retired = false, requests = 0;
  const worker = idleWorker(t, async () => { requests++; throw rateLimited(); }, {
    check: async () => { if (retired) throw Object.assign(Error('MODEL_BINDING_CHANGED'), { code: 'MODEL_BINDING_CHANGED' }); },
  });
  await worker.start(); assert.equal(requests, 1); retired = true;
  await advance(t, [worker], 1); assert.equal(worker.snapshot().running, false);
  await advance(t, [worker], 120); assert.equal(requests, 1);
});

test('periodic presence throttling respects cooldown and an explicit stop prevents later renewal', async t => {
  fakeClock(t);
  let presence = 0, requests = 0;
  const worker = idleWorker(t, async (_snapshot, input) => {
    requests++;
    if (input.path.endsWith('/provider') && ++presence === 2) throw rateLimited();
    return idleReply(input);
  }, { timings: { pollMs: 10_000 } });
  await worker.start(); await advance(t, [worker], 15);
  assert.equal(worker.snapshot().running, true);
  assert.equal(worker.snapshot().errorCode, 'RATE_LIMITED');
  const before = requests;
  await advance(t, [worker], 30); assert.equal(requests, before);
  await worker.stop(); await advance(t, [worker], 90);
  assert.equal(requests, before); assert.equal(worker.snapshot().running, false);
});

test('authentication failures still stop the provider instead of entering throttling recovery', async t => {
  fakeClock(t);
  const worker = idleWorker(t, async (_snapshot, input) => {
    if (input.path.endsWith('/provider/claim')) throw Object.assign(Error('SESSION_REVOKED'), { code: 'SESSION_REVOKED' });
    return idleReply(input);
  });
  await worker.start({ manual: true });
  await assert.rejects(worker.runOnce(), { code: 'SESSION_REVOKED' });
  assert.equal(worker.snapshot().running, false);
});
