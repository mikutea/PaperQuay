import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, ChevronRight, Download, RefreshCw, Square } from 'lucide-react';
import {
  desktopGraphExchange,
  type DesktopGraphConflict,
  type DesktopGraphConflictChoice,
  type DesktopGraphExchangePreview,
  type DesktopGraphExchangeStatus,
  type DesktopGraphLocalRow,
  type GraphRelationData,
} from '../../services/desktopGraphExchange';
import { SettingsField } from './readerPreferencesPrimitives';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

const buttonClass = 'pq-button inline-flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const detailClass = 'min-w-0 rounded-xl border border-[var(--pq-border)] bg-[var(--pq-surface-2)] p-3';
const summaryClass = 'min-h-11 cursor-pointer py-3 text-sm font-medium text-[var(--pq-text)]';
const PAGE_SIZE = 8;

function errorCode(error: unknown): string {
  const value = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  return value.match(/\b[A-Z][A-Z_]{3,70}\b/)?.[0] || 'UNKNOWN';
}

function reasonLabel(code: string, l: ReaderPreferencesLocalizer): string {
  const labels: Record<string, [string, string]> = {
    UNMAPPED_GRAPH_ENDPOINT: ['先把关系涉及的论文添加到账号，再重新检查。关系内容仍保留。', 'Add the papers involved in this relation to your account, then check again. The relation is preserved.'],
    REVISION_MISMATCH: ['账号内容已更新，请重新检查后选择要保留的内容。', 'The account content changed. Check again and choose which content to keep.'],
    MISSING_LOCAL_MATERIAL: ['绑定的本机文献已不可用。', 'The linked local paper is unavailable.'],
    AMBIGUOUS_LOCAL_MAPPING: ['一份本机文献对应多个账号对象，需要先明确绑定。', 'This local paper has multiple account bindings. Resolve the binding first.'],
    AMBIGUOUS_ACCOUNT_MAPPING: ['一个账号对象对应多份本机文献，需要先明确绑定。', 'This account entity has multiple local bindings. Resolve the binding first.'],
    INVALID_DESKTOP_GRAPH_RELATION: ['这条关系的字段无法完整交换，原关系仍保留。', 'This relation cannot be exchanged completely. Its original fields are preserved.'],
    GRAPH_MAPPING_CHANGED: ['账号、服务或文库绑定已变化，请重新检查差异。', 'The account, service or library binding changed. Check differences again.'],
    GRAPH_PREVIEW_STALE: ['预览已过期，请重新检查差异后选择。', 'This preview expired. Check differences and select again.'],
    GRAPH_PREVIEW_REQUIRED: ['请先检查差异，再选择要交换的关系。', 'Check differences before selecting relations to exchange.'],
    GRAPH_PENDING: ['请先处理待发送请求或冲突。', 'Handle pending requests or conflicts first.'],
    GRAPH_CONFLICT: ['这条关系有待决定的冲突，请检查差异后选择处理方式。', 'This relation has an unresolved conflict. Check differences and choose a resolution.'],
    GRAPH_OPERATION_REJECTED: ['账号未接受这次操作，请查看原请求及返回原因。', 'The account rejected this operation. Review the original request and its result.'],
    GRAPH_SAVE_UNCONFIRMED: ['本机保存尚未确认。可导出备份，或仅重试保存。', 'Local persistence is unconfirmed. Export a backup or retry saving only.'],
    GRAPH_STATE_INVALID: ['私有图谱状态无法读取，操作已停止。请保留原文件并检查本机存储。', 'The private graph state cannot be read. Work stopped; preserve the original file and check local storage.'],
    GRAPH_STATE_FULL: ['私有图谱已达到容量限制，请先导出备份。', 'The private graph reached its capacity limit. Export a backup first.'],
    GRAPH_STORAGE_CHANGED: ['本机状态文件已变化，当前结果尚未覆盖它。请先导出备份，再核对存储。', 'The local state file changed. Export the current result before checking storage.'],
    GRAPH_LIMIT: ['所选关系或检查范围超过容量限制，请缩小范围。', 'The selection or review exceeds capacity. Reduce its scope.'],
    GRAPH_FEATURE_UNAVAILABLE: ['当前账号服务尚未支持图谱关系交换。', 'This account service does not support graph relation exchange.'],
    DESKTOP_OPERATION_CANCELLED: ['已停止本机等待；待处理请求仍保留。', 'Local waiting stopped; pending requests are preserved.'],
    DUPLICATE_LOCAL_RELATION: ['本机存在重复的关系标识，请先核对原图谱。', 'Local relation identifiers are duplicated. Check the original graph first.'],
    IMMUTABLE_GRAPH_BINDING_CHANGED: ['已发布关系的端点或来源已变化。请以新关系发布。', 'The endpoints or origin of a published relation changed. Publish it as a new relation.'],
    DELETED_GRAPH_ENDPOINT: ['账号中的一个端点已删除，暂不能发布这条关系。', 'An account endpoint was deleted; this relation cannot be published.'],
    GRAPH_HEAD_MISSING: ['暂未取得这条关系的账号版本，请重新检查差异。', 'The account version is unavailable. Check differences again.'],
    REMOTE_GRAPH_CHANGED: ['账号版本已有修改，请先查看账号内容并处理差异。', 'The account version changed. Review its content and differences first.'],
    GRAPH_SOURCE_MISSING: ['本机图谱文件当前不可用，不能据此删除账号关系。', 'The local graph file is unavailable; account relations cannot be deleted from this state.'],
    GRAPH_SOURCE_INVALID: ['本机图谱文件无法完整读取，请先检查原文件。', 'The local graph file cannot be read completely. Check the original file first.'],
    AUTHENTICATION_REQUIRED: ['请先登录账号。', 'Sign in to your account first.'],
    AUTH_SESSION_CHANGED: ['登录身份已变化，请确认当前账号。', 'The signed-in identity changed. Check the current account.'],
    NETWORK_ERROR: ['连接未完成。已保存的原请求可在确认后继续。', 'The connection did not complete. Saved requests can be continued explicitly.'],
    DESKTOP_REQUEST_TIMEOUT: ['本次等待超时。请查看待处理请求后决定是否继续。', 'This wait timed out. Review pending requests before continuing.'],
  };
  return labels[code] ? l(...labels[code]) : l('本次操作未完成，请根据状态检查绑定或连接。', 'This operation did not complete. Check the binding or connection shown in its status.');
}

