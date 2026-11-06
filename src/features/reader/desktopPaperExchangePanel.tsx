import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, BookOpen, ChevronRight, Download, RefreshCw, Square } from 'lucide-react';
import type { PaperData } from '../../../packages/sync-core/src/types';
import type { DesktopPaperMetadata, DesktopPaperOrganizationChoice } from '../../../packages/sync-core/src/desktopPaperState';
import { LIBRARY_CONTENT_CHANGED_EVENT } from '../../services/radar';
import {
  desktopPaperExchange, type DesktopPaperAdoptResult, type DesktopPaperAdoption, type DesktopPaperConflictChoice,
  type DesktopPaperExchangePreview, type DesktopPaperExchangeStatus, type DesktopPaperList, type DesktopPaperLocalRow,
} from '../../services/desktopPaperExchange';
import { SettingsField, SettingsInput, SettingsSelect } from './readerPreferencesPrimitives';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

const buttonClass = 'pq-button inline-flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';
const summaryClass = 'min-h-11 cursor-pointer py-3 text-sm font-medium text-[var(--pq-text)]';
const selectionClass = 'flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm';
const inputClass = 'mt-1 h-4 w-4 shrink-0 accent-[var(--pq-accent)]';
const MAX_PAPERS = 16, PAGE_SIZE = 8;
export type DesktopPaperTask = 'publish' | 'adopt' | 'organization' | 'pending';
type Confirmation = { kind: 'publish' | 'adopt' } | { kind: 'restore'; adoptionId: string } | null;
type OrganizationDraft = { readingStatus: 'unread' | 'reading' | 'read'; queued: boolean; collections: string };

