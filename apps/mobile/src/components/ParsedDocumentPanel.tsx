import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodeParsedDocument, PARSED_LIMITS, ParsedDocumentError, type ParsedDocumentPackage } from '../../../../packages/sync-core/src/parsedDocument.ts';
import { getParsedCache } from '../parsed/cache.ts';
import { prepareParsedAssets, type ParsedAssets } from '../parsed/assets.ts';
import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';
import type { PdfVersion } from '../pdf/types.ts';
import { PdfError, throwIfAborted } from '../pdf/errors.ts';
import { registerPdfTask, waitForPdfTask } from '../pdf/tasks.ts';
import { ParsedDocumentView } from './ParsedDocumentView.tsx';

interface Ready { document: ParsedDocumentPackage; digest: string; assets: ParsedAssets }
interface Task { signal: AbortSignal; check(): void; guard(): boolean }
export interface ParsedDocumentPanelProps {
  scope: AccountScope; version: PdfVersion; pageCount: number; pdfPageIndex: number;
  isCurrent(): boolean; onJump(pageIndex: number): void;
}

export function assertParsedTarget(document: ParsedDocumentPackage, version: PdfVersion, pageCount: number): void {
  if (document.paperId !== version.data.paperId || document.attachmentVersionId !== version.entityId
    || document.pdf.sha256 !== version.data.sha256 || document.pdf.sizeBytes !== version.data.sizeBytes
    || document.pdf.pageCount !== pageCount) throw new PdfError('VERSION_MISMATCH');
}

function message(error: unknown): string {
  if (error instanceof ParsedDocumentError) {
    if (error.code === 'PACKAGE_LIMIT') return '解析包超过大小或内容上限，请在桌面缩减后重新导出。';
    if (error.code === 'HASH_UNAVAILABLE') return '此环境不能校验解析包，请使用受支持的安全连接。';
    return '解析包不完整或格式不受支持，原有解析内容已保留。';
  }
  if (error instanceof PdfError) {
    if (error.code === 'VERSION_MISMATCH') return '解析包与当前文献或 PDF 版本不一致，原有解析内容已保留。';
    if (error.code === 'CACHE_FULL') return '解析缓存已满（最多 64 MB、32 份）。请清理不再需要的解析包后重试。';
    if (error.code === 'CACHE_CORRUPT') return '解析包中的图片或本机缓存不完整，请重新导入有效解析包。';
    if (error.code === 'CACHE_UNAVAILABLE') return '无法保存解析缓存，原有内容已保留。请检查本机存储后重试。';
    return error.message;
  }
  return '解析包未能完成保存，原有内容已保留。请重试。';
}

