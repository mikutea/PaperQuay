import type {
  DocumentChatAttachment,
  DocumentChatMessage,
  DocumentChatSession,
  PaperAnnotation,
  PaperHistoryRecord,
  PdfReadingHeatmap,
  PdfScrollPosition,
} from '../types/reader';

import { normalizeBlockTextMarks } from '../features/blocks/blockTextMarks.ts';

const PAPER_HISTORY_STORAGE_KEY = 'paper-reader-paper-history-v1';
const PAPER_HISTORY_VERSION = 6;
const PDF_READING_HEATMAP_BIN_COUNT = 120;

export const PAPER_READING_HEATMAP_UPDATED_EVENT = 'paperquay:reading-heatmap-updated';

function stripAttachmentForHistory(
  attachment: DocumentChatAttachment,
): DocumentChatAttachment {
  return {
    ...attachment,
    dataUrl: undefined,
    textContent: undefined,
  };
}

function stripMessageForHistory(message: DocumentChatMessage): DocumentChatMessage {
  return {
    ...message,
    attachments: message.attachments?.map(stripAttachmentForHistory),
  };
}

function buildSessionTitle(messages: DocumentChatMessage[]): string {
  const firstUserMessage = messages.find(
    (message) => message.role === 'user' && message.content.trim(),
  );

  if (!firstUserMessage) {
    return 'New chat';
  }

  const normalizedContent = firstUserMessage.content.replace(/\s+/g, ' ').trim();

  return normalizedContent.length > 36
    ? `${normalizedContent.slice(0, 36)}...`
    : normalizedContent;
}

function stripSessionForHistory(session: DocumentChatSession): DocumentChatSession {
  const firstMessage = session.messages[0];
  const lastMessage = session.messages[session.messages.length - 1];

  return {
    ...session,
    title: session.title.trim() || buildSessionTitle(session.messages),
    createdAt: session.createdAt || firstMessage?.createdAt || Date.now(),
    updatedAt: lastMessage?.createdAt || session.createdAt || Date.now(),
    messages: session.messages.map(stripMessageForHistory),
  };
}

function buildLegacySession(
  record: Pick<PaperHistoryRecord, 'qaMessages' | 'selectedQaPresetId'>,
): DocumentChatSession | null {
  const messages = Array.isArray(record.qaMessages)
    ? record.qaMessages.map(stripMessageForHistory)
    : [];

  if (messages.length === 0) {
    return null;
  }

  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];

  return {
    id: `legacy-${firstMessage?.id || crypto.randomUUID()}`,
    title: buildSessionTitle(messages),
    createdAt: firstMessage?.createdAt || Date.now(),
    updatedAt: lastMessage?.createdAt || firstMessage?.createdAt || Date.now(),
    messages,
  };
}

function stripAnnotationForHistory(annotation: PaperAnnotation): PaperAnnotation {
  return {
    ...annotation,
    note: annotation.note.trim(),
    quote: annotation.quote?.trim(),
    updatedAt: annotation.updatedAt || annotation.createdAt || Date.now(),
  };
}

function normalizePdfScrollPositions(value: unknown): Record<string, PdfScrollPosition> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const positions: Record<string, PdfScrollPosition> = {};

  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const position = candidate as Partial<PdfScrollPosition>;
    const sourceKey =
      typeof position.sourceKey === 'string' && position.sourceKey.trim()
        ? position.sourceKey
        : key;

    if (
      !sourceKey ||
      typeof position.top !== 'number' ||
      !Number.isFinite(position.top) ||
      typeof position.left !== 'number' ||
      !Number.isFinite(position.left) ||
      typeof position.page !== 'number' ||
      !Number.isFinite(position.page) ||
      typeof position.pageOffsetTop !== 'number' ||
      !Number.isFinite(position.pageOffsetTop) ||
      typeof position.updatedAt !== 'number' ||
      !Number.isFinite(position.updatedAt)
    ) {
      continue;
    }

    const nextPosition: PdfScrollPosition = {
      sourceKey,
      top: Math.max(0, position.top),
      left: Math.max(0, position.left),
      page: Math.max(1, Math.round(position.page)),
      pageOffsetTop: Math.max(0, position.pageOffsetTop),
      updatedAt: position.updatedAt,
    };

    if (typeof position.pageOffsetRatio === 'number' && Number.isFinite(position.pageOffsetRatio)) {
      nextPosition.pageOffsetRatio = Math.min(1, Math.max(0, position.pageOffsetRatio));
    }

    if (typeof position.pageHeight === 'number' && Number.isFinite(position.pageHeight) && position.pageHeight > 0) {
      nextPosition.pageHeight = position.pageHeight;
    }

    positions[sourceKey] = nextPosition;
  }

  return Object.fromEntries(
    Object.entries(positions)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, 12),
  );
}

