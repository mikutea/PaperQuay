import {
  PARSED_LIMITS, ParsedDocumentError, type ParsedBlock, type ParsedDocumentPackage,
} from '../../../../packages/sync-core/src/parsedDocument.ts';

/** Resolve each continuation once. Large strings/tables are shared, never concatenated
 * along a chain; a continuation keeps its own block ID and PDF page. */
export function resolveParsedBlocks(document: ParsedDocumentPackage): ParsedBlock[] {
  if (!Array.isArray(document.blocks) || document.blocks.length > PARSED_LIMITS.maxBlocks)
    throw new ParsedDocumentError('INVALID_PACKAGE');
  const originals = new Map(document.blocks.map((block) => [block.id, block]));
  if (originals.size !== document.blocks.length) throw new ParsedDocumentError('INVALID_PACKAGE');
  const complete = new Map<string, ParsedBlock>();
  for (const block of document.blocks) {
    const chain: ParsedBlock[] = [], seen = new Set<string>();
    let current: ParsedBlock | undefined = block;
    while (current && !complete.has(current.id)) {
      if (seen.has(current.id)) throw new ParsedDocumentError('INVALID_PACKAGE');
      seen.add(current.id); chain.push(current);
      if (!current.sourceBlockId) break;
      const source = originals.get(current.sourceBlockId);
      if (!source || source.kind !== current.kind) throw new ParsedDocumentError('INVALID_PACKAGE');
      current = source;
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      const own = chain[index], source = own.sourceBlockId ? complete.get(own.sourceBlockId) : undefined;
      complete.set(own.id, source ? {
        ...source, ...own,
        text: own.text || source.text,
        markdown: own.markdown || source.markdown,
        latex: own.latex || source.latex,
        table: own.table ?? source.table,
        assetId: own.assetId ?? source.assetId,
        caption: own.caption || source.caption,
        footnote: own.footnote || source.footnote,
      } : { ...own });
    }
  }
  return document.blocks.map((block) => complete.get(block.id)!);
}