/** A mounted panel is bound to one loaded PDF; PaperReader keys it by that identity. */
export default function ParsedDocumentPanel(props: ParsedDocumentPanelProps) {
  const { scope, version, pageCount } = props;
  const scopeKey = accountScopeKey(scope);
  const cache = useMemo(() => getParsedCache(), []);
  const latest = useRef(props); latest.current = props;
  const mounted = useRef(false);
  const active = useRef<AbortController | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const resources = useRef<Ready | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(props.pdfPageIndex);
  const [pageInput, setPageInput] = useState(String(props.pdfPageIndex + 1));
  const [offset, setOffset] = useState(0);

  const run = useCallback(async (label: string, work: (task: Task) => Promise<void>) => {
    active.current?.abort();
    const abort = new AbortController(); active.current = abort;
    const token = ++generation.current;
    const parent = lifetime.current;
    const cancel = () => abort.abort();
    parent?.signal.addEventListener('abort', cancel, { once: true });
    if (parent?.signal.aborted) abort.abort();
    const check = () => {
      throwIfAborted(abort.signal);
      if (!mounted.current || generation.current !== token || !latest.current.isCurrent()) throw new PdfError('ACCOUNT_CHANGED');
    };
    const guard = () => { try { check(); return true; } catch { return false; } };
    setBusy(label); setError(null); setNotice(null);
    try { check(); await waitForPdfTask(abort.signal, () => work({ signal: abort.signal, check, guard })); }
    catch (failure) { if (mounted.current && token === generation.current) setError(message(failure)); }
    finally {
      parent?.signal.removeEventListener('abort', cancel);
      if (mounted.current && token === generation.current) { active.current = null; setBusy(null); }
    }
  }, []);

  const adopt = useCallback(async (value: { document: ParsedDocumentPackage; digest: string }, task: Task, save: boolean) => {
    task.check(); assertParsedTarget(value.document, version, pageCount);
    const assets = await prepareParsedAssets(value.document, task.signal);
    let accepted = false;
    try {
      task.check();
      if (save) await cache.put(scope, value, { signal: task.signal, guard: task.guard });
      task.check();
      const next = { ...value, assets };
      resources.current?.assets.release(); resources.current = next; accepted = true;
      setReady(next); setOffset(0);
      setNotice(save ? '解析包已保存到此账号的本机缓存，可离线重开。' : '已读取本机解析缓存。');
    } finally { if (!accepted) assets.release(); }
  }, [cache, scope, version, pageCount]);
  const liveAdopt = useRef(adopt); liveAdopt.current = adopt;

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController(); lifetime.current = abort;
    const clearResources = () => {
      active.current?.abort(); resources.current?.assets.release(); resources.current = null;
      if (mounted.current) setReady(null);
    };
    abort.signal.addEventListener('abort', clearResources, { once: true });
    const release = registerPdfTask(scope, abort);
    void run('正在读取解析缓存…', async (task) => {
      const value = await cache.read(scope, version, pageCount, { signal: task.signal, guard: task.guard });
      task.check(); if (value) await liveAdopt.current(value, task, false);
    });
    return () => {
      mounted.current = false; ++generation.current; abort.abort(); release();
      if (lifetime.current === abort) lifetime.current = null;
    };
    // The parent key binds scope, loaded PDF and version; callbacks are read live.
  }, [scopeKey, version.entityId, version.data.sha256, pageCount, cache, run]);

  useEffect(() => { setPageIndex(props.pdfPageIndex); setPageInput(String(props.pdfPageIndex + 1)); setOffset(0); }, [props.pdfPageIndex]);
  const choosePage = (index: number) => {
    const next = Math.max(0, Math.min(pageCount - 1, Number.isFinite(index) ? Math.trunc(index) : 0));
    setPageIndex(next); setPageInput(String(next + 1)); setOffset(0);
  };
  const blockCount = useMemo(() => ready?.document.blocks.filter((block) => block.pageIndex === pageIndex).length ?? 0, [ready, pageIndex]);
  const jump = useCallback((index: number) => { if (latest.current.isCurrent()) latest.current.onJump(index); }, []);
  const importFile = (file: File) => void run('正在核对解析包…', async (task) => {
    // Keep the byte bound before allocating or JSON parsing the complete input.
    if (!file.size || file.size > PARSED_LIMITS.maxPackageBytes) throw new ParsedDocumentError('PACKAGE_LIMIT');
    const bytes = new Uint8Array(await file.arrayBuffer()); task.check();
    const value = await decodeParsedDocument(bytes); task.check();
    await liveAdopt.current(value, task, true);
  });

  return <div className="pr-panel-content parsed-panel">
    <p className="pr-muted">导入桌面为此 PDF 导出的解析包，查看公式、表格和插图。解析包只保存在本设备当前账号中。</p>
    <div className="parsed-actions"><label className="parsed-file">{ready ? '替换解析包' : '导入解析包'}
      <input aria-label="导入解析包" type="file" accept="application/json,.json" disabled={Boolean(busy)} onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) importFile(file);
      }} /></label>
      <button type="button" disabled={Boolean(busy)} onClick={() => {
        if (!window.confirm('清理此 PDF 在本设备的解析缓存？原始 PDF、笔记和导出的解析包文件会保留。')) return;
        void run('正在清理解析缓存…', async (task) => {
          await cache.remove(scope, version.entityId, { signal: task.signal, guard: task.guard }); task.check();
          resources.current?.assets.release(); resources.current = null; setReady(null); setNotice('本机解析缓存已清理。');
        });
      }}>清理此版本解析缓存</button>
    </div>
    <details className="parsed-cache-management"><summary>管理本机解析空间</summary>
      <p className="pr-muted">最多保留 32 份、共 64 MB 的解析包。清理后可以从原导出文件重新导入。</p>
      <button type="button" disabled={Boolean(busy)} onClick={() => {
        if (!window.confirm('清除此账号在本设备的全部解析包？PDF、笔记、文库与原导出文件会保留。')) return;
        void run('正在清理解析缓存…', async (task) => {
          await cache.clear(scope, { signal: task.signal, guard: task.guard }); task.check();
          resources.current?.assets.release(); resources.current = null; setReady(null); setNotice('此账号的本机解析缓存已清理。');
        });
      }}>清除此账号的全部解析缓存</button>
    </details>
    {(busy || error || notice) && <div className={`parsed-feedback${error ? ' parsed-error' : ''}`} role={error ? 'alert' : 'status'}>
      <span>{busy || error || notice}</span>{busy && <button type="button" onClick={() => active.current?.abort()}>取消解析操作</button>}
    </div>}
    {ready ? <>
      <div className="parsed-page-controls"><button type="button" aria-label="上一解析页" disabled={!pageIndex} onClick={() => choosePage(pageIndex - 1)}>‹</button>
        <form onSubmit={(event) => { event.preventDefault(); choosePage(Number(pageInput) - 1); }}>
          <label>解析页 <input inputMode="numeric" aria-label="解析页码" value={pageInput}
            onChange={(event) => setPageInput(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
          <span>/ {pageCount}</span><button type="submit">转到</button></form>
        <button type="button" aria-label="下一解析页" disabled={pageIndex + 1 >= pageCount} onClick={() => choosePage(pageIndex + 1)}>›</button></div>
      <div className="parsed-page-info"><span>第 {pageIndex + 1} 页 · {blockCount} 个内容块</span>
        <button type="button" onClick={() => choosePage(props.pdfPageIndex)}>跟随 PDF 当前页</button></div>
      <ParsedDocumentView document={ready.document} urls={ready.assets.urls} pageIndex={pageIndex} offset={offset} onJump={jump} />
      {blockCount > 40 && <nav className="parsed-pages" aria-label="解析内容分段">
        <button type="button" disabled={!offset} onClick={() => setOffset((value) => Math.max(0, value - 40))}>上一段</button>
        <span>{offset + 1}–{Math.min(offset + 40, blockCount)} / {blockCount}</span>
        <button type="button" disabled={offset + 40 >= blockCount} onClick={() => setOffset((value) => value + 40)}>下一段</button></nav>}
      <p className="pr-muted parsed-boundary">解析块定位到原文页。请以 PDF 原文核对内容与版式。</p>
    </> : !busy && <div className="parsed-empty"><h4>此版本还没有解析包</h4><p>在桌面完成解析后，进入「设置 → 账号与在线文件」，为已关联的 PDF 导出解析包。旧缓存若缺少版本证据，需要重新解析。</p></div>}
  </div>;
}