function normalizePdfReadingHeatmaps(value: unknown): Record<string, PdfReadingHeatmap> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const heatmaps: Record<string, PdfReadingHeatmap> = {};

  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const heatmap = candidate as Partial<PdfReadingHeatmap>;
    const sourceKey =
      typeof heatmap.sourceKey === 'string' && heatmap.sourceKey.trim()
        ? heatmap.sourceKey
        : key;
    const rawBins = Array.isArray(heatmap.bins) ? heatmap.bins : [];

    if (
      !sourceKey ||
      rawBins.length === 0 ||
      typeof heatmap.updatedAt !== 'number' ||
      !Number.isFinite(heatmap.updatedAt)
    ) {
      continue;
    }

    const bins = Array.from({ length: PDF_READING_HEATMAP_BIN_COUNT }, (_, index) => {
      const value = rawBins[index];

      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : 0;
    });
    const totalMs =
      typeof heatmap.totalMs === 'number' && Number.isFinite(heatmap.totalMs)
        ? Math.max(0, Math.round(heatmap.totalMs))
        : bins.reduce((sum, value) => sum + value, 0);

    heatmaps[sourceKey] = {
      sourceKey,
      bins,
      totalMs,
      updatedAt: heatmap.updatedAt,
    };
  }

  return Object.fromEntries(
    Object.entries(heatmaps)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, 12),
  );
}

function isRecordShape(value: unknown): value is PaperHistoryRecord {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as PaperHistoryRecord).workspaceId === 'string' &&
      typeof (value as PaperHistoryRecord).lastOpenedAt === 'number',
  );
}

export function loadPaperHistoryMap(): Record<string, PaperHistoryRecord> {
  try {
    const rawValue = localStorage.getItem(PAPER_HISTORY_STORAGE_KEY);

    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    const nextRecords: Record<string, PaperHistoryRecord> = {};

    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (!isRecordShape(value)) {
        continue;
      }

      const legacyReadingViewMode = (value as { readingViewMode?: unknown }).readingViewMode;
      const normalizedSessions = Array.isArray(value.qaSessions)
        ? value.qaSessions
            .filter(
              (session): session is DocumentChatSession =>
                Boolean(session && typeof session === 'object' && typeof session.id === 'string'),
            )
            .map(stripSessionForHistory)
        : [];
      const legacySession = buildLegacySession(value);
      const qaSessions =
        normalizedSessions.length > 0
          ? normalizedSessions
          : legacySession
            ? [legacySession]
            : [];
      const selectedQaSessionId =
        typeof value.selectedQaSessionId === 'string' &&
        qaSessions.some((session) => session.id === value.selectedQaSessionId)
          ? value.selectedQaSessionId
          : qaSessions[0]?.id ?? null;
      const workspaceNoteMarkdown =
        typeof value.workspaceNoteMarkdown === 'string' ? value.workspaceNoteMarkdown : '';
      const annotations = Array.isArray(value.annotations)
        ? value.annotations
            .filter(
              (annotation): annotation is PaperAnnotation =>
                Boolean(
                  annotation &&
                    typeof annotation === 'object' &&
                    typeof (annotation as PaperAnnotation).id === 'string' &&
                    typeof (annotation as PaperAnnotation).blockId === 'string',
                ),
            )
            .map(stripAnnotationForHistory)
        : [];

      nextRecords[workspaceId] = {
        ...value,
        version: PAPER_HISTORY_VERSION,
        readingViewMode:
          legacyReadingViewMode === 'pdf-only' || legacyReadingViewMode === 'pdf-annotate'
            ? 'pdf-only'
            : 'dual-pane',
        selectedQaSessionId,
        pdfScrollPositions: normalizePdfScrollPositions(
          (value as { pdfScrollPositions?: unknown }).pdfScrollPositions,
        ),
        pdfReadingHeatmaps: normalizePdfReadingHeatmaps(
          (value as { pdfReadingHeatmaps?: unknown }).pdfReadingHeatmaps,
        ),
        workspaceNoteMarkdown,
        annotations,
        blockTextMarks: normalizeBlockTextMarks(value.blockTextMarks),
        qaSessions,
        qaMessages: undefined,
      };
    }

    return nextRecords;
  } catch {
    return {};
  }
}

export function loadPaperHistory(workspaceId: string): PaperHistoryRecord | null {
  return loadPaperHistoryMap()[workspaceId] ?? null;
}

export function savePaperHistory(record: PaperHistoryRecord): PaperHistoryRecord {
  const currentMap = loadPaperHistoryMap();
  const normalizedSessions = record.qaSessions.map(stripSessionForHistory);
  const normalizedAnnotations = record.annotations.map(stripAnnotationForHistory);
  const selectedQaSessionId =
    record.selectedQaSessionId &&
    normalizedSessions.some((session) => session.id === record.selectedQaSessionId)
      ? record.selectedQaSessionId
      : normalizedSessions[0]?.id ?? null;
  const sanitizedRecord: PaperHistoryRecord = {
    ...record,
    version: PAPER_HISTORY_VERSION,
    selectedQaSessionId,
    pdfScrollPositions: normalizePdfScrollPositions(record.pdfScrollPositions),
    pdfReadingHeatmaps: normalizePdfReadingHeatmaps(record.pdfReadingHeatmaps),
    workspaceNoteMarkdown: record.workspaceNoteMarkdown,
    annotations: normalizedAnnotations,
    blockTextMarks: normalizeBlockTextMarks(record.blockTextMarks),
    qaSessions: normalizedSessions,
    qaMessages: undefined,
  };

  currentMap[record.workspaceId] = sanitizedRecord;
  localStorage.setItem(PAPER_HISTORY_STORAGE_KEY, JSON.stringify(currentMap));

  return sanitizedRecord;
}

export function removePaperHistory(workspaceId: string): void {
  const currentMap = loadPaperHistoryMap();

  if (!(workspaceId in currentMap)) {
    return;
  }

  delete currentMap[workspaceId];
  localStorage.setItem(PAPER_HISTORY_STORAGE_KEY, JSON.stringify(currentMap));
}
