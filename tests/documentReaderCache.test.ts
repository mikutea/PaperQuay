import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isMatchingSummaryCacheEnvelope,
  loadSavedMineruPages,
  loadSavedSummaryCache,
  resolveSavedPdfPath,
  resolveCachedMineruSourcePath,
} from '../src/features/reader/documentReaderCache.ts';
import { parseMineruMarkdownPages } from '../src/services/mineru.ts';
import type { PaperSummary, PdfSource, WorkspaceItem } from '../src/types/reader.ts';

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

function summary(overrides: Partial<PaperSummary> = {}): PaperSummary {
  return {
    title: overrides.title ?? 'Paper Title',
    abstract: overrides.abstract ?? 'Abstract',
    overview: overrides.overview ?? 'Overview',
    background: overrides.background ?? 'Background',
    researchProblem: overrides.researchProblem ?? 'Problem',
    approach: overrides.approach ?? 'Approach',
    experimentSetup: overrides.experimentSetup ?? 'Experiment',
    keyFindings: overrides.keyFindings ?? ['Finding'],
    conclusions: overrides.conclusions ?? 'Conclusion',
    limitations: overrides.limitations ?? 'Limitation',
    takeaways: overrides.takeaways ?? ['Takeaway'],
    keywords: overrides.keywords ?? ['keyword'],
  };
}

const zh = (value: string) => value;
const parsePages = (payload: string | unknown) => JSON.parse(String(payload));

test('isMatchingSummaryCacheEnvelope requires matching source keys and a summary', () => {
  assert.equal(
    isMatchingSummaryCacheEnvelope({ sourceKey: 'source-1', summary: summary() }, 'source-1'),
    true,
  );
  assert.equal(
    isMatchingSummaryCacheEnvelope({ sourceKey: 'source-2', summary: summary() }, 'source-1'),
    false,
  );
  assert.equal(isMatchingSummaryCacheEnvelope({ sourceKey: 'source-1' }, 'source-1'), false);
});

test('loadSavedSummaryCache skips stale or malformed cache candidates', async () => {
  const saved = summary({ title: 'Cached Summary' });
  const reads: string[] = [];
  const loaded = await loadSavedSummaryCache({
    item: item(),
    mineruCacheDir: 'D:/cache',
    sourceKey: 'source-1',
    readText: async (path) => {
      reads.push(path);
      if (reads.length === 1) return JSON.stringify({ sourceKey: 'other', summary: summary() });
      if (reads.length === 2) return JSON.stringify({ sourceKey: 'source-1', summary: saved });
      return null;
    },
  });

  assert.deepEqual(loaded, saved);
  assert.equal(reads.length, 2);
});

test('loadSavedMineruPages restores the first readable MinerU JSON cache', async () => {
  const reads: string[] = [];
  const loaded = await loadSavedMineruPages({
    item: item({ title: 'Cached Paper' }),
    mineruCacheDir: 'D:/cache',
    l: zh,
    parsePages,
    readText: async (path) => {
      reads.push(path);
      return reads.length === 1
        ? JSON.stringify([[{ type: 'paragraph', content: 'cached text' }]])
        : null;
    },
  });

  assert.equal(loaded?.pages.length, 1);
  assert.equal(loaded?.pages[0]?.[0]?.type, 'paragraph');
  assert.match(loaded?.message ?? '', /本地缓存/);
  assert.equal(reads.length, 2);
});

test('local MinerU cache provenance keeps image resolution next to the original output', async () => {
  for (const sourcePath of ['D:/papers/output/content_list.json', '/papers/full.md', '\\\\server\\share\\output\\middle.json']) {
    const result = await resolveCachedMineruSourcePath({
      item: item(), cachedPath: 'D:/cache/document-1/content_list_v2.json', cachedText: '[]',
      manifestPath: 'manifest.json',
      readText: async (path) => path === sourcePath ? '[]' : JSON.stringify({
        documentKey: 'item-1', pdfPath: 'D:/papers/paper.pdf', sourceKind: 'manual-json', sourcePath,
      }),
    });
    assert.equal(result, sourcePath);
  }
});

test('cache provenance cannot redirect an older artifact to a newer source directory', async () => {
  const cachedText = '[[{"type":"image","content":{"img_path":"old.png"}}]]';
  const cachedPath = 'D:/cache/document-1/content_list_v2.json';
  for (const sourceText of ['new Markdown', '[[{"type":"paragraph","content":"new"}]]', null]) {
    const result = await resolveCachedMineruSourcePath({
      item: item(), cachedPath, cachedText, manifestPath: 'manifest.json',
      readText: async (path) => path === 'manifest.json' ? JSON.stringify({
        documentKey: 'item-1', pdfPath: 'D:/papers/paper.pdf', sourceKind: 'manual-json',
        sourcePath: 'D:/new-output/full.md',
      }) : sourceText,
    });
    assert.equal(result, cachedPath);
  }
});

