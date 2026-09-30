import type {
  BBox,
  BBoxCoordinateSystem,
  BBoxPageSize,
  MineruBlockBase,
  MineruPage,
  PositionedMineruBlock,
  RenderableMineruBlock,
} from '../types/reader';
import { isValidBBox } from '../utils/bbox.ts';
import {
  normalizeLatexExpression,
  normalizeMarkdownMath,
  normalizeRawLatexExpression,
} from '../utils/markdown.ts';
import { joinReadableText } from '../utils/text.ts';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

const STRUCTURAL_CONTENT_KEYS = new Set([
  'type', 'bbox', 'path', 'img_path', 'image_path', 'image_source', 'asset_paths',
  'table_type', 'table_nest_level', 'level', 'text_level', 'math_type',
  'list_type', 'item_type', 'sub_type', 'raw_type', 'bboxCoordinateSystem', 'bboxPageSize',
]);

const IMAGE_CAPTION_KEYS = ['image_caption', 'chart_caption', 'figure_caption', 'caption', 'caption_content'];
const IMAGE_FOOTNOTE_KEYS = ['image_footnote', 'chart_footnote', 'figure_footnote'];
const VISUAL_NOTE_TEXT_KEYS = ['table_caption', ...IMAGE_CAPTION_KEYS, 'content', 'text', 'value'];
const VISUAL_NOTE_FOOTNOTE_KEYS = ['table_footnote', ...IMAGE_FOOTNOTE_KEYS];

type VisibleHtmlContent = {
  text: string; hasTable: boolean; captions: string[]; cells: string[]; footers: string[];
};
type TableContent = {
  html?: string;
  visible?: VisibleHtmlContent;
  readableBlock: PositionedMineruBlock;
};

function collectTextParts(input: unknown): string[] {
  if (input == null) {
    return [];
  }

  if (typeof input === 'string') {
    return [input];
  }

  if (typeof input === 'number' || typeof input === 'boolean') {
    return [String(input)];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => collectTextParts(item));
  }

  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    return Object.entries(record).flatMap(([key, value]) => {
      if (STRUCTURAL_CONTENT_KEYS.has(key)) {
        return [];
      }

      return collectTextParts(value);
    });
  }

  return [];
}

function getRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function uniqueNonblankText(parts: string[]): string[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const value = part.trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function getVisibleHtmlContent(input: string): VisibleHtmlContent {
  const hiddenTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta']);
  const nodes: { node: DefaultTreeAdapterMap['node']; captionParts?: string[]; cellParts?: string[]; footerParts?: string[] }[] =
    [...parseFragment(input).childNodes].reverse().map((node) => ({ node }));
  const text: string[] = [];
  const captions: string[][] = [];
  const cells: string[][] = [];
  const footers: string[][] = [];
  let hasTable = false;
  while (nodes.length > 0) {
    let { node, captionParts, cellParts, footerParts } = nodes.pop()!;
    if ('tagName' in node && hiddenTags.has(node.tagName)) continue;
    if ('tagName' in node && node.tagName === 'table') hasTable = true;
    if ('tagName' in node && node.tagName === 'caption') {
      captionParts = [];
      captions.push(captionParts);
    }
    if ('tagName' in node && (node.tagName === 'td' || node.tagName === 'th')) {
      cellParts = [];
      cells.push(cellParts);
    }
    if ('tagName' in node && node.tagName === 'tfoot') {
      footerParts = [];
      footers.push(footerParts);
    }
    if (node.nodeName === '#text' && 'value' in node) {
      text.push(node.value);
      captionParts?.push(node.value);
      cellParts?.push(node.value);
      footerParts?.push(node.value);
    }
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        nodes.push({ node: node.childNodes[index], captionParts, cellParts, footerParts });
      }
    }
  }
  const normalize = (parts: string[]) => parts.join(' ').replace(/\s+/g, ' ').trim();
  return { text: normalize(text), hasTable, captions: captions.map(normalize).filter(Boolean), cells: cells.map(normalize).filter(Boolean), footers: footers.map(normalize).filter(Boolean) };
}

function removeSpelledMineruTokenNoise(value: string): string {
  const chars = ['t', 'e', 'x', 't', 'l', 'i', 's', 't'];
  const spacedTokenPattern = new RegExp(
    `(?:^|\s)${chars.join('[\s\u200b\u200c\u200d\ufeff_\-]*')}(?=\s|[\x00\u2022\u25cf\u25aa\u25ab\u25e6\ufffd])`,
    'gi',
  );

  return value.replace(spacedTokenPattern, ' ');
}

function getDirectoryPath(filePath: string): string {
  const lastSlashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));

  return lastSlashIndex >= 0 ? filePath.slice(0, lastSlashIndex) : '.';
}

function joinPath(basePath: string, ...segments: string[]): string {
  const normalizedBase = basePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedSegments = segments
    .filter(Boolean)
    .flatMap((segment) => segment.replace(/\\/g, '/').split('/'));
  const output: string[] = normalizedBase.split('/');

  for (const segment of normalizedSegments) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (output.length > 0) {
        output.pop();
      }
      continue;
    }

    output.push(segment);
  }

  if (/^[a-zA-Z]:$/.test(output[0] ?? '')) {
    return output.join('\\');
  }

  if (basePath.startsWith('\\') || basePath.startsWith('/')) {
    return `/${output.filter(Boolean).join('/')}`;
  }

  return output.join('/');
}

