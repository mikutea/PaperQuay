import { createRichNoteData, richNoteText, validateRichNoteData, RichNoteError, RICH_NOTE_LIMITS, type RichNoteAsset, type RichNoteData, type RichNoteNode } from '../../../../packages/sync-core/src/richNote.ts';

export function richNoteAssetKey(assets: readonly RichNoteAsset[]): string { return assets.map((asset) => asset.id).sort().join(':'); }
export function richNoteUsedAssets(document: RichNoteNode, candidates: readonly RichNoteAsset[]): RichNoteAsset[] {
  richNoteText(document);
  const ids = new Set<string>();
  const walk = (node: RichNoteNode) => { if (node.type === 'image') ids.add(String(node.attrs?.src).slice(13)); for (const child of node.content ?? []) walk(child); };
  walk(document); return candidates.filter((asset) => ids.has(asset.id));
}
/** No normalization is emitted at construction/receive. Repeated controlled acks
 * and metadata changes do not replace an actively edited ProseMirror document. */
export class RichNoteSession {
  private value: RichNoteData;
  private receivedDocument: string;
  private catalog = new Map<string, RichNoteAsset>();
  private retired = false;
  private dirty = false;
  constructor(value: RichNoteData) { this.value = validateRichNoteData(value); this.receivedDocument = JSON.stringify(this.value.document); for (const asset of this.value.assets) this.catalog.set(asset.id, asset); }
  get current(): RichNoteData { return this.value; }
  get isDirty(): boolean { return this.dirty; }
  receive(input: RichNoteData): { replace: boolean; resources: boolean } {
    const next = validateRichNoteData(input), signature = JSON.stringify(next.document);
    const replace = signature !== this.receivedDocument && signature !== JSON.stringify(this.value.document);
    const before = richNoteAssetKey(this.value.assets);
    const merged = replace ? next : createRichNoteData({ paperId: next.paperId, title: next.title, document: this.value.document, metadata: next.metadata, assets: this.value.assets });
    this.receivedDocument = signature; this.value = merged;
    if (replace) { this.catalog = new Map(next.assets.map((asset) => [asset.id, asset])); this.dirty = false; }
    return { replace, resources: before !== richNoteAssetKey(this.value.assets) };
  }
  prepare(document: unknown, extraAssets: readonly RichNoteAsset[] = []): RichNoteData {
    const candidates = new Map(this.catalog);
    for (const asset of extraAssets) candidates.set(asset.id, asset);
    if (candidates.size > RICH_NOTE_LIMITS.assets || [...candidates.values()].reduce((sum, asset) => sum + asset.sizeBytes, 0) > RICH_NOTE_LIMITS.entityBytes) throw new RichNoteError('NOTE_LIMIT');
    return createRichNoteData({ paperId: this.value.paperId, title: this.value.title, document, metadata: this.value.metadata,
      assets: richNoteUsedAssets(document as RichNoteNode, [...candidates.values()]) });
  }
  edit(document: unknown, extraAssets: readonly RichNoteAsset[] = []): RichNoteData | null {
    if (this.retired) return null;
    this.dirty = true;
    const next = this.prepare(document, extraAssets);
    if (JSON.stringify(next.document) === JSON.stringify(this.value.document)) return null;
    for (const asset of next.assets) this.catalog.set(asset.id, asset);
    this.value = next; return next;
  }
  close(): void { this.retired = true; this.catalog.clear(); }
}
