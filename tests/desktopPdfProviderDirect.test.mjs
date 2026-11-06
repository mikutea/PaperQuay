import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createDesktopPdfProvider } = require('../electron/backend/desktopPdfProvider.cjs');
const PDF = Buffer.from('%PDF-1.7\nsynthetic direct source\n%%EOF\n');
const sha256 = createHash('sha256').update(PDF).digest('hex');
const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'), 'a=ice-ufrag:abcd', 'a=ice-pwd:' + 'a'.repeat(22), ''].join('\r\n');
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const error = (code) => Object.assign(new Error(code), { code });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) { if (Date.now() > deadline) assert.fail('Direct provider condition timed out'); await delay(2); }
}
function harness(t, options = {}) {
  const now = Date.now(), calls = [], events = [], errors = [], states = [], waits = [], uploads = [], jobs = [];
  const item = { requestId: randomUUID(), attachmentVersionId: randomUUID(), sha256, sizeBytes: PDF.length,
    expiresAt: new Date(now + 30000).toISOString(), direct: { offer: sdp, expiresAt: new Date(now + 5900).toISOString() } };
  const binding = { bindingId: randomUUID(), attachmentVersionId: item.attachmentVersionId, sha256, sizeBytes: PDF.length };
  const f = { item, binding, calls, events, errors, states, waits, uploads, jobs, state: 'direct', relayReady: true,
    polls: 0, reads: 0, validates: 0, tokens: 0, statusCalls: 0, closed: false, answer: null };
  const abortPromise = (signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(error('DESKTOP_OPERATION_CANCELLED'));
    else signal.addEventListener('abort', () => reject(error('DESKTOP_OPERATION_CANCELLED')), { once: true });
  });
  f.peer = { candidateType: 'host', close: async () => { f.closed = true; events.push('peer-closed'); },
    send: async (bytes, settings) => {
      events.push('direct-send'); assert.deepEqual(bytes, PDF);
      if (options.send) return options.send(f, bytes, settings);
      await settings.beforeEnd(jobs[0].signal); f.state = 'complete'; return { received: true };
    } };
  f.host = { authorize: (requestId, until) => { assert.equal(requestId, item.requestId); events.push('renewed'); assert.ok(until > Date.now()); },
    close: async () => { f.closed = true; events.push('host-closed'); },
    open: async (job) => {
      jobs.push(job); events.push('peer-open');
      if (options.open) return options.open(f, job, abortPromise);
      await job.onAnswer(sdp, job.signal); return f.peer;
    } };
  f.provider = createDesktopPdfProvider({
    request: async (route, requestOptions) => {
      calls.push({ route, ...requestOptions });
      if (route.endsWith('/provider/poll')) {
        f.polls++; if (f.polls === 1) return { request: item }; return abortPromise(requestOptions.signal);
      }
      if (route.endsWith('/unavailable')) { events.push('unavailable'); return { acknowledged: true }; }
      assert.ok(route.includes(item.requestId));
      if (route.endsWith('/direct')) {
        f.statusCalls++; if (options.status) await options.status(f, requestOptions);
        return { state: f.state, answer: f.answer, expiresAt: item.expiresAt, directExpiresAt: item.direct.expiresAt,
          authorizedUntil: f.state === 'direct' ? new Date(Math.min(Date.now() + 1900, Date.parse(item.direct.expiresAt))).toISOString() : null,
          relayReady: f.state === 'relay' && f.relayReady };
      }
      if (route.endsWith('/answer')) { f.answer = requestOptions.body.sdp; events.push('answer'); return { accepted: true }; }
      if (route.endsWith('/authorize')) {
        events.push('final-authorized'); if (options.authorize) return options.authorize(f, requestOptions);
        return { authorizedUntil: new Date(Date.now() + 1900).toISOString() };
      }
      if (route.endsWith('/fallback')) {
        assert.equal(f.closed, true, 'Peer must be closed before requesting HTTP fallback'); events.push('fallback');
        if (options.fallback) return options.fallback(f, requestOptions);
        f.state = 'relay'; return { state: 'relay' };
      }
      assert.fail(`Unexpected direct fixture route ${route}`);
    },
    getBinding: () => binding,
    read: async (_binding, signal) => {
      f.reads++; events.push('read');
      if (options.read) return options.read(f, signal);
      return { bytes: PDF, sha256, sizeBytes: PDF.length };
    },
    validateTarget: async (_binding, signal) => { f.validates++; if (options.validate) await options.validate(f, signal); },
    ensureTokenLifetime: async () => { f.tokens++; },
    sendContent: async (route, bytes) => { assert.ok(route.includes(item.requestId)); uploads.push(bytes); events.push('relay-send'); },
    getDirectCapability: () => ({ transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls: [] }),
    getPeerHost: () => f.host,
    onError: (cause) => errors.push(cause.code), onChange: () => states.push(f.provider.snapshot()),
    retryDelay: (signal, ms) => new Promise((resolve) => {
      const wait = { ms, signal, resolve: () => { signal.removeEventListener('abort', wait.resolve); resolve(); } }; waits.push(wait);
      if (signal.aborted) wait.resolve(); else signal.addEventListener('abort', wait.resolve, { once: true });
    }),
  });
  t.after(async () => { f.provider.stop(); for (const wait of waits) wait.resolve(); await f.provider.settled(); });
  f.tick = async (ms) => { await until(() => waits.some((wait) => wait.ms === ms && !wait.signal.aborted));
    const index = waits.findIndex((wait) => wait.ms === ms && !wait.signal.aborted); waits.splice(index, 1)[0].resolve(); };
  return f;
}