function extractTypedContentText(
  block: PositionedMineruBlock,
  preferredKeys: string[],
  allowFallback = true,
  preserveMath: boolean | 'plain' = false,
): string {
  const content = getRecord(block.content);

  if (!content) {
    return allowFallback ? joinReadableText(collectTextParts(block.content)) : '';
  }

  const preferredParts = uniqueNonblankText(preferredKeys
    .map((key) => key.endsWith('_footnote')
      ? renderTableFootnote(content[key])
      : preserveMath
        ? renderVisualCaption(content[key], false, preserveMath === 'plain')
        : joinReadableText(collectTextParts(content[key]))));

  if (preferredParts.length > 0) {
    return joinReadableText(preferredParts);
  }

  return allowFallback ? joinReadableText(collectTextParts(block.content)) : '';
}

function normalizeRawBlockType(rawType: unknown): string {
  const type = typeof rawType === 'string' ? rawType : 'paragraph';
  const lowerType = type.toLowerCase();

  if (/^(?:chart|figure|image|table)_(?:caption|footnote)$/.test(lowerType)) {
    return 'caption';
  }

  if (lowerType.includes('title')) {
    return 'title';
  }

  if (lowerType.includes('table')) {
    return 'table';
  }

  if (lowerType.includes('image')) {
    return 'image';
  }

  if (lowerType.includes('chart') || lowerType.includes('figure')) {
    return 'image';
  }

  if (lowerType.includes('equation')) {
    return 'equation';
  }

  if (lowerType.includes('list')) {
    return 'list';
  }

  return type;
}

function extractMathText(input: unknown): string {
  const record = getRecord(input);
  const candidates = [
    record?.math_content,
    record?.content,
    record?.latex,
    record?.text,
    record?.value,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return normalizeRawLatexExpression(candidate);
    }
  }

  return normalizeRawLatexExpression(joinReadableText(collectTextParts(input)));
}

