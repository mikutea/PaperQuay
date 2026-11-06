import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as modelCore from '../packages/sync-core/src/modelInference.ts';

const require = createRequire(import.meta.url);
const { createRemoteTaskWorker } = require('../electron/backend/remoteTaskWorker.cjs');
const { createComputerModelWorker } = require('../electron/backend/computerModelWorker.cjs');
const rateLimited = () => Object.assign(Error('RATE_LIMITED'), { code: 'RATE_LIMITED', statusCode: 429 });
const reply = input => input.path.endsWith('/provider/claim') ? { claim: null } : { provider: {} };
function clock(t) { t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1_800_000_000_000 }); }
async function advance(t, seconds, extra = () => {}) {
  for (let second = 1; second <= seconds; second++) {
    t.mock.timers.tick(1000); extra(second);
    await new Promise(resolve => setImmediate(resolve));
  }
}
function idle(t, api, { accountId = randomUUID(), check = async () => {}, kind = 'parse', timings } = {}) {
  const snapshot = { scope: { service: 'https://sync.fixture.test', accountId, deviceId: randomUUID(), libraryId: randomUUID() },
    generation: { account: 1, library: 1, profiles: 1, credentials: 1 },
    profiles: [{ id: kind + '-default', revision: 1, digest: 'a'.repeat(64), kind, model: 'synthetic' }] };
  const worker = createRemoteTaskWorker({ core: {}, capture: async () => structuredClone(snapshot), check, api, timings,
    adapters: { [kind]: { execute: async () => assert.fail('Idle polling must not invoke an upstream service') } },
    readPdf: async () => assert.fail('Idle polling must not read a PDF'),
    journal: { read: async () => assert.fail('No idle task journal read'), write: async () => assert.fail('No idle journal write') },
  });
  t.after(() => worker.stop()); return worker;
}

test('four idle parse/index providers stay enabled within the shared account budget', async t => {
  clock(t); const accountId = randomUUID(), accepted = []; let throttles = 0;
  const workers = Array.from({ length: 4 }, (_, i) => idle(t, async (snapshot, input) => {
    assert.equal(snapshot.scope.accountId, accountId);
    if (accepted.filter(at => at > Date.now() - 60000).length >= 120) { throttles++; throw rateLimited(); }
    accepted.push(Date.now()); return reply(input);
  }, { accountId, kind: i % 2 ? 'index' : 'parse' }));
  await Promise.all(workers.map(worker => worker.start())); await advance(t, 180);
  assert.equal(throttles, 0); assert(workers.every(worker => worker.snapshot().running));
});

test('all eight idle provider workers plus reading sync leave room in the default account budget', async t => {
  clock(t); const accountId = randomUUID(), accepted = []; let maximum = 0, throttles = 0;
  const request = () => {
    const count = accepted.filter(at => at > Date.now() - 60000).length;
    if (count >= 120) { throttles++; throw rateLimited(); }
    accepted.push(Date.now()); maximum = Math.max(maximum, count + 1);
  };
  const api = async (snapshot, input) => { assert.equal(snapshot.scope.accountId, accountId); request(); return reply(input); };
  const workers = Array.from({ length: 4 }, () => idle(t, api, { accountId }));
  for (let index = 0; index < 4; index++) {
    const value = { scope: { service: 'https://sync.fixture.test', accountId, deviceId: randomUUID(), libraryId: randomUUID() }, generation: 'b'.repeat(64),
      profiles: [{ id: 'chat-default', revision: 1, digest: 'a'.repeat(64), kind: 'chat', model: 'synthetic', maxInputBytes: 65536, maxOutputTokens: 2048, stream: false }] };
    const worker = createComputerModelWorker({ core: modelCore, capture: async () => structuredClone(value), check: async () => {}, api,
      journal: { list: async () => [], capacity: async () => ({ retained: 0, maxRetained: 16 }), put: async () => assert.fail('No idle intent') },
      getPrivate: async () => assert.fail('No idle model call') });
    workers.push(worker); t.after(() => worker.stop());
  }
  await Promise.all(workers.map(worker => worker.start()));
  await advance(t, 180, second => { if (second % 15 === 0) for (let i = 0; i < 4; i++) request(); });
  assert.equal(throttles, 0); assert(maximum <= 104, 'leave at least 16 requests for other account operations');
  assert(workers.every(worker => worker.snapshot().running));
});