function Reason({ code, l }: { code: string; l: ReaderPreferencesLocalizer }) {
  return <p title={code} className="mt-2 break-words text-xs leading-5 text-[var(--pq-text-muted)]">{reasonLabel(code, l)}</p>;
}

function actionLabel(action: DesktopGraphLocalRow['action'] | 'put', l: ReaderPreferencesLocalizer): string {
  const labels = {
    create: l('添加到账号', 'Add to account'), update: l('更新账号中的内容', 'Update account content'),
    restore: l('恢复账号关系', 'Restore account relation'), delete: l('删除账号关系', 'Delete account relation'),
    none: l('已同步，没有变化', 'Synced, unchanged'), blocked: l('暂不能同步', 'Cannot sync yet'), put: l('保存关系修改', 'Save relation changes'),
  };
  return labels[action];
}

function pendingLabel(stage: string, l: ReaderPreferencesLocalizer): string {
  const labels: Record<string, string> = {
    queued: l('等待发送', 'Waiting to send'), sending: l('等待响应', 'Waiting for response'),
    uncertain: l('结果待核对', 'Outcome to verify'), conflict: l('等待处理冲突', 'Conflict to resolve'),
    rejected: l('请求未被接受', 'Request rejected'), 'device-blocked': l('设备需重新授权', 'Device authorization required'),
    overlay: l('本机修改待发布', 'Local edit awaiting publication'),
  };
  return labels[stage] || stage;
}

export function DesktopGraphRelationDetails({ data, title, empty, l }: {
  data?: GraphRelationData | null; title: string; empty?: string; l: ReaderPreferencesLocalizer;
}) {
  const endpoint = (value: GraphRelationData['source']) => `${value.entityType === 'paper' ? l('论文', 'Paper') : l('笔记', 'Note')} · ${value.entityId}`;
  return <section className={detailClass}>
    <h5 className="mb-2 text-xs font-medium text-[var(--pq-text)]">{title}</h5>
    {!data ? <p className="text-xs text-[var(--pq-text-muted)]">{empty || l('无对应内容', 'No corresponding content')}</p> : <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs leading-5">
      <dt className="text-[var(--pq-text-muted)]">{l('起点', 'Source')}</dt><dd className="break-all">{endpoint(data.source)}</dd>
      <dt className="text-[var(--pq-text-muted)]">{l('终点', 'Target')}</dt><dd className="break-all">{endpoint(data.target)}</dd>
      <dt className="text-[var(--pq-text-muted)]">{l('来源', 'Origin')}</dt><dd>{data.relationType === 'ai_suggested' ? l('AI 建议', 'AI suggestion') : l('人工关系', 'Manual relation')}</dd>
      <dt className="text-[var(--pq-text-muted)]">{l('关系名', 'Label')}</dt><dd className="break-words">{data.label}</dd>
      <dt className="text-[var(--pq-text-muted)]">{l('完整说明', 'Full description')}</dt><dd className="whitespace-pre-wrap break-words">{data.description || l('未填写', 'Not provided')}</dd>
      <dt className="text-[var(--pq-text-muted)]">{l('关系分数', 'Relation score')}</dt><dd>{data.confidence === null ? l('未提供', 'Not provided') : String(data.confidence)}</dd>
      <dt className="text-[var(--pq-text-muted)]">{l('权重', 'Weight')}</dt><dd>{String(data.weight)}</dd>
      <dt className="text-[var(--pq-text-muted)]">{l('创建时间', 'Created')}</dt><dd className="break-all">{data.createdAt}</dd>
      <dt className="text-[var(--pq-text-muted)]">{l('更新时间', 'Updated')}</dt><dd className="break-all">{data.updatedAt || l('未提供', 'Not provided')}</dd>
    </dl>}
  </section>;
}