function escapeMarkdownProse(value: string): string {
  return value.replace(/[\\`*_{}\[\]#|$~]/g, '\\$&')
    .replace(/^([ \t]*)([-+>])(?=[ \t])/gm, '$1\\$2')
    .replace(/^([ \t]*\d+)([.)])(?=[ \t])/gm, '$1\\$2');
}

function renderInlineMarkdownContent(input: unknown, escapeProse = false, plainMath = false): string {
  if (input == null) {
    return '';
  }

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return escapeProse ? escapeMarkdownProse(String(input)) : String(input);
  }

  if (Array.isArray(input)) {
    return input.map((item) => renderInlineMarkdownContent(item, escapeProse, plainMath)).join('');
  }

  const record = getRecord(input);

  if (!record) {
    return '';
  }

  const nodeType = typeof record.type === 'string' ? record.type.toLowerCase() : '';

  if (nodeType === 'text') {
    const textContent = record.content ?? record.text ?? record.value;
    return typeof textContent === 'string'
      ? escapeProse ? escapeMarkdownProse(textContent) : textContent
      : renderInlineMarkdownContent(textContent, escapeProse, plainMath);
  }

  if (nodeType === 'equation_inline') {
    const mathText = extractMathText(record);
    return mathText ? plainMath ? mathText : `$${mathText}$` : '';
  }

  if (nodeType.includes('equation')) {
    const mathText = extractMathText(record);
    return mathText ? plainMath ? mathText : `$$\n${mathText}\n$$` : '';
  }

  for (const key of [
    'paragraph_content',
    'title_content',
    'list_content',
    'list_items',
    'item_content',
    'caption_content',
    'table_caption',
    'image_caption',
    'chart_caption',
    'figure_caption',
    'caption',
    'table_footnote',
    'image_footnote',
    'chart_footnote',
    'figure_footnote',
    'content',
    'value',
  ]) {
    if (!(key in record)) {
      continue;
    }

    const rendered = renderInlineMarkdownContent(record[key], escapeProse, plainMath);

    if (rendered) {
      return rendered;
    }
  }

  return Object.entries(record)
    .filter(([key]) => !STRUCTURAL_CONTENT_KEYS.has(key) && key !== 'html' && key !== 'table_body')
    .map(([, value]) => renderInlineMarkdownContent(value, escapeProse, plainMath))
    .join('');
}

function renderTableFootnote(input: unknown, escapeProse = false): string {
  return Array.isArray(input) && input.every((item) => typeof item === 'string')
    ? input.map((item) => renderInlineMarkdownContent(item, escapeProse).trim()).filter(Boolean).join(' ')
    : renderInlineMarkdownContent(input, escapeProse).trim();
}

function renderVisualCaption(input: unknown, escapeProse = false, plainMath = false): string {
  return Array.isArray(input) && input.every((item) => typeof item === 'string')
    ? input.map((item) => renderInlineMarkdownContent(item, escapeProse, plainMath).trim()).filter(Boolean).join(' ')
    : renderInlineMarkdownContent(input, escapeProse, plainMath).trim();
}

function renderCaptionMathPart(input: unknown, depth = 0): { markdown: string; hasMath: boolean } {
  const literal = (value: string) => value.replace(/[\\`*_{}\[\]()#+.!|$~-]/g, '\\$&');
  if (depth > 16) return { markdown: literal(renderVisualCaption(input)), hasMath: false };
  if (typeof input === 'string') return { markdown: literal(input), hasMath: false };
  if (Array.isArray(input)) {
    const parts = input.map((item) => renderCaptionMathPart(item, depth + 1));
    return {
      markdown: parts.map((part) => part.markdown).join(input.every((item) => typeof item === 'string') ? ' ' : ''),
      hasMath: parts.some((part) => part.hasMath),
    };
  }
  const record = getRecord(input);
  if (!record) return { markdown: literal(renderVisualCaption(input)), hasMath: false };
  if (record.type === 'equation_inline') {
    const math = extractMathText(record);
    if (math) return { markdown: `$${math}$`, hasMath: true };
  }
  for (const key of ['content', 'text', 'value', 'caption_content']) {
    if (key in record) return renderCaptionMathPart(record[key], depth + 1);
  }
  return { markdown: literal(renderVisualCaption(input)), hasMath: false };
}

function extractCaptionMathMarkdown(block: PositionedMineruBlock): string | undefined {
  const content = getRecord(block.content);
  if (!content) return undefined;
  const parts = ['table_caption', 'caption', 'caption_content']
    .filter((key) => key in content)
    .map((key) => renderCaptionMathPart(content[key]));
  return parts.some((part) => part.hasMath)
    ? uniqueNonblankText(parts.map((part) => part.markdown)).join(' ')
    : undefined;
}

function renderVisualMarkdownContent(
  input: unknown,
  excludeRawMarkdown = false,
  tableCellText = '',
): string {
  const record = getRecord(input);
  const nodeType = typeof record?.type === 'string' ? record.type.toLowerCase() : '';
  if (!record || nodeType === 'text' || nodeType.includes('equation')) {
    return renderInlineMarkdownContent(input, true).trim();
  }

  return uniqueNonblankText(Object.entries(record)
    .filter(([key]) =>
      !STRUCTURAL_CONTENT_KEYS.has(key) &&
      key !== 'html' && key !== 'table_body' &&
      !(excludeRawMarkdown && key === 'markdown'))
    .map(([key, value]) => {
      const rendered =
        key === 'markdown' ? renderInlineMarkdownContent(value) :
        key === 'table_footnote' || key === 'image_footnote' ||
        key === 'chart_footnote' || key === 'figure_footnote'
          ? renderTableFootnote(value, true)
          : renderVisualCaption(value, true);
      return tableCellText && ['content', 'text', 'value'].includes(key) && renderVisualCaption(value) === tableCellText
        ? ''
        : rendered;
    })
    .filter(Boolean))
    .join(' ');
}

function renderTableMarkdownContent(input: unknown, tableCellText: string, hasHtml: boolean): string {
  const record = getRecord(input);
  if (!record) return renderVisualMarkdownContent(input);
  const captionKeys = ['table_caption', 'caption', 'caption_content'];
  const caption = Object.fromEntries(captionKeys.map((key) => [key, record[key]]));
  const body = Object.fromEntries(Object.entries(record)
    .filter(([key]) => !captionKeys.includes(key) && key !== 'table_footnote'));
  return uniqueNonblankText([
    renderVisualMarkdownContent(caption),
    escapeMarkdownProse(tableCellText),
    renderVisualMarkdownContent(body, hasHtml, tableCellText),
    renderTableFootnote(record.table_footnote, true),
  ]).join(' ');
}

function renderOrderedVisualMarkdownContent(
  input: unknown, textKeys: string[], footnoteKeys: string[], excludeRawMarkdown = false,
): string {
  const record = getRecord(input);
  if (!record) return renderVisualMarkdownContent(input, excludeRawMarkdown);
  const otherKeys = Object.keys(record)
    .filter((key) => !textKeys.includes(key) && !footnoteKeys.includes(key));
  const ordered = Object.fromEntries([...textKeys, ...otherKeys, ...footnoteKeys]
    .map((key) => [key, record[key]]));
  return renderVisualMarkdownContent(ordered, excludeRawMarkdown);
}

function cleanMineruListText(value: string): string {
  return removeSpelledMineruTokenNoise(value)
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\btext\s*[_-]?\s*l\s*ist\s*text\b/gi, '')
    .replace(/\btext\s*[_-]\s*list\s*text\b/gi, '')
    .replace(/\btext\s*list\s*text\b/gi, '')
    .replace(/\btext\s*ist\s*text\b/gi, '')
    .replace(/\btextlist\s*text\b/gi, '')
    .replace(/\btext\s*(?=[\x00\u2022\u25cf\u25aa\u25ab\u25e6\ufffd*+-])/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMineruListMetadataNoise(value: string): boolean {
  const normalized = value
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();

  return normalized === 'text' || normalized === 'list' || normalized === 'textlist';
}
function splitBulletListItems(value: string): string[] {
  const cleaned = cleanMineruListText(value);

  if (!cleaned) {
    return [];
  }

  const normalized = cleaned
    .replace(/\s*[\x00\u2022\u25cf\u25aa\u25ab\u25e6\ufffd]\s*/g, '\n- ')
    .replace(/\btext\s+(?=[\u4e00-\u9fff])/gi, '\n- ')
    .replace(/\s+(?=\d+[.)]\s+)/g, '\n');

  return normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((line) => Boolean(line) && !isMineruListMetadataNoise(line));
}

function getMineruListItems(input: unknown): unknown[] {
  const record = getRecord(input);

  if (record) {
    if (Array.isArray(record.list_items)) {
      return record.list_items;
    }

    if (Array.isArray(record.list_content)) {
      return record.list_content;
    }

    if (Array.isArray(record.item_content)) {
      return [record.item_content];
    }

    if (Array.isArray(record.content)) {
      return record.content;
    }
  }

  return Array.isArray(input) ? input : [input];
}

export function renderListMarkdownContent(input: unknown): string {
  const rawItems = getMineruListItems(input);
  const items = rawItems.flatMap((item) => {
    const record = getRecord(item);
    const content = record?.item_content ?? record?.list_content ?? record?.content ?? item;

    return splitBulletListItems(renderInlineMarkdownContent(content));
  });

  return items.map((item) => `- ${item}`).join('\n');
}

function readTableHtml(block: PositionedMineruBlock) {
  const content = getRecord(block.content);
  const candidates = [...new Set([content?.html, content?.table_body]
    .filter((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate.trim())))]
    .map((html) => ({ html, visible: getVisibleHtmlContent(html) }));
  return candidates.find(({ visible }) => visible.hasTable && visible.cells.length > 0) ??
    candidates.find(({ visible }) => visible.hasTable && visible.text) ??
    candidates.find(({ visible }) => visible.text) ??
    candidates.find(({ visible }) => visible.hasTable);
}

export function extractTableHtmlFromMineruBlock(
  block: PositionedMineruBlock,
): string | undefined {
  return readTableHtml(block)?.html;
}

export function extractMineruAssetPathFromBlock(
  block: PositionedMineruBlock,
  mineruPath?: string,
): string | undefined {
  const content = getRecord(block.content);
  const imageSource = getRecord(content?.image_source);
  const candidate = [
    imageSource?.path, content?.img_path, content?.path, content?.image_path,
    ...(Array.isArray(content?.asset_paths) ? content.asset_paths : []),
  ].find((path) => typeof path === 'string' && path.trim() &&
    (!mineruPath || resolveMineruAssetPath(mineruPath, path.trim())));

  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

export function resolveMineruAssetPath(
  mineruPath: string,
  assetPath: string,
): string | undefined {
  if (!mineruPath.trim() || !assetPath.trim()) {
    return undefined;
  }

  if (mineruPath.startsWith('cloud:')) {
    return undefined;
  }

  const root = getDirectoryPath(mineruPath);
  const normalizedAsset = assetPath.replace(/\\/g, '/');
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(normalizedAsset) && !/^[a-zA-Z]:\//.test(normalizedAsset)) {
    return undefined;
  }
  if (normalizedAsset.split('/').includes('..')) {
    return undefined;
  }

  const absolute = /^[a-zA-Z]:\//.test(normalizedAsset) || normalizedAsset.startsWith('/');
  const candidate = absolute
    ? assetPath
    : root.startsWith('\\\\')
      ? `${root}\\${assetPath}`
      : joinPath(root, assetPath);
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const normalizedCandidate = candidate.replace(/\\/g, '/');
  const caseInsensitive = /^[a-zA-Z]:/.test(normalizedRoot) || normalizedRoot.startsWith('//');
  const boundary = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  const path = caseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  if (!path.startsWith(boundary === '/' ? '/' : `${boundary}/`)) {
    return undefined;
  }

  return candidate;
}

function withoutEmbeddedTableText(block: PositionedMineruBlock, visible?: VisibleHtmlContent): PositionedMineruBlock {
  const content = getRecord(block.content);
  if (!content || !visible) return block;
  const captions = new Set(visible.captions);
  const body = new Set([visible.text, visible.cells.join(' '), ...visible.cells, ...visible.footers]);
  return {
    ...block,
    content: Object.fromEntries(Object.entries(content).filter(([key, value]) => {
      const alreadyVisible = ['table_caption', 'caption', 'caption_content'].includes(key)
        ? captions : ['content', 'text', 'value', 'table_footnote'].includes(key) ? body : null;
      return !alreadyVisible || !alreadyVisible.has(renderVisualCaption(value).replace(/\s+/g, ' ').trim());
    })),
  };
}

function readTableContent(block: PositionedMineruBlock): TableContent | undefined {
  if (block.type !== 'table') return undefined;
  const parsed = readTableHtml(block);
  return {
    ...parsed,
    readableBlock: withoutEmbeddedTableText(block, parsed?.visible),
  };
}

function extractBlockCaption(block: PositionedMineruBlock): string {
  switch (block.type) {
    case 'table':
      return extractTypedContentText(block, ['table_caption', 'caption', 'caption_content'], false, 'plain');
    case 'image':
      return extractTypedContentText(block, IMAGE_CAPTION_KEYS, false, 'plain');
    default:
      return '';
  }
}

export function extractCaptionFromMineruBlock(block: PositionedMineruBlock): string {
  return extractBlockCaption(block);
}

function toMarkdownFragment(block: PositionedMineruBlock, plainText: string, table?: TableContent): string {
  const structuredMarkdown = renderInlineMarkdownContent(block.content).trim();
  const tableCellText = table?.visible?.text ?? '';
  const visualMarkdown =
    block.type === 'table'
      ? renderTableMarkdownContent(
        table?.readableBlock.content ?? block.content,
        tableCellText,
        Boolean(table?.html),
      )
      : block.type === 'image' ? renderOrderedVisualMarkdownContent(
        block.content, [...IMAGE_CAPTION_KEYS, 'content', 'text', 'value'], IMAGE_FOOTNOTE_KEYS, true,
      ) : '';
  const safeText = plainText || `未提取到 ${block.type} 文本`;

  switch (block.type) {
    case 'title':
      return `## ${structuredMarkdown || safeText}`;
    case 'list': {
      const listMarkdown = renderListMarkdownContent(block.content);
      const fallbackListMarkdown = renderListMarkdownContent(structuredMarkdown || safeText);

      return listMarkdown || fallbackListMarkdown || `- ${safeText}`;
    }
    case 'equation': {
      const mathText = extractMathText(block.content);
      return mathText ? `$$\n${mathText}\n$$` : structuredMarkdown || safeText;
    }
    case 'image': {
      const parsedImage = extractMarkdownImage(plainText);
      const rawMarkdown = getRecord(block.content)?.markdown;
      const markdownDescription = typeof rawMarkdown === 'string'
        ? stripMarkdownImagePaths(rawMarkdown)
        : '';
      const description = markdownDescription || visualMarkdown || (parsedImage ? parsedImage.alt : plainText);
      return description ? `**图片说明** ${description}` : '';
    }
    case 'table': {
      const tableText = visualMarkdown || plainText;
      return tableText ? `**表格说明** ${tableText}` : '';
    }
    case 'caption':
      return `> ${renderOrderedVisualMarkdownContent(block.content, VISUAL_NOTE_TEXT_KEYS, VISUAL_NOTE_FOOTNOTE_KEYS) || structuredMarkdown || safeText}`;
    default:
      return structuredMarkdown || safeText;
  }
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBBox(value: unknown): BBox | undefined {
  if (!Array.isArray(value) || value.length !== 4) {
    return undefined;
  }

  const numbers = value.map(toFiniteNumber);

  if (numbers.some((number) => number == null)) {
    return undefined;
  }

  const bbox = numbers as BBox;

  return isValidBBox(bbox) ? bbox : undefined;
}

function readPageSize(value: unknown): BBoxPageSize | undefined {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined;
  }

  const width = toFiniteNumber(value[0]);
  const height = toFiniteNumber(value[1]);

  if (!width || !height || width <= 0 || height <= 0) {
    return undefined;
  }

  return [width, height];
}

function readCoordinateSystem(
  value: unknown,
  fallback: BBoxCoordinateSystem,
): BBoxCoordinateSystem {
  return value === 'pdf' || value === 'normalized-1000' ? value : fallback;
}

function normalizeMineruBlock(
  input: unknown,
  pageIndex: number,
  blockIndex: number,
  fallbackCoordinateSystem: BBoxCoordinateSystem,
): MineruBlockBase {
  if (!input || typeof input !== 'object') {
    throw new Error(`第 ${pageIndex + 1} 页第 ${blockIndex + 1} 个块不是有效对象`);
  }

  const rawBlock = input as Record<string, unknown>;
  const bbox = readBBox(rawBlock.bbox);

  return {
    type: normalizeRawBlockType(rawBlock.type),
    content: rawBlock.content ?? null,
    bbox,
    bboxCoordinateSystem: readCoordinateSystem(
      rawBlock.bboxCoordinateSystem,
      fallbackCoordinateSystem,
    ),
    bboxPageSize: readPageSize(rawBlock.bboxPageSize),
  };
}

function mapFlatContentType(rawBlock: Record<string, unknown>): string {
  const rawType = typeof rawBlock.type === 'string' ? rawBlock.type : 'text';
  const lowerType = rawType.toLowerCase();
  const textLevel = toFiniteNumber(rawBlock.text_level);

  if (lowerType === 'text') {
    return textLevel && textLevel > 0 ? 'title' : 'paragraph';
  }

  if (/^(?:chart|figure|image|table)_(?:caption|footnote)$/.test(lowerType)) {
    return 'caption';
  }

  if (lowerType.includes('equation')) {
    return 'equation';
  }

  if (lowerType.includes('table')) {
    return 'table';
  }

  if (lowerType.includes('image')) {
    return 'image';
  }

  if (lowerType.includes('chart') || lowerType.includes('figure')) {
    return 'image';
  }

  if (lowerType.includes('list')) {
    return 'list';
  }

  return rawType;
}

function pickFlatContent(rawBlock: Record<string, unknown>): Record<string, unknown> {
  const blockType = mapFlatContentType(rawBlock);
  const isVisual = blockType === 'image' || blockType === 'table' || blockType === 'caption';
  const contentKeys = [
    'text',
    'text_level',
    'table_body',
    'html',
    'table_caption',
    'table_footnote',
    'caption',
    'caption_content',
    'value',
    'image_caption',
    'image_footnote',
    'chart_caption',
    'chart_footnote',
    'figure_caption',
    'figure_footnote',
    'img_path',
    'image_path',
    'path',
    'image_source',
    'code_body',
    'code_caption',
    'code_footnote',
    'sub_type',
  ];
  const content: Record<string, unknown> = {};

  for (const key of contentKeys) {
    if (!isVisual && /^(?:(?:image|chart|figure|table)_(?:caption|footnote)|caption(?:_content)?)$/.test(key)) {
      continue;
    }
    if (key === 'value' && !isVisual && typeof rawBlock.text === 'string' && rawBlock.text.trim()) {
      continue;
    }
    if (key in rawBlock) {
      content[key] = rawBlock[key];
    }
  }

  if (isVisual && 'content' in rawBlock) {
    content.content = rawBlock.content;
  }

  return Object.keys(content).length > 0 ? content : { value: rawBlock.content ?? null };
}

function parseFlatContentList(items: unknown[]): MineruPage[] {
  const pages: MineruPage[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const rawBlock = item as Record<string, unknown>;
    const rawPageIndex = toFiniteNumber(rawBlock.page_idx);
    const pageIndex = rawPageIndex != null && rawPageIndex >= 0 ? Math.floor(rawPageIndex) : 0;
    const page = pages[pageIndex] ?? [];

    page.push({
      type: mapFlatContentType(rawBlock),
      content: pickFlatContent(rawBlock),
      bbox: readBBox(rawBlock.bbox),
      bboxCoordinateSystem: 'normalized-1000',
    });

    pages[pageIndex] = page;
  }

  return pages.map((page) => page ?? []);
}

function mapMiddleBlockType(rawType: unknown): string {
  const type = normalizeRawBlockType(rawType);
  return ['title', 'table', 'image', 'caption', 'equation', 'list'].includes(type)
    ? type
    : 'paragraph';
}

function extractMiddleContent(rawBlock: Record<string, unknown>): Record<string, unknown> {
  const visualType = mapMiddleBlockType(rawBlock.type);
  const isVisual = visualType === 'image' || visualType === 'table';
  type Role = 'body' | 'caption' | 'footnote';
  const pending: { record: Record<string, unknown>; role: Role }[] = [{ record: rawBlock, role: 'body' }];
  const seen = new Set<Record<string, unknown>>();
  const records: Record<string, unknown>[] = [];
  const spans: Record<string, unknown>[] = [];
  const spanTextParts: string[] = [];
  const notes = { caption: [] as unknown[], footnote: [] as unknown[] };
  while (pending.length) {
    const { record, role: inheritedRole } = pending.pop()!;
    if (seen.has(record)) continue;
    seen.add(record);
    records.push(record);
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    const role: Role = isVisual && /^(?:image|chart|figure|table)_(?:caption|footnote)$/.test(type)
      ? type.endsWith('_caption') ? 'caption' : 'footnote' : inheritedRole;
    const lines = Array.isArray(record.lines) ? record.lines : [];
    for (const line of lines) {
      const items = getRecord(line)?.spans;
      const lineSpans = Array.isArray(items) ? items.map(getRecord).filter((item) => item !== null) : [];
      for (const span of lineSpans) spans.push(span);
      if (role === 'body') {
        for (const span of lineSpans) {
          for (const part of collectTextParts(span.content ?? span.text ?? span.latex ?? null)) spanTextParts.push(part);
        }
      } else {
        const inline = lineSpans.filter((span) => (span.content ?? span.text ?? span.latex) != null)
          .map((span) => ({
            type: span.type === 'inline_equation' ? 'equation_inline' :
              span.type === 'interline_equation' ? 'equation' : span.type ?? 'text',
            content: span.content ?? span.text ?? span.latex,
          }));
        if (inline.length) {
          if (notes[role].length) notes[role].push({ type: 'text', content: ' ' });
          for (const part of inline) notes[role].push(part);
        }
      }
    }
    if (isVisual && Array.isArray(record.blocks)) {
      for (let index = record.blocks.length - 1; index >= 0; index -= 1) {
        const child = getRecord(record.blocks[index]);
        if (child) pending.push({ record: child, role });
      }
    }
  }
  const imagePaths = [...records, ...spans].flatMap((record) => [
    record.img_path, record.image_path, record.path, getRecord(record.image_source)?.path,
  ])
    .filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
    .map((path) => path.trim());
  const html = visualType === 'table'
    ? spans.map((span) => span.html).find((value) => typeof value === 'string' && value.trim()) : undefined;

  return {
    text: joinReadableText(spanTextParts),
    raw_type: rawBlock.type,
    ...(notes.caption.length ? { caption: notes.caption } : {}),
    ...(notes.footnote.length ? { [visualType === 'table' ? 'table_footnote' : 'image_footnote']: notes.footnote } : {}),
    ...(html ? { html } : {}),
    ...(imagePaths.length ? { img_path: imagePaths[0], asset_paths: [...new Set(imagePaths)] } : {}),
  };
}

function parseMiddleJson(raw: Record<string, unknown>): MineruPage[] {
  if (!Array.isArray(raw.pdf_info)) {
    throw new Error('MinerU middle JSON 缺少 pdf_info 数组');
  }

  const pages: MineruPage[] = [];

  for (const pageInfo of raw.pdf_info) {
    if (!pageInfo || typeof pageInfo !== 'object') {
      continue;
    }

    const rawPage = pageInfo as Record<string, unknown>;
    const rawPageIndex = toFiniteNumber(rawPage.page_idx);
    const pageIndex = rawPageIndex != null && rawPageIndex >= 0 ? Math.floor(rawPageIndex) : pages.length;
    const pageSize = readPageSize(rawPage.page_size);
    const paraBlocks = Array.isArray(rawPage.para_blocks) ? rawPage.para_blocks : [];

    pages[pageIndex] = paraBlocks
      .filter((block) => block && typeof block === 'object')
      .map((block) => {
        const rawBlock = block as Record<string, unknown>;

        return {
          type: mapMiddleBlockType(rawBlock.type),
          content: extractMiddleContent(rawBlock),
          bbox: readBBox(rawBlock.bbox),
          bboxCoordinateSystem: 'pdf',
          bboxPageSize: pageSize,
        };
      });
  }

  return pages.map((page) => page ?? []);
}

export function parseMineruPages(payload: string | unknown): MineruPage[] {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;

  if (Array.isArray(parsed)) {
    const pageArrays = parsed.map((candidate) => {
      if (Array.isArray(candidate)) return candidate;
      const dictionary = getRecord(candidate);
      if (!dictionary || 'type' in dictionary) return null;
      const keys = Object.keys(dictionary);
      if (keys.length === 0 || !keys.every((key) =>
        /^\d+$/.test(key) && typeof getRecord(dictionary[key])?.type === 'string')) {
        return null;
      }
      return keys.sort((left, right) => Number(left) - Number(right)).map((key) => dictionary[key]);
    });

    if (pageArrays.every((page): page is unknown[] => Array.isArray(page))) {
      return pageArrays.map((page, pageIndex) => {
        return page.map((block, blockIndex) => {
          return normalizeMineruBlock(block, pageIndex, blockIndex, 'normalized-1000');
        });
      });
    }

    return parseFlatContentList(parsed);
  }

  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).pdf_info)) {
    return parseMiddleJson(parsed as Record<string, unknown>);
  }

  throw new Error('MinerU JSON 必须是 content_list_v2、content_list 或 middle JSON');
}

