import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ClientError } from '../errors.ts';
import {
  deleteCloudPdfCopy, describeCloudPdfError, inspectCloudPdfCopy, listCloudPdfCopies, uploadCloudPdfCopy,
  type CloudPdfContext, type CloudPdfList, type CloudPdfOptions, type CloudPdfQuota, type CloudPdfStatus,
} from '../pdf/cloudCopies.ts';
import { readerIdentity, sameReaderIdentity } from '../pdf/position.ts';
import { registerPdfTask } from '../pdf/tasks.ts';
import type { PdfVersion } from '../pdf/types.ts';
import type { AccountScope } from '../storage/accountStore.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
import { ReaderSheet } from './ReaderSheet.tsx';

interface CommonProps {
  context: CloudPdfContext;
  scope: AccountScope;
  controller: Pick<WorkspaceController, 'getSnapshot' | 'save'>;
  accountCurrent?: () => boolean;
}

export const cloudByteLabel = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : bytes < 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;

function useCloudWork(props: CommonProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const mounted = useRef(true);
  const operation = useRef(0);
  const active = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current++; active.current?.abort(); };
  }, []);
  async function run(label: string, work: (options: CloudPdfOptions) => Promise<void>) {
    if (active.current) return;
    const abort = new AbortController(); active.current = abort;
    const token = ++operation.current;
    const accountCurrent = props.accountCurrent;
    const release = registerPdfTask(props.scope, abort);
    setBusy(label); setError(null); setNotice(null); setProgress(null);
    try {
      const identity = readerIdentity(props.controller, props.scope);
      const isCurrent = () => mounted.current && operation.current === token
        && (!accountCurrent || accountCurrent()) && !props.controller.getSnapshot().needsLogin
        && props.controller.getSnapshot().status === 'ready' && sameReaderIdentity(props.controller, identity);
      if (!isCurrent()) throw new ClientError('ACCOUNT_CHANGED');
      await work({ signal: abort.signal, isCurrent, onProgress: (loaded, total) => {
        if (isCurrent() && !abort.signal.aborted) setProgress(total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : null);
      } });
    } catch (failure) {
      if (mounted.current && operation.current === token && (!accountCurrent || accountCurrent()))
        setError(describeCloudPdfError(failure));
    } finally {
      release();
      if (operation.current === token) {
        active.current = null;
        if (mounted.current) { setBusy(null); setProgress(null); }
      }
    }
  }
  const feedback = <>
    {busy && <div className="cloud-feedback" role="status"><span>{busy}{progress !== null ? ` · ${progress}%` : '…'}</span>
      <button type="button" className="secondary" onClick={() => active.current?.abort()}>取消等待</button></div>}
    {error && <p className="cloud-error" role="alert">{error}</p>}
    {notice && <p className="cloud-notice" role="status">{notice}</p>}
  </>;
  return { busy, run, setNotice, feedback };
}

function Quota({ quota }: { quota: CloudPdfQuota }) {
  const fraction = Math.min(100, quota.usedBytes / quota.maxBytes * 100);
  return <div className="cloud-quota">
    <div><span>云空间</span><strong>{quota.usedBytes ? cloudByteLabel(quota.usedBytes) : '0 KB'} / {cloudByteLabel(quota.maxBytes)}</strong></div>
    <progress aria-label="已用云空间" value={fraction} max={100} />
    <p>{quota.usedCopies} / {quota.maxCopies} 份 PDF</p>
  </div>;
}

