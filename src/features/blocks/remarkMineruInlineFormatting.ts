import { createElement, isValidElement, type ReactNode } from 'react';
import { parseEntities } from 'parse-entities';
import { displayMarkdownFallback, displayMathTagsAsLatex, fencedMarkdownLineStarts, mapOutsideLiteralHtmlBlocks, markdownCodeSpans, normalizeMarkdownMathOutsideCodeSpans, splitMarkdownLinesPreservingEndings } from '../../services/mineru.ts';
import { normalizeMarkdownMath } from '../../utils/markdown.ts';

const INLINE_TAG_PATTERN = /<\/?(?:sup|sub)\s*>/gi;
const CAPTION_TAG_PATTERN = /<\/?(?:sup|sub)\s*>/gi;
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

  const matches = [...text.matchAll(CAPTION_TAG_PATTERN)];

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

  const match = /^<(\/?)(sup|sub)\s*>$/i.exec(node.value.trim());

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
  if (!/<\/?(?:sup|sub)\s*>/i.test(markdown)) {
    return normalizeMarkdownMath(markdown);
  }

  const literalHtml = mapOutsideLiteralHtmlBlocks(markdown, normalizeMineruReaderMarkdown);
  if (literalHtml !== null) return literalHtml;

  // Four-space and tab-indented CommonMark code blocks are inert, including
  // indentation after a blockquote container prefix.
  const listMarker = /(?:[-+*]|\d{1,9}[.)])(?=[ \t])/y;
  const thematicBreakAt = (line: string, start: number) => {
    let index = start;
    while (index - start < 3 && line[index] === ' ') index += 1;
    const marker = line[index];
    if (marker !== '*' && marker !== '-' && marker !== '_') return false;
    let count = 0;
    for (; index < line.length && line[index] !== '\r' && line[index] !== '\n'; index += 1) {
      if (line[index] === marker) count += 1;
      else if (line[index] !== ' ' && line[index] !== '\t') return false;
    }
    return count >= 3;
  };
  const unquote = (line: string) => {
    let cursor = 0;
    let column = 0;
    const mayEndThematic = /[-*_][ \t]*(?:\r\n|\r|\n)?$/.test(line);
    const advance = (end: number) => {
      while (cursor < end) {
        column += line[cursor] === '\t' ? 4 - column % 4 : 1;
        cursor += 1;
      }
    };
    while (cursor < line.length) {
      let next = cursor;
      while (next - cursor < 3 && line[next] === ' ') next += 1;
      if (line[next] === '>') {
        advance(next + 1);
        if (line[cursor] === ' ' || line[cursor] === '\t') advance(cursor + 1);
        continue;
      }
      if (mayEndThematic && thematicBreakAt(line, cursor)) break;
      listMarker.lastIndex = next;
      const list = listMarker.exec(line);
      if (!list) break;
      const markerEnd = next + list[0].length;
      advance(markerEnd);
      const markerColumn = column;
      let paddingEnd = markerEnd;
      let paddingColumn = column;
      while (line[paddingEnd] === ' ' || line[paddingEnd] === '\t') {
        paddingColumn += line[paddingEnd] === '\t' ? 4 - paddingColumn % 4 : 1;
        paddingEnd += 1;
        if (paddingColumn - markerColumn > 4) break;
      }
      advance(paddingColumn - markerColumn > 4 ? markerEnd + 1 : paddingEnd);
    }
    return line.slice(cursor);
  };
  const lines = splitMarkdownLinesPreservingEndings(markdown);
  const isIndentedCode = (content: string) => {
    let column = 0;
    for (const character of content) {
      if (character !== ' ' && character !== '\t') break;
      column += character === '\t' ? 4 - column % 4 : 1;
      if (column >= 4) return true;
    }
    return false;
  };
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
  let candidateSetextText = false;
  const endsStandaloneBlock = (content: string, precedingText: boolean) => {
    const line = content.replace(/\r\n$|[\r\n]$/, '').trimEnd();
    return /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line)
      || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(line)
      || (precedingText && /^ {0,3}(?:=+|-{1,2})[ \t]*$/.test(line));
  };
  for (const [index, line] of lines.entries()) {
    if (fencedLines[index]) {
      // The line after a fence is a new block boundary, even without a blank line.
      candidateBlank = true;
      candidateInCode = false;
      candidateSetextText = false;
      continue;
    }
    const content = unquote(line);
    const blank = content.trim() === '';
    const indented = isIndentedCode(content);
    if (indented && (candidateBlank || candidateInCode)) {
      hasIndentedCode = true;
      break;
    }
    candidateInCode = false;
    const standalone = endsStandaloneBlock(content, candidateSetextText);
    candidateBlank = blank || standalone;
    candidateSetextText = !blank && !indented && !standalone;
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
    let previousSetextText = false;
    for (const [index, line] of lines.entries()) {
      if (fencedLines[index]) {
        outside += line;
        inCode = false;
        previousBlank = true;
        previousSetextText = false;
        continue;
      }
      const content = unquote(line);
      const blank = content.trim() === '';
      const indented = isIndentedCode(content);
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
      const standalone = endsStandaloneBlock(content, previousSetextText);
      previousBlank = blank || standalone;
      previousSetextText = !blank && !indented && !standalone;
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
  const codeSpans = markdownCodeSpans(markdown, true);
  const htmlBoundary = (text: string, start: number) => {
    let quote = '';
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '<') {
        return { end: -1, nested: index };
      } else if (char === '>') {
        return { end: index, nested: -1 };
      }
    }
    return { end: -1, nested: -1 };
  };
  const insideHtmlTag = (text: string) => {
    const ranges: Array<[number, number]> = [];
    for (let start = text.indexOf('<'); start >= 0;) {
      if (!/^<\/?[A-Za-z]/.test(text.slice(start, start + 3))) {
        start = text.indexOf('<', start + 1);
        continue;
      }
      const { end, nested } = htmlBoundary(text, start);
      if (nested >= 0) { start = nested; continue; }
      if (end < 0) break;
      ranges.push([start, end + 1]);
      start = text.indexOf('<', end + 1);
    }
    let cursor = 0;
    return (position: number) => {
      while (ranges[cursor]?.[1] <= position) cursor += 1;
      return ranges[cursor] !== undefined && ranges[cursor][0] < position;
    };
  };
  const tagInsideHtml = insideHtmlTag(markdown);
  let codeSpanCursor = 0;
  let chunkCursor = 0;
  let tagCount = 0;
  let tagLineStart = 0;
  let tagLineEnd = markdown.indexOf('\n');
  let pairedAdjacentFence = false;
  for (const tag of markdown.matchAll(INLINE_TAG_PATTERN)) {
    const tagStart = tag.index ?? 0;
    while (tagLineEnd >= 0 && tagStart > tagLineEnd) {
      tagLineStart = tagLineEnd + 1;
      tagLineEnd = markdown.indexOf('\n', tagLineStart);
    }
    while (codeSpans[codeSpanCursor]?.[1] <= tagStart) codeSpanCursor += 1;
    if (fenceStarts.has(tagLineStart)) continue;
    if (codeSpans[codeSpanCursor]?.[0] <= tagStart && tagStart < codeSpans[codeSpanCursor][1]) continue;
    if (tagInsideHtml(tagStart)) continue;
    if (++tagCount > MAX_INLINE_NODES) {
      // The cap is also a complexity guard: avoid reprocessing a tag-heavy
      // string unless it contains an authored parenthesized/display formula.
      return /\\[([]/.test(markdown) ? normalizeMarkdownMathOutsideCodeSpans(markdown) : markdown;
    }
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
    const [, slash, name] = /<(\/?)(sup|sub)\s*>/i.exec(tag) ?? [];
    return name ? `<${slash ? '/' : ''}${name.toLowerCase()}>` : tag;
  };
  const tags: string[] = [];
  const readableMarkdown = markdown.replace(/\{PQInlineTag/g, `${MARKER_START}${MARKER_START}`);
  const readableCodeSpans = markdownCodeSpans(readableMarkdown, true);

  const protectAttributeTags = (text: string) => {
    let protectedAttributes = '';
    let last = 0;
    const openAttributeTags = new Map<string, number>();
    for (let start = text.indexOf('<'); start >= 0;) {
      if (!/^<\/?[A-Za-z]/.test(text.slice(start, start + 3))) {
        start = text.indexOf('<', start + 1);
        continue;
      }
      const { end, nested } = htmlBoundary(text, start);
      if (nested >= 0) { start = nested; continue; }
      if (end < 0) break;
      const opening = text.slice(start, end + 1);
      const named = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)\b/.exec(opening);
      const name = named?.[2].toLowerCase();
      const depth = name ? openAttributeTags.get(name) ?? 0 : 0;
      const closesProtectedTag = !!named?.[1] && depth === 1;
      const hasFormattingInAttribute = !named?.[1] && opening.search(/<\/?(?:sup|sub)\s*>/i) > 0;
      if (name && depth) {
        if (named?.[1]) {
          if (closesProtectedTag) openAttributeTags.delete(name);
          else openAttributeTags.set(name, depth - 1);
        } else if (!/\/>$/.test(opening)) {
          openAttributeTags.set(name, depth + 1);
        }
      } else if (name && hasFormattingInAttribute && !/\/>$/.test(opening)) {
        openAttributeTags.set(name, 1);
      }
      if (hasFormattingInAttribute || closesProtectedTag) {
        protectedAttributes += text.slice(last, start) + `${MARKER_START}${tags.length}${MARKER_END}`;
        tags.push(opening);
        last = end + 1;
      }
      start = text.indexOf('<', end + 1);
    }
    return protectedAttributes + text.slice(last);
  };
  const protectInlineTags = (text: string) => {
    const protectedAttributes = protectAttributeTags(text);
    const insideTag = insideHtmlTag(protectedAttributes);
    return protectedAttributes.replace(INLINE_TAG_PATTERN, (tag, offset: number) => {
      if (insideTag(offset)) return tag;
      const marker = `${MARKER_START}${tags.length}${MARKER_END}`;
      tags.push(tag);
      return marker;
    });
  };
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
  let wrapperCodeCursor = 0;
  while (search < readableMarkdown.length) {
    const start = readableMarkdown.indexOf('<', search);
    if (start < 0) break;
    const { end, nested } = htmlBoundary(readableMarkdown, start);
    if (nested >= 0) { search = nested; continue; }
    if (end < 0) break;
    while (readableCodeSpans[wrapperCodeCursor]?.[1] <= start) wrapperCodeCursor += 1;
    if (readableCodeSpans[wrapperCodeCursor]?.[0] <= start && start < readableCodeSpans[wrapperCodeCursor][1]) {
      search = end + 1;
      continue;
    }
    const opening = readableMarkdown.slice(start, end + 1);
    const kind = /^<div\s+class=["']formula["'](?=[\s/>])/i.test(opening)
      ? 'div'
      : /^<span\s+class=["']math["'](?=[\s/>])/i.test(opening) ? 'span' : null;

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
          : `${kind === 'div' ? '<div class="formula">' : '<span class="math">'}${safeMath}</${kind}>`;
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
  if (fenceStarts.size > 0 || (/[_^\\$=<>~]/.test(markdown.replace(INLINE_TAG_PATTERN, '')) && !pairedAdjacentFence)) {
    const safeSource = protectAttributeTags(readableMarkdown);
    const safeNormalized = protectAttributeTags(restoreInlineTags(protectedMarkdown));
    return restoreInlineTags(displayMarkdownFallback(safeSource, normalizeMarkdownMathOutsideCodeSpans(safeNormalized)));
  }

  const protectedResult = restoreInlineTags(normalizeMarkdownMathOutsideCodeSpans(protectedMarkdown));

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
