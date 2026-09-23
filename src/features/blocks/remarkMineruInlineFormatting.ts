import { createElement, type ReactNode } from 'react';
import { normalizeMarkdownMath } from '../../utils/markdown.ts';

const MATH_HTML_PATTERN =
  /<div\s+class=["']formula["'][^>]*>.*?<\/div>|<span\s+class=["']math["'][^>]*>.*?<\/span>/gis;
const INLINE_TAG_PATTERN = /<\s*\/?\s*(?:sup|sub)\s*>/gi;
const PRENORMALIZED_TAG_MATH_PATTERN = /\$([^$\n]*<\/?(?:sup|sub)>[^$\n]*)\$/gi;

function recoverTagMathOutsideCode(text: string): string {
  return text.replace(PRENORMALIZED_TAG_MATH_PATTERN, (fenced, body: string) =>
    /<\s*(sup|sub)\s*>.*?<\s*\/\s*\1\s*>/i.test(body) ? body : fenced,
  );
}

function recoverTagMathOutsideInlineCode(line: string): string {
  const delimiters = [...line.matchAll(/`+/g)];
  let cursor = 0;
  let output = '';

  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index];
    const closingIndex = delimiters.findIndex(
      (candidate, nextIndex) => nextIndex > index && candidate[0].length === opening[0].length,
    );

    if (closingIndex < 0) {
      break;
    }

    const closing = delimiters[closingIndex];
    output += recoverTagMathOutsideCode(line.slice(cursor, opening.index));
    output += line.slice(opening.index, (closing.index ?? 0) + closing[0].length);
    cursor = (closing.index ?? 0) + closing[0].length;
    index = closingIndex;
  }

  return output + recoverTagMathOutsideCode(line.slice(cursor));
}

function recoverPreNormalizedTagMath(markdown: string): string {
  let fence: { marker: string; length: number } | null = null;

  return markdown.split('\n').map((line) => {
    const opening = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);

    if (fence) {
      if (
        opening &&
        opening[1][0] === fence.marker &&
        opening[1].length >= fence.length &&
        line.slice(opening[0].length).trim() === ''
      ) {
        fence = null;
      }

      return line;
    }

    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      return line;
    }

    return recoverTagMathOutsideInlineCode(line);
  }).join('\n');
}

export function renderMineruInlineCaption(text: string): ReactNode[] {
  const matches = [...text.matchAll(INLINE_TAG_PATTERN)];
  const rendered: ReactNode[] = [];
  let cursor = 0;

  for (let index = 0; index < matches.length; index += 1) {
    const opening = matches[index];

    if (/^<\s*\//.test(opening[0])) {
      continue;
    }

    const name = opening[0].match(/(?:sup|sub)/i)?.[0].toLowerCase() as 'sup' | 'sub';
    let depth = 1;
    let closingIndex = index + 1;

    for (; closingIndex < matches.length; closingIndex += 1) {
      const candidate = matches[closingIndex];

      if (!new RegExp(name, 'i').test(candidate[0])) {
        continue;
      }

      depth += /^<\s*\//.test(candidate[0]) ? -1 : 1;

      if (depth === 0) {
        break;
      }
    }

    if (depth === 0) {
      const closing = matches[closingIndex];
      rendered.push(text.slice(cursor, opening.index));
      rendered.push(createElement(
        name,
        { key: opening.index },
        ...renderMineruInlineCaption(text.slice(
          (opening.index ?? 0) + opening[0].length,
          closing.index,
        )),
      ));
      cursor = (closing.index ?? 0) + closing[0].length;
      index = closingIndex;
    }
  }

  rendered.push(text.slice(cursor));
  return rendered;
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

function renderInlineTags(children: MarkdownNode[]): MarkdownNode[] {
  const rendered: MarkdownNode[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const opening = readInlineTag(node);

    if (opening && !opening.closing) {
      let depth = 1;
      let closingIndex = index + 1;

      for (; closingIndex < children.length; closingIndex += 1) {
        const tag = readInlineTag(children[closingIndex]);

        if (tag?.name !== opening.name) {
          continue;
        }

        depth += tag.closing ? -1 : 1;

        if (depth === 0) {
          break;
        }
      }

      if (depth === 0) {
        rendered.push({
          type: 'mineruInlineFormatting',
          data: { hName: opening.name },
          children: renderInlineTags(children.slice(index + 1, closingIndex)),
        });
        index = closingIndex;
        continue;
      }
    }

    if (node.children) {
      node.children = renderInlineTags(node.children);
    }

    rendered.push(node);
  }

  return rendered;
}

export function normalizeMineruReaderMarkdown(markdown: string): string {
  const tags: string[] = [];
  // Markdown fallback blocks can arrive with spurious math fences already added by MinerU.
  const readableMarkdown = recoverPreNormalizedTagMath(markdown);
  let markerStart = '\uE200';

  while (readableMarkdown.includes(markerStart)) {
    markerStart += '\uE200';
  }

  const protectInlineTags = (text: string) => text.replace(INLINE_TAG_PATTERN, (tag) => {
    const marker = `${markerStart}${tags.length}\uE201`;
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

  const markerPattern = new RegExp(`${markerStart}(\\d+)\\uE201`, 'g');
  return normalizeMarkdownMath(protectedMarkdown).replace(markerPattern, (_marker, index: string) =>
    tags[Number(index)] ?? _marker,
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