test('direct bytes require initial and final permission and finish without an HTTP content request', async (t) => {
  const f = harness(t); f.provider.start(); await until(() => f.polls === 2);
  assert.deepEqual(f.calls[0].body, { direct: true }); assert.equal(f.jobs.length, 1); assert.equal(f.reads, 1);
  assert.equal(f.tokens, 2); assert.equal(f.validates, 2); assert.ok(f.events.indexOf('final-authorized') > f.events.indexOf('direct-send'));
  assert.equal(f.uploads.length, 0); assert.equal(f.events.includes('fallback'), false); assert.equal(f.errors.length, 0);
  assert.ok(f.states.some((snapshot) => snapshot[0]?.status === 'connecting' && snapshot[0].transport === 'webrtc-data-v1'));
  assert.ok(f.states.some((snapshot) => snapshot[0]?.status === 'sending' && snapshot[0].candidateType === 'host'));
  assert.equal(f.closed, true);
});

test('ICE failure closes the peer and waits for the same lease consumer before one relay upload', async (t) => {
  const f = harness(t, { open: async () => { throw error('DESKTOP_PEER_FAILED'); } }); f.relayReady = false;
  f.provider.start(); await until(() => f.events.includes('fallback'));
  assert.equal(f.uploads.length, 0); assert.equal(f.reads, 1); assert.equal(f.closed, true);
  f.relayReady = true; await f.tick(250); await until(() => f.polls === 2);
  assert.equal(f.reads, 1); assert.equal(f.uploads.length, 1); assert.deepEqual(f.uploads[0], PDF);
  assert.ok(f.events.indexOf('host-closed') < f.events.indexOf('fallback'));
  assert.ok(f.events.indexOf('fallback') < f.events.indexOf('relay-send')); assert.equal(f.errors.length, 0);
  assert.ok(f.states.some((snapshot) => snapshot[0]?.transport === 'http-relay-v1'));
});

test('a completion that wins a fallback race does not duplicate the upload', async (t) => {
  const f = harness(t, { open: async () => { throw error('DESKTOP_PEER_FAILED'); },
    fallback: async (state) => { state.state = 'complete'; throw error('DESKTOP_PDF_REQUEST_IN_USE'); } });
  f.provider.start(); await until(() => f.polls === 2);
  assert.equal(f.events.filter((event) => event === 'fallback').length, 1); assert.equal(f.uploads.length, 0); assert.equal(f.errors.length, 0);
});

test('a native source failure closes the opening peer and cannot fall back to a changed file', async (t) => {
  const f = harness(t, { open: (_state, job, aborted) => aborted(job.signal), read: async () => { throw error('DESKTOP_SOURCE_CHANGED'); } });
  f.provider.start(); await until(() => f.polls === 2);
  assert.equal(f.closed, true); assert.deepEqual(f.errors, ['DESKTOP_SOURCE_CHANGED']);
  assert.equal(f.events.includes('fallback'), false); assert.equal(f.uploads.length, 0); assert.equal(f.reads, 1);
});

test('target change at final permission prevents the final block and does not trigger fallback', async (t) => {
  const f = harness(t, { validate: async (state) => { if (state.validates === 2) throw error('ATTACHMENT_VERSION_UNAVAILABLE'); } });
  f.provider.start(); await until(() => f.polls === 2);
  assert.deepEqual(f.errors, ['ATTACHMENT_VERSION_UNAVAILABLE']); assert.equal(f.events.includes('final-authorized'), false);
  assert.equal(f.events.includes('fallback'), false); assert.equal(f.uploads.length, 0); assert.equal(f.closed, true);
});

