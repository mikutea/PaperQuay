import assert from 'node:assert/strict';
import test from 'node:test';
import { SYNC_LIMITS, validateEntityData } from '../../../packages/sync-core/src/index.ts';
import {
  DOI_LOOKUP_LIMITS, DoiLookupError, lookupDoi, normalizeDoi,
  type DoiLookupErrorCode, type DoiLookupOptions, type DoiLookupResult,
} from '../src/library/doiLookup.ts';

const doi = '10.1234/study';
const apiUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
const work = (overrides: Record<string, unknown> = {}) => ({
  DOI: doi, title: ['A study'], author: [{ given: 'Ada', family: 'Lovelace' }],
  issued: { 'date-parts': [[2026, 10, 26]] }, 'container-title': ['Research Journal'],
  abstract: 'A plain abstract.', subject: ['Information Systems'], ...overrides,
});
const envelope = (message: unknown = work()) => ({ status: 'ok', 'message-type': 'work', 'message-version': '1.0.0', message });
const response = (value: unknown = envelope(), init: ResponseInit = {}) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json; charset=utf-8' }, ...init,
});
const fetchFor = (value: unknown = envelope()): typeof fetch => async () => response(value);
const lookup = (overrides: Record<string, unknown> = {}, options: DoiLookupOptions = {}) =>
  lookupDoi(doi, { fetch: fetchFor(envelope(work(overrides))), ...options });
const codes = (result: DoiLookupResult) => result.warnings.map((warning) => warning.code);
async function rejects(code: DoiLookupErrorCode, action: Promise<unknown>): Promise<DoiLookupError> {
  let found: unknown;
  try { await action; } catch (error) { found = error; }
  assert.ok(found instanceof DoiLookupError, `expected safe error ${code}`);
  assert.equal(found.code, code);
  assert.equal(found.message, code);
  assert.equal(found.cause, undefined);
  return found;
}
function invalidDoi(input: unknown) {
  assert.throws(() => normalizeDoi(input as string), (error: unknown) => error instanceof DoiLookupError && error.code === 'INVALID_DOI');
}

test('DOI normalization preserves identifier punctuation and accepts only exact resolver URLs', () => {
  for (const input of [doi, '  DOI: 10.1234/STUDY  ', 'https://doi.org/10.1234%2FSTUDY',
    'http://dx.doi.org/10.1234/STUDY', 'HTTPS://DOI.ORG/10.1234%2fstudy']) assert.equal(normalizeDoi(input), doi);
  assert.equal(normalizeDoi('10.1234/OLD(1998);2-F.'), '10.1234/old(1998);2-f.');
  assert.equal(normalizeDoi('10.1234/query?part#fragment'), '10.1234/query?part#fragment');
  assert.equal(normalizeDoi('10.1234/literal%2Fpart'), '10.1234/literal%2fpart', 'bare identifiers are not URL decoded');
  assert.equal(normalizeDoi('https://doi.org/10.1234%2Fliteral%252Fpart'), '10.1234/literal%2fpart');
  assert.equal(normalizeDoi('10.1002/(SICI)1099-0844(199912)17:4<290::AID-CBF849>3.0.CO;2-P'),
    '10.1002/(sici)1099-0844(199912)17:4<290::aid-cbf849>3.0.co;2-p');
});

test('DOI normalization rejects URL authorities, routing modifiers, controls and malformed identifiers', () => {
  for (const input of [null, 42, '', '10.123/x', '10.1234567890/x', '10.1234/', '10.1234/a b', '10.1234/a\nb',
    '10.1234/a\u0000b', '10.1234/a\u200bb', '10.1234/a\ud800', '10.1234/a\\b', 'ftp://doi.org/10.1234/x',
    'https://doi.org.evil.test/10.1234/x', 'https://evil.test/10.1234/x', 'https://doi.org@evil.test/10.1234/x',
    'https://user@doi.org/10.1234/x', 'https://doi.org:443/10.1234/x', 'http://doi.org:80/10.1234/x',
    'https://doi.org/10.1234/x?', 'https://doi.org/10.1234/x#', 'https://doi.org/10.1234/x?q=1',
    'https://doi.org/10.1234/x#fragment', 'https://doi.org\\10.1234/x', 'https://doi.org/10.1234/x/../y',
    'https://doi.org/10.1234/x/%2e%2e/y', 'https://doi.org/10.1234/%zz', 'https://doi.org/10.1234/%ED%A0%80',
    `10.1234/${'x'.repeat(DOI_LOOKUP_LIMITS.maxDoiLength)}`, ' '.repeat(DOI_LOOKUP_LIMITS.maxInputLength + 1)]) invalidDoi(input);
});

