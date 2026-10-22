import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arePdfScrollPositionsEquivalent,
  buildReaderLocalPdfPathCandidates,
  getReaderDocumentSignature,
  restorePaperQaHistory,
  restorePdfSourceHistory,
  shouldStorePdfReadingHeatmap,
  upsertRecentPdfReadingHeatmap,
  upsertRecentPdfScrollPosition,
} from '../src/features/reader/documentReaderHistory.ts';
import { aggregateReadingTimeChartBins } from '../src/features/literature/readingTimeChartUtils.ts';
import type { PdfReadingHeatmap, PdfScrollPosition } from '../src/types/reader.ts';
import type { DocumentChatSession, PaperHistoryRecord } from '../src/types/reader.ts';

function scrollPosition(overrides: Partial<PdfScrollPosition> = {}): PdfScrollPosition {
  return {
    sourceKey: overrides.sourceKey ?? 'source-1',
    top: overrides.top ?? 100,
    left: overrides.left ?? 0,
    page: overrides.page ?? 2,
    pageOffsetTop: overrides.pageOffsetTop ?? 40,
    updatedAt: overrides.updatedAt ?? 10,
    ...overrides,
  };
}

test('reader reopens a native paper when its missing PDF is attached or replaced', () => {
  const native = { workspaceId: 'native-library:paper-1', source: 'native-library' as const };
  const missing = getReaderDocumentSignature(native);
  const attached = getReaderDocumentSignature({ ...native, localPdfPath: 'D:/papers/first.pdf' });
  const replaced = getReaderDocumentSignature({ ...native, localPdfPath: 'D:/papers/replacement.pdf' });
  assert.notEqual(missing, attached);
  assert.notEqual(attached, replaced);
  const zotero = { workspaceId: 'zotero:paper-1', source: 'zotero' as const, attachmentKey: 'ATTACHMENT' };
  assert.equal(getReaderDocumentSignature(zotero), getReaderDocumentSignature({ ...zotero, localPdfPath: 'D:/download.pdf' }));
});

function heatmap(overrides: Partial<PdfReadingHeatmap> = {}): PdfReadingHeatmap {
  return {
    sourceKey: overrides.sourceKey ?? 'source-1',
    bins: overrides.bins ?? [1, 2, 3],
    totalMs: overrides.totalMs ?? 60,
    updatedAt: overrides.updatedAt ?? 10,
    ...overrides,
  };
}

test('arePdfScrollPositionsEquivalent ignores tiny scroll jitter', () => {
  const existing = scrollPosition({
    top: 100,
    left: 20,
    pageOffsetTop: 50,
    pageOffsetRatio: 0.5,
    pageHeight: 800,
  });
  const next = scrollPosition({
    top: 100.5,
    left: 20.5,
    pageOffsetTop: 50.5,
    pageOffsetRatio: 0.500001,
    pageHeight: 800.5,
  });

  assert.equal(arePdfScrollPositionsEquivalent(existing, next), true);
  assert.equal(
    arePdfScrollPositionsEquivalent(existing, scrollPosition({ ...next, page: 3 })),
    false,
  );
});

test('upsertRecentPdfScrollPosition stores meaningful changes and trims stale records', () => {
  const current = Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [
      `source-${index}`,
      scrollPosition({ sourceKey: `source-${index}`, updatedAt: index }),
    ]),
  );
  const next = upsertRecentPdfScrollPosition(
    current,
    scrollPosition({ sourceKey: 'source-new', updatedAt: 100 }),
    3,
  );

  assert.deepEqual(Object.keys(next ?? {}).sort(), ['source-2', 'source-3', 'source-new']);
  assert.equal(upsertRecentPdfScrollPosition(next ?? {}, scrollPosition({ sourceKey: '' })), null);
  assert.equal(
    upsertRecentPdfScrollPosition(
      { same: scrollPosition({ sourceKey: 'same', top: 10 }) },
      scrollPosition({ sourceKey: 'same', top: 10.5 }),
    ),
    null,
  );
});