function errorCode(error: unknown): string {
  const value = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  return value.match(/\b[A-Z][A-Z_]{3,70}\b/)?.[0] || 'PAPER_EXCHANGE_FAILED';
}
function reasonLabel(code: string, l: ReaderPreferencesLocalizer): string {
  const labels: Record<string, [string, string]> = {
    PAPER_FEATURE_UNAVAILABLE: ['当前账号服务尚未支持题录同步。', 'This account service does not support paper detail sync yet.'],
    PAPER_ORGANIZATION_UNAVAILABLE: ['当前账号服务尚未支持阅读安排，请联系管理员更新服务。', 'This account service does not support reading plans yet. Ask the administrator to update it.'],
    PAPER_BINDING_REQUIRED: ['先在文件共享中关联对应文献，再同步题录。', 'Link the matching paper under file access before syncing its details.'],
    PAPER_BINDING_CHANGED: ['文献关联已变化，请重新选择并核对。', 'The paper link changed. Select and review it again.'],
    PAPER_BINDING_CONFLICT: ['文献的对应关系不唯一，请先核对已有的文件关联。', 'The paper link is ambiguous. Check existing file links first.'],
    PAPER_PREVIEW_STALE: ['内容预览已过期，请重新检查。', 'This preview expired. Check again.'],
    PAPER_SOURCE_CHANGED: ['本机文献已有后续修改，操作已停止。请重新检查，保留当前修改。', 'The local paper was edited later. The operation stopped. Check again and preserve the current edits.'],
    PAPER_ORGANIZATION_CHANGED: ['本机阅读安排已有后续修改，操作已停止。请重新检查。', 'The local reading plan changed later. The operation stopped. Check again.'],
    PAPER_REMOTE_UNAVAILABLE: ['这份账号文献当前不可用或已删除。本机文献保留。', 'This account paper is unavailable or deleted. The local paper is preserved.'],
    PAPER_LOCAL_UNAVAILABLE: ['这份本机文献当前无法读取，请先检查文库。', 'This local paper cannot be read. Check the library first.'],
    PAPER_SOURCE_UNSUPPORTED: ['这份题录暂不能完整交换，请先检查文献内容。', 'These paper details cannot be exchanged completely yet. Check the paper first.'],
    PAPER_PENDING: ['先处理这份文献的未完成操作，再继续同步。', 'Finish this paper’s pending operations before syncing again.'],
    PAPER_ADOPTION_UNCONFIRMED: ['上次接收或撤销尚未确认保存，请继续保存到本机。', 'The last receipt or undo is not confirmed saved. Continue saving it locally.'],
    PAPER_SAVE_UNCONFIRMED: ['同步结果尚未确认保存到本机。请先保存同步结果。', 'The sync result is not confirmed saved locally. Save the sync result first.'],
    PAPER_SCOPE_CHANGED: ['账号、服务或文库已变化，请重新检查。', 'The account, service or library changed. Check again.'],
    PAPER_STORAGE_CHANGED: ['本机同步记录已变化，尚未被覆盖。请先导出备份并检查存储。', 'The local sync record changed and was not overwritten. Export a backup and check storage.'],
    PAPER_CONFLICT_CHANGED: ['待处理的内容已变化，请重新检查后选择。', 'The content to resolve changed. Check again before choosing.'],
    PAPER_STATE_INVALID: ['题录同步记录无法读取，请保留原文件并检查本机存储。', 'The paper sync record cannot be read. Preserve the original file and check local storage.'],
    PAPER_STATE_FULL: ['同步记录已达到容量限制，请先导出备份。', 'The sync record reached its capacity limit. Export a backup first.'],
    PAPER_LIMIT: ['本次内容超过容量限制，请减少选择数量。', 'This content exceeds the limit. Select fewer papers.'],
    PAPER_SELECTION_INVALID: ['本次选择无效，请重新选择，单次最多 16 份。', 'This selection is invalid. Select up to 16 papers at a time.'],
    PAPER_ORGANIZATION_INVALID: ['阅读安排无效，请检查分类名称后再保存。', 'The reading plan is invalid. Check its collection names before saving.'],
    AUTHENTICATION_REQUIRED: ['请先连接账号。', 'Connect your account first.'],
    AUTH_SESSION_CHANGED: ['登录身份已变化，请确认当前账号。', 'The signed-in identity changed. Check the current account.'],
    DESKTOP_LIBRARY_CHANGED: ['文库已变化，请重新选择文献。', 'The library changed. Select the papers again.'],
    DESKTOP_OPERATION_CANCELLED: ['已停止等待，未完成操作仍保留。', 'Waiting stopped. Unfinished operations are preserved.'],
    REVISION_MISMATCH: ['账号内容已有更新，请重新检查。', 'Account content changed. Check again.'],
  };
  const label = labels[code];
  return label ? l(...label) : l('本次操作未完成。请查看同步详情，保留当前记录后重新检查。', 'This operation did not complete. Review sync details, preserve the current record and check again.');
}
function Reason({ code, l }: { code: string; l: ReaderPreferencesLocalizer }) {
  return <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{reasonLabel(code, l)}</p>;
}
function Diagnostics({ data, l }: { data: unknown; l: ReaderPreferencesLocalizer }) {
  return <details><summary className={summaryClass}>{l('诊断记录', 'Diagnostic record')}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--pq-surface-2)] p-3 text-xs">{JSON.stringify(data, null, 2)}</pre></details>;
}
function readingLabel(value: string, l: ReaderPreferencesLocalizer): string {
  return value === 'read' ? l('已读', 'Read') : value === 'reading' ? l('在读', 'Reading') : l('未读', 'Unread');
}
type DisplayValue = string | string[] | null;
type DisplayField = { key: string; label: string; value: DisplayValue; long?: boolean };
function fields(data: PaperData | DesktopPaperMetadata | null, organization: DesktopPaperOrganizationChoice | null | undefined, l: ReaderPreferencesLocalizer): DisplayField[] {
  const metadata = data && 'isFavorite' in data ? data : null;
  const paper = data && !('isFavorite' in data) ? data : null;
  const org = organization === undefined ? paper?.organization : organization;
  const favorite = metadata?.isFavorite ?? paper?.organization?.favorite;
  const values: DisplayField[] = [
    { key: 'title', label: l('题名', 'Title'), value: data?.title || null },
    { key: 'authors', label: l('作者', 'Authors'), value: metadata ? metadata.authors.map(row => row.name) : paper?.authors ?? null },
    { key: 'year', label: l('年份', 'Year'), value: data?.year ?? null },
    { key: 'publication', label: l('刊物', 'Publication'), value: data?.publication ?? null },
    { key: 'doi', label: 'DOI', value: data?.doi ?? null },
    { key: 'abstractText', label: l('摘要', 'Abstract'), value: data?.abstractText ?? null, long: true },
    { key: 'keywords', label: l('关键词', 'Keywords'), value: data?.keywords ?? null },
    { key: 'favorite', label: l('收藏', 'Favorite'), value: favorite === undefined ? null : favorite ? l('已收藏', 'Favorite') : l('未收藏', 'Not a favorite') },
    { key: 'tags', label: l('标签', 'Tags'), value: metadata ? metadata.tags.map(row => row.name) : paper?.organization?.tags ?? null },
    { key: 'readingStatus', label: metadata ? l('本机阅读草稿：状态', 'Local reading draft: status') : l('阅读状态', 'Reading status'), value: org ? readingLabel(org.readingStatus, l) : metadata ? l('无本机草稿，使用账号安排', 'No local draft; use the account plan') : null },
    { key: 'queued', label: metadata ? l('本机阅读草稿：清单', 'Local reading draft: list') : l('阅读清单', 'Reading list'), value: org ? org.queueRank === null ? l('不在清单中', 'Not on the list') : l('已加入清单', 'On the list') : metadata ? l('无本机草稿，使用账号安排', 'No local draft; use the account plan') : null },
    { key: 'collections', label: metadata ? l('本机阅读草稿：分类名称', 'Local reading draft: collection names') : l('账号分类名称', 'Account collection names'), value: org?.collections ?? (metadata ? l('无本机草稿，使用账号安排', 'No local draft; use the account plan') : null) },
  ];
  if (metadata) {
    values.push({ key: 'authorDetails', label: l('作者姓名信息', 'Author name details'), value: metadata.authors.map(row => [row.name, row.givenName && l('名：', 'Given: ') + row.givenName, row.familyName && l('姓：', 'Family: ') + row.familyName].filter(Boolean).join(' / ')) });
    values.push({ key: 'tagColors', label: l('标签颜色', 'Tag colors'), value: metadata.tags.map(row => row.name + (row.color ? ' (' + row.color + ')' : '')) });
    values.push({ key: 'updatedAt', label: l('保存时间', 'Saved at'), value: new Date(metadata.updatedAt).toLocaleString() });
  }
  return values;
}
function FieldValue({ value, long, l }: { value: DisplayValue; long?: boolean; l: ReaderPreferencesLocalizer }) {
  if (value === null || value === '' || Array.isArray(value) && !value.length) return <span className="text-[var(--pq-text-muted)]">{l('未设置', 'Not set')}</span>;
  const content = Array.isArray(value) ? <ul className="space-y-1">{value.map((entry, index) => <li key={index}>{entry}</li>)}</ul> : value;
  return <div className={'min-w-0 whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]' + (long ? ' max-h-40 overflow-y-auto' : '')}>
    {Array.isArray(value) && value.length > 4 ? <details><summary className={summaryClass}>{l(`查看全部 ${value.length} 项`, `View all ${value.length} items`)}</summary>{content}</details> : content}
  </div>;
}
/** Display only the actual exchanged whitelist. Internal IDs remain in diagnostics. */
export function DesktopPaperDiff({ before, after, beforeOrganization, afterOrganization, beforeLabel, afterLabel, l }: {
  before: PaperData | DesktopPaperMetadata | null; after: PaperData | DesktopPaperMetadata | null;
  beforeOrganization?: DesktopPaperOrganizationChoice | null; afterOrganization?: DesktopPaperOrganizationChoice | null;
  beforeLabel: string; afterLabel: string; l: ReaderPreferencesLocalizer;
}) {
  const left = fields(before, beforeOrganization, l), right = fields(after, afterOrganization, l);
  const changed = right.filter((row, index) => JSON.stringify(row.value) !== JSON.stringify(left[index]?.value));
  const unchanged = right.filter((row, index) => JSON.stringify(row.value) === JSON.stringify(left[index]?.value));
  const render = (row: DisplayField) => <div key={row.key} className="space-y-2 border-b border-[var(--pq-border)] py-3 last:border-b-0" data-paper-field={row.key}>
    <h6 className="text-sm font-medium">{row.label}</h6><div className="grid min-w-0 gap-3 md:grid-cols-2">
      {[{ title: beforeLabel, value: left.find(item => item.key === row.key)?.value ?? null }, { title: afterLabel, value: row.value }].map((side, index) => <div key={index} className="min-w-0 rounded-lg bg-[var(--pq-surface-2)] px-3 py-2 text-sm"><p className="mb-1 text-xs text-[var(--pq-text-muted)]">{side.title}</p><FieldValue value={side.value} long={row.long} l={l} /></div>)}
    </div></div>;
  return <div className="min-w-0" data-paper-diff>{changed.length ? changed.map(render) : <p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('可见题录与阅读安排没有变化。', 'Visible paper details and reading plans are unchanged.')}</p>}
    {unchanged.length ? <details><summary className={summaryClass}>{l(`查看未变化的 ${unchanged.length} 项`, `View ${unchanged.length} unchanged fields`)}</summary>{unchanged.map(render)}</details> : null}
  </div>;
}
function PageRows<T>({ items, renderRow, l }: { items: T[]; renderRow: (item: T) => ReactNode; l: ReaderPreferencesLocalizer }) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return <><ul className="min-w-0 divide-y divide-[var(--pq-border)]">{items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(renderRow)}</ul>{pages > 1 ? <div className="flex flex-wrap items-center gap-2"><button type="button" className={buttonClass} disabled={!current} onClick={() => setPage(current - 1)}>{l('上一页', 'Previous')}</button><span className="text-xs text-[var(--pq-text-muted)]">{l(`第 ${current + 1} / ${pages} 页`, `Page ${current + 1} of ${pages}`)}</span><button type="button" className={buttonClass} disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>{l('下一页', 'Next')}</button></div> : null}</>;
}
function taskTitle(task: DesktopPaperTask, l: ReaderPreferencesLocalizer): string {
  return { publish: l('发送本机修改', 'Send local changes'), adopt: l('接收账号修改', 'Receive account changes'), organization: l('安排阅读', 'Plan reading'), pending: l('查看未完成操作', 'View unfinished operations') }[task];
}
export function DesktopPaperTaskPicker({ disabled, onTask, l }: { disabled: boolean; onTask: (task: DesktopPaperTask) => void; l: ReaderPreferencesLocalizer }) {
  const tasks = [
    { key: 'publish' as const, icon: ArrowUpFromLine, detail: l('选择文献，核对要发送的题录与阅读安排', 'Select papers and review the details and reading plans to send') },
    { key: 'adopt' as const, icon: ArrowDownToLine, detail: l('逐项核对，再保存到本机文库', 'Review each change before saving it to this library') },
    { key: 'organization' as const, icon: BookOpen, detail: l('设置阅读状态、清单与账号分类', 'Set reading status, the reading list and account collections') },
    { key: 'pending' as const, icon: RefreshCw, detail: l('继续上次操作，处理不同内容或撤销接收', 'Continue previous work, resolve differences or undo a receipt') },
  ];
  return <nav aria-label={l('题录同步任务', 'Paper sync tasks')} className="divide-y divide-[var(--pq-border)] overflow-hidden rounded-xl border border-[var(--pq-border)]">{tasks.map(item => <button key={item.key} type="button" data-paper-task={item.key} className="flex min-h-20 w-full items-center gap-3 p-4 text-left hover:bg-[var(--pq-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--pq-accent)] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => onTask(item.key)}><item.icon aria-hidden className="h-5 w-5 shrink-0 text-[var(--pq-accent)]" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{taskTitle(item.key, l)}</span><span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{item.detail}</span></span><ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--pq-text-faint)]" /></button>)}</nav>;
}
function LocalSelection({ list, task, selected, search, disabled, onSearch, onSelect, onPreview, onLinkPapers, l }: {
  list: DesktopPaperList; task: 'publish' | 'organization'; selected: string[]; search: string; disabled: boolean;
  onSearch: (value: string) => void; onSelect: (id: string, checked: boolean) => void; onPreview: () => void; onLinkPapers?: () => void; l: ReaderPreferencesLocalizer;
}) {
  const rows = list.papers.filter(row => row.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="space-y-3"><SettingsInput className="min-h-11" type="search" aria-label={l('搜索本机文献', 'Search local papers')} placeholder={l('按题名搜索', 'Search by title')} value={search} disabled={disabled} onChange={event => onSearch(event.target.value)} />
    <p className="text-xs text-[var(--pq-text-muted)]">{task === 'publish' ? l(`已选择 ${selected.length} 份，每次最多 16 份。`, `${selected.length} selected. Up to 16 papers at a time.`) : l('选择一份文献安排阅读。', 'Choose one paper to plan reading.')}</p>
    {!rows.length ? <p className="text-sm text-[var(--pq-text-muted)]">{l('没有找到相符的文献。', 'No matching papers found.')}</p> : <PageRows key={search} items={rows} l={l} renderRow={row => <li key={row.localPaperId} className="py-1"><label className={selectionClass}><input type={task === 'publish' ? 'checkbox' : 'radio'} name="paper-local-selection" className={inputClass} checked={selected.includes(row.localPaperId)} disabled={disabled || !row.boundEntityId || task === 'publish' && !selected.includes(row.localPaperId) && selected.length >= MAX_PAPERS} onChange={event => onSelect(row.localPaperId, event.target.checked)} /><span className="min-w-0 break-words"><span className="font-medium">{row.title || l('未命名文献', 'Untitled paper')}</span>{!row.boundEntityId ? <span className="mt-1 block text-xs leading-5 text-[var(--pq-text-muted)]">{l('尚未关联账号文献，请先在文件共享中关联。', 'Not linked to an account paper. Link it under file access first.')}</span> : null}</span></label></li>} />}
    <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !selected.length} onClick={onPreview}>{task === 'publish' ? l('查看发送内容', 'Review what to send') : l('检查阅读安排', 'Review reading plan')}</button>{list.papers.some(row => !row.boundEntityId) && onLinkPapers ? <button type="button" className={buttonClass} disabled={disabled} onClick={onLinkPapers}>{l('去关联文献', 'Link papers')}</button> : null}</div>
  </div>;
}
function AdoptionDiff({ row, reverse = false, l }: { row: DesktopPaperAdoption; reverse?: boolean; l: ReaderPreferencesLocalizer }) {
  return <DesktopPaperDiff before={reverse ? row.after : row.before} after={reverse ? row.before : row.after} beforeOrganization={reverse ? row.afterOrganization : row.beforeOrganization} afterOrganization={reverse ? row.beforeOrganization : row.afterOrganization} beforeLabel={reverse ? l('这次接收保存的内容', 'Content saved by this receipt') : l('接收前', 'Before receiving')} afterLabel={reverse ? l('撤销后恢复的内容', 'Content restored by undo') : l('接收后', 'After receiving')} l={l} />;
}
function OrganizationEditor({ row, draft, disabled, onChange, onSave, l }: { row: DesktopPaperLocalRow; draft: OrganizationDraft; disabled: boolean; onChange: (value: OrganizationDraft) => void; onSave: () => void; l: ReaderPreferencesLocalizer }) {
  return <div className="space-y-3"><h5 className="break-words text-sm font-medium">{row.label}</h5>
    <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{row.organizationSource === 'desktop-choice' ? l('正在编辑此账号的本机阅读草稿。', 'Editing the local reading draft for this account.') : row.organizationSource === 'account' ? l('以账号中的阅读安排为起点。', 'Starting from the account reading plan.') : l('这是新建的阅读安排，未读是初始值。', 'This is a new reading plan. Unread is the initial value.')}</p>
    <label className="grid gap-1 text-sm">{l('阅读状态', 'Reading status')}<SettingsSelect className="min-h-11" aria-label={l('阅读状态', 'Reading status')} value={draft.readingStatus} disabled={disabled} onChange={event => onChange({ ...draft, readingStatus: event.target.value as OrganizationDraft['readingStatus'] })}><option value="unread">{l('未读', 'Unread')}</option><option value="reading">{l('在读', 'Reading')}</option><option value="read">{l('已读', 'Read')}</option></SettingsSelect></label>
    <label className={selectionClass}><input type="checkbox" className={inputClass} checked={draft.queued} disabled={disabled} onChange={event => onChange({ ...draft, queued: event.target.checked })} /><span>{l('加入阅读清单', 'Add to reading list')}</span></label>
    <label className="grid gap-1 text-sm">{l('账号分类名称，每行一个', 'Account collection names, one per line')}<textarea aria-label={l('账号分类名称', 'Account collection names')} className="min-h-28 w-full resize-y rounded-xl border border-[var(--pq-border)] bg-[var(--pq-surface-1)] px-3 py-2 text-sm text-[var(--pq-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--pq-accent)]" rows={3} value={draft.collections} maxLength={8192} disabled={disabled} onChange={event => onChange({ ...draft, collections: event.target.value })} /></label>
    <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('账号分类名称不改本机分类层级。阅读状态单独设置，不从阅读页位置推断。', 'Account collection names do not change local category hierarchies. Reading status is set independently of the reading position.')}</p>
    <button type="button" className={buttonClass} disabled={disabled} onClick={onSave}>{l('保存本机阅读安排', 'Save local reading plan')}</button>
  </div>;
}