function isMarkdownTableBlock(value: string): boolean {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.length >= 2 &&
    lines.every((line) => line.startsWith('|') && line.endsWith('|')) &&
    lines.some((line) => /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line))
  );
}

function isMarkdownListLine(line: string): boolean {
  return /^(\s*)([-*+]|\d+[.)])\s+\S/.test(line);
}

function isMarkdownListContinuation(line: string): boolean {
  return /^\s{2,}\S/.test(line);
}

function stripMarkdownHeading(value: string): string {
  return value.replace(/^#{1,6}\s+/, '').trim();
}

function stripMathFence(value: string): string {
  const trimmed = value.trim();
  const displayMathMatch = trimmed.match(/^\$\$\s*([\s\S]*?)\s*\$\$$/);
  const bracketMathMatch = trimmed.match(/^\\\[\s*([\s\S]*?)\s*\\\]$/);

  return (displayMathMatch?.[1] ?? bracketMathMatch?.[1] ?? trimmed).trim();
}

function findMarkdownImage(value: string, from = 0): { start: number; end: number; alt: string; path: string } | null {
  for (let start = value.indexOf('![', from); start >= 0;) {
    let labelEnd = start + 2;
    while (labelEnd < value.length && value[labelEnd] !== ']') {
      if (value[labelEnd] === '\\') labelEnd += 1;
      labelEnd += 1;
    }
    if (labelEnd >= value.length) return null;
    if (value[labelEnd + 1] !== '(') {
      start = value.indexOf('![', labelEnd + 1);
      continue;
    }

    let depth = 1;
    let end = labelEnd + 2;
    while (end < value.length && depth > 0) {
      if (value[end] === '\\') {
        end += 2;
        continue;
      }
      if (value[end] === '(') depth += 1;
      if (value[end] === ')') depth -= 1;
      end += 1;
    }
    if (depth !== 0) return null;

    const path = value.slice(labelEnd + 2, end - 1).trim().replace(/^<|>$/g, '');
    if (!path) {
      start = value.indexOf('![', end);
      continue;
    }
    return { start, end, alt: value.slice(start + 2, labelEnd).trim(), path };
  }
  return null;
}

function extractMarkdownImage(value: string): { alt: string; path: string } | null {
  const image = findMarkdownImage(value);
  return image ? { alt: image.alt, path: image.path } : null;
}

function stripMarkdownImagePaths(value: string): string {
  let result = '';
  let from = 0;
  for (let image = findMarkdownImage(value, from); image; image = findMarkdownImage(value, from)) {
    result += value.slice(from, image.start) + image.alt;
    from = image.end;
  }
  return (result + value.slice(from)).trim();
}

function inferMarkdownBlockType(markdown: string): MineruBlockBase['type'] {
  const trimmed = markdown.trim();

  if (/^#{1,6}\s+\S/.test(trimmed)) {
    return 'title';
  }

  if (
    /^\$\$[\s\S]*\$\$$/.test(trimmed) ||
    /^\\\[[\s\S]*\\\]$/.test(trimmed) ||
    /^```(?:latex|tex|math|katex)\s*[\s\S]*```$/i.test(trimmed)
  ) {
    return 'equation';
  }

  if (isMarkdownTableBlock(trimmed) || /^<table[\s\S]*<\/table>$/i.test(trimmed)) {
    return 'table';
  }

  if (extractMarkdownImage(trimmed)) {
    return 'image';
  }

  const nonEmptyLines = trimmed.split('\n').filter((line) => line.trim());
  if (
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line, index) =>
      isMarkdownListLine(line) || (index > 0 && isMarkdownListContinuation(line))
    )
  ) {
    return 'list';
  }

  return 'paragraph';
}

