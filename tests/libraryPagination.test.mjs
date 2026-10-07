import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');

function fixture(count = 1105) {
  const library = {
    categories: [{ id: 'favorites', isSystem: true, systemKey: 'favorites' }],
    papers: Array.from({ length: count }, (_, index) => ({
      id: `paper-${index}`, title: `Paper ${String(index).padStart(4, '0')}`,
      sortOrder: index, importedAt: index, updatedAt: index, isFavorite: index % 2 === 0,
      categoryIds: [], tags: [], authors: [], keywords: [], attachments: [],
    })),
  };
  let saves = 0;
  return {
    library, saves: () => saves,
    commands: createLibraryCommands({ appPaths: {}, store: { load: () => library, save: async () => { saves++; } } }),
  };
}

test('paged queries expose every result past the old 500/1000 limits without overlaps', async () => {
  const { commands, saves } = fixture();
  const ids = [];
  for (let page = 0; page < 12; page++) {
    const result = await commands.library_list_papers_page({ request: { page, pageSize: 100 } });
    assert.equal(result.total, 1105); assert.equal(result.page, page);
    assert.equal(result.papers.length, page === 11 ? 5 : 100);
    ids.push(...result.papers.map(paper => paper.id));
  }
  assert.deepEqual(ids, Array.from({ length: 1105 }, (_, i) => `paper-${i}`));
  assert.equal(saves(), 0);
});

test('page totals use the same category, search and sort filters as rows', async () => {
  const { commands } = fixture();
  const result = await commands.library_list_papers_page({ request: { categoryId: 'favorites', search: 'Paper 10', sortBy: 'title', sortDirection: 'desc', page: 1, pageSize: 20 } });
  assert.equal(result.total, 50);
  assert.equal(result.papers.length, 20);
  assert.equal(result.papers[0].id, 'paper-1058');
  assert.equal(result.papers.at(-1).id, 'paper-1020');
});

test('empty and out-of-range pages have valid bounds; shrinking results clamp to the last page', async () => {
  const { commands, library } = fixture(201);
  assert.equal((await commands.library_list_papers_page({ request: { page: 999 } })).page, 2);
  library.papers.pop();
  const shrunk = await commands.library_list_papers_page({ request: { page: 2 } });
  assert.equal(shrunk.page, 1); assert.equal(shrunk.papers.length, 100);
  const empty = await commands.library_list_papers_page({ request: { search: 'missing', page: 20 } });
  assert.deepEqual(empty, { papers: [], total: 0, page: 0, pageSize: 100 });
});

test('invalid pagination inputs are normalized and each page is bounded', async () => {
  const { commands } = fixture();
  for (const page of [-1, NaN, Infinity, 1.5, '2']) {
    assert.equal((await commands.library_list_papers_page({ request: { page } })).page, 0);
  }
  assert.equal((await commands.library_list_papers_page({ request: { pageSize: 2000 } })).pageSize, 500);
  assert.equal((await commands.library_list_papers_page({ request: { pageSize: -1 } })).pageSize, 100);
});

test('reordering a filtered page leaves all omitted papers in their original slots', async () => {
  const { commands, library, saves } = fixture(6);
  await commands.library_reorder_papers({ request: { paperIds: ['paper-4', 'paper-2'] } });
  const ordered = await commands.library_list_all_papers();
  assert.deepEqual(ordered.map(paper => paper.id), ['paper-0', 'paper-1', 'paper-4', 'paper-3', 'paper-2', 'paper-5']);
  assert.equal(new Set(library.papers.map(paper => paper.sortOrder)).size, 6);
  assert.equal(saves(), 1);
});

test('stale or malformed reorder requests fail without changing the current order', async () => {
  const { commands, library, saves } = fixture(4);
  const original = structuredClone(library);
  for (const paperIds of [['paper-0', 'missing'], ['paper-0', 'paper-0'], 'paper-0']) {
    await assert.rejects(commands.library_reorder_papers({ request: { paperIds } }), /Invalid paper order/);
    assert.deepEqual(library, original);
  }
  assert.equal(saves(), 0);
});
