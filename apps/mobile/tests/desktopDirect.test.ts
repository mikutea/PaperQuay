import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '../src/pdf/acquisition.ts';
import { ClientError } from '../src/errors.ts';
import { DesktopPdfError, downloadDesktopPdfCopy, type DesktopPdfCapability,
  type DesktopPdfContext, type DesktopPdfOptions } from '../src/pdf/desktopCopies.ts';
import { createDesktopDirectPeer, DesktopDirectError, isDesktopDirectCapability, validDesktopSdp,
  validDesktopStunUrl, type DesktopDirectCapability } from '../src/pdf/desktopDirectPeer.ts';
import { PdfError } from '../src/pdf/errors.ts';
import { PDF_LIMITS, type PdfVersion } from '../src/pdf/types.ts';
import { FakeDesktopPeer, TEST_SDP, deferred, fakeDesktopFactory, flush } from './helpers/desktopRtc.ts';

const API = 'https://sync.example.test';
const VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic direct file fixture\n%%EOF\n');
const version: PdfVersion = { entityId: VERSION, data: { paperId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  attachmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sha256: await sha256(bytes), sizeBytes: bytes.length,
  mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 1 } };
const direct: DesktopDirectCapability = { transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls: [] };
const capability: DesktopPdfCapability = { transport: 'http-relay-v1', maxFileBytes: PDF_LIMITS.maxFileBytes,
  requestTtlMs: 30000, pollTimeoutMs: 20000, direct };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const errorResponse = (status: number, code: string) => json({ error: { code, message: 'private transport diagnostics' } }, status);
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof DesktopPdfError || error instanceof ClientError || error instanceof PdfError);
  assert.equal(error.code, expected); assert.ok(!error.message.includes('private')); return true;
};

function transfer() {
  const peer = new FakeDesktopPeer(); const configurations: RTCConfiguration[] = [];
  const abort = new AbortController(); const states: string[] = []; const requests: { path: string; init: RequestInit }[] = [];
  let current = true; let limits: DesktopPdfCapability | null = capability;
  let expiresAt = '', directExpiresAt = '';
  const context: DesktopPdfContext = { apiBaseUrl: API, getAccessToken: async () => 'synthetic-token', getDesktopPdfCapability: () => limits };
  const hooks: {
    poll?: () => Response | Promise<Response>;
    complete?: () => Response | Promise<Response>;
    fallback?: () => Response | Promise<Response>;
    content?: () => Response | Promise<Response>;
  } = {};
  const status = (patch: Record<string, unknown> = {}) => ({ state: 'direct', answer: TEST_SDP, expiresAt, directExpiresAt,
    authorizedUntil: new Date(Math.min(Date.now() + 1900, Date.parse(directExpiresAt))).toISOString(), relayReady: false, ...patch });
  const options: DesktopPdfOptions = { signal: abort.signal, isCurrent: () => current,
    createPeerConnection: fakeDesktopFactory(peer, configurations), onTransferState: (state) => states.push(state),
    fetch: async (url, init) => {
      const path = String(url).slice(API.length); requests.push({ path, init: init! });
      if (init?.method === 'DELETE') return json({ cancelled: true });
      if (path === '/v1/desktop-pdfs/requests') {
        expiresAt = new Date(Date.now() + 30000).toISOString(); directExpiresAt = new Date(Date.now() + 6000).toISOString();
        return json({ requestId: REQUEST, attachmentVersionId: VERSION, expiresAt }, 201);
      }
      if (path.endsWith('/direct/complete')) return hooks.complete?.() ?? json({ received: true });
      if (path.endsWith('/direct/fallback')) return hooks.fallback?.() ?? json({ state: 'relay' });
      if (path.endsWith('/direct')) return hooks.poll?.() ?? json(status());
      if (path.endsWith('/content')) return hooks.content?.() ?? new Response(bytes as BodyInit, { headers: {
        'content-type': 'application/pdf', 'content-length': String(bytes.length), 'accept-ranges': 'none',
      } });
      throw new Error('unexpected synthetic route');
    } };
  peer.onAnswer = () => peer.deliver(version, REQUEST, bytes);
  return { peer, abort, states, requests, configurations, hooks, options, context, status,
    setCurrent: (value: boolean) => { current = value; }, setCapability: (value: DesktopPdfCapability | null) => { limits = value; },
    run: () => downloadDesktopPdfCopy(context, version, options) };
}

