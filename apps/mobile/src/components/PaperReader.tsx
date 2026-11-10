import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import {
  getVisibleEntity, listVisibleEntities, type AnnotationAnchor, type AnnotationData, type AttachmentVersionData,
  type PaperData, type ReadingPositionData, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import { accountScopeKey } from '../storage/accountStore.ts';
import { ClientError, describeError } from '../errors.ts';
import { Icon } from './Icon.tsx';
import { ReaderSheet } from './ReaderSheet.tsx';
import { CloudPdfPanel } from './CloudPdfPanel.tsx';
import { PdfSourceAttempts } from './PdfSourceAttempts.tsx';
import { CloudPdfError, describeCloudPdfError, downloadCloudPdfCopy } from '../pdf/cloudCopies.ts';
import { DesktopPdfError } from '../pdf/desktopCopies.ts';
import { describePdfSourceError, resolvePdfSource, type CloudPdfUnavailableReason, type DesktopPdfUnavailableReason, type PdfSourceAttempt } from '../pdf/sourceResolver.ts';
import { assertPdfTarget, capturePdfVersion, pdfVersionWriteGuard } from '../pdf/versionGuard.ts';
import { guardedPdfFetch } from '../pdf/guardedFetch.ts';
import { ReaderTapGesture, captureReaderZoomAnchor, restoreReaderZoomAnchor,
  type ReaderPointer, type ReaderTapPoint, type ReaderZoomAnchor } from './readerGestures.ts';
import { getPdfCache } from '../pdf/cache.ts';
import { registerPdfTask, waitForPdfTask } from '../pdf/tasks.ts';
import { InitialPdfOpening, useInitialPdfRestore } from '../pdf/opening.ts';
import { useReaderDirty } from '../pdf/dirty.ts';
import { downloadPublicPdf, inspectPublicPdf, readLocalPdf, safePdfName, type PdfSourceProbe } from '../pdf/acquisition.ts';
import { openVerifiedPdf, type PdfOutlineItem, type PdfRuntime, type PdfSearchMatch, type VerifiedPdf } from '../pdf/engine.ts';
import { PdfError, throwIfAborted } from '../pdf/errors.ts';
import { pageWindow, quadBounds } from '../pdf/geometry.ts';
import { PdfPageView, pageDisplaySize } from '../pdf/PdfPageView.tsx';
import {PdfPaperAppearanceControl} from '../pdf/PdfPaperAppearanceControl.tsx';
import {readPdfPaperAppearance, writePdfPaperAppearance} from '../pdf/pdfPaperAppearance.ts';
import { ownReadingPosition, positionOwner, readerIdentity, ReadingCheckpointWriter, sameReaderIdentity,
  type PositionStatus, type ReaderIdentity, type ReadingPoint } from '../pdf/position.ts';
import { PDF_LIMITS, type PaperReaderProps, type PdfAiContext, type PdfCacheEntry, type PdfCitationTarget, type PdfVersion } from '../pdf/types.ts';

const ParsedDocumentPanel = lazy(() => import('./ParsedDocumentPanel.tsx'));
type Panel = 'source' | 'contents' | 'search' | 'annotations' | 'cache' | 'cloud' | 'parsed' | 'more' | 'page' | 'ask' | null;
interface Loaded { pdf: VerifiedPdf; version: PdfVersion; runtime: PdfRuntime; identity: ReaderIdentity }
interface Task { epoch: number; signal: AbortSignal; identity: ReaderIdentity; check: () => void }
interface CommentDraft { entityId: string; revision: number; data: AnnotationData; comment: string; saved: string }
const byteLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const errorMessage = (error: unknown) => error instanceof CloudPdfError ? describeCloudPdfError(error)
  : error instanceof DesktopPdfError ? new DesktopPdfError(error.code).message
    : error instanceof PdfError ? error.message : describeError(error);
const labelForKind = (kind: AnnotationData['kind']) => kind === 'highlight' ? '高亮' : kind === 'underline' ? '下划线' : '区域';
const panelTitles: Record<NonNullable<Panel>, string> = { source: 'PDF 文件', contents: '目录与阅读接续', search: '搜索原文',
  annotations: '批注', cache: '本机缓存', cloud: '私有云 PDF', parsed: '解析阅读', more: '阅读选项', page: '跳转页面', ask: '阅读 AI' };

function ReaderPanel({ compact, title, onClose, children }: { compact: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (compact) return <ReaderSheet open title={title} onClose={onClose} className="pr-reader-sheet">{children}</ReaderSheet>;
  return <aside className="pr-panel" aria-label={title}>
    <div className="pr-panel-heading"><h3>{title}</h3><button type="button" aria-label="关闭面板" onClick={onClose}>×</button></div>
    {children}
  </aside>;
}

function versionsFor(paperId: string, records: VisibleEntity[]): PdfVersion[] {
  return records.filter((record) => record.entityType === 'attachmentVersion' && !record.deleted && record.data
    && (record.data as AttachmentVersionData).paperId === paperId)
    .map((record) => capturePdfVersion({ entityId: record.entityId, data: record.data as AttachmentVersionData }));
}

interface ReaderFocusViewport {
  focus: PdfCitationTarget | null;
  pdf: VerifiedPdf | null;
  pageIndex: number;
  fitWidth: number;
  zoom: number;
  rotation: number;
  continuous: boolean;
  offsets: number[];
  contentTop?: number;
  topInset?: number;
  scroll: { readonly current: HTMLDivElement | null };
}

/** A citation scrolls once; its highlight can remain through later user zooms and resizes. */
export function useReaderFocusPosition({ focus, pdf, pageIndex, fitWidth, zoom, rotation, continuous, offsets,
  contentTop = 0, topInset = 48, scroll }: ReaderFocusViewport) {
  const positioned = useRef<{ pdf: VerifiedPdf; requestId: string } | null>(null);
  useEffect(() => {
    if (!pdf) { positioned.current = null; return; }
    const container = scroll.current;
    if (!focus || focus.pageIndex !== pageIndex || !focus.quads?.length || !container
      || (positioned.current?.pdf === pdf && positioned.current.requestId === focus.requestId)) return;
    let active = true;
    void pdf.page(pageIndex).then((page) => {
      if (!active || scroll.current !== container) return;
      const size = pageDisplaySize(pdf, pageIndex, fitWidth, zoom, rotation);
      const viewport = page.getViewport({ scale: size.scale, rotation: (page.rotate + rotation) % 360 });
      const bounds = quadBounds(focus.quads![0], pdf.pages[pageIndex].cropBox, viewport);
      container.scrollTop = (continuous ? offsets[pageIndex] : 0) + Math.max(0, contentTop + bounds.top - topInset);
      // Failed, replaced or interrupted page loads must not consume the navigation request.
      positioned.current = { pdf, requestId: focus.requestId };
    }).catch(() => undefined);
    return () => { active = false; };
  }, [focus, pdf, pageIndex, fitWidth, zoom, rotation, continuous, offsets, contentTop, topInset, scroll]);
}

export function PaperReader(props: PaperReaderProps) {
  const { scope, paper, controller, onAskAi, jumpTo, compact = false } = props;
  const scopeKey = accountScopeKey(scope);
  const versions = useMemo(() => versionsFor(paper.entityId, props.attachmentVersions), [paper.entityId, props.attachmentVersions]);
  const [selectedVersionId, setSelectedVersionId] = useState(() => versions[0]?.entityId ?? '');
  const cloudVersion = versions.find((version) => version.entityId === selectedVersionId);
  const cloudVersionRecord = props.attachmentVersions.find((record) => record.entityId === selectedVersionId && !record.deleted);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [panel, setPanel] = useState<Panel>('source');
  const [toolsVisible, setToolsVisible] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [probe, setProbe] = useState<PdfSourceProbe | null>(null);
  const [sourceAttempts, setSourceAttempts] = useState<PdfSourceAttempt[]>([]);
  const [cacheEntries, setCacheEntries] = useState<PdfCacheEntry[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [paperAppearance, setPaperAppearance] = useState(readPdfPaperAppearance);
  const [rotation, setRotation] = useState(0);
  const [continuous, setContinuous] = useState(true);
  const [fitWidth, setFitWidth] = useState(640);
  const [chromeInsets, setChromeInsets] = useState({ top: 68, bottom: 132 });
  const liveChromeInsets = useRef(chromeInsets); liveChromeInsets.current = chromeInsets;
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
  const readerRoot = useRef<HTMLElement>(null);
  const heading = useRef<HTMLElement>(null);
  const footer = useRef<HTMLElement>(null);
  const pageIndicator = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pendingZoom = useRef<ReaderZoomAnchor | null>(null);
  const positionedDocument = useRef<VerifiedPdf | null>(null);
  const measuredWidth = useRef(640);
  const gestures = useRef(new ReaderTapGesture({ allowed: () => false, tap: () => undefined, doubleTap: () => undefined }));
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const liveScope = useRef(scopeKey); liveScope.current = scopeKey;
  const epoch = useRef(0);
  const taskAbort = useRef<AbortController | null>(null);
  const activeReadTarget = useRef<{ epoch: number; check: () => void } | null>(null);
  const documentAbort = useRef<AbortController | null>(null);
  const releaseDocumentTask = useRef<(() => void) | null>(null);
  const invalidateContext = useRef(props.onContextInvalidated); invalidateContext.current = props.onContextInvalidated;
  const mobilePanelOpen = useRef(props.onMobilePanelOpen); mobilePanelOpen.current = props.onMobilePanelOpen;
  const compactView = useRef(compact); compactView.current = compact;
  const current = useRef<Loaded | null>(null);
  const activeBytes = useRef<Uint8Array | null>(null);
  const writer = useRef<ReadingCheckpointWriter | null>(null);
  const currentPoint = useRef<ReadingPoint>({ pageIndex: 0, offsetRatio: 0 });
  const pendingJump = useRef<PdfCitationTarget | null>(null);
  const seenJump = useRef<string | null>(null);
  const opening = useRef(new InitialPdfOpening());
  const draftRef = useRef<CommentDraft | null>(null);
  const commentWork = useRef<Promise<void> | null>(null);
  const dirty = useReaderDirty(props.onDirtyChange);
  const updateCommentDraft = useCallback((draft: CommentDraft | null) => {
    draftRef.current = draft; dirty.setComment(draft); setCommentDraft(draft);
  }, [dirty]);
  const updatePositionStatus = useCallback((status: PositionStatus) => {
    dirty.setPosition(status); setPositionStatus(status);
  }, [dirty]);
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
    pendingZoom.current = null; positionedDocument.current = null;
    void current.current?.pdf.close(); current.current = null;
    setLoaded(null); setSelection(null); setFocus(null); setOutline([]); setSearchResults([]); setSearched(false);
    setAreaMode(false); updatePositionStatus('idle');
  }, [updatePositionStatus]);

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
        || (props.accountCurrent && !props.accountCurrent())
        || controller.getSnapshot().status !== 'ready' || !sameReaderIdentity(controller, identity)) throw new PdfError('ACCOUNT_CHANGED');
    };
    setBusy(label); setProgress(null); setError(null); setNotice(null);
    try { check(); await waitForPdfTask(abort.signal, () => work({ epoch: taskEpoch, signal: abort.signal, identity, check })); }
    catch (failure) {
      if (mounted.current && epoch.current === taskEpoch && liveScope.current === scopeKey) {
        const reason = abort.signal.aborted
          ? abort.signal.reason instanceof PdfError || abort.signal.reason instanceof ClientError
            ? abort.signal.reason : new PdfError('CANCELLED')
          : failure;
        setError(errorMessage(reason));
        setSourceAttempts((items) => items.map((item) => item.status === 'pending'
          ? { ...item, status: 'skipped', code: 'NOT_ATTEMPTED', message: '本次检查已停止，未尝试此来源。' }
          : ['checking', 'downloading', 'verifying'].includes(item.status)
            ? { ...item, status: 'failed', ...describePdfSourceError(reason, item.source) } : item));
      }
    }
    finally {
      release();
      if (activeReadTarget.current?.epoch === taskEpoch) activeReadTarget.current = null;
      if (mounted.current && epoch.current === taskEpoch && liveScope.current === scopeKey) {
        setBusy(null); setProgress(null); taskAbort.current = null;
      }
    }
  }, [controller, scope, scopeKey, props.accountCurrent]);

  const targetTask = useCallback((task: Task, expected?: PdfVersion): Task => {
    const captured = expected && capturePdfVersion(expected);
    const check = () => { task.check(); assertPdfTarget(controller.getSnapshot().workspace?.sync, paper.entityId, captured); };
    check(); activeReadTarget.current = { epoch: task.epoch, check };
    return { ...task, check };
  }, [controller, paper.entityId]);

  const saveComment = useCallback(async () => {
    if (commentWork.current) { await commentWork.current; return; }
    if (!draftRef.current || draftRef.current.comment === draftRef.current.saved) return;
    const identity = readerIdentity(controller, scope);
    const finishSave = dirty.beginSave('comment');
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
        // Advance only the saved base; edits made during the write remain the current draft.
        const value = draftRef.current;
        if (value?.entityId === draft.entityId) updateCommentDraft({ ...value, saved: draft.comment, revision: visible.revision });
      }
      if (mounted.current) setCommentStatus('saved');
    })();
    commentWork.current = work;
    try { await work; }
    catch (failure) { if (mounted.current && liveScope.current === scopeKey) { setCommentStatus('error'); setError(errorMessage(failure)); } throw failure; }
    finally { if (commentWork.current === work) commentWork.current = null; finishSave(); }
  }, [controller, dirty, scope, scopeKey, updateCommentDraft]);

  const finishPending = useCallback(async () => { await saveComment(); await writer.current?.flush(); }, [saveComment]);

  const openBytes = useCallback(async (bytes: Uint8Array, fileName: string, expected: PdfVersion | undefined,
    source: string | undefined, task: Task) => {
    task.check(); await finishPending(); task.check(); closeDocument();
    const abort = new AbortController(); documentAbort.current = abort;
    const releaseDocument = registerPdfTask(scope, abort); releaseDocumentTask.current = releaseDocument;
    const cancel = () => abort.abort(); task.signal.addEventListener('abort', cancel, { once: true });
    let pdf: VerifiedPdf | null = null;
    let adopted = false;
    try {
      const { browserPdfRuntime } = await import('../pdf/browserRuntime.ts'); task.check();
      const runtime = browserPdfRuntime();
      pdf = await openVerifiedPdf(bytes, { expected, signal: abort.signal, runtime }); task.check();
      const sync = controller.getSnapshot().workspace!.sync;
      assertPdfTarget(sync, paper.entityId, expected, pdf.pageCount);
      const liveVersions = versionsFor(paper.entityId, listVisibleEntities(sync, 'attachmentVersion'));
      const known = liveVersions.find((version) => version.data.sha256 === pdf!.sha256 && version.data.sizeBytes === pdf!.sizeBytes);
      const existing = expected ?? known;
      const record = existing && assertPdfTarget(sync, paper.entityId, existing, pdf.pageCount);
      let version: PdfVersion = record?.data
        ? capturePdfVersion({ entityId: record.entityId, data: record.data as AttachmentVersionData })
        : { entityId: crypto.randomUUID(), data: {
        paperId: paper.entityId, attachmentId: liveVersions[0]?.data.attachmentId ?? crypto.randomUUID(),
        sha256: pdf.sha256, sizeBytes: pdf.sizeBytes, mediaType: 'application/pdf',
        fileName: safePdfName(fileName), pageCount: pdf.pageCount,
      } };
      if (version.data.pageCount !== null && version.data.pageCount !== pdf.pageCount) throw new PdfError('VERSION_MISMATCH');
      if (!existing || version.data.pageCount === null) {
        const beforeCommit = pdfVersionWriteGuard(paper.entityId, existing ? version : undefined, version.entityId);
        version = { ...version, data: { ...version.data, pageCount: pdf.pageCount } };
        task.check();
        await controller.save({ entityType: 'attachmentVersion', entityId: version.entityId, mutation: 'put', data: version.data }, record?.revision ?? 0,
          (transactionState) => {
            try { task.check(); } catch { throw new ClientError('EDIT_CHANGED'); }
            beforeCommit(transactionState);
          });
        task.check();
      }
      const live = assertPdfTarget(controller.getSnapshot().workspace?.sync, paper.entityId, version, pdf.pageCount)!;
      version = capturePdfVersion({ entityId: live.entityId, data: { ...live.data as AttachmentVersionData, pageCount: pdf.pageCount } });
      // From this point every continuation also guards a just-created or newly discovered version.
      task = targetTask(task, version);
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
      const result = { pdf, version, runtime, identity: task.identity }; current.current = result; activeBytes.current = bytes;
      adopted = true; pdf = null;
      writer.current = new ReadingCheckpointWriter(controller, scope, version, {
        onStatus: (status) => { if (mounted.current && current.current === result && sameReaderIdentity(controller, task.identity)) updatePositionStatus(status); },
      });
      currentPoint.current = point; setPageIndex(point.pageIndex); setLoaded(result); setSelectedVersionId(version.entityId);
      setPanel(null); setSelection(null); setToolsVisible(true); updateCommentDraft(null); setCommentStatus('idle');
      writer.current.record(point);
      void result.pdf.outline(abort.signal).then((items) => { if (current.current === result && mounted.current) setOutline(items); }).catch(() => undefined);
      void refreshCache().catch(() => undefined);
    } finally {
      task.signal.removeEventListener('abort', cancel);
      if (pdf) await pdf.close();
      if (!adopted) {
        abort.abort(); releaseDocument();
        if (documentAbort.current === abort) documentAbort.current = null;
        if (releaseDocumentTask.current === releaseDocument) releaseDocumentTask.current = null;
      }
    }
  }, [cache, closeDocument, controller, finishPending, paper.entityId, refreshCache, scope, targetTask, updateCommentDraft, updatePositionStatus]);

  const loadCached = useCallback(async (version: PdfVersion) => {
    opening.current.beginExplicitOpen();
    const captured = capturePdfVersion(version);
    await runTask('正在打开 PDF', async (baseTask) => {
      const task = targetTask(baseTask, captured);
      await finishPending(); task.check();
      const bytes = await cache.read(scope, captured); task.check();
      if (!bytes) { closeDocument(); setPanel('source'); setNotice('此版本尚未保存在本机。可从可用来源打开，或选择相同的本机 PDF。'); return; }
      const source = (await cache.list(scope)).find((entry) => entry.versionId === captured.entityId)?.sourceUrl;
      task.check(); if (source) setSourceUrl(source);
      await openBytes(bytes, captured.data.fileName, captured, source, task);
    });
  }, [cache, closeDocument, finishPending, openBytes, runTask, scope, targetTask]);

  const checkCloudRead = (task: Task, version: PdfVersion) => {
    task.check();
    const snapshot = controller.getSnapshot();
    if (snapshot.needsLogin) throw new ClientError('AUTH_REQUIRED');
    const record = assertPdfTarget(snapshot.workspace?.sync, paper.entityId, version);
    if (!record || record.revision < 1 || record.pending) throw new CloudPdfError('VERSION_UNAVAILABLE');
  };
  const checkDesktopRead = (task: Task, version: PdfVersion) => {
    task.check();
    const snapshot = controller.getSnapshot();
    if (snapshot.needsLogin) throw new ClientError('AUTH_REQUIRED');
    const record = assertPdfTarget(snapshot.workspace?.sync, paper.entityId, version);
    if (!record || record.revision < 1 || record.pending) throw new DesktopPdfError('VERSION_UNAVAILABLE');
  };

  function readCloudCopy() {
    const context = props.cloudPdf;
    const version = cloudVersion && capturePdfVersion(cloudVersion);
    if (!context || !version || busy) return;
    opening.current.beginExplicitOpen();
    void runTask('正在下载云副本', async (baseTask) => {
      const task = targetTask(baseTask, version);
      const check = () => checkCloudRead(task, version);
      check();
      const bytes = await downloadCloudPdfCopy(context, version, {
        signal: task.signal, isCurrent: () => { try { check(); return true; } catch { return false; } },
        onProgress: (downloaded, total) => { check(); setProgress({ loaded: downloaded, total }); },
      });
      check();
      await openBytes(bytes, version.data.fileName, version, undefined, task);
    });
  }

  function openAvailableSource() {
    const version = cloudVersion && capturePdfVersion(cloudVersion);
    if (!version || busy) return;
    const publicUrl = sourceUrl.trim(); const context = props.cloudPdf;
    const desktopContext = props.desktopPdf;
    opening.current.beginExplicitOpen(); setSourceAttempts([]); setProbe(null);
    void runTask('正在查找此版本的 PDF', async (baseTask) => {
      const task = targetTask(baseTask, version);
      const snapshot = controller.getSnapshot();
      const record = assertPdfTarget(snapshot.workspace?.sync, paper.entityId, version)!;
      let reason: CloudPdfUnavailableReason | undefined;
      if (!context) reason = 'not-configured';
      else if (!context.getCloudPdfCapability()) reason = 'not-enabled';
      else if (snapshot.needsLogin) reason = 'login-required';
      else if (record.revision < 1 || record.pending) reason = 'not-synced';
      let desktopReason: DesktopPdfUnavailableReason | undefined;
      if (!desktopContext) desktopReason = 'not-configured';
      else if (!desktopContext.getDesktopPdfCapability()) desktopReason = 'not-enabled';
      else if (snapshot.needsLogin) desktopReason = 'login-required';
      else if (record.revision < 1 || record.pending) desktopReason = 'not-synced';
      const result = await resolvePdfSource({ scope, version, cache, publicUrl,
        desktop: desktopContext && !desktopReason ? { context: desktopContext, check: () => checkDesktopRead(task, version) } : undefined,
        desktopUnavailableReason: desktopReason,
        cloud: context && !reason ? { context, check: () => checkCloudRead(task, version) } : undefined,
        cloudUnavailableReason: reason,
      }, {
        signal: task.signal, check: task.check,
        onAttempt: (attempt) => { task.check(); setSourceAttempts((items) => [...items.filter((item) => item.source !== attempt.source), attempt]); },
        onProgress: ({ loaded, total }) => { task.check(); setProgress({ loaded, total }); },
      });
      task.check(); setSourceAttempts(result.attempts);
      if (result.status === 'unavailable') {
        setNotice('这些来源暂时都无法提供此版本。可检查下面的原因，或选择相同的本机 PDF。'); return;
      }
      setBusy('正在核对并打开 PDF'); setProgress(null);
      await openBytes(result.bytes, result.fileName, version, result.sourceUrl, task);
    });
  }

  // Retire this reader during the unmount commit, before queued navigation continuations resume.
  useLayoutEffect(() => {
    mounted.current = true;
    void refreshCache().catch((failure) => { if (mounted.current) setError(errorMessage(failure)); });
    return () => {
      mounted.current = false; epoch.current++; taskAbort.current?.abort(); documentAbort.current?.abort();
      releaseDocumentTask.current?.(); releaseDocumentTask.current = null;
      writer.current?.stop(); void current.current?.pdf.close(); activeBytes.current = null;
    };
  }, [scopeKey]);

  useInitialPdfRestore(opening.current, versions, selectedVersionId, Boolean(jumpTo), (initial) => {
    setSelectedVersionId(initial.entityId); void loadCached(initial);
  });

  useEffect(() => {
    const reading = current.current;
    if (!reading && !activeReadTarget.current) return;
    try {
      activeReadTarget.current?.check();
      if (reading) {
        if (controller.getSnapshot().status !== 'ready' || (props.accountCurrent && !props.accountCurrent())
          || !sameReaderIdentity(controller, reading.identity)) throw new PdfError('ACCOUNT_CHANGED');
        assertPdfTarget(controller.getSnapshot().workspace?.sync, paper.entityId, reading.version, reading.pdf.pageCount);
      }
    } catch (failure) {
      taskAbort.current?.abort(failure); activeReadTarget.current = null;
      closeDocument(); setPanel('source'); setError(errorMessage(failure));
    }
  }, [paper, props.attachmentVersions, props.accountCurrent, loaded, controller, closeDocument]);

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
      if (dirty.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    document.addEventListener('visibilitychange', persist); window.addEventListener('pagehide', pagehide);
    window.addEventListener('beforeunload', beforeunload);
    return () => { document.removeEventListener('visibilitychange', persist); window.removeEventListener('pagehide', pagehide); window.removeEventListener('beforeunload', beforeunload); };
  }, [dirty, finishPending]);

  const captureZoom = (point?: ReaderTapPoint) => {
    const container = scroll.current;
    const index = point?.pageIndex ?? currentPoint.current.pageIndex;
    const page = container?.querySelector<HTMLElement>(`.pr-page[data-page-index="${index}"]`);
    if (!container || !page) return null;
    return captureReaderZoomAnchor(index, page.getBoundingClientRect(), container.getBoundingClientRect(), point);
  };
  const changeZoom = (value: number, point?: ReaderTapPoint) => {
    if (value === zoom) return;
    pendingZoom.current = captureZoom(point); setSelection(null); setZoom(value);
  };
  const hasNativeSelection = () => { const value = globalThis.getSelection?.(); return Boolean(value && !value.isCollapsed && value.toString()); };
  gestures.current.update({
    allowed: () => compact && Boolean(loaded) && !panel && !areaMode && !selection && !hasNativeSelection(),
    tap: () => setToolsVisible((value) => !value),
    doubleTap: (point) => changeZoom(zoom > 1 ? 1 : 2, point),
  });
  useEffect(() => {
    const selected = () => { if (hasNativeSelection()) gestures.current.interrupt(); };
    document.addEventListener('selectionchange', selected);
    return () => { document.removeEventListener('selectionchange', selected); gestures.current.dispose(); };
  }, []);
  useEffect(() => { gestures.current.interrupt(); }, [compact, panel, loaded]);
  useLayoutEffect(() => { if (compact && panel) mobilePanelOpen.current?.(); }, [compact, panel]);

  const pagePadding = compact ? 0 : 32;
  const pageGap = compact ? 12 : 24;
  useLayoutEffect(() => {
    if (!scroll.current || !loaded) return;
    const element = scroll.current;
    const measure = () => {
      const width = Math.max(160, element.clientWidth - pagePadding);
      if (width === measuredWidth.current) return;
      if (positionedDocument.current === loaded.pdf) pendingZoom.current ??= captureZoom();
      measuredWidth.current = width; setFitWidth(width);
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [loaded, panel, pagePadding]);

  useLayoutEffect(() => {
    const root = readerRoot.current;
    if (!compact || !loaded || !root || !heading.current || !footer.current || !pageIndicator.current) return;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const headerBounds = heading.current!.getBoundingClientRect();
      const footerBounds = footer.current!.getBoundingClientRect();
      // The indicator sits above the actual toolbar, including larger text and wrapped selection tools.
      root.style.setProperty('--reader-footer-height', `${footerBounds.height}px`);
      const indicatorBounds = pageIndicator.current!.getBoundingClientRect();
      const next = { top: Math.ceil(headerBounds.bottom - bounds.top + 8),
        bottom: Math.ceil(bounds.bottom - Math.min(footerBounds.top, indicatorBounds.top) + 8) };
      const before = liveChromeInsets.current;
      if (before.top === next.top && before.bottom === next.bottom) return;
      if (before.top !== next.top && positionedDocument.current === loaded.pdf) pendingZoom.current ??= captureZoom();
      liveChromeInsets.current = next; setChromeInsets(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [root, heading.current, footer.current, pageIndicator.current]) observer.observe(element);
    return () => { observer.disconnect(); root.style.removeProperty('--reader-footer-height'); };
  }, [compact, loaded]);

  const layout = useMemo(() => {
    const offsets: number[] = []; const heights: number[] = []; let total = 0;
    if (loaded) for (let index = 0; index < loaded.pdf.pageCount; index++) {
      offsets.push(total); const height = pageDisplaySize(loaded.pdf, index, fitWidth, zoom, rotation).height;
      heights.push(height); total += height + pageGap;
    }
    return { offsets, heights, total: Math.max(0, total - pageGap) };
  }, [loaded, fitWidth, zoom, rotation, pageGap]);

  const goTo = useCallback((index: number, offsetRatio = 0) => {
    if (!loaded || !Number.isInteger(index) || index < 0 || index >= loaded.pdf.pageCount) return;
    const point = { pageIndex: index, offsetRatio: Math.max(0, Math.min(1, offsetRatio)) };
    currentPoint.current = point; setPageIndex(index); setSelection(null); setFocus(null); writer.current?.record(point);
    // The mobile top spacer equals its persistent reading inset, so page coordinates stay document-relative.
    if (scroll.current) scroll.current.scrollTop = (continuous ? layout.offsets[index] : 0) + point.offsetRatio * layout.heights[index];
  }, [continuous, layout, loaded]);

  useLayoutEffect(() => {
    if (!loaded || !scroll.current) return;
    const anchor = pendingZoom.current;
    const page = anchor && scroll.current.querySelector<HTMLElement>(`.pr-page[data-page-index="${anchor.pageIndex}"]`);
    if (anchor && page) {
      pendingZoom.current = null;
      const bounds = page.getBoundingClientRect(); const viewport = scroll.current.getBoundingClientRect();
      const restored = restoreReaderZoomAnchor(anchor, { left: bounds.left - viewport.left + scroll.current.scrollLeft,
        top: bounds.top - viewport.top + scroll.current.scrollTop, width: bounds.width, height: bounds.height });
      scroll.current.scrollLeft = restored.left; scroll.current.scrollTop = restored.top;
      positionedDocument.current = loaded.pdf; onScroll(); return;
    }
    const point = currentPoint.current;
    scroll.current.scrollTop = (continuous ? layout.offsets[point.pageIndex] : 0) + point.offsetRatio * layout.heights[point.pageIndex];
    positionedDocument.current = loaded.pdf;
  }, [loaded, layout, continuous, pageIndex, chromeInsets.top]);
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

  useReaderFocusPosition({ focus, pdf: loaded?.pdf ?? null, pageIndex, fitWidth, zoom, rotation,
    continuous, offsets: layout.offsets, contentTop: compact ? chromeInsets.top : 0,
    topInset: compact ? chromeInsets.top + 8 : 48, scroll });

  const onScroll = () => {
    gestures.current.interrupt();
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
    taskAbort.current?.abort(); setSelectedVersionId(id); setProbe(null); setSourceUrl(''); setSourceAttempts([]);
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
    const value = versions.find((entry) => entry.entityId === selectedVersionId);
    const expected = value && capturePdfVersion(value);
    setSourceAttempts([]);
    void runTask('正在核对 PDF', async (baseTask) => {
      const task = targetTask(baseTask, expected);
      const bytes = await readLocalPdf(file, { signal: task.signal, onProgress: (done, total) => { task.check(); setProgress({ loaded: done, total }); } });
      task.check(); await openBytes(bytes, file.name, expected, undefined, task);
    });
  };

  const inspectSource = () => void runTask('正在检查链接', async (baseTask) => {
    const task = targetTask(baseTask, versions.find((entry) => entry.entityId === selectedVersionId));
    const found = await inspectPublicPdf(sourceUrl, { signal: task.signal, fetch: guardedPdfFetch(task.check) }); task.check(); setProbe(found);
  });
  const downloadSource = () => {
    if (!probe) return;
    opening.current.beginExplicitOpen();
    const source = { ...probe }; const value = versions.find((entry) => entry.entityId === selectedVersionId);
    const expected = value && capturePdfVersion(value);
    setSourceAttempts([]);
    void runTask('正在读取 PDF', async (baseTask) => {
      const task = targetTask(baseTask, expected);
      const bytes = await downloadPublicPdf(source, { signal: task.signal, fetch: guardedPdfFetch(task.check),
        onProgress: (done, total) => { task.check(); setProgress({ loaded: done, total }); } });
      task.check(); await openBytes(bytes, source.fileName, expected, source.url, task);
    });
  };

  const addAnnotation = async (kind: AnnotationData['kind'], anchor = selection) => {
    if (!anchor || !loaded || dirty.annotationSaving) return;
    let identity: ReaderIdentity | undefined; const version = loaded.version;
    const finishSave = dirty.beginSave('annotation');
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
    finally { finishSave(); if (mounted.current) setAnnotationSaving(dirty.annotationSaving); }
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
    updateCommentDraft(draft); setCommentStatus('idle');
  };

  const deleteAnnotation = async (record: VisibleEntity) => {
    if (!window.confirm('删除这条批注？')) return;
    const finishSave = dirty.beginSave('annotation');
    setAnnotationSaving(true);
    try {
      const identity = readerIdentity(controller, scope);
      await saveComment();
      if (!sameReaderIdentity(controller, identity) || !mounted.current) throw new PdfError('ACCOUNT_CHANGED');
      const latest = getVisibleEntity(controller.getSnapshot().workspace!.sync, 'annotation', record.entityId);
      if (!latest || latest.deleted) throw new PdfError('ANNOTATION_CHANGED');
      await controller.save({ entityType: 'annotation', entityId: record.entityId, mutation: 'delete', data: null }, latest.revision);
      if (!sameReaderIdentity(controller, identity) || !mounted.current) return;
      if (draftRef.current?.entityId === record.entityId) updateCommentDraft(null);
      setNotice('批注已删除，联网后同步。');
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { finishSave(); if (mounted.current) setAnnotationSaving(dirty.annotationSaving); }
  };

  const ask = (kind: PdfAiContext['scope']) => {
    if (!loaded || !onAskAi) return;
    const reading = loaded; const anchor = selection;
    if (compact) setPanel(null);
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
      // Preparing a long document can outlive a newly opened tool sheet.
      if (compactView.current) setPanel(null);
      onAskAi({ paperId: paper.entityId, attachmentVersionId: reading.version.entityId, sha256: reading.version.data.sha256,
        scope: kind, totalPages: reading.pdf.pageCount, pages, complete: true,
        label: kind === 'document' ? `${reading.version.data.fileName} · 全文` : `第 ${(kind === 'selection' ? anchor!.pageIndex : pageIndex) + 1} 页${kind === 'selection' ? '选段' : ''}` });
      props.onOpenAi?.();
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
    try {
      await finishPending();
      if (!mounted.current || liveScope.current !== scopeKey) return;
      // Flush completion can precede React's next commit. Publish the current aggregate,
      // including new edits or annotation writes that started while the flush was pending.
      dirty.publish(); props.onBack();
    }
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
  const positionMessage = positionStatus === 'saving' ? '正在保存位置…' : positionStatus === 'saved' ? '位置已保存'
    : positionStatus === 'error' ? '位置尚未保存' : '阅读位置保存在此设备';
  const pointer = (event: PointerEvent<HTMLDivElement>): { point: ReaderPointer; eligible: boolean } => {
    const target = event.target as HTMLElement;
    const page = target.closest<HTMLElement>('.pr-page[data-page-index]');
    return { point: { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, time: event.timeStamp,
      pageIndex: Number(page?.dataset.pageIndex ?? -1), onText: Boolean(target.closest('.pr-text-layer span,.pr-text-layer br')) },
    eligible: compact && Boolean(page) && event.isPrimary !== false && event.button === 0
      && !target.closest('button,a,input,textarea,select,summary,[role="button"],[contenteditable="true"],.pr-area-input,.pr-annotation-overlay,[data-reader-no-tap]') };
  };
  const zoomControl = <label className="pr-control"><span className={compact ? '' : 'pr-sr-only'}>缩放</span>
    <select aria-label="缩放" value={zoom} onChange={(event) => changeZoom(Number(event.target.value))}>
      <option value={0.75}>75%</option><option value={1}>适合宽度</option><option value={1.25}>125%</option>
      <option value={1.5}>150%</option><option value={2}>200%</option><option value={3}>300%</option>
    </select></label>;
  const modeControl = <label className="pr-control"><span className={compact ? '' : 'pr-sr-only'}>阅读模式</span>
    <select aria-label="阅读模式" value={continuous ? 'continuous' : 'single'} onChange={(event) => setContinuous(event.target.value === 'continuous')}>
      <option value="continuous">连续</option><option value="single">分页</option></select></label>;
  const pageControls = loaded && <div className="pr-page-controls"><button type="button" aria-label="上一页" disabled={pageIndex === 0} onClick={() => goTo(pageIndex - 1)}>‹</button>
    <label><span className="pr-sr-only">页码</span><input inputMode="numeric" value={pageInput} aria-label="页码"
      onChange={(event) => setPageInput(event.target.value.replace(/\D/g, '').slice(0, 5))}
      onBlur={() => { goTo(Number(pageInput) - 1); setPageInput(String(currentPoint.current.pageIndex + 1)); }}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); goTo(Number(pageInput) - 1); event.currentTarget.blur(); if (compact) setPanel(null); } }} /></label>
    <span>/ {loaded.pdf.pageCount}</span><button type="button" aria-label="下一页" disabled={pageIndex + 1 >= loaded.pdf.pageCount} onClick={() => goTo(pageIndex + 1)}>›</button></div>;
  const feedback = (error || notice || busy) && <div className={`pr-feedback ${error ? 'pr-feedback-error' : ''}`} role={error ? 'alert' : 'status'}>
    <span>{busy ?? error ?? notice}{busy && progress ? ` · ${byteLabel(progress.loaded)}${progress.total !== null ? ` / ${byteLabel(progress.total)}` : ''}` : ''}</span>
    {busy ? <button type="button" onClick={() => taskAbort.current?.abort()}>取消</button>
      : <button type="button" aria-label="关闭提示" onClick={() => { setError(null); setNotice(null); }}>×</button>}
  </div>;

  const chromeHidden = compact && !toolsVisible && Boolean(loaded);
  const footerHidden = chromeHidden && !selection && !areaMode;
  return <section ref={readerRoot} className={`pr-reader${compact ? ' pr-reader--compact' : ''}${chromeHidden ? ' pr-reader--immersive' : ''}`}
    data-pdf-paper-appearance={paperAppearance}
    style={compact ? { '--reader-content-top': `${chromeInsets.top}px`, '--reader-content-bottom': `${chromeInsets.bottom}px` } as CSSProperties : undefined}
    aria-label="PDF 阅读器" data-tools-visible={toolsVisible} data-document-loaded={Boolean(loaded)} onKeyDown={(event) => {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,button,summary,[contenteditable="true"],[role="dialog"]')
      || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'PageDown') { event.preventDefault(); goTo(pageIndex + 1); }
    if (event.key === 'PageUp') { event.preventDefault(); goTo(pageIndex - 1); }
  }}>
    <header ref={heading} className="pr-heading" aria-hidden={chromeHidden || undefined} {...(chromeHidden ? { inert: '' } : {})}>
      <button type="button" className={`pr-icon-button${compact ? ' app-glass' : ''}`} aria-label="返回文库" onClick={() => void back()}><Icon name="back" /></button>
      <div className="pr-title"><h2 title={title}>{title}</h2>{!compact && <p>{loaded ? `${loaded.pdf.pageCount} 页 · ${byteLabel(loaded.version.data.sizeBytes)}` : '选择 PDF 开始阅读'}</p>}</div>
      {compact ? <button type="button" className="pr-more-button app-glass" aria-label="更多阅读选项" aria-haspopup="dialog" onClick={() => setPanel('more')}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg></button>
        : <button type="button" onClick={() => { if (panel === 'source') taskAbort.current?.abort(); setPanel(panel === 'source' ? null : 'source'); }}>文件</button>}
    </header>
    {loaded && !compact && <div className="pr-toolbar" role="toolbar" aria-label="阅读工具">
      {pageControls}{zoomControl}
      <button type="button" onClick={() => { setSelection(null); setRotation((value) => (value + 90) % 360); }} aria-label={`旋转页面，当前 ${rotation} 度`}>旋转</button>
      {modeControl}
      <PdfPaperAppearanceControl value={paperAppearance} onChange={value => { writePdfPaperAppearance(value); setPaperAppearance(value); }} />
      <button type="button" aria-pressed={panel === 'contents'} onClick={() => setPanel(panel === 'contents' ? null : 'contents')}>目录</button>
      <button type="button" aria-pressed={panel === 'search'} onClick={() => setPanel(panel === 'search' ? null : 'search')}>搜索</button>
      <button type="button" aria-pressed={panel === 'annotations'} onClick={() => setPanel(panel === 'annotations' ? null : 'annotations')}>批注 {annotationRecords.length || ''}</button>
      <button type="button" aria-pressed={panel === 'parsed'} onClick={() => setPanel(panel === 'parsed' ? null : 'parsed')}>解析</button>
    </div>}
    {(!compact || !panel) && feedback}
    <div className="pr-body">
      {panel && <ReaderPanel compact={compact} title={panelTitles[panel]} onClose={() => {
        if (panel === 'cloud' || panel === 'source') taskAbort.current?.abort();
        setPanel(null);
      }}>
        {compact && feedback}
        {panel === 'parsed' && props.onOpenRemoteTasks && <div className="pr-panel-content"><button type="button" className="secondary" onClick={props.onOpenRemoteTasks}>由在线电脑生成解析或索引</button></div>}
        {panel === 'annotations' && props.onExportNotes && <div className="pr-panel-content"><button type="button" className="secondary" onClick={props.onExportNotes}>导出笔记与批注</button></div>}
        {panel === 'parsed' && (loaded ? <Suspense fallback={<p className="pr-panel-content" role="status">正在打开解析阅读…</p>}>
          <ParsedDocumentPanel key={`${scopeKey}:${loaded.version.entityId}:${loaded.version.data.sha256}:${props.parsedCacheEpoch ?? 0}`} scope={scope}
            version={loaded.version} pageCount={loaded.pdf.pageCount} pdfPageIndex={pageIndex}
            isCurrent={() => {
              try {
                if (current.current !== loaded || !mounted.current || (props.accountCurrent && !props.accountCurrent())
                  || controller.getSnapshot().status !== 'ready' || !sameReaderIdentity(controller, loaded.identity)) return false;
                assertPdfTarget(controller.getSnapshot().workspace?.sync, paper.entityId, loaded.version, loaded.pdf.pageCount);
                return true;
              } catch { return false; }
            }} onJump={(index) => { goTo(index); if (compact) setPanel(null); }}
            onPackageChange={(retainedDigest) => {
              if (current.current === loaded && mounted.current && sameReaderIdentity(controller, loaded.identity))
                invalidateContext.current?.({ attachmentVersionId: loaded.version.entityId, retainedDigest });
            }}
            onAskAi={onAskAi ? (context) => {
              if (current.current !== loaded || !mounted.current || (props.accountCurrent && !props.accountCurrent())
                || !sameReaderIdentity(controller, loaded.identity)) throw new PdfError('ACCOUNT_CHANGED');
              assertPdfTarget(controller.getSnapshot().workspace?.sync, paper.entityId, loaded.version, loaded.pdf.pageCount);
              if (context.paperId !== paper.entityId || context.attachmentVersionId !== loaded.version.entityId
                || context.sha256 !== loaded.version.data.sha256 || context.totalPages !== loaded.pdf.pageCount) throw new PdfError('VERSION_MISMATCH');
              if (compactView.current) setPanel(null);
              onAskAi(context); props.onOpenAi?.();
            } : undefined} />
        </Suspense> : <p className="pr-panel-content">请先打开需要核对的 PDF。</p>)}
        {panel === 'more' && <div className="pr-panel-content pr-options">
          {loaded && <section className="pr-option-section" aria-label="阅读显示"><h3>阅读显示</h3>
            <div className="pr-option-controls">{zoomControl}{modeControl}</div>
            <PdfPaperAppearanceControl value={paperAppearance} onChange={value => { writePdfPaperAppearance(value); setPaperAppearance(value); }} />
            <p className="pr-muted">夜间纸张用于文字阅读；彩图可选柔和原图，核对颜色时选原始颜色。</p>
            <button type="button" onClick={() => { setSelection(null); setRotation((value) => (value + 90) % 360); }} aria-label={`旋转页面，当前 ${rotation} 度`}>旋转页面 <span>{rotation}°</span></button>
            <button type="button" onClick={() => setPanel('annotations')}>批注 <span>{annotationRecords.length}</span></button>
            <button type="button" onClick={() => setPanel('parsed')}>解析阅读</button></section>}
          <section className="pr-option-section" aria-label="文件与离线"><h3>文件与离线</h3>
            <button type="button" onClick={() => setPanel('source')}>文件与版本</button>
            {props.cloudPdf && <button type="button" disabled={!cloudVersion} onClick={() => setPanel('cloud')}>私有云 PDF</button>}
            <button type="button" onClick={() => { setPanel('cache'); void refreshCache().catch((failure) => setError(errorMessage(failure))); }}>离线副本与缓存</button></section>
          {loaded && <div className="pr-option-status"><span role="status">{positionMessage}</span>
            {positionStatus === 'error' && <button type="button" onClick={() => { void writer.current?.flush().catch((failure) => setError(errorMessage(failure))); }}>重试保存位置</button>}
            <span>{loaded.pdf.pageCount} 页 · {byteLabel(loaded.version.data.sizeBytes)}</span>
            <p>轻触空白处收起工具；双击空白处放大或适宽。长按文字可选择原文。</p></div>}
          {props.statusContent && <div className="pr-account-status">{props.statusContent}</div>}
        </div>}
        {panel === 'page' && <div className="pr-panel-content pr-jump-panel">{pageControls}
          <button type="button" className="pr-primary" onClick={() => { goTo(Number(pageInput) - 1); setPanel(null); }}>跳转</button></div>}
        {panel === 'ask' && <div className="pr-panel-content">
          {onAskAi && <><button type="button" disabled={Boolean(busy)} onClick={() => ask('page')}>询问本页</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => ask('document')}>询问全文</button></>}
          {props.onOpenAi && <button type="button" onClick={() => { setPanel(null); props.onOpenAi?.(); }}>打开 AI 对话</button>}
          <p className="pr-muted">也可先选择页面中的文字，再对选段提问。</p>
        </div>}
        {panel === 'source' && <div className="pr-panel-content">
          <label>附件版本<select value={selectedVersionId} disabled={Boolean(busy)} onChange={(event) => void changeVersion(event.target.value)}>
            {versions.map((version) => <option key={version.entityId} value={version.entityId}>{version.data.fileName} · {version.data.sha256.slice(0, 8)}</option>)}
            <option value="">添加新版本</option></select></label>
          <p className="pr-muted">{selectedVersionId ? '选择与此版本一致的文件。不同文件可作为新版本添加，批注会分别保留。' : '文件只保留在当前设备。文库会同步版本信息、批注与阅读位置。'}</p>
          {cloudVersion && <div className="pr-source-choice">
            <button type="button" className="pr-primary" disabled={Boolean(busy)} onClick={openAvailableSource}>从可用来源打开</button>
            <p className="pr-muted">点击后依次尝试本机缓存、同账号在线电脑、私有云和下方填写的公开链接，仅打开与此版本一致的 PDF。电脑需开启文件提供并保持在线。</p>
          </div>}
          <PdfSourceAttempts attempts={sourceAttempts} />
          <input className="pr-file-input" type="file" accept="application/pdf,.pdf" ref={fileInput} onChange={chooseFile} tabIndex={-1} />
          <button type="button" className={cloudVersion ? undefined : 'pr-primary'} disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>选择本机 PDF</button>
          {props.cloudPdf && cloudVersion && <button type="button" disabled={Boolean(busy)} onClick={() => setPanel('cloud')}>查看此版本的云副本</button>}
          <div className="pr-divider" />
          <label>公开 PDF 链接<input type="url" value={sourceUrl} placeholder="https://…/paper.pdf" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            disabled={Boolean(busy)} onChange={(event) => { setSourceUrl(event.target.value); setProbe(null); setSourceAttempts([]); }} /></label>
          <button type="button" disabled={Boolean(busy) || !sourceUrl.trim()} onClick={inspectSource}>检查链接</button>
          {probe && <div className="pr-source-result"><p>{probe.rangeSupported ? '来源支持分段读取。' : '来源不支持分段读取，需要下载完整文件。'}
            {' '}核对版本将读取{probe.sizeBytes === null ? '完整 PDF' : `完整文件（${byteLabel(probe.sizeBytes)}）`}。</p>
            <button type="button" className="pr-primary" disabled={Boolean(busy)} onClick={downloadSource}>读取完整 PDF 并打开</button></div>}
          <p className="pr-muted">网页链接、需要登录或不允许跨域读取的来源可能无法打开。可改选本机 PDF。</p>
          {loaded && <button type="button" disabled={Boolean(busy)} onClick={togglePin}>{cacheEntry?.pinned ? '取消离线保留' : '保留此 PDF 供离线阅读'}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => { setPanel('cache'); void refreshCache().catch((failure) => setError(errorMessage(failure))); }}>查看与清理缓存</button>
        </div>}
        {panel === 'cloud' && props.cloudPdf && cloudVersion && <CloudPdfPanel key={`${scopeKey}:${cloudVersion.entityId}`}
          context={props.cloudPdf} scope={scope} controller={controller} accountCurrent={props.accountCurrent}
          version={cloudVersion} synced={Boolean(cloudVersionRecord && cloudVersionRecord.revision > 0 && !cloudVersionRecord.pending)}
          hasBytes={loaded?.version.entityId === cloudVersion.entityId && Boolean(activeBytes.current)}
          getBytes={() => current.current?.version.entityId === cloudVersion.entityId ? activeBytes.current : null}
          reading={Boolean(busy)} onRead={readCloudCopy} />}
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
            onChange={(event) => {
              const value = draftRef.current;
              if (value?.entityId === commentDraft.entityId) updateCommentDraft({ ...value, comment: event.target.value });
            }}
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
      </ReaderPanel>}
      {loaded ? <div ref={scroll} className="pr-scroll" onScroll={onScroll} tabIndex={0} aria-label="PDF 页面"
        onPointerDown={(event) => { const value = pointer(event); gestures.current.down(value.point, value.eligible); }}
        onPointerMove={(event) => gestures.current.move({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY })}
        onPointerUp={(event) => { const value = pointer(event); gestures.current.up(value.point, value.eligible); }}
        onPointerCancel={(event) => gestures.current.cancel(event.pointerId)}>
        <div className="pr-pages" style={{ width: Math.max(fitWidth + pagePadding, fitWidth * zoom + pagePadding) }}>
          {continuous && firstPage > 0 && <div aria-hidden="true" style={{ height: layout.offsets[firstPage] }} />}
          {renderedPages.map((index) => <div key={`${loaded.version.entityId}:${index}`} className="pr-page-slot" style={{ height: layout.heights[index], marginBottom: index < loaded.pdf.pageCount - 1 && continuous ? pageGap : 0 }}>
            <PdfPageView pdf={loaded.pdf} runtime={loaded.runtime} pageIndex={index} fitWidth={fitWidth} zoom={zoom} rotation={rotation}
              annotations={annotationRecords.filter((record) => (record.data as AnnotationData).anchor.pageIndex === index).map((record) => ({ entityId: record.entityId, data: record.data as AnnotationData }))}
              focusQuads={focus?.pageIndex === index ? focus.quads : undefined} areaMode={areaMode}
              onSelection={selectText} onArea={(anchor) => { void addAnnotation('area', anchor); }} onError={pageError} />
          </div>)}
          {continuous && lastPage < loaded.pdf.pageCount - 1 && <div aria-hidden="true" style={{ height: Math.max(0, layout.total - layout.offsets[lastPage] - layout.heights[lastPage] - pageGap) }} />}
        </div>
      </div> : <div className="pr-empty"><Icon name="note" /><h3>打开这篇文献的 PDF</h3><p>选择本机文件，或获取公开全文链接。核对完成后即可阅读、批注和继续上次的位置。</p>
        <button type="button" className="pr-primary" onClick={() => setPanel('source')}>选择 PDF</button></div>}
      {compact && loaded && <>
        <button ref={pageIndicator} type="button" className="pr-page-indicator app-glass" aria-label={`第 ${pageIndex + 1} 页，共 ${loaded.pdf.pageCount} 页，跳转页面`}
          aria-hidden={chromeHidden || undefined} {...(chromeHidden ? { inert: '' } : {})}
          aria-haspopup="dialog" onClick={() => setPanel('page')}>{pageIndex + 1} <span>/ {loaded.pdf.pageCount}</span></button>
        {positionStatus === 'error' && <div className="pr-position-alert" role="alert">位置尚未保存
          <button type="button" onClick={() => { void writer.current?.flush().catch((failure) => setError(errorMessage(failure))); }}>重试</button></div>}
      </>}
    </div>
    {loaded && <footer ref={footer} className={`pr-footer${compact ? ' pr-mobile-footer' : ''}`} data-contextual={Boolean(selection || areaMode)}>
      <div className={compact ? 'pr-floating-tools app-glass' : undefined} aria-hidden={footerHidden || undefined} {...(footerHidden ? { inert: '' } : {})}>
      {selection ? <div className="pr-selection-tools" onPointerDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}><span>已选 {selection.quote?.exact.length ?? 0} 字</span>
        <button type="button" disabled={annotationSaving} onClick={() => void addAnnotation('highlight')}>高亮</button>
        <button type="button" disabled={annotationSaving} onClick={() => void addAnnotation('underline')}>下划线</button>
        {onAskAi && <button type="button" disabled={Boolean(busy)} onClick={() => ask('selection')}>选段提问</button>}
        <label className="pr-color-label">颜色<input aria-label="批注颜色" type="color" value={annotationColor} onChange={(event) => setAnnotationColor(event.target.value)} /></label>
      </div> : areaMode ? <div className="pr-selection-tools"><span>在页面上拖动框选区域</span><button type="button" onClick={() => setAreaMode(false)}>完成</button></div>
        : compact ? <nav className="pr-mobile-actions" aria-label="阅读操作">
          <button type="button" aria-haspopup="dialog" onClick={() => setPanel('contents')}><Icon name="library" /><span>目录</span></button>
          <button type="button" aria-haspopup="dialog" onClick={() => setPanel('search')}><Icon name="search" /><span>搜索</span></button>
          <button type="button" disabled={!props.onOpenNotes} onClick={props.onOpenNotes}><Icon name="note" /><span>笔记</span></button>
          <button type="button" disabled={!onAskAi && !props.onOpenAi} aria-haspopup="dialog" onClick={() => setPanel('ask')}>
            <svg viewBox="0 0 24 24" className="pr-ai-mark" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z" /></svg><span>AI</span></button>
        </nav> : <div className="pr-reading-status"><span role="status">{positionMessage}</span>
          {positionStatus === 'error' && <button type="button" onClick={() => { void writer.current?.flush().catch((failure) => setError(errorMessage(failure))); }}>重试</button>}
          {onAskAi && <div><button type="button" disabled={Boolean(busy)} onClick={() => ask('page')}>询问本页</button><button type="button" disabled={Boolean(busy)} onClick={() => ask('document')}>询问全文</button></div>}
        </div>}
      </div>
      {compact && <button type="button" className="pr-tool-toggle app-glass" aria-label={toolsVisible ? '隐藏阅读工具' : '显示阅读工具'}
        aria-pressed={!toolsVisible} onClick={() => { gestures.current.interrupt(); setToolsVisible((value) => !value); }}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d={toolsVisible ? 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5' : 'M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5'} /></svg>
      </button>}
    </footer>}
  </section>;
}
