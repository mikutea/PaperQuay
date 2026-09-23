import { parseEntities } from 'parse-entities';
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
    const ignoredKeys = new Set([
      'type',
      'bbox',
      'path',
      'image_source',
      'table_type',
      'table_nest_level',
      'level',
      'text_level',
      'math_type',
      'list_type',
      'item_type',
      'bboxCoordinateSystem',
      'bboxPageSize',
    ]);

    return Object.entries(record).flatMap(([key, value]) => {
      if (ignoredKeys.has(key)) {
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

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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
): string {
  const content = getRecord(block.content);

  if (!content) {
    return joinReadableText(collectTextParts(block.content));
  }

  const preferredParts = preferredKeys.flatMap((key) => collectTextParts(content[key]));

  if (preferredParts.length > 0) {
    return joinReadableText(preferredParts);
  }

  return joinReadableText(collectTextParts(block.content));
}

function normalizeRawBlockType(rawType: unknown): string {
  const type = typeof rawType === 'string' ? rawType : 'paragraph';
  const lowerType = type.toLowerCase();

  if (lowerType.includes('title')) {
    return 'title';
  }

  if (lowerType.includes('table')) {
    return 'table';
  }

  if (lowerType.includes('image')) {
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

function renderInlineMarkdownContent(input: unknown): string {
  if (input == null) {
    return '';
  }

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return String(input);
  }

  if (Array.isArray(input)) {
    return input.map((item) => renderInlineMarkdownContent(item)).join('');
  }

  const record = getRecord(input);

  if (!record) {
    return '';
  }

  const nodeType = typeof record.type === 'string' ? record.type.toLowerCase() : '';

  if (nodeType === 'text') {
    const textContent = record.content ?? record.text ?? record.value;
    return typeof textContent === 'string' ? textContent : renderInlineMarkdownContent(textContent);
  }

  if (nodeType === 'equation_inline') {
    const mathText = extractMathText(record);
    return mathText ? `$${mathText}$` : '';
  }

  if (nodeType.includes('equation')) {
    const mathText = extractMathText(record);
    return mathText ? `$$\n${mathText}\n$$` : '';
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
    'caption',
    'content',
    'value',
  ]) {
    if (!(key in record)) {
      continue;
    }

    const rendered = renderInlineMarkdownContent(record[key]);

    if (rendered) {
      return rendered;
    }
  }

  return Object.entries(record)
    .filter(([key]) => key !== 'type' && key !== 'math_type')
    .map(([, value]) => renderInlineMarkdownContent(value))
    .join('');
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

export function extractTableHtmlFromMineruBlock(
  block: PositionedMineruBlock,
): string | undefined {
  const content = getRecord(block.content);
  const html = content?.html ?? content?.table_body;

  return typeof html === 'string' && html.trim() ? html : undefined;
}

export function extractMineruAssetPathFromBlock(
  block: PositionedMineruBlock,
): string | undefined {
  const content = getRecord(block.content);
  const imageSource = getRecord(content?.image_source);
  const candidate =
    imageSource?.path ??
    content?.img_path ??
    content?.path ??
    content?.image_path;

  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

export function resolveMineruAssetPath(
  mineruPath: string,
  assetPath: string,
): string | undefined {
  if (!mineruPath.trim() || !assetPath.trim()) {
    return undefined;
  }

  if (/^[a-zA-Z]:[\\/]/.test(assetPath) || assetPath.startsWith('/') || assetPath.startsWith('\\')) {
    return assetPath;
  }

  if (/^[a-zA-Z]+:\/\//.test(assetPath)) {
    return assetPath;
  }

  if (mineruPath.startsWith('cloud:')) {
    return undefined;
  }

  return joinPath(getDirectoryPath(mineruPath), assetPath);
}

export function extractCaptionFromMineruBlock(block: PositionedMineruBlock): string {
  switch (block.type) {
    case 'table':
      return extractTypedContentText(block, ['table_caption', 'caption']);
    case 'image':
      return extractTypedContentText(block, ['image_caption', 'caption']);
    default:
      return '';
  }
}

function toMarkdownFragment(block: PositionedMineruBlock, plainText: string): string {
  const structuredMarkdown = renderInlineMarkdownContent(block.content).trim();
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
    case 'image':
      return `**图片说明** ${structuredMarkdown || safeText}`;
    case 'table':
      return `**表格说明** ${structuredMarkdown || safeText}`;
    case 'caption':
      return `> ${structuredMarkdown || safeText}`;
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

  if (lowerType.includes('equation')) {
    return 'equation';
  }

  if (lowerType.includes('table')) {
    return 'table';
  }

  if (lowerType.includes('image')) {
    return 'image';
  }

  if (lowerType.includes('list')) {
    return 'list';
  }

  return rawType;
}

function pickFlatContent(rawBlock: Record<string, unknown>): Record<string, unknown> {
  const contentKeys = [
    'text',
    'text_level',
    'table_body',
    'table_caption',
    'table_footnote',
    'image_caption',
    'image_footnote',
    'img_path',
    'code_body',
    'code_caption',
    'code_footnote',
    'sub_type',
  ];
  const content: Record<string, unknown> = {};

  for (const key of contentKeys) {
    if (key in rawBlock) {
      content[key] = rawBlock[key];
    }
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
  const type = typeof rawType === 'string' ? rawType : 'paragraph';
  const lowerType = type.toLowerCase();

  if (lowerType.includes('title')) {
    return 'title';
  }

  if (lowerType.includes('table')) {
    return 'table';
  }

  if (lowerType.includes('image')) {
    return 'image';
  }

  if (lowerType.includes('equation')) {
    return 'equation';
  }

  if (lowerType.includes('list')) {
    return 'list';
  }

  return 'paragraph';
}

function extractMiddleContent(rawBlock: Record<string, unknown>): Record<string, unknown> {
  const lines = Array.isArray(rawBlock.lines) ? rawBlock.lines : [];
  const spanTextParts = lines.flatMap((line) => {
    if (!line || typeof line !== 'object') {
      return [];
    }

    const spans = (line as Record<string, unknown>).spans;

    if (!Array.isArray(spans)) {
      return [];
    }

    return spans.flatMap((span) => {
      if (!span || typeof span !== 'object') {
        return [];
      }

      const rawSpan = span as Record<string, unknown>;

      return collectTextParts(
        rawSpan.content ?? rawSpan.text ?? rawSpan.latex ?? rawSpan.img_path ?? null,
      );
    });
  });

  return {
    text: joinReadableText(spanTextParts),
    raw_type: rawBlock.type,
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
    if (parsed.every(Array.isArray)) {
      return parsed.map((page, pageIndex) => {
        if (!Array.isArray(page)) {
          throw new Error(`第 ${pageIndex + 1} 页不是有效的块数组`);
        }

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

function extractMarkdownImage(value: string): { alt: string; path: string } | null {
  const match = value.match(/!\[([^\]]*)\]\(([^)]+)\)/);

  if (!match) {
    return null;
  }

  return {
    alt: match[1]?.trim() ?? '',
    path: match[2]?.trim().replace(/^<|>$/g, '') ?? '',
  };
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
  const sourceMarkdown = buffer.join('\n');
  const block = createMarkdownMineruBlock(sourceMarkdown);

  if (block) {
    // Display the original tagged Markdown; keep normalized content for translation fingerprints.
    if (/<\s*\/?\s*(?:sup|sub)\s*>/i.test(sourceMarkdown)) {
      block.readerMarkdownSource = sourceMarkdown.trim();
    }

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

export function extractTextFromMineruBlock(block: PositionedMineruBlock): string {
  if (block.type === 'table') {
    const caption = extractCaptionFromMineruBlock(block);
    const tableHtml = extractTableHtmlFromMineruBlock(block);

    return caption || (tableHtml ? stripHtml(tableHtml) : '');
  }

  if (block.type === 'image') {
    return extractTypedContentText(block, ['image_caption', 'image_footnote', 'caption']);
  }

  if (block.type === 'equation') {
    return extractMathText(block.content);
  }

  return joinReadableText(collectTextParts(block.content));
}

export function extractTranslatableMarkdownFromMineruBlock(
  block: PositionedMineruBlock,
): string {
  const plainText = extractTextFromMineruBlock(block);
  return toMarkdownFragment(block, plainText);
}

function mathTagContentToLatex(content: string): string {
  const openings: number[] = [];
  const unmatchedBraces = new Set<number>();
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\\') {
      index += 1;
    } else if (content[index] === '{') {
      openings.push(index);
    } else if (content[index] === '}') {
      if (openings.length) openings.pop();
      else unmatchedBraces.add(index);
    }
  }
  for (const index of openings) unmatchedBraces.add(index);

  const escapeRaw = (raw: string, offset: number) => {
    let result = '';
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index];
      if (character === '\\' && !escaped) {
        escaped = true;
        result += character;
        continue;
      }
      if (character === '$' && !escaped) {
        result += '{\\char"24}';
        continue;
      }
      if (!escaped && ('%#$&'.includes(character) || unmatchedBraces.has(offset + index))) {
        result += '\\';
      }
      result += character;
      escaped = false;
    }
    return result;
  };

  const escapeDecoded = (value: string) => [...value].map((character) => {
    switch (character) {
      case '<': return '\\lt ';
      case '>': return '\\gt ';
      case '&': return '\\&';
      case '%': return '\\%';
      case '$': return '{\\char"24}';
      case '#': return '\\#';
      case '_': return '\\_';
      case '{': return '\\{';
      case '}': return '\\}';
      case '\\': return '\\backslash ';
      case '^': return '\\hat{}';
      default: return character;
    }
  }).join('');

  let output = '';
  let cursor = 0;
  for (const match of content.matchAll(/&(?:#(?:[xX][0-9a-fA-F]{1,6}|\d{1,8})|[A-Za-z][A-Za-z0-9]{0,31});/g)) {
    const start = match.index ?? 0;
    output += escapeRaw(content.slice(cursor, start), cursor);
    const decoded = parseEntities(match[0]);
    output += decoded === match[0] ? escapeRaw(match[0], start) : escapeDecoded(decoded);
    cursor = start + match[0].length;
  }

  return output + escapeRaw(content.slice(cursor), cursor);
}

export function displayMathTagsAsLatex(body: string): string | null {
  let latex = mergeRepeatedEquationScripts(body);

  for (let depth = 0; depth < 32; depth += 1) {
    const next = latex.replace(
      /<\s*(sub|sup)\s*>([^<>]*)<\s*\/\s*\1\s*>/gi,
      (_match, tag: string, content: string) => `${tag.toLowerCase() === 'sub' ? '_' : '^'}{${mathTagContentToLatex(content)}}`,
    );

    if (next === latex) break;
    latex = next;
  }

  return /<\s*\/?\s*(?:sup|sub)\s*>/i.test(latex) ? null : latex;
}

function mergeRepeatedEquationScripts(body: string): string {
  const groupStarts = new Map<number, number>();
  const stack: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\') {
      index += 1;
    } else if (body[index] === '{') {
      stack.push(index);
    } else if (body[index] === '}' && stack.length) {
      groupStarts.set(index, stack.pop()!);
    }
  }

  let grouped = '';
  let cursor = 0;
  for (const match of body.matchAll(/<\s*(sub|sup)\s*>([^<>]*)<\s*\/\s*\1\s*>/gi)) {
    const start = match.index ?? 0;
    let closing = start - 1;
    while (closing >= cursor && /\s/.test(body[closing])) closing -= 1;
    const opening = groupStarts.get(closing);
    const script = match[1].toLowerCase() === 'sub' ? '_' : '^';
    if (opening === undefined || opening <= cursor || body[opening - 1] !== script) continue;
    grouped += body.slice(cursor, opening - 1) + `${script}{${body.slice(opening + 1, closing)}${mathTagContentToLatex(match[2])}}`;
    cursor = start + match[0].length;
  }
  grouped += body.slice(cursor);

  return grouped.replace(
    /([_^])(?:\{([^{}]+)\}|(\\(?:[A-Za-z]+|[^A-Za-z\s])|[\p{L}\p{N}]+))\s*<\s*(sub|sup)\s*>([^<>]*)<\s*\/\s*\4\s*>/giu,
    (match, script: string, braced: string | undefined, bare: string | undefined, tag: string, content: string) => {
      if ((script === '_' ? 'sub' : 'sup') !== tag.toLowerCase()) return match;
      const existing = braced ?? bare ?? '';
      return `${script}{${existing}${existing.startsWith('\\') ? ' ' : ''}${mathTagContentToLatex(content)}}`;
    },
  );
}

export function displayMarkdownFallback(source: string | undefined, normalized: string): string {
  if (!source) return normalized;

  // Markdown code fences are inert, including a closer longer than its opener.
  // Normalize only surrounding text; mid-line runs are not fences.
  const unquote = (line: string) => {
    let cursor = 0;
    let depth = 0;
    while (cursor < line.length) {
      let next = cursor;
      while (next - cursor < 3 && line[next] === ' ') next += 1;
      if (line[next] !== '>') break;
      cursor = next + 1;
      depth += 1;
      if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
    }
    return { content: line.slice(cursor), depth };
  };
  const fenceMarker = (line: string) => /^( {0,3})((?:[-+*]|\d+[.)]) +)?(`{3,}|~{3,})(?:[^\n]*)/.exec(line);
  const lines = /(?:`{3,}|~{3,})/.test(source) ? source.split(/(?<=\n)/) : [];
  if (lines.some((line) => fenceMarker(unquote(line).content))) {
    const renderOutsideFence = (text: string) => {
      const leading = text.match(/^\s*/)?.[0] ?? '';
      const trailing = text.match(/\s*$/)?.[0] ?? '';
      const body = text.slice(leading.length, text.length - trailing.length);
      return body
        ? leading + displayMarkdownFallback(body, normalizeMarkdownMath(body)) + trailing
        : text;
    };
    let output = '';
    let outside = '';
    let fenceLength = 0;
    let fenceCharacter = '';
    let fenceIndent = 0;
    let fenceQuoteDepth = 0;
    for (const line of lines) {
      const { content: quotedContent, depth: quoteDepth } = unquote(line);
      const marker = fenceMarker(quotedContent);
      const lineIndent = /^( *)/.exec(quotedContent)?.[1].length ?? 0;
      if (fenceLength > 0 && (quoteDepth !== fenceQuoteDepth ||
          (fenceIndent > 0 && quotedContent.trim() && lineIndent < fenceIndent))) {
        fenceLength = 0;
      }
      if (marker && fenceLength === 0) {
        output += renderOutsideFence(outside);
        outside = '';
        fenceIndent = marker[2] ? marker[1].length + marker[2].length : 0;
        fenceQuoteDepth = quoteDepth;
        fenceLength = marker[3].length;
        fenceCharacter = marker[3][0];
        output += line;
      } else if (fenceLength > 0) {
        output += line;
        const closing = /^( *)(`{3,}|~{3,})\s*$/.exec(quotedContent.trimEnd());
        if (closing && closing[1].length <= fenceIndent + 3 && closing[2][0] === fenceCharacter && closing[2].length >= fenceLength) {
          fenceLength = 0;
        }
      } else {
        outside += line;
      }
    }
    return output + renderOutsideFence(outside);
  }

  if (source.length > 65_536) {
    // Image/table fallbacks contain a caption-only fragment, unlike their
    // original Markdown source which can embed a remote image URL.
    return /^\*\*(?:图片说明|表格说明)\*\*/.test(normalized) ? normalized : source;
  }

  const literalFences = new Set([...source.matchAll(/\$[^$\n]*\$/g)].map(([fenced]) => fenced));
  for (let opening = source.indexOf('\\('); opening >= 0;) {
    const closing = source.indexOf('\\)', opening + 2);
    if (closing < 0) break;
    const parenthesized = source.slice(opening, closing + 2);
    const fenced = normalizeMarkdownMath(parenthesized);
    if (/^\$[^$\n]*\$$/.test(fenced)) literalFences.add(fenced);
    opening = source.indexOf('\\(', closing + 2);
  }
  const sourceHasDollar = source.includes('$');
  const sourceBodyCursors = new Map<string, number>();
  const isAuthoredFence = (fenced: string, body: string) => {
    let position = source.indexOf(body, sourceBodyCursors.get(body) ?? 0);
    while (position >= 0 && sourceSpans.some(([start, end]) => position >= start && position < end)) {
      position = source.indexOf(body, position + body.length);
    }
    if (position < 0) return literalFences.has(fenced);
    sourceBodyCursors.set(body, position + body.length);
    let left = position;
    while (left > 0 && /\s/.test(source[left - 1])) left -= 1;
    let right = position + body.length;
    while (right < source.length && /\s/.test(source[right])) right += 1;
    const before = source.slice(Math.max(0, left - 2), left);
    const after = source.slice(right, right + 2);
    return (before.endsWith('$') && after.startsWith('$')) || (before.endsWith('\\(') && after.startsWith('\\)'));
  };
  const renderInlineMath = (segment: string) => {
    const renderFence = (fenced: string, body: string) => {
      const isLiteralFence = isAuthoredFence(fenced, body);
      const isCurrencyProse = isLiteralFence && /^\s*\d/.test(body) && [...body.matchAll(/\s+/g)].length >= 2;

      if (!/(?:[_^=]|\\[A-Za-z])/.test(body) && (!isLiteralFence || isCurrencyProse)) {
        return isLiteralFence ? fenced : body;
      }

      const duplicateScript = /^([\s\S]*[_^](?:\{[^{}]+\}|[A-Za-z0-9]+))(<\s*(?:sub|sup)\s*>[\s\S]*)$/i.exec(body);
      if (duplicateScript && /<\s*\/\s*(?:sub|sup)\s*>\s*$/i.test(duplicateScript[2])) {
        return `$${duplicateScript[1]}$${duplicateScript[2]}`;
      }

      const latex = displayMathTagsAsLatex(body);
      return latex === null ? fenced : `$${latex}$`;
    };
    let output = '';
    let cursor = 0;
    let opening = -1;
    const tagToken = /<\s*(\/?)\s*(sub|sup)\s*>/giy;
    const tagStack: string[] = [];
    for (let index = 0; index < segment.length; index += 1) {
      if (segment[index] === '<') {
        tagToken.lastIndex = index;
        const tag = tagToken.exec(segment);
        if (tag) {
          if (tag[1]) {
            if (tagStack[tagStack.length - 1] === tag[2].toLowerCase()) tagStack.pop();
          } else {
            tagStack.push(tag[2].toLowerCase());
          }
          index = tagToken.lastIndex - 1;
          continue;
        }
      }
      if (tagStack.length > 0) continue;
      if (segment[index] !== '$') continue;
      let backslashes = 0;
      for (let previous = index - 1; segment[previous] === '\\'; previous -= 1) backslashes += 1;
      // A normalizer-created fence can end next to an escaped backtick;
      // never reinterpret an escaped dollar that was present in the source.
      if (backslashes % 2 !== 0 && (opening < 0 || sourceHasDollar)) continue;
      if (opening < 0) {
        opening = index;
        continue;
      }
      const body = segment.slice(opening + 1, index);
      if (!body.includes('\n') && /<\s*\/?\s*(?:sup|sub)\s*>/i.test(body)) {
        output += segment.slice(cursor, opening) + renderFence(segment.slice(opening, index + 1), body);
        cursor = index + 1;
      }
      opening = -1;
    }
    return output + segment.slice(cursor);
  };
  const renderOutsideCode = (segment: string) => {
    let output = '';
    let cursor = 0;

    for (const match of segment.matchAll(/\$\$([\s\S]*?)\$\$/g)) {
      const start = match.index ?? 0;
      const escaped = (position: number) => {
        let backslashes = 0;
        for (let previous = position - 1; segment[previous] === '\\'; previous -= 1) backslashes += 1;
        return backslashes % 2 !== 0;
      };
      output += renderInlineMath(segment.slice(cursor, start));
      const latex = escaped(start) || escaped(start + match[0].length - 2)
        ? null
        : displayMathTagsAsLatex(match[1]);
      output += latex === null ? match[0] : `$$${latex}$$`;
      cursor = start + match[0].length;
    }

    return output + renderInlineMath(segment.slice(cursor));
  };

  const codeSpans = (text: string) => {
    const delimiters = [...text.matchAll(/`+/g)].flatMap((match) => {
      let backslashes = 0;
      for (let index = (match.index ?? 0) - 1; text[index] === '\\'; index -= 1) {
        backslashes += 1;
      }
      const escaped = backslashes % 2;
      const length = match[0].length - escaped;
      return length > 0 ? [{ index: (match.index ?? 0) + escaped, length }] : [];
    });
    const nextSame = new Int32Array(delimiters.length).fill(-1);
    const nextByLength = new Map<number, number>();

    for (let index = delimiters.length - 1; index >= 0; index -= 1) {
      const length = delimiters[index].length;
      nextSame[index] = nextByLength.get(length) ?? -1;
      nextByLength.set(length, index);
    }

    const spans: Array<[number, number]> = [];
    for (let index = 0; index < delimiters.length; index += 1) {
      const closingIndex = nextSame[index];
      if (closingIndex < 0) continue;
      spans.push([delimiters[index].index, delimiters[closingIndex].index + delimiters[closingIndex].length]);
      index = closingIndex;
    }
    return spans;
  };

  let output = '';
  let cursor = 0;
  const normalizedSpans = codeSpans(normalized);
  const sourceSpans = codeSpans(source);

  for (let index = 0; index < normalizedSpans.length; index += 1) {
    const [start, end] = normalizedSpans[index];
    const sourceSpan = sourceSpans[index];
    output += renderOutsideCode(normalized.slice(cursor, start));
    output += sourceSpan
      ? source.slice(sourceSpan[0], sourceSpan[1])
      : normalized.slice(start, end);
    cursor = end;
  }

  return output + renderOutsideCode(normalized.slice(cursor));
}

export function buildRenderableBlocks(
  blocks: PositionedMineruBlock[],
  mineruPath?: string,
): RenderableMineruBlock[] {
  return blocks.map((block) => {
    const plainText = extractTextFromMineruBlock(block);
    const rawMathText = block.type === 'equation' ? extractMathText(block.content) : undefined;
    const mathText = rawMathText
      ? displayMathTagsAsLatex(rawMathText) ?? rawMathText
      : undefined;
    const tableHtml = block.type === 'table' ? extractTableHtmlFromMineruBlock(block) : undefined;
    const captionText =
      block.type === 'table' || block.type === 'image'
        ? extractCaptionFromMineruBlock(block)
        : undefined;
    const relativeAssetPath = extractMineruAssetPathFromBlock(block);

    return {
      block,
      plainText,
      markdown: displayMarkdownFallback(block.readerMarkdownSource, toMarkdownFragment(block, plainText)),
      mathText,
      tableHtml,
      captionText,
      assetPath:
        mineruPath && relativeAssetPath
          ? resolveMineruAssetPath(mineruPath, relativeAssetPath)
          : undefined,
      isInteractive: isValidBBox(block.bbox),
    };
  });
}