test('lookup uses one fixed Crossref request, no credentials, cache, headers or redirects, and returns an unsaved archive', async () => {
  const specialDoi = '10.1234/a?query#fragment';
  const calls: { url: string; options: RequestInit }[] = [];
  const fake: typeof fetch = async (input, options) => {
    calls.push({ url: String(input), options: options! });
    return response(envelope(work({ DOI: specialDoi.toUpperCase() })));
  };
  const result = await lookupDoi(specialDoi, { fetch: fake });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.crossref.org/works/${encodeURIComponent(specialDoi)}`);
  assert.deepEqual(Object.keys(calls[0].options).sort(), ['cache', 'credentials', 'method', 'mode', 'redirect', 'referrerPolicy', 'signal']);
  assert.deepEqual({ ...calls[0].options, signal: undefined }, { method: 'GET', signal: undefined, credentials: 'omit',
    redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.source.provider, 'Crossref');
  assert.equal(result.source.doi, specialDoi);
  assert.equal(result.source.doiUrl, `https://doi.org/${encodeURIComponent(specialDoi)}`);
  assert.equal(result.source.apiUrl, calls[0].url);
  assert.deepEqual(result.archive, { format: 'paperquay-library', version: 1, papers: [{ ref: 'p1', data: {
    title: 'A study', doi: specialDoi, year: '2026', publication: 'Research Journal', abstractText: 'A plain abstract.',
    authors: ['Ada Lovelace'], keywords: ['Information Systems'],
  } }], notes: [] });
  assert.equal(validateEntityData('paper', result.archive.papers[0].data).ok, true);
  assert.equal(result.archive.papers[0].data.organization, undefined);
  assert.equal(result.source.yearField, 'issued');
  assert.deepEqual(result.warnings, [{ code: 'SUBJECTS_AS_KEYWORDS', field: 'keywords' }]);
});

test('lookup rejects bad identifiers and options before any request', async () => {
  let calls = 0;
  const fake: typeof fetch = async () => { calls += 1; return response(); };
  await rejects('INVALID_DOI', lookupDoi('https://example.com/secret', { fetch: fake }));
  for (const timeout of [0, -1, 1.2, NaN, Infinity, DOI_LOOKUP_LIMITS.maxTimeout + 1]) {
    await rejects('INVALID_OPTIONS', lookupDoi(doi, { fetch: fake, timeout }));
  }
  await rejects('INVALID_OPTIONS', lookupDoi(doi, null as unknown as DoiLookupOptions));
  await rejects('INVALID_OPTIONS', lookupDoi(doi, { fetch: false } as unknown as DoiLookupOptions));
  await rejects('INVALID_OPTIONS', lookupDoi(doi, { fetch: null } as unknown as DoiLookupOptions));
  await rejects('INVALID_OPTIONS', lookupDoi(doi, { fetch: fake, timeout: null } as unknown as DoiLookupOptions));
  await rejects('INVALID_OPTIONS', lookupDoi(doi, { fetch: fake, signal: {} } as DoiLookupOptions));
  const controller = new AbortController();
  controller.abort('private reason');
  await rejects('ABORTED', lookupDoi(doi, { fetch: fake, signal: controller.signal }));
  assert.equal(calls, 0);
});