test('fresh control revocation aborts native I/O and never attempts relay', async (t) => {
  let sourceAborted = false;
  const f = harness(t, {
    open: (_state, job, aborted) => aborted(job.signal),
    read: async (_state, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      sourceAborted = true; reject(error('DESKTOP_OPERATION_CANCELLED'));
    }, { once: true })),
    status: async (state) => { if (state.statusCalls > 1) throw error('AUTHENTICATION_REQUIRED'); },
  });
  f.provider.start(); await until(() => f.reads === 1); await f.tick(1000); await until(() => f.polls === 2);
  assert.equal(sourceAborted, true); assert.equal(f.closed, true); assert.deepEqual(f.errors, ['AUTHENTICATION_REQUIRED']);
  assert.equal(f.events.includes('fallback'), false); assert.equal(f.uploads.length, 0);
});

test('direct cancellation retains the native read slot until its descriptor operation finishes', async (t) => {
  const release = deferred();
  const f = harness(t, { open: (_state, job, aborted) => aborted(job.signal),
    read: async () => { await release.promise; return { bytes: PDF, sha256, sizeBytes: PDF.length }; } });
  t.after(() => release.resolve());
  f.provider.start(); await until(() => f.reads === 1); f.provider.stop(); f.provider.start();
  await delay(10); assert.equal(f.polls, 1); assert.equal(f.provider.snapshot().length, 1);
  release.resolve(); await until(() => f.polls === 2);
  assert.equal(f.uploads.length, 0); assert.equal(f.events.includes('fallback'), false); assert.equal(f.closed, true);
});

test('server-initiated relay mode skips the helper and keeps the original descriptor validation', async (t) => {
  const f = harness(t); f.state = 'relay'; f.provider.start(); await until(() => f.polls === 2);
  assert.equal(f.jobs.length, 0); assert.equal(f.reads, 1); assert.equal(f.uploads.length, 1);
  assert.equal(f.events.includes('fallback'), false); assert.deepEqual(f.uploads[0], PDF);
});

test('a slow control renewal and final authorization share one provider lease request slot', async (t) => {
  const monitorEntered = deferred(), releaseMonitor = deferred(), sending = deferred(), releaseFinal = deferred(), finalStarted = deferred();
  t.after(() => { releaseMonitor.resolve(); releaseFinal.resolve(); });
  let monitorBusy = false, finalChecks = 0;
  const f = harness(t, {
    status: async (state) => {
      if (state.statusCalls === 2) { monitorBusy = true; monitorEntered.resolve(); await releaseMonitor.promise; monitorBusy = false; }
    },
    send: async (state, _bytes, settings) => {
      sending.resolve(); await releaseFinal.promise; finalStarted.resolve();
      await settings.beforeEnd(state.jobs[0].signal); state.state = 'complete'; return { received: true };
    },
    authorize: async () => {
      assert.equal(monitorBusy, false, 'Fresh authorization cannot overlap a still-pending GET'); finalChecks++;
      return { authorizedUntil: new Date(Date.now() + 1900).toISOString() };
    },
  });
  f.provider.start(); await sending.promise; await f.tick(1000); await monitorEntered.promise;
  releaseFinal.resolve(); await finalStarted.promise; await delay(10);
  assert.equal(finalChecks, 0); assert.equal(f.events.includes('final-authorized'), false);
  releaseMonitor.resolve(); await until(() => f.polls === 2);
  assert.equal(finalChecks, 1); assert.equal(f.errors.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.events.includes('fallback'), false);
});

test('an ICE answer waits behind a slow renewal instead of racing the server control lock', async (t) => {
  const monitorEntered = deferred(), releaseMonitor = deferred(), opening = deferred(), releaseAnswer = deferred(), answerStarted = deferred();
  t.after(() => { releaseMonitor.resolve(); releaseAnswer.resolve(); });
  const f = harness(t, {
    status: async (state) => { if (state.statusCalls === 2) { monitorEntered.resolve(); await releaseMonitor.promise; } },
    open: async (state, job) => {
      opening.resolve(); await releaseAnswer.promise; answerStarted.resolve();
      await job.onAnswer(sdp, job.signal); return state.peer;
    },
  });
  f.provider.start(); await opening.promise; await f.tick(1000); await monitorEntered.promise;
  releaseAnswer.resolve(); await answerStarted.promise; await delay(10); assert.equal(f.events.includes('answer'), false);
  releaseMonitor.resolve(); await until(() => f.polls === 2);
  assert.equal(f.events.filter((event) => event === 'answer').length, 1); assert.equal(f.errors.length, 0);
  assert.equal(f.events.includes('fallback'), false); assert.equal(f.uploads.length, 0);
});
