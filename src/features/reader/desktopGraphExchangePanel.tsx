import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Download, GitCompareArrows, RefreshCw, Square } from 'lucide-react';
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
    UNMAPPED_GRAPH_ENDPOINT: ['端点尚无已验证的本机绑定；关系会保留。', 'An endpoint has no verified local binding; the relation is preserved.'],
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
    create: l('新发布', 'Publish new'), update: l('更新账号关系', 'Update account relation'),
    restore: l('恢复账号关系', 'Restore account relation'), delete: l('删除账号关系', 'Delete account relation'),
    none: l('无变化', 'Unchanged'), blocked: l('暂不能发布', 'Cannot publish yet'), put: l('写入关系', 'Write relation'),
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

interface ReviewProps {
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

export function DesktopGraphExchangeReview(props: ReviewProps) {
  const { preview, disabled, selectedLocal, selectedIncoming, confirmation, conflictChoices, l } = props;
  const local = preview.localRows.filter(row => selectedLocal.includes(row.key) && row.action !== 'none' && row.action !== 'blocked');
  const incoming = preview.incoming.filter(row => selectedIncoming.includes(row.entityId) && row.canAccept);
  const confirm = (kind: 'publish' | 'adopt') => {
    const rows = kind === 'publish' ? local : incoming;
    const deleting = rows.filter(row => 'action' in row ? row.action === 'delete' : row.state === 'delete').length;
    const restoring = kind === 'publish' ? local.filter(row => row.action === 'restore').length : 0;
    return <div className="mt-3 space-y-2 border-l-2 border-[var(--pq-accent)] pl-3" role="group" aria-label={l('确认所选关系', 'Confirm selected relations')}>
      <p className="text-sm font-medium">{kind === 'publish' ? l(`发布所选 ${rows.length} 条关系到当前账号`, `Publish ${rows.length} selected relations to this account`) : l(`接收所选 ${rows.length} 条到私有图谱`, `Accept ${rows.length} selected relations into the private graph`)}</p>
      {deleting > 0 ? <p className="text-xs text-[var(--pq-error)]">{kind === 'publish' ? l(`包含 ${deleting} 条删除，将删除账号中的关系。`, `Includes ${deleting} deletions from the account.`) : l(`包含 ${deleting} 条删除，将从私有图谱移除对应关系。`, `Includes ${deleting} deletions from the private graph.`)}</p> : null}
      {restoring > 0 ? <p className="text-xs text-[var(--pq-text-muted)]">{l(`包含 ${restoring} 条恢复，将恢复账号中已删除的关系。`, `Includes ${restoring} restores of deleted account relations.`)}</p> : null}
      <ul className="max-h-36 list-disc overflow-y-auto pl-4 text-xs leading-5">{rows.map(row => <li key={row.key} className="break-words">{row.label}</li>)}</ul>
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || rows.length === 0} onClick={kind === 'publish' ? props.onPublish : props.onAdopt}>{kind === 'publish' ? l('确认发布所选', 'Confirm publication') : l('确认接收所选', 'Confirm acceptance')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => props.onConfirm(null)}>{l('返回选择', 'Back to selection')}</button></div>
    </div>;
  };
  return <div className="space-y-3 text-[var(--pq-text)]" data-desktop-graph-review>
    <p className="break-words text-xs text-[var(--pq-text-muted)]">{l('检查时间：', 'Checked: ')}{preview.checkedAt}</p>
    <details open className="border-t border-[var(--pq-border)] pt-1">
      <summary className={summaryClass}>{l('本机关系 → 账号', 'Local relations → account')} <span className="font-normal text-[var(--pq-text-muted)]">({preview.localRows.length})</span></summary>
      {preview.localRows.length ? <PageRows key={preview.token} items={preview.localRows} l={l} renderRow={row => <li key={row.key} className="py-3">
        <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--pq-accent)]" checked={selectedLocal.includes(row.key)} disabled={disabled || row.action === 'none' || row.action === 'blocked'} onChange={event => props.onToggleLocal(row.key, event.target.checked)} /><span className="min-w-0 flex-1 break-words">{row.label}<span className={`mt-1 block text-xs ${row.action === 'delete' ? 'text-[var(--pq-error)]' : 'text-[var(--pq-text-muted)]'}`}>{actionLabel(row.action, l)}</span></span></label>
        {row.reason ? <Reason code={row.reason} l={l} /> : null}
        <details className="ml-7"><summary className="min-h-11 cursor-pointer py-3.5 text-xs text-[var(--pq-text-muted)]">{l('查看字段差异', 'View field differences')}</summary><div className="grid min-w-0 gap-2 lg:grid-cols-2"><DesktopGraphRelationDetails data={row.local} title={l('本机内容', 'Local content')} empty={row.action === 'delete' ? l('本机关系已删除', 'Local relation deleted') : undefined} l={l} /><DesktopGraphRelationDetails data={row.remote} title={l('账号内容', 'Account content')} empty={row.action === 'restore' ? l('账号关系已删除', 'Account relation deleted') : undefined} l={l} /></div><p className="mt-2 break-all text-xs text-[var(--pq-text-muted)]">{l('本机关系 ID：', 'Local relation ID: ')}{row.localRelationId || l('无法读取', 'Unavailable')}{row.entityId ? ` / ${row.entityId}` : ''}</p></details>
        {row.action === 'blocked' && row.raw !== undefined ? <details className="ml-7"><summary className="min-h-11 cursor-pointer py-3.5 text-xs text-[var(--pq-text-muted)]">{l('查看保留的本机原字段', 'View preserved original local fields')}</summary><pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-xl bg-[var(--pq-surface-2)] p-3 text-xs leading-5">{JSON.stringify(row.raw, null, 2)}</pre></details> : null}
      </li>} /> : <p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('当前文库暂无可检查的本机关系。', 'This library has no local relations to review.')}</p>}
      {confirmation === 'publish' ? confirm('publish') : <button type="button" className={buttonClass + ' mt-2'} disabled={disabled || local.length === 0} onClick={() => props.onConfirm('publish')}><ArrowUpFromLine className="h-4 w-4" />{l(`发布所选 (${local.length})…`, `Publish selected (${local.length})…`)}</button>}
    </details>
    <details open className="border-t border-[var(--pq-border)] pt-1">
      <summary className={summaryClass}>{l('账号关系 → 私有图谱', 'Account relations → private graph')} <span className="font-normal text-[var(--pq-text-muted)]">({preview.incoming.length})</span></summary>
      {preview.incoming.length ? <PageRows key={preview.token} items={preview.incoming} l={l} renderRow={row => <li key={row.key} className="py-3">
        <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--pq-accent)]" checked={selectedIncoming.includes(row.entityId)} disabled={disabled || !row.canAccept} onChange={event => props.onToggleIncoming(row.entityId, event.target.checked)} /><span className="min-w-0 flex-1 break-words">{row.label}<span className={`mt-1 block text-xs ${row.state === 'delete' ? 'text-[var(--pq-error)]' : 'text-[var(--pq-text-muted)]'}`}>{{ new: l('新关系', 'New relation'), update: l('有更新', 'Updated'), delete: l('从私有图谱移除', 'Remove from private graph'), same: l('已接收，无变化', 'Accepted, unchanged'), unmapped: l('保留在账号，端点待绑定', 'Preserved in the account; endpoints unbound'), pending: l('有待处理请求', 'Pending request') }[row.state]}</span></span></label>
        {row.reason ? <Reason code={row.reason} l={l} /> : null}
        <details className="ml-7"><summary className="min-h-11 cursor-pointer py-3.5 text-xs text-[var(--pq-text-muted)]">{l('查看接收差异', 'View acceptance differences')}</summary><div className="grid min-w-0 gap-2 lg:grid-cols-2"><DesktopGraphRelationDetails data={row.accepted} title={l('私有图谱已有内容', 'Existing private graph content')} empty={l('尚无已接收内容', 'No accepted content')} l={l} /><DesktopGraphRelationDetails data={row.data} title={l(`账号版本 ${row.revision}`, `Account revision ${row.revision}`)} empty={row.state === 'delete' ? l('账号关系已删除', 'Account relation deleted') : undefined} l={l} /></div><p className="mt-2 break-all text-xs text-[var(--pq-text-muted)]">{l('账号关系 ID：', 'Account relation ID: ')}{row.entityId}</p></details>
      </li>} /> : <p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('账号中暂无待接收关系。', 'The account has no relations to accept.')}</p>}
      {confirmation === 'adopt' ? confirm('adopt') : <button type="button" className={buttonClass + ' mt-2'} disabled={disabled || incoming.length === 0} onClick={() => props.onConfirm('adopt')}><ArrowDownToLine className="h-4 w-4" />{l(`接收所选 (${incoming.length})…`, `Accept selected (${incoming.length})…`)}</button>}
    </details>
    {preview.conflicts.length ? <details open className="border-t border-[var(--pq-border)] pt-1">
      <summary className={summaryClass}>{l(`待决定的冲突 (${preview.conflicts.length})`, `Conflicts to decide (${preview.conflicts.length})`)}</summary>
      <PageRows key={preview.token} items={preview.conflicts} l={l} renderRow={conflict => <li key={conflict.conflictId} className="space-y-3 py-3">
        <p className="break-words text-sm font-medium">{conflict.label}</p>
        <p className="text-xs text-[var(--pq-text-muted)]">{l(`账号版本 ${conflict.expectedRevision}；请查看两份内容后选择。`, `Account revision ${conflict.expectedRevision}; review both versions before choosing.`)}</p>
        <div className="grid min-w-0 gap-2 lg:grid-cols-2"><DesktopGraphRelationDetails data={conflict.current?.data} title={l('当前账号版本', 'Current account version')} empty={conflict.current?.deletedAt ? l('已删除', 'Deleted') : l('尚无账号版本', 'No account version')} l={l} /><DesktopGraphRelationDetails data={conflict.attempted.data} title={l('本次请求：', 'This request: ') + actionLabel(conflict.attempted.mutation, l)} empty={conflict.attempted.mutation === 'delete' ? l('请求删除这条关系', 'Requests deletion of this relation') : undefined} l={l} /></div>
        <fieldset disabled={disabled} className="flex flex-wrap gap-x-4 gap-y-2 text-xs"><legend className="sr-only">{l('选择冲突处理方式', 'Choose conflict resolution')}</legend>{(['current', 'attempted'] as const).map(choice => <label key={choice} className="flex min-h-11 items-center gap-2"><input type="radio" name={`graph-conflict-${conflict.conflictId}`} checked={conflictChoices[conflict.conflictId] === choice} onChange={() => props.onConflictChoice(conflict.conflictId, choice)} />{choice === 'current' ? l('保留当前账号版本', 'Keep current account version') : l('使用本次请求', 'Use this request')}</label>)}</fieldset>
        <button type="button" className={buttonClass} disabled={disabled || !conflictChoices[conflict.conflictId]} onClick={() => props.onResolve(conflict)}>{l('确认这条冲突的选择', 'Confirm this conflict choice')}</button>
      </li>} />
    </details> : null}
    {preview.pendingRows.length + preview.pendingResolutions.length > 0 ? <details className="border-t border-[var(--pq-border)] pt-1">
      <summary className={summaryClass}>{l(`待处理原请求 (${preview.pendingRows.length + preview.pendingResolutions.length})`, `Pending original requests (${preview.pendingRows.length + preview.pendingResolutions.length})`)}</summary>
      <PageRows key={preview.token} items={preview.pendingRows} l={l} renderRow={row => <li key={row.opId} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{row.label}</p><p className="text-xs text-[var(--pq-text-muted)]">{actionLabel(row.mutation, l)} · {pendingLabel(row.stage, l)}</p><DesktopGraphRelationDetails data={row.data} title={l('已保存的原请求内容', 'Saved original request')} empty={row.mutation === 'delete' ? l('请求删除这条关系', 'Requests deletion of this relation') : undefined} l={l} /><p className="break-all text-xs text-[var(--pq-text-muted)]">{l('请求 ID：', 'Request ID: ')}{row.opId}</p></li>} />
      <PageRows key={`${preview.token}:resolutions`} items={preview.pendingResolutions} l={l} renderRow={row => {
        const conflict = preview.conflicts.find(item => item.conflictId === row.conflictId);
        const deletes = row.choice === 'merged' ? row.mutation === 'delete' : conflict?.attempted.mutation === 'delete';
        return <li key={row.opId} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{l('已保存的冲突决定：', 'Saved conflict choice: ')}{conflict?.label || row.conflictId}</p>
          <p className="text-xs text-[var(--pq-text-muted)]">{row.choice === 'current' ? l(`保留账号版本 ${row.expectedRevision}`, `Keep account revision ${row.expectedRevision}`) : row.choice === 'attempted' ? l('使用原始请求内容', 'Use the original attempted content') : l('使用已保存的合并内容', 'Use saved merged content')}</p>
          {row.choice !== 'current' ? <DesktopGraphRelationDetails data={row.choice === 'merged' ? row.data : conflict?.attempted.data} title={l('原决定的内容', 'Original choice content')} empty={deletes ? l('删除关系', 'Delete relation') : l('请在冲突详情中核对原始请求。', 'Review the original request in conflict details.')} l={l} /> : null}
          <p className="text-xs text-[var(--pq-text-muted)]">{row.lastResult?.status === 'rejected' ? l('该决定未被接受', 'This choice was rejected') : row.lastResult?.status === 'conflict' ? l('账号版本已变化，需重新选择', 'The account version changed; choose again') : l('决定的处理结果待确认', 'The choice outcome is unconfirmed')}</p>
          {row.lastResult?.code ? <Reason code={row.lastResult.code} l={l} /> : null}<p className="break-all text-xs text-[var(--pq-text-muted)]">{l('请求 ID：', 'Request ID: ')}{row.opId}</p>
        </li>;
      }} />
    </details> : null}
    <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('关系分数是原始建议分数，不代表经过校准的概率。', 'A relation score is the original suggestion score, not a calibrated probability.')}</p>
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

  const check = () => run('preview', async () => {
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

  return <SettingsField label={l('图谱关系交换', 'Graph relation exchange')} description={l('先查看差异，再选择发布到账号，或接收到当前账号的私有图谱。', 'Review differences, then choose what to publish to your account or accept into its private graph.')}>
    <div className="space-y-3" data-desktop-graph-exchange>
      {!accountActive ? <p className="text-sm text-[var(--pq-text-muted)]">{l('登录后可检查当前文库的关系。', 'Sign in to review relations in this library.')}</p> : status && !status.supported ? <p className="text-sm text-[var(--pq-text-muted)]">{l('当前账号服务尚未支持图谱关系交换。', 'This account service does not support graph relation exchange.')}</p> : null}
      {status?.loaded ? <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--pq-text-muted)]">{[[l('已接收', 'Accepted'), status.accepted], [l('已绑定材料', 'Bound materials'), status.mapped], [l('映射待处理项', 'Mapping items to review'), status.unmapped], [l('待处理', 'Pending'), status.pending], [l('冲突', 'Conflicts'), status.conflicts]].map(([label, count]) => <div key={label} className="flex gap-2"><dt>{label}</dt><dd className="font-medium text-[var(--pq-text)]">{count}</dd></div>)}</dl> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={disabled || !status?.supported} onClick={() => void check()}><GitCompareArrows className="h-4 w-4" />{working === 'preview' ? l('正在检查…', 'Checking…') : l('检查关系差异', 'Check relation differences')}</button>
        <button type="button" className={buttonClass} disabled={!sameOwner || busy || !status?.loaded && !status?.saveUnconfirmed} onClick={() => void run('export', async () => {
          const request = sequence.current, result = await desktopGraphExchange.exportBackup();
          if (alive.current && request === sequence.current && currentStatus.current?.scopeKey === ownerKey && result.status === 'exported') setNotice(l('私有图谱、待处理请求及冲突已导出备份。', 'Private graph, pending requests and conflicts exported.'));
        })}><Download className="h-4 w-4" />{l('导出备份', 'Export backup')}</button>
        {canStop ? <button type="button" className={buttonClass} disabled={!sameOwner || working === 'stop'} onClick={() => void change('stop', desktopGraphExchange.stop, l('已停止等待；原请求仍保留。', 'Waiting stopped; original requests are preserved.'), true)}><Square className="h-3 w-3" />{l('停止等待', 'Stop waiting')}</button> : null}
      </div>
      {status?.saveUnconfirmed ? <div className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3"><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('本机保存尚未确认。仅重试保存会保留当前结果，不发送关系请求。', 'Local persistence is unconfirmed. Retry saving preserves the current result without sending relation requests.')}</p><button type="button" className={buttonClass} disabled={!sameOwner || busy} onClick={() => void change('save', desktopGraphExchange.retrySave, l('本机保存已确认，请重新检查差异。', 'Local save confirmed. Check differences again.'))}><RefreshCw className="h-4 w-4" />{l('仅重试保存', 'Retry saving only')}</button></div> : null}
      {status && status.pending > 0 ? <div className="space-y-2"><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{status.continuable > 0 ? l(`有 ${status.pending} 项待处理，其中 ${status.continuable} 个原请求可继续。继续时使用原请求标识核对或发送。`, `${status.pending} items are pending; ${status.continuable} original requests can continue. Their original identifiers are used to check or send them.`) : l(`有 ${status.pending} 项待处理。请检查差异，查看冲突或未接受的请求。`, `${status.pending} items need attention. Check differences to review conflicts or rejected requests.`)}</p>{status.continuable > 0 ? <button type="button" className={buttonClass} disabled={disabled} onClick={() => void change('continue', desktopGraphExchange.continue, l('原请求处理已返回，请检查状态或重新查看差异。', 'Original request processing returned. Review its status or check differences again.'))}>{l('继续原请求', 'Continue original requests')}</button> : null}</div> : null}
      {visibleError && !(status?.saveUnconfirmed && visibleError === 'GRAPH_SAVE_UNCONFIRMED') ? <div role="alert"><Reason code={visibleError} l={l} /></div> : null}
      {notice ? <p role="status" className="text-xs leading-5 text-[var(--pq-text-muted)]">{notice}</p> : null}
      {validPreview ? <DesktopGraphExchangeReview preview={validPreview} disabled={disabled} selectedLocal={selectedLocal} selectedIncoming={selectedIncoming} confirmation={confirmation} conflictChoices={conflictChoices} l={l}
        onToggleLocal={(key, checked) => toggle(setSelectedLocal, key, checked)} onToggleIncoming={(key, checked) => toggle(setSelectedIncoming, key, checked)} onConfirm={setConfirmation}
        onPublish={() => { if (!disabled && confirmation === 'publish') void change('publish', () => desktopGraphExchange.publish({ token: validPreview.token, keys: validPreview.localRows.filter(row => selectedLocal.includes(row.key) && row.action !== 'none' && row.action !== 'blocked').map(row => row.key) }), l('所选发布请求已处理，请查看状态并重新检查差异。', 'Selected publication requests processed. Review the status and check differences again.')); }}
        onAdopt={() => { if (!disabled && confirmation === 'adopt') void change('adopt', () => desktopGraphExchange.adopt({ token: validPreview.token, ids: validPreview.incoming.filter(row => selectedIncoming.includes(row.entityId) && row.canAccept).map(row => row.entityId) }), l('所选关系已接收到私有图谱。', 'Selected relations accepted into the private graph.')); }}
        onConflictChoice={(id, choice) => setConflictChoices(previous => ({ ...previous, [id]: choice }))}
        onResolve={conflict => { const choice = conflictChoices[conflict.conflictId]; if (!disabled && choice) void change('resolve', () => desktopGraphExchange.resolve({ conflictId: conflict.conflictId, choice, expectedRevision: conflict.expectedRevision }), l('这条冲突的选择已处理，请重新检查差异。', 'This conflict choice was processed. Check differences again.')); }} /> : null}
      <details className="border-t border-[var(--pq-border)] pt-1"><summary className="min-h-11 cursor-pointer py-3.5 text-xs text-[var(--pq-text-muted)]">{l('范围、绑定与完整字段', 'Scope, bindings and full fields')}</summary><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('私有图谱按服务、账号和文库分别保存；接收不会覆盖本机已有图谱。当前使用已发布或此前经 PDF 版本核验建立的唯一论文绑定。笔记等尚无显式绑定的端点会标为待绑定，保留关系及完整说明，不按标题或相同 ID 猜测。', 'Private graphs are separate for each service, account and library. Acceptance preserves the existing local graph. Papers use unique bindings established by publication or prior PDF-version verification. Notes and other endpoints without an explicit binding remain unbound, preserving the relation and its full description. Titles or matching IDs do not establish a binding.')}</p><p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('已绑定材料统计端点材料数；映射待处理项按绑定与关系问题计数，可能涉及同一条关系。', 'Bound materials counts endpoint materials. Mapping items count binding and relation issues; several may concern one relation.')}</p><p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('导出备份包含当前私有图谱、原请求与冲突。本地图谱原 JSON 及无法交换的原字段请随文库备份。', 'Export includes the current private graph, original requests and conflicts. Back up the original local graph JSON and unsupported fields with your library.')}</p></details>
    </div>
  </SettingsField>;
}