test('errors expose fixed codes without server content or underlying transport details', async () => {
  for (const [status, code] of [[404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'SERVICE_UNAVAILABLE'],
    [503, 'SERVICE_UNAVAILABLE'], [401, 'HTTP_ERROR'], [302, 'HTTP_ERROR'], [206, 'HTTP_ERROR']] as const) {
    const error = await rejects(code, lookupDoi(doi, { fetch: async () => new Response('private service response', { status }) }));
    assert.ok(!JSON.stringify(error).includes('private'));
  }
  await rejects('NETWORK_FAILED', lookupDoi(doi, { fetch: async () => { throw new Error('private URL and auth reason'); } }));
  await rejects('NETWORK_FAILED', lookupDoi(doi, { fetch: (() => { throw new TypeError('synchronous private detail'); }) as typeof fetch }));
  const controller = new AbortController();
  await rejects('ABORTED', lookupDoi(doi, { signal: controller.signal, fetch: (() => {
    controller.abort();
    throw new Error('transport aborted synchronously');
  }) as typeof fetch }));
});

test('lookup does not cache results between calls or reuse mutable preview objects', async () => {
  let calls = 0;
  const fake: typeof fetch = async () => { calls += 1; return response(); };
  const first = await lookupDoi(doi, { fetch: fake });
  first.archive.papers[0].data.title = 'Changed locally';
  first.warnings.length = 0;
  const second = await lookupDoi(doi, { fetch: fake });
  assert.equal(calls, 2);
  assert.equal(second.archive.papers[0].data.title, 'A study');
  assert.deepEqual(codes(second), ['SUBJECTS_AS_KEYWORDS']);
});

test('cancellation settles an ignored-abort fetch and discards its eventual body', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let finish: (value: Response) => void = () => {};
  let requestSignal: AbortSignal | undefined;
  let cancelled = false;
  const fake: typeof fetch = (_input, options) => {
    requestSignal = options!.signal as AbortSignal;
    return new Promise((resolve) => { finish = resolve; });
  };
  const pending = lookupDoi(doi, { fetch: fake, signal: controller.signal });
  controller.abort('not included in error');
  await rejects('ABORTED', pending);
  assert.equal(requestSignal?.aborted, true);
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test('timeouts settle ignored-abort transports without retries', { timeout: 1000 }, async () => {
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  await rejects('TIMEOUT', lookupDoi(doi, { timeout: 5, fetch: (_input, options) => {
    calls += 1;
    requestSignal = options!.signal as AbortSignal;
    return new Promise(() => {});
  } }));
  assert.equal(calls, 1);
  assert.equal(requestSignal?.aborted, true);
});

test('cancellation and timeouts also settle stalled body reads without waiting for body cancellation', { timeout: 1000 }, async () => {
  for (const abort of [true, false]) {
    const controller = new AbortController();
    let reading: () => void = () => {};
    const ready = new Promise<void>((resolve) => { reading = resolve; });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() { reading(); return new Promise(() => {}); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const pending = lookupDoi(doi, { signal: controller.signal, timeout: abort ? 500 : 5,
      fetch: async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }) });
    await ready;
    if (abort) controller.abort();
    await rejects(abort ? 'ABORTED' : 'TIMEOUT', pending);
    assert.equal(cancelled, true);
  }
});

