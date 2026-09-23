import { createElement, isValidElement, type ReactNode } from 'react';
import { displayMarkdownFallback, displayMathTagsAsLatex } from '../../services/mineru.ts';
import { normalizeMarkdownMath } from '../../utils/markdown.ts';

const INLINE_TAG_PATTERN = /<\s*\/?\s*(?:sup|sub)\s*>/gi;
// Braces keep protected tags outside long math candidates in normalizeMarkdownMath.
// A private-use marker here can cause repeated scans of a preceding math token.
const MARKER_START = '{PQInlineTag';
const MARKER_END = '}';
const MAX_INLINE_NODES = 512;
const MAX_INLINE_DEPTH = 32;
const MAX_CAPTION_LENGTH = 16_384;
const MAX_INLINE_WORK = 20_000;
const MAX_CAPTION_WORK = 4_096;

export function renderMineruInlineCaption(
  text: string,
  depth = 0,
  budget: { remaining: number } = { remaining: MAX_CAPTION_WORK },
): ReactNode[] {
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
    if (--budget.remaining < 0) return [text];
    const opening = matches[index];

    if (/^<\s*\//.test(opening[0])) {
      continue;
    }

    const name = opening[0].match(/(?:sup|sub)/i)?.[0].toLowerCase() as 'sup' | 'sub';
    let nesting = 1;
    let closingIndex = index + 1;

    for (; closingIndex < matches.length; closingIndex += 1) {
      if (--budget.remaining < 0) return [text];
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
        ), depth + 1, budget),
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
  data?: { hName?: string; hChildren?: MarkdownNode[] };
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

function renderInlineTags(
  children: MarkdownNode[],
  budget: { remaining: number },
  depth = 0,
): MarkdownNode[] {
  if (children.length > MAX_INLINE_NODES || depth >= MAX_INLINE_DEPTH || budget.remaining <= 0) {
    return children;
  }

  const rendered: MarkdownNode[] = [];

  for (let index = 0; index < children.length; index += 1) {
    if (--budget.remaining < 0) {
      rendered.push(...children.slice(index));
      return rendered;
    }

    const node = children[index];
    if ((node.type === 'math' || node.type === 'inlineMath') && typeof node.value === 'string') {
      const latex = displayMathTagsAsLatex(node.value);
      if (latex !== null) {
        node.value = latex;
        if (node.data?.hChildren?.[0]?.type === 'text') {
          node.data.hChildren[0].value = latex;
        }
      }
    }
    const opening = readInlineTag(node);

    if (opening && !opening.closing) {
      let nesting = 1;
      let closingIndex = index + 1;

      for (; closingIndex < children.length; closingIndex += 1) {
        if (--budget.remaining < 0) {
          rendered.push(...children.slice(index));
          return rendered;
        }

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
          children: renderInlineTags(children.slice(index + 1, closingIndex), budget, depth + 1),
        });
        index = closingIndex;
        continue;
      }
    }

    if (node.children) {
      node.children = renderInlineTags(node.children, budget, depth + 1);
    }

    rendered.push(node);
  }

  return rendered;
}

