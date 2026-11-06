import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, ChevronRight, Download, Link2, RefreshCw, Square } from 'lucide-react';
import { emitNoteChanged } from '../../app/appEvents';
import {
  desktopNoteExchange,
  type DesktopNoteAdoptResult,
  type DesktopNoteConflict,
  type DesktopNoteConflictChoice,
  type DesktopNoteExchangePreview,
  type DesktopNoteExchangeStatus,
  type DesktopNoteIncomingRow,
  type DesktopNoteList,
  type DesktopNoteLocalRow,
  type DesktopNoteSummary,
} from '../../services/desktopNoteExchange';
import { SettingsField } from './readerPreferencesPrimitives';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

const buttonClass = 'pq-button inline-flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const summaryClass = 'min-h-11 cursor-pointer py-3 text-sm font-medium text-[var(--pq-text)]';
const contentClass = 'min-w-0 rounded-xl border border-[var(--pq-border)] bg-[var(--pq-surface-2)] p-3';
const selectionClass = 'flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm';
const PAGE_SIZE = 8;
const MAX_NOTES = 16;

function errorCode(error: unknown): string {
  const value = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  return value.match(/\b[A-Z][A-Z_]{3,70}\b/)?.[0] || 'UNKNOWN';
}

function reasonLabel(code: string, l: ReaderPreferencesLocalizer): string {
  const labels: Record<string, [string, string]> = {
    NOTE_FEATURE_UNAVAILABLE: ['当前账号服务尚未支持笔记同步。', 'This account service does not support note sync yet.'],
    NOTE_RICH_UNSUPPORTED: ['当前账号服务尚未支持这种笔记格式，请联系管理员更新服务。', 'This note format is not supported by the account service. Ask the administrator to update it.'],
    NOTE_RICH_UNAVAILABLE: ['当前账号服务尚未支持富文本笔记，请联系管理员更新服务。', 'This account service does not support rich text notes yet. Ask the administrator to update it.'],
    NOTE_PREVIEW_REQUIRED: ['请先检查所选笔记的内容。', 'Check the selected notes first.'],
    NOTE_PREVIEW_STALE: ['预览已过期，请重新检查笔记内容。', 'This preview expired. Check the notes again.'],
    NOTE_SOURCE_CHANGED: ['笔记保存内容已变化，请重新检查后发送。', 'The saved note changed. Check it again before sending.'],
    NOTE_MAPPING_CHANGED: ['账号、服务或文库已变化，请重新检查。', 'The account, service or library changed. Check again.'],
    NOTE_BINDING_CHANGED: ['笔记的关联已变化，请重新检查双方内容。', 'The note link changed. Review both notes again.'],
    NOTE_BINDING_EXISTS: ['这份笔记已有对应关系，请重新检查后选择。', 'This note is already linked. Check again before choosing.'],
    NOTE_BINDING_CONFLICT: ['这两份笔记已有其他对应关系。请核对原有的关联，再重新选择。', 'These notes already have different links. Check their existing links, then choose again.'],
    NOTE_BINDING_REQUIRED: ['这份账号笔记已存在。请先到关联已有笔记中核对双方内容。', 'This account note already exists. Review both notes under Link existing notes first.'],
    NOTE_SCOPE_CHANGED: ['账号、服务或文库已变化，请重新检查。', 'The account, service or library changed. Check again.'],
    NOTE_SELECTION_INVALID: ['本次选择无效。每次最多处理 16 份笔记，请重新选择。', 'This selection is invalid. Choose up to 16 notes at a time.'],
    NOTE_CONFLICT_CHANGED: ['需要处理的内容已变化，请重新检查再选择。', 'The content to resolve changed. Check again before choosing.'],
    NOTE_REMOTE_UNAVAILABLE: ['这份账号笔记当前不可用，请重新检查。', 'This account note is unavailable. Check again.'],
    NOTE_RESTORE_REQUIRED: ['这份账号笔记已删除。请重新检查，并明确确认是否恢复。', 'This account note was deleted. Check again and explicitly confirm whether to restore it.'],
    NOTE_UNSUPPORTED: ['这份笔记暂不能完整交换。原笔记仍保留，请检查其中的内容格式。', 'This note cannot be exchanged completely yet. The original is preserved; check its content format.'],
    NOTE_COPY_SAVE_UNCONFIRMED: ['笔记副本尚未确认保存。请继续保存本机副本，保留上次已接收的内容。', 'Saving the note copy is unconfirmed. Continue saving local copies to preserve the content already received.'],
    NOTE_COPY_CHANGED: ['待恢复的本机副本已有修改，操作已停止。请保留并核对这份笔记。', 'The local copy to recover was edited. Work stopped; preserve and review that note.'],
    NOTE_PENDING: ['先处理这份笔记的未完成操作，再继续同步。', 'Finish this note’s pending operations before syncing again.'],
    NOTE_CONFLICT: ['账号内容与这次修改不同，请到未完成操作中选择要保留的内容。', 'Account content differs from this change. Choose which content to keep under unfinished operations.'],
    NOTE_SAVE_UNCONFIRMED: ['结果尚未确认保存到本机。请仅重试保存，也可以先导出备份。', 'Local saving is unconfirmed. Retry saving only, or export a backup first.'],
    NOTE_STATE_INVALID: ['笔记同步记录无法读取。请保留原文件并检查本机存储。', 'The note sync record cannot be read. Preserve the original file and check local storage.'],
    NOTE_STATE_FULL: ['笔记同步记录已达到容量限制，请先导出备份。', 'The note sync record reached its capacity limit. Export a backup first.'],
    NOTE_STORAGE_CHANGED: ['本机同步记录已变化，尚未被覆盖。请先导出备份并核对存储。', 'The local sync record changed and was not overwritten. Export a backup and check storage.'],
    NOTE_LIMIT: ['这次选择超过容量限制，请减少笔记数量。', 'This selection exceeds the limit. Choose fewer notes.'],
    NOTE_HEAD_MISSING: ['暂未取得这份笔记的账号内容，请重新检查。', 'The account note is unavailable. Check again.'],
    NOTE_OPERATION_REJECTED: ['账号未接受这次操作，请查看操作详情后重新检查。', 'The account rejected this operation. Review its details, then check again.'],
    REMOTE_NOTE_CHANGED: ['账号笔记已更新，请先查看双方内容再决定。', 'The account note changed. Review both versions before deciding.'],
    SAVED_NOTE_UNAVAILABLE: ['这份本机笔记当前无法读取，请先在笔记中检查并保存。', 'This local note cannot be read. Open it in Notes and save it first.'],
    INVALID_NOTE_SELECTION: ['请选择一到十六份本机笔记。', 'Choose one to sixteen local notes.'],
    UNMAPPED_NOTE_REFERENCE: ['有引用尚未关联到账号。请先关联被引用的内容，或与相关笔记一起发送。', 'Some references are not linked to the account. Link the referenced content, or send the related notes together.'],
    UNMAPPED_NOTE_PAPER: ['这份笔记所属的文献尚未在本机关联。先关联对应文献，再接收笔记。', 'The paper this note belongs to is not linked on this computer. Link that paper before receiving the note.'],
    MISSING_LOCAL_MATERIAL: ['关联的本机内容已不可用，请检查原笔记。', 'The linked local content is unavailable. Check the original note.'],
    REVISION_MISMATCH: ['账号内容已有更新，请重新检查后选择。', 'Account content changed. Check again before choosing.'],
    AUTHENTICATION_REQUIRED: ['请先登录账号。', 'Sign in to your account first.'],
    AUTH_SESSION_CHANGED: ['登录身份已变化，请确认当前账号。', 'The signed-in identity changed. Check the current account.'],
    DESKTOP_LIBRARY_CHANGED: ['当前文库已变化，请重新选择笔记。', 'The library changed. Select the notes again.'],
    DESKTOP_OPERATION_CANCELLED: ['已停止等待，未完成操作仍保留。', 'Waiting stopped. Unfinished operations are preserved.'],
    DESKTOP_REQUEST_TIMEOUT: ['本次等待超时。请检查未完成操作后决定是否继续。', 'This wait timed out. Review unfinished operations before continuing.'],
    NETWORK_ERROR: ['连接未完成。已保存的操作可在核对后继续。', 'The connection did not complete. Saved operations can be continued after review.'],
    SOURCE_TOO_LARGE: ['所选笔记内容超过容量限制，请减少这次发送的笔记数量。', 'The selected content exceeds the limit. Send fewer notes at a time.'],
    IMAGE_LIMIT: ['笔记中的图片超过容量限制，请先检查图片。', 'Images in this note exceed the limit. Check its images first.'],
    REMOTE_IMAGE_UNSUPPORTED: ['这份笔记含有尚未保存到本机的图片，请先在笔记中保存图片。', 'This note contains images that are not saved locally. Save them in Notes first.'],
    LOCAL_IMAGE_UNSUPPORTED: ['有图片当前无法完整交换，原笔记仍保留。', 'An image cannot be exchanged completely. The original note is preserved.'],
  };
  return labels[code] ? l(...labels[code]) : l('本次操作未完成。请检查笔记内容和连接；详情中保留了诊断信息。', 'This operation did not complete. Check the note and connection; diagnostic details are available below.');
}

