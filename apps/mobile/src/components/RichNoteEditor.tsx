import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Editor, getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import katex from 'katex';
import { createRichNoteData, validateRichNoteData, type RichNoteData, type RichNoteNode, type RichNoteAsset } from '../../../../packages/sync-core/src/richNote.ts';
import { createRichNoteExtensions, richReferenceLabel, RICH_NOTE_MATH_OPTIONS } from './richNoteExtensions.ts';
import { RichNoteImagePool, readRichNoteImage } from './richNoteImages.ts';
import { RichNoteSession, richNoteAssetKey } from './richNoteSession.ts';

export interface RichNoteEditorProps {
  value: RichNoteData;
  onChange(value: RichNoteData): void;
  onValidityChange?(valid: boolean): void;
  /** Actual body transactions, including drafts which fail full validation. A
   * controlled value echo is not a persistence acknowledgement and stays dirty. */
  onDirtyChange?(dirty: boolean): void;
  disabled?: boolean;
  readOnly?: boolean;
  /** Parent account scope + entity id. Replacing it destroys undo and image state. */
  sessionKey?: string;
}
const INVALID = '此笔记不能完整表示，正文未改写；暂不可保存。';
const IMAGE_ERROR = '图片无法完整解码或超过限制，原笔记保持不变。';
function checked(value: RichNoteData): RichNoteData | null { try { return validateRichNoteData(value); } catch { return null; } }

function useAssets(value: RichNoteData | null) {
  const key = value ? richNoteAssetKey(value.assets) : 'invalid';
  const desired = useRef(key); desired.current = key;
  const owner = useRef<{ key: string; pool: RichNoteImagePool } | null>(null);
  const listeners = useRef(new Set<() => void>());
  const [state, setState] = useState<{ key: string; error: boolean } | null>(null);
  const view = useMemo(() => ({
    get: (id: string) => owner.current?.key === desired.current ? owner.current.pool.get(id) : undefined,
    subscribe: (listener: () => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
    refresh: () => { for (const listener of listeners.current) listener(); },
  }), []);
  useEffect(() => {
    if (!value) { setState({ key, error: true }); return; }
    const pool = new RichNoteImagePool(); let active = true;
    owner.current = { key, pool }; const unsubscribe = pool.subscribe(view.refresh); view.refresh();
    void pool.replace(value.assets).then((ready) => { if (active && ready) setState({ key, error: false }); }, () => { if (active) setState({ key, error: true }); });
    return () => { active = false; unsubscribe(); pool.close(); if (owner.current?.pool === pool) owner.current = null; view.refresh(); };
  }, [key]);
  return { view, ready: state?.key === key && !state.error && Boolean(value), failed: state?.key === key && state.error };
}

function MathView({ latex, block }: { latex: string; block: boolean }) {
  const target = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!target.current) return;
    try { katex.render(latex, target.current, { ...RICH_NOTE_MATH_OPTIONS, displayMode: block, macros: {} }); }
    catch { target.current.textContent = latex; }
  }, [latex, block]);
  return <span className={block ? 'rich-note-math-block' : 'rich-note-math'} ref={target}>{latex}</span>;
}
function RichTree({ node, value, image }: { node: RichNoteNode; value: RichNoteData; image(id: string): string | undefined }): ReactNode {
  const attrs = node.attrs ?? {};
  const children = node.content?.map((child, index) => <RichTree key={index} node={child} value={value} image={image} />);
  if (node.type === 'text') {
    let output: ReactNode = node.text;
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link') output = <a href={String(mark.attrs!.href)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{output}</a>;
      else if (mark.type === 'highlight') output = <mark style={mark.attrs?.color ? { backgroundColor: String(mark.attrs.color) } : undefined}>{output}</mark>;
      else output = createElement(({ bold: 'strong', italic: 'em', strike: 's', code: 'code', underline: 'u' } as Record<string, string>)[mark.type], null, output);
    }
    return output;
  }
  if (node.type === 'doc') return <>{children}</>;
  if (node.type === 'hardBreak') return <br />;
  if (node.type === 'horizontalRule') return <hr />;
  if (node.type === 'inlineMath' || node.type === 'blockMath') return <MathView latex={String(attrs.latex)} block={node.type === 'blockMath'} />;
  if (node.type === 'image') {
    const url = image(String(attrs.src).slice(13));
    return <figure className="rich-note-image">{url ? <img src={url} alt={String(attrs.alt || '')} title={attrs.title ? String(attrs.title) : undefined}
      width={typeof attrs.width === 'number' ? attrs.width : undefined} height={typeof attrs.height === 'number' ? attrs.height : undefined} referrerPolicy="no-referrer" /> : <span>图片正在校验</span>}
      {attrs.title && <figcaption>{String(attrs.title)}</figcaption>}</figure>;
  }
  if (['noteAnchorBlock', 'noteAnchorLink', 'wikiLink', 'hashTag', 'paperReference'].includes(node.type)) {
    return createElement(node.type === 'noteAnchorBlock' ? 'aside' : 'span', { className: 'rich-note-reference', 'data-rich-type': node.type }, richReferenceLabel(node.type, attrs, value.metadata));
  }
  if (node.type === 'noteComponentBlock') return <section className="rich-note-component"><div className="rich-note-component-title">{String(attrs.title || '')}</div>{children}</section>;
  if (node.type === 'table') return <div className="rich-note-table-scroll" tabIndex={0} role="region" aria-label="笔记表格"><table><tbody>{children}</tbody></table></div>;
  if (node.type === 'tableRow') return <tr>{children}</tr>;
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    const widths = attrs.colwidth as number[] | null | undefined;
    return createElement(node.type === 'tableHeader' ? 'th' : 'td', { colSpan: Number(attrs.colspan || 1), rowSpan: Number(attrs.rowspan || 1),
      style: { textAlign: attrs.align as 'left' | 'right' | 'center' | undefined, width: widths?.every(Boolean) ? widths.reduce((sum, width) => sum + width, 0) : undefined } }, children);
  }
  if (node.type === 'taskList') return <ul data-type="taskList">{children}</ul>;
  if (node.type === 'taskItem') return <li data-type="taskItem"><input type="checkbox" checked={Boolean(attrs.checked)} readOnly disabled aria-label={attrs.checked ? '已完成任务' : '未完成任务'} /><div>{children}</div></li>;
  if (node.type === 'orderedList') return <ol start={Number(attrs.start ?? 1)} type={attrs.type as '1' | 'a' | 'A' | 'i' | 'I' | undefined}>{children}</ol>;
  if (node.type === 'codeBlock') return <pre><code data-language={attrs.language || undefined}>{children}</code></pre>;
  const tag = node.type === 'heading' ? `h${attrs.level}` : ({ paragraph: 'p', blockquote: 'blockquote', bulletList: 'ul', listItem: 'li' } as Record<string, string>)[node.type];
  return createElement(tag, null, children);
}