function createMarkdownMineruBlock(markdown: string): MineruBlockBase | null {
  const normalizedMarkdown = normalizeMarkdownMath(markdown.trim());

  if (!normalizedMarkdown) {
    return null;
  }

  const type = inferMarkdownBlockType(normalizedMarkdown);

  if (type === 'title') {
    return {
      type,
      content: {
        markdown: normalizedMarkdown,
        title_content: stripMarkdownHeading(normalizedMarkdown),
      },
    };
  }

  if (type === 'equation') {
    return {
      type,
      content: {
        markdown: normalizedMarkdown,
        math_content: stripMathFence(normalizedMarkdown),
      },
    };
  }

  if (type === 'image') {
    const image = extractMarkdownImage(normalizedMarkdown);

    return {
      type,
      content: {
        markdown: normalizedMarkdown,
        image_caption: image?.alt ?? '',
        image_path: image?.path ?? '',
      },
    };
  }

  if (type === 'table') {
    return {
      type,
      content: {
        markdown: normalizedMarkdown,
        table_body: /^<table/i.test(normalizedMarkdown) ? normalizedMarkdown : undefined,
      },
    };
  }

  return {
    type,
    content: {
      markdown: normalizedMarkdown,
    },
  };
}

function flushMarkdownBlock(buffer: string[], blocks: MineruBlockBase[]): void {
  const block = createMarkdownMineruBlock(buffer.join('\n'));

  if (block) {
    blocks.push(block);
  }

  buffer.length = 0;
}

