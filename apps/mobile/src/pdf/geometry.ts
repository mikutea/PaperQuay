import type { PdfQuad } from '../../../../packages/sync-core/src/index.ts';

export type CropBox = readonly [number, number, number, number];
export type Matrix = readonly [number, number, number, number, number, number];
export interface ViewportGeometry {
  width: number;
  height: number;
  transform: readonly number[];
}
export interface Rect { left: number; top: number; right: number; bottom: number }

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function validBox(box: CropBox): void {
  if (!box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) {
    throw new RangeError('Invalid PDF crop box');
  }
}

/** PDF coordinates are normalized against the unrotated crop box, with y increasing up. */
export function viewportPointToNormalized(
  x: number, y: number, cropBox: CropBox, viewport: ViewportGeometry,
): [number, number] {
  validBox(cropBox);
  const [a, b, c, d, e, f] = viewport.transform;
  const determinant = a * d - b * c;
  if (![x, y, a, b, c, d, e, f, determinant].every(Number.isFinite) || determinant === 0) {
    throw new RangeError('Invalid PDF viewport');
  }
  const pdfX = (d * (x - e) - c * (y - f)) / determinant;
  const pdfY = (-b * (x - e) + a * (y - f)) / determinant;
  return [clamp((pdfX - cropBox[0]) / (cropBox[2] - cropBox[0])),
    clamp((pdfY - cropBox[1]) / (cropBox[3] - cropBox[1]))];
}

export function normalizedPointToViewport(
  x: number, y: number, cropBox: CropBox, viewport: ViewportGeometry,
): [number, number] {
  validBox(cropBox);
  const [a, b, c, d, e, f] = viewport.transform;
  const pdfX = cropBox[0] + x * (cropBox[2] - cropBox[0]);
  const pdfY = cropBox[1] + y * (cropBox[3] - cropBox[1]);
  return [a * pdfX + c * pdfY + e, b * pdfX + d * pdfY + f];
}

/** Four corners remain ordered around their polygon; rotations never reorder the source anchor. */
export function rectToQuad(rect: Rect, cropBox: CropBox, viewport: ViewportGeometry): PdfQuad {
  const points = [[rect.left, rect.top], [rect.right, rect.top],
    [rect.right, rect.bottom], [rect.left, rect.bottom]];
  return points.flatMap(([x, y]) => viewportPointToNormalized(x, y, cropBox, viewport)) as PdfQuad;
}

export function quadToViewport(quad: PdfQuad, cropBox: CropBox, viewport: ViewportGeometry): number[] {
  return [0, 2, 4, 6].flatMap((index) =>
    normalizedPointToViewport(quad[index], quad[index + 1], cropBox, viewport));
}

export function quadBounds(quad: PdfQuad, cropBox: CropBox, viewport: ViewportGeometry): Rect {
  const points = quadToViewport(quad, cropBox, viewport);
  const xs = [points[0], points[2], points[4], points[6]];
  const ys = [points[1], points[3], points[5], points[7]];
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const rect = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return rect.right - rect.left > 0.5 && rect.bottom - rect.top > 0.5 ? rect : null;
}

export function boundedCanvasScale(width: number, height: number, devicePixelRatio: number, maxPixels: number): number {
  if (width <= 0 || height <= 0 || maxPixels <= 0) return 1;
  return Math.min(Math.max(1, devicePixelRatio || 1), 2, Math.sqrt(maxPixels / (width * height)));
}

export function pageWindow(pageIndex: number, pageCount: number, continuous: boolean): number[] {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) return [];
  return continuous
    ? [pageIndex - 1, pageIndex, pageIndex + 1].filter((index) => index >= 0 && index < pageCount)
    : [pageIndex];
}
