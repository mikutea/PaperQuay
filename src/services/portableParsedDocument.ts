import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { buildRenderableBlocks, flattenMineruPages, parseMineruPages } from './mineru.ts';
import { verifyParsedDocument, type ParsedDocumentPackage } from '../../packages/sync-core/src/parsedDocument.ts';

type PortableBlock = ParsedDocumentPackage['blocks'][number];
type PortableAsset = ParsedDocumentPackage['assets'][number];
type HtmlNode = DefaultTreeAdapterMap['node'];
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const hidden = new Set(['script', 'style', 'link', 'meta', 'template']);
const portableCellTags = new Set(['td', 'th', 'a', 'span', 'div', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'small', 'code', 'pre']);
const markdownParser = unified().use(remarkParse);
type MarkdownNode = { type: string; url?: string; value?: string; children?: MarkdownNode[] };
function publicTarget(value: string): boolean {
  let target = value.trim();
  for (let count = 0; count < 4; count++) {
    try { const decoded = decodeURIComponent(target); if (decoded === target) break; target = decoded; }
    catch { return false; }
  }
  if (!target || /[\x00-\x1f\x7f\\]/.test(target)) return false;
  if (target.startsWith('#')) return true;
  try {
    const url = new URL(target);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
function inspectHtmlTargets(node: HtmlNode): void {
  // CSS and embedded document/event payloads have their own URL grammars.
  // This portable profile does not export them or claim to sanitize them.
  if (['style', 'script', 'meta', 'link'].includes(tag(node))) return fail('DESKTOP_PARSED_RESOURCE_INVALID');
  if ('attrs' in node) for (const attribute of node.attrs) {
    if (['style', 'srcdoc'].includes(attribute.name) || /^on[a-z]/i.test(attribute.name)) return fail('DESKTOP_PARSED_RESOURCE_INVALID');
    if (['src', 'href', 'data', 'poster', 'action', 'formaction', 'srcset', 'background', 'codebase', 'archive', 'classid'].includes(attribute.name) || attribute.name.endsWith(':href')) {
      // srcset is deliberately unsupported rather than parsed with a lossy
      // comma split; destinations can themselves contain commas.
      if (attribute.name === 'srcset' || !publicTarget(attribute.value)) return fail('DESKTOP_PARSED_RESOURCE_INVALID');
    }
  }
  for (const child of children(node)) inspectHtmlTargets(child);
}
/** Inspect destinations as syntax, not with a regex over ordinary prose.
 * Code samples and text mentioning C:/example retain their original meaning. */
export function assertPortableResourceTargets(value: string): void {
  const stack: MarkdownNode[] = [markdownParser.parse(value) as MarkdownNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (['link', 'image', 'definition'].includes(node.type) && (!node.url || !publicTarget(node.url))) return fail('DESKTOP_PARSED_RESOURCE_INVALID');
    if (node.type === 'html' && node.value) inspectHtmlTargets(parseFragment(node.value));
    if (node.children) stack.push(...node.children);
  }
}
function children(node: HtmlNode): HtmlNode[] { return 'childNodes' in node ? node.childNodes : []; }
function tag(node: HtmlNode): string { return 'tagName' in node ? node.tagName : ''; }
function visibleText(node: HtmlNode): string {
  if (hidden.has(tag(node))) return '';
  if (tag(node) && !portableCellTags.has(tag(node))) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return children(node).map(visibleText).join(' ').replace(/\s+/g, ' ').trim();
}
function findTable(node: HtmlNode): HtmlNode | undefined {
  if (hidden.has(tag(node))) return undefined;
  if (tag(node) === 'table') return node;
  for (const child of children(node)) { const found = findTable(child); if (found) return found; }
}
function span(node: HtmlNode, name: string, remainingRows: number): number {
  const value = 'attrs' in node ? node.attrs.find((attr) => attr.name === name)?.value : undefined;
  if (value === undefined) return 1;
  if (!/^\d+$/.test(value)) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
  const number = Number(value);
  if (name === 'rowspan' && number === 0) return remainingRows;
  if (!Number.isSafeInteger(number) || number < 1 || number > 10000) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
  return number;
}

/** Parse data, never HTML for injection. Ignore executable/hidden nodes and
 * retain table sections and span semantics instead of flattening the grid. */
export function portableTableFromHtml(html: string): NonNullable<PortableBlock['table']> {
  if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
  const fragment = parseFragment(html);
  const table = findTable(fragment);
  if (!table) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
  let tableCount = 0;
  const allNodes: HtmlNode[] = [fragment];
  while (allNodes.length) {
    const node = allNodes.pop()!;
    if (hidden.has(tag(node))) continue;
    if (tag(node) === 'table') tableCount++;
    allNodes.push(...children(node));
  }
  if (tableCount !== 1) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
  const outside: HtmlNode[] = [fragment];
  while (outside.length) {
    const node = outside.pop()!;
    if (node === table || hidden.has(tag(node))) continue;
    if (node.nodeName === '#text' && 'value' in node && node.value.trim()) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
    if (tag(node) && !['div', 'span'].includes(tag(node))) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
    outside.push(...children(node));
  }
  inspectHtmlTargets(table);
  const rows: NonNullable<PortableBlock['table']>['rows'] = [];
  function group(nodes: HtmlNode[], section: 'head' | 'body' | 'foot') {
    const rowNodes = nodes.filter((node) => tag(node) === 'tr');
    for (const [index, row] of rowNodes.entries()) {
      const cells = children(row).filter((node) => ['td', 'th'].includes(tag(node))).map((cell) => {
        if (children(cell).some((node) => findTable(node))) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
        return { text: visibleText(cell), rowSpan: span(cell, 'rowspan', rowNodes.length - index),
          colSpan: span(cell, 'colspan', rowNodes.length - index), header: tag(cell) === 'th' };
      });
      if (!cells.length) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
      rows.push({ section, cells });
      if (rows.length > 10000) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
    }
  }
  for (const child of children(table)) {
    const name = tag(child);
    if (name === 'tr') group([child], 'body');
    else if (['thead', 'tbody', 'tfoot'].includes(name)) group(children(child), name === 'thead' ? 'head' : name === 'tfoot' ? 'foot' : 'body');
  }
  if (!rows.length) return fail('DESKTOP_PARSED_TABLE_UNSUPPORTED');
  return { caption: children(table).filter((node) => tag(node) === 'caption').map((node) => children(node).map(visibleText).join(' ')).join(' '), rows };
}

export async function createPortableParsedDocument(input: {
  paperId: string;
  attachmentVersionId: string;
  pdf: ParsedDocumentPackage['pdf'];
  parser: ParsedDocumentPackage['parser'];
  jsonText: string;
  jsonPath: string;
  readAsset: (path: string, id: string) => Promise<PortableAsset>;
}): Promise<ParsedDocumentPackage> {
  const pages = parseMineruPages(input.jsonText);
  if (pages.length > input.pdf.pageCount) return fail('DESKTOP_PARSED_PAGE_MISMATCH');
  const positioned = flattenMineruPages(pages);
  if (!positioned.length || positioned.length > 20000) return fail('DESKTOP_PARSED_OUTPUT_INVALID');
  const rendered = buildRenderableBlocks(positioned, input.jsonPath);
  const blockIds = new Map(positioned.map((block, index) => [block.blockId, `b-${index + 1}`]));
  const assetIds = new Map<string, string>();
  const assets: PortableAsset[] = [];
  const blocks: PortableBlock[] = [];
  for (const [index, view] of rendered.entries()) {
    const source = view.block;
    for (const text of [view.plainText, view.markdown, view.captionText, view.tableFootnoteText])
      if (text) assertPortableResourceTargets(text);
    const kind: PortableBlock['kind'] = source.type === 'title' || source.type === 'heading' ? 'heading'
      : source.type === 'equation' ? 'equation' : source.type === 'table' ? 'table' : source.type === 'image' ? 'image' : 'text';
    const block: PortableBlock = { id: `b-${index + 1}`, pageIndex: source.pageIndex, kind, text: view.plainText };
    if (view.markdown) block.markdown = view.markdown;
    if (view.captionText) block.caption = view.captionText;
    if (view.tableFootnoteText) block.footnote = view.tableFootnoteText;
    if (source.contentSourceBlockId && blockIds.has(source.contentSourceBlockId)) block.sourceBlockId = blockIds.get(source.contentSourceBlockId)!;
    if (kind === 'equation' && view.mathText) block.latex = view.mathText;
    if (kind === 'table' && view.tableHtml) block.table = portableTableFromHtml(view.tableHtml);
    if (kind === 'image' && view.assetPath) {
      let id = assetIds.get(view.assetPath);
      if (!id) {
        id = `a-${assets.length + 1}`;
        const asset = await input.readAsset(view.assetPath, id);
        if (asset.id !== id) return fail('DESKTOP_PARSED_RESOURCE_INVALID');
        assets.push(asset); assetIds.set(view.assetPath, id);
      }
      block.assetId = id;
    }
    blocks.push(block);
  }
  // Only schema-owned fields leave this function: no raw OCR objects, bbox,
  // local paths, endpoint credentials, ZIP names, or untrusted HTML fields.
  const verified = await verifyParsedDocument({ format: 'paperquay-parsed-document', version: 1,
    paperId: input.paperId, attachmentVersionId: input.attachmentVersionId, pdf: input.pdf,
    parser: input.parser, blocks, assets });
  return verified.document;
}
