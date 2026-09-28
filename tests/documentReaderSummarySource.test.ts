import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPaperSummarySourceKey,
  loadMineruMarkdownDocument,
  resolveMineruMarkdownCandidatePaths,
} from '../src/features/reader/documentReaderSummarySource.ts';
import type { PositionedMineruBlock, WorkspaceItem } from '../src/types/reader.ts';

function item(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    itemKey: overrides.itemKey ?? 'item-1',
    title: overrides.title ?? 'Paper Title',
    creators: overrides.creators ?? 'Author',
    year: overrides.year ?? '2026',
    itemType: overrides.itemType ?? 'journalArticle',
    source: overrides.source ?? 'native-library',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    groupKey: overrides.groupKey ?? 'group-1',
    ...overrides,
  };
}

function block(overrides: Partial<PositionedMineruBlock> = {}): PositionedMineruBlock {
  return {
    type: overrides.type ?? 'paragraph',
    content: overrides.content ?? 'text',
    blockId: overrides.blockId ?? 'page-1-block-1',
    pageIndex: overrides.pageIndex ?? 0,
    blockIndex: overrides.blockIndex ?? 0,
    ...overrides,
  };
}

const zh = (value: string) => value;

test('buildPaperSummarySourceKey distinguishes pdf text and MinerU markdown sources', () => {
  assert.equal(
    buildPaperSummarySourceKey({
      item: item({ itemKey: 'paper-1' }),
      promptVersion: 'prompt-v1',
      summaryLanguage: 'Chinese',
      summarySourceMode: 'pdf-text',
      pdfSource: { kind: 'local-path', path: 'D:/papers/paper.pdf' },
      pdfPath: '',
      currentPdfName: 'paper.pdf',
      mineruPath: '',
      currentJsonName: 'content_list_v2.json',
      blockCount: 0,
    }),
    'paper-1::prompt-v1::Chinese::pdf-text::local:D:/papers/paper.pdf',
  );

  assert.equal(
    buildPaperSummarySourceKey({
      item: item({ itemKey: 'paper-1' }),
      promptVersion: 'prompt-v1',
      summaryLanguage: 'English',
      summarySourceMode: 'mineru-markdown',
      pdfSource: null,
      pdfPath: '',
      currentPdfName: 'paper.pdf',
      mineruPath: 'D:/cache/content_list_v2.json',
      currentJsonName: 'content_list_v2.json',
      blockCount: 12,
    }),
    'paper-1::prompt-v1-visual-v2::English::mineru-markdown::D:/cache/content_list_v2.json::12',
  );
});

test('buildPaperSummarySourceKey returns empty when the selected source is unavailable', () => {
  assert.equal(
    buildPaperSummarySourceKey({
      item: item(),
      promptVersion: 'prompt-v1',
      summaryLanguage: 'Chinese',
      summarySourceMode: 'pdf-text',
      pdfSource: null,
      pdfPath: '',
      currentPdfName: '',
      mineruPath: '',
      currentJsonName: '',
      blockCount: 0,
    }),
    '',
  );
});

test('resolveMineruMarkdownCandidatePaths includes sibling markdown before cache paths', () => {
  const paths = resolveMineruMarkdownCandidatePaths({
    item: item(),
    mineruCacheDir: 'D:/cache',
    mineruPath: 'D:/papers/content_list_v2.json',
  });

  assert.equal(paths[0], 'D:/papers/full.md');
  assert.match(paths[1] ?? '', /D:\/cache[\\/]document-/);
});

test('loadMineruMarkdownDocument returns the first non-empty cached markdown', async () => {
  const reads: string[] = [];
  const markdown = await loadMineruMarkdownDocument({
    item: item(),
    flatBlocks: [block()],
    mineruPath: 'D:/papers/content_list_v2.json',
    mineruCacheDir: 'D:/cache',
    readText: async (path) => {
      reads.push(path);
      return reads.length === 1 ? '' : '# cached markdown';
    },
    buildFallbackMarkdown: () => '# fallback markdown',
    l: zh,
  });

  assert.equal(markdown, '# cached markdown');
  assert.equal(reads.length, 2);
});

test('loadMineruMarkdownDocument falls back to rendered blocks and reports empty sources', async () => {
  const fallback = await loadMineruMarkdownDocument({
    item: item(),
    flatBlocks: [block()],
    mineruPath: '',
    mineruCacheDir: '',
    readText: async () => null,
    buildFallbackMarkdown: () => '# fallback markdown',
    l: zh,
  });

  assert.equal(fallback, '# fallback markdown');

  await assert.rejects(
    () =>
      loadMineruMarkdownDocument({
        item: item(),
        flatBlocks: [],
        mineruPath: '',
        mineruCacheDir: '',
        readText: async () => null,
        buildFallbackMarkdown: () => '',
        l: zh,
      }),
    /MinerU/,
  );
});
