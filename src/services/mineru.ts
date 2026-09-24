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
      if (character === '<' && !escaped) {
        result += '\\lt ';
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

function containsOtherHtmlTag(content: string): boolean {
  let opening = -1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '<') {
      opening = index;
      continue;
    }
    if (content[index] !== '>' || opening < 0) continue;
    let cursor = opening + 1;
    while (cursor < index && /\s/.test(content[cursor])) cursor += 1;
    if (content[cursor] === '/') cursor += 1;
    while (cursor < index && /\s/.test(content[cursor])) cursor += 1;
    if (/[A-Za-z]/.test(content[cursor] ?? '')) {
      cursor += 1;
      while (cursor < index && /[A-Za-z0-9:-]/.test(content[cursor])) cursor += 1;
      if (cursor === index || (content[cursor] === '/' && cursor + 1 === index) || /\s/.test(content[cursor] ?? '')) return true;
    }
    opening = -1;
  }
  return false;
}

function replaceInnermostMathTags(body: string): string {
  const stack: Array<{ name: string; start: number; end: number; nested: boolean }> = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const tag of body.matchAll(/<\s*(\/?)\s*(sub|sup)\s*>/gi)) {
    const name = tag[2].toLowerCase();
    const start = tag.index ?? 0;
    if (!tag[1]) {
      if (stack.length) stack[stack.length - 1].nested = true;
      stack.push({ name, start, end: start + tag[0].length, nested: false });
      continue;
    }

    const opening = stack[stack.length - 1];
    if (!opening || opening.name !== name) continue;
    stack.pop();
    if (opening.nested) continue;

    const content = body.slice(opening.end, start);
    // A less-than relation is text; a different HTML tag is not math markup.
    if (containsOtherHtmlTag(content)) continue;
    replacements.push({
      start: opening.start,
      end: start + tag[0].length,
      value: `${name === 'sub' ? '_' : '^'}{${mathTagContentToLatex(content)}}`,
    });
  }

  if (!replacements.length) return body;
  let output = '';
  let cursor = 0;
  for (const replacement of replacements) {
    output += body.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  return output + body.slice(cursor);
}

export function displayMathTagsAsLatex(body: string): string | null {
  let latex = body;

  for (let depth = 0; depth < 32; depth += 1) {
    // Resolve inner tags first, then merge the now-visible script with any
    // script already attached to the same TeX atom on the next pass.
    const next = replaceInnermostMathTags(mergeRepeatedEquationScripts(latex));

    if (next === latex) break;
    latex = next;
  }

  return /<\s*\/?\s*(?:sup|sub)\s*>/i.test(latex) ? null : latex;
}

