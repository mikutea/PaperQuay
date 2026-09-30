import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTextFromMineruBlock,
  flattenMineruPages,
  parseMineruPages,
} from '../src/services/mineru.ts';

test('parseMineruPages preserves numeric-keyed page dictionaries from merged MinerU output', () => {
  const pages = parseMineruPages([
    {
      '0': {
        type: 'title',
        content: { title_content: [{ type: 'text', content: 'Architecture Optimization' }] },
      },
      '1': {
        type: 'paragraph',
        content: { paragraph_content: [{ type: 'text', content: 'First page body.' }] },
      },
    },
    [{
      type: 'paragraph',
      content: { paragraph_content: [{ type: 'text', content: 'Second page body.' }] },
    }],
  ]);
  const blocks = flattenMineruPages(pages);

  assert.deepEqual(pages.map((page) => page.length), [2, 1]);
  assert.deepEqual(blocks.map((block) => extractTextFromMineruBlock(block)), [
    'Architecture Optimization',
    'First page body.',
    'Second page body.',
  ]);
});

test('parseMineruPages keeps ordinary flat content lists as flat blocks', () => {
  const blocks = flattenMineruPages(parseMineruPages([
    { type: 'text', text: 'Ordinary flat block' },
  ]));

  assert.equal(blocks.length, 1);
  assert.equal(extractTextFromMineruBlock(blocks[0]), 'Ordinary flat block');
});