test('direct capability and SDP reject unbounded, media, relay and injected ICE configuration', () => {
  for (const value of ['stun:stun.example.test', 'stuns:stun.example.test:5349', 'stun:[::1]:3478']) assert.equal(validDesktopStunUrl(value), true);
  for (const value of ['turn:relay.test', 'stun:user@host.test', 'stun:host.test?transport=udp', 'stun:host.test/path',
    'stun:host.test#secret', 'stun:host.test:65536', 'stun:host.test:0', ' stun:host.test', 'stun:bad..test', 'https://host.test'])
    assert.equal(validDesktopStunUrl(value), false, value);
  assert.equal(isDesktopDirectCapability(direct), true);
  for (const value of [{ ...direct, attemptMs: 6001 }, { ...direct, maxSdpBytes: 65536 }, { ...direct, stunUrls: ['turn:relay.test'] },
    { ...direct, stunUrls: ['stun:a.test', 'stun:b.test', 'stun:c.test'] }]) assert.equal(isDesktopDirectCapability(value), false);
  assert.equal(validDesktopSdp(TEST_SDP), true);
  for (const value of ['', `${TEST_SDP}m=audio 9 RTP/AVP 0\r\n`, TEST_SDP.replace('m=application', 'm=video'),
    `${TEST_SDP}a=candidate:1 1 udp 1 synthetic.invalid 9 typ relay\r\n`, `${TEST_SDP}${'a=candidate:x\r\n'.repeat(33)}`,
    `${TEST_SDP}a=private:中文\r\n`, `${TEST_SDP}${'x'.repeat(32768)}`]) assert.equal(validDesktopSdp(value), false);
});

