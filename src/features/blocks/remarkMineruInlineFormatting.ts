import { createElement, isValidElement, type ReactNode } from 'react';
import { normalizeMarkdownMath } from '../../utils/markdown.ts';

const INLINE_TAG = /<\/?(?:sup|sub)[ \t]*>/gi;
const MAX_TAGS = 256;
const MAX_DEPTH = 32;
const MAX_CAPTION_LENGTH = 16_384;

// Captions are plain text, not Markdown or trusted HTML. Only paired MinerU
// script tags become elements; everything else remains React-escaped text.
export function renderMineruInlineCaption(text: string, depth = 0): ReactNode[] {
  if (text.length > MAX_CAPTION_LENGTH || depth >= MAX_DEPTH) return [text];
  const tags = [...text.matchAll(INLINE_TAG)];
  if (tags.length > MAX_TAGS) return [text];

  const output: ReactNode[] = [];
  let cursor = 0;
  for (let index = 0; index < tags.length; index += 1) {
    const opening = tags[index];
    if (opening[0][1] === '/') continue;
    const name = /^<(sup|sub)/i.exec(opening[0])![1].toLowerCase() as 'sup' | 'sub';
    let nesting = 1;
    let closingIndex = index + 1;
    for (; closingIndex < tags.length; closingIndex += 1) {
      const candidate = tags[closingIndex][0];
      if (/<\/?(sup|sub)/i.exec(candidate)?.[1].toLowerCase() !== name) continue;
      nesting += candidate[1] === '/' ? -1 : 1;
      if (nesting === 0) break;
    }
    if (nesting !== 0) continue;
    const closing = tags[closingIndex];
    output.push(text.slice(cursor, opening.index));
    output.push(createElement(
      name,
      { key: opening.index },
      ...renderMineruInlineCaption(text.slice(opening.index + opening[0].length, closing.index), depth + 1),
    ));
    cursor = closing.index + closing[0].length;
    index = closingIndex;
  }
  output.push(text.slice(cursor));
  return output;
}

export function plainMineruInlineCaption(text: string): string {
  const flatten = (node: ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(flatten).join('');
    return isValidElement<{ children?: ReactNode }>(node) ? flatten(node.props.children) : '';
  };
  return renderMineruInlineCaption(text).map(flatten).join('');
}

// Protect only MinerU's script-tag syntax while the existing math normalizer runs.
// Markdown block, link, and code boundaries remain the parser's responsibility.
export function normalizeMineruReaderMarkdown(markdown: string): string {
  const tags = [...markdown.matchAll(INLINE_TAG)];
  if (!tags.length) return normalizeMarkdownMath(markdown);
  if (tags.length > MAX_TAGS) return markdown;

  let marker = 'PQInlineTag';
  for (let attempt = 0; markdown.includes(marker) && attempt < 4; attempt += 1) {
    marker += `Q${markdown.length.toString(36)}`;
  }
  if (markdown.includes(marker)) return markdown;

  const originals: string[] = [];
  const protectedMarkdown = markdown.replace(INLINE_TAG, (tag) => {
    originals.push(tag);
    return `{${marker}${originals.length - 1}}`;
  });
  return normalizeMarkdownMath(protectedMarkdown).replace(
    new RegExp(`\\{${marker}(\\d+)\\}`, 'g'),
    (_, index: string) => originals[Number(index)] ?? '',
  );
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string };
}

function scriptTag(node: MarkdownNode): { name: 'sup' | 'sub'; closing: boolean } | null {
  if (node.type !== 'html' || !node.value) return null;
  const match = /^<(\/)?(sup|sub)[ \t]*>$/i.exec(node.value);
  return match ? { name: match[2].toLowerCase() as 'sup' | 'sub', closing: !!match[1] } : null;
}

function formatChildren(children: MarkdownNode[], depth = 0): MarkdownNode[] {
  if (children.length > MAX_TAGS || depth >= MAX_DEPTH) return children;
  const output: MarkdownNode[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const opening = scriptTag(node);
    if (opening && !opening.closing) {
      let nesting = 1;
      let closingIndex = index + 1;
      for (; closingIndex < children.length; closingIndex += 1) {
        const candidate = scriptTag(children[closingIndex]);
        if (candidate?.name !== opening.name) continue;
        nesting += candidate.closing ? -1 : 1;
        if (nesting === 0) break;
      }
      if (nesting === 0) {
        output.push({
          type: 'mineruInlineFormatting',
          data: { hName: opening.name },
          children: formatChildren(children.slice(index + 1, closingIndex), depth + 1),
        });
        index = closingIndex;
        continue;
      }
    }
    if (node.children) node.children = formatChildren(node.children, depth + 1);
    output.push(node);
  }
  return output;
}

// The installed Markdown parser has already determined code, links, tables,
// formulas, and raw HTML boundaries. Do not re-implement that grammar here.
export function remarkMineruInlineFormatting() {
  return (tree: unknown) => {
    const root = tree as MarkdownNode;
    if (root.children) root.children = formatChildren(root.children);
  };
}
