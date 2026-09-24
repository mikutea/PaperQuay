import { createElement, isValidElement, type ReactNode } from 'react';
import { parseEntities } from 'parse-entities';
import { displayMarkdownFallback, displayMathTagsAsLatex, fencedMarkdownLineStarts, mapOutsideLiteralHtmlBlocks } from '../../services/mineru.ts';
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
    return [parseEntities(text)];
  }

  const matches = [...text.matchAll(INLINE_TAG_PATTERN)];

  if (matches.length > MAX_INLINE_NODES) {
    return [parseEntities(text)];
  }

  const rendered: ReactNode[] = [];
  let cursor = 0;

  for (let index = 0; index < matches.length; index += 1) {
    if (--budget.remaining < 0) return [parseEntities(text)];
    const opening = matches[index];

    if (/^<\s*\//.test(opening[0])) {
      continue;
    }

    const name = opening[0].match(/(?:sup|sub)/i)?.[0].toLowerCase() as 'sup' | 'sub';
    let nesting = 1;
    let closingIndex = index + 1;

    for (; closingIndex < matches.length; closingIndex += 1) {
      if (--budget.remaining < 0) return [parseEntities(text)];
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
      rendered.push(parseEntities(text.slice(cursor, opening.index)));
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

  rendered.push(parseEntities(text.slice(cursor)));
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

export function normalizeMineruReaderMarkdown(markdown: string, splitAdjacentFences = true): string {
  if (!/<\s*\/?\s*(?:sup|sub)\s*>/i.test(markdown)) {
    return normalizeMarkdownMath(markdown);
  }

  const literalHtml = mapOutsideLiteralHtmlBlocks(markdown, normalizeMineruReaderMarkdown);
  if (literalHtml !== null) return literalHtml;

  // Four-space and tab-indented CommonMark code blocks are inert, including
  // indentation after a blockquote container prefix.
  const listMarker = /(?:[-+*]|\d{1,9}[.)])(?=[ \t])/y;
  const unquote = (line: string) => {
    let cursor = 0;
    while (cursor < line.length) {
      let next = cursor;
      while (next - cursor < 3 && line[next] === ' ') next += 1;
      if (line[next] === '>') {
        cursor = next + 1;
        if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
        continue;
      }
      listMarker.lastIndex = next;
      const list = listMarker.exec(line);
      if (!list) break;
      cursor = next + list[0].length + 1;
    }
    return line.slice(cursor);
  };
  const lines = markdown.split(/(?<=\n)/);
  // Indentation inside a fenced block is fenced content, not a new indented
  // code block. Keep the fence together before splitting out indented blocks.
  const fenceStarts = fencedMarkdownLineStarts(markdown);
  let lineStart = 0;
  const fencedLines = lines.map((line) => {
    const fenced = fenceStarts.has(lineStart);
    lineStart += line.length;
    return fenced;
  });
  let hasIndentedCode = false;
  let candidateBlank = true;
  let candidateInCode = false;
  for (const [index, line] of lines.entries()) {
    if (fencedLines[index]) {
      // The line after a fence is a new block boundary, even without a blank line.
      candidateBlank = true;
      candidateInCode = false;
      continue;
    }
    const content = unquote(line);
    const blank = content.trim() === '';
    const indented = /^(?: {4}|\t)/.test(content);
    if (indented && (candidateBlank || candidateInCode)) {
      hasIndentedCode = true;
      break;
    }
    candidateInCode = false;
    candidateBlank = blank;
  }
  if (hasIndentedCode) {
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
    for (const [index, line] of lines.entries()) {
      if (fencedLines[index]) {
        outside += line;
        inCode = false;
        previousBlank = true;
        continue;
      }
      const content = unquote(line);
      const blank = content.trim() === '';
      const indented = /^(?: {4}|\t)/.test(content);
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

  // A completed math fence followed by a tag must stay outside that formula.
  // Split at each paired tag so this exception cannot force later, unrelated
  // long math tokens through the protected-marker normalizer.
  const completedDollarFenceEnds = new Set<number>();
  let singleDollarOpen = false;
  let doubleDollarOpen = false;
  for (let index = 0; index < markdown.length;) {
    if (markdown[index] === '\\') {
      index += 2;
      continue;
    }
    if (markdown[index] !== '$') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (markdown[end] === '$') end += 1;
    for (let pair = index; pair + 1 < end; pair += 2) {
      if (doubleDollarOpen) completedDollarFenceEnds.add(pair + 1);
      doubleDollarOpen = !doubleDollarOpen;
    }
    if ((end - index) % 2 !== 0) {
      if (singleDollarOpen) completedDollarFenceEnds.add(end - 1);
      singleDollarOpen = !singleDollarOpen;
    }
    index = end;
  }
  const chunks: string[] = [];
  const stack: Array<{ name: string; adjacent: boolean; start: number }> = [];
  let chunkCursor = 0;
  let tagCount = 0;
  let pairedAdjacentFence = false;
  for (const tag of markdown.matchAll(INLINE_TAG_PATTERN)) {
    if (++tagCount > MAX_INLINE_NODES) return markdown;
    const name = /(?:sup|sub)/i.exec(tag[0])?.[0].toLowerCase() ?? '';
    if (/^<\s*\//.test(tag[0])) {
      const opening = stack[stack.length - 1];
      if (opening?.name !== name) continue;
      stack.pop();
      if (opening.adjacent && stack.length === 0) {
        pairedAdjacentFence = true;
        if (splitAdjacentFences) {
          const end = (tag.index ?? 0) + tag[0].length;
          if (opening.start > chunkCursor) chunks.push(markdown.slice(chunkCursor, opening.start));
          chunks.push(markdown.slice(opening.start, end));
          chunkCursor = end;
        }
      }
    } else {
      stack.push({ name, adjacent: stack.length === 0 && completedDollarFenceEnds.has((tag.index ?? 0) - 1), start: tag.index ?? 0 });
    }
  }
  if (splitAdjacentFences && chunks.length > 0) {
    if (chunkCursor < markdown.length) chunks.push(markdown.slice(chunkCursor));
    return chunks.map((chunk) => normalizeMineruReaderMarkdown(chunk, false)).join('');
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
  if (/[_^\\$=<>~]/.test(markdown.replace(INLINE_TAG_PATTERN, '')) && !pairedAdjacentFence) {
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
