/** Pure saved-note exchange adapter. No desktop stores, renderer IPC, image
 * fetches or filesystem reads are allowed in this bundle. Supported desktop
 * TipTap JSON is converted with explicit byte evidence; unsupported structures
 * are reported and never replaced by derived text/HTML. */
import { cloneDesktopRichSource, projectDesktopLibrary,
  type DesktopProjectionInput, type DesktopProjectionSkip } from '../../packages/sync-core/src/desktopProjection.ts';
import type { VisibleEntity } from '../../packages/sync-core/src/types.ts';
import { exportLibraryArchive, parseLibraryArchive,
  type LibraryDesktopExportReport } from '../../apps/mobile/src/library/libraryTransfer.ts';

export const DESKTOP_NOTE_EXPORT_LIMITS = Object.freeze({ notes: 500, rawCharacters: 16 * 1024 * 1024, captureBytes: 64 * 1024 * 1024 });
const NOTE_FIELDS = ['id', 'paperId', 'type', 'title', 'format', 'body', 'contentJson', 'anchors', 'tags', 'color', 'isFavorite',
  'isPinned', 'linkedNoteIds', 'linkedPaperIds', 'linkedPaperId', 'folderId', 'aiChatId', 'aiChatMessageIds',
  'createdAt', 'updatedAt', 'deletedAt', 'excerpt', 'pdfLocation', 'unresolvedReferences'] as const;
const PAPER_FIELDS = ['id', 'title', 'doi', 'year', 'publication', 'abstractText', 'authors', 'keywords'] as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function pick(value: unknown, fields: readonly string[]): unknown {
  if (!record(value)) return null;
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor) continue;
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('INVALID_SAVED_SOURCE');
    if (descriptor.value !== undefined) selected[field] = descriptor.value;
  }
  return cloneDesktopRichSource(selected, DESKTOP_NOTE_EXPORT_LIMITS.rawCharacters);
}
/** Full saved truth used by the exporter fence. Derived HTML/text and backlink
 * caches are deliberately excluded; they are never an export fallback. */
export function snapshotDesktopSavedNote(value: unknown): unknown { return pick(value, NOTE_FIELDS); }
export function snapshotDesktopBibliography(value: unknown): unknown { return pick(value, PAPER_FIELDS); }

export function inspectDesktopSavedNote(value: unknown): { imageSources: string[]; paperIds: string[] } {
  const raw = snapshotDesktopSavedNote(value), sources = new Set<string>(), papers = new Set<string>();
  const paper = (id: unknown) => { if (typeof id === 'string' && id !== 'global-notes') papers.add(id.replace(/^native-library:/, '')); };
  if (record(raw)) {
    paper(raw.paperId); paper(raw.linkedPaperId);
    if (Array.isArray(raw.linkedPaperIds)) raw.linkedPaperIds.forEach(paper);
    if (Array.isArray(raw.anchors)) for (const anchor of raw.anchors) if (record(anchor)) paper(anchor.paperId);
    const walk = (node: unknown): void => {
      if (!record(node)) return;
      if (record(node.attrs)) {
        if (node.type === 'image' && typeof node.attrs.src === 'string') sources.add(node.attrs.src);
        if (node.type === 'paperReference') paper(node.attrs.paperId);
      }
      if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(raw.contentJson);
  }
  return { imageSources: [...sources], paperIds: [...papers] };
}

export function createPortableRichNoteArchive(input: DesktopProjectionInput,
  options: { skippedNotes?: Readonly<Record<number, string>> } = {}) {
  const originalNotes = input.notes ?? [];
  if (originalNotes.length < 1 || originalNotes.length > DESKTOP_NOTE_EXPORT_LIMITS.notes) throw new Error('INVALID_NOTE_SELECTION');
  const skippedNotes = options.skippedNotes ?? {};
  // A resource failure removes the entire note before graph resolution, so
  // another exported note cannot retain an active reference to a skipped one.
  const hasSkip = (index: number) => Object.prototype.hasOwnProperty.call(skippedNotes, index);
  const notes = originalNotes.map((value, index) => hasSkip(index) ? null : value);
  const projected = projectDesktopLibrary({ ...input, notes }, () => { throw new Error('MISSING_EXPORT_ALIAS'); });
  const skipped: DesktopProjectionSkip[] = projected.skipped.map((entry) => entry.entityType === 'note' && hasSkip(entry.index)
    ? { ...entry, code: skippedNotes[entry.index] } : entry);
  const exportedNotes = projected.entities.filter((entry) => entry.entityType === 'note');
  const usedPapers = new Set<string>();
  for (const entry of exportedNotes) if (entry.entityType === 'note') {
    if (entry.data.paperId) usedPapers.add(entry.data.paperId);
    if (entry.data.format === 'tiptap-json') {
      entry.data.metadata.linkedPaperIds.forEach(id => usedPapers.add(id));
      if (entry.data.metadata.linkedPaperId) usedPapers.add(entry.data.metadata.linkedPaperId);
      entry.data.metadata.anchors.forEach(anchor => { if (anchor.paperId) usedPapers.add(anchor.paperId); });
    }
  }
  const entities = projected.entities.filter((entry) => entry.entityType === 'note' || entry.entityType === 'paper' && usedPapers.has(entry.entityId));
  const aliases: LibraryDesktopExportReport['aliases'] = [];
  for (const [key, sourceId] of Object.entries(projected.identityMap.aliases)) {
    const [kind, originalId] = JSON.parse(key) as [string, string];
    if ((kind === 'paper' || kind === 'note') && entities.some((entry) => entry.entityType === kind && entry.entityId === sourceId))
      aliases.push({ entityType: kind, sourceId, originalId });
  }
  aliases.sort((a, b) => a.entityType.localeCompare(b.entityType) || a.sourceId.localeCompare(b.sourceId));
  const report: LibraryDesktopExportReport = { source: 'desktop-saved-notes', sourceIds: 'export-only-aliases', scope: 'selected-saved-notes',
    requestedNotes: originalNotes.length, skipped: skipped.map(({ entityType, index, code }) => {
      if (entityType !== 'paper' && entityType !== 'note') throw new Error('UNEXPECTED_EXPORT_ENTITY');
      return { entityType, index, code };
    }), aliases };
  const visible: VisibleEntity[] = entities.map((entry) => ({ ...entry, revision: 0, deleted: false, pending: true, status: 'overlay' }));
  const exported = exportLibraryArchive(visible, { version: 2, exportReport: report });
  // Keep the generated main-process bundle and the actual mobile importer on
  // the same serialized boundary, including metadata-only diagnostic reports.
  parseLibraryArchive(exported.json);
  return { ...exported, skipped: report.skipped };
}