function PageRows<T>({ items, renderRow, l }: { items: T[]; renderRow: (item: T) => ReactNode; l: ReaderPreferencesLocalizer }) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
  const current = Math.min(page, last);
  return <>
    <ul className="divide-y divide-[var(--pq-border)]">{items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(renderRow)}</ul>
    {last > 0 ? <nav className="mt-2 flex flex-wrap items-center justify-between gap-2" aria-label={l('关系列表分页', 'Relation list pages')}>
      <span className="text-xs text-[var(--pq-text-muted)]">{l(`第 ${current + 1} / ${last + 1} 页，共 ${items.length} 条`, `Page ${current + 1} of ${last + 1}, ${items.length} relations`)}</span>
      <div className="flex gap-2"><button type="button" className={buttonClass} disabled={current === 0} onClick={() => setPage(current - 1)}>{l('上一页', 'Previous')}</button><button type="button" className={buttonClass} disabled={current === last} onClick={() => setPage(current + 1)}>{l('下一页', 'Next')}</button></div>
    </nav> : null}
  </>;
}

export type DesktopGraphExchangeTask = 'publish' | 'adopt' | 'pending';

interface ReviewProps {
  task: DesktopGraphExchangeTask;
  preview: DesktopGraphExchangePreview;
  disabled: boolean;
  selectedLocal: string[];
  selectedIncoming: string[];
  confirmation: 'publish' | 'adopt' | null;
  conflictChoices: Record<string, DesktopGraphConflictChoice>;
  onToggleLocal: (key: string, checked: boolean) => void;
  onToggleIncoming: (id: string, checked: boolean) => void;
  onConfirm: (action: 'publish' | 'adopt' | null) => void;
  onPublish: () => void;
  onAdopt: () => void;
  onConflictChoice: (id: string, choice: DesktopGraphConflictChoice) => void;
  onResolve: (conflict: DesktopGraphConflict) => void;
  l: ReaderPreferencesLocalizer;
}

function hasNoteEndpoint(data: GraphRelationData | null | undefined, raw?: unknown): boolean {
  if (data?.source.entityType === 'note' || data?.target.entityType === 'note') return true;
  if (!raw || typeof raw !== 'object') return false;
  const fields = raw as Record<string, unknown>;
  return [fields.source, fields.target].some(value => typeof value === 'string' && value.startsWith('note:'));
}

function RowReason({ code, note, l }: { code: string; note: boolean; l: ReaderPreferencesLocalizer }) {
  return code === 'UNMAPPED_GRAPH_ENDPOINT' && note
    ? <p title={code} className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('此类笔记关系暂不能同步，原内容仍保留。', 'This kind of note relation cannot sync yet. Its original content is preserved.')}</p>
    : <Reason code={code} l={l} />;
}

function RelationContent({ data, title, empty, l }: { data?: GraphRelationData | null; title: string; empty?: string; l: ReaderPreferencesLocalizer }) {
  return <section className={detailClass}>
    <h5 className="text-sm font-medium">{title}</h5>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--pq-text-muted)]">{data ? data.description || l('未填写说明', 'No description') : empty || l('尚无内容', 'No content yet')}</p>
    {data ? <details className="mt-1"><summary className={summaryClass}>{l('完整字段', 'Full fields')}</summary><DesktopGraphRelationDetails data={data} title={data.label} l={l} /><p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('关系分数是原始建议分数，不代表经过校准的概率。', 'The relation score is the original suggestion score, not a calibrated probability.')}</p></details> : null}
  </section>;
}

export function DesktopGraphExchangeTaskPicker({ disabled, pending, onTask, l }: { disabled: boolean; pending: number; onTask: (task: DesktopGraphExchangeTask) => void; l: ReaderPreferencesLocalizer }) {
  const tasks: { key: DesktopGraphExchangeTask; title: string; description: string; icon: ReactNode }[] = [
    { key: 'publish', title: l('把本机关系同步到账号', 'Sync local relations to your account'), description: l('选择这台电脑上的关系，让同账号设备也能看到。', 'Choose relations from this computer to view on your other devices.'), icon: <ArrowUpFromLine className="h-5 w-5 shrink-0" /> },
    { key: 'adopt', title: l('把账号关系带到本机', 'Bring account relations to this computer'), description: l('选择账号中的关系，加入本机的账号图谱。', 'Choose account relations to add to the account graph on this computer.'), icon: <ArrowDownToLine className="h-5 w-5 shrink-0" /> },
    { key: 'pending', title: l('处理未完成操作', 'Finish pending operations'), description: pending > 0 ? l('上次同步还有内容需要核对或继续。', 'Some content from the last sync needs review or continuation.') : l('检查上次同步的结果，处理内容不同的关系。', 'Check previous sync results and resolve differing relation content.'), icon: <RefreshCw className="h-5 w-5 shrink-0" /> },
  ];
  return <div className="divide-y divide-[var(--pq-border)]" data-graph-task-picker>{tasks.map(task => <button key={task.key} type="button" aria-label={task.title} className="flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-4 text-left text-[var(--pq-text)] enabled:hover:bg-[var(--pq-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pq-accent)] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => onTask(task.key)}>
    {task.icon}<span className="min-w-0"><span className="block text-sm font-medium">{task.title}</span><span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{task.description}</span></span><ChevronRight aria-hidden className="ml-auto h-4 w-4 shrink-0 text-[var(--pq-text-muted)]" />
  </button>)}</div>;
}