test('direct transfer accepts exact bytes only after the server receipt and sends no HTTP PDF body', async () => {
  const task = transfer(); const receipt = deferred<Response>(); const completing = deferred<void>();
  task.hooks.complete = () => { completing.resolve(); return receipt.promise; };
  let settled = false; const pending = task.run().finally(() => { settled = true; });
  await completing.promise; await flush();
  assert.equal(settled, false); assert.deepEqual(task.peer.channel.sent, []);
  receipt.resolve(json({ received: true })); assert.deepEqual(await pending, bytes);
  assert.deepEqual(task.states, ['direct-connecting', 'direct-received']);
  assert.deepEqual(task.requests.map(({ path }) => path), ['/v1/desktop-pdfs/requests',
    `/v1/desktop-pdfs/requests/${REQUEST}/direct`, `/v1/desktop-pdfs/requests/${REQUEST}/direct/complete`]);
  assert.deepEqual(JSON.parse(String(task.requests[0].init.body)), { attachmentVersionId: VERSION, direct: { offer: TEST_SDP } });
  assert.deepEqual(JSON.parse(task.peer.channel.sent[0]), { type: 'ack', requestId: REQUEST, sha256: version.data.sha256, sizeBytes: bytes.length });
  assert.deepEqual(task.peer.created, [{ label: 'paperquay-pdf-v1', options: { ordered: true, protocol: 'paperquay-pdf-v1' } }]);
  assert.equal(task.peer.channel.binaryType, 'arraybuffer'); assert.equal(task.peer.closed, 1); assert.equal(task.peer.channel.closed, 1);
  assert.deepEqual(task.configurations, [{ iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' }]);
  for (const request of task.requests) {
    assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.redirect, 'error');
    assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer synthetic-token');
  }
});

test('provider closure before the confirmed complete response and ACK failure cannot downgrade success', async () => {
  for (const when of ['before-receipt', 'ack-send', 'ack-drain'] as const) {
    const task = transfer();
    task.hooks.complete = () => { if (when === 'before-receipt') task.peer.channel.close(); return json({ received: true }); };
    task.peer.channel.onSend = () => {
      if (when === 'ack-drain') task.peer.channel.bufferedAmount = 1;
      if (when !== 'before-receipt') task.peer.channel.close();
    };
    assert.deepEqual(await task.run(), bytes);
    assert.deepEqual(task.states, ['direct-connecting', 'direct-received']);
    assert.equal(task.requests.some(({ path }) => path.endsWith('/fallback') || path.endsWith('/content')), false);
  }
});

test('unconfirmed complete, final-check conflict and cancellation never adopt bytes or send ACK', async () => {
  for (const kind of ['conflict', 'false-receipt', 'cancel', 'account'] as const) {
    const task = transfer();
    task.hooks.complete = () => {
      task.peer.channel.close();
      if (kind === 'cancel') task.abort.abort();
      if (kind === 'account') task.setCurrent(false);
      return kind === 'false-receipt' ? json({ received: false })
        : kind === 'conflict' ? errorResponse(409, 'DESKTOP_PDF_REQUEST_IN_USE') : json({ received: true });
    };
    if (kind === 'false-receipt') {
      task.hooks.fallback = () => errorResponse(409, 'DESKTOP_PDF_REQUEST_IN_USE');
      await assert.rejects(task.run(), code('REQUEST_IN_USE'));
    } else await assert.rejects(task.run(), code(kind === 'conflict' ? 'REQUEST_IN_USE' : kind === 'cancel' ? 'CANCELLED' : 'ACCOUNT_CHANGED'));
    assert.deepEqual(task.peer.channel.sent, []);
    assert.equal(task.states.includes('direct-received'), false);
    assert.equal(task.requests.some(({ path }) => path.endsWith('/content')), false);
  }
});

test('an observed complete state without our own receipt is terminal', async () => {
  const task = transfer(); task.hooks.poll = () => json(task.status({ state: 'complete', answer: null, authorizedUntil: null }));
  await assert.rejects(task.run(), code('REQUEST_IN_USE'));
  assert.equal(task.requests.some(({ path }) => path.endsWith('/fallback') || path.endsWith('/content')), false);
  assert.deepEqual(task.peer.channel.sent, []);
});

test('ICE failure, old provider relay and direct conflict fall back within the same lease exactly once', async () => {
  for (const kind of ['ice', 'old-provider', 'conflict'] as const) {
    const task = transfer();
    if (kind === 'ice') task.peer.onAnswer = () => { task.peer.fail(); };
    if (kind === 'old-provider') task.hooks.poll = () => json(task.status({ state: 'relay', answer: null, authorizedUntil: null }));
    if (kind === 'conflict') task.hooks.poll = () => errorResponse(409, 'DESKTOP_PDF_DIRECT_FALLBACK');
    assert.deepEqual(await task.run(), bytes);
    assert.deepEqual(task.states, ['direct-connecting', 'relay-fallback', 'relay-received']);
    assert.equal(task.requests.filter(({ path }) => path === '/v1/desktop-pdfs/requests').length, 1);
    assert.equal(task.requests.filter(({ path }) => path.endsWith(`/${REQUEST}/direct/fallback`)).length, 1);
    assert.equal(task.requests.filter(({ path }) => path.endsWith(`/${REQUEST}/content`)).length, 1);
    assert.equal(task.peer.closed, 1); assert.deepEqual(task.peer.channel.sent, []);
  }
});

test('unsafe metadata, ordering, oversized frames, wrong digest and partial streams discard direct bytes before relay', async () => {
  const metadata = { type: 'metadata', requestId: REQUEST, attachmentVersionId: VERSION, sha256: version.data.sha256, sizeBytes: bytes.length };
  for (const kind of ['wrong-id', 'extra-field', 'binary-first', 'duplicate-metadata', 'oversize-json', 'oversize-binary', 'blob',
    'empty-binary', 'overflow', 'early-eof', 'bad-hash', 'after-eof', 'extra-channel'] as const) {
    const task = transfer();
    task.peer.onAnswer = () => {
      const send = (value: unknown) => task.peer.channel.receive(typeof value === 'object' && !(value instanceof ArrayBuffer)
        && !(value instanceof Blob) ? JSON.stringify(value) : value);
      if (kind === 'wrong-id') { send({ ...metadata, requestId: VERSION }); return; }
      if (kind === 'extra-field') { send({ ...metadata, path: 'private' }); return; }
      if (kind === 'binary-first') { send(bytes.slice().buffer); return; }
      if (kind === 'oversize-json') { send(JSON.stringify({ ...metadata, pad: '中'.repeat(350) })); return; }
      if (kind === 'extra-channel') { assert.equal(task.peer.extraChannel().closed, 1); return; }
      if (kind === 'bad-hash') { const bad = bytes.slice(); bad[20] ^= 1; task.peer.deliver(version, REQUEST, bad); return; }
      if (kind === 'after-eof') { task.peer.deliver(version, REQUEST, bytes); send(bytes.slice().buffer); return; }
      send(metadata);
      if (kind === 'duplicate-metadata') send(metadata);
      if (kind === 'oversize-binary') send(new ArrayBuffer(16385));
      if (kind === 'blob') send(new Blob([bytes as BlobPart]));
      if (kind === 'empty-binary') send(new ArrayBuffer(0));
      if (kind === 'overflow') send(new ArrayBuffer(bytes.length + 1));
      if (kind === 'early-eof') send({ type: 'eof', requestId: REQUEST, sha256: version.data.sha256, sizeBytes: bytes.length });
    };
    assert.deepEqual(await task.run(), bytes, kind);
    assert.deepEqual(task.states, ['direct-connecting', 'relay-fallback', 'relay-received'], kind);
    assert.equal(task.requests.some(({ path }) => path.endsWith('/complete')), false, kind);
    assert.deepEqual(task.peer.channel.sent, [], kind);
  }
});

test('direct SDP larger than old JSON limit remains bounded and is accepted once', async () => {
  const task = transfer(); const answer = TEST_SDP + 'a=synthetic:' + 'x'.repeat(19000) + '\r\n';
  task.hooks.poll = () => json(task.status({ answer }));
  assert.deepEqual(await task.run(), bytes); assert.equal(task.peer.remote.length, 1); assert.equal(task.peer.remote[0].sdp, answer);
});

test('unsafe signaling, changed lease and excessive permission fall back without setting an answer', async () => {
  for (const patch of [{ answer: `${TEST_SDP}m=audio 9 RTP/AVP 0\r\n` }, { expiresAt: new Date(0).toISOString() },
    { directExpiresAt: 'yesterday' }, { authorizedUntil: new Date(Date.now() + 60000).toISOString() }, { relayReady: 'yes' }]) {
    const task = transfer(); task.hooks.poll = () => json(task.status(patch));
    assert.deepEqual(await task.run(), bytes); assert.equal(task.peer.remote.length, 0);
    assert.deepEqual(task.states, ['direct-connecting', 'relay-fallback', 'relay-received']);
  }
});

test('auth, revocation, target deletion and unknown conflicts stay terminal during direct polling', async () => {
  for (const [status, serverCode, expected] of [[401, 'AUTH_REQUIRED', 'AUTH_REQUIRED'], [403, 'SESSION_REVOKED', 'SESSION_REVOKED'],
    [404, 'NOT_FOUND', 'VERSION_UNAVAILABLE'], [410, 'ATTACHMENT_VERSION_UNAVAILABLE', 'VERSION_UNAVAILABLE'],
    [409, 'DESKTOP_PDF_CHANGED', 'CHANGED'], [409, 'DESKTOP_PDF_REQUEST_IN_USE', 'REQUEST_IN_USE']] as const) {
    const task = transfer(); task.hooks.poll = () => errorResponse(status, serverCode);
    await assert.rejects(task.run(), code(expected));
    assert.equal(task.requests.some(({ path }) => path.endsWith('/fallback') || path.endsWith('/content')), false);
    assert.equal(task.peer.closed, 1);
  }
});

test('stalled direct auth or target error bodies cannot become a timeout or a relay retry', async () => {
  for (const [status, expected] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [410, 'VERSION_UNAVAILABLE'], [409, 'CHANGED']] as const) {
    const task = transfer(); let cancelled = false; task.options.timeoutMs = 25;
    task.hooks.poll = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status, headers: { 'content-type': 'application/json' },
    });
    await assert.rejects(task.run(), code(expected)); assert.equal(cancelled, true);
    assert.equal(task.requests.some(({ path }) => path.endsWith('/fallback') || path.endsWith('/content')), false);
  }
});