export function findHtmlTagEnd(source: string, opening: number, limit = source.length): number {
  let quote = '';
  for (let index = opening + 1; index < limit; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
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
  for (const match of body.matchAll(/<\s*(sub|sup)\s*>((?:[^<]|<(?![A-Za-z/]))*)<\s*\/\s*\1\s*>/gi)) {
    const start = match.index ?? 0;
    let closing = start - 1;
    while (closing >= cursor && /\s/.test(body[closing])) closing -= 1;
    const opening = groupStarts.get(closing);
    const script = match[1].toLowerCase() === 'sub' ? '_' : '^';
    if (opening === undefined || opening <= cursor || body[opening - 1] !== script) continue;
    const existing = body.slice(opening + 1, closing);
    if (containsOtherHtmlTag(match[2])) continue;
    const appended = mathTagContentToLatex(match[2]);
    const delimiter = /\\[A-Za-z]+$/.test(existing) && /^[A-Za-z]/.test(appended) ? ' ' : '';
    grouped += body.slice(cursor, opening - 1) + `${script}{${existing}${delimiter}${appended}}`;
    cursor = start + match[0].length;
  }
  grouped += body.slice(cursor);

  return grouped.replace(
    /([_^])(?:\{([^{}]+)\}|(\\(?:[A-Za-z]+|[^A-Za-z\s])|[^\s\\{}_^$]))\s*<\s*(sub|sup)\s*>((?:[^<]|<(?![A-Za-z/]))*)<\s*\/\s*\4\s*>/giu,
    (match, script: string, braced: string | undefined, bare: string | undefined, tag: string, content: string) => {
      if ((script === '_' ? 'sub' : 'sup') !== tag.toLowerCase()) return match;
      if (containsOtherHtmlTag(content)) return match;
      const existing = braced ?? bare ?? '';
      return `${script}{${existing}${existing.startsWith('\\') ? ' ' : ''}${mathTagContentToLatex(content)}}`;
    },
  );
}

// Line starts occupied by fenced code. Keep the opening quote/list container
// with the fence so an unclosed fence stops when that container ends.
export function fencedMarkdownLineStarts(source: string): Set<number> {
  const starts = new Set<number>();
  if (!/(?:`{3,}|~{3,})/.test(source)) return starts;

  type Container = { kind: 'quote' | 'list'; width: number };
  const listMarker = /(?:[-+*]|\d{1,9}[.)])[ \t]+/y;
  const openingPrefix = (line: string) => {
    const containers: Container[] = [];
    let cursor = 0;
    while (cursor < line.length) {
      const start = cursor;
      let next = cursor;
      while (next - start < 3 && line[next] === ' ') next += 1;
      if (line[next] === '>') {
        cursor = next + 1;
        if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
        containers.push({ kind: 'quote', width: 0 });
        continue;
      }
      listMarker.lastIndex = next;
      const list = listMarker.exec(line);
      if (!list) break;
      cursor = next + list[0].length;
      containers.push({ kind: 'list', width: cursor - start });
    }
    return { cursor, containers };
  };
  const continuation = (line: string, containers: Container[]) => {
    let cursor = 0;
    for (const container of containers) {
      if (container.kind === 'quote') {
        const start = cursor;
        while (cursor - start < 3 && line[cursor] === ' ') cursor += 1;
        if (line[cursor] !== '>') return null;
        cursor += 1;
        if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
      } else {
        let width = 0;
        while (width < container.width && (line[cursor] === ' ' || line[cursor] === '\t')) {
          width += line[cursor] === '\t' ? 4 : 1;
          cursor += 1;
        }
        if (width < container.width) return null;
      }
    }
    return cursor;
  };

  let fenceRun = '';
  let fenceContainers: Container[] = [];
  let fenceAllowsBlank = false;
  let lineStart = 0;
  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const line = source.slice(lineStart, newline < 0 ? source.length : newline).replace(/\r$/, '');
    const continued = fenceRun ? continuation(line, fenceContainers) : null;
    if (fenceRun && (continued !== null || (line.trim() === '' && fenceAllowsBlank))) {
      starts.add(lineStart);
      const content = (continued === null ? line : line.slice(continued)).trimEnd();
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
      if (closing && closing[1][0] === fenceRun[0] && closing[1].length >= fenceRun.length) fenceRun = '';
    } else {
      fenceRun = '';
      const { cursor, containers } = openingPrefix(line);
      const content = line.slice(cursor).trimEnd();
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(content);
      if (opening && (opening[1][0] !== '`' || !content.slice(opening[0].length).includes('`'))) {
        fenceRun = opening[1];
        fenceContainers = containers;
        fenceAllowsBlank = containers.every((part) => part.kind === 'list');
        starts.add(lineStart);
      }
    }
    lineStart = newline < 0 ? source.length : newline + 1;
  }
  return starts;
}

export function mapOutsideLiteralHtmlBlocks(source: string, transform: (text: string) => string): string | null {
  const lower = source.toLowerCase();
  const fencedLines = fencedMarkdownLineStarts(source);
  const blockStarts = /<!--|<\?|<!\[CDATA\[|<![A-Z]|<\/([A-Za-z][A-Za-z0-9-]*)\s*>|<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/g;
  const namedBlockTags = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option output p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));
  const lineStarts = [0];
  for (const newline of source.matchAll(/\n/g)) lineStarts.push((newline.index ?? 0) + 1);
  let lineCursor = 0;
  const blankLines = [...source.matchAll(/\n(?=[ \t]*\r?\n)/g)].map((match) => match.index ?? 0);
  let blankCursor = 0;
  const markerPositions = new Map<string, number[]>([
    ['-->', []], ['?>', []], [']]>', []],
    ['</pre>', []], ['</textarea>', []], ['</script>', []], ['</style>', []],
  ]);
  for (const match of lower.matchAll(/-->|\?>|\]\]>|<\/(?:pre|textarea|script|style)>/g)) {
    markerPositions.get(match[0])!.push(match.index ?? 0);
  }
  const markerCursors = new Map<string, number>();
  const nextMarker = (marker: string, after: number) => {
    const positions = markerPositions.get(marker)!;
    let index = markerCursors.get(marker) ?? 0;
    while (positions[index] < after) index += 1;
    markerCursors.set(marker, index);
    return positions[index] ?? -1;
  };
  let output = '';
  let cursor = 0;
  let found = false;
  let mathWrapperUntil = 0;
  const wrapperClosers = {
    div: [...lower.matchAll(/<\/div>/g)].map((match) => match.index ?? 0),
    span: [...lower.matchAll(/<\/span>/g)].map((match) => match.index ?? 0),
  };
  const wrapperCloseCursor = { div: 0, span: 0 };
  const atBlockStart = (lineStart: number, opening: number) => {
    if (opening - lineStart > 256) return null;
    const containers: Array<{ kind: 'quote' | 'list'; width: number }> = [];
    let position = lineStart;
    while (position < opening) {
      const start = position;
      while (position - start < 3 && source[position] === ' ') position += 1;
      if (source[position] === '>') {
        position += 1;
        if (source[position] === ' ' || source[position] === '\t') position += 1;
        containers.push({ kind: 'quote', width: 0 });
        continue;
      }
      const marker = /(?:[-+*]|\d{1,9}[.)])[ \t]+/y;
      marker.lastIndex = position;
      const list = marker.exec(source);
      if (list && position + list[0].length <= opening) {
        position += list[0].length;
        containers.push({ kind: 'list', width: position - start });
        continue;
      }
      return position === opening ? containers : null;
    }
    return containers;
  };
  const containerEnd = (afterOpening: number, naturalEnd: number, containers: Array<{ kind: 'quote' | 'list'; width: number }>) => {
    if (containers.length === 0) return naturalEnd;
    const onlyLists = containers.every((container) => container.kind === 'list');
    let lineStart = source.indexOf('\n', afterOpening);
    while (lineStart >= 0 && lineStart + 1 < naturalEnd) {
      lineStart += 1;
      const nextLine = source.indexOf('\n', lineStart);
      if (onlyLists && !source.slice(lineStart, nextLine < 0 ? naturalEnd : nextLine).trim()) {
        lineStart = nextLine;
        continue;
      }
      let position = lineStart;
      for (const container of containers) {
        if (container.kind === 'quote') {
          const start = position;
          while (position - start < 3 && source[position] === ' ') position += 1;
          if (source[position] !== '>') return lineStart;
          position += 1;
          if (source[position] === ' ' || source[position] === '\t') position += 1;
        } else {
          let width = 0;
          while (width < container.width && (source[position] === ' ' || source[position] === '\t')) {
            width += source[position] === '\t' ? 4 : 1;
            position += 1;
          }
          // Blank lines may continue a list's raw HTML block without padding.
          if (width < container.width && source.slice(position, nextLine < 0 ? naturalEnd : nextLine).trim()) {
            return lineStart;
          }
        }
      }
      lineStart = nextLine;
    }
    return naturalEnd;
  };
  const renderOutside = (text: string) => {
    const leading = text.match(/^\s*/)?.[0] ?? '';
    const trailing = text.match(/\s*$/)?.[0] ?? '';
    const body = text.slice(leading.length, text.length - trailing.length);
    if (!body) return text;
    // Keep the indentation with the first content line so CommonMark can
    // recognize code immediately after a protected HTML block.
    if (/(?:^|\n)(?: {4,}|\t[ \t]*)$/.test(leading)) return transform(text);
    return leading + transform(body) + trailing;
  };
  const validCustomOpening = (start: number, end: number) => {
    let position = start + 1;
    while (/[A-Za-z0-9-]/.test(source[position] ?? '') && position < end) position += 1;
    while (position < end) {
      const spacing = position;
      while ((source[position] === ' ' || source[position] === '\t') && position < end) position += 1;
      if (source[position] === '/' && position + 1 === end) return true;
      if (position === end) return true;
      if (position === spacing || !/[A-Za-z_:]/.test(source[position] ?? '')) return false;
      position += 1;
      while (/[A-Za-z0-9:._-]/.test(source[position] ?? '') && position < end) position += 1;
      while ((source[position] === ' ' || source[position] === '\t') && position < end) position += 1;
      if (source[position] !== '=') continue;
      position += 1;
      while ((source[position] === ' ' || source[position] === '\t') && position < end) position += 1;
      const quote = source[position] === '"' || source[position] === "'" ? source[position++] : '';
      const valueStart = position;
      if (quote) {
        while (position < end && source[position] !== quote) position += 1;
        if (position === end) return false;
        position += 1;
      } else {
        while (position < end && !/[\s"'=<>`]/.test(source[position])) position += 1;
        if (position === valueStart) return false;
      }
    }
    return position === end;
  };
  const throughLineEnd = (end: number) => {
    const newline = source.indexOf('\n', end);
    return newline < 0 ? source.length : newline + 1;
  };
  for (const match of source.matchAll(blockStarts)) {
    const opening = match.index ?? 0;
    if (opening < cursor || opening < mathWrapperUntil) continue;
    while (lineStarts[lineCursor + 1] <= opening) lineCursor += 1;
    const lineStart = lineStarts[lineCursor];
    if (fencedLines.has(lineStart)) continue;
    const containers = atBlockStart(lineStart, opening);
    if (containers === null) continue;
    const tag = (match[2] ?? match[1] ?? '').toLowerCase();
    const specialEnding = match[0].startsWith('<!--') ? '-->'
      : match[0].startsWith('<?') ? '?>'
      : match[0].toLowerCase().startsWith('<![cdata[') ? ']]>' : '';
    const special = !tag;
    const openingLineEnd = source.indexOf('\n', opening);
    const openingEnd = specialEnding
      ? opening + match[0].length - 1
      : findHtmlTagEnd(source, opening, openingLineEnd < 0 ? source.length : openingLineEnd);
    if (openingEnd < 0) continue;
    const mathWrapper = tag === 'div' && /^<div\s+class=["']formula["'](?=[\s/>])/i.test(source.slice(opening, openingEnd + 1)) ? 'div'
      : tag === 'span' && /^<span\s+class=["']math["'](?=[\s/>])/i.test(source.slice(opening, openingEnd + 1)) ? 'span' : null;
    if (mathWrapper) {
      const positions = wrapperClosers[mathWrapper];
      while (positions[wrapperCloseCursor[mathWrapper]] < openingEnd + 1) wrapperCloseCursor[mathWrapper] += 1;
      const closing = positions[wrapperCloseCursor[mathWrapper]];
      if (closing !== undefined) {
        mathWrapperUntil = closing + mathWrapper.length + 3;
        continue;
      }
    }
    const typeOne = /^(?:pre|textarea|script|style)$/.test(tag);
    if (tag && !typeOne && !namedBlockTags.has(tag)) {
      if (match[2] && !validCustomOpening(opening, openingEnd)) continue;
      const lineEnd = source.indexOf('\n', openingEnd + 1);
      if (source.slice(openingEnd + 1, lineEnd < 0 ? source.length : lineEnd).trim()) continue;
      // CommonMark type-7 tags cannot interrupt an ordinary paragraph.
      if (lineCursor > 0 && !fencedLines.has(lineStarts[lineCursor - 1])) {
        const priorLine = source.slice(lineStarts[lineCursor - 1], lineStart).trimEnd();
        let position = 0;
        while (position < priorLine.length) {
          let marker = position;
          while (marker - position < 3 && priorLine[marker] === ' ') marker += 1;
          if (priorLine[marker] !== '>') break;
          position = marker + 1;
          if (priorLine[position] === ' ' || priorLine[position] === '\t') position += 1;
        }
        const priorContent = priorLine.slice(position);
        if (priorContent.trim() && cursor !== lineStart &&
            !/^ {0,3}(?:#{1,6}(?:[ \t]+|$)|(?:[-*_][ \t]*){3,}|(?:[-+*]|\d{1,9}[.)])[ \t]+|`{3,}|~{3,})/.test(priorContent)) continue;
      }
    }
    const closing = typeOne ? nextMarker(`</${tag}>`, openingEnd + 1)
      : specialEnding ? nextMarker(specialEnding, opening + match[0].length) : -1;
    while (blankLines[blankCursor] < openingEnd + 1) blankCursor += 1;
    const blankLine = typeOne || special ? undefined : blankLines[blankCursor];
    const naturalEnd = typeOne ? (closing < 0 ? source.length : throughLineEnd(closing + tag.length + 3))
      : specialEnding ? (closing < 0 ? source.length : throughLineEnd(closing + specialEnding.length))
      : special ? throughLineEnd(openingEnd + 1)
      : blankLine === undefined ? source.length : blankLine + 1;
    const blockEnd = containerEnd(openingEnd, naturalEnd, containers);
    output += renderOutside(source.slice(cursor, opening));
    cursor = blockEnd;
    output += source.slice(opening, cursor);
    found = true;
  }
  return found ? output + renderOutside(source.slice(cursor)) : null;
}

function isLineLevelCodePrefix(prefix: string): boolean {
  let cursor = 0;
  const whitespace = () => {
    while (prefix[cursor] === ' ' || prefix[cursor] === '\t') cursor += 1;
  };
  whitespace();
  while (prefix[cursor] === '>') {
    cursor += 1;
    whitespace();
  }
  let markerEnd = cursor;
  if (prefix[cursor] === '-' || prefix[cursor] === '+' || prefix[cursor] === '*') {
    markerEnd += 1;
  } else if (/[0-9]/.test(prefix[cursor] ?? '')) {
    while (markerEnd - cursor < 9 && /[0-9]/.test(prefix[markerEnd] ?? '')) markerEnd += 1;
    if (prefix[markerEnd] === '.' || prefix[markerEnd] === ')') markerEnd += 1;
    else markerEnd = cursor;
  }
  if (markerEnd > cursor && (prefix[markerEnd] === ' ' || prefix[markerEnd] === '\t')) {
    cursor = markerEnd;
    whitespace();
  }
  return cursor === prefix.length;
}

export function markdownCodeSpans(text: string, inlineOnly = false): Array<[number, number]> {
  const blankEnds = inlineOnly
    ? [...text.matchAll(/\r?\n[ \t]*\r?\n/g)].map((match) => (match.index ?? 0) + match[0].length)
    : [];
  let blankCursor = 0;
  let paragraph = 0;
  let lineStart = 0;
  let lineEnd = text.indexOf('\n');
  let lastDelimiterLine = -1;
  const delimiters = [...text.matchAll(/`+/g)].flatMap((match) => {
    const index = match.index ?? 0;
    while (blankEnds[blankCursor] <= (match.index ?? 0)) {
      blankCursor += 1;
      paragraph += 1;
    }
    while (lineEnd >= 0 && index > lineEnd) {
      lineStart = lineEnd + 1;
      lineEnd = text.indexOf('\n', lineStart);
    }
    const firstDelimiterOnLine = lastDelimiterLine !== lineStart;
    lastDelimiterLine = lineStart;
    // A line-level triple run is a fence or indented code, not an inline span.
    if (inlineOnly && firstDelimiterOnLine && match[0].length >= 3) {
      let previous = index - 1;
      while (previous >= lineStart && (text[previous] === ' ' || text[previous] === '\t')) previous -= 1;
      if (text[previous] !== '`' &&
          isLineLevelCodePrefix(text.slice(lineStart, index))) return [];
    }
    let backslashes = 0;
    for (let index = (match.index ?? 0) - 1; text[index] === '\\'; index -= 1) backslashes += 1;
    return [{ index: match.index ?? 0, length: match[0].length, escaped: backslashes % 2, paragraph }];
  });
  const nextSame = new Int32Array(delimiters.length).fill(-1);
  const nextByLength = new Map<number, number>();
  let nextParagraph = -1;
  for (let index = delimiters.length - 1; index >= 0; index -= 1) {
    const delimiter = delimiters[index];
    if (delimiter.paragraph !== nextParagraph) {
      nextByLength.clear();
      nextParagraph = delimiter.paragraph;
    }
    nextSame[index] = nextByLength.get(delimiter.length - delimiter.escaped) ?? -1;
    nextByLength.set(delimiter.length, index);
  }
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < delimiters.length; index += 1) {
    if (delimiters[index].length <= delimiters[index].escaped) continue;
    const closingIndex = nextSame[index];
    if (closingIndex < 0) continue;
    spans.push([delimiters[index].index + delimiters[index].escaped, delimiters[closingIndex].index + delimiters[closingIndex].length]);
    index = closingIndex;
  }
  return spans;
}

