import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Download, MonitorSmartphone, RefreshCw, X } from 'lucide-react';
import type { ReadingPositionData } from '../../../packages/sync-core/src/types';
import type { DesktopReadingReaderAccess, DesktopReadingReaderSnapshot } from '../../services/desktopReadingReader';
import type { DesktopReadingTrackingController, DesktopReadingTrackingSnapshot } from '../../services/desktopReadingTracking';
import {
  desktopReadingPosition, type DesktopReadingCapture, type DesktopReadingConflictChoice,
  type DesktopReadingDevicePosition, type DesktopReadingPositionPreview, type DesktopReadingPositionStatus,
  type VerifiedDesktopReadingSource,
} from '../../services/desktopReadingPosition';
import { useLocaleText } from '../../i18n/uiLanguage';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

const buttonClass = 'pq-button inline-flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const summaryClass = 'min-h-11 cursor-pointer py-3 text-sm font-medium text-[var(--pq-text)]';
const selectionClass = 'flex min-h-11 cursor-pointer items-start gap-3 py-3 text-sm';
const inputClass = 'mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]';
const pageSize = 8;
type Task = 'publish' | 'resume' | 'pending';
type Confirmation = { kind: 'publish'; preview: DesktopReadingPositionPreview } | { kind: 'resume'; preview: DesktopReadingPositionPreview; position: DesktopReadingDevicePosition };
type Operation = { current(): boolean; owner: string; reader: DesktopReadingReaderAccess | null };