test('cache provenance ignores foreign, cloud, malformed and non-local sources', async () => {
  const cachedPath = 'D:/cache/document-1/content_list_v2.json';
  for (const overrides of [
    { documentKey: 'other' }, { sourceKind: 'cloud' }, { sourceKind: 'unknown' },
    { sourcePath: 'https://example.test/content_list.json' }, { sourcePath: 'relative/content_list.json' },
    { sourcePath: 'D:/papers/../secret.json' }, { sourcePath: 42 },
  ]) {
    assert.equal(await resolveCachedMineruSourcePath({
      item: item(), cachedPath, cachedText: '[]', manifestPath: 'manifest.json',
      readText: async () => JSON.stringify({
        documentKey: 'item-1', pdfPath: 'D:/papers/paper.pdf', sourceKind: 'manual-json',
        sourcePath: 'D:/papers/content_list.json', ...overrides,
      }),
    }), cachedPath);
  }
  assert.equal(await resolveCachedMineruSourcePath({
    item: item(), cachedPath, cachedText: '[]', manifestPath: 'manifest.json', readText: async () => '{',
  }), cachedPath);
});

test('legacy sibling provenance is recovered only from matching local content', async () => {
  const cachedPath = 'D:/cache/document-1/content_list_v2.json';
  for (const matches of [true, false]) {
    const result = await resolveCachedMineruSourcePath({
      item: item({ localPdfPath: 'D:/papers/paper.pdf' }), cachedPath, cachedText: '[{"type":"image"}]',
      manifestPath: 'manifest.json',
      readText: async (path) => path === 'manifest.json' ? JSON.stringify({
        documentKey: 'item-1', pdfPath: 'D:/papers/paper.pdf', sourceKind: 'sibling-json',
      }) : path === 'D:/papers/content_list.json' && matches ? '[{"type":"image"}]' : null,
    });
    assert.equal(result, matches ? 'D:/papers/content_list.json' : cachedPath);
  }
});

test('loadSavedMineruPages checks content_list JSON inside document cache folders only', async () => {
  const reads: string[] = [];
  const loaded = await loadSavedMineruPages({
    item: item({ title: 'Cached Paper' }),
    mineruCacheDir: 'D:/cache',
    l: zh,
    parsePages,
    readText: async (path) => {
      reads.push(path);
      return path.endsWith('/content_list.json') && path.includes('/document-')
        ? JSON.stringify([[{ type: 'paragraph', content: 'content list text' }]])
        : null;
    },
  });

  assert.equal(loaded?.pages[0]?.[0]?.content, 'content list text');
  assert.equal(reads.includes('D:/cache/content_list_v2.json'), false);
  assert.equal(reads.includes('D:/cache/content_list.json'), false);
  assert.match(reads[0] ?? '', /D:\/cache\/document-/);
  assert.equal(reads.some((path) => path.endsWith('/content_list.json')), true);
});

test('loadSavedMineruPages can fall back to cached MinerU Markdown blocks', async () => {
  const reads: string[] = [];
  const loaded = await loadSavedMineruPages({
    item: item({ title: 'Markdown Paper' }),
    mineruCacheDir: 'D:/cache',
    l: zh,
    parsePages,
    parseMarkdownPages: parseMineruMarkdownPages,
    readText: async (path) => {
      reads.push(path);
      return path.endsWith('/full.md') && path.includes('/document-')
        ? '# Method\n\nThe method uses $x_i$.\n\n- Step one'
        : null;
    },
  });

  assert.equal(loaded?.pages.length, 1);
  assert.equal(loaded?.pages[0]?.[0]?.type, 'title');
  assert.equal(loaded?.pages[0]?.[1]?.type, 'paragraph');
  assert.equal(loaded?.pages[0]?.[2]?.type, 'list');
  assert.match(loaded?.message ?? '', /MinerU Markdown/);
  assert.equal(reads.includes('D:/cache/full.md'), false);
});

test('resolveSavedPdfPath returns the first manifest path that still loads as a PDF', async () => {
  const loadAttempts: string[] = [];
  const resolved = await resolveSavedPdfPath({
    item: item(),
    mineruCacheDir: 'D:/cache',
    readText: async () =>
      JSON.stringify({
        version: 1,
        documentKey: 'item-1',
        title: 'Paper Title',
        pdfPath: 'D:/papers/cached.pdf',
        savedAt: new Date(0).toISOString(),
        sourceKind: 'manual-json',
      }),
    loadPdf: async (source: PdfSource) => {
      if (source?.kind === 'local-path') {
        loadAttempts.push(source.path);
      }

      return new Uint8Array([1]);
    },
  });

  assert.equal(resolved, 'D:/papers/cached.pdf');
  assert.deepEqual(loadAttempts, ['D:/papers/cached.pdf']);
});

test('resolveSavedPdfPath ignores invalid manifests and unreadable PDFs', async () => {
  const resolved = await resolveSavedPdfPath({
    item: item(),
    mineruCacheDir: 'D:/cache',
    readText: async () =>
      JSON.stringify({
        version: 1,
        documentKey: 'item-1',
        title: 'Paper Title',
        pdfPath: 'D:/papers/missing.pdf',
        savedAt: new Date(0).toISOString(),
        sourceKind: 'manual-json',
      }),
    loadPdf: async () => {
      throw new Error('missing file');
    },
  });

  assert.equal(resolved, null);
});