function Preview({ value, onValidityChange }: Pick<RichNoteEditorProps, 'value' | 'onValidityChange'>) {
  const data = useMemo(() => checked(value), [value]), images = useAssets(data);
  const callback = useRef(onValidityChange); callback.current = onValidityChange;
  useEffect(() => { callback.current?.(Boolean(data) && images.ready); }, [Boolean(data), images.ready]);
  return <section className="rich-note-editor rich-note-preview" aria-label="富文本笔记预览">
    {!data ? <p role="alert">{INVALID}</p> : <>
      {images.failed ? <p role="alert">{IMAGE_ERROR}</p> : !images.ready && <p role="status">正在校验笔记图片…</p>}
      <div className="rich-note-content"><RichTree node={data.document} value={data} image={images.view.get} /></div>
    </>}
  </section>;
}

function Surface(props: RichNoteEditorProps) {
  const data = useMemo(() => checked(props.value), [props.value]), images = useAssets(data);
  const host = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), editor = useRef<Editor | null>(null), session = useRef<RichNoteSession | null>(null);
  const latest = useRef(props); latest.current = props;
  const ready = useRef(false); ready.current = images.ready;
  const canPublish = useRef(false), mounted = useRef(false), valid = useRef<boolean | null>(null), contentValid = useRef(true);
  const dirty = useRef(false);
  const upload = useRef<AbortController | null>(null), pending = useRef(false), extra = useRef<RichNoteAsset[]>([]);
  const [status, setStatus] = useState(''), [, render] = useState(0), [link, setLink] = useState('');
  const [math, setMath] = useState({ kind: 'inlineMath' as 'inlineMath' | 'blockMath', latex: '', position: null as number | null, original: '' });
  const [range, setRange] = useState({ row1: 1, column1: 1, row2: 1, column2: 2 });
  const report = (value: boolean) => { if (valid.current !== value) { valid.current = value; latest.current.onValidityChange?.(value); } };
  const reportDirty = (value: boolean) => { if (value || dirty.current !== value) { dirty.current = value; latest.current.onDirtyChange?.(value); } };
  const allowed = () => mounted.current && !latest.current.disabled && ready.current;
  const markIntent = () => { if (allowed()) canPublish.current = true; };
  const publish = (active: Editor, current: RichNoteSession) => {
    if (!mounted.current || editor.current !== active || session.current !== current || !canPublish.current || latest.current.disabled) return;
    reportDirty(true);
    try {
      const result = current.edit(active.getJSON(), extra.current);
      contentValid.current = true; setStatus(''); report(ready.current && !pending.current);
      if (result) latest.current.onChange(result);
    } catch { contentValid.current = false; report(false); setStatus(INVALID); }
  };
  useLayoutEffect(() => {
    if (!data || !host.current) return;
    mounted.current = true; contentValid.current = true; canPublish.current = false;
    const current = new RichNoteSession(data); session.current = current;
    let active: Editor | undefined;
    try {
      const extensions = createRichNoteExtensions({ images: images.view, metadata: () => current.current.metadata,
        onMath: (kind, position, latex) => { if (allowed()) setMath({ kind, position, latex, original: latex }); } });
      const model = getSchema(extensions).nodeFromJSON(data.document); model.check();
      createRichNoteData({ paperId: data.paperId, title: data.title, document: model.toJSON(), metadata: data.metadata, assets: data.assets });
      active = new Editor({ element: host.current, content: data.document, injectCSS: false, editable: false, enableContentCheck: true,
        extensions,
        editorProps: { attributes: { 'aria-label': '富文本笔记正文', role: 'textbox', 'aria-multiline': 'true' },
          handlePaste: (_view, event) => {
            event.preventDefault(); if (!allowed()) return true;
            if (event.clipboardData?.files.length) { setStatus('粘贴图片暂不支持，请使用“插入本地图片”；正文未改变。'); return true; }
            if (event.clipboardData?.getData('text/html')) { setStatus('富文本粘贴暂不支持，请使用纯文本粘贴；正文未改变。'); return true; }
            const plain = event.clipboardData?.getData('text/plain');
            if (plain && active) { markIntent(); active.view.dispatch(active.state.tr.insertText(plain)); } return true;
          },
          handleDrop: (_view, event) => { event.preventDefault(); setStatus('请通过“插入本地图片”选择图片；拖入内容未改变正文。'); return true; },
        },
        onUpdate: ({ editor: instance }) => publish(instance, current),
        onSelectionUpdate: () => { if (mounted.current) render((count) => count + 1); },
      });
      // Check the actual schema before allowing any edits, without emitting its defaults.
      active.state.doc.check(); createRichNoteData({ paperId: data.paperId, title: data.title, document: active.getJSON(), metadata: data.metadata, assets: data.assets });
      editor.current = active; render((count) => count + 1);
    } catch { contentValid.current = false; report(false); setStatus(INVALID); }
    return () => { mounted.current = false; canPublish.current = false; upload.current?.abort(); current.close();
      if (editor.current === active) editor.current = null; active?.destroy(); session.current = null; };
  }, [Boolean(data)]);
  useLayoutEffect(() => {
    const active = editor.current, current = session.current;
    if (!data || !active || !current) { report(false); return; }
    try {
      const change = current.receive(data);
      if (change.replace) {
        upload.current?.abort(); canPublish.current = false; extra.current = [];
        const document = active.schema.nodeFromJSON(data.document); document.check();
        const position = Math.min(active.state.selection.from, document.content.size);
        active.view.updateState(EditorState.create({ schema: active.schema, doc: document, plugins: active.state.plugins,
          selection: TextSelection.near(document.resolve(position)) }));
        contentValid.current = true; setStatus('');
        reportDirty(false);
      }
      images.view.refresh();
    } catch { contentValid.current = false; setStatus(INVALID); report(false); }
  }, [data]);
  useLayoutEffect(() => {
    editor.current?.setEditable(Boolean(data) && images.ready && !props.disabled, false);
    if (props.disabled) upload.current?.abort();
    report(Boolean(editor.current) && Boolean(data) && images.ready && contentValid.current && !pending.current);
  }, [Boolean(data), images.ready, props.disabled]);

  const action = (run: (active: Editor) => boolean) => {
    const active = editor.current; if (!active || !allowed()) return;
    markIntent(); try { run(active); render((count) => count + 1); } catch { setStatus('当前光标位置不支持此操作，正文未改变。'); }
  };
  const toolbar = (label: string, run: (active: Editor) => boolean, pressed?: boolean) => <button type="button" key={label} disabled={!images.ready || props.disabled || !data}
    aria-pressed={pressed} onMouseDown={(event) => event.preventDefault()} onClick={() => action(run)}>{label}</button>;
  const applyMath = () => action((active) => {
    if (!math.latex.trim()) { setStatus('请输入公式。'); return false; }
    if (math.position !== null) {
      const node = active.state.doc.nodeAt(math.position);
      if (node?.type.name !== math.kind || node.attrs.latex !== math.original) { setStatus('公式位置已变化，请重新选择公式。'); return false; }
      active.view.dispatch(active.state.tr.setNodeMarkup(math.position, undefined, { ...node.attrs, latex: math.latex }));
    } else active.chain().focus().insertContent({ type: math.kind, attrs: { latex: math.latex } }).run();
    setMath({ ...math, position: null, original: '' }); return true;
  });
  const selectCells = () => action((active) => {
    const position = active.state.selection.$from;
    for (let depth = position.depth; depth > 0; depth--) if (position.node(depth).type.name === 'table') {
      const table = position.node(depth), map = TableMap.get(table), start = position.before(depth) + 1;
      const indexes = [[range.row1, range.column1], [range.row2, range.column2]].map(([row, column]) => {
        if (!Number.isInteger(row) || !Number.isInteger(column) || row < 1 || row > map.height || column < 1 || column > map.width) throw new Error();
        return start + map.map[(row - 1) * map.width + column - 1];
      });
      active.view.dispatch(active.state.tr.setSelection(CellSelection.create(active.state.doc, indexes[0], indexes[1]))); return true;
    }
    setStatus('请先将光标放入需要编辑的表格。'); return false;
  });
  const insertImage = async (file: File) => {
    const active = editor.current, current = session.current; if (!active || !current || !allowed()) return;
    upload.current?.abort(); const controller = new AbortController(); upload.current = controller;
    const originalDocument = active.state.doc; pending.current = true; report(false); setStatus('正在校验本地图片…');
    try {
      const asset = await readRichNoteImage(file, controller.signal);
      if (controller.signal.aborted || !allowed() || editor.current !== active || session.current !== current) return;
      if (active.state.doc !== originalDocument) { setStatus('正文已变化，请重新选择图片。'); return; }
      const node = active.schema.nodes.image.create({ src: `asset:sha256:${asset.id}`, alt: file.name.slice(0, 2048), title: null, width: null, height: null });
      const transaction = active.state.tr.replaceSelectionWith(node);
      current.prepare(transaction.doc.toJSON(), [asset]);
      extra.current = [asset]; markIntent(); active.view.dispatch(transaction);
    } catch { if (!controller.signal.aborted && mounted.current && session.current === current) setStatus(IMAGE_ERROR); }
    finally { if (upload.current === controller) { pending.current = false; if (mounted.current) report(ready.current && contentValid.current); } }
  };
  const currentEditor = editor.current;
  return <section className="rich-note-editor" aria-label="富文本笔记编辑器">
    {!data && <p role="alert">{INVALID}</p>}
    <div className="rich-note-toolbar" role="toolbar" aria-label="正文格式">
      {toolbar('加粗', (active) => active.chain().focus().toggleBold().run(), currentEditor?.isActive('bold'))}
      {toolbar('斜体', (active) => active.chain().focus().toggleItalic().run(), currentEditor?.isActive('italic'))}
      {toolbar('下划线', (active) => active.chain().focus().toggleUnderline().run(), currentEditor?.isActive('underline'))}
      {toolbar('删除线', (active) => active.chain().focus().toggleStrike().run(), currentEditor?.isActive('strike'))}
      {toolbar('高亮', (active) => active.chain().focus().toggleHighlight({ color: '#fef08a' }).run(), currentEditor?.isActive('highlight'))}
      {toolbar('行内代码', (active) => active.chain().focus().toggleCode().run(), currentEditor?.isActive('code'))}
      {toolbar('段落', (active) => active.chain().focus().setParagraph().run())}
      {toolbar('二级标题', (active) => active.chain().focus().toggleHeading({ level: 2 }).run())}
      {toolbar('引用', (active) => active.chain().focus().toggleBlockquote().run())}
      {toolbar('无序列表', (active) => active.chain().focus().toggleBulletList().run())}
      {toolbar('有序列表', (active) => active.chain().focus().toggleOrderedList().run())}
      {toolbar('任务列表', (active) => active.chain().focus().toggleTaskList().run())}
      {toolbar('缩进列表', (active) => active.chain().focus().sinkListItem(active.isActive('taskItem') ? 'taskItem' : 'listItem').run())}
      {toolbar('减少缩进', (active) => active.chain().focus().liftListItem(active.isActive('taskItem') ? 'taskItem' : 'listItem').run())}
      {toolbar('代码块', (active) => active.chain().focus().toggleCodeBlock().run())}
      {toolbar('分隔线', (active) => active.chain().focus().setHorizontalRule().run())}
      {toolbar('撤销', (active) => active.chain().focus().undo().run())}{toolbar('重做', (active) => active.chain().focus().redo().run())}
    </div>
    <details className="rich-note-controls"><summary>链接、公式、图片与表格</summary>
      <div className="rich-note-form-row"><label>链接地址<input type="url" value={link} onChange={(event) => setLink(event.target.value)} disabled={props.disabled} /></label>
        {toolbar('设置链接', (active) => {
          try { createRichNoteData({ paperId: null, title: '', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: link } }] }] }] }, metadata: session.current!.current.metadata, assets: [] }); }
          catch { setStatus('此链接不在安全范围内，正文未改变。'); return false; }
          return active.chain().focus().extendMarkRange('link').setLink({ href: link }).run();
        })}{toolbar('移除链接', (active) => active.chain().focus().unsetLink().run())}</div>
      <div className="rich-note-form-row"><label>公式类型<select value={math.kind} onChange={(event) => setMath({ ...math, kind: event.target.value as typeof math.kind, position: null })} disabled={props.disabled}>
        <option value="inlineMath">行内公式</option><option value="blockMath">独立公式</option></select></label>
        <label>LaTeX<textarea value={math.latex} maxLength={16_384} onChange={(event) => setMath({ ...math, latex: event.target.value })} disabled={props.disabled} /></label>
        <button type="button" disabled={!images.ready || props.disabled || !math.latex.trim()} onClick={applyMath}>{math.position === null ? '插入公式' : '更新选中公式'}</button></div>
      <div className="rich-note-form-row"><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="本地笔记图片" hidden disabled={!images.ready || props.disabled}
        onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void insertImage(file); }} />
        <button type="button" disabled={!images.ready || props.disabled} onClick={() => fileInput.current?.click()}>插入本地图片</button><span>PNG/JPEG/WebP，单图不超过 512KiB。</span></div>
      <div className="rich-note-toolbar" aria-label="表格操作">
        {toolbar('插入表格', (active) => active.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run())}
        {toolbar('增加行', (active) => active.chain().focus().addRowAfter().run())}{toolbar('增加列', (active) => active.chain().focus().addColumnAfter().run())}
        {toolbar('删除行', (active) => active.chain().focus().deleteRow().run())}{toolbar('删除列', (active) => active.chain().focus().deleteColumn().run())}
        {toolbar('切换表头', (active) => active.chain().focus().toggleHeaderCell().run())}
        {toolbar('合并单元格', (active) => active.chain().focus().mergeCells().run())}{toolbar('拆分单元格', (active) => active.chain().focus().splitCell().run())}
        {toolbar('删除表格', (active) => active.chain().focus().deleteTable().run())}
      </div>
      <div className="rich-note-form-row">{(['row1', 'column1', 'row2', 'column2'] as const).map((key, index) => <label key={key}>{['起始行', '起始列', '结束行', '结束列'][index]}
        <input type="number" min={1} max={1000} value={range[key]} onChange={(event) => setRange({ ...range, [key]: Number(event.target.value) })} disabled={props.disabled} /></label>)}
        <button type="button" onClick={selectCells} disabled={!images.ready || props.disabled}>选中表格范围</button></div>
    </details>
    {images.failed ? <p role="alert">{IMAGE_ERROR}</p> : !images.ready && data && <p role="status">正在校验笔记图片…</p>}
    {status && <p role="status">{status}</p>}
    <div className="rich-note-content" ref={host} onBeforeInputCapture={markIntent} onKeyDownCapture={markIntent} onPointerDownCapture={markIntent}
      onChangeCapture={markIntent} onClickCapture={(event) => { if ((event.target as HTMLElement).closest?.('a')) event.preventDefault(); }} />
    <p className="muted rich-note-help">图片只使用包内资源；历史定位不代表当前 PDF 版本。富文本粘贴与拖入暂不支持。</p>
  </section>;
}

export function RichNoteEditor(props: RichNoteEditorProps) {
  const previousKey = useRef(props.sessionKey);
  useLayoutEffect(() => { if (previousKey.current !== props.sessionKey) { previousKey.current = props.sessionKey; props.onDirtyChange?.(false); } }, [props.sessionKey]);
  return props.readOnly ? <Preview key={props.sessionKey ?? ''} value={props.value} onValidityChange={props.onValidityChange} />
    : <Surface key={props.sessionKey ?? ''} {...props} />;
}
export function RichNotePreview(props: Pick<RichNoteEditorProps, 'value' | 'onValidityChange' | 'sessionKey'>) {
  return <Preview key={props.sessionKey ?? ''} value={props.value} onValidityChange={props.onValidityChange} />;
}
