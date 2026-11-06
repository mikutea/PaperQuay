import type { AnnotationAnchor, PdfQuad } from '../../../../packages/sync-core/src/index.ts';
import { intersectRect, rectToQuad, type CropBox, type ViewportGeometry } from './geometry.ts';
import { PdfError } from './errors.ts';

export function capturePageSelection(layer: HTMLElement, pageIndex: number, cropBox: CropBox,
  viewport: ViewportGeometry, selection: Selection | null = globalThis.getSelection()): AnnotationAnchor | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !selection.anchorNode || !selection.focusNode
    || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return null;
  const exact = selection.toString().trim();
  if (!exact) return null;
  if (exact.length > 8192) throw new PdfError('SELECTION_LIMIT');
  const page = layer.closest<HTMLElement>('.pr-page');
  if (!page) return null;
  const bounds = page.getBoundingClientRect();
  const rectangle = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
  const seen = new Set<string>();
  const quads: PdfQuad[] = [];
  for (const rect of Array.from(selection.getRangeAt(0).getClientRects())) {
    const clipped = intersectRect(rect, rectangle);
    if (!clipped) continue;
    const key = [clipped.left, clipped.top, clipped.right, clipped.bottom].map((value) => Math.round(value * 10)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    if (quads.length >= 200) throw new PdfError('SELECTION_LIMIT');
    quads.push(rectToQuad({ left: clipped.left - bounds.left, top: clipped.top - bounds.top,
      right: clipped.right - bounds.left, bottom: clipped.bottom - bounds.top }, cropBox, viewport));
  }
  if (!quads.length) return null;
  const pageText = layer.textContent ?? '';
  const index = pageText.indexOf(exact);
  return { pageIndex, coordinateSpace: 'pdf-crop-box-unrotated-normalized', quads,
    quote: { exact, prefix: index >= 0 ? pageText.slice(Math.max(0, index - 120), index) : '',
      suffix: index >= 0 ? pageText.slice(index + exact.length, index + exact.length + 120) : '' } };
}
