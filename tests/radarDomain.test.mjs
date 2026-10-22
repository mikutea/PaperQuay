import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeTopic, samePaper, normalizeDoi, publicUrl, mergeCandidates, rankPaper, buildQueue } = require('../electron/backend/radarDomain.cjs');
const topic = (patch = {}) => normalizeTopic({ name: 'Materials research', queries: ['battery recycling'], sources: ['crossref'],
  includeTerms: ['battery'], priorityTerms: ['recycling'], methodTerms: ['experiment'], ...patch });
const paper = (patch = {}) => ({ id: 'p1', title: 'Battery recycling experiment', authors: [{ name: 'Ada Researcher' }],
  year: '2025', doi: '10.1234/example', attachments: [], importedAt: 1, readingProgress: 0, ...patch });

test('topic configuration is general and rejects invalid or unbounded inputs', () => {
  const configured = topic();
  assert.equal(configured.enabled, false);
  assert.equal(configured.name, 'Materials research');
  assert.throws(() => topic({ queries: [] }));
  assert.throws(() => topic({ sources: ['https://untrusted.example'] }));
  assert.throws(() => topic({ weights: { relevance: -1 } }));
  assert.throws(() => topic({ intervalHours: 0 }));
  assert.throws(() => topic({ queries: Array.from({ length: 5 }, (_, i) => `query ${i}`) }));
});

test('deduplication normalizes DOI and preserves different identified works', () => {
  assert.equal(normalizeDoi(' https://doi.org/10.1234/EXAMPLE '), '10.1234/example');
  assert.ok(samePaper(paper(), paper({ title: 'Different indexing title', doi: 'DOI:10.1234/EXAMPLE' })));
  assert.equal(samePaper(paper(), paper({ doi: '10.1234/different' })), false);
  assert.ok(samePaper(paper(), paper({ doi: '', authors: ['Ada Researcher'] })));
  assert.equal(samePaper(paper({ doi: '', authors: [] }), paper({ doi: '', authors: [] })), false);
  assert.equal(samePaper(paper({ doi: '' }), paper({ doi: '', year: '2024' })), false);
});

test('publication links reject privileged protocols, credentials and local hosts', () => {
  assert.equal(publicUrl('https://doi.org/10.1234/example'), 'https://doi.org/10.1234/example');
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'https://user:secret@publisher.example', 'http://127.0.0.1/x', 'http://host.local/x', 'http://[::1]/x']) assert.equal(publicUrl(url), '');
});

test('candidate merging is idempotent across providers and keeps dismissal and topic membership', () => {
  const first = topic(), second = topic({ name: 'Second topic' });
  const state = { candidates: [] };
  const record = { ...paper(), authors: ['Ada Researcher'], source: 'crossref', sourceId: '10.1234/example' };
  assert.equal(mergeCandidates(state, [record], first, 1, { papers: [] }).added, 1);
  state.candidates[0].dismissed = true;
  assert.equal(mergeCandidates(state, [{ ...record, source: 'openalex' }], second, 2, { papers: [paper()] }).added, 0);
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].dismissed, true);
  assert.deepEqual(state.candidates[0].topicIds, [first.id, second.id]);
  assert.deepEqual(state.candidates[0].sources, ['crossref', 'openalex']);
  assert.equal(state.candidates[0].paperId, 'p1');
});

test('ranking exposes contributions, respects exclusions, and never rewards unknown dates', () => {
  const ranked = rankPaper(paper(), topic(), Date.UTC(2026, 9, 22));
  assert.equal(ranked.score, ranked.reasons.reduce((sum, reason) => sum + reason.points, 0));
  assert.equal(rankPaper(paper({ year: '' }), topic()).reasons.find((item) => item.key === 'recency').points, 0);
  assert.equal(rankPaper(paper(), topic({ excludeTerms: ['recycling'] })).score, 0);
  assert.ok(ranked.reasons.find((item) => item.key === 'methods').matched.includes('experiment'));
});

test('indexed merging keeps distinct known DOIs and ambiguous undated records separate', () => {
  const research = topic(), state = { candidates: [] };
  const record = { ...paper(), authors: ['Ada Researcher'], source: 'crossref', sourceId: 'first' };
  mergeCandidates(state, [record, { ...record, doi: '10.1234/different', sourceId: 'second' }], research, 1, { papers: [] });
  assert.equal(state.candidates.length, 2);
  mergeCandidates(state, [{ ...record, doi: '', year: '', sourceId: 'undated-1' },
    { ...record, doi: '', year: '', sourceId: 'undated-2' }], research, 2, { papers: [] });
  assert.equal(state.candidates.length, 4);
});

test('the queue includes old and new papers without the library UI page limit and preserves manual choices', () => {
  const research = topic();
  const papers = Array.from({ length: 1002 }, (_, i) => paper({ id: `p${i}`, importedAt: i }));
  papers[1001].readingProgress = 1;
  const state = { topics: [research], queue: [{ paperId: 'p1000', pinned: true, status: 'later' }, { paperId: 'p1001', status: 'unread' }] };
  const rows = buildQueue({ papers }, state, research.id);
  assert.equal(rows.length, 1002);
  assert.equal(rows[0].paper.id, 'p1000');
  assert.equal(rows[0].status, 'later');
  assert.equal(rows.find((row) => row.paper.id === 'p1001').status, 'unread');
  assert.equal(rows[1].evidence, 'metadata');
  assert.equal(papers[0].sortOrder, undefined);
});