export function parseMineruMarkdownPages(markdownText: string): MineruPage[] {
  const text = markdownText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();

  if (!text) {
    return [];
  }

  const blocks: MineruBlockBase[] = [];
  const buffer: string[] = [];
  const lines = text.split('\n');
  let fencedBlock: { marker: string; isMath: boolean } | null = null;

  const flush = () => flushMarkdownBlock(buffer, blocks);

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)(.*)$/);

    if (fencedBlock) {
      buffer.push(line);

      if (trimmed.startsWith(fencedBlock.marker)) {
        flush();
        fencedBlock = null;
      }

      continue;
    }

    if (!trimmed) {
      flush();
      continue;
    }

    if (fenceMatch) {
      flush();
      buffer.push(line);
      fencedBlock = {
        marker: fenceMatch[1],
        isMath: /(?:latex|tex|math|katex)/i.test(fenceMatch[2] ?? ''),
      };
      continue;
    }

    if (trimmed.startsWith('$$')) {
      flush();
      buffer.push(line);

      if (!/^\$\$[\s\S]+\$\$$/.test(trimmed)) {
        fencedBlock = {
          marker: '$$',
          isMath: true,
        };
      } else {
        flush();
      }

      continue;
    }

    if (/^#{1,6}\s+\S/.test(trimmed)) {
      flush();
      buffer.push(line);
      flush();
      continue;
    }

    if (isMarkdownTableBlock(line)) {
      flush();
      buffer.push(line);
      flush();
      continue;
    }

    const currentIsTable = buffer.length > 0 && buffer.every((entry) => entry.trim().startsWith('|'));
    const lineIsTable = trimmed.startsWith('|') && trimmed.endsWith('|');

    if (lineIsTable) {
      if (!currentIsTable) {
        flush();
      }

      buffer.push(line);
      continue;
    }

    if (currentIsTable) {
      flush();
    }

    const currentIsList = buffer.length > 0 && isMarkdownListLine(buffer[0] ?? '');
    const lineIsList = isMarkdownListLine(line) || (currentIsList && isMarkdownListContinuation(line));

    if (lineIsList) {
      if (!currentIsList && buffer.length > 0) {
        flush();
      }

      buffer.push(line);
      continue;
    }

    if (currentIsList) {
      flush();
    }

    if (extractMarkdownImage(trimmed)) {
      flush();
      buffer.push(line);
      flush();
      continue;
    }

    buffer.push(line);
  }

  flush();

  return blocks.length > 0 ? [blocks] : [];
}

