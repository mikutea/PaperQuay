import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  getVisibleEntity, type AnnotationAnchor, type AnnotationData, type AttachmentVersionData,
  type PaperData, type ReadingPositionData, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import { accountScopeKey } from '../storage/accountStore.ts';
import { describeError } from '../errors.ts';
import { Icon } from './Icon.tsx';
import { getPdfCache } from '../pdf/cache.ts';
import { registerPdfTask } from '../pdf/tasks.ts';
import { InitialPdfOpening, useInitialPdfRestore } from '../pdf/opening.ts';
import { downloadPublicPdf, inspectPublicPdf, readLocalPdf, safePdfName, type PdfSourceProbe } from '../pdf/acquisition.ts';
import { openVerifiedPdf, type PdfOutlineItem, type PdfRuntime, type PdfSearchMatch, type VerifiedPdf } from '../pdf/engine.ts';
import { PdfError, throwIfAborted } from '../pdf/errors.ts';
import { pageWindow, quadBounds } from '../pdf/geometry.ts';
import { PdfPageView, pageDisplaySize } from '../pdf/PdfPageView.tsx';
import { ownReadingPosition, positionOwner, readerIdentity, ReadingCheckpointWriter, sameReaderIdentity,
  type PositionStatus, type ReaderIdentity, type ReadingPoint } from '../pdf/position.ts';
import { PDF_LIMITS, type PaperReaderProps, type PdfAiContext, type PdfCacheEntry, type PdfCitationTarget, type PdfVersion } from '../pdf/types.ts';

type Panel = 'source' | 'contents' | 'search' | 'annotations' | 'cache' | null;
interface Loaded { pdf: VerifiedPdf; version: PdfVersion; runtime: PdfRuntime }
interface Task { epoch: number; signal: AbortSignal; identity: ReaderIdentity; check: () => void }
interface CommentDraft { entityId: string; revision: number; data: AnnotationData; comment: string; saved: string }
const byteLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const errorMessage = (error: unknown) => error instanceof PdfError ? error.message : describeError(error);
const labelForKind = (kind: AnnotationData['kind']) => kind === 'highlight' ? '高亮' : kind === 'underline' ? '下划线' : '区域';

function versionsFor(paperId: string, records: VisibleEntity[]): PdfVersion[] {
  return records.filter((record) => record.entityType === 'attachmentVersion' && !record.deleted && record.data
    && (record.data as AttachmentVersionData).paperId === paperId)
    .map((record) => ({ entityId: record.entityId, data: record.data as AttachmentVersionData }));
}

