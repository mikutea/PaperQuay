import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { PageViewport, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import type { AnnotationAnchor, AnnotationData, PdfQuad } from '../../../../packages/sync-core/src/index.ts';
import { PDF_LIMITS } from './types.ts';
import type { PdfRuntime, VerifiedPdf } from './engine.ts';
import { boundedCanvasScale, intersectRect, normalizedPointToViewport, quadToViewport, rectToQuad } from './geometry.ts';
import { capturePageSelection } from './selection.ts';
import { PdfError, pdfError } from './errors.ts';
import { boundedTextContent } from './textContent.ts';

export interface PageAnnotation { entityId: string; data: AnnotationData }
interface Props {
  pdf: VerifiedPdf;
  runtime: PdfRuntime;
  pageIndex: number;
  fitWidth: number;
  zoom: number;
  rotation: number;
  annotations: PageAnnotation[];
  focusQuads?: PdfQuad[];
  areaMode: boolean;
  onSelection: (anchor: AnnotationAnchor | null, pageIndex: number) => void;
  onArea: (anchor: AnnotationAnchor) => void;
  onError: (error: PdfError) => void;
}

export function pageDisplaySize(pdf: VerifiedPdf, index: number, fitWidth: number, zoom: number, rotation: number): {
  width: number; height: number; scale: number;
} {
  const info = pdf.pages[index];
  const width = rotation % 180 === 0 ? info.width : info.height;
  const height = rotation % 180 === 0 ? info.height : info.width;
  const scale = Math.max(1, fitWidth) / width * zoom;
  return { width: width * scale, height: height * scale, scale };
}

export function PdfPageView(props: Props) {
  const { pdf, runtime, pageIndex, fitWidth, zoom, rotation } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const pageRoot = useRef<HTMLElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const work = useRef<Promise<void> | null>(null);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<PdfError | null>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const size = pageDisplaySize(pdf, pageIndex, fitWidth, zoom, rotation);

  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    let page: PDFPageProxy | undefined;
    let rendering: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const previous = work.current;
    setReady(false); setFailure(null); setViewport(null);
    const job = (async () => {
      await previous?.catch(() => undefined);
      if (!active || !canvas.current || !layer.current) return;
      page = await pdf.page(pageIndex);
      if (!active) { page.cleanup(); return; }
      const view = page.getViewport({ scale: size.scale, rotation: (page.rotate + rotation) % 360 });
      setViewport(view);
      const outputScale = boundedCanvasScale(view.width, view.height, globalThis.devicePixelRatio ?? 1, PDF_LIMITS.maxCanvasPixels);
      const target = canvas.current;
      target.width = Math.max(1, Math.floor(view.width * outputScale));
      target.height = Math.max(1, Math.floor(view.height * outputScale));
      const textRoot = layer.current;
      textRoot.replaceChildren();
      rendering = page.render({ canvas: target, viewport: view,
        transform: [target.width / view.width, 0, 0, target.height / view.height, 0, 0] });
      // Observe immediately: text extraction may fail before the render is awaited below.
      void rendering.promise.catch(() => undefined);
      const content = await boundedTextContent(page, abort.signal);
      if (!active) return;
      if (content.items.length > 20_000 || content.items.reduce((count, item) => count + ('str' in item ? item.str.length : 0), 0)
        > PDF_LIMITS.maxTextPageCharacters) throw new PdfError('TEXT_LIMIT');
      textLayer = new runtime.library.TextLayer({ textContentSource: content, container: textRoot, viewport: view });
      // Explicit dimensions also work on WebViews without the CSS round() function.
      textRoot.style.width = `${(page.view[2] - page.view[0]) * view.scale * page.userUnit}px`;
      textRoot.style.height = `${(page.view[3] - page.view[1]) * view.scale * page.userUnit}px`;
      await Promise.all([rendering.promise, textLayer.render()]);
      const resourceError = runtime.resourceError?.();
      if (resourceError) throw resourceError;
      if (active) setReady(true);
    })().catch((error) => {
      rendering?.cancel(); textLayer?.cancel();
      if (!active) return;
      const safe = runtime.resourceError?.() ?? (error instanceof PdfError ? error : new PdfError('PAGE_RENDER'));
      setFailure(safe); callbacks.current.onError(safe);
    });
    work.current = job;
    return () => {
      active = false; abort.abort(); rendering?.cancel(); textLayer?.cancel();
      if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; }
      layer.current?.replaceChildren();
      void job.finally(() => page?.cleanup());
    };
  }, [pdf, runtime, pageIndex, size.scale, rotation]);

  useEffect(() => {
    if (!ready || !viewport) return;
    let ownedSelection = false;
    const changed = () => {
      if (!layer.current || callbacks.current.areaMode) return;
      try {
        const anchor = capturePageSelection(layer.current, pageIndex, pdf.pages[pageIndex].cropBox, viewport);
        if (anchor) { ownedSelection = true; callbacks.current.onSelection(anchor, pageIndex); }
        else if (ownedSelection) { ownedSelection = false; callbacks.current.onSelection(null, pageIndex); }
      } catch (error) { callbacks.current.onError(pdfError(error)); }
    };
    document.addEventListener('selectionchange', changed);
    return () => document.removeEventListener('selectionchange', changed);
  }, [pdf, pageIndex, ready, viewport]);

  const relativePoint = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = pageRoot.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(size.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(size.height, event.clientY - bounds.top)) };
  };
  const startArea = (event: PointerEvent<HTMLDivElement>) => {
    if (!props.areaMode || !ready || !viewport || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const point = relativePoint(event); pointer.current = { id: event.pointerId, ...point };
    setDrag({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
  };
  const moveArea = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    const point = relativePoint(event);
    setDrag({ x1: pointer.current.x, y1: pointer.current.y, x2: point.x, y2: point.y });
  };
  const finishArea = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id !== event.pointerId || !viewport) return;
    const start = pointer.current; const point = relativePoint(event);
    pointer.current = null; setDrag(null); event.currentTarget.releasePointerCapture(event.pointerId);
    const rect = intersectRect({ left: Math.min(start.x, point.x), top: Math.min(start.y, point.y),
      right: Math.max(start.x, point.x), bottom: Math.max(start.y, point.y) },
    { left: 0, top: 0, right: size.width, bottom: size.height });
    if (!rect || rect.right - rect.left < 5 || rect.bottom - rect.top < 5) return;
    props.onArea({ pageIndex, coordinateSpace: 'pdf-crop-box-unrotated-normalized',
      quads: [rectToQuad(rect, pdf.pages[pageIndex].cropBox, viewport)], quote: null });
  };
  const polygon = (quad: PdfQuad) => quadToViewport(quad, pdf.pages[pageIndex].cropBox, viewport!).reduce((text, value, index) =>
    text + (index % 2 === 0 ? (index ? ' ' : '') : ',') + value, '');
  const underline = (quad: PdfQuad): number[] => {
    const xs = [quad[0], quad[2], quad[4], quad[6]]; const ys = [quad[1], quad[3], quad[5], quad[7]];
    return [...normalizedPointToViewport(Math.min(...xs), Math.min(...ys), pdf.pages[pageIndex].cropBox, viewport!),
      ...normalizedPointToViewport(Math.max(...xs), Math.min(...ys), pdf.pages[pageIndex].cropBox, viewport!)];
  };

  return <section ref={pageRoot} className="pr-page" data-page-index={pageIndex}
    aria-label={`第 ${pageIndex + 1} 页`} style={{ width: size.width, height: size.height,
      '--total-scale-factor': size.scale * pdf.pages[pageIndex].userUnit,
      '--scale-round-x': '1px', '--scale-round-y': '1px' } as CSSProperties}>
    <canvas ref={canvas} aria-hidden="true" style={{ width: size.width, height: size.height }} />
    <div ref={layer} className="pr-text-layer textLayer" />
    {viewport && <svg className="pr-annotation-overlay" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
      {props.annotations.flatMap(({ entityId, data }) => data.anchor.quads.map((quad, index) => {
        if (data.kind === 'underline') {
          const [x1, y1, x2, y2] = underline(quad);
          return <line key={`${entityId}:${index}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={data.color} strokeWidth="2" />;
        }
        return <polygon key={`${entityId}:${index}`} points={polygon(quad)}
          fill={data.color} fillOpacity={data.kind === 'area' ? 0.08 : 0.3}
          stroke={data.kind === 'area' ? data.color : 'none'} strokeWidth="2" />;
      }))}
      {props.focusQuads?.map((quad, index) => <polygon key={`focus:${index}`} points={polygon(quad)} fill="#0d9488" fillOpacity="0.12"
        stroke="#0d9488" strokeWidth="2" strokeDasharray="5 3" />)}
      {drag && <rect x={Math.min(drag.x1, drag.x2)} y={Math.min(drag.y1, drag.y2)}
        width={Math.abs(drag.x2 - drag.x1)} height={Math.abs(drag.y2 - drag.y1)} fill="#0d9488" fillOpacity="0.12" stroke="#0d9488" />}
    </svg>}
    {props.areaMode && <div className="pr-area-input" aria-label="拖动框选批注范围" onPointerDown={startArea}
      onPointerMove={moveArea} onPointerUp={finishArea} onPointerCancel={() => { pointer.current = null; setDrag(null); }} />}
    {!ready && !failure && <div className="pr-page-message" role="status">正在显示第 {pageIndex + 1} 页…</div>}
    {failure && <div className="pr-page-message" role="alert">{failure.message}</div>}
  </section>;
}
