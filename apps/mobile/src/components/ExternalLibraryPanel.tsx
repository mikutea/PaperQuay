import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { canonicalJson } from '../../../../packages/sync-core/src/index.ts';
import { ClientError, describeError } from '../errors.ts';
import {
  ExternalLibraryError, parseExternalLibrary, planExternalLibraryImport,
  type ExternalLibraryDecision, type ExternalLibrarySnapshot, type ExternalLibraryWarning,
} from '../library/externalLibrary.ts';
import { externalLibraryEntities, type StoredWorkspace, type WorkspaceController } from '../sync/workspace.ts';

interface Props {
  controller: WorkspaceController;
  scopeKey: string;
  accountCurrent: () => boolean;
  onBusyChange: (busy: boolean) => void;
}
const fieldNames: Record<string, string> = {
  title: '标题', authors: '作者', year: '年份', doi: 'DOI', publication: '出版来源',
  abstractText: '摘要', keywords: '关键词',
};
const reasons: Record<string, string> = {
  DUPLICATE_CHOICE_REQUIRED: '发现相同 DOI 或题录，请明确关联已有文献、另存副本或跳过。',
  FIELD_CONFLICT: '来源与本地有不同改动，请核对冲突字段后选择保留哪一方。',
  SOURCE_VERSION_REUSED: '来源在相同版本号下提供了不同内容，请从来源重新取得有效版本。',
  TARGET_MISSING: '原关联文献已不在本机文库中，请先完成同步或跳过这条记录。',
  TARGET_DELETED: '原关联文献已删除，本次不会恢复它。请跳过这条记录。',
  TARGET_PENDING: '关联文献尚有待同步内容或同步冲突。请先完成同步或处理冲突。',
  TARGET_ALREADY_LINKED: '这篇文献已有其他来源条目的关联，请另存副本或跳过。',
  INVALID_LINK_TARGET: '所选文献不能用于本次关联，请重新选择。',
};
const actions: Record<string, string> = {
  create: '新增文献', link: '关联已有文献', update: '更新题录', unchanged: '保留当前题录', skip: '跳过', blocked: '需要处理',
};
const warningText: Record<ExternalLibraryWarning['code'], string> = {
  UNSUPPORTED_FIELDS: '卷期页、链接等当前未支持的来源字段没有导入。',
  UNSUPPORTED_ITEM: '笔记、批注或来源中已删除的条目已跳过，不会删除本地文献。',
  TAGS_OMITTED: 'Zotero 标签没有转成关键词，也不会覆盖个人分类。',
  CHILDREN_OMITTED: '附属条目和来源笔记没有导入。',
  ATTACHMENTS_OMITTED: '附件条目、路径和文件没有导入或读取。',
  CREATOR_ROLES_OMITTED: '编辑等非作者角色没有加入作者列表。',
  AUTHOR_STRUCTURE_FLATTENED: '作者保存为显示名称，姓名拆分与机构标记不保留。',
  DATE_PARTS_OMITTED: '出版日期仅保留年份。',
  YEAR_OMITTED: '来源日期不能确定唯一年份，本次年份留空。',
  TYPE_OMITTED: '文献类型没有导入。',
  TEXT_MARKUP_PRESERVED: '来源中的格式标记保留为普通文字，不执行或渲染 HTML。',
};
function display(value: unknown): string {
  return value == null || value === '' ? '未提供' : Array.isArray(value) ? value.join('；') || '未提供' : String(value);
}
function message(cause: unknown): string {
  if (cause instanceof ClientError) return describeError(cause);
  if (cause instanceof ExternalLibraryError) {
    if (/LARGE|CAPACITY|MANY|LIMIT/.test(cause.code)) return '文件或来源映射超过上限。每次最多 4 MB、500 条，请缩小范围后重试。';
    if (/JSON/.test(cause.code)) return 'JSON 文件无法读取，请检查内容后重新选择。';
    if (/SOURCE|LIBRARY/.test(cause.code)) return '无法确认文件中的来源文库。每个快照只接受一个明确的来源。';
    return '来源条目、版本号或题录不符合当前格式。本次没有保存任何内容，请检查文件后重试。';
  }
  return '未能读取或保存这份外部文库，请重新选择文件后重试。';
}

