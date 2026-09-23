import { extractTranslatableMarkdownFromMineruBlock } from '../../services/mineru.ts';
import type { PositionedMineruBlock, TranslationBlockInput, TranslationMap } from '../../types/reader';

function buildTranslationBlockInputs(
  blocks: PositionedMineruBlock[],
  includeContentContinuations: boolean,
): TranslationBlockInput[] {
  return blocks.flatMap((block) => {
    if (!includeContentContinuations && block.contentSourceBlockId) return [];
    const text = extractTranslatableMarkdownFromMineruBlock(block).trim();
    return text ? [{ blockId: block.blockId, text }] : [];
  });
}

export function buildReaderTranslationBlockInputs(
  blocks: PositionedMineruBlock[],
): TranslationBlockInput[] {
  return buildTranslationBlockInputs(blocks, false);
}

// Batches before this fix included continuation blocks in their source fingerprint.
// Recreate that exact source only to verify and reuse already saved translations.
export function buildLegacyBatchTranslationBlockInputs(
  blocks: PositionedMineruBlock[],
): TranslationBlockInput[] {
  return buildTranslationBlockInputs(blocks, true);
}

export interface TranslationSourceMetadata {
  blockSourceFingerprints: Record<string, string>;
  sourceFingerprint: string;
}

export interface SourceBoundTranslationCache {
  blockSourceFingerprints?: Record<string, string>;
  legacySourceBinding?: boolean;
  sourceFingerprint?: string;
  translations: TranslationMap;
}

function normalizeTranslationSourceText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }

  return hash.toString(16).padStart(16, '0');
}

function blockSourcePayload(block: TranslationBlockInput): string {
  const blockId = normalizeTranslationSourceText(block.blockId);
  const text = normalizeTranslationSourceText(block.text);
  return `${blockId.length}:${blockId}${text.length}:${text}`;
}

export function buildTranslationSourceMetadata(
  blocks: TranslationBlockInput[],
): TranslationSourceMetadata {
  const blockSourceFingerprints: Record<string, string> = {};
  const sourceParts: string[] = [];

  for (const block of blocks) {
    const blockId = block.blockId.trim();
    if (!blockId) continue;

    const payload = blockSourcePayload(block);
    blockSourceFingerprints[blockId] = `fnv1a64-v1:${fnv1a64(payload)}`;
    sourceParts.push(payload);
  }

  return {
    blockSourceFingerprints,
    sourceFingerprint: `fnv1a64-v1:${fnv1a64(sourceParts.join('\u001e'))}`,
  };
}

export function selectReusableCachedTranslations(
  cached: SourceBoundTranslationCache | null | undefined,
  sourceBlocks: TranslationBlockInput[],
  legacyBatchSourceBlocks?: TranslationBlockInput[],
): TranslationMap {
  if (
    !cached ||
    cached.legacySourceBinding ||
    !cached.sourceFingerprint ||
    !cached.blockSourceFingerprints
  ) {
    return {};
  }

  const currentSource = buildTranslationSourceMetadata(sourceBlocks);

  if (cached.sourceFingerprint !== currentSource.sourceFingerprint) {
    if (!legacyBatchSourceBlocks || legacyBatchSourceBlocks.length <= sourceBlocks.length) {
      return {};
    }
    const legacySource = buildTranslationSourceMetadata(legacyBatchSourceBlocks);
    if (
      cached.sourceFingerprint !== legacySource.sourceFingerprint ||
      !sourceBlocks.every((block) =>
        legacySource.blockSourceFingerprints[block.blockId.trim()] ===
        currentSource.blockSourceFingerprints[block.blockId.trim()],
      )
    ) {
      return {};
    }
  }

  const reusable: TranslationMap = {};

  for (const block of sourceBlocks) {
    const blockId = block.blockId.trim();
    const translatedText = cached.translations[blockId]?.trim();

    if (
      !blockId ||
      !translatedText ||
      cached.blockSourceFingerprints[blockId] !==
        currentSource.blockSourceFingerprints[blockId]
    ) {
      continue;
    }

    reusable[blockId] = translatedText;
  }

  return reusable;
}

export function selectReusableSessionTranslations(
  snapshot: (SourceBoundTranslationCache & { targetLanguage: string }) | null | undefined,
  sourceBlocks: TranslationBlockInput[],
  targetLanguage: string,
  legacyBatchSourceBlocks?: TranslationBlockInput[],
): TranslationMap {
  return snapshot?.targetLanguage === targetLanguage
    ? selectReusableCachedTranslations(snapshot, sourceBlocks, legacyBatchSourceBlocks)
    : {};
}