function errorCode(error: unknown): string {
  const value = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  return value.match(/\b[A-Z][A-Z_]{3,70}\b/)?.[0] || 'READING_FAILED';
}
function reasonLabel(code: string, l: ReaderPreferencesLocalizer): string {
  const labels: Record<string, [string, string]> = {
    READING_FEATURE_UNAVAILABLE: ['当前账号服务尚未支持阅读位置，请先检查账号连接。', 'The current account service does not support reading positions. Check the account connection.'],
    READING_SAVE_UNCONFIRMED: ['处理结果已收到，但本机保存尚未确认。请只重试保存或先导出备份。', 'The result was received, but saving it locally is unconfirmed. Retry saving only, or export a backup first.'],
    READING_STORAGE_CHANGED: ['本机位置记录已被其他操作修改，请保留备份并重新检查。', 'Another operation changed the local reading record. Preserve a backup and check again.'],
    READING_STATE_INVALID: ['本机位置记录无法完整读取，请保留原记录并检查存储。', 'The local reading record cannot be read completely. Preserve it and check storage.'],
    READING_STATE_FULL: ['本机位置记录已达到容量限制，请先导出备份。', 'The local reading record reached its capacity limit. Export a backup first.'],
    READING_SELECTION_INVALID: ['请选择当前 PDF 的一个已关联版本或有效设备位置。', 'Select a linked version of the current PDF or a valid device position.'],
    READING_SOURCE_CHANGED: ['PDF 或文献关联已变化，请重新检查当前打开的 PDF。', 'The PDF or its paper link changed. Check the currently open PDF again.'],
    READING_BINDING_REQUIRED: ['当前 PDF 尚未唯一关联到账号版本，请先在账号设置中关联这份文件。', 'This PDF is not uniquely linked to an account version. Link the file in account settings first.'],
    READING_BINDING_CHANGED: ['账号文件关联已变化，请重新检查当前 PDF。', 'The account file link changed. Check the current PDF again.'],
    READING_PREVIEW_STALE: ['位置或来源在检查后已有变化，请重新检查后再操作。', 'The position or source changed after the check. Check again before continuing.'],
    READING_PENDING: ['此版本还有未完成的原请求，请先查看未完成操作。', 'This version still has an unfinished original request. Review unfinished operations first.'],
    READING_CONFLICT_CHANGED: ['账号位置已有新变化，请重新检查后选择。', 'The account position changed again. Check before choosing.'],
    READING_DEVICE_CHANGED: ['登录设备已变化。旧设备的未完成请求会保留，不能改成新请求重发。', 'The signed-in device changed. The old device’s unfinished request is preserved and cannot be resent as a new request.'],
    DEVICE_CHANGED: ['这是另一个登录设备的原请求，当前设备不能改写。请保留记录。', 'This request belongs to another signed-in device. The current device cannot change it; preserve the record.'],
    READING_TOMBSTONE_UNBOUND: ['已有删除记录，但版本归属尚未确认。请保留原请求并检查账号记录。', 'A deleted record exists, but its version is not confirmed. Preserve the original request and check account records.'],
    READING_POSITION_UNSUPPORTED: ['当前位置无法按已核验版本记录，请在 PDF 页面加载完成后重新检查。', 'This position cannot be recorded for a verified version. Check after the PDF page has loaded.'],
    READING_READER_CHANGED: ['当前阅读器已变化，旧位置操作已停止。请重新打开阅读位置面板。', 'The current reader changed. The old position operation stopped. Open the reading position panel again.'],
    READING_POSITION_UNAVAILABLE: ['当前页面尚未取得有效阅读位置，请等页面加载后重新检查。', 'The current page has no valid reading position yet. Wait for it to load, then check again.'],
    READING_POSITION_UNREACHABLE: ['当前窗口无法准确显示所选位置，请调整窗口或 PDF 缩放后重新检查。', 'This window cannot display the exact selected position. Adjust the window or PDF zoom, then check again.'],
    READING_PDF_LIMIT: ['这个 PDF 超过阅读位置核验的 64 MiB 上限，仍可正常在本机阅读。', 'This PDF exceeds the 64 MiB reading-position verification limit. Local reading remains available.'],
    READING_VERSION_MISMATCH: ['当前打开的 PDF 与所选账号版本不一致，未应用旧位置。', 'The open PDF differs from the selected account version. The old position was not applied.'],
    READING_HASH_UNAVAILABLE: ['当前环境无法核验 PDF 内容，请保留本机阅读位置。', 'This environment cannot verify PDF content. Keep the local reading position.'],
    CHECKPOINT_ALREADY_EXISTS: ['这个设备和版本已有位置记录。原请求已保留，请检查已有记录，不能另建请求绕过。', 'This device and version already have a reading record. The original request is preserved; check the existing record instead of creating another request.'],
    READING_DEVICE_MISMATCH: ['这个位置属于另一个设备，当前设备不能修改。', 'This position belongs to another device and cannot be changed by the current device.'],
    AUTHENTICATION_REQUIRED: ['请先连接账号，再检查当前 PDF 的阅读位置。', 'Connect an account before checking the current PDF’s reading position.'],
    AUTH_SESSION_CHANGED: ['登录身份已变化，请确认当前账号。', 'The signed-in identity changed. Check the current account.'],
    DESKTOP_LIBRARY_CHANGED: ['文库已变化，请重新检查当前 PDF。', 'The library changed. Check the current PDF again.'],
    DESKTOP_OPERATION_CANCELLED: ['已停止本次等待，未完成的原请求仍保留。', 'This wait stopped. Unfinished original requests are preserved.'],
    REVISION_MISMATCH: ['账号位置已有更新，请重新检查。', 'The account position was updated. Check again.'],
  };
  return labels[code] ? l(...labels[code]) : l('本次位置操作尚未完成。请查看诊断记录，保留原请求后重新检查。', 'This reading-position operation did not complete. Review diagnostics, preserve the original request and check again.');
}
function dateLabel(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; }
function pointLabel(point: { pageIndex: number; offsetRatio: number }, l: ReaderPreferencesLocalizer): string {
  const percentage = Number((point.offsetRatio * 100).toPrecision(15));
  return l(`第 ${point.pageIndex + 1} 页 · 页内 ${percentage}%`, `Page ${point.pageIndex + 1} · ${percentage}% down the page`);
}
function deviceLabel(row: DesktopReadingDevicePosition, l: ReaderPreferencesLocalizer): string {
  return row.isCurrentDevice ? row.deviceName ? l(`${row.deviceName}（此设备）`, `${row.deviceName} (this device)`) : l('此设备', 'This device') : row.deviceName || l('未命名设备', 'Unnamed device');
}
function Diagnostics({ value, l }: { value: unknown; l: ReaderPreferencesLocalizer }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary className={summaryClass}>{l('诊断记录', 'Diagnostic record')}</summary>{open ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--pq-surface-2)] p-3 text-xs">{JSON.stringify(value, null, 2)}</pre> : null}</details>;
}
function Rows<T>({ items, renderRow, l }: { items: T[]; renderRow: (row: T, index: number) => ReactNode; l: ReaderPreferencesLocalizer }) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(items.length / pageSize)), current = Math.min(page, pages - 1);
  return <><ul className="min-w-0 divide-y divide-[var(--pq-border)]">{items.slice(current * pageSize, (current + 1) * pageSize).map((row, index) => renderRow(row, current * pageSize + index))}</ul>{pages > 1 ? <nav aria-label={l('记录分页', 'Record pages')} className="flex flex-wrap items-center gap-2"><button type="button" className={buttonClass} disabled={!current} onClick={() => setPage(current - 1)}>{l('上一页', 'Previous')}</button><span className="text-xs text-[var(--pq-text-muted)]">{l(`第 ${current + 1} / ${pages} 页`, `Page ${current + 1} of ${pages}`)}</span><button type="button" className={buttonClass} disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>{l('下一页', 'Next')}</button></nav> : null}</>;
}
function PointDetails({ point, l, furthest = false }: { point: { pageIndex: number; offsetRatio: number; observedAt: string; furthestPageIndex?: number; furthestOffsetRatio?: number } | null; l: ReaderPreferencesLocalizer; furthest?: boolean }) {
  if (!point) return <p className="text-sm text-[var(--pq-text-muted)]">{l('没有可用的位置。', 'No position is available.')}</p>;
  return <div className="space-y-1 text-sm"><p className="font-medium">{pointLabel(point, l)}</p><p className="text-xs text-[var(--pq-text-muted)]">{l('记录时间：', 'Recorded: ')}{dateLabel(point.observedAt)}</p>{furthest && typeof point.furthestPageIndex === 'number' && typeof point.furthestOffsetRatio === 'number' ? <p className="text-xs text-[var(--pq-text-muted)]">{l('最远进度：', 'Furthest progress: ')}{pointLabel({ pageIndex: point.furthestPageIndex, offsetRatio: point.furthestOffsetRatio }, l)}</p> : null}</div>;
}
function validSnapshot(value: DesktopReadingReaderSnapshot): boolean {
  return /^[0-9a-f]{64}$/.test(value.sha256) && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 && value.sizeBytes <= 64 * 1024 * 1024
    && Number.isSafeInteger(value.pageCount) && value.pageCount > 0 && Number.isSafeInteger(value.pageIndex) && value.pageIndex >= 0 && value.pageIndex < value.pageCount
    && Number.isFinite(value.offsetRatio) && value.offsetRatio >= 0 && value.offsetRatio <= 1 && Number.isFinite(Date.parse(value.observedAt));
}
function sameProof(left: Pick<VerifiedDesktopReadingSource, 'sha256' | 'sizeBytes' | 'pageCount'>, right: Pick<VerifiedDesktopReadingSource, 'sha256' | 'sizeBytes' | 'pageCount'>): boolean {
  return left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes && left.pageCount === right.pageCount;
}
function samePosition(left: ReadingPositionData, right: ReadingPositionData): boolean {
  return (['paperId', 'attachmentVersionId', 'pageIndex', 'offsetRatio', 'furthestPageIndex', 'furthestOffsetRatio', 'sessionId', 'deviceSequence', 'observedAt'] as const).every(key => left[key] === right[key]);
}

