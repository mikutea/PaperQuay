import type { MineruPage, PaperSummary, PdfSource, WorkspaceItem } from '../../types/reader.ts';
import {
  buildMineruCachePathCandidates,
  buildMineruSummaryCachePathCandidates,
  getMineruJsonPathCandidates,
  guessSiblingJsonPaths,
  guessSiblingMarkdownPath,
} from '../../utils/mineruCache.ts';
import { isMineruCacheManifest } from './documentReaderManifest.ts';
type Localize = (zh: string, en: string) => string;

type ReadLocalTextFileIfExists = (path: string) => Promise<string | null>;
type LoadPdfBinary = (source: PdfSource) => Promise<Uint8Array | null>;
type ParseMineruPages = (payload: string | unknown) => MineruPage[];
type ParseMineruMarkdownPages = (markdownText: string) => MineruPage[];
type SummaryCacheEnvelope = {
  sourceKey: string;
  summary: PaperSummary;
};

// Cached text still references assets next to the original local parse output.
// This changes only the resolution base; resolveMineruAssetPath keeps enforcing
// the source-directory boundary for every asset.
export async function resolveCachedMineruSourcePath({
  item, cachedPath, cachedText, manifestPath, readText,
}: {
  item: WorkspaceItem;
  cachedPath: string;
  cachedText: string;
  manifestPath: string;
  readText: ReadLocalTextFileIfExists;
}): Promise<string> {
  try {
    const raw = await readText(manifestPath);
    if (!raw) return cachedPath;
    const manifest = JSON.parse(raw);
    if (!isMineruCacheManifest(manifest) || manifest.documentKey !== item.itemKey ||
        !['manual-json', 'sibling-json'].includes(manifest.sourceKind)) return cachedPath;

    const sourcePath = manifest.sourcePath;
    if (typeof sourcePath === 'string' &&
        /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(sourcePath) &&
        !sourcePath.split(/[\\/]/).includes('..') &&
        /\.(?:json|md)$/i.test(sourcePath)) return sourcePath;

    // Older sibling caches did not record provenance. Recover it only when
    // the original sibling output is still an exact match for the cached text.
    if (manifest.sourceKind === 'sibling-json' && item.localPdfPath) {
      const candidates = cachedPath.toLowerCase().endsWith('.md')
        ? [guessSiblingMarkdownPath(item.localPdfPath)]
        : guessSiblingJsonPaths(item.localPdfPath);
      for (const path of candidates) {
        if (await readText(path) === cachedText) return path;
      }
    }
  } catch {
    // Missing or malformed provenance must not discard a usable text cache.
  }
  return cachedPath;
}

export interface SavedMineruPagesResult {
  pages: MineruPage[];
  path: string;
  message: string;
}

export function isMatchingSummaryCacheEnvelope(
  value: unknown,
  sourceKey: string,
): value is SummaryCacheEnvelope {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as Partial<SummaryCacheEnvelope>).sourceKey === sourceKey &&
      (value as Partial<SummaryCacheEnvelope>).summary,
  );
}

export async function loadSavedSummaryCache({
  item,
  mineruCacheDir,
  sourceKey,
  readText,
}: {
  item: WorkspaceItem;
  mineruCacheDir: string;
  sourceKey: string;
  readText: ReadLocalTextFileIfExists;
}): Promise<PaperSummary | null> {
  if (!mineruCacheDir.trim() || !sourceKey.trim()) {
    return null;
  }

  const candidatePaths = buildMineruSummaryCachePathCandidates(
    mineruCacheDir.trim(),
    item,
    sourceKey,
  );

  for (const candidatePath of candidatePaths) {
    try {
      const raw = await readText(candidatePath);
      if (!raw) continue;

      const parsed = JSON.parse(raw);

      if (!isMatchingSummaryCacheEnvelope(parsed, sourceKey)) {
        continue;
      }

      return parsed.summary;
    } catch {
      continue;
    }
  }

  return null;
}

export async function loadSavedMineruPages({
  item,
  mineruCacheDir,
  l,
  readText,
  parsePages,
  parseMarkdownPages,
}: {
  item: WorkspaceItem;
  mineruCacheDir: string;
  l: Localize;
  readText: ReadLocalTextFileIfExists;
  parsePages: ParseMineruPages;
  parseMarkdownPages?: ParseMineruMarkdownPages;
}): Promise<SavedMineruPagesResult | null> {
  if (!mineruCacheDir.trim()) {
    return null;
  }

  const candidateCaches = buildMineruCachePathCandidates(mineruCacheDir.trim(), item);

  for (const cachePaths of candidateCaches) {
    for (const candidatePath of getMineruJsonPathCandidates(cachePaths)) {
      try {
        const jsonText = await readText(candidatePath);
        if (!jsonText) continue;

        return {
          pages: parsePages(jsonText),
          path: await resolveCachedMineruSourcePath({
            item, cachedPath: candidatePath, cachedText: jsonText,
            manifestPath: cachePaths.manifestPath, readText,
          }),
          message: l(
            `已从本地缓存恢复《${item.title}》的解析结果`,
            `Restored the parsing result for "${item.title}" from the local cache`,
          ),
        };
      } catch {
        continue;
      }
    }
  }

  if (parseMarkdownPages) {
    for (const cachePaths of candidateCaches) {
      try {
        const markdownText = await readText(cachePaths.markdownPath);
        if (!markdownText?.trim()) continue;

        const pages = parseMarkdownPages(markdownText);

        if (pages.length === 0 || pages.every((page) => page.length === 0)) {
          continue;
        }

        return {
          pages,
          path: await resolveCachedMineruSourcePath({
            item, cachedPath: cachePaths.markdownPath, cachedText: markdownText,
            manifestPath: cachePaths.manifestPath, readText,
          }),
          message: l(
            `已从本地 MinerU Markdown 恢复《${item.title}》的结构块`,
            `Restored structured blocks for "${item.title}" from local MinerU Markdown`,
          ),
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

export async function resolveSavedPdfPath({
  item,
  mineruCacheDir,
  readText,
  loadPdf,
}: {
  item: WorkspaceItem;
  mineruCacheDir: string;
  readText: ReadLocalTextFileIfExists;
  loadPdf: LoadPdfBinary;
}): Promise<string | null> {
  if (!mineruCacheDir.trim()) {
    return null;
  }

  const candidateCaches = buildMineruCachePathCandidates(mineruCacheDir.trim(), item);

  for (const cachePaths of candidateCaches) {
    try {
      const manifestText = await readText(cachePaths.manifestPath);
      if (!manifestText) continue;

      const parsed = JSON.parse(manifestText);

      if (!isMineruCacheManifest(parsed) || !parsed.pdfPath.trim()) {
        continue;
      }

      try {
        await loadPdf({ kind: 'local-path', path: parsed.pdfPath } satisfies PdfSource);
        return parsed.pdfPath;
      } catch {
        continue;
      }
    } catch {
      continue;
    }
  }

  return null;
}