function Reason({ code, l }: { code: string; l: ReaderPreferencesLocalizer }) {
  return <p className="mt-2 text-sm leading-6 text-[var(--pq-text-muted)]">{reasonLabel(code, l)}</p>;
}

function Diagnostics({ data, l }: { data: unknown; l: ReaderPreferencesLocalizer }) {
  return <details><summary className={summaryClass}>{l('操作详情', 'Operation details')}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-[var(--pq-text-muted)]">{JSON.stringify(data, null, 2)}</pre></details>;
}

function actionLabel(action: DesktopNoteLocalRow['action'] | 'put' | 'delete', l: ReaderPreferencesLocalizer): string {
  return ({ create: l('添加到账号', 'Add to account'), update: l('更新账号内容', 'Update account content'), restore: l('恢复账号中已删除的笔记', 'Restore a deleted account note'), none: l('内容没有变化', 'Content is unchanged'), blocked: l('暂不能发送', 'Cannot send yet'), put: l('保存笔记修改', 'Save note changes'), delete: l('删除账号笔记', 'Delete account note') })[action];
}

function pendingLabel(stage: string, l: ReaderPreferencesLocalizer): string {
  return ({ queued: l('等待发送', 'Waiting to send'), sending: l('等待响应', 'Waiting for response'), uncertain: l('结果待核对', 'Outcome to verify'), conflict: l('等待决定保留哪份内容', 'Choose which content to keep'), rejected: l('操作未被接受', 'Operation rejected'), 'device-blocked': l('设备需要重新授权', 'Device authorization required'), overlay: l('本机修改待发送', 'Local changes waiting to send') } as Record<string, string>)[stage] || l('需要检查处理结果', 'Review the operation result');
}

export function DesktopNoteContent({ data, title, empty, l }: { data?: DesktopNoteSummary | null; title: string; empty?: string; l: ReaderPreferencesLocalizer }) {
  return <section className={contentClass}>
    <h5 className="text-sm font-medium">{title}</h5>
    {data ? <>
      <p className="mt-2 break-words text-sm font-medium">{data.title || l('未命名笔记', 'Untitled note')}</p>
      <p className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-[var(--pq-text-muted)]">{data.body || l('正文为空', 'The note is empty')}</p>
      <p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{data.format === 'tiptap-json' ? l('富文本', 'Rich text') : l('文本笔记', 'Text note')}{data.images > 0 ? l(`，含 ${data.images} 张图片`, `, includes ${data.images} images`) : ''}</p>
      {data.tags.length > 0 ? <p className="mt-2 break-words text-xs leading-5 text-[var(--pq-text-muted)]">{l('标签：', 'Tags: ')}{data.tags.join('、')}</p> : null}
      {data.unresolvedReferences > 0 ? <p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l(`有 ${data.unresolvedReferences} 处引用尚未关联，原引用文字会保留。`, `${data.unresolvedReferences} references are not yet linked. Their original text is preserved.`)}</p> : null}
    </> : <p className="mt-2 text-sm leading-6 text-[var(--pq-text-muted)]">{empty || l('无对应内容', 'No corresponding content')}</p>}
  </section>;
}

function PageRows<T>({ items, renderRow, l }: { items: T[]; renderRow: (item: T) => ReactNode; l: ReaderPreferencesLocalizer }) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1), current = Math.min(page, last);
  return <>
    <ul className="divide-y divide-[var(--pq-border)]">{items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(renderRow)}</ul>
    {last > 0 ? <nav className="mt-2 flex flex-wrap items-center justify-between gap-2" aria-label={l('笔记列表分页', 'Note list pages')}><span className="text-xs text-[var(--pq-text-muted)]">{l(`第 ${current + 1} / ${last + 1} 页，共 ${items.length} 项`, `Page ${current + 1} of ${last + 1}, ${items.length} items`)}</span><div className="flex gap-2"><button type="button" className={buttonClass} disabled={current === 0} onClick={() => setPage(current - 1)}>{l('上一页', 'Previous')}</button><button type="button" className={buttonClass} disabled={current === last} onClick={() => setPage(current + 1)}>{l('下一页', 'Next')}</button></div></nav> : null}
  </>;
}