test('claim throttling preserves enablement and renews presence before another claim', async t => {
  clock(t); const calls = []; let claims = 0;
  const worker = idle(t, async (_snapshot, input) => { calls.push(input.path);
    if (input.path.endsWith('/claim') && ++claims === 1) throw rateLimited(); return reply(input); });
  await worker.start({ manual: true }); assert.deepEqual(await worker.runOnce(), { worked: false });
  assert.equal(worker.snapshot().running, true); assert.equal(worker.snapshot().errorCode, 'RATE_LIMITED');
  const before = calls.length; await advance(t, 59); await worker.runOnce(); assert.equal(calls.length, before);
  await advance(t, 1); await worker.runOnce();
  assert.deepEqual(calls.slice(before), ['/v1/remote-tasks/provider', '/v1/remote-tasks/provider/claim']);
  assert.equal(worker.snapshot().errorCode, null);
});

test('initial presence throttling and repeated limits use bounded increasing quiet periods', async t => {
  clock(t); let requests = 0, presence = 0, claims = 0;
  const worker = idle(t, async (_snapshot, input) => { requests++;
    if (input.path.endsWith('/provider') && ++presence <= 2) throw rateLimited();
    if (input.path.endsWith('/claim')) claims++; return reply(input); });
  await worker.start({ manual: true }); assert.equal(worker.snapshot().running, true);
  await advance(t, 59); assert.equal(requests, 1);
  await advance(t, 1); await worker.runOnce(); assert.equal(presence, 2);
  await advance(t, 119); assert.equal(requests, 2);
  await advance(t, 1); await worker.runOnce(); assert.equal(presence, 3); assert.equal(claims, 1);
  assert.equal(worker.snapshot().errorCode, null);
});

test('periodic presence throttling pauses every network loop while the binding guard remains active', async t => {
  clock(t); let presence = 0, requests = 0, checks = 0;
  const worker = idle(t, async (_snapshot, input) => { requests++;
    if (input.path.endsWith('/provider') && ++presence === 2) throw rateLimited(); return reply(input);
  }, { check: async () => { checks++; } });
  await worker.start(); await advance(t, 15);
  assert.equal(worker.snapshot().running, true); assert.equal(worker.snapshot().errorCode, 'RATE_LIMITED');
  const before = requests, guardBefore = checks;
  await advance(t, 59); assert.equal(requests, before); assert(checks > guardBefore);
  await advance(t, 1); await worker.runOnce();
  assert.equal(presence, 3); assert.equal(worker.snapshot().errorCode, null);
});

test('a retired binding stops during cooldown without contacting a replacement account', async t => {
  clock(t); let retired = false, requests = 0;
  const worker = idle(t, async () => { requests++; throw rateLimited(); }, {
    check: async () => { if (retired) throw Object.assign(Error('REMOTE_BINDING_CHANGED'), { code: 'REMOTE_BINDING_CHANGED' }); },
  });
  await worker.start({ manual: true }); retired = true; await advance(t, 1);
  assert.equal(worker.snapshot().running, false); await advance(t, 180); assert.equal(requests, 1);
});

test('an explicit stop during cooldown cannot later renew or claim', async t => {
  clock(t); let requests = 0;
  const worker = idle(t, async (_snapshot, input) => { requests++; if (input.method !== 'DELETE') throw rateLimited(); return {}; });
  await worker.start({ manual: true }); await worker.stop(); const before = requests;
  await advance(t, 180); assert.equal(requests, before); assert.equal(worker.snapshot().running, false);
});

test('revoked authentication still stops a remote task provider immediately', async t => {
  clock(t); const worker = idle(t, async (_snapshot, input) => {
    if (input.path.endsWith('/claim')) throw Object.assign(Error('SESSION_REVOKED'), { code: 'SESSION_REVOKED' }); return reply(input);
  });
  await worker.start({ manual: true }); await assert.rejects(worker.runOnce(), { code: 'SESSION_REVOKED' });
  assert.equal(worker.snapshot().running, false);
});
