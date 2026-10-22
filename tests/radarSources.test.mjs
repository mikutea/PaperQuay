import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { searchTopic, mapWork, readBoundedJson } = require('../electron/backend/radarSources.cjs');
const { normalizeTopic } = require('../electron/backend/radarDomain.cjs');
const config = (patch = {}) => normalizeTopic({ name: 'Battery research', queries: ['battery recycling'], sources: ['crossref', 'openalex'], ...patch });
const work = (index) => ({ DOI: '10.1234/work-' + index, title: ['Battery work ' + index], author: [{ given: 'Ada', family: 'Researcher' }], published: { 'date-parts': [[2026]] } });
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('provider mapping normalizes metadata and rejects malformed titles and unsafe links', () => {
  const crossref = mapWork('crossref', { ...work(1), abstract: '<jats:p>Plain abstract</jats:p>' });
  assert.equal(crossref.abstractText, 'Plain abstract');
  assert.deepEqual(crossref.authors, ['Ada Researcher']);
  assert.equal(mapWork('crossref', { ...work(1), title: 'not an array' }), null);
  const alex = mapWork('openalex', { id: 'https://openalex.org/W1', display_name: 'A title', publication_year: 2026,
    primary_location: { landing_page_url: 'file:///secret' }, authorships: [null, { author: { display_name: 'Author' } }],
    abstract_inverted_index: { world: [1, -1, 1e8], Hello: [0], invalid: 'wrong' } });
  assert.equal(alex.abstractText, 'Hello world'); assert.equal(alex.url, ''); assert.deepEqual(alex.authors, ['Author']);
});

test('search uses fixed provider hosts, refuses redirects and reports a bounded publication window', async () => {
  const calls = [];
  const result = await searchTopic(config({ sources: ['crossref'] }), {}, { timestamp: Date.UTC(2026, 9, 22), throttleMs: 0,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response({ message: { items: Array.from({ length: 25 }, (_, i) => work(calls.length * 25 + i)), 'total-results': 900 } }); } });
  assert.equal(calls.length, 2); assert.equal(result.records.length, 50); assert.equal(result.reports[0].limited, true);
  assert.equal(calls[0].url.origin, 'https://api.crossref.org'); assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].url.searchParams.get('filter'), /until-pub-date:2026-10-22/);
  assert.equal(calls[1].url.searchParams.get('offset'), '25');
});

test('one failed provider does not erase another provider and errors never expose credentials', async () => {
  const secret = 'private-fixture-key'; let attempts = 0;
  const result = await searchTopic(config(), { openAlexApiKey: secret }, { throttleMs: 0, fetchImpl: async (url) => {
    attempts++;
    if (url.hostname === 'api.crossref.org') return response({ message: { items: [work(1)], 'total-results': 1 } });
    assert.equal(url.searchParams.get('api_key'), secret);
    throw new Error('Connection failed: ' + url.href);
  } });
  assert.equal(attempts, 2); assert.equal(result.records.length, 1); assert.equal(result.reports[1].error, 'Request failed or timed out');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('rate limits stop that provider, preserve partial results and bound Retry-After', async () => {
  let calls = 0;
  const before = Date.now();
  const result = await searchTopic(config({ sources: ['crossref'], queries: ['first', 'second'] }), {}, { throttleMs: 0,
    fetchImpl: async () => { calls++; return calls === 1 ? response({ message: { items: Array.from({ length: 25 }, (_, i) => work(i)), 'total-results': 100 } }) : new Response('', { status: 429, headers: { 'retry-after': '99999999' } }); } });
  assert.equal(calls, 2); assert.equal(result.records.length, 25); assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].error, 'HTTP 429');
  assert.ok(result.reports[0].retryAt >= before + 86400000 && result.reports[0].retryAt <= Date.now() + 86400000);
});

test('cancel propagates without emitting a successful or empty result', async () => {
  const controller = new AbortController();
  const pending = searchTopic(config(), {}, { signal: controller.signal, throttleMs: 0, fetchImpl: async (_url, options) => {
    controller.abort(new Error('fixture cancellation')); throw options.signal.reason;
  } });
  await assert.rejects(pending, /fixture cancellation/);
});

test('query-specific failures continue to the remaining queries and keep independent results', async () => {
  let calls = 0;
  const result = await searchTopic(config({ sources: ['crossref'], queries: ['timeout', 'bad filter', 'working query'] }), {}, { throttleMs: 0,
    fetchImpl: async () => { calls++; if (calls === 1) throw new Error('fixture timeout'); if (calls === 2) return new Response('', { status: 400 }); return response({ message: { items: [work(1)], 'total-results': 1 } }); } });
  assert.equal(calls, 3); assert.equal(result.reports.length, 3); assert.equal(result.records.length, 1);
  assert.equal(result.reports[0].error, 'Request failed or timed out'); assert.equal(result.reports[1].error, 'HTTP 400');
  assert.equal(result.reports[2].error, null);
});

test('authentication failures stop all remaining queries for that provider', async () => {
  let calls = 0;
  const result = await searchTopic(config({ sources: ['crossref'], queries: ['first', 'second'] }), {}, { throttleMs: 0,
    fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } });
  assert.equal(calls, 1); assert.equal(result.reports[0].error, 'HTTP 401');
});

test('bounded JSON cancels an oversized body before reading and limits streamed responses', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readBoundedJson(new Response(body, { headers: { 'content-length': String(4 * 1024 * 1024) } })), /too large/);
  assert.equal(cancelled, true);
  await assert.rejects(readBoundedJson(new Response(' '.repeat(4 * 1024 * 1024))), /too large/);
});
