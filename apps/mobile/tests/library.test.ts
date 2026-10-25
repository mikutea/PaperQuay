import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PaperData, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import { MarkdownPreview } from '../src/components/MarkdownPreview.tsx';
import { filterPapers, normalizeOrganization, organizationOf, type LibraryFilter } from '../src/library/organization.ts';

const paper: PaperData = { title: 'Study', authors: ['Author'], year: '2026', doi: null, publication: null, abstractText: null, keywords: ['research'] };
const row = (id: string, data: PaperData): VisibleEntity => ({ entityType: 'paper', entityId: id, data, revision: 1, deleted: false, pending: false, status: 'synced' });
const filter: LibraryFilter = { query: '', favorite: false, readingStatus: '', tag: '', collection: '', year: '', queued: false };
test('library combines independent organization filters and uses deterministic queue ordering', () => {
  const a = row('b', { ...paper, organization: { favorite: true, readingStatus: 'reading', tags: ['village'], collections: ['thesis'], queueRank: 2 } });
  const b = row('a', { ...paper, title: 'Another', organization: { ...organizationOf(a.data as PaperData), queueRank: 2 } });
  const c = row('c', paper);
  assert.deepEqual(filterPapers([a, b, c], { ...filter, queued: true }).map((entity) => entity.entityId), ['a', 'b']);
  assert.deepEqual(filterPapers([a, b, c], { ...filter, query: 'AUTHOR', favorite: true, readingStatus: 'reading', tag: 'village', collection: 'thesis', year: '2026' }), [a, b]);
  assert.deepEqual(filterPapers([a, c], { ...filter, readingStatus: 'unread' }), [c]);
  assert.equal(filterPapers([a, b], { ...filter, year: '2025' }).length, 0);
  const value = normalizeOrganization({ ...organizationOf(paper), tags: [' one ', 'one', '', 'two'], collections: ['group', ' group '] });
  assert.deepEqual(value.tags, ['one', 'two']);
  assert.deepEqual(value.collections, ['group']);
});

test('Markdown preview renders GFM without HTML execution, image fetches or unsafe links', () => {
  const html = renderToStaticMarkup(createElement(MarkdownPreview, { body: '# Heading\n\n<script>alert(1)</script>\n\n![tracking](https://example.test/pixel)\n\n[unsafe](javascript:alert(1)) [safe](https://example.test/paper)\n\n| A | B |\n| - | - |\n| 1 | 2 |' }));
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script|<img|javascript:/);
  assert.match(html, /href="https:\/\/example.test\/paper"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
