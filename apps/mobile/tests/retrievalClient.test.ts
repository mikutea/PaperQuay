import test from 'node:test';
import assert from 'node:assert/strict';
import { RetrievalClient, RetrievalError, type RetrievalContext } from '../src/retrieval/client.ts';
import { retrievalFixture, retrievalCapability, retrievalReceipt, retrievalScope } from './retrievalFixtures.ts';
const token = 'synthetic-retrieval-auth-only';
const context = (): RetrievalContext => ({ apiBaseUrl: retrievalScope.apiBaseUrl, getAccessToken: async () => token, getCapability: retrievalCapability, identityKey: () => 'account-a' });
const code = (expected: string) => (error: unknown) => error instanceof RetrievalError && error.code === expected && !JSON.stringify(error).includes(token);
test('remote retrieval sends the exact preview only to the configured service and verifies its saved receipt', async () => {
  const f = retrievalFixture(), receipt = await retrievalReceipt(f), calls: { url: string; input: RequestInit }[] = [];
  const client = new RetrievalClient(context(), async (url, input) => { calls.push({ url: String(url), input: input! }); return Response.json({ replayed: false, receipt }); });
  assert.deepEqual(await client.execute(f.request), receipt); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, retrievalScope.apiBaseUrl + '/v1/remote-retrieval/requests'); assert.equal(calls[0].input.redirect, 'error');
  assert.equal(calls[0].input.credentials, 'omit'); assert.equal(calls[0].input.cache, 'no-store'); assert.equal(calls[0].input.referrerPolicy, 'no-referrer');
  assert.equal((calls[0].input.headers as Record<string,string>).Authorization, 'Bearer ' + token); assert.deepEqual(JSON.parse(String(calls[0].input.body)), f.request);
  assert.doesNotMatch(String(calls[0].input.body), /synthetic-retrieval-auth-only|endpoint|vector|password/);
});
test('source discovery is one explicit bounded page and never follows a source URL or silently fetches the next page', async () => {
  const f = retrievalFixture(), calls: string[] = [];
  const client = new RetrievalClient(context(), async url => { calls.push(String(url)); return Response.json({ sources: [f.source], nextCursor: f.source.taskId, hasMore: true }); });
  const page = await client.listSources(null); assert.deepEqual(page.sources, [f.source]); assert.equal(calls.length, 1); assert.equal(new URL(calls[0]).searchParams.get('limit'), '8');
  await assert.rejects(client.listSources(f.source.taskId), code('INVALID'));
});
test('identity change before token completion sends nothing, and cancellation cannot adopt a late body', async () => {
  const f = retrievalFixture(); let identity = 'A', release!: (value:string)=>void, calls = 0;
  const ctx = { ...context(), getAccessToken: () => new Promise<string>(done => { release = done; }), identityKey: () => identity };
  const client = new RetrievalClient(ctx, async () => { calls++; return Response.json({}); }); const request = client.execute(f.request);
  await Promise.resolve(); identity = 'B'; release(token); await assert.rejects(request, code('CHANGED')); assert.equal(calls, 0);
  const abort = new AbortController(), receipt = await retrievalReceipt(f); let reply!: (value:Response)=>void;
  const waiting = new RetrievalClient(context(), () => new Promise(done => { reply = done; })).execute(f.request, { signal: abort.signal });
  await new Promise(done => setTimeout(done, 0)); abort.abort(); reply(Response.json({ replayed: false, receipt })); await assert.rejects(waiting, code('CANCELLED'));
});
test('capability budgets and unsupported services stop before authentication or HTTP', async () => {
  const f = retrievalFixture(); let reads = 0, calls = 0;
  const ctx = { ...context(), getAccessToken: async () => { reads++; return token; }, getCapability: () => ({ ...retrievalCapability(), maxTopK: 1 }) };
  await assert.rejects(new RetrievalClient(ctx, async () => { calls++; return Response.json({}); }).execute(f.request), code('LIMIT'));
  await assert.rejects(new RetrievalClient({ ...ctx, getCapability: () => null }).execute(f.request), code('DISABLED')); assert.equal(reads, 0); assert.equal(calls, 0);
});
test('tampered digests, changed requests, wrong status identities, redirects and oversized bodies are not accepted', async () => {
  const f = retrievalFixture(), receipt = await retrievalReceipt(f);
  const bad = [Response.json({ replayed: false, receipt: { ...receipt, resultDigest: 'f'.repeat(64) } }),
    Response.json({ replayed: false, receipt: { ...receipt, request: { ...f.request, query: 'other' } } }), new Response('', { status: 302, headers: { location: 'https://other.example.test' } }),
    new Response('{}', { headers: { 'content-length': String(2 ** 24) } })];
  for (const response of bad) await assert.rejects(new RetrievalClient(context(), async () => response).execute(f.request), code('INVALID'));
  await assert.rejects(new RetrievalClient(context(), async () => Response.json({ requestId: crypto.randomUUID(), status: 'absent', requestDigest: null, receipt: null })).status(f.request.requestId), code('INVALID'));
});
test('account errors retain actionable fixed messages without leaking the server error body', async () => {
  const f = retrievalFixture();
  for (const [serverCode, expected, status] of [['REMOTE_RETRIEVAL_SOURCE_CHANGED','SOURCE_CHANGED',409],['REMOTE_RETRIEVAL_REQUEST_REUSED','REUSED',409],['REMOTE_RETRIEVAL_STORAGE_FULL','CAPACITY',507],['REMOTE_RETRIEVAL_BUSY','BUSY',429],['SESSION_REVOKED','AUTH_REQUIRED',401]] as const) {
    await assert.rejects(new RetrievalClient(context(), async () => Response.json({ error: { code: serverCode, detail: token } }, { status })).execute(f.request), code(expected));
  }
});

test('an oversized declared response cancels its unread stream and aborts the request', async () => {
  const f = retrievalFixture(); let cancelled = 0, requestSignal: AbortSignal | null = null;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const client = new RetrievalClient(context(), async (_url, input) => { requestSignal = input!.signal as AbortSignal; return new Response(body, { headers: { 'content-length': String(2 ** 24) } }); });
  await assert.rejects(client.execute(f.request), code('INVALID')); assert.equal(cancelled, 1); assert.equal(requestSignal!.aborted, true);
});