function DeleteConfirmation({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div className="cloud-confirm" role="group" aria-label="确认删除云副本">
    <p>删除后，其他设备将无法再从这里下载。本机已保存的 PDF、文库记录与笔记会保留。</p>
    <div className="cloud-actions"><button type="button" className="danger" disabled={busy} onClick={onConfirm}>确认删除云副本</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>保留云副本</button></div>
  </div>;
}

interface ReaderProps extends CommonProps {
  version: PdfVersion;
  synced: boolean;
  hasBytes: boolean;
  getBytes: () => Uint8Array | null;
  reading: boolean;
  onRead: () => void;
}

export function CloudPdfPanel(props: ReaderProps) {
  const [status, setStatus] = useState<CloudPdfStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const work = useCloudWork(props);
  const enabled = Boolean(props.context.getCloudPdfCapability());
  const locked = Boolean(work.busy) || props.reading;
  function refresh() {
    void work.run('正在查询云副本', async (options) => {
      const result = await inspectCloudPdfCopy(props.context, props.version, options);
      if (options.isCurrent() && !options.signal.aborted) { setStatus(result); setConfirmDelete(false); }
    });
  }
  useEffect(() => { if (enabled && props.synced) refresh(); }, [enabled, props.synced]);
  function upload() {
    void work.run('正在上传 PDF', async (options) => {
      const bytes = props.getBytes();
      if (!bytes || !props.synced) throw new ClientError('ACCOUNT_CHANGED');
      const result = await uploadCloudPdfCopy(props.context, props.version, bytes, options);
      if (options.isCurrent() && !options.signal.aborted) {
        setStatus(result); setConfirmDelete(false);
        work.setNotice(result.replayed ? '云端已保存相同的 PDF，未重复占用空间。' : '云副本已保存，同一账号的其他设备可以下载。');
      }
    });
  }
  function remove() {
    void work.run('正在删除云副本', async (options) => {
      const result = await deleteCloudPdfCopy(props.context, props.version.entityId, options);
      if (options.isCurrent() && !options.signal.aborted) {
        setStatus({ copy: null, quota: result.quota }); setConfirmDelete(false);
        work.setNotice('云副本已删除，本机文件与文库内容保留。');
      }
    });
  }
  return <div className="cloud-panel pr-panel-content">
    <div className="cloud-file"><span className="cloud-kicker">当前 PDF 版本</span><strong>{props.version.data.fileName}</strong>
      <span>{cloudByteLabel(props.version.data.sizeBytes)} · {props.version.data.sha256.slice(0, 12)}</span></div>
    <p className="cloud-description">手动保存到当前账号的服务器，同一账号的其他设备可下载此 PDF。</p>
    {!enabled ? <p role="status" className="cloud-description">当前服务尚未开放 PDF 云副本。</p>
      : !props.synced ? <p role="status" className="cloud-description">请先同步这个附件版本，再保存或读取云副本。</p> : <>
        {status && <><p className="cloud-state">{status.copy ? '已保存云副本' : '尚无云副本'}</p><Quota quota={status.quota} /></>}
        {status?.copy ? <>
          <button type="button" className="pr-primary" disabled={locked || !status.copy.available} onClick={props.onRead}>下载云副本并阅读</button>
          {confirmDelete ? <DeleteConfirmation busy={locked} onConfirm={remove} onCancel={() => setConfirmDelete(false)} />
            : <button type="button" className="cloud-delete" disabled={locked} onClick={() => setConfirmDelete(true)}>删除此云副本</button>}
        </> : <>
          <button type="button" className="pr-primary" disabled={locked || !props.hasBytes || !status} onClick={upload}>上传此 PDF 到私有云</button>
          {!props.hasBytes && <p className="cloud-description">先在本机打开这个版本的 PDF，即可上传。</p>}
        </>}
        <button type="button" className="secondary" disabled={locked} onClick={refresh}>刷新云副本状态</button>
      </>}
    {work.feedback}
  </div>;
}

export function CloudPdfLibrary(props: CommonProps & { onClose: () => void }) {
  const [list, setList] = useState<CloudPdfList | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const work = useCloudWork(props);
  const enabled = Boolean(props.context.getCloudPdfCapability());
  function refresh() {
    void work.run('正在读取云副本列表', async (options) => {
      const result = await listCloudPdfCopies(props.context, options);
      if (options.isCurrent() && !options.signal.aborted) { setList(result); setConfirmId(null); }
    });
  }
  useEffect(() => { if (enabled) refresh(); }, [enabled]);
  function remove(id: string) {
    void work.run('正在删除云副本', async (options) => {
      await deleteCloudPdfCopy(props.context, id, options);
      const result = await listCloudPdfCopies(props.context, options);
      if (options.isCurrent() && !options.signal.aborted) {
        setList(result); setConfirmId(null); work.setNotice('云副本已删除，本机文件与文库内容保留。');
      }
    });
  }
  return <ReaderSheet open title="私有云 PDF" onClose={props.onClose} className="cloud-library-sheet">
    <div className="cloud-library">
      <p className="cloud-description">管理当前账号上传的 PDF。文献移出文库后，云副本仍保留在这里，直到你手动删除。</p>
      {enabled ? <>
        {list && <><Quota quota={list.quota} />
          <ul className="cloud-copy-list">{list.copies.map((copy) => <li key={copy.attachmentVersionId}>
            <div className="cloud-file"><strong>{copy.fileName}</strong><span>{cloudByteLabel(copy.sizeBytes)} · {copy.sha256.slice(0, 12)}</span></div>
            {!copy.available && <p className="cloud-unavailable">文献或版本已删除 · 可清理云副本</p>}
            {confirmId === copy.attachmentVersionId
              ? <DeleteConfirmation busy={Boolean(work.busy)} onConfirm={() => remove(copy.attachmentVersionId)} onCancel={() => setConfirmId(null)} />
              : <button type="button" className="cloud-delete" disabled={Boolean(work.busy)} onClick={() => setConfirmId(copy.attachmentVersionId)}>删除云副本</button>}
          </li>)}</ul>
          {!list.copies.length && <p className="cloud-empty">还没有云副本。打开文献 PDF，在阅读选项中逐份上传。</p>}
        </>}
        <button type="button" className="secondary" disabled={Boolean(work.busy)} onClick={refresh}>刷新云副本列表</button>
      </> : <p className="cloud-empty" role="status">当前服务尚未开放 PDF 云副本。</p>}
    </div>
    <div className="cloud-library-feedback">{work.feedback}</div>
  </ReaderSheet>;
}