test('cancellation, account switch and capability change during direct polling close resources and ignore a late body', async () => {
  for (const kind of ['cancel', 'account', 'capability'] as const) {
    const task = transfer(); const reply = deferred<Response>(); const began = deferred<void>();
    task.hooks.poll = () => { began.resolve(); return reply.promise; };
    const pending = task.run(); await began.promise;
    if (kind === 'cancel') task.abort.abort();
    if (kind === 'account') task.setCurrent(false);
    if (kind === 'capability') task.setCapability({ ...capability, direct: { ...direct, stunUrls: ['stun:changed.test'] } });
    reply.resolve(json(task.status()));
    await assert.rejects(pending, code(kind === 'cancel' ? 'CANCELLED' : kind === 'account' ? 'ACCOUNT_CHANGED' : 'CAPABILITY_CHANGED'));
    assert.equal(task.peer.closed, 1); assert.equal(task.peer.remote.length, 0);
    assert.equal(task.requests.some(({ path }) => path.endsWith('/fallback') || path.endsWith('/content')), false);
  }
});

test('a short control permission expires, closes the peer and falls back without resuming late frames', async () => {
  const task = transfer(); task.peer.onAnswer = () => undefined;
  task.hooks.poll = () => json(task.status({ authorizedUntil: new Date(Date.now() + 25).toISOString() }));
  assert.deepEqual(await task.run(), bytes);
  task.peer.deliver(version, REQUEST, bytes); await flush();
  assert.deepEqual(task.states, ['direct-connecting', 'relay-fallback', 'relay-received']); assert.equal(task.peer.closed, 1);
});