test('upsertRecentPdfReadingHeatmap stores newer activity and skips stale duplicates', () => {
  const existing = heatmap({ sourceKey: 'same', totalMs: 100, updatedAt: 20 });

  assert.equal(
    shouldStorePdfReadingHeatmap(existing, heatmap({ sourceKey: 'same', totalMs: 100, updatedAt: 10 })),
    false,
  );
  assert.equal(
    shouldStorePdfReadingHeatmap(existing, heatmap({ sourceKey: 'same', totalMs: 120, updatedAt: 10 })),
    true,
  );

  const next = upsertRecentPdfReadingHeatmap(
    {
      older: heatmap({ sourceKey: 'older', updatedAt: 1 }),
      newer: heatmap({ sourceKey: 'newer', updatedAt: 5 }),
    },
    heatmap({ sourceKey: 'fresh', updatedAt: 9 }),
    2,
  );

  assert.deepEqual(Object.keys(next ?? {}).sort(), ['fresh', 'newer']);
  assert.equal(upsertRecentPdfReadingHeatmap(next ?? {}, heatmap({ sourceKey: '' })), null);
});

test('aggregateReadingTimeChartBins compresses reading heatmap into chart buckets', () => {
  const bins = Array.from({ length: 120 }, (_, index) => index + 1);
  const chartBins = aggregateReadingTimeChartBins(heatmap({ bins }));

  assert.equal(chartBins.length, 24);
  assert.equal(chartBins[0], 15);
  assert.equal(chartBins[23], 590);
  assert.deepEqual(aggregateReadingTimeChartBins(null), Array.from({ length: 24 }, () => 0));
});

test('restorePdfSourceHistory clones recent scroll position for a new source key', () => {
  const restored = restorePdfSourceHistory(
    {
      pdfScrollPositions: {
        older: scrollPosition({ sourceKey: 'older', top: 10, updatedAt: 1 }),
        recent: scrollPosition({ sourceKey: 'recent', top: 50, updatedAt: 5 }),
      },
      pdfReadingHeatmaps: {
        recent: heatmap({ sourceKey: 'recent' }),
      },
    },
    'new-source',
    99,
  );

  assert.deepEqual(restored.pdfScrollPositions['new-source'], {
    ...scrollPosition({ sourceKey: 'recent', top: 50, updatedAt: 5 }),
    sourceKey: 'new-source',
    updatedAt: 99,
  });
  assert.equal(restored.pdfReadingHeatmaps.recent.sourceKey, 'recent');
});

test('buildReaderLocalPdfPathCandidates preserves priority and removes path duplicates', () => {
  const candidates = buildReaderLocalPdfPathCandidates({
    historyLastPdfPath: ' D:/papers/history.pdf ',
    documentLocalPdfPath: 'D:\\papers\\history.pdf',
    remotePdfDownloadPath: 'D:/papers/downloaded.pdf',
    cachedPdfPath: '',
  });

  assert.deepEqual(candidates, ['D:/papers/history.pdf', 'D:/papers/downloaded.pdf']);
});

test('restorePaperQaHistory restores saved sessions and selection instead of creating a blank chat', () => {
  const savedSession: DocumentChatSession = {
    id: 'saved-session',
    title: 'Saved conversation',
    createdAt: 10,
    updatedAt: 20,
    messages: [{ id: 'message-1', role: 'user', content: 'What is the method?', createdAt: 10 }],
  };
  const history = {
    qaSessions: [savedSession],
    selectedQaSessionId: savedSession.id,
    selectedQaPresetId: 'qa-preset-saved',
  } as PaperHistoryRecord;
  let createdCount = 0;

  const restored = restorePaperQaHistory(
    history,
    () => {
      createdCount += 1;
      return { ...savedSession, id: 'new-session', messages: [] };
    },
    'qa-preset-default',
  );

  assert.equal(createdCount, 0);
  assert.equal(restored.qaSessions, history.qaSessions);
  assert.equal(restored.selectedQaSessionId, 'saved-session');
  assert.equal(restored.selectedQaPresetId, 'qa-preset-saved');
});

test('restorePaperQaHistory creates one session only when no saved conversation exists', () => {
  const initialSession: DocumentChatSession = {
    id: 'new-session',
    title: 'New chat',
    createdAt: 10,
    updatedAt: 10,
    messages: [],
  };

  const restored = restorePaperQaHistory(null, () => initialSession, 'qa-preset-default');

  assert.deepEqual(restored.qaSessions, [initialSession]);
  assert.equal(restored.selectedQaSessionId, initialSession.id);
  assert.equal(restored.selectedQaPresetId, 'qa-preset-default');
});