export function flattenMineruPages(pages: MineruPage[]): PositionedMineruBlock[] {
  const blocks = pages.flatMap((page, pageIndex) =>
    page.map((block, blockIndex) => ({
      ...block,
      blockId: `page-${pageIndex + 1}-block-${blockIndex + 1}`,
      pageIndex,
      blockIndex,
    })),
  );
  let lastTextParagraph: PositionedMineruBlock | null = null;

  return blocks.map((block) => {
    const blockText = extractTextFromMineruBlock(block).trim();
    const isEmptyParagraphContinuation =
      block.type === 'paragraph' &&
      Boolean(block.bbox) &&
      !blockText &&
      lastTextParagraph != null;

    if (isEmptyParagraphContinuation && lastTextParagraph) {
      return {
        ...block,
        contentSourceBlockId: lastTextParagraph.blockId,
      };
    }

    if (block.type === 'paragraph' && blockText) {
      lastTextParagraph = block;
    }

    return block;
  });
}

export function resolveMineruBlockContentSource(
  block: PositionedMineruBlock,
  blockById: Map<string, PositionedMineruBlock>,
): PositionedMineruBlock {
  return block.contentSourceBlockId
    ? blockById.get(block.contentSourceBlockId) ?? block
    : block;
}

function extractBlockText(block: PositionedMineruBlock, table?: TableContent): string {
  if (block.type === 'table') {
    const readableBlock = table?.readableBlock ?? block;
    const caption = extractTypedContentText(readableBlock,
      ['table_caption', 'caption', 'caption_content'], false, true);
    const content = getRecord(readableBlock.content);
    const markdown = content?.markdown;
    const footnote = renderTableFootnote(content?.table_footnote);
    const fallbackText = content
      ? [content.content, content.text, content.value]
        .map((candidate) => renderVisualCaption(candidate))
      : [renderVisualCaption(block.content)];
    const bodyText = table?.html
      ? uniqueNonblankText([table.visible?.text ?? '', ...fallbackText]).join(' ')
      : uniqueNonblankText([
        ...(typeof markdown === 'string' ? [markdown] : []), ...fallbackText,
      ]).join(' ');
    const tableText = [caption, bodyText].filter(Boolean).join(' ');
    return [tableText, footnote].filter(Boolean).join(' ');
  }

  if (block.type === 'image') {
    return extractTypedContentText(block, [
      ...IMAGE_CAPTION_KEYS, 'content', 'text', 'value', ...IMAGE_FOOTNOTE_KEYS,
    ], true, true);
  }

  if (block.type === 'caption') {
    return extractTypedContentText(block, [
      ...VISUAL_NOTE_TEXT_KEYS, ...VISUAL_NOTE_FOOTNOTE_KEYS,
    ], true, true);
  }

  if (block.type === 'equation') {
    return extractMathText(block.content);
  }

  return joinReadableText(collectTextParts(block.content));
}