test('gathering is bounded before request creation and a late offer cannot reopen direct transport', async (t) => {
  const task = transfer(); const offer = deferred<RTCSessionDescriptionInit>(); task.peer.offer = () => offer.promise;
  const set = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) =>
    set(handler, timeout === 1500 ? 10 : timeout, ...args)) as typeof setTimeout);
  assert.deepEqual(await task.run(), bytes); offer.resolve({ type: 'offer', sdp: TEST_SDP }); await flush();
  assert.deepEqual(JSON.parse(String(task.requests[0].init.body)), { attachmentVersionId: VERSION });
  assert.deepEqual(task.states, ['direct-connecting', 'relay-fallback', 'relay-received']);
  assert.equal(task.requests.length, 2); assert.equal(task.peer.localDescription, null); assert.equal(task.peer.closed, 1);
});

test('old capabilities and unavailable RTC retain the legacy two-request relay path', async () => {
  for (const oldService of [true, false]) {
    const task = transfer();
    if (oldService) { const { direct: _unused, ...legacy } = capability; task.setCapability(legacy); }
    else task.options.createPeerConnection = undefined;
    assert.deepEqual(await task.run(), bytes); assert.equal(task.requests.length, 2);
    assert.deepEqual(JSON.parse(String(task.requests[0].init.body)), { attachmentVersionId: VERSION });
    assert.deepEqual(task.states, ['relay', 'relay-received']); assert.equal(task.peer.created.length, 0);
  }
});

test('new status polls renew authorization while a large direct transfer is pending', async () => {
  const task = transfer(); task.peer.onAnswer = () => undefined; let polls = 0;
  task.hooks.poll = () => {
    polls++;
    if (polls === 2) queueMicrotask(() => task.peer.deliver(version, REQUEST, bytes));
    return json(task.status());
  };
  assert.deepEqual(await task.run(), bytes); assert.equal(polls, 2); assert.equal(task.peer.remote.length, 1);
  assert.deepEqual(task.states, ['direct-connecting', 'direct-received']);
});