export type DesktopNoteExchangeTask = 'publish' | 'adopt' | 'bind' | 'pending';
type Confirmation = 'publish' | 'adopt' | 'bind' | 'delete' | null;

function canDeleteAccountNote(row: DesktopNoteIncomingRow, preview: DesktopNoteExchangePreview): boolean {
  return !!row.data && row.state !== 'delete' && row.state !== 'pending'
    && !preview.conflicts.some(item => item.entityId === row.entityId)
    && !preview.pendingRows.some(item => item.entityId === row.entityId);
}

function taskTitle(task: DesktopNoteExchangeTask, l: ReaderPreferencesLocalizer): string {
  return ({ publish: l('发送本机笔记', 'Send local notes'), adopt: l('接收账号笔记', 'Receive account notes'), bind: l('关联已有笔记', 'Link existing notes'), pending: l('处理未完成操作', 'Finish pending operations') })[task];
}

export function DesktopNoteExchangeTaskPicker({ disabled, onTask, l }: { disabled: boolean; onTask: (task: DesktopNoteExchangeTask) => void; l: ReaderPreferencesLocalizer }) {
  const tasks = [
    { key: 'publish' as const, icon: ArrowUpFromLine, description: l('先选择这台电脑上已保存的笔记，再查看发送内容。', 'Choose saved notes from this computer, then review what to send.') },
    { key: 'adopt' as const, icon: ArrowDownToLine, description: l('把账号中的笔记保存为本机副本，继续阅读和编辑。', 'Save account notes as local copies to read and edit.') },
    { key: 'bind' as const, icon: Link2, description: l('手动指定本机与账号中已有笔记的对应关系。', 'Choose which existing local and account notes belong together.') },
    { key: 'pending' as const, icon: RefreshCw, description: l('核对上次结果，继续发送或决定保留哪份内容。', 'Review previous results, continue sending or choose which content to keep.') },
  ];
  return <div className="divide-y divide-[var(--pq-border)]" data-note-task-picker>{tasks.map(task => <button key={task.key} type="button" data-note-task={task.key} className="flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-4 text-left text-[var(--pq-text)] enabled:hover:bg-[var(--pq-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pq-accent)] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => onTask(task.key)}><task.icon aria-hidden className="h-5 w-5 shrink-0" /><span className="min-w-0"><span className="block text-sm font-medium">{taskTitle(task.key, l)}</span><span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{task.description}</span></span><ChevronRight aria-hidden className="ml-auto h-4 w-4 shrink-0 text-[var(--pq-text-muted)]" /></button>)}</div>;
}

export function DesktopNoteLocalSelection({ list, task, selected, search, disabled, onSearch, onSelect, onPreview, l }: {
  list: DesktopNoteList; task: 'publish' | 'bind'; selected: string[]; search: string; disabled: boolean;
  onSearch: (text: string) => void; onSelect: (id: string, checked: boolean) => void; onPreview: () => void; l: ReaderPreferencesLocalizer;
}) {
  const filtered = list.notes.filter(note => note.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section aria-label={l('选择本机笔记', 'Choose local notes')} className="space-y-2">
    <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{task === 'publish' ? l('每次最多选择 16 份。笔记中的修改需要先保存；相互引用的笔记请一起选择。', 'Choose up to 16 notes. Save edits first, and select notes that reference each other together.') : l('先选择一份本机笔记，再选择账号中与它对应的笔记。', 'Choose one local note, then its corresponding account note.')}</p>
    <label className="block text-sm"><span className="mb-1 block">{l('查找本机笔记', 'Find a local note')}</span><input type="search" value={search} onChange={event => onSearch(event.target.value)} disabled={disabled} className="pq-input min-h-11 w-full px-3 py-2" /></label>
    <PageRows key={search} items={filtered} l={l} renderRow={note => <li key={note.localNoteId} className="py-2"><label className={selectionClass}><input type={task === 'bind' ? 'radio' : 'checkbox'} name={task === 'bind' ? 'note-local-binding' : undefined} className="mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]" checked={selected.includes(note.localNoteId)} disabled={disabled || task === 'publish' && selected.length >= MAX_NOTES && !selected.includes(note.localNoteId)} onChange={event => onSelect(note.localNoteId, event.target.checked)} /><span className="min-w-0 break-words"><span className="block font-medium">{note.title || l('未命名笔记', 'Untitled note')}</span><span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{note.boundEntityId ? l('已关联账号笔记', 'Linked to an account note') : l('尚未关联', 'Not linked yet')}</span></span></label></li>} />
    {!filtered.length ? <p className="py-3 text-sm text-[var(--pq-text-muted)]">{list.notes.length ? l('没有找到匹配的笔记。', 'No notes match your search.') : l('这份文库还没有本机笔记。先在笔记中创建并保存。', 'This library has no local notes yet. Create and save one in Notes first.')}</p> : null}
    <div className="flex flex-wrap items-center gap-3"><button type="button" className={buttonClass} disabled={disabled || selected.length === 0 || selected.length > (task === 'bind' ? 1 : MAX_NOTES)} onClick={onPreview}>{task === 'bind' ? l('选择对应的账号笔记', 'Choose the matching account note') : l('查看发送内容', 'Review notes to send')}</button><span role="status" className="text-xs text-[var(--pq-text-muted)]">{l(`已选择 ${selected.length} 份`, `${selected.length} notes selected`)}</span></div>
  </section>;
}

export interface DesktopNoteReviewProps {
  task: DesktopNoteExchangeTask; preview: DesktopNoteExchangePreview; disabled: boolean;
  selectedIncoming: string[]; bindingEntityId: string; deleteEntityId: string; confirmation: Confirmation; restoreConfirmed: boolean;
  conflictChoices: Record<string, DesktopNoteConflictChoice>;
  onToggleIncoming: (id: string, checked: boolean) => void; onBinding: (id: string) => void;
  onConfirm: (action: Confirmation) => void; onRestoreConfirmed: (confirmed: boolean) => void;
  onPublish: () => void; onAdopt: () => void; onBind: () => void; onBackToSelection: () => void;
  onDeleteSelection: (id: string) => void; onDelete: () => void;
  onConflictChoice: (id: string, choice: DesktopNoteConflictChoice) => void; onResolve: (conflict: DesktopNoteConflict) => void;
  l: ReaderPreferencesLocalizer;
}

export function DesktopNoteExchangeReview(props: DesktopNoteReviewProps) {
  const { task, preview, disabled, selectedIncoming, bindingEntityId, deleteEntityId, confirmation, restoreConfirmed, conflictChoices, l } = props;
  const actionable = preview.localRows.filter(row => !['none', 'blocked'].includes(row.action));
  const restoring = actionable.filter(row => row.action === 'restore');
  const incoming = preview.incoming.filter(row => selectedIncoming.includes(row.entityId) && row.canAccept);
  const localBinding = preview.localRows.length === 1 ? preview.localRows[0] : undefined;
  const accountBinding = preview.incoming.find(row => row.entityId === bindingEntityId && row.data && !['delete', 'pending'].includes(row.state));
  const deleting = preview.incoming.find(row => row.entityId === deleteEntityId && canDeleteAccountNote(row, preview));
  return <div className="space-y-3 text-[var(--pq-text)]" data-desktop-note-review data-note-review-task={task}>
    {task === 'publish' ? <section aria-label={l('本次发送内容', 'Notes to send')}>
      <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('发送会处理下方所有可发送的笔记。需要增减笔记时，请返回选择并重新检查。', 'Sending includes every eligible note below. To change the selection, go back and check again.')}</p>
      <PageRows key={preview.token} items={preview.localRows} l={l} renderRow={row => <li key={row.key} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{row.label}</p><p className="text-sm text-[var(--pq-text-muted)]">{actionLabel(row.action, l)}</p><div className="grid min-w-0 gap-2 lg:grid-cols-2"><DesktopNoteContent data={row.local} title={l('本机已保存的内容', 'Saved local content')} l={l} /><DesktopNoteContent data={row.remote} title={l('账号中的内容', 'Account content')} empty={row.action === 'restore' ? l('账号笔记已删除', 'The account note was deleted') : undefined} l={l} /></div>{row.reason ? <><Reason code={row.reason} l={l} /><Diagnostics data={{ reason: row.reason, localNoteId: row.localNoteId, entityId: row.entityId }} l={l} /></> : null}</li>} />
      {!preview.localRows.length ? <p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('没有可供检查的本机笔记，请返回重新选择。', 'There are no local notes to review. Go back and select again.')}</p> : null}
      {confirmation === 'publish' ? <div data-note-confirmation tabIndex={-1} role="group" aria-label={l('确认发送笔记', 'Confirm sending notes')} className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3 focus:outline-none"><p className="text-sm font-medium">{l(`即将把 ${actionable.length} 份笔记发送到账号`, `Ready to send ${actionable.length} notes to your account`)}</p><ul className="max-h-36 list-disc overflow-auto pl-4 text-sm leading-6">{actionable.map(row => <li key={row.key} className="break-words">{row.label}</li>)}</ul>{restoring.length > 0 ? <label className={selectionClass}><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]" checked={restoreConfirmed} disabled={disabled} onChange={event => props.onRestoreConfirmed(event.target.checked)} /><span>{l(`确认恢复账号中已删除的 ${restoring.length} 份笔记。`, `Restore ${restoring.length} notes previously deleted from the account.`)}</span></label> : null}<div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !actionable.length || restoring.length > 0 && !restoreConfirmed} onClick={props.onPublish}>{l(`发送这 ${actionable.length} 份笔记`, `Send these ${actionable.length} notes`)}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => props.onConfirm(null)}>{l('返回查看', 'Back to review')}</button></div></div> : <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !actionable.length} onClick={() => props.onConfirm('publish')}>{l('继续发送', 'Continue to send')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={props.onBackToSelection}>{l('重新选择笔记', 'Change selected notes')}</button></div>}
    </section> : null}
    {task === 'adopt' ? <section aria-label={l('选择账号笔记', 'Choose account notes')}>
      <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('每次最多接收 16 项。接收后会创建新的本机副本，并关联到账号笔记。原本机笔记保留，你可以在笔记中继续编辑新副本。', 'Receive up to 16 items at a time as new local copies linked to the account notes. Existing local notes are preserved. Edit the new copies in Notes.')}</p>
      <PageRows key={preview.token} items={preview.incoming} l={l} renderRow={row => <li key={row.entityId} className="space-y-2 py-3">
        <label className={selectionClass}>
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]" checked={selectedIncoming.includes(row.entityId)}
            disabled={disabled || !row.canAccept || selectedIncoming.length >= MAX_NOTES && !selectedIncoming.includes(row.entityId)}
            onChange={event => props.onToggleIncoming(row.entityId, event.target.checked)} />
          <span className="min-w-0 break-words font-medium">{row.label}<span className="mt-1 block text-xs font-normal leading-5 text-[var(--pq-text-muted)]">{row.state === 'delete' ? l('仅接收删除标记，本机笔记保留', 'Receive the deletion marker; local notes stay') : row.state === 'same' ? l('已接收当前内容', 'Current content already received') : row.state === 'pending' ? l('先处理未完成操作', 'Finish pending operations first') : row.canAccept ? l('接收为新的本机副本', 'Receive as a new local copy') : l('暂不能接收', 'Cannot receive yet')}</span></span>
        </label>
        <div className="grid min-w-0 gap-2 lg:grid-cols-2">
          <DesktopNoteContent data={row.data} title={l('账号中的内容', 'Account content')} empty={row.state === 'delete' ? l('账号笔记已删除', 'The account note was deleted') : undefined} l={l} />
          {row.accepted ? <DesktopNoteContent data={row.accepted} title={l('上次接收的内容', 'Previously received content')} l={l} /> : null}
        </div>
        {canDeleteAccountNote(row, preview) ? <details>
          <summary className={summaryClass}>{l('更多操作', 'More actions')}</summary>
          <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('可以从账号移除此笔记，本机原笔记与副本仍保留。', 'You can remove this note from your account. Original local notes and copies are preserved.')}</p>
          <button type="button" className={buttonClass + ' mt-2'} disabled={disabled} aria-label={l(`从账号移到废纸篓：${row.label}`, `Move to account trash: ${row.label}`)} onClick={() => props.onDeleteSelection(row.entityId)}>{l('从账号移到废纸篓', 'Move to account trash')}</button>
        </details> : null}
      </li>} />
      {!preview.incoming.length ? <p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('账号中还没有可接收的笔记。', 'There are no account notes to receive yet.')}</p> : null}
      {confirmation === 'delete' ? <div data-note-confirmation tabIndex={-1} role="group" aria-label={l('确认从账号移除笔记', 'Confirm removing an account note')} className="my-3 space-y-3 border-l-2 border-[var(--pq-accent)] pl-3 focus:outline-none">
        <p className="break-words text-sm font-medium">{l('将从账号移到废纸篓：', 'Move to account trash: ')}{deleting?.label}</p>
        <DesktopNoteContent data={deleting?.data} title={l('所选账号笔记', 'Selected account note')} l={l} />
        <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('这项更改会同步到其他设备。本机原笔记与已接收的副本都会保留。', 'This change syncs to your other devices. Original local notes and received copies are preserved.')}</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !deleting} onClick={props.onDelete}>{l('确认移到废纸篓', 'Confirm move to trash')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => props.onConfirm(null)}>{l('返回选择', 'Back to selection')}</button></div>
      </div> : null}
      {confirmation === 'adopt' ? <div data-note-confirmation tabIndex={-1} role="group" aria-label={l('确认接收笔记', 'Confirm receiving notes')} className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3 focus:outline-none">
        <p className="text-sm">{l('原本机笔记会保留。所选删除标记也不会删除本机笔记。', 'Existing local notes are preserved. Selected deletion markers do not delete local notes.')}</p>
        <ul className="max-h-36 list-disc overflow-auto pl-4 text-sm leading-6">{incoming.map(row => <li key={row.entityId} className="break-words">{row.label}{row.state === 'delete' ? l('（删除标记）', ' (deletion marker)') : ''}</li>)}</ul>
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !incoming.length || incoming.length > MAX_NOTES} onClick={props.onAdopt}>{l(`接收所选 ${incoming.length} 项`, `Receive ${incoming.length} selected items`)}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => props.onConfirm(null)}>{l('返回选择', 'Back to selection')}</button></div>
      </div> : confirmation !== 'delete' ? <button type="button" className={buttonClass + ' mt-3'} disabled={disabled || !incoming.length || incoming.length > MAX_NOTES} onClick={() => props.onConfirm('adopt')}>{l('查看接收选择', 'Review receiving selection')}</button> : null}
    </section> : null}
    {task === 'bind' ? <section aria-label={l('指定对应笔记', 'Choose matching notes')} className="space-y-3">
      <DesktopNoteContent data={localBinding?.local} title={l('选中的本机笔记', 'Selected local note')} l={l} />
      <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('请选择对应的账号笔记。标题相同也需要你核对内容；关联只建立对应关系，不修改双方正文。', 'Choose the matching account note. Review the contents even when titles match. Linking does not change either note’s content.')}</p>
      <PageRows key={preview.token} items={preview.incoming} l={l} renderRow={row => <li key={row.entityId} className="space-y-2 py-3"><label className={selectionClass}><input type="radio" name="note-account-binding" className="mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]" checked={bindingEntityId === row.entityId} disabled={disabled || !row.data || row.state === 'delete' || row.state === 'pending'} onChange={() => props.onBinding(row.entityId)} /><span className="min-w-0 break-words font-medium">{row.label}{row.state === 'delete' || row.state === 'pending' ? <span className="mt-1 block text-xs font-normal text-[var(--pq-text-muted)]">{row.state === 'delete' ? l('已删除，不能关联', 'Deleted; cannot link') : l('先处理未完成操作', 'Finish pending operations first')}</span> : null}</span></label><DesktopNoteContent data={row.data} title={l('账号中的内容', 'Account content')} l={l} /></li>} />
      {!preview.incoming.length ? <p className="text-sm text-[var(--pq-text-muted)]">{l('账号中还没有可关联的笔记。可返回并选择发送本机笔记。', 'There are no account notes to link yet. Go back and choose Send local notes.')}</p> : null}
      {confirmation === 'bind' ? <div data-note-confirmation tabIndex={-1} role="group" aria-label={l('确认关联笔记', 'Confirm linking notes')} className="space-y-3 border-l-2 border-[var(--pq-accent)] pl-3 focus:outline-none"><div className="grid min-w-0 gap-2 lg:grid-cols-2"><DesktopNoteContent data={localBinding?.local} title={l('本机笔记', 'Local note')} l={l} /><DesktopNoteContent data={accountBinding?.data} title={l('账号笔记', 'Account note')} l={l} /></div><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('本次只关联，不发送或接收正文。之后发送此本机笔记时，将更新这份账号笔记。', 'This only links the notes, without sending or receiving content. Sending this local note later will update this account note.')}</p><div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !localBinding?.local || !accountBinding} onClick={props.onBind}>{l('仅关联这两份笔记', 'Link these two notes only')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => props.onConfirm(null)}>{l('返回选择', 'Back to selection')}</button></div></div> : <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !localBinding?.local || !accountBinding} onClick={() => props.onConfirm('bind')}>{l('核对关联内容', 'Review the link')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={props.onBackToSelection}>{l('重新选择本机笔记', 'Choose another local note')}</button></div>}
    </section> : null}
    {task === 'pending' ? <>
      {preview.conflicts.length > 0 ? <section aria-label={l('选择要保留的笔记内容', 'Choose note content to keep')}><h4 className="text-sm font-medium">{l('有些笔记内容不同', 'Some note contents differ')}</h4><PageRows key={preview.token} items={preview.conflicts} l={l} renderRow={conflict => <li key={conflict.conflictId} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{conflict.label}</p><div className="grid min-w-0 gap-2 lg:grid-cols-2"><DesktopNoteContent data={conflict.current?.data} title={l('账号中的内容', 'Account content')} empty={conflict.current?.deletedAt ? l('账号笔记已删除', 'The account note was deleted') : undefined} l={l} /><DesktopNoteContent data={conflict.attempted.data} title={l('本次修改', 'This change')} empty={conflict.attempted.mutation === 'delete' ? l('这次修改将删除账号笔记', 'This change deletes the account note') : undefined} l={l} /></div><fieldset disabled={disabled} className="flex flex-wrap gap-x-4 gap-y-2"><legend className="sr-only">{l('选择要保留的内容', 'Choose which content to keep')}</legend>{(['current', 'attempted'] as const).map(choice => <label key={choice} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name={'note-conflict-' + conflict.conflictId} checked={conflictChoices[conflict.conflictId] === choice} onChange={() => props.onConflictChoice(conflict.conflictId, choice)} />{choice === 'current' ? l('保留账号内容', 'Keep account content') : conflict.attempted.mutation === 'restore' ? l('使用本次修改并恢复账号笔记', 'Use this change and restore the account note') : conflict.attempted.mutation === 'delete' ? l('应用这次删除', 'Apply this deletion') : l('使用本次修改', 'Use this change')}</label>)}</fieldset><button type="button" className={buttonClass} disabled={disabled || !conflictChoices[conflict.conflictId]} onClick={() => props.onResolve(conflict)}>{l('应用这项选择', 'Apply this choice')}</button><Diagnostics data={{ conflictId: conflict.conflictId, entityId: conflict.entityId, expectedRevision: conflict.expectedRevision, mutation: conflict.attempted.mutation }} l={l} /></li>} /></section> : null}
      {preview.pendingRows.length > 0 ? <section aria-label={l('上次未完成的操作', 'Unfinished operations')}><h4 className="text-sm font-medium">{l('上次未完成的操作', 'Unfinished operations')}</h4><PageRows key={preview.token} items={preview.pendingRows} l={l} renderRow={row => <li key={row.opId} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{row.label}</p><p className="text-sm text-[var(--pq-text-muted)]">{pendingLabel(row.stage, l)}</p><DesktopNoteContent data={row.data} title={l('上次保存的修改', 'Previously saved change')} empty={row.mutation === 'delete' ? l('请求删除账号笔记', 'Requested deletion of the account note') : undefined} l={l} /><Diagnostics data={{ opId: row.opId, entityId: row.entityId, mutation: row.mutation, stage: row.stage }} l={l} /></li>} /></section> : null}
      <PageRows key={preview.token + ':resolutions'} items={preview.pendingResolutions} l={l} renderRow={row => <li key={row.opId} className="space-y-2 py-3"><p className="text-sm font-medium">{l('上次保存的内容选择', 'Previously saved content choice')}</p><p className="text-sm text-[var(--pq-text-muted)]">{row.choice === 'current' ? l('保留账号内容', 'Keep account content') : l('使用上次修改的内容', 'Use the previously changed content')}</p><p className="text-sm text-[var(--pq-text-muted)]">{row.lastResult?.status === 'rejected' ? l('上次选择未被接受，请重新检查。', 'The last choice was rejected. Check again.') : row.lastResult?.status === 'conflict' ? l('账号内容已变化，请重新选择。', 'Account content changed. Choose again.') : l('处理结果待确认。', 'The result is unconfirmed.')}</p>{row.lastResult?.code ? <Reason code={row.lastResult.code} l={l} /> : null}<Diagnostics data={row} l={l} /></li>} />
      {!preview.conflicts.length && !preview.pendingRows.length && !preview.pendingResolutions.length ? <p className="py-3 text-sm text-[var(--pq-text-muted)]">{l('没有需要处理的未完成操作。', 'There are no unfinished operations to handle.')}</p> : null}
    </> : null}
  </div>;
}

