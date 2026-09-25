import { createElement, isValidElement, type ReactNode } from 'react';
import { normalizeMarkdownMath } from '../../utils/markdown.ts';

const INLINE_TAG = /<\/?(?:sup|sub)[ \t]*>/gi;
const MAX_TAGS = 256;
const MAX_DEPTH = 32;
const MAX_CAPTION_LENGTH = 16_384;
const MAX_AST_NODES = 20_000;
const MAX_OVERFLOW_MATH_LENGTH = 16_384;

// Captions are plain text, not Markdown or trusted HTML. Only paired MinerU
// script tags become elements; everything else remains React-escaped text.
export function renderMineruInlineCaption(text: string, depth = 0): ReactNode[] {
  if (text.length > MAX_CAPTION_LENGTH || depth >= MAX_DEPTH) return [text];
  const tags = [...text.matchAll(INLINE_TAG)];
  if (tags.length > MAX_TAGS) return [text];

  const nesting: string[] = [];
  for (const tag of tags) {
    const name = /^<\/?(sup|sub)/i.exec(tag[0])![1].toLowerCase();
    if (tag[0][1] === '/') {
      if (nesting.length && nesting.pop() !== name) return [text];
    } else {
      nesting.push(name);
    }
  }

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
  let tagCount = 0;
  for (const _ of markdown.matchAll(INLINE_TAG)) {
    if (++tagCount > MAX_TAGS) {
      // Keep ordinary formulas working for realistic blocks, but do not feed
      // arbitrarily large tag floods into the existing math normalizer.
      return markdown.length <= MAX_OVERFLOW_MATH_LENGTH
        ? normalizeMarkdownMath(markdown)
        : markdown;
    }
  }
  if (!tagCount) return normalizeMarkdownMath(markdown);

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

function formatChildren(children: MarkdownNode[], depth: number, budget: { nodes: number }): MarkdownNode[] {
  if (depth >= MAX_DEPTH || children.length > budget.nodes) return children;
  budget.nodes -= children.length;

  // Pair script tags in one pass. Unmatched openers must not repeatedly scan
  // the rest of a large Markdown paragraph on Electron's renderer thread.
  const pairs = new Map<number, number>();
  const stack: Array<{ name: 'sup' | 'sub'; index: number }> = [];
  let tagCount = 0;
  for (let index = 0; index < children.length; index += 1) {
    const tag = scriptTag(children[index]);
    if (!tag) continue;
    if (++tagCount > MAX_TAGS) return children;
    if (tag.closing) {
      const opening = stack[stack.length - 1];
      if (!opening) continue;
      if (opening.name !== tag.name) return children;
      pairs.set(stack.pop()!.index, index);
    } else {
      stack.push({ name: tag.name, index });
    }
  }

  const formatRange = (start: number, end: number, level: number): MarkdownNode[] => {
    const output: MarkdownNode[] = [];
    for (let index = start; index < end; index += 1) {
      const node = children[index];
      const closing = level < MAX_DEPTH ? pairs.get(index) : undefined;
      if (closing !== undefined && closing < end) {
        const name = scriptTag(node)!.name;
        output.push({
          type: 'mineruInlineFormatting',
          data: { hName: name },
          children: formatRange(index + 1, closing, level + 1),
        });
        index = closing;
        continue;
      }
      if (node.children) node.children = formatChildren(node.children, level + 1, budget);
      output.push(node);
    }
    return output;
  };
  return formatRange(0, children.length, depth);
}

// The installed Markdown parser has already determined code, links, tables,
// formulas, and raw HTML boundaries. Do not re-implement that grammar here.
export function remarkMineruInlineFormatting() {
  return (tree: unknown) => {
    const root = tree as MarkdownNode;
    if (root.children) root.children = formatChildren(root.children, 0, { nodes: MAX_AST_NODES });
  };
}