export function DesktopGraphExchangeReview(props: ReviewProps) {
  const { task, preview, disabled, selectedLocal, selectedIncoming, confirmation, conflictChoices, l } = props;
  const local = preview.localRows.filter(row => selectedLocal.includes(row.key) && row.action !== 'none' && row.action !== 'blocked');
  const incoming = preview.incoming.filter(row => selectedIncoming.includes(row.entityId) && row.canAccept);
  const confirm = (kind: 'publish' | 'adopt') => {
    const rows = kind === 'publish' ? local : incoming;
    const deleting = rows.filter(row => 'action' in row ? row.action === 'delete' : row.state === 'delete').length;
    const restoring = kind === 'publish' ? local.filter(row => row.action === 'restore').length : 0;
    return <div className="mt-3 space-y-2 border-l-2 border-[var(--pq-accent)] pl-3" role="group" aria-label={l('确认所选关系', 'Confirm selected relations')}>
      <p className="text-sm font-medium">{kind === 'publish' ? l('即将把所选关系同步到账号', 'Ready to sync selected relations to your account') : l('即将把所选关系带到本机', 'Ready to bring selected relations to this computer')}</p>
      {deleting > 0 ? <p className="text-sm text-[var(--pq-error)]">{kind === 'publish' ? l('包含 ' + deleting + ' 条删除，将删除账号中的关系。', 'Includes ' + deleting + ' deletions from the account.') : l('包含 ' + deleting + ' 条删除，将从本机账号图谱移除对应关系。', 'Includes ' + deleting + ' deletions from the local account graph.')}</p> : null}
      {restoring > 0 ? <p className="text-sm text-[var(--pq-text-muted)]">{l('包含 ' + restoring + ' 条恢复，将恢复账号中已删除的关系。', 'Includes ' + restoring + ' restores of deleted account relations.')}</p> : null}
      <ul className="max-h-36 list-disc overflow-y-auto pl-4 text-sm leading-6">{rows.map(row => <li key={row.key} className="break-words">{row.label}</li>)}</ul>
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || rows.length === 0} onClick={kind === 'publish' ? props.onPublish : props.onAdopt}>{kind === 'publish' ? l('同步这 ' + rows.length + ' 条关系', 'Sync these ' + rows.length + ' relations') : l('带入这 ' + rows.length + ' 条关系', 'Bring in these ' + rows.length + ' relations')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => props.onConfirm(null)}>{l('返回选择', 'Back to selection')}</button></div>
    </div>;
  };
  return <div className="space-y-3 text-[var(--pq-text)]" data-desktop-graph-review data-graph-task={task}>
    {task === 'publish' ? <section aria-label={l('选择要同步的关系', 'Choose relations to sync')}>
      <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('勾选要同步的关系。你可以先查看内容，再预览这次修改。', 'Select relations to sync. Review their content, then preview this change.')}</p>
      {preview.localRows.length ? <PageRows key={preview.token} items={preview.localRows} l={l} renderRow={row => <li key={row.key} className="py-3">
        <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]" checked={selectedLocal.includes(row.key)} disabled={disabled || row.action === 'none' || row.action === 'blocked'} onChange={event => props.onToggleLocal(row.key, event.target.checked)} /><span className="min-w-0 flex-1 break-words">{row.label}<span className={'mt-1 block text-xs ' + (row.action === 'delete' ? 'text-[var(--pq-error)]' : 'text-[var(--pq-text-muted)]')}>{actionLabel(row.action, l)}</span></span></label>
        {row.reason ? <RowReason code={row.reason} note={hasNoteEndpoint(row.local, row.raw)} l={l} /> : null}
        <details className="ml-7"><summary className={summaryClass}>{l('查看内容与变化', 'View content and changes')}</summary><div className="grid min-w-0 gap-2 lg:grid-cols-2"><RelationContent data={row.local} title={l('本机内容', 'Local content')} empty={row.action === 'delete' ? l('本机关系已删除', 'Local relation deleted') : undefined} l={l} /><RelationContent data={row.remote} title={l('账号内容', 'Account content')} empty={row.action === 'restore' ? l('账号关系已删除', 'Account relation deleted') : undefined} l={l} /></div><p className="mt-2 break-all text-xs text-[var(--pq-text-muted)]">{l('本机关系 ID：', 'Local relation ID: ')}{row.localRelationId || l('无法读取', 'Unavailable')}{row.entityId ? ' / ' + row.entityId : ''}</p>
          {row.action === 'blocked' && row.raw !== undefined ? <details><summary className={summaryClass}>{l('保留的本机原字段', 'Preserved original local fields')}</summary><pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-xl bg-[var(--pq-surface-2)] p-3 text-xs leading-5">{JSON.stringify(row.raw, null, 2)}</pre></details> : null}
        </details>
      </li>} /> : <p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('当前文库还没有可同步的关系。先在图谱中建立文献之间的关系。', 'This library has no relations to sync. Create relations between papers in the graph first.')}</p>}
      {confirmation === 'publish' ? confirm('publish') : <button type="button" className={buttonClass + ' mt-2'} disabled={disabled || local.length === 0} onClick={() => props.onConfirm('publish')}>{l('预览同步内容 (' + local.length + ')', 'Preview sync (' + local.length + ')')}</button>}
    </section> : null}
    {task === 'adopt' ? <section aria-label={l('选择要带到本机的关系', 'Choose relations to bring to this computer')}>
      <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('勾选要带到本机的关系，保存在本机的账号图谱中。', 'Select relations to save in the account graph on this computer.')}</p>
      {preview.incoming.length ? <PageRows key={preview.token} items={preview.incoming} l={l} renderRow={row => <li key={row.key} className="py-3">
        <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]" checked={selectedIncoming.includes(row.entityId)} disabled={disabled || !row.canAccept} onChange={event => props.onToggleIncoming(row.entityId, event.target.checked)} /><span className="min-w-0 flex-1 break-words">{row.label}<span className={'mt-1 block text-xs ' + (row.state === 'delete' ? 'text-[var(--pq-error)]' : 'text-[var(--pq-text-muted)]')}>{{ new: l('新关系', 'New relation'), update: l('有更新', 'Updated'), delete: l('从本机账号图谱移除', 'Remove from the local account graph'), same: l('已带入，没有变化', 'Already brought in, unchanged'), unmapped: l('暂不能带入，内容保留在账号', 'Cannot bring in yet; preserved in your account'), pending: l('需要先处理未完成操作', 'Finish the pending operation first') }[row.state]}</span></span></label>
        {row.reason ? <RowReason code={row.reason} note={hasNoteEndpoint(row.data)} l={l} /> : null}
        <details className="ml-7"><summary className={summaryClass}>{l('查看内容与变化', 'View content and changes')}</summary><div className="grid min-w-0 gap-2 lg:grid-cols-2"><RelationContent data={row.accepted} title={l('本机账号图谱中的内容', 'Content in the local account graph')} empty={l('尚未带入这条关系', 'This relation has not been brought in')} l={l} /><RelationContent data={row.data} title={l('账号中的最新内容', 'Latest account content')} empty={row.state === 'delete' ? l('账号关系已删除', 'Account relation deleted') : undefined} l={l} /></div><p className="mt-2 break-all text-xs text-[var(--pq-text-muted)]">{l('账号关系 ID：', 'Account relation ID: ')}{row.entityId}{l('；账号版本 ', '; account revision ')}{row.revision}</p></details>
      </li>} /> : <p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('账号中还没有可带到本机的关系。', 'Your account has no relations to bring to this computer.')}</p>}
      {confirmation === 'adopt' ? confirm('adopt') : <button type="button" className={buttonClass + ' mt-2'} disabled={disabled || incoming.length === 0} onClick={() => props.onConfirm('adopt')}>{l('预览带入内容 (' + incoming.length + ')', 'Preview import (' + incoming.length + ')')}</button>}
    </section> : null}
    {task === 'pending' ? <>
      {preview.conflicts.length ? <section aria-label={l('选择要保留的内容', 'Choose which content to keep')}>
        <h4 className="text-sm font-medium">{l('这些关系有不同内容，请选择要保留的版本', 'These relations differ. Choose the content to keep.')}</h4>
        <PageRows key={preview.token} items={preview.conflicts} l={l} renderRow={conflict => <li key={conflict.conflictId} className="space-y-3 py-3">
          <p className="break-words text-sm font-medium">{conflict.label}</p>
          <div className="grid min-w-0 gap-2 lg:grid-cols-2"><RelationContent data={conflict.current?.data} title={l('账号中的内容', 'Account content')} empty={conflict.current?.deletedAt ? l('已删除', 'Deleted') : l('尚无账号内容', 'No account content')} l={l} /><RelationContent data={conflict.attempted.data} title={l('本次修改', 'This change')} empty={conflict.attempted.mutation === 'delete' ? l('本次修改将删除这条关系', 'This change deletes the relation') : undefined} l={l} /></div>
          <fieldset disabled={disabled} className="flex flex-wrap gap-x-4 gap-y-2 text-sm"><legend className="sr-only">{l('选择要保留的内容', 'Choose which content to keep')}</legend>{(['current', 'attempted'] as const).map(choice => <label key={choice} className="flex min-h-11 items-center gap-2"><input type="radio" name={'graph-conflict-' + conflict.conflictId} checked={conflictChoices[conflict.conflictId] === choice} onChange={() => props.onConflictChoice(conflict.conflictId, choice)} />{choice === 'current' ? l('保留账号内容', 'Keep account content') : l('使用本次修改', 'Use this change')}</label>)}</fieldset>
          <button type="button" className={buttonClass} disabled={disabled || !conflictChoices[conflict.conflictId]} onClick={() => props.onResolve(conflict)}>{l('应用这项选择', 'Apply this choice')}</button>
          <details><summary className={summaryClass}>{l('操作详情', 'Operation details')}</summary><p className="break-all text-xs text-[var(--pq-text-muted)]">{l('账号版本 ', 'Account revision ')}{conflict.expectedRevision}{' / '}{conflict.entityId}{' / '}{conflict.conflictId}</p><p className="text-xs text-[var(--pq-text-muted)]">{actionLabel(conflict.attempted.mutation, l)}</p></details>
        </li>} />
      </section> : null}
      {preview.pendingRows.length + preview.pendingResolutions.length > 0 ? <section aria-label={l('上次未完成的操作', 'Unfinished operations')}>
        <h4 className="text-sm font-medium">{l('上次未完成的操作', 'Unfinished operations')}</h4>
        <PageRows key={preview.token} items={preview.pendingRows} l={l} renderRow={row => <li key={row.opId} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{row.label}</p><p className="text-sm text-[var(--pq-text-muted)]">{pendingLabel(row.stage, l)}</p><details><summary className={summaryClass}>{l('操作详情', 'Operation details')}</summary><p className="mb-2 text-xs text-[var(--pq-text-muted)]">{actionLabel(row.mutation, l)}</p><DesktopGraphRelationDetails data={row.data} title={l('已保存的原请求内容', 'Saved original request')} empty={row.mutation === 'delete' ? l('请求删除这条关系', 'Requests deletion of this relation') : undefined} l={l} /><p className="mt-2 break-all text-xs text-[var(--pq-text-muted)]">{l('请求 ID：', 'Request ID: ')}{row.opId}</p></details></li>} />
        <PageRows key={preview.token + ':resolutions'} items={preview.pendingResolutions} l={l} renderRow={row => {
          const conflict = preview.conflicts.find(item => item.conflictId === row.conflictId);
          const deletes = row.choice === 'merged' ? row.mutation === 'delete' : conflict?.attempted.mutation === 'delete';
          return <li key={row.opId} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{conflict?.label || l('已保存的关系处理决定', 'Saved relation choice')}</p>
            <p className="text-sm text-[var(--pq-text-muted)]">{row.lastResult?.status === 'rejected' ? l('上次选择未被接受，请重新检查。', 'The last choice was rejected. Check again.') : row.lastResult?.status === 'conflict' ? l('账号内容已变化，需要重新选择。', 'Account content changed. Choose again.') : l('上次选择的处理结果待确认。', 'The result of the last choice is unconfirmed.')}</p>
            {row.lastResult?.code ? <Reason code={row.lastResult.code} l={l} /> : null}
            <details><summary className={summaryClass}>{l('操作详情', 'Operation details')}</summary><p className="mb-2 text-xs text-[var(--pq-text-muted)]">{row.choice === 'current' ? l('保留账号版本 ' + row.expectedRevision, 'Keep account revision ' + row.expectedRevision) : row.choice === 'attempted' ? l('使用原始请求内容', 'Use the original attempted content') : l('使用已保存的合并内容', 'Use saved merged content')}</p>
              {row.choice !== 'current' ? <DesktopGraphRelationDetails data={row.choice === 'merged' ? row.data : conflict?.attempted.data} title={l('原决定的内容', 'Original choice content')} empty={deletes ? l('删除关系', 'Delete relation') : l('请在内容比较中核对原始修改。', 'Review the original change in the content comparison.')} l={l} /> : null}
              <p className="mt-2 break-all text-xs text-[var(--pq-text-muted)]">{l('请求 ID：', 'Request ID: ')}{row.opId}{row.lastResult?.code ? ' / ' + row.lastResult.code : ''}</p>
            </details>
          </li>;
        }} />
      </section> : null}
      {!preview.conflicts.length && !preview.pendingRows.length && !preview.pendingResolutions.length ? <p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('没有需要处理的未完成操作。', 'There are no unfinished operations to handle.')}</p> : null}
    </> : null}
  </div>;
}