export interface DesktopPaperExchangePanelProps { l: ReaderPreferencesLocalizer; accountActive: boolean; ownerKey: string | null; onLinkPapers?: () => void }
export function DesktopPaperExchangePanel(props: DesktopPaperExchangePanelProps) {
  return <OwnedPaperExchangePanel key={`${props.accountActive}:${props.ownerKey ?? ''}`} {...props} />;
}
function OwnedPaperExchangePanel({ l, accountActive, ownerKey, onLinkPapers }: DesktopPaperExchangePanelProps) {
  const [status, setStatus] = useState<DesktopPaperExchangeStatus | null>(null);
  const [task, setTask] = useState<DesktopPaperTask | null>(null);
  const [localList, setLocalList] = useState<DesktopPaperList | null>(null);
  const [selectedLocal, setSelectedLocal] = useState<string[]>([]), [search, setSearch] = useState('');
  const [preview, setPreview] = useState<DesktopPaperExchangePreview | null>(null);
  const [selectedIncoming, setSelectedIncoming] = useState<string[]>([]), [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [draft, setDraft] = useState<OrganizationDraft | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Record<string, DesktopPaperConflictChoice>>({});
  const [working, setWorking] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const alive = useRef(false), sequence = useRef(0), reads = useRef(0), operation = useRef<string | null>(null);
  const currentStatus = useRef<DesktopPaperExchangeStatus | null>(null), currentView = useRef<object | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), overview = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
  const clearReview = useCallback(() => { currentView.current = null; setPreview(null); setSelectedIncoming([]); setConfirmation(null); setDraft(null); setConflictChoices({}); }, []);
  const acceptStatus = useCallback((next: DesktopPaperExchangeStatus) => {
    if (next.scopeKey !== ownerKey || next.revision !== currentStatus.current?.revision) clearReview();
    if (next.saveUnconfirmed || next.adoptionPending || next.errorCode) setNotice('');
    if (next.scopeKey !== ownerKey) { sequence.current++; operation.current = null; setWorking(null); setLocalList(null); setSelectedLocal([]); }
    currentStatus.current = next; setStatus(next);
  }, [clearReview, ownerKey]);
  const reloadStatus = useCallback(async () => {
    if (!alive.current) return;
    const request = ++reads.current;
    try { const next = await desktopPaperExchange.status(); if (alive.current && request === reads.current) acceptStatus(next); }
    catch (failure) { if (alive.current && request === reads.current) setError(errorCode(failure)); }
  }, [acceptStatus]);
  useEffect(() => {
    alive.current = true; void reloadStatus(); let listening = true, unsubscribe: (() => void) | undefined;
    void desktopPaperExchange.onChanged(() => { void reloadStatus(); }).then(stop => { if (listening) unsubscribe = stop; else stop(); }).catch(() => { /* Initial status reports bridge failures. */ });
    return () => { listening = false; alive.current = false; sequence.current++; reads.current++; currentView.current = null; unsubscribe?.(); };
  }, [reloadStatus]);
  useEffect(() => { if (task) heading.current?.focus({ preventScroll: true }); else overview.current?.focus({ preventScroll: true }); }, [task, preview?.token]);
  useEffect(() => { if (confirmation) panel.current?.querySelector<HTMLElement>('[data-paper-confirmation]')?.focus({ preventScroll: true }); }, [confirmation]);
  const run = async (kind: string, action: (current: () => boolean) => Promise<void>, interrupt = false) => {
    if (!alive.current || !accountActive || !ownerKey || currentStatus.current?.scopeKey !== ownerKey || operation.current && !interrupt) return;
    const request = ++sequence.current; operation.current = kind; setWorking(kind); setError(null); setNotice('');
    const current = () => alive.current && request === sequence.current && currentStatus.current?.scopeKey === ownerKey;
    try { await action(current); }
    catch (failure) { if (current()) { setError(errorCode(failure)); await reloadStatus(); } }
    finally { if (alive.current && request === sequence.current) { operation.current = null; setWorking(null); } }
  };
  const loadLocal = (nextTask: 'publish' | 'organization') => run('list', async current => {
    setTask(nextTask); clearReview(); setLocalList(null); setSelectedLocal([]); setSearch('');
    const next = await desktopPaperExchange.list(); if (current() && next.scopeKey === ownerKey) setLocalList(next);
  });
  const check = (nextTask: DesktopPaperTask, localPaperIds: string[]) => run('preview', async current => {
    setTask(nextTask); clearReview();
    const next = await desktopPaperExchange.preview({ localPaperIds }); if (!current() || next.scopeKey !== ownerKey) return;
    const metadata = await desktopPaperExchange.status(); if (!current() || metadata.scopeKey !== ownerKey) return;
    reads.current++; acceptStatus(metadata);
    if (metadata.revision !== next.revision) { setError('PAPER_PREVIEW_STALE'); return; }
    setPreview(next);
    const row = next.localRows[0];
    if (nextTask === 'organization' && next.localRows.length === 1 && row.local?.organization) {
      const value = row.local.organization; setDraft({ readingStatus: value.readingStatus, queued: value.queueRank !== null, collections: value.collections.join('\n') });
    }
  });
  const change = (kind: string, action: () => Promise<DesktopPaperExchangeStatus | DesktopPaperAdoptResult>, success: string, interrupt = false) => run(kind, async current => {
    clearReview(); const next = await action(); if (!current() || next.scopeKey !== ownerKey) return;
    reads.current++; acceptStatus(next);
    if ('localPaperIds' in next && next.localPaperIds.length) window.dispatchEvent(new CustomEvent(LIBRARY_CONTENT_CHANGED_EVENT));
    if (next.errorCode) setError(next.errorCode); else setNotice(next.saveUnconfirmed || next.adoptionPending ? '' : success);
  }, interrupt);
  const sameOwner = accountActive && !!ownerKey && status?.scopeKey === ownerKey;
  const busy = !!working || !!status?.busy, disabled = !sameOwner || busy || !!status?.saveUnconfirmed || !status?.supported;
  const validPreview = preview && preview.scopeKey === ownerKey && preview.revision === status?.revision ? preview : null;
  const visibleError = error || status?.errorCode;
  const view = { task, validPreview, confirmation, selectedIncoming, conflictChoices, draft, status }; currentView.current = view;
  const mayUseStatus = () => currentView.current === view && !!sameOwner && !busy && currentStatus.current?.revision === status?.revision;
  const mayApply = () => mayUseStatus() && !disabled && !!validPreview;
  const confirm = (value: Confirmation) => { currentView.current = null; setConfirmation(value); };
  const executable = validPreview?.localRows.filter(row => row.action === 'update') || [];
  const receiving = validPreview?.incoming.filter(row => row.canAccept && selectedIncoming.includes(row.entityId)) || [];
  const restoring = confirmation?.kind === 'restore' ? validPreview?.adoptions.find(row => row.adoptionId === confirmation.adoptionId && row.phase === 'applied') : null;
  const organizationRow = validPreview?.localRows.length === 1 ? validPreview.localRows[0] : null;
  const canStop = !!status?.busy || ['preview', 'publish', 'adopt', 'organization', 'restore', 'continue', 'resolve', 'stop'].includes(working || '');
  const diff = (before: PaperData | null, after: PaperData | null, sending: boolean) => <DesktopPaperDiff before={before} after={after} beforeLabel={sending ? l('账号当前', 'Current account') : l('本机当前', 'Current local')} afterLabel={sending ? l('发送后', 'After sending') : l('接收后', 'After receiving')} l={l} />;
  // Legacy account records without organization leave local favorites, tags and plans intact.
  const receivedData = (row: DesktopPaperExchangePreview['incoming'][number]): PaperData | null => row.data && !row.data.organization && row.local?.organization ? { ...row.data, organization: row.local.organization } : row.data;
  return <SettingsField label={l('题录与阅读安排', 'Paper details and reading plans')} description={l('选择一项任务，再核对具体修改。', 'Choose a task, then review the specific changes.')}>
    <div ref={panel} className="space-y-3" data-desktop-paper-exchange aria-busy={busy}>
      {!accountActive ? <p className="text-sm text-[var(--pq-text-muted)]">{l('先连接账号，再同步题录与阅读安排。', 'Connect your account to sync paper details and reading plans.')}</p> : status && !status.supported ? <Reason code="PAPER_FEATURE_UNAVAILABLE" l={l} /> : !status ? <p role="status" className="text-sm">{l('正在读取题录同步状态…', 'Loading paper sync status…')}</p> : null}
      {task ? <div className="space-y-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => { clearReview(); setTask(null); setNotice(''); setError(null); }}><ArrowLeft aria-hidden className="h-4 w-4" />{l('返回题录同步', 'Back to paper sync')}</button><div className="flex flex-wrap items-center justify-between gap-2"><h4 ref={heading} tabIndex={-1} className="text-sm font-medium focus:outline-none">{taskTitle(task, l)}</h4><button type="button" className={buttonClass} disabled={disabled} onClick={() => { if (task === 'publish' || task === 'organization') { if (validPreview) void check(task, selectedLocal); else void loadLocal(task); } else void check(task, []); }}><RefreshCw aria-hidden className="h-4 w-4" />{l('重新检查', 'Check again')}</button></div></div> : <div ref={overview} tabIndex={-1} className="focus:outline-none"><DesktopPaperTaskPicker disabled={disabled} l={l} onTask={value => { if (value === 'publish' || value === 'organization') void loadLocal(value); else void check(value, []); }} /></div>}
      {working ? <p role="status" className="text-sm text-[var(--pq-text-muted)]">{working === 'list' || working === 'preview' ? l('正在检查文献…', 'Checking papers…') : l('正在处理…', 'Processing…')}</p> : null}
      {canStop ? <button type="button" className={buttonClass} disabled={!sameOwner || working === 'stop'} onClick={() => void change('stop', desktopPaperExchange.stop, l('已停止等待，未完成操作仍保留。', 'Waiting stopped. Unfinished operations are preserved.'), true)}><Square aria-hidden className="h-3 w-3" />{l('停止等待', 'Stop waiting')}</button> : null}
      {status?.saveUnconfirmed ? <div className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3"><p className="text-sm leading-6">{l('上次同步结果尚未确认保存。先保存已有结果，再继续操作。', 'The last sync result is not confirmed saved. Save the existing result before continuing.')}</p><button type="button" className={buttonClass} disabled={!sameOwner || busy} onClick={() => { if (mayUseStatus()) void change('save', desktopPaperExchange.retrySave, l('同步结果已保存，可以重新检查。', 'The sync result was saved. Check again to continue.')); }}>{l('保存同步结果', 'Save sync result')}</button><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('只保存已有结果，不重新发送。', 'Only saves the existing result without resending.')}</p></div> : null}
      {!!status?.adoptionPending ? <div className="space-y-2 border-l-2 border-[var(--pq-accent)] pl-3"><p className="text-sm leading-6">{l(`有 ${status.adoptionPending} 项接收或撤销尚未确认保存。`, `${status.adoptionPending} receipt or undo operations are not confirmed saved.`)}</p><button type="button" className={buttonClass} disabled={!sameOwner || busy || status.saveUnconfirmed} onClick={() => { if (mayUseStatus() && !status.saveUnconfirmed) void change('adoptions', desktopPaperExchange.resumeAdoptions, l('上次接收或撤销已保存到本机文库。', 'The previous receipt or undo was saved to this library.')); }}>{l('继续保存到本机', 'Continue saving locally')}</button><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('只继续保存上次接收或撤销，不重新拉取或发送。', 'Only continues saving the previous receipt or undo, without fetching or sending again.')}</p></div> : null}
      {visibleError && !(status?.saveUnconfirmed && visibleError === 'PAPER_SAVE_UNCONFIRMED') ? <div role="alert"><Reason code={visibleError} l={l} /></div> : null}
      {notice ? <p role="status" className="text-sm leading-6 text-[var(--pq-text-muted)]">{notice}</p> : null}
      {(task === 'publish' || task === 'organization') && !validPreview && localList?.scopeKey === ownerKey ? <LocalSelection list={localList} task={task} selected={selectedLocal} search={search} disabled={disabled} l={l} onLinkPapers={onLinkPapers} onSearch={setSearch} onSelect={(id, checked) => { clearReview(); setSelectedLocal(previous => task === 'organization' ? [id] : checked ? previous.includes(id) || previous.length >= MAX_PAPERS ? previous : [...previous, id] : previous.filter(value => value !== id)); }} onPreview={() => { if (!disabled && selectedLocal.length && selectedLocal.length <= (task === 'organization' ? 1 : MAX_PAPERS)) void check(task, selectedLocal); }} /> : null}
      {validPreview && task === 'publish' ? <div className="space-y-3" data-paper-review>
        <PageRows key={validPreview.token + String(confirmation?.kind)} items={confirmation?.kind === 'publish' ? executable : validPreview.localRows} l={l} renderRow={row => <li key={row.key} className="space-y-2 py-3"><h5 className="break-words text-sm font-medium">{row.label}</h5><p className="text-xs text-[var(--pq-text-muted)]">{row.action === 'update' ? l('将更新账号内容', 'Will update account content') : row.action === 'none' ? l('内容相同，无需发送', 'Unchanged; nothing to send') : l('暂不能发送', 'Cannot send yet')}</p>{diff(row.remote, row.local, true)}{row.reason ? <Reason code={row.reason} l={l} /> : null}</li>} />
        {confirmation?.kind === 'publish' ? <div data-paper-confirmation tabIndex={-1} role="group" aria-label={l('确认发送题录', 'Confirm sending paper details')} className="space-y-3 border-l-2 border-[var(--pq-accent)] pl-3 focus:outline-none"><p className="text-sm leading-6">{l(`将发送上面 ${executable.length} 份文献的修改。`, `Send the changes to the ${executable.length} papers shown above.`)}</p><div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !executable.length} onClick={() => { if (mayApply() && confirmation.kind === 'publish' && executable.length) void change('publish', () => desktopPaperExchange.publish({ token: validPreview.token }), l('已处理这批修改的发送，可以重新检查结果。', 'This batch was processed. Check again to review the result.')); }}>{l(`发送这 ${executable.length} 份修改`, `Send these ${executable.length} changes`)}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => confirm(null)}>{l('返回查看', 'Back to review')}</button></div></div> : <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !executable.length} onClick={() => confirm({ kind: 'publish' })}>{l('继续发送', 'Continue to send')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={clearReview}>{l('重新选择文献', 'Choose papers again')}</button></div>}
      </div> : null}
      {validPreview && task === 'adopt' ? <div className="space-y-3" data-paper-review>
        <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('接收会更新本机题录、标签和收藏。账号阅读安排单独保存；PDF、分类层级和阅读页位置保留。', 'Receiving updates local paper details, tags and favorites. Account reading plans are stored separately; PDFs, category hierarchies and reading positions are preserved.')}</p>
        {!validPreview.incoming.length ? <p className="text-sm">{l('账号中没有可查看的文献。', 'There are no account papers to review.')}</p> : <PageRows key={validPreview.token + String(confirmation?.kind)} items={confirmation?.kind === 'adopt' ? receiving : validPreview.incoming} l={l} renderRow={row => <li key={row.entityId} className="space-y-2 py-3">{confirmation?.kind === 'adopt' ? <h5 className="break-words text-sm font-medium">{row.label}</h5> : <label className={selectionClass}><input type="checkbox" className={inputClass} checked={selectedIncoming.includes(row.entityId)} disabled={disabled || !row.canAccept || !selectedIncoming.includes(row.entityId) && selectedIncoming.length >= MAX_PAPERS} onChange={event => { currentView.current = null; setConfirmation(null); setSelectedIncoming(previous => event.target.checked ? [...new Set([...previous, row.entityId])].slice(0, MAX_PAPERS) : previous.filter(id => id !== row.entityId)); }} /><span className="min-w-0 break-words font-medium">{row.label}</span></label>}
          {row.state === 'deleted' ? <p className="text-sm text-[var(--pq-text-muted)]">{l('账号文献已删除，本机文献保留，不执行接收。', 'The account paper was deleted. The local paper is preserved and cannot be received.')}</p> : diff(row.local, receivedData(row), false)}
          {row.data && !row.data.organization ? <p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('这份账号记录不含阅读安排；本机标签、收藏和阅读安排保留。', 'This account record has no reading plan; local tags, favorites and reading plans are preserved.')}</p> : null}
          {row.reason ? <Reason code={row.reason} l={l} /> : !row.canAccept ? <p className="text-xs text-[var(--pq-text-muted)]">{l('当前没有需要接收的修改。', 'There are no changes to receive.')}</p> : null}
        </li>} />}
        {confirmation?.kind === 'adopt' ? <div data-paper-confirmation tabIndex={-1} role="group" aria-label={l('确认接收题录', 'Confirm receiving paper details')} className="space-y-3 border-l-2 border-[var(--pq-accent)] pl-3 focus:outline-none"><p className="text-sm leading-6">{l('保存所选修改后，可在未完成操作的接收记录中撤销这次接收。', 'After saving these changes, undo this receipt from the receipt history under unfinished operations.')}</p><div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled || !receiving.length} onClick={() => { if (mayApply() && confirmation.kind === 'adopt' && receiving.length && receiving.length <= MAX_PAPERS) void change('adopt', () => desktopPaperExchange.adopt({ token: validPreview.token, ids: receiving.map(row => row.entityId) }), l('所选修改已保存到本机文库。接收记录中保留了撤销依据。', 'Selected changes were saved to this library. The receipt history retains what is needed to undo them.')); }}>{l(`接收所选 ${receiving.length} 项`, `Receive ${receiving.length} selected changes`)}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => confirm(null)}>{l('返回选择', 'Back to selection')}</button></div></div> : <button type="button" className={buttonClass} disabled={disabled || !receiving.length} onClick={() => confirm({ kind: 'adopt' })}>{l('查看接收选择', 'Review selected changes')}</button>}
      </div> : null}
      {validPreview && task === 'organization' && organizationRow ? <div className="space-y-3" data-paper-review>{status?.organizationSupported && draft && organizationRow.action !== 'blocked' ? <OrganizationEditor row={organizationRow} draft={draft} disabled={disabled} l={l} onChange={value => { currentView.current = null; setConfirmation(null); setDraft(value); }} onSave={() => { if (mayApply() && draft && status.organizationSupported) void change('organization', () => desktopPaperExchange.organization({ token: validPreview.token, localPaperId: organizationRow.localPaperId, readingStatus: draft.readingStatus, queued: draft.queued, collections: draft.collections.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }), l('已保存在此账号的本机草稿。重新检查并发送后，其他设备才可见。', 'Saved as a local draft for this account. Other devices can see it after you check and send it.')); }} /> : <Reason code={organizationRow.reason || 'PAPER_ORGANIZATION_UNAVAILABLE'} l={l} />}<button type="button" className={buttonClass} disabled={disabled} onClick={clearReview}>{l('重新选择文献', 'Choose papers again')}</button></div> : null}
      {validPreview && task === 'pending' ? <div className="space-y-4" data-paper-review>
        {restoring ? <div data-paper-confirmation tabIndex={-1} role="group" aria-label={l('确认撤销接收', 'Confirm undoing a receipt')} className="space-y-3 border-l-2 border-[var(--pq-accent)] pl-3 focus:outline-none"><h5 className="break-words text-sm font-medium">{restoring.label}</h5><AdoptionDiff row={restoring} reverse l={l} /><p className="text-sm leading-6 text-[var(--pq-text-muted)]">{l('只撤销这次本机接收，不改账号内容。如果此后又编辑过这份文献或阅读安排，撤销会停止。', 'Only undo this local receipt, without changing account content. If the paper or reading plan was edited later, undo stops.')}</p><div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={disabled} onClick={() => { if (mayApply() && confirmation?.kind === 'restore' && restoring.adoptionId === confirmation.adoptionId) void change('restore', () => desktopPaperExchange.restoreAdoption({ adoptionId: restoring.adoptionId }), l('这次接收已撤销，本机已恢复接收前的内容。账号内容未改动。', 'This receipt was undone. Local content was restored to before receiving. Account content was unchanged.')); }}>{l('确认撤销这次接收', 'Undo this receipt')}</button><button type="button" className={buttonClass} disabled={disabled} onClick={() => confirm(null)}>{l('返回记录', 'Back to history')}</button></div></div> : <>
          {validPreview.conflicts.length ? <section aria-label={l('选择要保留的题录', 'Choose paper details to keep')}><h5 className="text-sm font-medium">{l('内容不同，需要你的选择', 'Content differs and needs your choice')}</h5><PageRows key={validPreview.token + '-conflicts'} items={validPreview.conflicts} l={l} renderRow={row => <li key={row.conflictId} className="space-y-2 py-3"><h6 className="break-words text-sm font-medium">{row.label}</h6><DesktopPaperDiff before={row.current?.deletedAt ? null : row.current?.data || null} after={row.attempted.data} beforeLabel={l('账号当前内容', 'Current account content')} afterLabel={l('上次尝试的内容', 'Previously attempted content')} l={l} />{row.current?.deletedAt ? <p className="text-sm">{l('账号中这份文献已删除。', 'This account paper was deleted.')}</p> : null}{row.attempted.mutation !== 'put' ? <p className="text-sm">{row.attempted.mutation === 'delete' ? l('上次尝试删除账号文献。', 'The previous attempt deleted the account paper.') : l('上次尝试恢复账号文献。', 'The previous attempt restored the account paper.')}</p> : null}
            {(['current', 'attempted'] as const).map(choice => <label key={choice} className={selectionClass}><input type="radio" name={'paper-conflict-' + row.conflictId} className={inputClass} checked={conflictChoices[row.conflictId] === choice} disabled={disabled} onChange={() => { currentView.current = null; setConflictChoices(previous => ({ ...previous, [row.conflictId]: choice })); }} /><span>{choice === 'current' ? l('保留账号当前内容', 'Keep current account content') : l('使用上次尝试的修改', 'Use the previously attempted change')}</span></label>)}
            <button type="button" className={buttonClass} disabled={disabled || !conflictChoices[row.conflictId]} onClick={() => { const choice = conflictChoices[row.conflictId]; if (mayApply() && choice) void change('resolve', () => desktopPaperExchange.resolve({ conflictId: row.conflictId, choice, expectedRevision: row.expectedRevision }), l('已处理这项选择，可以重新检查结果。', 'This choice was processed. Check again to review the result.')); }}>{l('确认这项选择', 'Confirm this choice')}</button><Diagnostics data={row} l={l} /></li>} /></section> : null}
          {validPreview.pendingRows.length ? <section><h5 className="text-sm font-medium">{l('原请求的处理状态', 'Original request status')}</h5><PageRows key={validPreview.token + '-pending'} items={validPreview.pendingRows} l={l} renderRow={row => <li key={row.opId} className="space-y-2 py-3"><p className="break-words text-sm font-medium">{row.label}</p><p className="text-sm text-[var(--pq-text-muted)]">{row.stage === 'uncertain' ? l('上次发送的结果未知，需要先核对原请求。', 'The previous send result is unknown. The original request must be checked first.') : row.stage === 'queued' ? l('已保存，等待发送。', 'Saved and waiting to send.') : row.stage === 'conflict' ? l('内容不同，需要选择。', 'Content differs and needs a choice.') : l('原操作仍在处理中。', 'The original operation is still being handled.')}</p><details><summary className={summaryClass}>{l('查看原请求内容', 'View original request content')}</summary>{diff(null, row.data, true)}</details><Diagnostics data={row} l={l} /></li>} /></section> : null}
          {validPreview.pendingResolutions.length ? <section><h5 className="text-sm font-medium">{l('上次选择的处理状态', 'Previous choice status')}</h5><PageRows key={validPreview.token + '-choices'} items={validPreview.pendingResolutions} l={l} renderRow={row => <li key={row.opId} className="space-y-2 py-3"><p className="text-sm">{row.choice === 'current' ? l('保留账号内容', 'Keep account content') : l('使用上次修改', 'Use the previous change')}</p><p className="text-sm text-[var(--pq-text-muted)]">{row.lastResult?.status === 'rejected' ? l('上次选择未被接受，请重新检查。', 'The previous choice was rejected. Check again.') : row.lastResult?.status === 'conflict' ? l('账号内容又有变化，请重新选择。', 'Account content changed again. Choose again.') : l('处理结果待确认。', 'The result is unconfirmed.')}</p><Diagnostics data={row} l={l} /></li>} /></section> : null}
          {!validPreview.conflicts.length && !validPreview.pendingRows.length && !validPreview.pendingResolutions.length ? <p className="text-sm text-[var(--pq-text-muted)]">{l('没有等待发送或选择的操作。', 'No operations are waiting to send or resolve.')}</p> : null}
          {!!status?.continuable && !status.saveUnconfirmed && !status.adoptionPending ? <div className="space-y-2"><p className="text-xs leading-5 text-[var(--pq-text-muted)]">{l('继续时先核对上次结果，再处理仍未完成的原请求。', 'Continuing first checks the previous result, then handles the unfinished original request.')}</p><button type="button" className={buttonClass} disabled={disabled} onClick={() => { if (mayApply()) void change('continue', desktopPaperExchange.continue, l('已继续处理原请求，可以重新检查结果。', 'The original request continued. Check again to review the result.')); }}>{l('继续处理原请求', 'Continue original request')}</button></div> : null}
          <details className="border-t border-[var(--pq-border)]"><summary className={summaryClass}>{l(`本机接收记录（${validPreview.adoptions.length}）`, `Local receipt history (${validPreview.adoptions.length})`)}</summary>{!validPreview.adoptions.length ? <p className="text-sm text-[var(--pq-text-muted)]">{l('还没有本机接收记录。', 'There are no local receipts yet.')}</p> : <PageRows key={validPreview.token + '-adoptions'} items={[...validPreview.adoptions].reverse()} l={l} renderRow={row => <li key={row.adoptionId} className="py-3"><details><summary className={summaryClass + ' break-words'}>{row.label}<span className="ml-2 text-xs font-normal text-[var(--pq-text-muted)]">{row.phase === 'applied' ? l('已接收', 'Received') : row.phase === 'restored' ? l('已撤销', 'Undone') : row.phase === 'restoring' ? l('撤销待保存', 'Undo awaiting save') : l('接收待保存', 'Receipt awaiting save')}</span></summary><p className="text-xs text-[var(--pq-text-muted)]">{new Date(row.createdAt).toLocaleString()}</p><AdoptionDiff row={row} l={l} />{row.phase === 'applied' ? <button type="button" className={buttonClass} disabled={disabled || !!status?.adoptionPending} onClick={() => confirm({ kind: 'restore', adoptionId: row.adoptionId })}>{l('撤销这次接收', 'Undo this receipt')}</button> : null}<Diagnostics data={row} l={l} /></details></li>} />}</details>
        </>}
      </div> : null}
      <details className="border-t border-[var(--pq-border)] pt-1"><summary className={summaryClass}>{l('同步详情与备份', 'Sync details and backup')}</summary>{status?.loaded ? <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--pq-text-muted)]">{[[l('已关联', 'Linked'), status.bound], [l('已接收', 'Received'), status.accepted], [l('待处理', 'Pending'), status.pending], [l('内容不同', 'Differing content'), status.conflicts]].map(([label, count]) => <div key={label} className="flex gap-2"><dt>{label}</dt><dd>{count}</dd></div>)}</dl> : null}<p className="mt-2 text-xs leading-5 text-[var(--pq-text-muted)]">{l('记录按服务、账号和文库分别保存。备份包含关联、未完成操作和接收前后的题录。', 'Records are separate for each service, account and library. Backups contain links, unfinished operations and paper details before and after receipts.')}</p>{validPreview ? <p className="mt-2 text-xs">{l('检查时间：', 'Checked: ')}{new Date(validPreview.checkedAt).toLocaleString()}</p> : null}{visibleError ? <p className="mt-2 break-all text-xs text-[var(--pq-text-muted)]">{visibleError}</p> : null}<button type="button" className={buttonClass + ' mt-3'} disabled={!sameOwner || busy || !status?.loaded && !status?.saveUnconfirmed} onClick={() => { if (mayUseStatus()) void run('export', async current => { const result = await desktopPaperExchange.exportBackup(); if (current() && result.status === 'exported') setNotice(l('题录同步记录已导出备份。', 'The paper sync record was exported.')); }); }}><Download aria-hidden className="h-4 w-4" />{l('导出题录同步备份', 'Export paper sync backup')}</button>{validPreview ? <Diagnostics data={validPreview} l={l} /> : null}</details>
    </div>
  </SettingsField>;
}
