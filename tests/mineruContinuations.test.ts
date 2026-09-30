import test from 'node:test';
import assert from 'node:assert/strict';

import {
  flattenMineruPages,
  resolveMineruBlockContentSource,
  extractMineruAssetPathFromBlock,
  extractTextFromMineruBlock,
} from '../src/services/mineru.ts';
import type { MineruPage } from '../src/types/reader.ts';

test('empty paragraph blocks point to the previous paragraph content source', () => {
  const pages: MineruPage[] = [
    [
      {
        type: 'paragraph',
        content: { text: 'The paragraph starts on the previous page and continues after the break.' },
        bbox: [100, 100, 900, 940],
        bboxCoordinateSystem: 'normalized-1000',
      },
      {
        type: 'paragraph',
        content: { text: '' },
        bbox: [100, 50, 900, 90],
        bboxCoordinateSystem: 'normalized-1000',
      },
    ],
    [
      {
        type: 'paragraph',
        content: { text: '' },
        bbox: [100, 60, 900, 180],
        bboxCoordinateSystem: 'normalized-1000',
      },
      {
        type: 'paragraph',
        content: { text: 'A separate paragraph follows.' },
        bbox: [100, 220, 900, 360],
        bboxCoordinateSystem: 'normalized-1000',
      },
    ],
  ];

  const blocks = flattenMineruPages(pages);
  const blockById = new Map(blocks.map((block) => [block.blockId, block]));
  const samePageContinuation = blocks[1];
  const crossPageContinuation = blocks[2];
  const samePageSource = resolveMineruBlockContentSource(samePageContinuation, blockById);
  const crossPageSource = resolveMineruBlockContentSource(crossPageContinuation, blockById);

  assert.equal(samePageContinuation.contentSourceBlockId, blocks[0].blockId);
  assert.equal(crossPageContinuation.contentSourceBlockId, blocks[0].blockId);
  assert.equal(samePageSource.blockId, blocks[0].blockId);
  assert.equal(crossPageSource.blockId, blocks[0].blockId);
  assert.equal(
    extractTextFromMineruBlock(crossPageSource),
    'The paragraph starts on the previous page and continues after the break.',
  );
  assert.equal(blocks[3].contentSourceBlockId, undefined);
});

test('cross-page empty table fragments point to their last contentful table', () => {
  const pages: MineruPage[] = [
    [{
      type: 'table',
      content: { html: '<table><tr><td>First</td></tr></table>', image_source: { path: 'images/table.png' } },
      bbox: [100, 100, 900, 900],
      bboxCoordinateSystem: 'normalized-1000',
    }],
    [{
      type: 'table',
      content: { image_source: { path: 'images/' } },
      bbox: [100, 60, 900, 900],
      bboxCoordinateSystem: 'normalized-1000',
    }],
    [{
      type: 'table',
      content: { image_source: { path: '' } },
      bbox: [100, 60, 900, 900],
      bboxCoordinateSystem: 'normalized-1000',
    }],
  ];
  const blocks = flattenMineruPages(pages);
  const blockById = new Map(blocks.map((block) => [block.blockId, block]));

  assert.equal(blocks[1].contentSourceBlockId, blocks[0].blockId);
  assert.equal(blocks[2].contentSourceBlockId, blocks[0].blockId);
  assert.equal(resolveMineruBlockContentSource(blocks[1], blockById).blockId, blocks[0].blockId);
});

test('directory-only assets are ignored while real images and HTML tables remain contentful', () => {
  const pages: MineruPage[] = [[
    { type: 'table', content: { image_source: { path: 'images/' } } },
    { type: 'table', content: { image_source: { path: 'images/table.png' } } },
    { type: 'table', content: { img_path: 'images\\' } },
    { type: 'table', content: { html: '<table><tr><td>Second</td></tr></table>' } },
  ]];
  const blocks = flattenMineruPages(pages);

  assert.equal(extractMineruAssetPathFromBlock(blocks[0]), undefined);
  assert.equal(extractMineruAssetPathFromBlock(blocks[1]), 'images/table.png');
  assert.equal(extractMineruAssetPathFromBlock(blocks[2]), undefined);
  assert.equal(blocks[0].contentSourceBlockId, undefined);
  assert.equal(blocks[2].contentSourceBlockId, blocks[1].blockId);
  assert.equal(blocks[3].contentSourceBlockId, undefined);
});

test('an empty HTML table shell inherits the adjacent contentful table', () => {
  const blocks = flattenMineruPages([[
    { type: 'table', content: { html: '<table><tr><td>Data</td></tr></table>' } },
    { type: 'table', content: { html: '<table><tr></tr></table>' } },
  ]]);

  assert.equal(blocks[1].contentSourceBlockId, blocks[0].blockId);
});

test('empty tables do not reuse a source after intervening content or a page gap', () => {
  const blocks = flattenMineruPages([
    [
      { type: 'table', content: { html: '<table><td>First</td></table>' } },
      { type: 'paragraph', content: { text: 'Separate discussion' } },
      { type: 'table', content: {} },
      { type: 'table', content: { html: '<table><td>Second</td></table>' } },
    ],
    [],
    [{ type: 'table', content: {} }],
  ]);

  assert.equal(blocks[2].contentSourceBlockId, undefined);
  assert.equal(blocks[4].contentSourceBlockId, undefined);
});