export function normalizeMineruReaderMarkdown(markdown: string): string {
  if (!/<\s*\/?\s*(?:sup|sub)\s*>/i.test(markdown)) {
    return normalizeMarkdownMath(markdown);
  }

  // Four-space and tab-indented CommonMark code blocks are inert, like fences.
  if (/(?:^|\n\n)(?: {4}|\t)/.test(markdown)) {
    const normalizeOutside = (text: string) => {
      const leading = text.match(/^\s*/)?.[0] ?? '';
      const trailing = text.match(/\s*$/)?.[0] ?? '';
      const body = text.slice(leading.length, text.length - trailing.length);
      return body ? leading + normalizeMineruReaderMarkdown(body) + trailing : text;
    };
    let output = '';
    let outside = '';
    let inCode = false;
    let previousBlank = true;
    for (const line of markdown.split(/(?<=\n)/)) {
      const blank = line.trim() === '';
      const indented = /^(?: {4}|\t)/.test(line);
      if (indented && (previousBlank || inCode)) {
        if (outside) {
          output += normalizeOutside(outside);
          outside = '';
        }
        output += line;
        inCode = true;
      } else if (inCode && blank) {
        output += line;
      } else {
        outside += line;
        inCode = false;
      }
      previousBlank = blank;
    }
    return output + normalizeOutside(outside);
  }

  const canonicalizeInlineTag = (tag: string) => {
    const [, slash, name] = /<\s*(\/?)\s*(sup|sub)\s*>/i.exec(tag) ?? [];
    return name ? `<${slash ? '/' : ''}${name.toLowerCase()}>` : tag;
  };
  const tags: string[] = [];
  const readableMarkdown = markdown.replace(/\{PQInlineTag/g, `${MARKER_START}${MARKER_START}`);

  const protectInlineTags = (text: string) => text.replace(INLINE_TAG_PATTERN, (tag) => {
    const marker = `${MARKER_START}${tags.length}${MARKER_END}`;
    tags.push(tag);
    return marker;
  });
  let protectedMarkdown = '';
  let cursor = 0;

  // Locate wrapper open/close tokens once, rather than retrying an unbounded
  // wildcard from every malformed opener in imported MinerU text.
  const closes = {
    div: [...readableMarkdown.matchAll(/<\/div>/gi)].map((match) => match.index ?? 0),
    span: [...readableMarkdown.matchAll(/<\/span>/gi)].map((match) => match.index ?? 0),
  };
  const closeCursor = { div: 0, span: 0 };
  let search = 0;
  while (search < readableMarkdown.length) {
    const start = readableMarkdown.indexOf('<', search);
    if (start < 0) break;
    const end = readableMarkdown.indexOf('>', start + 1);
    if (end < 0) break;
    const opening = readableMarkdown.slice(start, end + 1);
    const kind = /^<div\s+class=["']formula["'][^>]*>$/i.test(opening)
      ? 'div'
      : /^<span\s+class=["']math["'][^>]*>$/i.test(opening) ? 'span' : null;

    if (kind) {
      const positions = closes[kind];
      while (positions[closeCursor[kind]] < end + 1) closeCursor[kind] += 1;
      const closing = positions[closeCursor[kind]];
      if (closing !== undefined) {
        const closingEnd = closing + kind.length + 3;
        protectedMarkdown += protectInlineTags(readableMarkdown.slice(cursor, start));
        const wrapper = readableMarkdown.slice(start, closingEnd);
        const inner = readableMarkdown.slice(end + 1, closing);
        const safeMath = displayMathTagsAsLatex(inner);
        protectedMarkdown += safeMath === null
          ? wrapper.replace(INLINE_TAG_PATTERN, canonicalizeInlineTag)
          : `${readableMarkdown.slice(start, end + 1)}${safeMath}${readableMarkdown.slice(closing, closingEnd)}`;
        cursor = closingEnd;
        search = cursor;
        continue;
      }
    }
    search = end + 1;
  }

  protectedMarkdown += protectInlineTags(readableMarkdown.slice(cursor));

  const restoreInlineTags = (value: string) => value.replace(
    /\{PQInlineTag\{PQInlineTag|\{PQInlineTag(\d+)\}/g,
    (marker, index: string | undefined) => index === undefined ? MARKER_START : tags[Number(index)] ?? marker,
  );

  // Formula wrappers have already received safe tag conversion. Keep ordinary
  // math on the direct path so long relation tokens never reach marker scans.
  if (/[_^\\$=<>]/.test(markdown.replace(INLINE_TAG_PATTERN, '')) && !/\$<\s*(?:sup|sub)\s*>/i.test(markdown)) {
    return displayMarkdownFallback(markdown, normalizeMarkdownMath(restoreInlineTags(protectedMarkdown)));
  }

  const protectedResult = restoreInlineTags(normalizeMarkdownMath(protectedMarkdown));

  return protectedResult;
}

// Only recognize MinerU's paired inline formatting tags. Other raw HTML stays literal.
export function remarkMineruInlineFormatting() {
  return (tree: unknown) => {
    const root = tree as MarkdownNode;

    if (root.children) {
      root.children = renderInlineTags(root.children, { remaining: MAX_INLINE_WORK });
    }
  };
}