test('response validation rejects redirects, wrong media types, wrong destination, bad UTF-8 and invalid JSON', async () => {
  const badUrl = response();
  Object.defineProperty(badUrl, 'url', { value: 'https://other.example/work' });
  const redirected = response();
  Object.defineProperty(redirected, 'redirected', { value: true });
  const opaque = response();
  Object.defineProperty(opaque, 'type', { value: 'opaque' });
  for (const bad of [badUrl, redirected, opaque, new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{}'), new Response(null, { headers: { 'Content-Type': 'application/json' } }),
    new Response('{"message":', { headers: { 'Content-Type': 'application/json' } }),
    new Response(Uint8Array.from([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json' } })]) {
    await rejects('INVALID_RESPONSE', lookupDoi(doi, { fetch: async () => bad }));
  }
  const validUrl = response();
  Object.defineProperty(validUrl, 'url', { value: apiUrl });
  assert.equal((await lookupDoi(doi, { fetch: async () => validUrl })).source.doi, doi);
  const vendorJson = response(envelope(), { headers: { 'Content-Type': 'application/vnd.crossref-api-message+json' } });
  assert.equal((await lookupDoi(doi, { fetch: async () => vendorJson })).source.doi, doi);
});

test('lookup enforces declared and actual body limits and bounds zero-byte stream chunks', async () => {
  let cancelled = false;
  const declared = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: {
    'Content-Type': 'application/json', 'Content-Length': String(DOI_LOOKUP_LIMITS.maxResponseBytes + 1),
  } });
  await rejects('RESPONSE_TOO_LARGE', lookupDoi(doi, { fetch: async () => declared }));
  assert.equal(cancelled, true);
  await rejects('RESPONSE_TOO_LARGE', lookupDoi(doi, { fetch: async () => new Response(
    new Uint8Array(DOI_LOOKUP_LIMITS.maxResponseBytes + 1), { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } },
  ) }));
  let pulls = 0;
  let emptyCancelled = false;
  const empty = new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array()); }, cancel() { emptyCancelled = true; },
  });
  await rejects('RESPONSE_TOO_LARGE', lookupDoi(doi, { fetch: async () => new Response(empty, { headers: { 'Content-Type': 'application/json' } }) }));
  assert.ok(pulls <= DOI_LOOKUP_LIMITS.maxResponseChunks + 2);
  assert.equal(emptyCancelled, true);
});

test('valid multi-chunk UTF-8 is reconstructed and deep JSON or a failed stream is rejected', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope(work({ title: ['中文标题 β'] }))));
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + 1)); offset += 1;
  } });
  const result = await lookupDoi(doi, { fetch: async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(result.archive.papers[0].data.title, '中文标题 β');
  let deep: unknown = {};
  for (let index = 0; index < DOI_LOOKUP_LIMITS.maxJsonDepth + 1; index += 1) deep = { child: deep };
  await rejects('INVALID_RESPONSE', lookupDoi(doi, { fetch: fetchFor(envelope(work({ extra: deep }))) }));
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private transport detail')); } });
  await rejects('NETWORK_FAILED', lookupDoi(doi, { fetch: async () => new Response(broken, { headers: { 'Content-Type': 'application/json' } }) }));
});

test('Crossref envelope and requested DOI are validated before metadata can be previewed', async () => {
  for (const bad of [null, [], {}, { ...envelope(), status: 'failed' }, { ...envelope(), 'message-type': 'work-list' },
    { ...envelope(), 'message-version': '2.0.0' }, { ...envelope(), 'message-version': undefined },
    envelope([]), envelope(work({ DOI: undefined })), envelope(work({ DOI: 1234 })), envelope(work({ DOI: 'wrong' }))]) {
    await rejects('INVALID_RESPONSE', lookupDoi(doi, { fetch: fetchFor(bad) }));
  }
  await rejects('DOI_MISMATCH', lookup({ DOI: '10.1234/another' }));
  assert.equal((await lookup({ DOI: doi.toUpperCase() })).archive.papers[0].data.doi, doi);
});

test('title is required; alternatives, subtitles and unsupported metadata are disclosed without inventing fields', async () => {
  for (const title of [undefined, [], ['   '], ['<p></p>']]) await rejects('MISSING_TITLE', lookup({ title, subtitle: ['Fallback is forbidden'] }));
  const result = await lookup({ title: ['', 'Primary title', 'Translated title'], subtitle: ['A subtitle'],
    'container-title': ['Journal A', 'Journal B'], volume: '12', issue: '2', page: '10-20',
    type: 'journal-article', URL: 'https://publisher.example/private', ISBN: ['123'], editor: [{ family: 'Editor' }] });
  assert.equal(result.archive.papers[0].data.title, 'Primary title');
  assert.equal(result.archive.papers[0].data.publication, 'Journal A');
  for (const code of ['TITLE_ALTERNATIVES_OMITTED', 'SUBTITLE_OMITTED', 'PUBLICATION_ALTERNATIVES_OMITTED', 'ADDITIONAL_METADATA_OMITTED']) {
    assert.ok(codes(result).includes(code as DoiLookupResult['warnings'][number]['code']));
  }
  assert.ok(!JSON.stringify(result).includes('publisher.example'));
  assert.ok(!JSON.stringify(result.archive).includes('Editor'));
  const missing = await lookup({ author: undefined, issued: undefined, abstract: undefined, subject: undefined,
    'container-title': undefined, publisher: 'Publisher is not a journal', institution: [{ name: 'Not an author' }] });
  assert.deepEqual(missing.archive.papers[0].data, { title: 'A study', doi, year: null, publication: null, abstractText: null, authors: [], keywords: [] });
  for (const code of ['AUTHORS_MISSING', 'YEAR_MISSING', 'PUBLICATION_MISSING', 'ABSTRACT_MISSING', 'ADDITIONAL_METADATA_OMITTED']) {
    assert.ok(codes(missing).includes(code as DoiLookupResult['warnings'][number]['code']));
  }
});