export function ExternalLibraryPanel({ controller, scopeKey, accountCurrent, onBusyChange }: Props) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [snapshot, setSnapshot] = useState<ExternalLibrarySnapshot | null>(null);
  const [reviewWorkspace, setReviewWorkspace] = useState<StoredWorkspace | null>(null);
  const [decisions, setDecisions] = useState<readonly ExternalLibraryDecision[] | undefined>();
  const [filename, setFilename] = useState('');
  const [warnings, setWarnings] = useState<ExternalLibraryWarning[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const prefix = useId();
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; sequence.current++; onBusyChange(false); };
  }, [onBusyChange]);
  function current(): boolean {
    const value = controller.getSnapshot(); const sync = value.workspace?.sync;
    return active.current && accountCurrent() && value.status === 'ready' && Boolean(sync)
      && JSON.stringify([sync!.accountId, sync!.deviceId, sync!.generation]) === scopeKey;
  }
  function markBusy(value: boolean) { busyRef.current = value; setBusy(value); onBusyChange(value); }
  const entities = useMemo(() => reviewWorkspace ? externalLibraryEntities(reviewWorkspace) : [], [reviewWorkspace]);
  const planned = useMemo(() => {
    if (!snapshot || !reviewWorkspace) return null;
    try { return { plan: planExternalLibraryImport(snapshot, reviewWorkspace.externalLibraries, entities, decisions), error: null }; }
    catch (cause) { return { plan: null, error: message(cause) }; }
  }, [snapshot, reviewWorkspace, entities, decisions]);
  const plan = planned?.plan;
  const stale = useMemo(() => {
    if (!snapshot || !plan || !state.workspace) return false;
    try {
      return planExternalLibraryImport(snapshot, state.workspace.externalLibraries, externalLibraryEntities(state.workspace), decisions).signature !== plan.signature;
    } catch { return true; }
  }, [snapshot, plan, state.workspace, decisions]);
  const sourceNames = { 'zotero-user': 'Zotero 个人库', 'zotero-group': 'Zotero 群组库', external: '外部文库' };
  const paperTitle = (id: string) => {
    const data = entities.find((entity) => entity.entityType === 'paper' && entity.entityId === id)?.data;
    return data && 'title' in data ? data.title : '未命名文献';
  };

  async function readFile(file?: File) {
    if (!file || busyRef.current || !current()) return;
    const request = ++sequence.current;
    markBusy(true); setError(null); setFeedback(null); setSnapshot(null); setReviewWorkspace(null); setDecisions(undefined); setWarnings([]);
    try {
      if (file.size > 4 * 1024 * 1024) { setError('文件超过 4 MB，请缩小范围后重试。'); return; }
      const bytes = await file.arrayBuffer();
      if (!current() || sequence.current !== request) return;
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { setError('文件不是有效的 UTF-8 文本，请使用 UTF-8 编码重新导出。'); return; }
      const parsed = parseExternalLibrary(text);
      setFilename(file.name); setSnapshot(parsed.snapshot); setReviewWorkspace(controller.getSnapshot().workspace); setWarnings(parsed.warnings);
    } catch (cause) { if (current() && sequence.current === request) setError(message(cause)); }
    finally { if (active.current && sequence.current === request) markBusy(false); }
  }
  function decide(itemKey: string, action: string) {
    if (busyRef.current || stale) return;
    setError(null); setFeedback(null);
    setDecisions((previous) => {
      const next = (previous ?? []).filter((entry) => entry.itemKey !== itemKey);
      if (action === 'default') return next;
      if (action.startsWith('link:')) next.push({ itemKey, action: 'link', paperId: action.slice(5) });
      else next.push({ itemKey, action: action as 'skip' | 'copy' });
      return next;
    });
  }
  function resolve(itemKey: string, resolution: '' | 'prefer-local' | 'prefer-source') {
    if (busyRef.current || stale) return;
    setError(null);
    setDecisions((previous) => {
      const selected = previous?.find((entry) => entry.itemKey === itemKey);
      const next = (previous ?? []).filter((entry) => entry.itemKey !== itemKey);
      const decision: ExternalLibraryDecision = selected?.action === 'link'
        ? { itemKey, action: 'link', paperId: selected.paperId, ...(resolution ? { resolution } : {}) }
        : { itemKey, action: 'import', ...(resolution ? { resolution } : {}) };
      next.push(decision); return next;
    });
  }
  async function confirm() {
    if (!snapshot || !plan || stale || busyRef.current || !current()) return;
    const request = ++sequence.current;
    markBusy(true); setError(null); setFeedback(null);
    try {
      const result = await controller.importExternalLibrary(snapshot, decisions, plan.signature, scopeKey);
      if (!current() || sequence.current !== request) return;
      setSnapshot(null); setReviewWorkspace(null); setDecisions(undefined); setWarnings([]);
      setFeedback(`已保存：新增 ${result.newPapers} 篇，关联 ${result.linkedPapers} 篇，更新 ${result.updatedPapers} 篇。来源映射已保存在此设备；题录按当前同步状态发送。`);
    } catch (cause) { if (current() && sequence.current === request) setError(message(cause)); }
    finally { if (active.current && sequence.current === request) markBusy(false); }
  }

  return <section className="external-library" aria-label="外部文库更新">
    <h3>从同一来源继续更新</h3>
    <p className="muted">选择外部文库快照，核对新增和变化后保存。已在 PaperQuay 中修改的字段会单独比较。</p>
    <p className="transfer-hint">来源映射只保存在本设备的当前账号下；题录正常同步。更换设备或清除本机数据后，需要重新确认关联。</p>
    <details className="external-format"><summary>支持的快照格式</summary>
      <p>支持 Zotero Web API v3 的 JSON 条目数组（含来源库、条目 key、version 和 data），以及 PaperQuay 外部文库快照 v1。</p>
      <p>一次仅接受一个来源，最多 4 MB、500 条。本轮不连接 Zotero 账号；普通 CSL JSON、RDF 或 BibTeX 导出不能当作带稳定来源标识的快照。</p>
      <p>只读取题录。附件、笔记、分类和未支持的出版字段不会导入；来源中缺少条目不会删除本地文献。</p>
    </details>
    <input ref={input} type="file" accept=".json,application/json" hidden aria-label="选择外部文库快照"
      onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void readFile(file); }} />
    <div className="transfer-source">
      {snapshot && <p className="transfer-filename">{filename}</p>}
      <button className="secondary" type="button" disabled={busy} onClick={() => input.current?.click()}>{snapshot ? '更换快照' : '选择快照文件'}</button>
    </div>
    {busy && !snapshot && <p role="status">正在读取外部文库…</p>}
    {plan && <><section className="transfer-preview" aria-label="外部文库更新预览">
      <h3>{plan.snapshot.source.name}</h3>
      <p className="external-source-id">{sourceNames[plan.snapshot.source.kind]} · {plan.snapshot.source.key}</p>
      <p className="external-counts">新增 {plan.summary.newPapers} · 关联 {plan.summary.linkedPapers} · 更新 {plan.summary.updatedPapers} · 待处理 {plan.summary.blocked}</p>
      {stale && <div className="transfer-message external-stale" role="alert">
        <p>文库在预览后有变化，此次预览已过期。请重新比较；此前的关联和冲突选择将清除。</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          if (!current() || busyRef.current) return;
          setReviewWorkspace(controller.getSnapshot().workspace); setDecisions(undefined); setError(null); setFeedback(null);
        }}>重新比较当前文库</button>
      </div>}
      {warnings.length > 0 && <div className="transfer-warnings" role="note" aria-label="外部文库字段转换提示">
        <details><summary>查看来源字段转换与跳过内容</summary><ul>
          {[...new Set(warnings.map((warning) => warning.code))].map((code) => {
            const count = new Set(warnings.filter((warning) => warning.code === code).map((warning) => warning.itemKey).filter(Boolean)).size;
            return <li key={code}>{warningText[code]}{count > 0 ? `（涉及 ${count} 条记录）` : ''}</li>;
          })}
        </ul></details>
      </div>}
      <ul className="external-rows">{plan.rows.map((row, index) => {
        const selected = decisions?.find((entry) => entry.itemKey === row.itemKey);
        const choice = selected?.action === 'link' ? `link:${selected.paperId}`
          : selected?.action === 'skip' || selected?.action === 'copy' ? selected.action : 'default';
        const resolution = row.resolution ?? '';
        const conflicting = row.fields.some((field) => field.conflict);
        const changedFields = row.fields.filter((field) => canonicalJson(field.local) !== canonicalJson(field.source));
        return <li key={row.itemKey} data-item-key={row.itemKey}>
          <div className="external-row-heading"><strong>{row.title}</strong><span>{actions[row.action]}</span></div>
          <p className="external-item-id">条目 {row.itemKey} · 来源版本 {row.itemVersion}</p>
          {row.targetPaperId && <p className="transfer-hint">关联：{paperTitle(row.targetPaperId)}</p>}
          {row.skipReason === 'STALE_VERSION' && <p className="transfer-hint">已跳过旧版本，保留当前文献和更新的来源记录。</p>}
          {row.blockedReason && <p className="external-blocked">{reasons[row.blockedReason] || '这条记录需要处理后才能保存。'}</p>}
          <div className="field"><label htmlFor={`${prefix}-choice-${index}`}>处理「{row.title}」</label>
            <select id={`${prefix}-choice-${index}`} value={choice} disabled={busy || stale} onChange={(event) => decide(row.itemKey, event.target.value)}>
              <option value="default">{row.mapped ? '按已保存的关联比较' : '按预览处理'}</option>
              <option value="skip">跳过这条记录</option>
              {!row.mapped && <option value="copy">另存为新文献</option>}
              {!row.mapped && row.duplicates?.existingIds.map((id) => <option key={id} value={`link:${id}`}>关联：{paperTitle(id)}</option>)}
            </select></div>
          {(row.blockedReason === 'FIELD_CONFLICT' || !row.blockedReason && row.action !== 'skip' && (conflicting || resolution)) && <div className="field external-resolution">
            <label htmlFor={`${prefix}-resolution-${index}`}>冲突字段的处理</label>
            <select id={`${prefix}-resolution-${index}`} value={resolution} disabled={busy || stale} onChange={(event) => resolve(row.itemKey, event.target.value as typeof resolution)}>
              <option value="">请先比较双方内容</option><option value="prefer-local">冲突字段保留本地</option><option value="prefer-source">冲突字段采用来源</option>
            </select>
            <p className="transfer-hint">此选择只处理双方内容不同的冲突字段；其他字段仍按预览合并。</p>
          </div>}
          <details className="external-diff"><summary>{changedFields.length ? `比较 ${changedFields.length} 个不同字段` : '查看题录与比较结果'}</summary>
            {row.fields.map((field) => <div className={`external-field${field.conflict ? ' has-conflict' : ''}`} key={field.field}>
              <h4>{fieldNames[field.field] || field.field}{field.conflict ? ' · 冲突' : ''}</h4>
              <dl><dt>上次来源</dt><dd>{display(field.base)}</dd><dt>当前本地</dt><dd>{display(field.local)}</dd>
                <dt>此次来源</dt><dd>{display(field.source)}</dd><dt>{row.action === 'skip' ? '保持本地' : '合并预览'}</dt><dd>{display(row.action === 'skip' ? field.local : field.result)}</dd></dl>
            </div>)}
          </details>
        </li>;
      })}</ul>
    </section>
      <div className="transfer-confirm">
        {error && <p className="inline-error transfer-message" role="alert">{error}</p>}
        {plan.summary.blocked > 0 && <p className="transfer-hint">请处理或跳过 {plan.summary.blocked} 条待处理记录后保存。</p>}
        <button type="button" className="primary" disabled={busy || stale || plan.summary.blocked > 0 || plan.rows.every((row) => row.action === 'skip')}
          onClick={() => void confirm()}>{busy ? '正在保存…' : '确认保存这次更新'}</button>
      </div>
    </>}
    {planned?.error && <p className="inline-error transfer-message" role="alert">{planned.error}</p>}
    {error && !plan && <p className="inline-error transfer-message" role="alert">{error}</p>}
    {feedback && <p className="transfer-message transfer-success" role="status">{feedback}</p>}
    {!snapshot && Boolean(state.workspace?.externalLibraries?.sources.length) && <details className="external-known"><summary>本设备已建立的来源关联</summary>
      <ul>{state.workspace!.externalLibraries!.sources.map((source) => <li key={source.id}>
        <strong>{source.name}</strong><span>{sourceNames[source.kind]} · {source.key} · {source.mappings.length} 条关联</span>
      </li>)}</ul>
    </details>}
  </section>;
}
