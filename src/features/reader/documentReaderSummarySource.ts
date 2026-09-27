import type {
  PdfSource,
  PositionedMineruBlock,
  ReaderSettings,
  WorkspaceItem,
} from '../../types/reader.ts';
import {
  buildMineruCachePathCandidates,
  guessSiblingMarkdownPath,
} from '../../utils/mineruCache.ts';
import { getPdfSourceSignature } from '../pdf/pdfDocumentSource.ts';

type ReadLocalTextFileIfExists = (path: string) => Promise<string | null>;
type BuildMineruMarkdownDocument = (
  blocks: PositionedMineruBlock[],
  mineruPath?: string,
) => string;
type Localize = (zh: string, en: string) => string;

// MinerU block extraction now includes visual captions, OCR, and footnotes.
// Invalidate only MinerU summaries; PDF-text summaries are unaffected.
export function mineruSummarySourceVersion(promptVersion: string): string {
  return `${promptVersion}-visual-v2`;
}

export function buildPaperSummarySourceKey({
  item,
  promptVersion,
  summaryLanguage,
  summarySourceMode,
  pdfSource,
  pdfPath,
  currentPdfName,
  mineruPath,
  currentJsonName,
  blockCount,
}: {
  item: WorkspaceItem | null | undefined;
  promptVersion: string;
  summaryLanguage: string;
  summarySourceMode: ReaderSettings['summarySourceMode'];
  pdfSource: PdfSource;
  pdfPath: string;
  currentPdfName: string;
  mineruPath: string;
  currentJsonName: string;
  blockCount: number;
}): string {
  if (!item) {
    return '';
  }

  if (summarySourceMode === 'pdf-text') {
    if (!pdfSource) {
      return '';
    }

    return `${item.itemKey}::${promptVersion}::${summaryLanguage}::pdf-text::${getPdfSourceSignature(pdfSource, pdfPath || currentPdfName)}`;
  }

  if (!mineruPath && blockCount === 0) {
    return '';
  }

  return `${item.itemKey}::${mineruSummarySourceVersion(promptVersion)}::${summaryLanguage}::mineru-markdown::${mineruPath || currentJsonName}::${blockCount}`;
}

export function resolveMineruMarkdownCandidatePaths({
  item,
  mineruCacheDir,
  mineruPath,
}: {
  item: WorkspaceItem;
  mineruCacheDir: string;
  mineruPath: string;
}): string[] {
  const candidatePaths = new Set<string>();

  if (mineruPath.trim() && !mineruPath.startsWith('cloud:')) {
    candidatePaths.add(guessSiblingMarkdownPath(mineruPath));
  }

  if (mineruCacheDir.trim()) {
    for (const cachePaths of buildMineruCachePathCandidates(mineruCacheDir.trim(), item)) {
      candidatePaths.add(cachePaths.markdownPath);
    }
  }

  return Array.from(candidatePaths);
}

export async function loadMineruMarkdownDocument({
  item,
  flatBlocks,
  mineruPath,
  mineruCacheDir,
  readText,
  buildFallbackMarkdown,
  l,
}: {
  item: WorkspaceItem;
  flatBlocks: PositionedMineruBlock[];
  mineruPath: string;
  mineruCacheDir: string;
  readText: ReadLocalTextFileIfExists;
  buildFallbackMarkdown: BuildMineruMarkdownDocument;
  l: Localize;
}): Promise<string> {
  const candidatePaths = resolveMineruMarkdownCandidatePaths({
    item,
    mineruCacheDir,
    mineruPath,
  });

  for (const candidatePath of candidatePaths) {
    try {
      const markdownText = await readText(candidatePath);
      if (!markdownText) continue;

      if (markdownText.trim()) {
        return markdownText;
      }
    } catch {
      continue;
    }
  }

  const fallbackMarkdown = buildFallbackMarkdown(flatBlocks, mineruPath);

  if (fallbackMarkdown.trim()) {
    return fallbackMarkdown;
  }

  throw new Error(
    l(
      '请先加载 MinerU 的 full.md，再使用 MinerU Markdown 作为概览来源。',
      'Load MinerU full.md before using MinerU Markdown as the overview source.',
    ),
  );
}