export interface DesktopReadingPositionPanelProps {
  localPaperId: string | null; reader: DesktopReadingReaderAccess | null; active: boolean;
  tracking?: DesktopReadingTrackingController;
  onClose(): void; onConfigureAccount?(): void;
}
export function DesktopReadingPositionPanel(props: DesktopReadingPositionPanelProps) {
  return <OwnedReadingPositionPanel key={`${props.active}:${props.localPaperId ?? ''}:${props.reader?.id ?? ''}`} {...props} />;
}
function OwnedReadingPositionPanel(props: DesktopReadingPositionPanelProps) {
  const l = useLocaleText(), titleId = useId();
  const [status, setStatus] = useState<DesktopReadingPositionStatus | null>(null), [statusReady, setStatusReady] = useState(false);
  const [task, setTask] = useState<Task | null>(null), [versions, setVersions] = useState<VerifiedDesktopReadingSource[]>([]), [selectedVersion, setSelectedVersion] = useState('');
  const [capture, setCapture] = useState<DesktopReadingReaderSnapshot | null>(null), [preview, setPreview] = useState<DesktopReadingPositionPreview | null>(null);
  const [selectedPosition, setSelectedPosition] = useState(''), [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Record<string, DesktopReadingConflictChoice>>({});
  const [working, setWorking] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [trackingState, setTrackingState] = useState<DesktopReadingTrackingSnapshot | null>(() => props.tracking?.snapshot() ?? null);
  const alive = useRef(false), sequence = useRef(0), reads = useRef(0), operation = useRef<string | null>(null), fresh = useRef(false);
  const statusRef = useRef(status), previewRef = useRef(preview), captureRef = useRef(capture), selectionRef = useRef(''), positionRef = useRef(''), confirmationRef = useRef<Confirmation | null>(null);
  const choicesRef = useRef(conflictChoices), taskRef = useRef(task), latest = useRef(props), panel = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null);
  latest.current = props;
  const clearPreview = useCallback(() => {
    previewRef.current = null; confirmationRef.current = null; positionRef.current = ''; choicesRef.current = {};
    setPreview(null); setConfirmation(null); setSelectedPosition(''); setConflictChoices({});
  }, []);
  const clearSource = useCallback(() => { clearPreview(); captureRef.current = null; selectionRef.current = ''; setCapture(null); setVersions([]); setSelectedVersion(''); }, [clearPreview]);
  const acceptStatus = useCallback((next: DesktopReadingPositionStatus) => {
    const old = statusRef.current;
    if (old?.scopeKey !== next.scopeKey) {
      sequence.current++; operation.current = null; setWorking(null); clearSource(); taskRef.current = null; setTask(null); setNotice(''); setError(null);
    } else if (old.revision !== next.revision || !next.supported || next.saveUnconfirmed || next.errorCode && /SOURCE_CHANGED|BINDING_CHANGED|PREVIEW_STALE|DEVICE_CHANGED/.test(next.errorCode)) clearPreview();
    if (next.saveUnconfirmed || next.errorCode) setNotice('');
    statusRef.current = next; setStatus(next); fresh.current = true; setStatusReady(true);
  }, [clearPreview, clearSource]);
  const reloadStatus = useCallback(async () => {
    if (!alive.current || !latest.current.active) return;
    const read = ++reads.current; fresh.current = false; setStatusReady(false);
    try { const next = await desktopReadingPosition.status(); if (alive.current && read === reads.current) acceptStatus(next); }
    catch (failure) { if (alive.current && read === reads.current) { setError(errorCode(failure)); fresh.current = false; setStatusReady(false); } }
  }, [acceptStatus]);
  useEffect(() => {
    if (!props.active) return;
    alive.current = true; void reloadStatus(); let listening = true, unsubscribe: (() => void) | undefined;
    void desktopReadingPosition.onChanged(change => {
      if (change && change.readingScopeKey !== statusRef.current?.scopeKey) {
        sequence.current++; operation.current = null; fresh.current = false; setWorking(null); clearSource();
        taskRef.current = null; setTask(null); setNotice(''); setError(null);
      }
      void reloadStatus();
    }).then(stop => { if (listening) unsubscribe = stop; else stop(); }).catch(() => { /* The local status request reports bridge failures. */ });
    return () => { listening = false; alive.current = false; sequence.current++; reads.current++; previewRef.current = null; confirmationRef.current = null; unsubscribe?.(); };
  }, [props.active, reloadStatus, clearSource]);
  useEffect(() => {
    const controller = props.tracking;
    if (!props.active || !controller) { setTrackingState(null); return; }
    let listening = true;
    const update = () => { if (listening && latest.current.tracking === controller) setTrackingState(controller.snapshot()); };
    const unsubscribe = controller.subscribe(update); update();
    return () => { listening = false; unsubscribe(); };
  }, [props.active, props.tracking]);
  useEffect(() => {
    if (!props.active || typeof document === 'undefined') return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; heading.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [props.active]);
  useEffect(() => { if (confirmation) panel.current?.querySelector<HTMLElement>('[data-reading-confirmation]')?.focus({ preventScroll: true }); else heading.current?.focus({ preventScroll: true }); }, [task, preview?.token, confirmation]);

  const ownerCurrent = (owner: string) => alive.current && latest.current.active && statusRef.current?.scopeKey === owner;
  const readerCurrent = (reader: DesktopReadingReaderAccess | null) => !!reader && latest.current.reader?.id === reader.id && reader.isCurrent();
  const mayUseStatus = () => !!statusRef.current?.scopeKey && fresh.current && alive.current && latest.current.active && !statusRef.current.busy && !operation.current;
  const mayUsePreview = (value: DesktopReadingPositionPreview) => mayUseStatus() && previewRef.current === value && statusRef.current?.scopeKey === value.scopeKey
    && statusRef.current.revision === value.revision && statusRef.current.supported && !statusRef.current.saveUnconfirmed && !statusRef.current.busy && readerCurrent(latest.current.reader);
  const run = async (kind: string, action: (operation: Operation) => Promise<void>, withReader = false, interrupt = false) => {
    const owner = statusRef.current?.scopeKey, reader = latest.current.reader;
    if (!alive.current || !latest.current.active || !owner || operation.current && !interrupt || withReader && !readerCurrent(reader)) return;
    const request = ++sequence.current; operation.current = kind; setWorking(kind); setError(null); setNotice('');
    const current = () => request === sequence.current && ownerCurrent(owner) && (!withReader || readerCurrent(reader));
    try { await action({ current, owner, reader }); }
    catch (failure) { if (request === sequence.current && ownerCurrent(owner)) { const code = !current() && withReader ? 'READING_READER_CHANGED' : errorCode(failure); setError(code); if (/CHANGED|STALE|MISMATCH/.test(code)) clearPreview(); await reloadStatus(); } }
    finally { if (alive.current && request === sequence.current) { operation.current = null; setWorking(null); } }
  };
  const assertCurrent = (work: Operation) => { if (!work.current()) throw Error('READING_READER_CHANGED'); };
  const loadPreview = async (work: Operation, snapshot: DesktopReadingReaderSnapshot, source: VerifiedDesktopReadingSource) => {
    assertCurrent(work); if (captureRef.current !== snapshot || selectionRef.current !== source.bindingId) throw Error('READING_PREVIEW_STALE');
    const submitted: DesktopReadingCapture = { ...snapshot, bindingId: source.bindingId };
    const result = await desktopReadingPosition.preview({ capture: submitted }); assertCurrent(work);
    if (result.scopeKey !== work.owner || result.source.bindingId !== source.bindingId || result.source.attachmentVersionId !== source.attachmentVersionId || !sameProof(result.source, snapshot)
      || (Object.keys(submitted) as (keyof DesktopReadingCapture)[]).some(key => result.capture[key] !== submitted[key])) throw Error('READING_PREVIEW_STALE');
    const next = await desktopReadingPosition.status(); assertCurrent(work); reads.current++; acceptStatus(next);
    if (next.scopeKey !== work.owner || next.revision !== result.revision || captureRef.current !== snapshot || selectionRef.current !== source.bindingId) throw Error('READING_PREVIEW_STALE');
    previewRef.current = result; setPreview(result);
  };
  const checkCurrentPdf = (nextTask: Task) => {
    if (!mayUseStatus() || !statusRef.current?.supported || statusRef.current.saveUnconfirmed || !props.localPaperId) return;
    taskRef.current = nextTask; setTask(nextTask); clearSource();
    void run('check', async work => {
      const snapshot = await work.reader!.capture(); assertCurrent(work); if (!validSnapshot(snapshot)) throw Error('READING_POSITION_UNSUPPORTED');
      const result = await desktopReadingPosition.versions({ localPaperId: latest.current.localPaperId!, sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, pageCount: snapshot.pageCount }); assertCurrent(work);
      if (result.scopeKey !== work.owner || result.versions.some(source => source.localPaperId !== latest.current.localPaperId || !sameProof(source, snapshot))) throw Error('READING_SOURCE_CHANGED');
      captureRef.current = snapshot; setCapture(snapshot); setVersions(result.versions);
      if (result.versions.length === 1) { const source = result.versions[0]; selectionRef.current = source.bindingId; setSelectedVersion(source.bindingId); await loadPreview(work, snapshot, source); }
      else if (!result.versions.length) setError('READING_BINDING_REQUIRED');
    }, true);
  };
  const checkSelected = () => {
    const snapshot = captureRef.current, source = versions.find(row => row.bindingId === selectionRef.current);
    if (!mayUseStatus() || !snapshot || !source) return; clearPreview();
    void run('check', work => loadPreview(work, snapshot, source), true);
  };
  const finishStatus = async (next: DesktopReadingPositionStatus, work: Operation, success: string) => {
    if (!work.current() || next.scopeKey !== work.owner) return;
    reads.current++; acceptStatus(next); clearPreview();
    if (next.errorCode) setError(next.errorCode);
    else if (next.saveUnconfirmed) setError('READING_SAVE_UNCONFIRMED');
    else setNotice(next.pending || next.conflicts ? l('原请求已保留，仍有操作待确认。请查看未完成操作。', 'The original request is preserved. Some operations remain unconfirmed; review unfinished operations.') : success);
    // The runtime action can return its busy snapshot before its finally event.
    // Fetch the settled local status instead of letting a late reply pin busy.
    await reloadStatus();
  };
  const confirm = (next: Confirmation | null) => { confirmationRef.current = next; setConfirmation(next); };
  const sendPosition = (choice: Confirmation) => {
    if (choice.kind !== 'publish' || confirmationRef.current !== choice || taskRef.current !== 'publish' || !mayUsePreview(choice.preview) || choice.preview.publicationAction === 'blocked') return;
    void run('publish', async work => {
      const result = await desktopReadingPosition.publish({ token: choice.preview.token });
      await finishStatus(result, work, l('这个位置已发送到账号，其他设备同步后可明确接续。', 'This position was sent to the account. Other devices can explicitly resume after syncing.'));
    }, true);
  };
  const resumePosition = (choice: Confirmation) => {
    if (choice.kind !== 'resume' || confirmationRef.current !== choice || taskRef.current !== 'resume' || positionRef.current !== choice.position.entityId || !mayUsePreview(choice.preview)) return;
    void run('resume', async work => {
      const { preview: view, position: row } = choice;
      const result = await desktopReadingPosition.resume({ token: view.token, entityId: row.entityId, expectedRevision: row.revision }); assertCurrent(work);
      if (previewRef.current !== view || confirmationRef.current !== choice || positionRef.current !== row.entityId || result.scopeKey !== work.owner
        || result.source.bindingId !== view.source.bindingId || result.source.paperId !== view.source.paperId || result.source.attachmentVersionId !== view.source.attachmentVersionId
        || !sameProof(result.source, view.source) || result.origin.entityId !== row.entityId || result.origin.revision !== row.revision || result.origin.deviceId !== row.deviceId || !samePosition(result.position, row.data)) throw Error('READING_PREVIEW_STALE');
      const next = await desktopReadingPosition.status(); assertCurrent(work); reads.current++; acceptStatus(next);
      if (next.scopeKey !== work.owner || next.revision !== view.revision || previewRef.current !== view || confirmationRef.current !== choice) throw Error('READING_PREVIEW_STALE');
      operation.current = 'apply'; setWorking('apply');
      await work.reader!.resume({ sha256: result.source.sha256, sizeBytes: result.source.sizeBytes, pageCount: result.source.pageCount, pageIndex: result.position.pageIndex, offsetRatio: result.position.offsetRatio }, {
        isCurrent: () => work.current() && previewRef.current === view && confirmationRef.current === choice && positionRef.current === row.entityId,
      }); assertCurrent(work);
      clearPreview(); setNotice(l(`已在当前 PDF 接续到第 ${result.position.pageIndex + 1} 页。`, `Resumed the current PDF on page ${result.position.pageIndex + 1}.`));
    }, true);
  };
  const enableTracking = (view: DesktopReadingPositionPreview) => {
    const controller = latest.current.tracking;
    if (!controller || statusRef.current?.tracking || !mayUsePreview(view) || !['stopped', 'error'].includes(controller.snapshot().phase)) return;
    void run('tracking-start', async work => {
      await controller.start(view); assertCurrent(work);
      if (latest.current.tracking !== controller) throw Error('READING_READER_CHANGED');
      clearPreview(); await reloadStatus(); assertCurrent(work);
      setNotice(l('本机记录已开启；发送到账号需另行检查并确认。', 'Local recording is on. Sending to the account requires a separate check and confirmation.'));
    }, true);
  };
  const stopTracking = () => {
    const controller = latest.current.tracking;
    if (!controller || !mayUseStatus()) return;
    void run('tracking-stop', async work => {
      await controller.stop(); if (!work.current() || latest.current.tracking !== controller) return;
      clearPreview(); await reloadStatus();
      if (work.current()) setNotice(l('已停止本次阅读记录，本机已保存的位置仍保留。', 'This reading session stopped. Locally saved positions are preserved.'));
    });
  };
  const chooseTask = (value: Task) => { if (!mayUseStatus()) return; taskRef.current = value; setTask(value); clearSource(); setNotice(''); setError(null); };
  const close = () => { if (operation.current) return; sequence.current++; previewRef.current = null; confirmationRef.current = null; props.onClose(); };
  const busy = !!working || !!status?.busy, ready = statusReady && !!status?.scopeKey, canCheck = ready && !!status?.supported && !status.saveUnconfirmed && !busy && !!props.localPaperId && readerCurrent(props.reader);
  const visibleError = error || status?.errorCode, selected = preview?.positions.find(row => row.entityId === selectedPosition);
  const taskLabels: Record<Task, string> = { publish: l('发布当前阅读位置', 'Publish the current position'), resume: l('从设备位置继续阅读', 'Resume from a device position'), pending: l('处理未完成操作', 'Handle unfinished operations') };
  if (!props.active) return null;
  const content = <div className="fixed inset-0 z-[12000] flex justify-end bg-black/25 dark:bg-black/50" data-desktop-reading-overlay>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="flex h-full min-w-0 w-full max-w-2xl flex-col overflow-hidden bg-[var(--pq-surface-1)] text-[var(--pq-text)] shadow-2xl outline-none" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab' || !panel.current) return;
      const controls = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary,[tabindex="0"]')].filter(node => {
        if (!node.getClientRects().length) return false;
        for (let parent = node.parentElement; parent && parent !== panel.current; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector('summary')?.contains(node)) return false;
        }
        return true;
      });
      const first = controls[0], last = controls.at(-1); if (!first) { event.preventDefault(); panel.current.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus(); }
    }}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--pq-border)] px-4 py-3"><div className="min-w-0"><h2 ref={heading} id={titleId} tabIndex={-1} className="text-lg font-semibold outline-none">{task ? taskLabels[task] : l('跨设备阅读位置', 'Reading positions across devices')}</h2><p className="mt-1 text-sm leading-6 text-[var(--pq-text-muted)]">{l('位置绑定当前打开并核验过的 PDF 版本。', 'Positions belong to the verified version of the open PDF.')}</p></div><button type="button" className={buttonClass + ' shrink-0'} aria-label={l('关闭阅读位置', 'Close reading positions')} disabled={!!working} onClick={close}><X aria-hidden className="h-4 w-4" /></button></header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4" data-reading-content>
        {task ? <button type="button" className={buttonClass} disabled={busy} onClick={() => { if (!operation.current) { taskRef.current = null; setTask(null); clearSource(); setNotice(''); setError(null); } }}><ArrowLeft aria-hidden className="h-4 w-4" />{l('返回阅读位置', 'Back to reading positions')}</button> : null}
        {visibleError ? <div role="alert" className="space-y-1 border-l-2 border-[var(--pq-accent)] pl-3"><p className="text-sm leading-6">{reasonLabel(visibleError, l)}</p><Diagnostics value={{ code: visibleError }} l={l} /></div> : null}
        {notice ? <p role="status" className="text-sm leading-6" data-reading-notice>{notice}</p> : null}
        {trackingState ? <section aria-label={l('本次阅读记录', 'This reading session')} data-reading-tracking className="space-y-3 border-b border-[var(--pq-border)] pb-4">
          <h3 className="text-sm font-medium">{trackingState.phase === 'recording' ? l('正在记录本次阅读位置', 'Recording this reading session') : trackingState.phase === 'saving' ? l('正在保存本机位置', 'Saving the local position') : trackingState.phase === 'starting' ? l('正在开启本机阅读记录', 'Starting local reading recording') : trackingState.phase === 'error' ? l('本次阅读记录遇到问题', 'This reading session needs attention') : l('本次阅读尚未开启记录', 'Recording is off for this reading session')}</h3>
          <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('只保存本机的最近位置与最远进度。发送到账号需另行检查并确认。关闭此面板会继续已开启的记录。', 'Only the recent position and furthest progress are saved locally. Sending to the account requires a separate check and confirmation. Closing this panel keeps an enabled session recording.')}</p>
          {trackingState.recent ? <div className="space-y-1"><p className="text-xs text-[var(--pq-text-muted)]">{l('本机最近位置', 'Most recent local position')}</p><PointDetails point={trackingState.recent} l={l} />{trackingState.furthest ? <p className="text-xs text-[var(--pq-text-muted)]">{l('本机最远进度：', 'Furthest local progress: ')}{pointLabel(trackingState.furthest, l)}</p> : null}</div> : null}
          {trackingState.errorCode ? <p role="alert" className="text-sm leading-6">{reasonLabel(trackingState.errorCode, l)}</p> : null}
          {(['recording', 'saving'].includes(trackingState.phase) || trackingState.phase === 'error' && !!status?.tracking) ? <button type="button" className={buttonClass} disabled={!ready || busy} onClick={stopTracking}>{trackingState.phase === 'error' ? l('重试停止记录', 'Retry stopping recording') : l('停止记录', 'Stop recording')}</button> : null}
        </section> : null}
        {!status ? <p role="status" className="text-sm text-[var(--pq-text-muted)]">{l('正在读取本机账号状态…', 'Reading local account status…')}</p> : !status.scopeKey ? <div className="space-y-2"><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('请连接账号，并将这份文献的 PDF 关联到账号版本。', 'Connect an account and link this paper’s PDF to an account version.')}</p>{props.onConfigureAccount ? <button type="button" className={buttonClass} disabled={busy} onClick={props.onConfigureAccount}>{l('打开账号设置', 'Open account settings')}</button> : null}</div> : null}
        {status?.scopeKey && !status.supported ? <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{reasonLabel('READING_FEATURE_UNAVAILABLE', l)}</p> : null}
        {working ? <div className="flex flex-wrap items-center gap-3" role="status"><p className="text-sm">{working === 'apply' ? l('正在核验当前 PDF 并应用所选位置…', 'Verifying the open PDF and applying the chosen position…') : working === 'check' ? l('正在核验 PDF 与账号位置…', 'Checking the PDF and account positions…') : working === 'stop' ? l('正在停止本次等待…', 'Stopping this wait…') : l('正在处理所选操作…', 'Processing the chosen action…')}</p>{!['apply', 'stop', 'export'].includes(working) ? <button type="button" className={buttonClass} onClick={() => { clearPreview(); void run('stop', async work => { const next = await desktopReadingPosition.stop(); await finishStatus(next, work, l('已停止本次等待，原请求与已收到的结果仍保留。', 'This wait stopped. Original requests and received results are preserved.')); }, false, true); }}>{l('停止本次等待', 'Stop this wait')}</button> : null}</div> : null}
        {status?.saveUnconfirmed ? <section className="space-y-2" aria-label={l('本机保存待确认', 'Local save unconfirmed')}><p className="text-sm leading-6">{l('已收到的结果仍保留。只重试本机保存会继续使用这个结果。', 'The received result is preserved. Retrying local saving reuses that result.')}</p><button type="button" className={buttonClass} disabled={!ready || busy} onClick={() => { if (mayUseStatus()) void run('save', async work => finishStatus(await desktopReadingPosition.retrySave(), work, l('本机保存已确认。可重新检查位置。', 'Local saving is confirmed. Check positions again.'))); }}>{l('只重试本机保存', 'Retry local saving only')}</button></section> : null}
        {!task && status?.scopeKey ? <nav aria-label={l('阅读位置操作', 'Reading position actions')} className="divide-y divide-[var(--pq-border)]">{([
          { key: 'publish' as const, icon: BookOpen, detail: l('核对当前页面，发送到账号供其他设备选用', 'Check the current page and send it for other devices to choose') },
          { key: 'resume' as const, icon: MonitorSmartphone, detail: l('选择来源设备，确认后在当前 PDF 接续', 'Choose a source device and confirm before resuming this PDF') },
          { key: 'pending' as const, icon: RefreshCw, detail: l('核对原请求、内容差异与保存结果', 'Review original requests, differing positions and save results') },
        ]).map(row => <button key={row.key} type="button" data-reading-task={row.key} className="flex min-h-11 w-full items-center gap-3 py-4 text-left disabled:opacity-50" disabled={!ready || busy} onClick={() => chooseTask(row.key)}><row.icon aria-hidden className="h-5 w-5 shrink-0 text-[var(--pq-text-muted)]" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{taskLabels[row.key]}</span><span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{row.detail}</span></span><ChevronRight aria-hidden className="h-4 w-4 shrink-0" /></button>)}</nav> : null}
        {task && !preview ? <section className="space-y-3" data-reading-prepare>
          <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{task === 'pending' ? l('检查当前 PDF 可查看对应版本及本账号未完成的原请求。', 'Check the current PDF to review its version and this account’s unfinished original requests.') : l('明确检查后读取当前 PDF 的完整内容，核对其账号版本与设备位置。', 'A deliberate check reads the complete open PDF to verify its account version and device positions.')}</p>
          <button type="button" className={buttonClass} disabled={!canCheck} onClick={() => checkCurrentPdf(task)}><RefreshCw aria-hidden className="h-4 w-4" />{capture ? l('重新检查当前 PDF', 'Check the current PDF again') : l('检查当前 PDF 与账号位置', 'Check this PDF and account positions')}</button>
          {!props.reader || !props.localPaperId ? <p className="text-sm text-[var(--pq-text-muted)]">{l('先打开本机文库中已加载完成的 PDF。', 'First open a fully loaded PDF from the local library.')}</p> : null}
          {capture && versions.length > 1 ? <fieldset disabled={busy} className="min-w-0 space-y-2"><legend className="text-sm font-medium">{l('内容相同的已关联版本，请明确选择一个', 'Matching linked versions; choose one explicitly')}</legend><Rows key={capture.observedAt} items={versions} l={l} renderRow={(source, index) => <li key={source.bindingId} className="py-1"><label className={selectionClass}><input type="radio" className={inputClass} name={titleId + '-version'} checked={selectedVersion === source.bindingId} onChange={() => { if (operation.current) return; clearPreview(); selectionRef.current = source.bindingId; setSelectedVersion(source.bindingId); }} /><span className="min-w-0 break-words [overflow-wrap:anywhere]">{l(`版本 ${index + 1}：`, `Version ${index + 1}: `)}{source.title}<span className="mt-1 block text-xs text-[var(--pq-text-muted)]">{source.fileName} · {source.pageCount} {l('页', 'pages')}</span></span></label><Diagnostics value={source} l={l} /></li>} /><button type="button" className={buttonClass} disabled={!selectedVersion || busy || !ready} onClick={checkSelected}>{l('检查所选版本', 'Check the selected version')}</button></fieldset> : null}
          {error === 'READING_BINDING_REQUIRED' && props.onConfigureAccount ? <button type="button" className={buttonClass} disabled={busy} onClick={props.onConfigureAccount}>{l('去关联这份 PDF', 'Link this PDF')}</button> : null}
        </section> : null}
        {preview ? <section className="space-y-2 border-b border-[var(--pq-border)] pb-3" data-reading-source><h3 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{preview.source.title}</h3><p className="break-words text-xs leading-5 text-[var(--pq-text-muted)] [overflow-wrap:anywhere]">{preview.source.fileName} · {preview.source.pageCount} {l('页', 'pages')}</p><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('当前打开的 PDF 与这个账号版本内容相符。', 'The open PDF matches this account version.')}</p></section> : null}
        {preview?.localDraft ? <section className="space-y-2" data-reading-local-draft><h3 className="text-sm font-medium">{l('此版本保存在本机的位置', 'Locally saved position for this version')}</h3><PointDetails point={{ ...preview.localDraft.capture, furthestPageIndex: preview.localDraft.furthestPageIndex, furthestOffsetRatio: preview.localDraft.furthestOffsetRatio }} l={l} furthest /><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('这是本机记录，不表示已发送到账号。', 'This is a local record and does not mean it was sent to the account.')}</p></section> : null}
        {preview && props.tracking && !status?.tracking && trackingState && ['stopped', 'error'].includes(trackingState.phase) && !confirmation ? <section className="space-y-2" data-reading-enable><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('为当前已核验的 PDF 开启本次记录。最近位置随实际阅读更新，最远进度单独保留；不会自动发送到账号。', 'Enable recording for this verified PDF session. The recent position follows actual reading; furthest progress is preserved separately. Nothing is sent automatically.')}</p><button type="button" className={buttonClass} disabled={busy || !ready || !!status?.saveUnconfirmed} onClick={() => enableTracking(preview)}>{l('记录本次阅读位置', 'Record this reading session')}</button></section> : null}
        {preview && task === 'publish' ? <section className="space-y-4" data-reading-publish><div className="grid min-w-0 gap-4 sm:grid-cols-2"><div className="space-y-2"><h3 className="text-sm text-[var(--pq-text-muted)]">{l('这次检查的位置', 'Position captured by this check')}</h3><PointDetails point={preview.capture} l={l} /></div><div className="space-y-2"><h3 className="text-sm text-[var(--pq-text-muted)]">{l('此设备的账号位置', 'This device’s account position')}</h3>{preview.own?.deletedAt ? <p className="text-sm">{l('此设备的账号位置已删除。', 'This device’s account position was deleted.')}</p> : <PointDetails point={preview.own?.data ?? null} l={l} furthest />}</div></div><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('最近位置可以回到较早页面，最远进度会单独保留。', 'The recent position can move to an earlier page; furthest progress is preserved separately.')}</p>{preview.publicationReason ? <p className="text-sm leading-6">{reasonLabel(preview.publicationReason, l)}</p> : null}{!confirmation ? <button type="button" className={buttonClass} disabled={busy || !ready || status?.saveUnconfirmed || preview.publicationAction === 'blocked'} onClick={() => { if (mayUsePreview(preview)) confirm({ kind: 'publish', preview }); }}>{preview.publicationAction === 'restore' ? l('核对恢复已删除的位置', 'Review restoring the deleted position') : l('核对并发布这个位置', 'Review publishing this position')}</button> : null}</section> : null}
        {preview && task === 'resume' && !confirmation ? <section className="space-y-3" data-reading-positions><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('请选择一个设备位置。确认前，当前阅读页保持原位。', 'Choose a device position. The current page stays in place until you confirm.')}</p>{preview.positions.length ? <Rows key={preview.token} items={preview.positions} l={l} renderRow={(row, index) => <li key={row.entityId} className="py-1"><label className={selectionClass}><input type="radio" className={inputClass} name={titleId + '-position'} checked={selectedPosition === row.entityId} disabled={busy} onChange={() => { if (operation.current) return; positionRef.current = row.entityId; setSelectedPosition(row.entityId); confirm(null); }} /><span className="min-w-0"><span className="block break-words font-medium">{deviceLabel(row, l)}{!row.deviceName && !row.isCurrentDevice ? l(` · 记录 ${index + 1}`, ` · record ${index + 1}`) : ''}</span><span className="mt-1 block text-sm">{pointLabel(row.data, l)}</span><span className="mt-1 block text-xs text-[var(--pq-text-muted)]">{dateLabel(row.data.observedAt)}</span></span></label><Diagnostics value={row} l={l} /></li>} /> : <p className="text-sm">{l('这个版本还没有可接续的设备位置。', 'This version has no device position to resume from yet.')}</p>}<button type="button" className={buttonClass} disabled={busy || !ready || !selected} onClick={() => { if (selected && positionRef.current === selected.entityId && mayUsePreview(preview)) confirm({ kind: 'resume', preview, position: selected }); }}><ArrowRight aria-hidden className="h-4 w-4" />{l('核对接续位置', 'Review the resume position')}</button></section> : null}
        {confirmation ? <section role="group" tabIndex={-1} aria-label={l('确认位置操作', 'Confirm position action')} data-reading-confirmation className="space-y-3 border-l-2 border-[var(--pq-accent)] pl-3 outline-none"><h3 className="text-sm font-medium">{confirmation.kind === 'resume' ? deviceLabel(confirmation.position, l) : l('本次将发布的位置', 'Position to publish')}</h3><PointDetails point={confirmation.kind === 'resume' ? confirmation.position.data : confirmation.preview.capture} l={l} />{confirmation.kind === 'resume' ? <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('确认后重新核验所选设备位置与当前 PDF，再跳转到这个位置。', 'Confirmation rechecks the selected device position and open PDF, then moves to this position.')}</p> : <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{confirmation.preview.publicationAction === 'restore' ? l('确认后恢复此设备已删除的账号位置，并发布本次检查的位置。', 'Confirmation restores this device’s deleted account position and publishes the position captured by this check.') : l('确认后发送本次检查的位置，其他设备同步后可自行选择接续。', 'Confirmation sends the captured position. Other devices can choose it after syncing.')}</p>}<div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy || !ready} onClick={() => confirmation.kind === 'resume' ? resumePosition(confirmation) : sendPosition(confirmation)}><Check aria-hidden className="h-4 w-4" />{confirmation.kind === 'resume' ? l('确认在当前 PDF 接续', 'Resume this PDF here') : confirmation.preview.publicationAction === 'restore' ? l('确认恢复并发布此位置', 'Restore and publish this position') : l('确认发布此位置', 'Publish this position')}</button><button type="button" className={buttonClass} disabled={busy} onClick={() => confirm(null)}>{l('返回核对', 'Back to review')}</button></div></section> : null}
        {preview && task === 'pending' ? <section className="space-y-4" data-reading-pending>
          {preview.conflicts.length ? <section aria-label={l('需要选择的位置', 'Positions needing a choice')}><h3 className="text-sm font-medium">{l('位置不同，需要你的选择', 'Positions differ and need your choice')}</h3><Rows key={preview.token + '-conflicts'} items={preview.conflicts} l={l} renderRow={row => <li key={row.conflictId} className="space-y-3 py-3"><h4 className="break-words text-sm font-medium">{row.label}</h4><div className="grid min-w-0 gap-3 sm:grid-cols-2"><div className="space-y-2"><p className="text-xs text-[var(--pq-text-muted)]">{l('账号当前位置', 'Current account position')}</p>{row.current?.deletedAt ? <p className="text-sm">{l('账号位置已删除。', 'The account position was deleted.')}</p> : <PointDetails point={row.current?.data ?? null} l={l} furthest />}</div><div className="space-y-2"><p className="text-xs text-[var(--pq-text-muted)]">{l('上次尝试的位置', 'Previously attempted position')}</p><PointDetails point={row.attempted.data} l={l} furthest />{row.attempted.mutation !== 'put' ? <p className="text-xs">{row.attempted.mutation === 'restore' ? l('上次动作：恢复位置', 'Previous action: restore position') : l('上次动作：删除位置', 'Previous action: delete position')}</p> : null}</div></div>{!row.canResolve && row.reason ? <p className="text-sm">{reasonLabel(row.reason, l)}</p> : null}{(['current', 'attempted'] as const).map(choice => <label key={choice} className={selectionClass}><input type="radio" className={inputClass} name={titleId + '-conflict-' + row.conflictId} disabled={busy || !row.canResolve} checked={conflictChoices[row.conflictId] === choice} onChange={() => { if (operation.current) return; choicesRef.current = { ...choicesRef.current, [row.conflictId]: choice }; setConflictChoices(choicesRef.current); }} /><span>{choice === 'current' ? l('保留账号当前位置', 'Keep the current account position') : l('使用上次尝试的位置', 'Use the previously attempted position')}</span></label>)}<button type="button" className={buttonClass} disabled={busy || !ready || !row.canResolve || !conflictChoices[row.conflictId]} onClick={() => { const choice = conflictChoices[row.conflictId]; if (!choice || choicesRef.current[row.conflictId] !== choice || !mayUsePreview(preview) || !row.canResolve) return; void run('resolve', async work => finishStatus(await desktopReadingPosition.resolve({ conflictId: row.conflictId, choice, expectedRevision: row.expectedRevision }), work, l('这项位置选择已处理。可重新检查结果。', 'This position choice was processed. Check again to review the result.')), true); }}>{l('确认这项选择', 'Confirm this choice')}</button><Diagnostics value={row} l={l} /></li>} /></section> : null}
          {preview.pendingRows.length ? <section><h3 className="text-sm font-medium">{l('原请求的处理状态', 'Original request status')}</h3><Rows key={preview.token + '-pending'} items={preview.pendingRows} l={l} renderRow={row => <li key={row.opId} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{row.label}</p><p className="text-sm text-[var(--pq-text-muted)]">{row.stage === 'uncertain' ? l('上次发送结果未知，继续时只核对并使用原请求。', 'The previous send result is unknown. Continuing checks and uses only the original request.') : row.stage === 'queued' ? l('已保存在本机，等待发送。', 'Saved locally and waiting to send.') : row.stage === 'conflict' ? l('位置不同，需要选择。', 'Positions differ and need a choice.') : row.stage === 'device-blocked' ? l('原请求属于其他登录设备，当前设备不能改写。', 'The original request belongs to another signed-in device and cannot be changed here.') : l('原请求未被接受，请核对原因。', 'The original request was not accepted. Review the reason.')}</p>{row.errorCode ? <p className="text-sm">{reasonLabel(row.errorCode, l)}</p> : null}<PointDetails point={row.data} l={l} furthest /><Diagnostics value={row} l={l} /></li>} /></section> : null}
          {preview.pendingResolutions.length ? <section><h3 className="text-sm font-medium">{l('上次选择的处理状态', 'Previous choice status')}</h3><Rows key={preview.token + '-resolutions'} items={preview.pendingResolutions} l={l} renderRow={row => <li key={row.opId} className="space-y-2 py-3"><p className="text-sm">{row.choice === 'current' ? l('保留账号位置', 'Keep the account position') : l('使用上次位置', 'Use the previous position')}</p><p className="text-sm text-[var(--pq-text-muted)]">{row.lastResult?.status === 'rejected' ? l('选择未被接受，请核对原结果。', 'The choice was rejected. Review the original result.') : row.lastResult?.status === 'conflict' ? l('账号位置又有变化，请重新检查。', 'The account position changed again. Check again.') : row.lastResult?.status === 'applied' ? l('选择已接受，等待本机保存确认。', 'The choice was accepted; local saving is awaiting confirmation.') : l('处理结果尚未确认。', 'The result is not yet confirmed.')}</p>{row.lastResult?.code ? <p className="text-sm">{reasonLabel(row.lastResult.code, l)}</p> : null}<Diagnostics value={row} l={l} /></li>} /></section> : null}
          {!preview.pendingRows.length && !preview.conflicts.length && !preview.pendingResolutions.length ? <p className="text-sm text-[var(--pq-text-muted)]">{l('没有等待发送或选择的位置操作。', 'No position operations are waiting to send or resolve.')}</p> : null}
          {!!status?.continuable && !status.saveUnconfirmed ? <button type="button" className={buttonClass} disabled={busy || !ready} onClick={() => { if (mayUsePreview(preview)) void run('continue', async work => finishStatus(await desktopReadingPosition.continue(), work, l('已继续处理原请求，可重新检查结果。', 'The original request continued. Check again to review the result.')), true); }}>{l('继续处理原请求', 'Continue original request')}</button> : null}
        </section> : null}
        {preview && !confirmation ? <button type="button" className={buttonClass} disabled={!canCheck} onClick={() => checkCurrentPdf(task!)}><RefreshCw aria-hidden className="h-4 w-4" />{l('重新检查当前 PDF', 'Check the current PDF again')}</button> : null}
        {status?.scopeKey ? <details className="border-t border-[var(--pq-border)]"><summary className={summaryClass}>{l('本机记录与备份', 'Local records and backup')}</summary><dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--pq-text-muted)]">{[[l('待处理', 'Pending'), status.pending], [l('内容不同', 'Differing positions'), status.conflicts]].map(([label, count]) => <div key={label} className="flex gap-2"><dt>{label}</dt><dd>{count}</dd></div>)}</dl><p className="my-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('备份包含此服务、账号和文库的完整位置记录，以及未确认的原请求与结果。请保存在私人位置。', 'The backup contains complete position records for this service, account and library, including unconfirmed original requests and results. Save it privately.')}</p><div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready || busy} onClick={() => { if (mayUseStatus()) void run('export', async work => { const result = await desktopReadingPosition.exportBackup(); if (work.current()) setNotice(result.status === 'exported' ? l('阅读位置记录已导出备份。', 'Reading position records were exported.') : l('已取消导出，原记录仍保留。', 'Export was cancelled; original records are preserved.')); }); }}><Download aria-hidden className="h-4 w-4" />{l('导出阅读位置备份', 'Export reading position backup')}</button><button type="button" className={buttonClass} disabled={busy} onClick={() => { if (!operation.current) void reloadStatus(); }}>{l('刷新本机状态', 'Refresh local status')}</button></div><Diagnostics value={preview ?? status} l={l} /></details> : null}
      </div>
    </div>
  </div>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