export function extractTextFromMineruBlock(block: PositionedMineruBlock): string {
  return extractBlockText(block, readTableContent(block));
}

export function extractTranslatableMarkdownFromMineruBlock(
  block: PositionedMineruBlock,
): string {
  const table = readTableContent(block);
  const plainText = extractBlockText(block, table);
  return toMarkdownFragment(block, plainText, table);
}

export function buildRenderableBlocks(
  blocks: PositionedMineruBlock[],
  mineruPath?: string,
): RenderableMineruBlock[] {
  return blocks.map((block) => {
    const table = readTableContent(block);
    const plainText = extractBlockText(block, table);
    const mathText = block.type === 'equation' ? extractMathText(block.content) : undefined;
    const tableHtml = table?.html;
    const captionText =
      block.type === 'table' || block.type === 'image'
        ? extractBlockCaption(block)
        : undefined;
    const tableContent = table ? getRecord(table.readableBlock.content) : null;
    const tableFootnoteText = block.type === 'table'
      ? renderTableFootnote(tableContent?.table_footnote, true)
      : undefined;
    const alreadyVisible = new Set([
      table?.visible?.text ?? '',
      renderTableFootnote(tableContent?.table_footnote),
      ...['table_caption', 'caption', 'caption_content'].map((key) => renderVisualCaption(tableContent?.[key])),
    ]);
    const tableOcrMarkdown = tableHtml && tableContent
      ? uniqueNonblankText(['content', 'text', 'value']
        .filter((key) => !alreadyVisible.has(renderVisualCaption(tableContent[key])))
        .map((key) => renderVisualCaption(tableContent[key], true))).join(' ')
      : undefined;
    const relativeAssetPath = extractMineruAssetPathFromBlock(block, mineruPath);

    return {
      block,
      plainText,
      markdown: toMarkdownFragment(block, plainText, table),
      mathText,
      tableHtml,
      captionText,
      tableDisplayCaptionText: table ? extractBlockCaption(table.readableBlock) : undefined,
      captionMathMarkdown: table ? extractCaptionMathMarkdown(table.readableBlock) : undefined,
      tableFootnoteText,
      tableOcrMarkdown,
      assetPath:
        mineruPath && relativeAssetPath
          ? resolveMineruAssetPath(mineruPath, relativeAssetPath)
          : undefined,
      isInteractive: isValidBBox(block.bbox),
    };
  });
}
