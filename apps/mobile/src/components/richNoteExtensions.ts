import { Node, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mathematics from '@tiptap/extension-mathematics';
import type { RichNoteMetadata } from '../../../../packages/sync-core/src/richNote.ts';
import type { RichNoteImagePool } from './richNoteImages.ts';

export const RICH_NOTE_MATH_OPTIONS = Object.freeze({ trust: false, throwOnError: false, strict: 'error' as const, maxExpand: 100, maxSize: 10 });
export interface RichNoteExtensionRuntime {
  images: Pick<RichNoteImagePool, 'get' | 'subscribe'>;
  metadata(): RichNoteMetadata;
  onMath?(kind: 'inlineMath' | 'blockMath', position: number, latex: string): void;
}
export function richReferenceLabel(type: string, attrs: Record<string, unknown>, metadata: RichNoteMetadata): string {
  if (type === 'noteAnchorBlock') return [attrs.label || '定位', '历史来源未验证', attrs.sourceLabel, attrs.sourceTitle, attrs.excerpt].filter(Boolean).join(' · ');
  if (type === 'noteAnchorLink') return `${attrs.label || '定位'}（来源未验证）`;
  if (type === 'hashTag') return `#${attrs.tag || ''}`;
  const kind = type === 'wikiLink' ? 'note' : 'paper', id = type === 'wikiLink' ? attrs.id : attrs.paperId;
  const unresolved = metadata.unresolvedReferences.some((entry) => entry.kind === kind && (id ? entry.id === id : entry.label === attrs.label));
  return `${type === 'wikiLink' ? '笔记' : '文献'}${unresolved ? '未解析引用' : '引用'}：${attrs.label || id || '未命名'}`;
}
function customAtom(name: string, group: 'block' | 'inline', defaults: Record<string, unknown>, runtime: RichNoteExtensionRuntime) {
  return Node.create({
    name, group, inline: group === 'inline', atom: true, selectable: true,
    addAttributes() { return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { default: value }])); },
    parseHTML() { return []; },
    renderHTML({ node }) { return [group === 'block' ? 'aside' : 'span', { 'data-rich-type': name, class: 'rich-note-reference' }, richReferenceLabel(name, node.attrs, runtime.metadata())]; },
    addNodeView() {
      return ({ node }) => {
        let current = node;
        const dom = document.createElement(group === 'block' ? 'aside' : 'span');
        dom.className = 'rich-note-reference'; dom.contentEditable = 'false'; dom.dataset.richType = name;
        const draw = () => { dom.textContent = richReferenceLabel(name, current.attrs, runtime.metadata()); };
        const unsubscribe = runtime.images.subscribe(draw); draw();
        return { dom, update(next) { if (next.type.name !== name) return false; current = next; draw(); return true; }, destroy: unsubscribe };
      };
    },
  });
}

/** Persisted schema mirrors the desktop. Image URLs exist only in a node view;
 * neither parseHTML nor renderHTML accepts or serializes an external image URL. */
export function createRichNoteExtensions(runtime: RichNoteExtensionRuntime): Extensions {
  const LocalImage = Image.extend({
    parseHTML() { return []; },
    renderHTML({ node }) { return ['span', { 'data-rich-image': 'preserved' }, String(node.attrs.alt || '包内图片')]; },
    addNodeView() {
      return ({ node }) => {
        let current = node;
        const dom = document.createElement('figure'), image = document.createElement('img'), caption = document.createElement('figcaption');
        dom.className = 'rich-note-image'; dom.contentEditable = 'false'; dom.append(image, caption);
        const draw = () => {
          const id = String(current.attrs.src).slice(13), url = runtime.images.get(id);
          if (url?.startsWith('blob:')) { if (image.getAttribute('src') !== url) image.src = url; image.hidden = false; } else { image.removeAttribute('src'); image.hidden = true; }
          image.alt = String(current.attrs.alt || '包内图片'); image.referrerPolicy = 'no-referrer';
          for (const key of ['width', 'height'] as const) {
            const value = current.attrs[key]; if (typeof value === 'number') image.setAttribute(key, String(value)); else image.removeAttribute(key);
          }
          caption.textContent = url ? String(current.attrs.title || current.attrs.alt || '') : '图片正在校验，暂不可保存';
        };
        const unsubscribe = runtime.images.subscribe(draw); draw();
        return { dom, update(next) { if (next.type.name !== 'image') return false; current = next; draw(); return true; }, destroy: unsubscribe };
      };
    },
  });
  const SafeLink = Link.extend({
    renderHTML({ HTMLAttributes }) { return ['a', { href: HTMLAttributes.href, title: HTMLAttributes.title, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' }, 0]; },
  }).configure({ openOnClick: false, autolink: false, linkOnPaste: false });
  const Component = Node.create({
    name: 'noteComponentBlock', group: 'block', content: 'block+', defining: true,
    addAttributes() { return { title: { default: 'Component' }, variant: { default: 'note' } }; },
    parseHTML() { return []; },
    renderHTML({ node }) { return ['section', { class: 'rich-note-component', 'data-rich-type': 'noteComponentBlock' },
      ['div', { class: 'rich-note-component-title', contenteditable: 'false' }, String(node.attrs.title || '')], ['div', {}, 0]]; },
  });
  return [StarterKit.configure({ link: false, trailingNode: false }), Highlight.configure({ multicolor: true }), SafeLink,
    LocalImage, Table.configure({ resizable: false, renderWrapper: true, allowTableNodeSelection: true }), TableRow, TableCell, TableHeader,
    TaskList, TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' } }), Mathematics.configure({ katexOptions: RICH_NOTE_MATH_OPTIONS,
      inlineOptions: { onClick: (node, position) => runtime.onMath?.('inlineMath', position, String(node.attrs.latex)) },
      blockOptions: { onClick: (node, position) => runtime.onMath?.('blockMath', position, String(node.attrs.latex)) } }), Component,
    customAtom('noteAnchorBlock', 'block', { anchorId: null, label: '定位', sourceLabel: '摘录', sourceTitle: '', excerpt: '' }, runtime),
    customAtom('noteAnchorLink', 'inline', { anchorId: null, label: null }, runtime),
    customAtom('wikiLink', 'inline', { id: null, label: null }, runtime), customAtom('hashTag', 'inline', { tag: null }, runtime),
    customAtom('paperReference', 'inline', { paperId: null, label: null }, runtime),
  ];
}
