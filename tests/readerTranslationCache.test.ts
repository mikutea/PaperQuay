import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLegacyBatchTranslationBlockInputs,
  buildReaderTranslationBlockInputs,
  buildTranslationSourceMetadata,
  selectReusableCachedTranslations,
  selectReusableSessionTranslations,
} from '../src/features/reader/readerTranslationSource.ts';
import { flattenMineruPages } from '../src/services/mineru.ts';

const sourceBlocks = [
  { blockId: 'section-1', text: 'Visitors and residents share a rural square.' },
  { blockId: 'section-2', text: 'The model evaluates several governance scenarios.' },
];

test('source-bound translation cache is reusable only for the exact structured source', () => {
  const sourceMetadata = buildTranslationSourceMetadata(sourceBlocks);
  const cached = {
    ...sourceMetadata,
    translations: {
      'section-1': '游客与居民共享一个乡村广场。',
      'section-2': '该模型评估若干治理情景。',
    },
  };

  assert.deepEqual(selectReusableCachedTranslations(cached, sourceBlocks), cached.translations);
  assert.deepEqual(
    selectReusableCachedTranslations(cached, [
      sourceBlocks[0],
      { ...sourceBlocks[1], text: 'The model now evaluates a changed source.' },
    ]),
    {},
  );
});

test('source fingerprints normalize harmless whitespace but bind block IDs and text', () => {
  const normalized = buildTranslationSourceMetadata(sourceBlocks);
  const whitespaceVariant = buildTranslationSourceMetadata([
    { blockId: 'section-1', text: '  Visitors  and residents share a rural square.\r\n' },
    { blockId: 'section-2', text: 'The model evaluates several governance scenarios.  ' },
  ]);
  const changedBlockId = buildTranslationSourceMetadata([
    { ...sourceBlocks[0], blockId: 'section-renamed' },
    sourceBlocks[1],
  ]);

  assert.equal(whitespaceVariant.sourceFingerprint, normalized.sourceFingerprint);
  assert.notEqual(changedBlockId.sourceFingerprint, normalized.sourceFingerprint);
});

test('legacy cache remains readable data but is never trusted as a complete source-bound cache', () => {
  const reusable = selectReusableCachedTranslations(
    {
      legacySourceBinding: true,
      translations: {
        'section-1': '旧译文',
        'section-2': '旧译文',
      },
    },
    sourceBlocks,
  );

  assert.deepEqual(reusable, {});
});

test('English batch retry reuses session translations after a failed cache save only for the same source and target', () => {
  const snapshot = {
    ...buildTranslationSourceMetadata(sourceBlocks),
    targetLanguage: 'Chinese',
    translations: {
      'section-1': '游客与居民共享一个乡村广场。',
      'section-2': '该模型评估若干治理情景。',
    },
  };
  assert.deepEqual(selectReusableSessionTranslations(snapshot, sourceBlocks, 'Chinese'), snapshot.translations);
  assert.deepEqual(selectReusableSessionTranslations(snapshot, sourceBlocks, 'English'), {});
  assert.deepEqual(selectReusableSessionTranslations(snapshot, [
    sourceBlocks[0],
    { ...sourceBlocks[1], text: 'The model now evaluates a changed source.' },
  ], 'Chinese'), {});
});

test('reader restores source-bound translations saved by the older batch with continuation blocks', () => {
  const blocks = flattenMineruPages([
    [{ type: 'paragraph', content: { paragraph_content: 'The original paragraph.' } }],
    [
      { type: 'paragraph', content: { paragraph_content: [] }, bbox: [0, 0, 100, 100] },
      { type: 'paragraph', content: { paragraph_content: 'A second visible paragraph.' } },
    ],
  ]);
  const readerBlocks = buildReaderTranslationBlockInputs(blocks);
  const legacyBatchBlocks = buildLegacyBatchTranslationBlockInputs(blocks);
  const cached = {
    ...buildTranslationSourceMetadata(legacyBatchBlocks),
    targetLanguage: 'Chinese',
    translations: {
      'page-1-block-1': '原文段落。',
      'page-2-block-1': '附属续段。',
      'page-2-block-2': '第二个可见段落。',
    },
  };

  assert.equal(readerBlocks.length, 2);
  assert.equal(legacyBatchBlocks.length, 3);
  assert.equal(blocks[1].contentSourceBlockId, 'page-1-block-1');
  assert.deepEqual(selectReusableCachedTranslations(cached, readerBlocks), {});
  assert.deepEqual(
    selectReusableCachedTranslations(cached, readerBlocks, legacyBatchBlocks),
    {
      'page-1-block-1': '原文段落。',
      'page-2-block-2': '第二个可见段落。',
    },
  );
  assert.deepEqual(
    selectReusableSessionTranslations(cached, readerBlocks, 'Chinese', legacyBatchBlocks),
    {
      'page-1-block-1': '原文段落。',
      'page-2-block-2': '第二个可见段落。',
    },
  );
  assert.deepEqual(
    selectReusableSessionTranslations(cached, readerBlocks, 'English', legacyBatchBlocks),
    {},
  );

  const changedVisible = readerBlocks.map((block) =>
    block.blockId === 'page-2-block-2'
      ? { ...block, text: 'The source has changed.' }
      : block,
  );
  assert.deepEqual(
    selectReusableCachedTranslations(cached, changedVisible, legacyBatchBlocks),
    {},
  );
  assert.deepEqual(
    selectReusableCachedTranslations(cached, readerBlocks, [
      ...legacyBatchBlocks.slice(0, 1),
      { ...legacyBatchBlocks[1], text: 'A different continuation.' },
      ...legacyBatchBlocks.slice(2),
    ]),
    {},
  );
  assert.deepEqual(
    selectReusableCachedTranslations({ ...cached, legacySourceBinding: true }, readerBlocks, legacyBatchBlocks),
    {},
  );
});