export interface DesktopNoteExchangePanelProps {
  l: ReaderPreferencesLocalizer;
  accountActive: boolean;
  ownerKey: string | null;
}

export function DesktopNoteExchangePanel(props: DesktopNoteExchangePanelProps) {
  return <OwnedNoteExchangePanel key={`${props.accountActive}:${props.ownerKey ?? ''}`} {...props} />;
}

function OwnedNoteExchangePanel({ l, accountActive, ownerKey }: DesktopNoteExchangePanelProps) {
  const [status, setStatus] = useState<DesktopNoteExchangeStatus | null>(null);
  const [task, setTask] = useState<DesktopNoteExchangeTask | null>(null);
  const [localList, setLocalList] = useState<DesktopNoteList | null>(null);
  const [selectedLocal, setSelectedLocal] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<DesktopNoteExchangePreview | null>(null);
  const [selectedIncoming, setSelectedIncoming] = useState<string[]>([]);
  const [bindingEntityId, setBindingEntityId] = useState('');
  const [deleteEntityId, setDeleteEntityId] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [conflictChoices, setConflictChoices] = useState<Record<string, DesktopNoteConflictChoice>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const alive = useRef(false), sequence = useRef(0), reads = useRef(0);
  const operation = useRef<string | null>(null);
  const currentStatus = useRef<DesktopNoteExchangeStatus | null>(null);
  const currentView = useRef<object | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const overview = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const clearReview = useCallback(() => {
    currentView.current = null;
    setPreview(null); setSelectedIncoming([]); setBindingEntityId(''); setDeleteEntityId(''); setConfirmation(null); setRestoreConfirmed(false); setConflictChoices({});
  }, []);
  const acceptStatus = useCallback((next: DesktopNoteExchangeStatus) => {
    if (next.scopeKey !== ownerKey || next.revision !== currentStatus.current?.revision) clearReview();
    if (next.saveUnconfirmed || next.copyPending || next.errorCode) setNotice('');
    if (next.scopeKey !== ownerKey) { sequence.current += 1; operation.current = null; setWorking(null); setLocalList(null); setSelectedLocal([]); }
    currentStatus.current = next; setStatus(next);
  }, [clearReview, ownerKey]);
  const reloadStatus = useCallback(async () => {
    if (!alive.current) return;
    const request = ++reads.current;
    try { const next = await desktopNoteExchange.status(); if (alive.current && request === reads.current) acceptStatus(next); }
    catch (failure) { if (alive.current && request === reads.current) setError(errorCode(failure)); }
  }, [acceptStatus]);

  useEffect(() => {
    alive.current = true; void reloadStatus();
    let listening = true, unsubscribe: (() => void) | undefined;
    void desktopNoteExchange.onChanged(() => { void reloadStatus(); }).then(stop => { if (listening) unsubscribe = stop; else stop(); }).catch(() => { /* Initial status reports bridge errors. */ });
    return () => { listening = false; alive.current = false; sequence.current += 1; reads.current += 1; currentView.current = null; unsubscribe?.(); };
  }, [reloadStatus]);
  useEffect(() => { if (task) heading.current?.focus({ preventScroll: true }); else overview.current?.focus({ preventScroll: true }); }, [task, preview?.token]);
  useEffect(() => {
    if (confirmation) panel.current?.querySelector<HTMLElement>('[data-note-confirmation]')?.focus({ preventScroll: true });
  }, [confirmation]);

  const run = async (kind: string, action: (current: () => boolean) => Promise<void>, interrupt = false) => {
    if (!alive.current || !accountActive || !ownerKey || currentStatus.current?.scopeKey !== ownerKey || operation.current && !interrupt) return;
    const request = ++sequence.current;
    operation.current = kind; setWorking(kind); setError(null); setNotice('');
    const current = () => alive.current && request === sequence.current && currentStatus.current?.scopeKey === ownerKey;
    try { await action(current); }
    catch (failure) { if (current()) { setError(errorCode(failure)); await reloadStatus(); } }
    finally { if (alive.current && request === sequence.current) { operation.current = null; setWorking(null); } }
  };
  const loadLocal = (nextTask: 'publish' | 'bind') => run('list', async current => {
    setTask(nextTask); clearReview(); setLocalList(null); setSelectedLocal([]); setSearch('');
    const next = await desktopNoteExchange.list();
    if (current() && next.scopeKey === ownerKey) setLocalList(next);
  });
  const check = (nextTask: DesktopNoteExchangeTask, noteIds: string[]) => run('preview', async current => {
    setTask(nextTask); clearReview();
    const next = await desktopNoteExchange.preview({ noteIds });
    if (!current() || next.scopeKey !== ownerKey) return;
    const metadata = await desktopNoteExchange.status();
    if (!current() || metadata.scopeKey !== ownerKey) return;
    reads.current += 1; acceptStatus(metadata);
    if (metadata.revision === next.revision) setPreview(next); else setError('NOTE_PREVIEW_STALE');
  });
  const change = (kind: string, action: () => Promise<DesktopNoteExchangeStatus | DesktopNoteAdoptResult>, success: string, interrupt = false) => run(kind, async current => {
    clearReview();
    const next = await action();
    if (!current() || next.scopeKey !== ownerKey) return;
    reads.current += 1; acceptStatus(next);
    if ('localNoteIds' in next) for (const noteId of next.localNoteIds) emitNoteChanged({ action: 'created', noteId, sourceId: 'desktop-note-exchange' });
    if (next.errorCode) setError(next.errorCode);
    else setNotice(next.saveUnconfirmed || next.copyPending ? '' : success);
  }, interrupt);

  const sameOwner = accountActive && !!ownerKey && status?.scopeKey === ownerKey;
  const busy = !!working || !!status?.busy;
  const disabled = !sameOwner || busy || !!status?.saveUnconfirmed || !status?.supported;
  const canStop = !!status?.busy || ['preview', 'publish', 'adopt', 'bind', 'delete', 'continue', 'resolve', 'stop'].includes(working || '');
  const validPreview = preview && preview.scopeKey === ownerKey && preview.revision === status?.revision ? preview : null;
  const visibleError = error || status?.errorCode;
  const view = { task, validPreview, confirmation, restoreConfirmed, selectedIncoming, bindingEntityId, deleteEntityId, conflictChoices };
  currentView.current = view;
  const mayApply = () => currentView.current === view && !disabled && !!validPreview && currentStatus.current?.scopeKey === ownerKey && currentStatus.current.revision === validPreview.revision;
  const confirm = (value: Confirmation) => { currentView.current = null; setConfirmation(value); setRestoreConfirmed(false); };

  return <SettingsField label={l('同步笔记', 'Sync notes')} description={l('选择要做的事，再核对具体笔记。', 'Choose what to do, then review the notes.')}>
    <div ref={panel} className="space-y-3" data-desktop-note-exchange aria-busy={busy}>
      {!accountActive ? <p className="text-sm text-[var(--pq-text-muted)]">{l('先连接账号，就能在设备之间同步笔记。', 'Connect your account to sync notes across devices.')}</p> : status && !status.supported ? <p className="text-sm text-[var(--pq-text-muted)]">{l('当前账号服务尚未支持笔记同步。', 'This account service does not support note sync yet.')}</p> : !status ? <p role="status" className="text-sm text-[var(--pq-text-muted)]">{l('正在读取笔记同步状态…', 'Loading note sync status…')}</p> : null}
      {task ? <div className="space-y-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => { clearReview(); setTask(null); setNotice(''); setError(null); }}><ArrowLeft aria-hidden className="h-4 w-4" />{l('返回笔记同步', 'Back to note sync')}</button><div className="flex flex-wrap items-center justify-between gap-2"><h4 ref={heading} tabIndex={-1} className="text-sm font-medium text-[var(--pq-text)] focus:outline-none">{taskTitle(task, l)}</h4><button type="button" className={buttonClass} disabled={disabled} onClick={() => { if (task === 'publish' || task === 'bind') { if (validPreview) void check(task, selectedLocal); else void loadLocal(task); } else void check(task, []); }}><RefreshCw aria-hidden className="h-4 w-4" />{working === 'preview' || working === 'list' ? l('正在检查…', 'Checking…') : l('重新检查', 'Check again')}</button></div></div> : <div ref={overview} tabIndex={-1} className="focus:outline-none"><DesktopNoteExchangeTaskPicker disabled={disabled} l={l} onTask={value => { if (value === 'publish' || value === 'bind') void loadLocal(value); else void check(value, []); }} /></div>}
      {working ? <p role="status" className="text-sm text-[var(--pq-text-muted)]">{working === 'preview' || working === 'list' ? l('正在检查笔记，请稍候…', 'Checking notes…') : l('正在处理，请稍候…', 'Processing…')}</p> : null}
      {canStop ? <button type="button" className={buttonClass} disabled={!sameOwner || working === 'stop'} onClick={() => void change('stop', desktopNoteExchange.stop, l('已停止等待，未完成操作仍保留。', 'Waiting stopped. Unfinished operations are preserved.'), true)}><Square aria-hidden className="h-3 w-3" />{l('停止等待', 'Stop waiting')}</button> : null}
      {status?.saveUnconfirmed ? <div className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3"><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('上次同步结果还没有确认保存到本机。先保存结果，再继续同步。', 'The last sync result is not yet confirmed saved on this computer. Save the result before continuing.')}</p><button type="button" className={buttonClass} disabled={!sameOwner || busy} onClick={() => void change('save', desktopNoteExchange.retrySave, l('结果已保存到本机，可以重新检查。', 'The result is saved on this computer. Check again to continue.'))}>{l('保存同步结果', 'Save sync result')}</button><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('这一步只重试保存已有结果，不会重新发送笔记。', 'This only retries saving the existing result, without resending notes.')}</p></div> : null}
      {!!status?.copyPending ? <div className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3"><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l(`有 ${status.copyPending} 份已接收的笔记副本尚未确认保存。`, `${status.copyPending} received note copies are not yet confirmed saved.`)}</p><button type="button" className={buttonClass} disabled={!sameOwner || busy || !!status.saveUnconfirmed} onClick={() => void change('copies', desktopNoteExchange.resumeCopies, l('已接收的笔记副本已保存，可在笔记中继续编辑。', 'Received note copies are saved. Continue editing them in Notes.'))}>{l('继续保存本机副本', 'Continue saving local copies')}</button><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('只保存上次已接收的内容，不会重新接收或发送。', 'This only saves content already received, without receiving or sending it again.')}</p></div> : null}
      {visibleError && !(status?.saveUnconfirmed && visibleError === 'NOTE_SAVE_UNCONFIRMED') ? <div role="alert"><Reason code={visibleError} l={l} /></div> : null}
      {notice ? <p role="status" className="text-sm leading-6 text-[var(--pq-text-muted)]">{notice}</p> : null}
      {(task === 'publish' || task === 'bind') && !validPreview && localList?.scopeKey === ownerKey ? <DesktopNoteLocalSelection list={localList} task={task} selected={selectedLocal} search={search} disabled={disabled} l={l} onSearch={setSearch} onSelect={(id, checked) => { clearReview(); setSelectedLocal(previous => task === 'bind' ? [id] : checked ? previous.includes(id) || previous.length >= MAX_NOTES ? previous : [...previous, id] : previous.filter(value => value !== id)); }} onPreview={() => { if (!disabled && selectedLocal.length && selectedLocal.length <= (task === 'bind' ? 1 : MAX_NOTES)) void check(task, selectedLocal); }} /> : null}
      {task && validPreview ? <DesktopNoteExchangeReview task={task} preview={validPreview} disabled={disabled} selectedIncoming={selectedIncoming} bindingEntityId={bindingEntityId} deleteEntityId={deleteEntityId} confirmation={confirmation} restoreConfirmed={restoreConfirmed} conflictChoices={conflictChoices} l={l}
        onToggleIncoming={(id, checked) => { currentView.current = null; setConfirmation(null); setSelectedIncoming(previous => checked ? previous.includes(id) || previous.length >= MAX_NOTES ? previous : [...previous, id] : previous.filter(value => value !== id)); }}
        onBinding={id => { currentView.current = null; setBindingEntityId(id); setConfirmation(null); }} onConfirm={confirm}
        onRestoreConfirmed={value => { currentView.current = null; setRestoreConfirmed(value); }}
        onBackToSelection={() => { clearReview(); }}
        onPublish={() => { if (mayApply() && task === 'publish' && confirmation === 'publish' && validPreview.localRows.some(row => !['none', 'blocked'].includes(row.action)) && (!validPreview.localRows.some(row => row.action === 'restore') || restoreConfirmed)) void change('publish', () => desktopNoteExchange.publish({ token: validPreview.token }), l('已处理这批笔记的发送，可以重新检查结果。', 'This batch was processed. Check again to review the result.')); }}
        onAdopt={() => { const ids = validPreview.incoming.filter(row => row.canAccept && selectedIncoming.includes(row.entityId)).map(row => row.entityId); if (mayApply() && task === 'adopt' && confirmation === 'adopt' && ids.length && ids.length <= MAX_NOTES) void change('adopt', () => desktopNoteExchange.adopt({ token: validPreview.token, ids }), l('所选内容已接收。新副本可在笔记中继续编辑，原笔记保留。', 'Selected content was received. Edit new copies in Notes; original notes are preserved.')); }}
        onBind={() => { const local = validPreview.localRows.length === 1 ? validPreview.localRows[0] : undefined, remote = validPreview.incoming.find(row => row.entityId === bindingEntityId && row.data && !['delete', 'pending'].includes(row.state)); if (mayApply() && task === 'bind' && confirmation === 'bind' && local?.local && remote) void change('bind', () => desktopNoteExchange.bind({ token: validPreview.token, localNoteId: local.localNoteId, entityId: remote.entityId }), l('两份笔记已关联，双方正文没有修改。', 'The two notes are linked. Neither note’s content was changed.')); }}
        onDeleteSelection={id => { currentView.current = null; setDeleteEntityId(id); setConfirmation('delete'); }}
        onDelete={() => { const row = validPreview.incoming.find(item => item.entityId === deleteEntityId && canDeleteAccountNote(item, validPreview)); if (mayApply() && task === 'adopt' && confirmation === 'delete' && row) void change('delete', () => desktopNoteExchange.deleteFromAccount({ token: validPreview.token, entityId: row.entityId }), l('已处理账号笔记的移除。本机原笔记与副本仍保留，可重新检查账号结果。', 'The account removal was processed. Original local notes and copies are preserved. Check again to review the account result.')); }}
        onConflictChoice={(id, choice) => { currentView.current = null; setConflictChoices(previous => ({ ...previous, [id]: choice })); }}
        onResolve={conflict => { const choice = conflictChoices[conflict.conflictId]; if (mayApply() && task === 'pending' && choice) void change('resolve', () => desktopNoteExchange.resolve({ conflictId: conflict.conflictId, choice, expectedRevision: conflict.expectedRevision }), l('已处理这项选择，可以重新检查结果。', 'This choice was processed. Check again to review the result.')); }} /> : null}
      {task === 'pending' && !!status?.continuable && !status.saveUnconfirmed && !status.copyPending ? <div className="space-y-2 border-t border-[var(--pq-border)] pt-3"><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('继续时会先核对上次结果，再处理仍未完成的操作。', 'Continuing checks the previous result before handling unfinished operations.')}</p><button type="button" className={buttonClass} disabled={disabled || !validPreview} onClick={() => { if (mayApply()) void change('continue', desktopNoteExchange.continue, l('已继续处理，可以重新检查结果。', 'Processing continued. Check again to review the result.')); }}>{l('继续处理', 'Continue processing')}</button></div> : null}
      <details className="border-t border-[var(--pq-border)] pt-1"><summary className={summaryClass}>{l('同步详情与备份', 'Sync details and backup')}</summary>{status?.loaded ? <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--pq-text-muted)]">{[[l('已接收', 'Received'), status.accepted], [l('已关联', 'Linked'), status.bound], [l('待处理', 'Pending'), status.pending], [l('内容不同', 'Differing content'), status.conflicts]].map(([label, count]) => <div key={label} className="flex gap-2"><dt>{label}</dt><dd className="font-medium text-[var(--pq-text)]">{count}</dd></div>)}</dl> : null}<p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('同步记录按服务、账号和文库分别保存。备份包含关联与未完成操作；本机笔记和图片请随文库备份。', 'Sync records are separate for each service, account and library. This backup contains links and unfinished operations. Back up local notes and images with the library.')}</p>{validPreview ? <p className="mt-2 break-words text-xs text-[var(--pq-text-muted)]">{l('检查时间：', 'Checked: ')}{validPreview.checkedAt}</p> : null}{visibleError ? <p className="mt-2 break-all text-xs text-[var(--pq-text-muted)]">{visibleError}</p> : null}<button type="button" className={buttonClass + ' mt-3'} disabled={!sameOwner || busy || !status?.loaded && !status?.saveUnconfirmed} onClick={() => void run('export', async current => { const result = await desktopNoteExchange.exportBackup(); if (current() && result.status === 'exported') setNotice(l('笔记同步记录已导出备份。', 'The note sync record was exported.')); })}><Download aria-hidden className="h-4 w-4" />{l('导出笔记同步备份', 'Export note sync backup')}</button></details>
    </div>
  </SettingsField>;
}
