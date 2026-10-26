import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  EntityData,
  LocalEdit,
  NoteData,
  PaperData,
  VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import { canonicalJson } from '../../../../packages/sync-core/src/index.ts';
import { ClientError, describeError } from '../errors.ts';
import type { WorkspaceController } from '../sync/workspace.ts';
import { Icon } from './Icon.tsx';
import { entityStatus } from '../viewState.ts';
import { normalizeOrganization } from '../library/organization.ts';
import { PaperOrganizationFields } from './PaperOrganizationFields.tsx';
const emptyPaper = (): PaperData => ({
  title: '',
  authors: [],
  year: null,
  doi: null,
  publication: null,
  keywords: [],
  abstractText: null,
});
const emptyNote = (): NoteData => ({ title: '', paperId: null, body: '', format: 'markdown' });
const MarkdownPreview = lazy(() => import('./MarkdownPreview.tsx').then((module) => ({ default: module.MarkdownPreview })));

export function EntityEditor({
  type,
  entityId,
  entity,
  hasConflict,
  papers,
  controller,
  onBack,
  onDirty,
  onConflicts,
  organizationEnabled = false,
  onRead,
  defaultPaperId = null,
}: {
  type: 'paper' | 'note';
  entityId: string;
  entity?: VisibleEntity | null;
  papers: VisibleEntity[];
  controller: Pick<WorkspaceController, 'save' | 'getSnapshot'>;
  hasConflict: boolean;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
  onConflicts: () => void;
  organizationEnabled?: boolean;
  onRead?: () => void;
  defaultPaperId?: string | null;
}) {
  const [data, setData] = useState<PaperData | NoteData>(
    () => (entity?.data as PaperData | NoteData) ?? (type === 'paper' ? emptyPaper() : { ...emptyNote(), paperId: defaultPaperId }),
  );
  const [baseRevision, setBaseRevision] = useState(entity?.revision ?? 0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingBlocked, setEditingBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const editorSession = useRef<object | null>(null);
  const editSequence = useRef(0);
  const savingSession = useRef<object | null>(null);
  const lastSavedData = useRef<string | null>(null);
  const flushNote = useRef<() => void>(() => {});
  const remoteSignature = JSON.stringify(entity?.data ?? null);
  const changedWhileEditing = dirty && (entity?.revision ?? 0) !== baseRevision;

  useLayoutEffect(() => {
    // Persistence may finish after navigation. Retire the old editor before its
    // callbacks can clear a replacement draft or navigate away from it.
    const session = {};
    editorSession.current = session;
    setData((entity?.data as PaperData | NoteData) ?? (type === 'paper' ? emptyPaper() : { ...emptyNote(), paperId: defaultPaperId }));
    setBaseRevision(entity?.revision ?? 0);
    setDirty(false);
    setSaving(false);
    setEditingBlocked(false);
    editSequence.current = 0;
    savingSession.current = null;
    lastSavedData.current = null;
    setError(null);
    setSaved(false);
    setPreview(false);
    return () => {
      if (editorSession.current === session) editorSession.current = null;
    };
  }, [type, entityId, controller]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty && entity?.data) {
      setData(entity.data as PaperData | NoteData);
      setBaseRevision(entity.revision);
    } else if (dirty && lastSavedData.current) {
      // An acknowledgement of this editor's earlier autosave may advance its
      // base. A different remote body must still require explicit comparison.
      const record = controller.getSnapshot().workspace?.sync.serverRecords[`${type}:${entityId}`];
      if (record?.data && canonicalJson(record.data) === lastSavedData.current)
        setBaseRevision(record.revision);
    }
  }, [remoteSignature, entity?.revision, dirty]); // A changed remote version never replaces a dirty draft.
  useEffect(() => {
    if (type !== 'note' || !dirty || saving || error || changedWhileEditing || entity?.deleted) return;
    const timer = setTimeout(() => flushNote.current(), 600);
    return () => clearTimeout(timer);
  }, [type, dirty, saving, error, changedWhileEditing, entity?.deleted, data]);
  useEffect(() => {
    if (type !== 'note') return;
    const onHidden = () => {
      if (globalThis.document?.visibilityState === 'hidden') flushNote.current();
    };
    const onPageHide = () => flushNote.current();
    // The local commit is the durability boundary. A pagehide event cannot
    // promise completion if the OS kills the process before that commit.
    globalThis.document?.addEventListener?.('visibilitychange', onHidden);
    globalThis.window?.addEventListener?.('pagehide', onPageHide);
    return () => {
      globalThis.document?.removeEventListener?.('visibilitychange', onHidden);
      globalThis.window?.removeEventListener?.('pagehide', onPageHide);
    };
  }, [type]);
  function edit(update: Partial<PaperData & NoteData>) {
    editSequence.current += 1;
    setData((previous) => ({ ...previous, ...update }));
    setDirty(true);
    setSaved(false);
    setError(null);
  }

  async function save(revision = baseRevision, mutation: 'put' | 'restore' = 'put', automatic = false) {
    const session = editorSession.current;
    if (!session || savingSession.current === session) return;
    if (!data.title.trim() && !(automatic && type === 'note')) {
      setError('请填写标题。');
      return;
    }
    const sequence = editSequence.current;
    savingSession.current = session;
    setSaving(true);
    setEditingBlocked(!automatic);
    setError(null);
    try {
      const normalized =
        'authors' in data
          ? {
              ...data,
              title: data.title.trim(),
              authors: data.authors.map((author) => author.trim()).filter(Boolean),
              keywords: data.keywords.map((word) => word.trim()).filter(Boolean),
              ...(data.organization ? { organization: normalizeOrganization(data.organization) } : {}),
            }
          : { ...data, title: data.title.trim() || '未命名笔记' };
      await controller.save(
        { entityType: type, entityId, mutation, data: normalized } as LocalEdit,
        revision,
      );
      if (editorSession.current !== session) return;
      lastSavedData.current = canonicalJson(normalized);
      if (editSequence.current === sequence) {
        setDirty(false);
        onDirty(false);
        setSaved(true);
      }
      const record = controller.getSnapshot().workspace?.sync.serverRecords[`${type}:${entityId}`];
      if (record?.data && canonicalJson(record.data) === lastSavedData.current)
        setBaseRevision(record.revision);
    } catch (problem) {
      if (editorSession.current === session) setError(describeError(problem));
    } finally {
      if (savingSession.current === session) savingSession.current = null;
      if (editorSession.current === session) {
        setSaving(false);
        setEditingBlocked(false);
      }
    }
  }
  flushNote.current = () => {
    if (type === 'note' && dirty && !changedWhileEditing && !entity?.deleted)
      void save(baseRevision, 'put', true);
  };
  async function remove() {
    const session = editorSession.current;
    if (!session) return;
    if (!window.confirm('将这条内容标记为已删除？同步后会影响此账号的其他设备。')) return;
    if (editorSession.current !== session) return;
    setSaving(true);
    setEditingBlocked(true);
    try {
      await controller.save(
        { entityType: type, entityId, mutation: 'delete', data: null } as LocalEdit,
        entity?.revision ?? 0,
      );
      if (editorSession.current !== session) return;
      setDirty(false);
      onDirty(false);
      onBack();
    } catch (problem) {
      if (editorSession.current === session) setError(describeError(problem));
    } finally {
      if (editorSession.current === session) {
        setSaving(false);
        setEditingBlocked(false);
      }
    }
  }
  async function restore() {
    const session = editorSession.current;
    if (!session) return;
    if (!entity?.data) {
      setError('没有可恢复的内容。请从冲突中保留的版本恢复。');
      return;
    }
    setSaving(true);
    setEditingBlocked(true);
    try {
      await controller.save(
        { entityType: type, entityId, mutation: 'restore', data: entity.data } as LocalEdit,
        entity.revision,
      );
      if (editorSession.current !== session) return;
      setError(null);
    } catch (problem) {
      if (editorSession.current === session) setError(describeError(problem));
    } finally {
      if (editorSession.current === session) {
        setSaving(false);
        setEditingBlocked(false);
      }
    }
  }

  return (
    <section
      className={`editor-pane ${type === 'note' ? 'note-editor' : ''}`}
      aria-label={type === 'note' ? '笔记编辑器' : '文献信息'}
    >
      <header className="editor-toolbar">
        <button className="icon-button mobile-back" onClick={onBack} aria-label="返回列表">
          <Icon name="back" />
        </button>
        <span className="eyebrow">{type === 'note' ? 'Markdown 笔记' : '文献信息'}</span>
        {type === 'paper' && entity && !entity.deleted && onRead && <button type="button" className="secondary"
          disabled={saving} onClick={onRead}>打开 PDF</button>}
        {entity && !entity.deleted && (
          <button
            className="icon-button danger-text"
            aria-label="删除此条内容"
            onClick={() => void remove()}
            disabled={saving}
          >
            <Icon name="trash" />
          </button>
        )}
      </header>
      {entity?.deleted && !dirty ? (
        <div className="deleted-detail">
          <Icon name="trash" />
          <h2>此内容已删除</h2>
          <p>恢复会创建一个明确的新版本，并同步到其他设备。</p>
          {entity.data ? (
            <>
              <h3>{(entity.data as PaperData | NoteData).title}</h3>
              <button className="primary" onClick={() => void restore()} disabled={saving}>
                恢复此版本
              </button>
            </>
          ) : (
            <p>服务器已移除正文；可从冲突页中保留的编辑恢复。</p>
          )}
        </div>
      ) : (
        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="editor-fields" disabled={editingBlocked}>
            <label className="sr-only" htmlFor="entity-title">
              {type === 'note' ? '笔记标题' : '文献标题'}
            </label>
            <input
              id="entity-title"
              className="title-input"
              value={data.title}
              onChange={(event) => edit({ title: event.target.value })}
              maxLength={2048}
              placeholder={type === 'note' ? '笔记标题' : '文献标题'}
              required
            />
            {type === 'note' ? (
              <>
                <label className="field association-field">
                  关联文献
                  <select
                    value={(data as NoteData).paperId ?? ''}
                    onChange={(event) => edit({ paperId: event.target.value || null })}
                  >
                    <option value="">独立笔记</option>
                    {(data as NoteData).paperId &&
                      !papers.some((paper) => paper.entityId === (data as NoteData).paperId) && (
                        <option value={(data as NoteData).paperId!}>
                          原关联文献（当前不可用）
                        </option>
                      )}
                    {papers
                      .filter((paper) => !paper.deleted)
                      .map((paper) => (
                        <option key={paper.entityId} value={paper.entityId}>
                          {(paper.data as PaperData).title}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="sr-only" htmlFor="note-body">
                  笔记正文
                </label>
                <div className="note-mode-tabs" aria-label="笔记模式">
                  <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</button>
                  <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
                </div>
                {preview ? <Suspense fallback={<p role="status">正在生成预览…</p>}><MarkdownPreview body={(data as NoteData).body} /></Suspense> : <textarea
                  id="note-body"
                  className="markdown-input"
                  value={(data as NoteData).body}
                  onChange={(event) => edit({ body: event.target.value })}
                  maxLength={262144}
                  placeholder="开始记录你的想法…支持 Markdown 文本。"
                  spellCheck={false}
                />}
              </>
            ) : (
              <div className="metadata-fields">
                <PaperOrganizationFields paper={data as PaperData} enabled={organizationEnabled}
                  onChange={(organization) => edit({ organization })} />
                <label className="field">
                  作者
                  <input
                    value={(data as PaperData).authors.join('; ')}
                    onChange={(event) =>
                      edit({
                        authors: event.target.value
                          .split(/[;；]/)
                          .map((author) => author.trimStart()),
                      })
                    }
                    placeholder="多位作者用分号分隔"
                    maxLength={8192}
                  />
                </label>
                <div className="field-row">
                  <label className="field">
                    年份
                    <input
                      value={(data as PaperData).year ?? ''}
                      onChange={(event) => edit({ year: event.target.value || null })}
                      placeholder="2026"
                      maxLength={32}
                    />
                  </label>
                  <label className="field">
                    DOI
                    <input
                      value={(data as PaperData).doi ?? ''}
                      onChange={(event) => edit({ doi: event.target.value || null })}
                      placeholder="10.…"
                      maxLength={2048}
                    />
                  </label>
                </div>
                <label className="field">
                  期刊 / 出版来源
                  <input
                    value={(data as PaperData).publication ?? ''}
                    onChange={(event) => edit({ publication: event.target.value || null })}
                    maxLength={2048}
                  />
                </label>
                <label className="field">
                  关键词
                  <input
                    value={(data as PaperData).keywords.join('; ')}
                    onChange={(event) =>
                      edit({
                        keywords: event.target.value.split(/[;；]/).map((word) => word.trimStart()),
                      })
                    }
                    placeholder="多个关键词用分号分隔"
                    maxLength={8192}
                  />
                </label>
                <label className="field">
                  摘要
                  <textarea
                    rows={7}
                    value={(data as PaperData).abstractText ?? ''}
                    onChange={(event) => edit({ abstractText: event.target.value || null })}
                    maxLength={65536}
                  />
                </label>
              </div>
            )}
          </fieldset>
          {changedWhileEditing && (
            <div className="draft-review">
              <h3>{entity?.deleted ? '编辑期间此内容被删除' : '编辑期间收到新版本'}</h3>
              <p>你的草稿已保留在编辑框中。请比较当前内容后决定如何保存。</p>
              <details>
                <summary>查看当前版本</summary>
                <ContentPreview data={entity?.data ?? null} deleted={entity?.deleted} />
              </details>
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => {
                  if (
                    window.confirm(
                      entity?.deleted
                        ? '明确恢复这条已删除的内容，并使用编辑框里的草稿创建新版本？'
                        : '已查看当前版本？保存会使用你编辑框里的完整内容，替换当前版本。',
                    )
                  )
                    void save(entity?.revision ?? 0, entity?.deleted ? 'restore' : 'put');
                }}
              >
                {entity?.deleted ? '明确恢复并保存草稿' : '已比较，保存我的草稿'}
              </button>
            </div>
          )}
          <footer className="editor-footer">
            <span role="status" className={`save-state ${dirty ? 'unsaved' : ''}`}>
              {saving
                ? '正在保存到此设备…'
                : dirty
                  ? type === 'note' && !changedWhileEditing && !error ? '等待自动保存…' : '尚未保存'
                  : saved || entity
                    ? entityStatus(entity, hasConflict)
                    : '新建内容尚未保存'}
            </span>
            {(hasConflict || entity?.status === 'conflict') && (
              <button type="button" className="text-button" onClick={onConflicts}>
                查看冲突
              </button>
            )}
            <button
              type="submit"
              className="primary"
              disabled={saving || changedWhileEditing || (!dirty && Boolean(entity))}
            >
              <Icon name="check" />
              保存
            </button>
          </footer>
        </form>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function ContentPreview({
  data,
  deleted = false,
}: {
  data: EntityData | null;
  deleted?: boolean;
}) {
  if (deleted) return <p className="muted">此版本已删除。</p>;
  if (!data) return <p className="muted">没有正文。</p>;
  if ('body' in data)
    return (
      <>
        <h4>{data.title}</h4>
        <pre className="content-preview">{data.body || '（正文为空）'}</pre>
      </>
    );
  if ('authors' in data)
    return (
      <>
        <h4>{data.title}</h4>
        <p>
          {data.authors.join(' · ')}
          {data.year ? ` · ${data.year}` : ''}
        </p>
        <dl className="metadata-preview">
          <dt>DOI</dt>
          <dd>{data.doi || '未填写'}</dd>
          <dt>来源</dt>
          <dd>{data.publication || '未填写'}</dd>
          <dt>关键词</dt>
          <dd>{data.keywords.join(' · ') || '未填写'}</dd>
        </dl>
        <pre className="content-preview">{data.abstractText || '（摘要为空）'}</pre>
      </>
    );
  return <pre className="content-preview">{JSON.stringify(data, null, 2)}</pre>;
}
