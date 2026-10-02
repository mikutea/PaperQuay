import type { JSONContent } from '@tiptap/core';
import type { Note } from '../../types/notes';

const LOCAL_NOTE_IMAGE = /^(?:data:image\/[a-z0-9.+-]+[;,]|blob:)/i;

export function isLocalNoteImageSource(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_NOTE_IMAGE.test(value.trim());
}

export const EMPTY_TIPTAP_DOCUMENT: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

function cloneContent(value: JSONContent): JSONContent {
  return JSON.parse(JSON.stringify(value)) as JSONContent;
}

function plainTextFromContent(node: JSONContent | null | undefined): string {
  if (!node) return '';
  const parts: string[] = [];

  const visit = (item: JSONContent) => {
    if (typeof item.text === 'string') {
      parts.push(item.text);
    }

    for (const child of item.content ?? []) visit(child);
  };

  visit(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function findNoteAnchorLink(node: JSONContent | null | undefined): JSONContent | null {
  if (!node) return null;
  if (node.type === 'noteAnchorLink') return node;

  for (const child of node.content ?? []) {
    const found = findNoteAnchorLink(child);
    if (found) return found;
  }

  return null;
}

function sourceLabelFromAnchorParagraph(node: JSONContent) {
  const text = plainTextFromContent(node)
    .replace(/↗\s*/g, '')
    .replace(/^引用\s*[·:：-]?\s*/u, '')
    .trim();

  return text || '摘录';
}

function normalizeAnchorPageLabel(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const pageMatch = normalized.match(/\bP\s*(\d+)\b/i);

  if (pageMatch) return `P${pageMatch[1]}`;
  return normalized || '定位';
}

function normalizeAnchorSourceTitle(sourceTitle: string, sourceLabel: string) {
  const explicitTitle = sourceTitle.replace(/\s+/g, ' ').trim();
  if (
    explicitTitle &&
    !/^PDF\b/i.test(explicitTitle) &&
    !/^P\s*\d+\b/i.test(explicitTitle) &&
    !/^(摘录|正文摘录|引用摘录)$/u.test(explicitTitle)
  ) {
    return explicitTitle;
  }

  const legacyLabel = sourceLabel.replace(/\s+/g, ' ').trim();
  if (!legacyLabel) return '文献';
  if (/^PDF\b/i.test(legacyLabel)) return '文献';
  if (/^P\s*\d+\b/i.test(legacyLabel)) return '文献';
  if (/^(摘录|正文摘录|引用摘录)$/u.test(legacyLabel)) return '文献';

  return legacyLabel;
}

function noteAnchorBlockFromLegacy(
  note: Note,
  paragraph: JSONContent,
  quote: JSONContent | null,
): JSONContent | null {
  const anchorLink = findNoteAnchorLink(paragraph);
  const anchorId = String(anchorLink?.attrs?.anchorId || '').trim();

  if (!anchorId) return null;

  const anchor = note.anchors.find((item) => item.id === anchorId) ?? null;
  const label =
    String(anchorLink?.attrs?.label || '').trim() ||
    (anchor?.pdfLocation?.pageNumber ? `P${anchor.pdfLocation.pageNumber}` : '定位');
  const sourceLabel = sourceLabelFromAnchorParagraph(paragraph);
  const excerpt = plainTextFromContent(quote) || anchor?.excerpt || '';

  return {
    type: 'noteAnchorBlock',
    attrs: {
      anchorId,
      label: normalizeAnchorPageLabel(label),
      sourceLabel,
      sourceTitle: normalizeAnchorSourceTitle(anchor?.sourceTitle || '', sourceLabel),
      excerpt,
    },
  };
}

function upgradeLegacyNoteAnchors(contentJson: JSONContent, note: Note): JSONContent {
  const next = cloneContent(contentJson);
  const content = Array.isArray(next.content) ? next.content : [];
  const upgraded: JSONContent[] = [];

  for (let index = 0; index < content.length; index += 1) {
    const node = content[index];
    const nextNode = content[index + 1] ?? null;

    if (
      node?.type === 'paragraph' &&
      findNoteAnchorLink(node) &&
      nextNode?.type === 'blockquote'
    ) {
      const anchorBlock = noteAnchorBlockFromLegacy(note, node, nextNode);

      if (anchorBlock) {
        upgraded.push(anchorBlock);
        index += 1;
        continue;
      }
    }

    upgraded.push(node);
  }

  return {
    ...next,
    content: upgraded.length > 0 ? upgraded : next.content,
  };
}

export function noteContentToTiptap(note: Note | null): JSONContent {
  if (note?.contentJson && typeof note.contentJson === 'object') {
    return upgradeLegacyNoteAnchors(note.contentJson, note);
  }

  const text = note?.contentText || note?.content || '';
  if (!text.trim()) return EMPTY_TIPTAP_DOCUMENT;

  return {
    type: 'doc',
    content: text.split(/\n{2,}/).map((paragraph) => ({
      type: 'paragraph',
      content: paragraph.trim() ? [{ type: 'text', text: paragraph.trim() }] : undefined,
    })),
  };
}

export function titleFromNoteContent(text: string, fallback = '未命名笔记') {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

export function collectText(node: JSONContent | null | undefined): string {
  if (!node) return '';
  const parts: string[] = [];

  const visit = (item: JSONContent) => {
    if (typeof item.text === 'string') {
      parts.push(item.text);
    }

    if (item.type === 'wikiLink') {
      const label = String(item.attrs?.label || item.attrs?.id || '').trim();
      if (label) parts.push(`[[${label}]]`);
    }
    if (item.type === 'hashTag') {
      const tag = String(item.attrs?.tag || '').trim();
      if (tag) parts.push(`#${tag}`);
    }
    if (item.type === 'paperReference') {
      const paperId = String(item.attrs?.paperId || item.attrs?.label || '').trim();
      if (paperId) parts.push(`@${paperId}`);
    }
    if (item.type === 'noteAnchorLink') {
      const label = String(item.attrs?.label || '定位').trim();
      if (label) parts.push(`引用 · ${label}`);
    }
    if (item.type === 'noteAnchorBlock') {
      const label = normalizeAnchorPageLabel(String(item.attrs?.label || '定位'));
      const sourceLabel = String(item.attrs?.sourceLabel || '摘录').trim();
      const sourceTitle = normalizeAnchorSourceTitle(String(item.attrs?.sourceTitle || ''), sourceLabel);
      const excerpt = String(item.attrs?.excerpt || '').trim();
      parts.push(`引用 ${sourceTitle} ${label}`);
      if (excerpt) parts.push(excerpt);
    }
    if (item.type === 'noteComponentBlock') {
      const title = String(item.attrs?.title || '').trim();
      if (title) parts.push(title);
    }

    for (const child of item.content ?? []) visit(child);
  };

  visit(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function extractNoteAnchorIds(node: JSONContent | null | undefined): Set<string> {
  const ids = new Set<string>();

  const visit = (item: JSONContent | null | undefined) => {
    if (!item) return;

    if (item.type === 'noteAnchorBlock' || item.type === 'noteAnchorLink') {
      const anchorId = String(item.attrs?.anchorId || '').trim();
      if (anchorId) ids.add(anchorId);
    }

    for (const child of item.content ?? []) visit(child);
  };

  visit(node);
  return ids;
}

export function extractOutline(content: JSONContent | null | undefined) {
  const headings: Array<{ id: string; level: number; text: string }> = [];

  const visit = (node: JSONContent | null | undefined) => {
    if (!node) return;
    if (node.type === 'heading') {
      const text = collectText(node).trim();
      if (text) {
        headings.push({
          id: `${headings.length}-${text}`,
          level: Number(node.attrs?.level) || 1,
          text,
        });
      }
    }

    for (const child of node.content ?? []) visit(child);
  };

  visit(content);
  return headings;
}

export function extractWikiTitles(text: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  const regex = /\[\[([^[\]\n]{1,160})\]\]/g;
  let match = regex.exec(text);

  while (match) {
    const value = match[1].trim();
    const key = value.toLocaleLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
    match = regex.exec(text);
  }

  return output;
}

export function extractPaperRefs(text: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  const regex = /(^|[\s([{"'，。；、])@([a-zA-Z0-9:_-]{2,160})/g;
  let match = regex.exec(text);

  while (match) {
    const value = match[2].trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
    match = regex.exec(text);
  }

  return output;
}