test('complete waits for an already active status read instead of competing for its server role slot', async () => {
  const task = transfer(); task.peer.onAnswer = () => undefined;
  const second = deferred<Response>(); const began = deferred<void>(); let polls = 0; let completeCalls = 0;
  task.hooks.poll = () => { if (++polls === 2) { began.resolve(); return second.promise; } return json(task.status()); };
  task.hooks.complete = () => { completeCalls++; return json({ received: true }); };
  const pending = task.run(); await began.promise;
  task.peer.deliver(version, REQUEST, bytes); await flush(); assert.equal(completeCalls, 0);
  second.resolve(json(task.status())); assert.deepEqual(await pending, bytes); assert.equal(completeCalls, 1);
  assert.equal(polls, 2); assert.deepEqual(task.states, ['direct-connecting', 'direct-received']);
});

test('fallback retains the pending status slot until it settles and discards its late answer', async () => {
  const task = transfer(); const reply = deferred<Response>(); const began = deferred<void>(); let fallbacks = 0;
  task.hooks.poll = () => { began.resolve(); return reply.promise; };
  task.hooks.fallback = () => { fallbacks++; return json({ state: 'relay' }); };
  const pending = task.run(); await began.promise; task.peer.fail(); await flush();
  assert.equal(fallbacks, 0); assert.equal(task.peer.closed, 1);
  reply.resolve(json(task.status())); assert.deepEqual(await pending, bytes); assert.equal(fallbacks, 1);
  assert.equal(task.peer.remote.length, 0); assert.deepEqual(task.states, ['direct-connecting', 'relay-fallback', 'relay-received']);
});

test('the fixed six-second direct attempt closes its peer and preserves the remaining relay budget', async (t) => {
  const task = transfer(); task.peer.onAnswer = () => undefined; const delays: number[] = [];
  const set = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    delays.push(timeout!); return set(handler, timeout! >= 5900 && timeout! <= 6000 ? 20 : timeout, ...args);
  }) as typeof setTimeout);
  assert.deepEqual(await task.run(), bytes);
  assert.ok(delays.some((delay) => delay >= 5900 && delay <= 6000)); assert.ok(delays.includes(15000));
  assert.deepEqual(task.states, ['direct-connecting', 'relay-fallback', 'relay-received']);
});

test('a changed answer is never applied and a fallback completion conflict cannot be mistaken for success', async () => {
  const task = transfer(); task.peer.onAnswer = () => undefined; let polls = 0;
  task.hooks.poll = () => json(task.status({ answer: ++polls === 1 ? TEST_SDP : `${TEST_SDP}a=changed:1\r\n` }));
  task.hooks.fallback = () => errorResponse(409, 'DESKTOP_PDF_REQUEST_IN_USE');
  await assert.rejects(task.run(), code('REQUEST_IN_USE')); assert.equal(task.peer.remote.length, 1);
  assert.equal(task.requests.some(({ path }) => path.endsWith('/content') || path.endsWith('/complete')), false);
  assert.deepEqual(task.peer.channel.sent, []);
});

test('direct peer rejects SCTP-overlimit chunks and all frames after its permit is invalid', async () => {
  const fake = new FakeDesktopPeer(); fake.sctp.maxMessageSize = 16;
  const abort = new AbortController(); const peer = createDesktopDirectPeer(direct, version, {
    signal: abort.signal, check: () => undefined, createPeerConnection: fakeDesktopFactory(fake),
  })!;
  await peer.prepareOffer(); peer.bindRequest(REQUEST); peer.authorize(Date.now() + 1000, Date.now() + 6000);
  fake.deliver(version, REQUEST, bytes);
  await assert.rejects(peer.bytes, (error: unknown) => error instanceof DesktopDirectError && error.reason === 'INVALID_FRAME');
  assert.equal(fake.closed, 1); abort.abort(); fake.deliver(version, REQUEST, bytes); assert.deepEqual(fake.channel.sent, []);
});