export interface DesktopGraphExchangePanelProps {
  l: ReaderPreferencesLocalizer;
  accountActive: boolean;
  ownerKey: string | null;
}

export function DesktopGraphExchangePanel(props: DesktopGraphExchangePanelProps) {
  // A new service/account/library owns a fresh view and fresh callbacks.
  return <OwnedGraphExchangePanel key={`${props.accountActive}:${props.ownerKey ?? ''}`} {...props} />;
}

function OwnedGraphExchangePanel({ l, accountActive, ownerKey }: DesktopGraphExchangePanelProps) {
  const [status, setStatus] = useState<DesktopGraphExchangeStatus | null>(null);
  const [task, setTask] = useState<DesktopGraphExchangeTask | null>(null);
  const [preview, setPreview] = useState<DesktopGraphExchangePreview | null>(null);
  const [selectedLocal, setSelectedLocal] = useState<string[]>([]);
  const [selectedIncoming, setSelectedIncoming] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<'publish' | 'adopt' | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Record<string, DesktopGraphConflictChoice>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const sequence = useRef(0);
  const reads = useRef(0);
  const operation = useRef<string | null>(null);
  const currentStatus = useRef<DesktopGraphExchangeStatus | null>(null);

  const clearReview = useCallback(() => {
    setPreview(null); setSelectedLocal([]); setSelectedIncoming([]); setConfirmation(null); setConflictChoices({});
  }, []);

  const acceptStatus = useCallback((next: DesktopGraphExchangeStatus) => {
    if (next.scopeKey !== ownerKey || next.revision !== currentStatus.current?.revision) clearReview();
    if (next.scopeKey !== ownerKey) { sequence.current += 1; operation.current = null; setWorking(null); }
    currentStatus.current = next;
    setStatus(next);
  }, [clearReview, ownerKey]);

  const reloadStatus = useCallback(async () => {
    if (!alive.current) return;
    const request = ++reads.current;
    try {
      const next = await desktopGraphExchange.status();
      if (alive.current && request === reads.current) acceptStatus(next);
    } catch (failure) {
      if (alive.current && request === reads.current) setError(errorCode(failure));
    }
  }, [acceptStatus]);

  useEffect(() => {
    alive.current = true;
    void reloadStatus();
    let listening = true;
    let unsubscribe: (() => void) | undefined;
    void desktopGraphExchange.onChanged(() => { void reloadStatus(); }).then(stop => {
      if (listening) unsubscribe = stop; else stop();
    }).catch(() => { /* The initial metadata read reports bridge errors. */ });
    return () => { listening = false; alive.current = false; sequence.current += 1; reads.current += 1; unsubscribe?.(); };
  }, [reloadStatus]);

  const run = async (kind: string, action: () => Promise<void>, interrupt = false) => {
    if (!alive.current || !accountActive || !ownerKey || currentStatus.current?.scopeKey !== ownerKey || operation.current && !interrupt) return;
    const request = ++sequence.current;
    operation.current = kind; setWorking(kind); setError(null); setNotice('');
    const current = () => alive.current && request === sequence.current && currentStatus.current?.scopeKey === ownerKey;
    try {
      // Actions retain their original owner even if another scope becomes active.
      await action();
    } catch (failure) {
      if (current()) { setError(errorCode(failure)); await reloadStatus(); }
    } finally {
      if (alive.current && request === sequence.current) { operation.current = null; setWorking(null); }
    }
  };

  const check = (nextTask: DesktopGraphExchangeTask) => run('preview', async () => {
    setTask(nextTask);
    const request = sequence.current;
    clearReview();
    const next = await desktopGraphExchange.preview();
    if (!alive.current || request !== sequence.current || next.scopeKey !== ownerKey) return;
    const metadata = await desktopGraphExchange.status();
    if (!alive.current || request !== sequence.current || metadata.scopeKey !== ownerKey) return;
    reads.current += 1; acceptStatus(metadata);
    if (metadata.revision === next.revision) setPreview(next);
    else setError('GRAPH_PREVIEW_STALE');
  });

  const change = (kind: string, action: () => Promise<DesktopGraphExchangeStatus>, success: string, interrupt = false) => run(kind, async () => {
    const request = sequence.current;
    clearReview();
    const next = await action();
    if (!alive.current || request !== sequence.current || next.scopeKey !== ownerKey) return;
    reads.current += 1; acceptStatus(next);
    if (next.errorCode) setError(next.errorCode);
    else setNotice(next.saveUnconfirmed ? reasonLabel('GRAPH_SAVE_UNCONFIRMED', l) : success);
  }, interrupt);

  const sameOwner = accountActive && !!ownerKey && status?.scopeKey === ownerKey;
  const busy = !!working || !!status?.busy;
  const canStop = !!status?.busy || ['preview', 'publish', 'continue', 'resolve', 'stop'].includes(working || '');
  const disabled = !sameOwner || busy || !!status?.saveUnconfirmed;
  const validPreview = preview && preview.scopeKey === ownerKey && preview.revision === status?.revision ? preview : null;
  const visibleError = error || status?.errorCode;
  const toggle = (setter: (next: (previous: string[]) => string[]) => void, key: string, checked: boolean) => {
    setConfirmation(null); setter(previous => checked ? [...previous, key] : previous.filter(value => value !== key));
  };

  const title = task === 'publish' ? l('把本机关系同步到账号', 'Sync local relations to your account') : task === 'adopt' ? l('把账号关系带到本机', 'Bring account relations to this computer') : l('处理未完成操作', 'Finish pending operations');
  return <SettingsField label={l('同步文献关系', 'Sync paper relations')} description={l('选择这次要做的事，再查看并确认具体内容。', 'Choose what to do, then review and confirm the content.')}>
    <div className="space-y-3" data-desktop-graph-exchange>
      {!accountActive ? <p className="text-sm text-[var(--pq-text-muted)]">{l('先连接账号，就能在设备之间同步文献关系。', 'Connect your account to sync paper relations across devices.')}</p> : status && !status.supported ? <p className="text-sm text-[var(--pq-text-muted)]">{l('当前账号服务暂不支持关系同步。', 'This account service does not support relation sync yet.')}</p> : null}
      {task ? <div className="space-y-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => { clearReview(); setTask(null); setNotice(''); setError(null); }}><ArrowLeft className="h-4 w-4" />{l('返回关系同步', 'Back to relation sync')}</button>
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium text-[var(--pq-text)]">{title}</h4><button type="button" className={buttonClass} disabled={disabled || !status?.supported} onClick={() => void check(task)}><RefreshCw className="h-4 w-4" />{working === 'preview' ? l('正在检查…', 'Checking…') : l('重新检查', 'Check again')}</button></div>
      </div> : <DesktopGraphExchangeTaskPicker disabled={disabled || !status?.supported} pending={status?.pending || 0} onTask={value => void check(value)} l={l} />}
      {canStop ? <button type="button" className={buttonClass} disabled={!sameOwner || working === 'stop'} onClick={() => void change('stop', desktopGraphExchange.stop, l('已停止等待，未完成的操作仍保留。', 'Waiting stopped. Unfinished operations are preserved.'), true)}><Square className="h-3 w-3" />{l('停止等待', 'Stop waiting')}</button> : null}
      {status?.saveUnconfirmed ? <div className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3"><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('上次结果还没有确认保存到本机。先重试保存，再继续同步。', 'The last result is not yet confirmed saved on this computer. Retry saving before continuing sync.')}</p><button type="button" className={buttonClass} disabled={!sameOwner || busy} onClick={() => void change('save', desktopGraphExchange.retrySave, l('结果已保存到本机，可以重新检查。', 'The result is saved on this computer. You can check again.'))}><RefreshCw className="h-4 w-4" />{l('仅重试保存', 'Retry saving only')}</button><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('这一步只保存已有结果，不会重新发送关系。', 'This only saves the existing result without resending relations.')}</p></div> : null}
      {visibleError && !(status?.saveUnconfirmed && visibleError === 'GRAPH_SAVE_UNCONFIRMED') ? <div role="alert"><Reason code={visibleError} l={l} /></div> : null}
      {notice ? <p role="status" className="text-sm leading-6 text-[var(--pq-text-muted)]">{notice}</p> : null}
      {task && validPreview ? <DesktopGraphExchangeReview task={task} preview={validPreview} disabled={disabled} selectedLocal={selectedLocal} selectedIncoming={selectedIncoming} confirmation={confirmation} conflictChoices={conflictChoices} l={l}
        onToggleLocal={(key, checked) => toggle(setSelectedLocal, key, checked)} onToggleIncoming={(key, checked) => toggle(setSelectedIncoming, key, checked)} onConfirm={setConfirmation}
        onPublish={() => { if (!disabled && task === 'publish' && confirmation === 'publish') void change('publish', () => desktopGraphExchange.publish({ token: validPreview.token, keys: validPreview.localRows.filter(row => selectedLocal.includes(row.key) && row.action !== 'none' && row.action !== 'blocked').map(row => row.key) }), l('已处理所选同步操作，可以重新检查结果。', 'Selected sync operations were processed. Check again to review the result.')); }}
        onAdopt={() => { if (!disabled && task === 'adopt' && confirmation === 'adopt') void change('adopt', () => desktopGraphExchange.adopt({ token: validPreview.token, ids: validPreview.incoming.filter(row => selectedIncoming.includes(row.entityId) && row.canAccept).map(row => row.entityId) }), l('所选关系已带到本机账号图谱。', 'Selected relations were brought into the local account graph.')); }}
        onConflictChoice={(id, choice) => setConflictChoices(previous => ({ ...previous, [id]: choice }))}
        onResolve={conflict => { const choice = conflictChoices[conflict.conflictId]; if (!disabled && task === 'pending' && choice) void change('resolve', () => desktopGraphExchange.resolve({ conflictId: conflict.conflictId, choice, expectedRevision: conflict.expectedRevision }), l('已处理这项选择，可以重新检查结果。', 'This choice was processed. Check again to review the result.')); }} /> : null}
      {task === 'pending' && status && status.continuable > 0 ? <div className="space-y-2 border-t border-[var(--pq-border)] pt-3"><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('上次操作尚未完成。继续时会先核对结果，再处理尚未完成的发送。', 'The previous operation is unfinished. Continue to check its result and complete any remaining send.')}</p><button type="button" className={buttonClass} disabled={disabled || !validPreview} onClick={() => void change('continue', desktopGraphExchange.continue, l('已继续处理，可以重新检查结果。', 'Processing continued. Check again to review the result.'))}>{l('继续处理', 'Continue processing')}</button></div> : null}
      <details className="border-t border-[var(--pq-border)] pt-1"><summary className={summaryClass}>{l('同步详情与备份', 'Sync details and backup')}</summary>
        {status?.loaded ? <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--pq-text-muted)]">{[[l('已带入', 'Brought in'), status.accepted], [l('已绑定材料', 'Bound materials'), status.mapped], [l('映射待处理项', 'Mapping items to review'), status.unmapped], [l('待处理', 'Pending'), status.pending], [l('内容不同', 'Differing content'), status.conflicts]].map(([label, count]) => <div key={label} className="flex gap-2"><dt>{label}</dt><dd className="font-medium text-[var(--pq-text)]">{count}</dd></div>)}</dl> : null}
        {validPreview ? <p className="mt-2 break-words text-xs text-[var(--pq-text-muted)]">{l('检查时间：', 'Checked: ')}{validPreview.checkedAt}</p> : null}
        <p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('带入的关系按服务、账号和文库分别保存，不覆盖原有本地图谱。只有已添加到账号、且对应关系明确的论文才能同步；笔记关系暂不支持。', 'Imported relations are saved separately for each service, account and library, preserving the original local graph. Only papers added to the account with an unambiguous binding can sync. Note relations are not yet supported.')}</p>
        <p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('绑定材料统计论文等端点的数量；映射待处理项可能涉及同一条关系。继续处理会使用已保存的原请求标识，不创建替代请求。', 'Bound materials counts endpoints such as papers; mapping items can concern the same relation. Continuation uses the saved original request identifiers without creating replacement requests.')}</p>
        <p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('备份包含本机账号图谱、未完成操作与内容冲突。本地图谱原 JSON 及无法同步的原字段，请随文库备份。', 'The backup includes the local account graph, unfinished operations and content conflicts. Back up original local graph JSON and unsupported fields with your library.')}</p>
        <button type="button" className={buttonClass + ' mt-3'} disabled={!sameOwner || busy || !status?.loaded && !status?.saveUnconfirmed} onClick={() => void run('export', async () => {
          const request = sequence.current, result = await desktopGraphExchange.exportBackup();
          if (alive.current && request === sequence.current && currentStatus.current?.scopeKey === ownerKey && result.status === 'exported') setNotice(l('本机账号图谱与未完成操作已导出备份。', 'The local account graph and unfinished operations were exported.'));
        })}><Download className="h-4 w-4" />{l('导出关系备份', 'Export relation backup')}</button>
      </details>
    </div>
  </SettingsField>;
}
