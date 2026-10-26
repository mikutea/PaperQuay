import type {
  AnnotationAnchor,
  AttachmentVersionData,
  PdfQuad,
  VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import type { AccountScope } from '../storage/accountStore.ts';
import type { WorkspaceController } from '../sync/workspace.ts';

export interface PdfAiContext {
  paperId: string;
  attachmentVersionId: string;
  sha256: string;
  scope: 'selection' | 'page' | 'document';
  totalPages: number;
  pages: { pageIndex: number; text: string; anchor?: AnnotationAnchor }[];
  /** True only when every page in the explicitly selected scope was extracted. */
  complete: boolean;
  label: string;
}

export interface PdfCitationTarget {
  requestId: string;
  attachmentVersionId: string;
  sha256: string;
  pageIndex: number;
  quads?: PdfQuad[];
}

export interface PaperReaderProps {
  scope: AccountScope;
  paper: VisibleEntity;
  attachmentVersions: VisibleEntity[];
  annotations: VisibleEntity[];
  positions: VisibleEntity[];
  controller: Pick<WorkspaceController, 'save' | 'getSnapshot'>;
  onBack: () => void;
  onAskAi?: (context: PdfAiContext) => void;
  jumpTo?: PdfCitationTarget;
  onDirtyChange?: (dirty: boolean) => void;
  onContextInvalidated?: () => void;
}

export interface PdfVersion {
  entityId: string;
  data: AttachmentVersionData;
}

export interface PdfCacheEntry {
  versionId: string;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  pageCount: number;
  pinned: boolean;
  createdAt: number;
  lastUsedAt: number;
  /** Private local metadata. Never include this value in a sync entity or diagnostics. */
  sourceUrl?: string;
}

export interface PdfCache {
  list(scope: AccountScope): Promise<PdfCacheEntry[]>;
  read(scope: AccountScope, version: PdfVersion): Promise<Uint8Array | null>;
  put(scope: AccountScope, version: PdfVersion, bytes: Uint8Array, options?: {
    pinned?: boolean;
    sourceUrl?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  setPinned(scope: AccountScope, versionId: string, pinned: boolean): Promise<void>;
  remove(scope: AccountScope, versionId: string): Promise<void>;
  clear(scope: AccountScope, options?: { includePinned?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export const PDF_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxPages: 2000,
  requestTimeoutMs: 30_000,
  operationTimeoutMs: 180_000,
  teardownTimeoutMs: 2_000,
  rangeChunkBytes: 1024 * 1024,
  maxCacheBytes: 256 * 1024 * 1024,
  maxTemporaryBytes: 128 * 1024 * 1024,
  maxPinnedBytes: 192 * 1024 * 1024,
  maxCacheEntries: 512,
  maxRenderedPages: 3,
  maxCanvasPixels: 4 * 1024 * 1024,
  maxTextPageCharacters: 262_144,
  maxDocumentTextCharacters: 1_000_000,
  maxSearchResults: 500,
});