test('author order, personal suffixes and corporate names survive while affiliations stay separate', async () => {
  const result = await lookup({ author: [
    { given: 'Jane', family: 'van der Meer', suffix: 'Jr.', affiliation: [{ name: 'University' }], ORCID: 'https://orcid.org/0000' },
    { name: 'Global Research Consortium' }, { family: 'Mononym' },
    { name: 'Ambiguous organization', given: 'Conflicting', family: 'Person' }, { affiliation: [{ name: 'Not a contributor' }] },
  ] });
  assert.deepEqual(result.archive.papers[0].data.authors, ['Jane van der Meer Jr.', 'Global Research Consortium', 'Mononym']);
  assert.ok(codes(result).includes('AUTHORS_INCOMPLETE'));
  assert.ok(codes(result).includes('AFFILIATIONS_OMITTED'));
  assert.ok(codes(result).includes('ADDITIONAL_METADATA_OMITTED'));
  assert.ok(!JSON.stringify(result.archive).includes('University'));
  assert.ok(!JSON.stringify(result.archive).includes('ORCID'));
  assert.ok(!codes(result).includes('AUTHORS_MISSING'));
});

test('publication year uses explicit priority and provenance, warns on fallback/conflict and never uses registry dates', async () => {
  const result = await lookup({ issued: { 'date-parts': [[2024]] }, published: { 'date-parts': [[2025]] },
    'published-print': { 'date-parts': [[2026]] }, 'published-online': { 'date-parts': [[2023]] } });
  assert.equal(result.archive.papers[0].data.year, '2024');
  assert.equal(result.source.yearField, 'issued');
  assert.ok(codes(result).includes('YEAR_CONFLICT'));
  assert.ok(!codes(result).includes('YEAR_FALLBACK'));
  const fallback = await lookup({ issued: { 'date-parts': [[2026, 2, 29]] }, published: { 'date-parts': [[2024, 2, 29]] },
    'published-print': { 'date-parts': [[2025]] } });
  assert.equal(fallback.archive.papers[0].data.year, '2024');
  assert.equal(fallback.source.yearField, 'published');
  for (const code of ['YEAR_INVALID', 'YEAR_FALLBACK', 'YEAR_CONFLICT']) assert.ok(codes(fallback).includes(code as 'YEAR_INVALID'));
  const online = await lookup({ issued: undefined, 'published-online': { 'date-parts': [[2020]] } });
  assert.equal(online.source.yearField, 'published-online');
  assert.equal(online.archive.papers[0].data.year, '2020');
  const registry = await lookup({ issued: undefined, created: { 'date-parts': [[2001]] }, deposited: { 'date-parts': [[2025]] },
    indexed: { 'date-parts': [[2026]] } });
  assert.equal(registry.archive.papers[0].data.year, null);
  assert.equal(registry.source.yearField, null);
  assert.ok(codes(registry).includes('YEAR_MISSING'));
});

test('invalid publication date shapes stay empty with warnings instead of guessing a year', async () => {
  for (const issued of [null, '2026', {}, { 'date-parts': [] }, { 'date-parts': [[2026], [2027]] },
    { 'date-parts': [['2026']] }, { 'date-parts': [[0]] }, { 'date-parts': [[10000]] },
    { 'date-parts': [[2026, 13]] }, { 'date-parts': [[2026, 4, 31]] }, { 'date-parts': [[2026, 2, 0]] }]) {
    const result = await lookup({ issued });
    assert.equal(result.archive.papers[0].data.year, null);
    assert.ok(codes(result).includes('YEAR_INVALID'));
    assert.ok(codes(result).includes('YEAR_MISSING'));
  }
});

