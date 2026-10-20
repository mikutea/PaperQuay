import type { PdfTextSelection, TextMarkupStyle } from '../../types/reader';
import { getSelectedTextRanges } from '../../utils/textSelectionRanges.ts';

export function capturePdfTextSelection(container: HTMLElement, selection: Range): PdfTextSelection[] {
  const pages: PdfTextSelection[] = [];
  for (const page of container.querySelectorAll<HTMLElement>('.page[data-page-number]')) {
    const textLayer = page.querySelector<HTMLElement>('.textLayer');
    if (!textLayer || !selection.intersectsNode(textLayer)) continue;
    const pageRect = page.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) continue;
    const rects = getSelectedTextRanges(textLayer, selection).flatMap((range) =>
      Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => ({
        x: (rect.left - pageRect.left) / pageRect.width,
        y: (rect.top - pageRect.top) / pageRect.height,
        width: rect.width / pageRect.width,
        height: rect.height / pageRect.height,
      })),
    );
    if (rects.length) pages.push({ pageIndex: Number(page.dataset.pageNumber) - 1, rects });
  }
  return pages;
}

interface PdfViewport {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
}

/**
 * PDF.js editor data uses PDF coordinates, including the page's crop and rotation.
 * Underlines use thin highlight quads so PDF.js can edit, undo, and export them.
 */
export function buildPdfTextMarkup(
  selection: PdfTextSelection,
  viewport: PdfViewport,
  style: TextMarkupStyle,
  color: string,
  editorTypes: { HIGHLIGHT: number },
) {
  if (!selection.rects.length) throw new Error('Cannot mark an empty PDF selection.');
  const rgb = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
  const boxes = selection.rects.map((box) => {
    let topLeft = viewport.convertToPdfPoint(box.x * viewport.width, box.y * viewport.height);
    const bottomLeft = viewport.convertToPdfPoint(box.x * viewport.width, (box.y + box.height) * viewport.height);
    const bottomRight = viewport.convertToPdfPoint((box.x + box.width) * viewport.width, (box.y + box.height) * viewport.height);
    if (style === 'underline') {
      const height = Math.hypot(topLeft[0] - bottomLeft[0], topLeft[1] - bottomLeft[1]);
      const ratio = Math.min(1, 1.25 / height);
      topLeft = bottomLeft.map((value, axis) => value + (topLeft[axis] - value) * ratio);
    }
    return [Math.min(topLeft[0], bottomRight[0]), Math.min(topLeft[1], bottomRight[1]),
      Math.max(topLeft[0], bottomRight[0]), Math.max(topLeft[1], bottomRight[1])];
  });
  const rect = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  return {
    color: rgb, pageIndex: selection.pageIndex, rect, rotation: 0, opacity: 1,
    annotationType: editorTypes.HIGHLIGHT,
    quadPoints: boxes.flatMap(([left, bottom, right, top]) => [left, top, right, top, left, bottom, right, bottom]),
  };
}