export function PaperReader(props: PaperReaderProps) {
  const { scope, paper, controller, onAskAi, jumpTo } = props;
  const scopeKey = accountScopeKey(scope);
  const versions = useMemo(() => versionsFor(paper.entityId, props.attachmentVersions), [paper.entityId, props.attachmentVersions]);
  const [selectedVersionId, setSelectedVersionId] = useState(() => versions[0]?.entityId ?? '');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [panel, setPanel] = useState<Panel>('source');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [probe, setProbe] = useState<PdfSourceProbe | null>(null);
  const [cacheEntries, setCacheEntries] = useState<PdfCacheEntry[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [continuous, setContinuous] = useState(true);
  const [fitWidth, setFitWidth] = useState(640);
  const [positionStatus, setPositionStatus] = useState<PositionStatus>('idle');
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PdfSearchMatch[]>([]);
  const [searchLimited, setSearchLimited] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selection, setSelection] = useState<AnnotationAnchor | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [annotationColor, setAnnotationColor] = useState('#eab308');
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentStatus, setCommentStatus] = useState<PositionStatus>('idle');
  const [focus, setFocus] = useState<PdfCitationTarget | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const liveScope = useRef(scopeKey); liveScope.current = scopeKey;
  const epoch = useRef(0);
  const taskAbort = useRef<AbortController | null>(null);
  const documentAbort = useRef<AbortController | null>(null);
  const releaseDocumentTask = useRef<(() => void) | null>(null);
  const invalidateContext = useRef(props.onContextInvalidated); invalidateContext.current = props.onContextInvalidated;
  const current = useRef<Loaded | null>(null); current.current = loaded;
  const activeBytes = useRef<Uint8Array | null>(null);
  const writer = useRef<ReadingCheckpointWriter | null>(null);
  const currentPoint = useRef<ReadingPoint>({ pageIndex: 0, offsetRatio: 0 });
  const pendingJump = useRef<PdfCitationTarget | null>(null);
  const seenJump = useRef<string | null>(null);
  const opening = useRef(new InitialPdfOpening());
  const draftRef = useRef<CommentDraft | null>(null); draftRef.current = commentDraft;
  const commentWork = useRef<Promise<void> | null>(null);
  const cache = useMemo(() => getPdfCache(), []);
  const cacheEntry = cacheEntries.find((entry) => entry.versionId === loaded?.version.entityId);
  const annotationRecords = useMemo(() => props.annotations.filter((record) => record.entityType === 'annotation'
    && !record.deleted && record.data && (record.data as AnnotationData).paperId === paper.entityId
    && (record.data as AnnotationData).attachmentVersionId === loaded?.version.entityId), [props.annotations, paper.entityId, loaded?.version.entityId]);

  const refreshCache = useCallback(async () => {
    const entries = await cache.list(scope);
    if (mounted.current && liveScope.current === scopeKey) setCacheEntries(entries);
  }, [cache, scope, scopeKey]);

  const closeDocument = useCallback(() => {
    invalidateContext.current?.();
    documentAbort.current?.abort(); documentAbort.current = null;
    releaseDocumentTask.current?.(); releaseDocumentTask.current = null;
    writer.current?.stop(); writer.current = null; activeBytes.current = null;
    void current.current?.pdf.close(); current.current = null;
    setLoaded(null); setSelection(null); setFocus(null); setOutline([]); setSearchResults([]); setSearched(false);
    setAreaMode(false); setPositionStatus('idle');
  }, []);

  const runTask = useCallback(async (label: string, work: (task: Task) => Promise<void>) => {
    taskAbort.current?.abort();
    const abort = new AbortController(); taskAbort.current = abort;
    const release = registerPdfTask(scope, abort);
    const taskEpoch = ++epoch.current;
    let identity: ReaderIdentity;
    try { identity = readerIdentity(controller, scope); }
    catch (failure) { release(); taskAbort.current = null; setError(errorMessage(failure)); return; }
    const check = () => {
      throwIfAborted(abort.signal);
      if (!mounted.current || liveScope.current !== scopeKey || epoch.current !== taskEpoch
        || !sameReaderIdentity(controller, identity)) throw new PdfError('ACCOUNT_CHANGED');
    };
    setBusy(label); setProgress(null); setError(null); setNotice(null);
    try { await work({ epoch: taskEpoch, signal: abort.signal, identity, check }); }
    catch (failure) { if (mounted.current && epoch.current === taskEpoch && liveScope.current === scopeKey) setError(errorMessage(failure)); }
    finally {
      release();
      if (mounted.current && epoch.current === taskEpoch && liveScope.current === scopeKey) {
        setBusy(null); setProgress(null); taskAbort.current = null;
      }
    }
  }, [controller, scope, scopeKey]);

  const saveComment = useCallback(async () => {
    if (commentWork.current) { await commentWork.current; return; }
    const identity = readerIdentity(controller, scope);
    const work = (async () => {
      while (draftRef.current && draftRef.current.comment !== draftRef.current.saved) {
        const draft = draftRef.current;
        if (!sameReaderIdentity(controller, identity) || liveScope.current !== scopeKey) throw new PdfError('ACCOUNT_CHANGED');
        const state = controller.getSnapshot().workspace!.sync;
        const visible = getVisibleEntity(state, 'annotation', draft.entityId);
        if (!visible?.data || visible.deleted) throw new PdfError('ACCOUNT_CHANGED');
        const latest = visible.data as AnnotationData;
        if (latest.comment !== draft.saved && latest.comment !== draft.comment) throw new PdfError('ANNOTATION_CHANGED');
        setCommentStatus('saving');
        await controller.save({ entityType: 'annotation', entityId: draft.entityId, mutation: 'put',
          data: { ...latest, comment: draft.comment } }, visible.revision);
        if (!sameReaderIdentity(controller, identity) || !mounted.current || liveScope.current !== scopeKey) return;
        setCommentDraft((value) => {
          if (!value || value.entityId !== draft.entityId) return value;
          const next = { ...value, saved: draft.comment, revision: visible.revision };
          draftRef.current = next; return next;
        });
        // React may batch the state updater; update the draft synchronously for the next iteration.
        if (draftRef.current?.entityId === draft.entityId) draftRef.current = { ...draftRef.current, saved: draft.comment };
      }
      if (mounted.current) setCommentStatus('saved');
    })();
    commentWork.current = work;
    try { await work; }
    catch (failure) { if (mounted.current && liveScope.current === scopeKey) { setCommentStatus('error'); setError(errorMessage(failure)); } throw failure; }
    finally { if (commentWork.current === work) commentWork.current = null; }
  }, [controller, scope, scopeKey]);

  const finishPending = useCallback(async () => { await saveComment(); await writer.current?.flush(); }, [saveComment]);

  const openBytes = useCallback(async (bytes: Uint8Array, fileName: string, expected: PdfVersion | undefined,
    source: string | undefined, task: Task) => {
    task.check(); await finishPending(); task.check(); closeDocument();
    const abort = new AbortController(); documentAbort.current = abort;
    releaseDocumentTask.current = registerPdfTask(scope, abort);
    const cancel = () => abort.abort(); task.signal.addEventListener('abort', cancel, { once: true });
    let pdf: VerifiedPdf | null = null;
    try {
      const { browserPdfRuntime } = await import('../pdf/browserRuntime.ts'); task.check();
      const runtime = browserPdfRuntime();
      pdf = await openVerifiedPdf(bytes, { expected, signal: abort.signal, runtime }); task.check();
      const known = versions.find((version) => version.data.sha256 === pdf!.sha256 && version.data.sizeBytes === pdf!.sizeBytes);
      let version: PdfVersion = expected ?? known ?? { entityId: crypto.randomUUID(), data: {
        paperId: paper.entityId, attachmentId: versions[0]?.data.attachmentId ?? crypto.randomUUID(),
        sha256: pdf.sha256, sizeBytes: pdf.sizeBytes, mediaType: 'application/pdf',
        fileName: safePdfName(fileName), pageCount: pdf.pageCount,
      } };
      if (version.data.pageCount !== null && version.data.pageCount !== pdf.pageCount) throw new PdfError('VERSION_MISMATCH');
      if ((!expected && !known) || version.data.pageCount === null) {
        version = { ...version, data: { ...version.data, pageCount: pdf.pageCount } };
        const visible = getVisibleEntity(controller.getSnapshot().workspace!.sync, 'attachmentVersion', version.entityId);
        task.check();
        await controller.save({ entityType: 'attachmentVersion', entityId: version.entityId, mutation: 'put', data: version.data }, visible?.revision ?? 0);
        task.check();
      }
      try { await cache.put(scope, version, bytes, { sourceUrl: source, signal: task.signal }); }
      catch (failure) {
        task.check(); setNotice(`${errorMessage(failure)} 本次仍可阅读，尚未保留离线副本。`);
      }
      task.check();
      const state = controller.getSnapshot().workspace!.sync;
      const own = ownReadingPosition(state, version)?.data as ReadingPositionData | null;
      let point: ReadingPoint = own && own.pageIndex < pdf.pageCount
        ? { pageIndex: own.pageIndex, offsetRatio: own.offsetRatio } : { pageIndex: 0, offsetRatio: 0 };
      const target = pendingJump.current;
      if (target?.attachmentVersionId === version.entityId && target.sha256 === version.data.sha256 && target.pageIndex < pdf.pageCount) {
        point = { pageIndex: target.pageIndex, offsetRatio: 0 }; setFocus(target); pendingJump.current = null;
      }
      const result = { pdf, version, runtime }; current.current = result; activeBytes.current = bytes;
      writer.current = new ReadingCheckpointWriter(controller, scope, version, {
        onStatus: (status) => { if (mounted.current && current.current === result && sameReaderIdentity(controller, task.identity)) setPositionStatus(status); },
      });
      currentPoint.current = point; setPageIndex(point.pageIndex); setLoaded(result); setSelectedVersionId(version.entityId);
      setPanel(null); setSelection(null); setCommentDraft(null); setCommentStatus('idle');
      writer.current.record(point);
      void pdf.outline(abort.signal).then((items) => { if (current.current === result && mounted.current) setOutline(items); }).catch(() => undefined);
      await refreshCache().catch(() => undefined);
      pdf = null;
    } finally {
      task.signal.removeEventListener('abort', cancel);
      if (pdf) await pdf.close();
      if (!current.current) { abort.abort(); releaseDocumentTask.current?.(); releaseDocumentTask.current = null; }
    }
  }, [cache, closeDocument, controller, finishPending, paper.entityId, refreshCache, scope, versions]);

  const loadCached = useCallback(async (version: PdfVersion) => {
    opening.current.beginExplicitOpen();
    await runTask('正在打开 PDF', async (task) => {
      await finishPending(); task.check();
      const bytes = await cache.read(scope, version); task.check();
      if (!bytes) { closeDocument(); setPanel('source'); setNotice('此版本尚未保存在本机。请选择相同文件，或读取它的公开 PDF 链接。'); return; }
      const source = (await cache.list(scope)).find((entry) => entry.versionId === version.entityId)?.sourceUrl;
      task.check(); if (source) setSourceUrl(source);
      await openBytes(bytes, version.data.fileName, version, source, task);
    });
  }, [cache, closeDocument, finishPending, openBytes, runTask, scope]);

  useEffect(() => {
    mounted.current = true;
    void refreshCache().catch((failure) => { if (mounted.current) setError(errorMessage(failure)); });
    return () => {
      mounted.current = false; epoch.current++; taskAbort.current?.abort(); documentAbort.current?.abort();
      releaseDocumentTask.current?.(); releaseDocumentTask.current = null;
      writer.current?.stop(); void current.current?.pdf.close(); activeBytes.current = null;
    };
  }, [scopeKey]);

  const dirty = Boolean(commentDraft && commentDraft.comment !== commentDraft.saved)
    || annotationSaving || positionStatus === 'saving' || positionStatus === 'error';
  useEffect(() => { props.onDirtyChange?.(dirty); }, [dirty, props.onDirtyChange]);

  useInitialPdfRestore(opening.current, versions, selectedVersionId, Boolean(jumpTo), (initial) => {
    setSelectedVersionId(initial.entityId); void loadCached(initial);
  });

  useEffect(() => {
    const draft = draftRef.current;
    if (!draft || draft.comment === draft.saved) return;
    setCommentStatus('saving');
    const timer = setTimeout(() => { void saveComment().catch(() => undefined); }, 450);
    return () => clearTimeout(timer);
  }, [commentDraft?.comment, commentDraft?.saved, saveComment]);

  useEffect(() => {
    const persist = () => { if (document.visibilityState === 'hidden') void finishPending().catch(() => undefined); };
    const pagehide = () => { void finishPending().catch(() => undefined); };
    const beforeunload = (event: BeforeUnloadEvent) => {
      if (draftRef.current && draftRef.current.comment !== draftRef.current.saved) { event.preventDefault(); event.returnValue = ''; }
    };
    document.addEventListener('visibilitychange', persist); window.addEventListener('pagehide', pagehide);
    window.addEventListener('beforeunload', beforeunload);
    return () => { document.removeEventListener('visibilitychange', persist); window.removeEventListener('pagehide', pagehide); window.removeEventListener('beforeunload', beforeunload); };
  }, [finishPending]);

  useLayoutEffect(() => {
    if (!scroll.current || !loaded) return;
    const element = scroll.current;
    const measure = () => setFitWidth(Math.max(160, element.clientWidth - 32));
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [loaded, panel]);

  const layout = useMemo(() => {
    const offsets: number[] = []; const heights: number[] = []; let total = 0;
    if (loaded) for (let index = 0; index < loaded.pdf.pageCount; index++) {
      offsets.push(total); const height = pageDisplaySize(loaded.pdf, index, fitWidth, zoom, rotation).height;
      heights.push(height); total += height + 24;
    }
    return { offsets, heights, total: Math.max(0, total - 24) };
  }, [loaded, fitWidth, zoom, rotation]);

  const goTo = useCallback((index: number, offsetRatio = 0) => {
    if (!loaded || !Number.isInteger(index) || index < 0 || index >= loaded.pdf.pageCount) return;
    const point = { pageIndex: index, offsetRatio: Math.max(0, Math.min(1, offsetRatio)) };
    currentPoint.current = point; setPageIndex(index); setSelection(null); setFocus(null); writer.current?.record(point);
    if (scroll.current) scroll.current.scrollTop = (continuous ? layout.offsets[index] : 0) + point.offsetRatio * layout.heights[index];
  }, [continuous, layout, loaded]);

  useLayoutEffect(() => {
    if (!loaded || !scroll.current) return;
    const point = currentPoint.current;
    scroll.current.scrollTop = (continuous ? layout.offsets[point.pageIndex] : 0) + point.offsetRatio * layout.heights[point.pageIndex];
  }, [loaded, layout, continuous, pageIndex]);
  useEffect(() => setPageInput(String(pageIndex + 1)), [pageIndex]);

  useEffect(() => {
    if (!jumpTo || seenJump.current === jumpTo.requestId) return;
    seenJump.current = jumpTo.requestId;
    const version = versions.find((entry) => entry.entityId === jumpTo.attachmentVersionId);
    if (!version || version.data.sha256 !== jumpTo.sha256 || !Number.isInteger(jumpTo.pageIndex) || jumpTo.pageIndex < 0
      || (version.data.pageCount !== null && jumpTo.pageIndex >= version.data.pageCount)
      || (jumpTo.quads && (jumpTo.quads.length > 200 || jumpTo.quads.some((quad) => quad.length !== 8
        || quad.some((value) => !Number.isFinite(value) || value < 0 || value > 1))))) {
      setError(new PdfError('VERSION_MISMATCH').message); return;
    }
    if (loaded?.version.entityId === version.entityId) { goTo(jumpTo.pageIndex); setFocus(jumpTo); }
    else { pendingJump.current = jumpTo; setSelectedVersionId(version.entityId); void loadCached(version); }
  }, [jumpTo, versions, loaded, goTo, loadCached]);

  useEffect(() => {
    if (!focus || !loaded || focus.pageIndex !== pageIndex || !focus.quads?.length || !scroll.current) return;
    let active = true;
    void loaded.pdf.page(pageIndex).then((page) => {
      if (!active || !scroll.current) return;
      const size = pageDisplaySize(loaded.pdf, pageIndex, fitWidth, zoom, rotation);
      const viewport = page.getViewport({ scale: size.scale, rotation: (page.rotate + rotation) % 360 });
      const bounds = quadBounds(focus.quads![0], loaded.pdf.pages[pageIndex].cropBox, viewport);
      const offset = Math.max(0, bounds.top - 48);
      scroll.current.scrollTop = (continuous ? layout.offsets[pageIndex] : 0) + offset;
    }).catch(() => undefined);
    return () => { active = false; };
  }, [focus, loaded, pageIndex, fitWidth, zoom, rotation, continuous, layout]);

  const onScroll = () => {
    if (!loaded || !scroll.current) return;
    const top = Math.max(0, scroll.current.scrollTop);
    let index = pageIndex;
    if (continuous) {
      let low = 0; let high = layout.offsets.length - 1;
      while (low < high) { const middle = Math.ceil((low + high) / 2); if (layout.offsets[middle] <= top + 1) low = middle; else high = middle - 1; }
      index = low;
    }
    const point = { pageIndex: index, offsetRatio: Math.max(0, Math.min(1, (top - (continuous ? layout.offsets[index] : 0)) / layout.heights[index])) };
    currentPoint.current = point;
    if (index !== pageIndex) { setPageIndex(index); setSelection(null); }
    writer.current?.record(point);
  };

  const changeVersion = async (id: string) => {
    opening.current.beginExplicitOpen();
    try { await finishPending(); }
    catch (failure) { setError(errorMessage(failure)); return; }
    taskAbort.current?.abort(); setSelectedVersionId(id); setProbe(null); setSourceUrl('');
    const version = versions.find((entry) => entry.entityId === id);
    if (version) await loadCached(version);
    else { closeDocument(); setPanel('source'); setNotice(null); }
  };

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    // Claim before reading or publishing metadata: a newly saved first version must
    // never start a second restoration task while this import is still caching bytes.
    opening.current.beginExplicitOpen();
    const expected = versions.find((entry) => entry.entityId === selectedVersionId);
    void runTask('正在核对 PDF', async (task) => {
      const bytes = await readLocalPdf(file, { signal: task.signal, onProgress: (done, total) => setProgress({ loaded: done, total }) });
      task.check(); await openBytes(bytes, file.name, expected, undefined, task);
    });
  };

  const inspectSource = () => void runTask('正在检查链接', async (task) => {
    const found = await inspectPublicPdf(sourceUrl, { signal: task.signal }); task.check(); setProbe(found);
  });
  const downloadSource = () => {
    if (!probe) return;
    opening.current.beginExplicitOpen();
    const source = probe; const expected = versions.find((entry) => entry.entityId === selectedVersionId);
    void runTask('正在读取 PDF', async (task) => {
      const bytes = await downloadPublicPdf(source, { signal: task.signal,
        onProgress: (done, total) => { if (!task.signal.aborted) setProgress({ loaded: done, total }); } });
      task.check(); await openBytes(bytes, source.fileName, expected, source.url, task);
    });
  };

  const addAnnotation = async (kind: AnnotationData['kind'], anchor = selection) => {
    if (!anchor || !loaded || annotationSaving) return;
    let identity: ReaderIdentity | undefined; const version = loaded.version;
    setAnnotationSaving(true); setError(null);
    try {
      identity = readerIdentity(controller, scope);
      const data: AnnotationData = { paperId: paper.entityId, attachmentVersionId: version.entityId,
        kind, color: annotationColor, comment: '', anchor };
      await controller.save({ entityType: 'annotation', entityId: crypto.randomUUID(), mutation: 'put', data }, 0);
      if (mounted.current && sameReaderIdentity(controller, identity) && current.current?.version.entityId === version.entityId) {
        setSelection(null); setAreaMode(false); globalThis.getSelection()?.removeAllRanges(); setNotice('批注已保存，联网后同步。');
      }
    } catch (failure) { if (mounted.current && (!identity || sameReaderIdentity(controller, identity))) setError(errorMessage(failure)); }
    finally { if (mounted.current) setAnnotationSaving(false); }
  };

  const selectAnnotation = async (record: VisibleEntity) => {
    const reading = current.current;
    if (!reading) return;
    try { await saveComment(); }
    catch { return; }
    if (!mounted.current || current.current !== reading) return;
    const data = record.data as AnnotationData;
    goTo(data.anchor.pageIndex); setFocus({ requestId: crypto.randomUUID(), attachmentVersionId: data.attachmentVersionId,
      sha256: reading.version.data.sha256, pageIndex: data.anchor.pageIndex, quads: data.anchor.quads });
    const draft = { entityId: record.entityId, revision: record.revision, data, comment: data.comment, saved: data.comment };
    draftRef.current = draft; setCommentDraft(draft); setCommentStatus('idle');
  };

  const deleteAnnotation = async (record: VisibleEntity) => {
    if (!window.confirm('删除这条批注？')) return;
    setAnnotationSaving(true);
    try {
      const identity = readerIdentity(controller, scope);
      await saveComment();
      if (!sameReaderIdentity(controller, identity) || !mounted.current) throw new PdfError('ACCOUNT_CHANGED');
      const latest = getVisibleEntity(controller.getSnapshot().workspace!.sync, 'annotation', record.entityId);
      if (!latest || latest.deleted) throw new PdfError('ANNOTATION_CHANGED');
      await controller.save({ entityType: 'annotation', entityId: record.entityId, mutation: 'delete', data: null }, latest.revision);
      if (!sameReaderIdentity(controller, identity) || !mounted.current) return;
      if (draftRef.current?.entityId === record.entityId) { draftRef.current = null; setCommentDraft(null); }
      setNotice('批注已删除，联网后同步。');
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { if (mounted.current) setAnnotationSaving(false); }
  };

  const ask = (kind: PdfAiContext['scope']) => {
    if (!loaded || !onAskAi) return;
    const reading = loaded; const anchor = selection;
    void runTask('正在准备原文', async (task) => {
      let pages: PdfAiContext['pages'];
      if (kind === 'selection') {
        if (!anchor?.quote?.exact) throw new PdfError('NO_TEXT');
        pages = [{ pageIndex: anchor.pageIndex, text: anchor.quote.exact, anchor }];
      } else if (kind === 'page') {
        const text = await reading.pdf.text(pageIndex, task.signal); if (!text) throw new PdfError('NO_TEXT');
        pages = [{ pageIndex, text }];
      } else pages = await reading.pdf.documentText(task.signal);
      task.check();
      if (current.current !== reading) throw new PdfError('VERSION_MISMATCH');
      onAskAi({ paperId: paper.entityId, attachmentVersionId: reading.version.entityId, sha256: reading.version.data.sha256,
        scope: kind, totalPages: reading.pdf.pageCount, pages, complete: true,
        label: kind === 'document' ? `${reading.version.data.fileName} · 全文` : `第 ${(kind === 'selection' ? anchor!.pageIndex : pageIndex) + 1} 页${kind === 'selection' ? '选段' : ''}` });
    });
  };

  const runSearch = () => {
    if (!loaded) return;
    const reading = loaded;
    void runTask('正在搜索原文', async (task) => {
      const result = await reading.pdf.search(searchQuery, task.signal); task.check();
      if (current.current !== reading) return;
      setSearchResults(result.matches); setSearchLimited(result.limited); setSearched(true);
    });
  };

  const changeCache = async (action: () => Promise<void>) => {
    try { await action(); await refreshCache(); }
    catch (failure) { setError(errorMessage(failure)); }
  };
  const togglePin = () => {
    if (!loaded) return;
    const item = loaded;
    void runTask('正在更新离线副本', async (task) => {
      task.check();
      if (cacheEntry) await cache.setPinned(scope, item.version.entityId, !cacheEntry.pinned);
      else if (activeBytes.current) await cache.put(scope, item.version, activeBytes.current, { pinned: true, signal: task.signal });
      task.check(); await refreshCache();
    });
  };
  const back = async () => {
    try { await finishPending(); props.onBack(); }
    catch (failure) { setError(errorMessage(failure)); }
  };
  const selectText = useCallback((anchor: AnnotationAnchor | null, index: number) => {
    setSelection((previous) => anchor ?? (previous?.pageIndex === index ? null : previous));
  }, []);
  const pageError = useCallback((failure: PdfError) => setError(failure.message), []);
  const renderedPages = loaded ? pageWindow(pageIndex, loaded.pdf.pageCount, continuous) : [];
  const firstPage = renderedPages[0] ?? 0; const lastPage = renderedPages[renderedPages.length - 1] ?? 0;
  const otherPositions = loaded ? props.positions.filter((record) => !record.deleted && record.data
    && (record.data as ReadingPositionData).attachmentVersionId === loaded.version.entityId
    && (record.data as ReadingPositionData).paperId === paper.entityId) : [];
  const state = controller.getSnapshot().workspace?.sync;
  const title = (paper.data as PaperData | null)?.title || '文献阅读';

  return <section className="pr-reader" aria-label="PDF 阅读器" onKeyDown={(event) => {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,button') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'PageDown') { event.preventDefault(); goTo(pageIndex + 1); }
    if (event.key === 'PageUp') { event.preventDefault(); goTo(pageIndex - 1); }
  }}>
    <header className="pr-heading">
      <button type="button" className="pr-icon-button" aria-label="返回文库" onClick={() => void back()}><Icon name="back" /></button>
      <div className="pr-title"><h2 title={title}>{title}</h2><p>{loaded ? `${loaded.pdf.pageCount} 页 · ${byteLabel(loaded.version.data.sizeBytes)}` : '选择 PDF 开始阅读'}</p></div>
      <button type="button" onClick={() => setPanel(panel === 'source' ? null : 'source')}>文件</button>
    </header>
    {loaded && <div className="pr-toolbar" role="toolbar" aria-label="阅读工具">
      <div className="pr-page-controls"><button type="button" aria-label="上一页" disabled={pageIndex === 0} onClick={() => goTo(pageIndex - 1)}>‹</button>
        <label><span className="pr-sr-only">页码</span><input inputMode="numeric" value={pageInput} aria-label="页码"
          onChange={(event) => setPageInput(event.target.value.replace(/\D/g, '').slice(0, 5))}
          onBlur={() => { goTo(Number(pageInput) - 1); setPageInput(String(currentPoint.current.pageIndex + 1)); }}
          onKeyDown={(event) => { if (event.key === 'Enter') { goTo(Number(pageInput) - 1); event.currentTarget.blur(); } }} /></label>
        <span>/ {loaded.pdf.pageCount}</span><button type="button" aria-label="下一页" disabled={pageIndex + 1 >= loaded.pdf.pageCount} onClick={() => goTo(pageIndex + 1)}>›</button></div>
      <label className="pr-control"><span className="pr-sr-only">缩放</span><select aria-label="缩放" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
        <option value={0.75}>75%</option><option value={1}>适合宽度</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option><option value={3}>300%</option>
      </select></label>
      <button type="button" onClick={() => { setSelection(null); setRotation((value) => (value + 90) % 360); }} aria-label={`旋转页面，当前 ${rotation} 度`}>旋转</button>
      <label className="pr-control"><span className="pr-sr-only">阅读模式</span><select aria-label="阅读模式" value={continuous ? 'continuous' : 'single'} onChange={(event) => setContinuous(event.target.value === 'continuous')}>
        <option value="continuous">连续</option><option value="single">分页</option></select></label>
      <button type="button" aria-pressed={panel === 'contents'} onClick={() => setPanel(panel === 'contents' ? null : 'contents')}>目录</button>
      <button type="button" aria-pressed={panel === 'search'} onClick={() => setPanel(panel === 'search' ? null : 'search')}>搜索</button>
      <button type="button" aria-pressed={panel === 'annotations'} onClick={() => setPanel(panel === 'annotations' ? null : 'annotations')}>批注 {annotationRecords.length || ''}</button>
    </div>}
    {(error || notice || busy) && <div className={`pr-feedback ${error ? 'pr-feedback-error' : ''}`} role={error ? 'alert' : 'status'}>
      <span>{busy ?? error ?? notice}{busy && progress ? ` · ${byteLabel(progress.loaded)}${progress.total !== null ? ` / ${byteLabel(progress.total)}` : ''}` : ''}</span>
      {busy ? <button type="button" onClick={() => taskAbort.current?.abort()}>取消</button>
        : <button type="button" aria-label="关闭提示" onClick={() => { setError(null); setNotice(null); }}>×</button>}
    </div>}
    <div className="pr-body">
      {panel && <aside className="pr-panel" aria-label={panel === 'source' ? 'PDF 文件' : panel === 'contents' ? '目录与阅读接续' : panel === 'search' ? '搜索原文' : panel === 'cache' ? '本机 PDF 缓存' : '批注清单'}>
        <div className="pr-panel-heading"><h3>{panel === 'source' ? 'PDF 文件' : panel === 'contents' ? '目录与阅读接续' : panel === 'search' ? '搜索原文' : panel === 'cache' ? '本机缓存' : '批注'}</h3>
          <button type="button" aria-label="关闭面板" onClick={() => setPanel(null)}>×</button></div>
        {panel === 'source' && <div className="pr-panel-content">
          <label>附件版本<select value={selectedVersionId} disabled={Boolean(busy)} onChange={(event) => void changeVersion(event.target.value)}>
            {versions.map((version) => <option key={version.entityId} value={version.entityId}>{version.data.fileName} · {version.data.sha256.slice(0, 8)}</option>)}
            <option value="">添加新版本</option></select></label>
          <p className="pr-muted">{selectedVersionId ? '选择与此版本一致的文件。不同文件可作为新版本添加，批注会分别保留。' : '文件只保留在当前设备。文库会同步版本信息、批注与阅读位置。'}</p>
          <input className="pr-file-input" type="file" accept="application/pdf,.pdf" ref={fileInput} onChange={chooseFile} tabIndex={-1} />
          <button type="button" className="pr-primary" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>选择本机 PDF</button>
          <div className="pr-divider" />
          <label>公开 PDF 链接<input type="url" value={sourceUrl} placeholder="https://…/paper.pdf" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            disabled={Boolean(busy)} onChange={(event) => { setSourceUrl(event.target.value); setProbe(null); }} /></label>
          <button type="button" disabled={Boolean(busy) || !sourceUrl.trim()} onClick={inspectSource}>检查链接</button>
          {probe && <div className="pr-source-result"><p>{probe.rangeSupported ? '来源支持分段读取。' : '来源不支持分段读取，需要下载完整文件。'}
            {' '}核对版本将读取{probe.sizeBytes === null ? '完整 PDF' : `完整文件（${byteLabel(probe.sizeBytes)}）`}。</p>
            <button type="button" className="pr-primary" disabled={Boolean(busy)} onClick={downloadSource}>读取完整 PDF 并打开</button></div>}
          <p className="pr-muted">网页链接、需要登录或不允许跨域读取的来源可能无法打开。可改选本机 PDF。</p>
          {loaded && <button type="button" onClick={togglePin}>{cacheEntry?.pinned ? '取消离线保留' : '保留此 PDF 供离线阅读'}</button>}
          <button type="button" onClick={() => { setPanel('cache'); void refreshCache().catch((failure) => setError(errorMessage(failure))); }}>查看与清理缓存</button>
        </div>}
        {panel === 'contents' && <div className="pr-panel-content">
          {otherPositions.length > 0 && <div className="pr-resume"><h4>从已保存的位置继续</h4>
            {otherPositions.map((record) => { const data = record.data as ReadingPositionData; const owner = state ? positionOwner(state, record.entityId) : null;
              const name = controller.getSnapshot().devices.find((device) => device.id === owner)?.name ?? (owner === state?.deviceId ? '此设备' : '其他设备');
              return <button type="button" key={record.entityId} onClick={() => { goTo(data.pageIndex, data.offsetRatio); setPanel(null); }}>{name} · 第 {data.pageIndex + 1} 页</button>; })}
          </div>}
          <h4>文档目录</h4>{outline.length ? <ol className="pr-outline">{outline.map((item, index) => <li key={index} style={{ paddingInlineStart: Math.min(item.depth, 6) * 12 }}>
            <button type="button" disabled={item.pageIndex === null} onClick={() => { if (item.pageIndex !== null) goTo(item.pageIndex); setPanel(null); }}>{item.title || '未命名章节'}
              {item.pageIndex !== null && <span>{item.pageIndex + 1}</span>}</button></li>)}</ol> : <p className="pr-muted">此 PDF 没有可用目录，可通过页码导航。</p>}
        </div>}
        {panel === 'search' && <div className="pr-panel-content"><form onSubmit={(event) => { event.preventDefault(); runSearch(); }}>
          <label>搜索原文<input value={searchQuery} maxLength={200} onChange={(event) => { setSearchQuery(event.target.value); setSearched(false); }} /></label>
          <button type="submit" disabled={Boolean(busy) || !searchQuery.trim()}>搜索</button></form>
          {searched && <p className="pr-muted">{searchLimited ? `显示前 ${PDF_LIMITS.maxSearchResults} 处结果` : `找到 ${searchResults.length} 处结果`}</p>}
          <ol className="pr-results">{searchResults.map((result, index) => <li key={`${result.pageIndex}:${result.offset}:${index}`}>
            <button type="button" onClick={() => { goTo(result.pageIndex); setPanel(null); }}><strong>第 {result.pageIndex + 1} 页</strong><span>{result.excerpt}</span></button></li>)}</ol>
        </div>}
        {panel === 'annotations' && <div className="pr-panel-content">
          <button type="button" aria-pressed={areaMode} onClick={() => { setAreaMode((value) => !value); setPanel(null); }}>{areaMode ? '退出区域批注' : '添加区域批注'}</button>
          {annotationRecords.length === 0 && <p className="pr-muted">选择原文可添加高亮或下划线，也可框选图表区域。</p>}
          <ol className="pr-annotation-list">{annotationRecords.map((record) => { const data = record.data as AnnotationData;
            return <li key={record.entityId}><button type="button" onClick={() => void selectAnnotation(record)}>
              <span className="pr-annotation-kind" style={{ borderColor: data.color }}>{labelForKind(data.kind)} · 第 {data.anchor.pageIndex + 1} 页</span>
              <span>{data.anchor.quote?.exact.slice(0, 220) || '框选区域'}</span>{data.comment && <small>{data.comment.slice(0, 180)}</small>}</button>
              <button type="button" className="pr-delete-annotation" aria-label={`删除第 ${data.anchor.pageIndex + 1} 页批注`} onClick={() => void deleteAnnotation(record)}><Icon name="trash" /></button>
            </li>; })}</ol>
          {commentDraft && <div className="pr-comment"><label>批注内容<textarea value={commentDraft.comment} maxLength={262144} rows={5}
            onChange={(event) => { const next = { ...commentDraft, comment: event.target.value }; draftRef.current = next; setCommentDraft(next); }}
            onBlur={() => { void saveComment().catch(() => undefined); }} /></label>
            <span role="status">{commentStatus === 'saving' ? '正在保存…' : commentStatus === 'saved' ? '已保存' : commentStatus === 'error' ? '尚未保存' : '内容会自动保存'}</span>
            {commentStatus === 'error' && <button type="button" onClick={() => { void saveComment().catch(() => undefined); }}>重试保存</button>}
          </div>}
        </div>}
        {panel === 'cache' && <div className="pr-panel-content"><p className="pr-muted">此账号在本机保留 {byteLabel(cacheEntries.reduce((total, entry) => total + entry.sizeBytes, 0))}。清理缓存不会删除原文件、文库记录或批注。</p>
          <button type="button" onClick={() => void changeCache(() => cache.clear(scope))}>清理临时缓存</button>
          <ul className="pr-cache-list">{cacheEntries.map((entry) => <li key={entry.versionId}><strong>{entry.fileName}</strong><span>{byteLabel(entry.sizeBytes)} · {entry.pinned ? '离线保留' : '临时缓存'}</span>
            <div><button type="button" onClick={() => void changeCache(() => cache.setPinned(scope, entry.versionId, !entry.pinned))}>{entry.pinned ? '取消保留' : '离线保留'}</button>
              <button type="button" onClick={() => { if (window.confirm(`清理「${entry.fileName}」的本机副本？`)) void changeCache(() => cache.remove(scope, entry.versionId)); }}>清理</button></div></li>)}</ul>
          {cacheEntries.length === 0 && <p>还没有 PDF 缓存。</p>}
        </div>}
      </aside>}
      {loaded ? <div ref={scroll} className="pr-scroll" onScroll={onScroll} tabIndex={0} aria-label="PDF 页面">
        <div className="pr-pages" style={{ width: Math.max(fitWidth + 32, fitWidth * zoom + 32) }}>
          {continuous && firstPage > 0 && <div aria-hidden="true" style={{ height: layout.offsets[firstPage] }} />}
          {renderedPages.map((index) => <div key={`${loaded.version.entityId}:${index}`} className="pr-page-slot" style={{ height: layout.heights[index], marginBottom: index < loaded.pdf.pageCount - 1 && continuous ? 24 : 0 }}>
            <PdfPageView pdf={loaded.pdf} runtime={loaded.runtime} pageIndex={index} fitWidth={fitWidth} zoom={zoom} rotation={rotation}
              annotations={annotationRecords.filter((record) => (record.data as AnnotationData).anchor.pageIndex === index).map((record) => ({ entityId: record.entityId, data: record.data as AnnotationData }))}
              focusQuads={focus?.pageIndex === index ? focus.quads : undefined} areaMode={areaMode}
              onSelection={selectText} onArea={(anchor) => { void addAnnotation('area', anchor); }} onError={pageError} />
          </div>)}
          {continuous && lastPage < loaded.pdf.pageCount - 1 && <div aria-hidden="true" style={{ height: Math.max(0, layout.total - layout.offsets[lastPage] - layout.heights[lastPage] - 24) }} />}
        </div>
      </div> : <div className="pr-empty"><Icon name="note" /><h3>打开这篇文献的 PDF</h3><p>选择本机文件，或获取公开全文链接。核对完成后即可阅读、批注和继续上次的位置。</p>
        <button type="button" className="pr-primary" onClick={() => setPanel('source')}>选择 PDF</button></div>}
    </div>
    {loaded && <footer className="pr-footer">
      {selection ? <div className="pr-selection-tools" onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}><span>已选 {selection.quote?.exact.length ?? 0} 字</span>
        <button type="button" disabled={annotationSaving} onClick={() => void addAnnotation('highlight')}>高亮</button>
        <button type="button" disabled={annotationSaving} onClick={() => void addAnnotation('underline')}>下划线</button>
        {onAskAi && <button type="button" disabled={Boolean(busy)} onClick={() => ask('selection')}>选段提问</button>}
        <label className="pr-color-label">颜色<input aria-label="批注颜色" type="color" value={annotationColor} onChange={(event) => setAnnotationColor(event.target.value)} /></label>
      </div> : areaMode ? <div className="pr-selection-tools"><span>在页面上拖动框选区域</span><button type="button" onClick={() => setAreaMode(false)}>完成</button></div>
        : <div className="pr-reading-status"><span role="status">{positionStatus === 'saving' ? '正在保存位置…' : positionStatus === 'saved' ? '位置已保存' : positionStatus === 'error' ? '位置尚未保存' : '阅读位置保存在此设备'}</span>
          {positionStatus === 'error' && <button type="button" onClick={() => { void writer.current?.flush().catch((failure) => setError(errorMessage(failure))); }}>重试</button>}
          {onAskAi && <div><button type="button" disabled={Boolean(busy)} onClick={() => ask('page')}>询问本页</button><button type="button" disabled={Boolean(busy)} onClick={() => ask('document')}>询问全文</button></div>}
        </div>}
    </footer>}
  </section>;
}