test('common JATS becomes plain text, with entities, paragraph boundaries and superscript meaning preserved', async () => {
  const result = await lookup({ title: ['<i>Delta</i> &amp; density'], abstract:
    '<jats:abstract xmlns:jats="https://jats.nlm.nih.gov"><jats:p>A <jats:italic>safe</jats:italic> &amp; &#x3b2; abstract.</jats:p>'
    + '<jats:p>H<jats:sub>2</jats:sub>O; x<jats:sup>2</jats:sup>. <jats:ext-link xlink:href="https://external.example">Link label</jats:ext-link></jats:p></jats:abstract>' });
  assert.equal(result.archive.papers[0].data.title, 'Delta & density');
  assert.equal(result.archive.papers[0].data.abstractText, 'A safe & β abstract.\n\nH_{2}O; x^{2}. Link label');
  assert.ok(result.warnings.some((warning) => warning.code === 'TEXT_FORMATTING_REMOVED' && warning.field === 'abstractText'));
  assert.ok(result.warnings.some((warning) => warning.code === 'TEXT_FORMATTING_REMOVED' && warning.field === 'title'));
  assert.ok(!JSON.stringify(result.archive).includes('external.example'));
  const literal = await lookup({ abstract: 'A < B and C > D; &lt;p&gt; is literal text.' });
  assert.equal(literal.archive.papers[0].data.abstractText, 'A < B and C > D; <p> is literal text.');
});

test('complex, malformed or executable markup is omitted with a safe warning', async () => {
  for (const abstract of ['<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>', '<script>alert("private")</script>',
    '<!DOCTYPE x SYSTEM "https://external.example/entity"><p>text</p>', '<p>&custom;</p>', '<p>&#xzz;</p>', '<p>&#;</p>', '<p>mismatch</sec>',
    '<p>unclosed', '<p title=unquoted>text</p>', '<?xml version="1.0"?><p>text</p>', '<other:p>text</other:p>', '<p>\u0000</p>']) {
    const result = await lookup({ abstract });
    assert.equal(result.archive.papers[0].data.abstractText, null);
    assert.ok(codes(result).includes('ABSTRACT_UNSUPPORTED'));
    assert.ok(!JSON.stringify(result).includes('private'));
  }
  await rejects('INVALID_RESPONSE', lookup({ title: ['<script>unsafe title</script>'] }));
  await rejects('INVALID_RESPONSE', lookup({ title: ['Invalid\ud800'] }));
});

test('metadata type and count limits fail without silently truncating required bibliographic values', async () => {
  for (const invalid of [{ title: 'Title' }, { title: [42] }, { author: {} }, { author: ['Name'] },
    { author: [{ given: 42, family: 'Name' }] }, { 'container-title': 1 }, { abstract: {} }, { subject: [1] }]) {
    await rejects('INVALID_RESPONSE', lookup(invalid));
  }
  for (const large of [{ title: ['x'.repeat(SYNC_LIMITS.maxTitleLength + 1)] },
    { title: ['x'.repeat(SYNC_LIMITS.maxTitleLength * 4 + 1)] },
    { title: Array(DOI_LOOKUP_LIMITS.maxTextAlternatives + 1).fill('Title') },
    { author: Array(SYNC_LIMITS.maxAuthors + 1).fill({ family: 'Name' }) },
    { author: [{ given: 'x'.repeat(SYNC_LIMITS.maxNameLength), family: 'y' }] },
    { subject: Array(SYNC_LIMITS.maxKeywords + 1).fill('Topic') },
    { subject: ['x'.repeat(SYNC_LIMITS.maxNameLength + 1)] },
    { abstract: 'x'.repeat(SYNC_LIMITS.maxAbstractLength + 1) }, { 'container-title': ['x'.repeat(2049)] }]) {
    await rejects('METADATA_LIMIT', lookup(large));
  }
});
