import type {
  DocumentChatSession,
  PaperHistoryRecord,
  PdfReadingHeatmap,
  PdfScrollPosition,
  WorkspaceItem,
} from '../../types/reader';

export const READER_PDF_HISTORY_LIMIT = 8;

export function getReaderDocumentSignature(
  document: Pick<WorkspaceItem, 'workspaceId' | 'attachmentKey' | 'source' | 'localPdfPath'>,
): string {
  return JSON.stringify([document.workspaceId, document.attachmentKey ?? '',
    document.source === 'native-library' ? document.localPdfPath ?? '' : '']);
}

type ReaderPdfHistorySnapshot = Pick<
  PaperHistoryRecord,
  'pdfScrollPositions' | 'pdfReadingHeatmaps'
>;

export interface RestoredPaperQaHistory {
  qaSessions: DocumentChatSession[];
  selectedQaSessionId: string;
  selectedQaPresetId: string;
}

export function restorePaperQaHistory(
  history: PaperHistoryRecord | null | undefined,
  createSession: () => DocumentChatSession,
  fallbackPresetId: string,
): RestoredPaperQaHistory {
  const qaSessions = history?.qaSessions?.length
    ? history.qaSessions
    : [createSession()];
  const selectedQaSessionId =
    history?.selectedQaSessionId &&
    qaSessions.some((session) => session.id === history.selectedQaSessionId)
      ? history.selectedQaSessionId
      : qaSessions[0]?.id ?? '';

  return {
    qaSessions,
    selectedQaSessionId,
    selectedQaPresetId: history?.selectedQaPresetId?.trim() || fallbackPresetId,
  };
}

function normalizeLocalPathForCompare(path: string): string {
  return path.replace(/[/\\]/g, '/').trim().toLowerCase();
}

export function arePdfScrollPositionsEquivalent(
  existing: PdfScrollPosition,
  next: PdfScrollPosition,
): boolean {
  return (
    Math.abs(existing.top - next.top) < 1 &&
    Math.abs(existing.left - next.left) < 1 &&
    existing.page === next.page &&
    Math.abs(existing.pageOffsetTop - next.pageOffsetTop) < 1 &&
    Math.abs((existing.pageOffsetRatio ?? -1) - (next.pageOffsetRatio ?? -1)) < 0.00001 &&
    Math.abs((existing.pageHeight ?? 0) - (next.pageHeight ?? 0)) < 1
  );
}

function trimRecentRecords<T extends { updatedAt: number }>(
  records: Record<string, T>,
  limit: number,
): Record<string, T> {
  const next = { ...records };
  const keysByRecentUse = Object.keys(next).sort(
    (left, right) => (next[right]?.updatedAt ?? 0) - (next[left]?.updatedAt ?? 0),
  );

  for (const staleKey of keysByRecentUse.slice(Math.max(0, limit))) {
    delete next[staleKey];
  }

  return next;
}

export function upsertRecentPdfScrollPosition(
  current: Record<string, PdfScrollPosition>,
  position: PdfScrollPosition,
  limit = READER_PDF_HISTORY_LIMIT,
): Record<string, PdfScrollPosition> | null {
  if (!position.sourceKey) {
    return null;
  }

  const existing = current[position.sourceKey];

  if (existing && arePdfScrollPositionsEquivalent(existing, position)) {
    return null;
  }

  return trimRecentRecords(
    {
      ...current,
      [position.sourceKey]: position,
    },
    limit,
  );
}

export function shouldStorePdfReadingHeatmap(
  existing: PdfReadingHeatmap | undefined,
  next: PdfReadingHeatmap,
): boolean {
  return !existing || existing.updatedAt < next.updatedAt || existing.totalMs !== next.totalMs;
}

export function upsertRecentPdfReadingHeatmap(
  current: Record<string, PdfReadingHeatmap>,
  heatmap: PdfReadingHeatmap,
  limit = READER_PDF_HISTORY_LIMIT,
): Record<string, PdfReadingHeatmap> | null {
  if (!heatmap.sourceKey) {
    return null;
  }

  if (!shouldStorePdfReadingHeatmap(current[heatmap.sourceKey], heatmap)) {
    return null;
  }

  return trimRecentRecords(
    {
      ...current,
      [heatmap.sourceKey]: heatmap,
    },
    limit,
  );
}

export function restorePdfSourceHistory(
  history: ReaderPdfHistorySnapshot | null | undefined,
  sourceKey: string,
  now = Date.now(),
): ReaderPdfHistorySnapshot {
  const pdfScrollPositions = { ...(history?.pdfScrollPositions ?? {}) };
  const pdfReadingHeatmaps = { ...(history?.pdfReadingHeatmaps ?? {}) };

  if (sourceKey && !pdfScrollPositions[sourceKey]) {
    const recentPosition = Object.values(pdfScrollPositions).sort(
      (left, right) => right.updatedAt - left.updatedAt,
    )[0];

    if (recentPosition) {
      pdfScrollPositions[sourceKey] = {
        ...recentPosition,
        sourceKey,
        updatedAt: now,
      };
    }
  }

  return {
    pdfScrollPositions,
    pdfReadingHeatmaps,
  };
}

export function appendUniqueLocalPdfPath(
  targets: string[],
  nextPath: string | null | undefined,
): void {
  const normalizedPath = nextPath?.trim();

  if (!normalizedPath) {
    return;
  }

  const normalizedPathKey = normalizeLocalPathForCompare(normalizedPath);

  if (targets.some((candidate) => normalizeLocalPathForCompare(candidate) === normalizedPathKey)) {
    return;
  }

  targets.push(normalizedPath);
}

export function buildReaderLocalPdfPathCandidates(options: {
  historyLastPdfPath?: string | null;
  documentLocalPdfPath?: string | null;
  remotePdfDownloadPath?: string | null;
  cachedPdfPath?: string | null;
}): string[] {
  const candidates: string[] = [];

  appendUniqueLocalPdfPath(candidates, options.historyLastPdfPath);
  appendUniqueLocalPdfPath(candidates, options.documentLocalPdfPath);
  appendUniqueLocalPdfPath(candidates, options.remotePdfDownloadPath);
  appendUniqueLocalPdfPath(candidates, options.cachedPdfPath);

  return candidates;
}
