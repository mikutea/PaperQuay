import { createElement, isValidElement, type ReactNode } from 'react';
import { normalizeMarkdownMath } from '../../utils/markdown.ts';

const INLINE_TAG = /<\/?(?:sup|sub)[ \t]*>/gi;
const MAX_TAGS = 256;
const MAX_DEPTH = 32;
const MAX_CAPTION_LENGTH = 16_384;
const MAX_AST_NODES = 20_000;
const MAX_READER_MATH_LENGTH = 16_384;

// Captions are plain text, not Markdown or trusted HTML. Only paired MinerU
// script tags become elements; everything else remains React-escaped text.
export function renderMineruInlineCaption(text: string): ReactNode[] {
  if (text.length > MAX_CAPTION_LENGTH) return [text];
  const tags = [...text.matchAll(INLINE_TAG)];
  if (tags.length > MAX_TAGS) return [text];

  const root: ReactNode[] = [];
  const nesting: Array<{ name: 'sup' | 'sub'; children: ReactNode[] }> = [];
  let cursor = 0;
  for (const tag of tags) {
    const name = /^<\/?(sup|sub)/i.exec(tag[0])![1].toLowerCase();
    const current = nesting.length ? nesting[nesting.length - 1].children : root;
    current.push(text.slice(cursor, tag.index));
    if (tag[0][1] === '/') {
      if (!nesting.length || nesting[nesting.length - 1].name !== name) return [text];
      const closed = nesting.pop()!;
      const parent = nesting.length ? nesting[nesting.length - 1].children : root;
      parent.push(createElement(closed.name, { key: tag.index }, ...closed.children));
    } else {
      if (nesting.length >= MAX_DEPTH) return [text];
      nesting.push({ name: name as 'sup' | 'sub', children: [] });
    }
    cursor = tag.index + tag[0].length;
  }
  if (nesting.length) return [text];
  root.push(text.slice(cursor));
  return root;
}

export function plainMineruInlineCaption(text: string): string {
  const flatten = (node: ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(flatten).join('');
    return isValidElement<{ children?: ReactNode }>(node) ? flatten(node.props.children) : '';
  };
  return renderMineruInlineCaption(text).map(flatten).join('');
}

// Keep prose script tags for remark, while the existing math normalizer still
// handles formula wrappers, image fallbacks, and code boundaries as before.
export function normalizeMineruReaderMarkdown(markdown: string): string {
  if (markdown.length > MAX_READER_MATH_LENGTH) {
    let count = 0;
    for (const _ of markdown.matchAll(INLINE_TAG)) {
      if (++count > MAX_TAGS) return markdown;
    }
  }
  return normalizeMarkdownMath(markdown, true);
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hChildren?: HastNode[] };
}

interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

function scriptTag(node: MarkdownNode): { name: 'sup' | 'sub'; closing: boolean } | null {
  if (node.type !== 'html' || !node.value) return null;
  const match = /^<(\/)?(sup|sub)[ \t]*>$/i.exec(node.value);
  return match ? { name: match[2].toLowerCase() as 'sup' | 'sub', closing: !!match[1] } : null;
}

function formatMathScripts(value: string): string {
  if (value.length > MAX_CAPTION_LENGTH) return value;
  const tags = [...value.matchAll(INLINE_TAG)];
  if (!tags.length || tags.length > MAX_TAGS) return value;
  const root: string[] = [];
  const stack: Array<{ name: 'sup' | 'sub'; body: string[] }> = [];
  let cursor = 0;
  for (const tag of tags) {
    const current = stack.length ? stack[stack.length - 1].body : root;
    const segment = value.slice(cursor, tag.index);
    if (stack.length && /[{}\\$&#_^~]/.test(segment)) return value;
    current.push(stack.length ? segment.replace(/%/g, '\\%') : segment);
    const name = /^<\/?(sup|sub)/i.exec(tag[0])![1].toLowerCase() as 'sup' | 'sub';
    if (tag[0][1] === '/') {
      if (!stack.length || stack[stack.length - 1].name !== name) return value;
      const closed = stack.pop()!;
      const body = closed.body.join('');
      if (!body) return value;
      const parent = stack.length ? stack[stack.length - 1].body : root;
      parent.push(`${name === 'sub' ? '_' : '^'}{${body}}`);
    } else {
      if (stack.length >= MAX_DEPTH) return value;
      stack.push({ name, body: [] });
    }
    cursor = tag.index + tag[0].length;
  }
  if (stack.length) return value;
  root.push(value.slice(cursor));
  return root.join('');
}

function formatChildren(children: MarkdownNode[], depth: number, budget: { nodes: number }): MarkdownNode[] {
  if (depth >= MAX_DEPTH || children.length > budget.nodes) return children;
  budget.nodes -= children.length;

  // Pair script tags in one pass. Unmatched openers must not repeatedly scan
  // the rest of a large Markdown paragraph on Electron's renderer thread.
  const pairs = new Map<number, number>();
  const stack: Array<{ name: 'sup' | 'sub'; index: number }> = [];
  let tagCount = 0;
  let formatTags = true;
  for (let index = 0; index < children.length; index += 1) {
    const tag = scriptTag(children[index]);
    if (!tag) continue;
    if (++tagCount > MAX_TAGS) { formatTags = false; break; }
    if (tag.closing) {
      const opening = stack[stack.length - 1];
      if (!opening || opening.name !== tag.name) { formatTags = false; break; }
      pairs.set(stack.pop()!.index, index);
    } else {
      stack.push({ name: tag.name, index });
    }
  }
  if (stack.length) formatTags = false;
  // Reject a too-deep sequence before formatting any of its outer pairs.
  if (formatTags) {
    let activeDepth = 0;
    for (const node of children) {
      const tag = scriptTag(node);
      if (!tag) continue;
      activeDepth += tag.closing ? -1 : 1;
      if (activeDepth + depth > MAX_DEPTH) { formatTags = false; break; }
    }
  }
  if (!formatTags) pairs.clear();

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
      if ((node.type === 'inlineMath' || node.type === 'math') && node.value) {
        const formatted = formatMathScripts(node.value);
        node.value = formatted;
        const textNode = node.type === 'math'
          ? node.data?.hChildren?.[0]?.children?.[0]
          : node.data?.hChildren?.[0];
        if (textNode?.type === 'text') textNode.value = formatted;
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
