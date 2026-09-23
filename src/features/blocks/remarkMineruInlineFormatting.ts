import { createElement, isValidElement, type ReactNode } from 'react';
import { normalizeMarkdownMath } from '../../utils/markdown.ts';

const MATH_HTML_PATTERN =
  /<div\s+class=["']formula["'][^>]*>.*?<\/div>|<span\s+class=["']math["'][^>]*>.*?<\/span>/gis;
const INLINE_TAG_PATTERN = /<\s*\/?\s*(?:sup|sub)\s*>/gi;
const MARKER_START = '\uE200';
const MARKER_END = '\uE201';
const MAX_INLINE_NODES = 512;
const MAX_INLINE_DEPTH = 32;
const MAX_CAPTION_LENGTH = 16_384;

export function renderMineruInlineCaption(text: string, depth = 0): ReactNode[] {
  if (text.length > MAX_CAPTION_LENGTH || depth >= MAX_INLINE_DEPTH) {
    return [text];
  }

  const matches = [...text.matchAll(INLINE_TAG_PATTERN)];

  if (matches.length > MAX_INLINE_NODES) {
    return [text];
  }

  const rendered: ReactNode[] = [];
  let cursor = 0;

  for (let index = 0; index < matches.length; index += 1) {
    const opening = matches[index];

    if (/^<\s*\//.test(opening[0])) {
      continue;
    }

    const name = opening[0].match(/(?:sup|sub)/i)?.[0].toLowerCase() as 'sup' | 'sub';
    let nesting = 1;
    let closingIndex = index + 1;

    for (; closingIndex < matches.length; closingIndex += 1) {
      const candidate = matches[closingIndex];

      if (!new RegExp(name, 'i').test(candidate[0])) {
        continue;
      }

      nesting += /^<\s*\//.test(candidate[0]) ? -1 : 1;

      if (nesting === 0) {
        break;
      }
    }

    if (nesting === 0) {
      const closing = matches[closingIndex];
      rendered.push(text.slice(cursor, opening.index));
      rendered.push(createElement(
        name,
        { key: opening.index },
        ...renderMineruInlineCaption(text.slice(
          (opening.index ?? 0) + opening[0].length,
          closing.index,
        ), depth + 1),
      ));
      cursor = (closing.index ?? 0) + closing[0].length;
      index = closingIndex;
    }
  }

  rendered.push(text.slice(cursor));
  return rendered;
}

export function plainMineruInlineCaption(text: string): string {
  const flatten = (node: ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') {
      return String(node);
    }

    if (Array.isArray(node)) {
      return node.map(flatten).join('');
    }

    return isValidElement<{ children?: ReactNode }>(node) ? flatten(node.props.children) : '';
  };

  return flatten(renderMineruInlineCaption(text));
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string };
}

function readInlineTag(node: MarkdownNode): { name: 'sup' | 'sub'; closing: boolean } | null {
  if (node.type !== 'html' || typeof node.value !== 'string') {
    return null;
  }

  const match = /^<\s*(\/?)\s*(sup|sub)\s*>$/i.exec(node.value.trim());

  return match
    ? { name: match[2].toLowerCase() as 'sup' | 'sub', closing: Boolean(match[1]) }
    : null;
}

function renderInlineTags(children: MarkdownNode[], depth = 0): MarkdownNode[] {
  if (children.length > MAX_INLINE_NODES || depth >= MAX_INLINE_DEPTH) {
    return children;
  }

  const rendered: MarkdownNode[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const opening = readInlineTag(node);

    if (opening && !opening.closing) {
      let nesting = 1;
      let closingIndex = index + 1;

      for (; closingIndex < children.length; closingIndex += 1) {
        const tag = readInlineTag(children[closingIndex]);

        if (tag?.name !== opening.name) {
          continue;
        }

        nesting += tag.closing ? -1 : 1;

        if (nesting === 0) {
          break;
        }
      }

      if (nesting === 0) {
        rendered.push({
          type: 'mineruInlineFormatting',
          data: { hName: opening.name },
          children: renderInlineTags(children.slice(index + 1, closingIndex), depth + 1),
        });
        index = closingIndex;
        continue;
      }
    }

    if (node.children) {
      node.children = renderInlineTags(node.children, depth + 1);
    }

    rendered.push(node);
  }

  return rendered;
}

export function normalizeMineruReaderMarkdown(markdown: string): string {
  const tags: string[] = [];
  const readableMarkdown = markdown.replace(/\uE200/g, `${MARKER_START}${MARKER_START}`);

  const protectInlineTags = (text: string) => text.replace(INLINE_TAG_PATTERN, (tag) => {
    const marker = `${MARKER_START}${tags.length}${MARKER_END}`;
    tags.push(tag);
    return marker;
  });
  let protectedMarkdown = '';
  let cursor = 0;

  // Formula wrappers must retain their tags until the existing LaTeX repair runs.
  for (const match of readableMarkdown.matchAll(MATH_HTML_PATTERN)) {
    const start = match.index ?? 0;
    protectedMarkdown += protectInlineTags(readableMarkdown.slice(cursor, start));
    protectedMarkdown += match[0];
    cursor = start + match[0].length;
  }

  protectedMarkdown += protectInlineTags(readableMarkdown.slice(cursor));

  return normalizeMarkdownMath(protectedMarkdown).replace(
    /\uE200\uE200|\uE200(\d+)\uE201/g,
    (marker, index: string | undefined) => index === undefined ? MARKER_START : tags[Number(index)] ?? marker,
  );
}

// Only recognize MinerU's paired inline formatting tags. Other raw HTML stays literal.
export function remarkMineruInlineFormatting() {
  return (tree: unknown) => {
    const root = tree as MarkdownNode;

    if (root.children) {
      root.children = renderInlineTags(root.children);
    }
  };
}