export function normalizeMarkdownMathOutsideCodeSpans(text: string): string {
  const spans = markdownCodeSpans(text, true);
  if (!spans.length) return normalizeMarkdownMath(text);
  const normalizeOutside = (segment: string) => {
    const leading = segment.match(/^\s*/)?.[0] ?? '';
    const trailing = segment.match(/\s*$/)?.[0] ?? '';
    const body = segment.slice(leading.length, segment.length - trailing.length);
    return body ? leading + normalizeMarkdownMath(body) + trailing : segment;
  };
  let output = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    output += normalizeOutside(text.slice(cursor, start)) + text.slice(start, end);
    cursor = end;
  }
  return output + normalizeOutside(text.slice(cursor));
}

export function displayMarkdownFallback(source: string | undefined, normalized: string): string {
  if (!source) return normalized;

  // Markdown code fences are inert, including a closer longer than its opener.
  // Use the same fence boundaries as the reader, including nested containers.
  const fencedLines = fencedMarkdownLineStarts(source);
  if (fencedLines.size) {
    const renderOutsideFence = (text: string) => {
      const leading = text.match(/^\s*/)?.[0] ?? '';
      const trailing = text.match(/\s*$/)?.[0] ?? '';
      const body = text.slice(leading.length, text.length - trailing.length);
      const closes = {
        div: [...body.matchAll(/<\/div>/gi)].map((match) => match.index ?? 0),
        span: [...body.matchAll(/<\/span>/gi)].map((match) => match.index ?? 0),
      };
      const closeCursor = { div: 0, span: 0 };
      let safeBody = '';
      let bodyCursor = 0;
      let search = 0;
      while (search < body.length) {
        const start = body.indexOf('<', search);
        if (start < 0) break;
        const end = findHtmlTagEnd(body, start);
        if (end < 0) break;
        const opening = body.slice(start, end + 1);
        const kind = /^<div\s+class=["']formula["'](?=[\s/>])/i.test(opening) ? 'div'
          : /^<span\s+class=["']math["'](?=[\s/>])/i.test(opening) ? 'span' : null;
        if (kind) {
          const positions = closes[kind];
          while (positions[closeCursor[kind]] < end + 1) closeCursor[kind] += 1;
          const closing = positions[closeCursor[kind]];
          if (closing !== undefined) {
            const closingEnd = closing + kind.length + 3;
            const inner = body.slice(end + 1, closing);
            const latex = displayMathTagsAsLatex(inner);
            safeBody += body.slice(bodyCursor, end + 1) + (latex ?? inner) + body.slice(closing, closingEnd);
            bodyCursor = closingEnd;
            search = bodyCursor;
            continue;
          }
        }
        search = end + 1;
      }
      safeBody += body.slice(bodyCursor);
      return body
        ? leading + displayMarkdownFallback(body, normalizeMarkdownMathOutsideCodeSpans(safeBody)) + trailing
        : text;
    };
    let output = '';
    let outside = '';
    let lineStart = 0;
    for (const line of source.split(/(?<=\n)/)) {
      if (fencedLines.has(lineStart)) {
        output += renderOutsideFence(outside);
        outside = '';
        output += line;
      } else {
        outside += line;
      }
      lineStart += line.length;
    }
    return output + renderOutsideFence(outside);
  }

  if (source.length > 65_536) {
    // Image/table fallbacks contain a caption-only fragment, unlike their
    // original Markdown source which can embed a remote image URL.
    return /^\*\*(?:图片说明|表格说明)\*\*/.test(normalized) ? normalized : source;
  }

  const literalHtml = mapOutsideLiteralHtmlBlocks(source, (text) => displayMarkdownFallback(text, normalizeMarkdownMathOutsideCodeSpans(text)));
  if (literalHtml !== null) return literalHtml;

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

      const duplicateScript = /^([\s\S]*([_^])(?:\{[^{}]+\}|[A-Za-z0-9]+))(<\s*(sub|sup)\s*>[\s\S]*)$/i.exec(body);
      if (!isLiteralFence && duplicateScript
        && (duplicateScript[2] === '_' ? 'sub' : 'sup') === duplicateScript[4].toLowerCase()
        && /<\s*\/\s*(?:sub|sup)\s*>\s*$/i.test(duplicateScript[3])) {
        return `$${duplicateScript[1]}$${duplicateScript[3]}`;
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

  let output = '';
  let cursor = 0;
  const inlineOnly = !source.includes('```');
  const normalizedSpans = markdownCodeSpans(normalized, inlineOnly);
  const sourceSpans = markdownCodeSpans(source, inlineOnly);

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
