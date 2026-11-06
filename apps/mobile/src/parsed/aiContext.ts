import { fromMarkdown } from 'mdast-util-from-markdown';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { validateEntityData, verifyParsedDocument, type ParsedBlock } from '../../../../packages/sync-core/src/index.ts';
import { AiError } from '../ai/errors.ts';
import { AI_LIMITS } from '../ai/types.ts';
import { PdfError } from '../pdf/errors.ts';
import type { PdfAiContext, PdfVersion } from '../pdf/types.ts';
import type { VerifiedParsedDocument } from './cache.ts';
import { resolveParsedBlocks } from './resolve.ts';

type Selection = { scope: 'page'; pageIndex: number } | { scope: 'document' };
interface MarkdownNode { type: string; value?: string; alt?: string; children?: MarkdownNode[] }
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** No individual conversion or repeated continuation can grow an unbounded string. */
class TextBuffer {
  constructor(private readonly limit:number=AI_LIMITS.contextBytes){}
  private readonly chunks: string[] = [];
  bytes = 0;
  add(value: string): void {
    this.bytes += encoder.encode(value).byteLength;
    if (this.bytes > this.limit) throw new AiError('CONTEXT_TOO_LARGE');
    this.chunks.push(value);
  }
  value(): string { return this.chunks.join(''); }
}

function commentsOnly(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index++;
    if (index === value.length) return true;
    if (!value.startsWith('<!--', index)) return false;
    const end = value.indexOf('-->', index + 4);
    if (end < 0) return false;
    index = end + 3;
  }
  return true;
}

/** Resource-bearing TeX commands have no safe text-only representation here.
 * Do not evaluate macros or try to guess which argument is visible. */
function assertTextMath(value: string): void {
  const targets = new Set(['href', 'url', 'includegraphics', 'htmlData', 'htmlId', 'htmlClass', 'htmlStyle']);
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\\') continue;
    let end = index + 1;
    while (end < value.length && /[A-Za-z]/.test(value[end])) end++;
    if (targets.has(value.slice(index + 1, end))) throw new AiError('CONTEXT_INVALID');
    index = end === index + 1 ? end : end - 1;
  }
}

/** The AST owns link/image boundaries, including reference-style links. Never
 * inspect URL/title/definition fields, and never silently drop visible raw HTML. */
function markdownText(value: string, maxBytes:number=AI_LIMITS.contextBytes): string {
  const tree = fromMarkdown(value, { extensions: [math()], mdastExtensions: [mathFromMarkdown()] });
  const output = new TextBuffer(maxBytes); let visible = false, count = 0;
  const stack: { node: MarkdownNode; depth: number; closing?: string }[] = [{ node: tree as MarkdownNode, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.closing !== undefined) { output.add(item.closing); continue; }
    const { node, depth } = item;
    if (++count > 100_000 || depth > 64) throw new AiError('CONTEXT_INVALID');
    if (node.type === 'definition') continue;
    if (node.type === 'html') {
      if (!commentsOnly(node.value ?? '')) throw new AiError('CONTEXT_INVALID');
      continue;
    }
    if (node.type === 'image' || node.type === 'imageReference') {
      const alt = node.alt ?? ''; output.add(alt); visible ||= Boolean(alt.trim()); continue;
    }
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
      const text = node.value ?? ''; output.add(text); visible ||= Boolean(text.trim());
      if (node.type === 'code') output.add('\n\n');
      continue;
    }
    if (node.type === 'inlineMath' || node.type === 'math') {
      const latex = node.value ?? ''; assertTextMath(latex); visible ||= Boolean(latex.trim());
      output.add(node.type === 'math' ? '$$\n' + latex + '\n$$\n\n' : '$' + latex + '$'); continue;
    }
    if (node.type === 'break') { output.add('\n'); continue; }
    if (node.type === 'thematicBreak') { output.add('\n---\n'); continue; }
    const inline = ['root', 'emphasis', 'strong', 'delete', 'link', 'linkReference'].includes(node.type);
    const block = ['paragraph', 'heading', 'blockquote', 'list', 'listItem'].includes(node.type);
    if ((!inline && !block) || !Array.isArray(node.children)) throw new AiError('CONTEXT_INVALID');
    if (block) {
      if (node.type === 'listItem') output.add('- ');
      stack.push({ node, depth, closing: '\n\n' });
    }
    for (let index = node.children.length - 1; index >= 0; index--) stack.push({ node: node.children[index], depth: depth + 1 });
  }
  return visible ? output.value().trim() : '';
}

function blockText(block: ParsedBlock, convert: (value: string) => string, maxBytes:number=AI_LIMITS.contextBytes): string {
  const parts: string[] = [], seen = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const text = convert(value);
    if (text && !seen.has(text)) { seen.add(text); parts.push(text); }
  };
  if (block.kind === 'equation') {
    const latex = block.latex ?? ''; assertTextMath(latex);
    if (latex.trim()) parts.push('$$\n' + latex + '\n$$');
  } else if (block.kind === 'table' && block.table) {
    const table = block.table;
    const caption = convert(table.caption);
    const rows = table.rows.map((row) => ({ section: row.section, cells: row.cells.map((cell) => ({
      text: convert(cell.text), header: cell.header, rowSpan: cell.rowSpan, colSpan: cell.colSpan,
    })) }));
    if (caption || rows.some((row) => row.cells.some((cell) => Boolean(cell.text)))) {
      const output = new TextBuffer(maxBytes); output.add('[table]\n');
      if (caption) output.add('caption: ' + caption + '\n');
      for (const [rowIndex, row] of rows.entries()) {
        output.add('[' + row.section + '] row ' + (rowIndex + 1) + '\n');
        for (const [index, cell] of row.cells.entries()) output.add('cell ' + (index + 1)
          + ' [header=' + cell.header + ',rowSpan=' + cell.rowSpan + ',colSpan=' + cell.colSpan + ']: ' + cell.text + '\n');
      }
      parts.push(output.value().trim());
    }
    // OCR prose and notes can exist in addition to the grid. Do not discard them
    // just because a structured table is also present.
    add(block.markdown || block.text);
  } else {
    add(block.markdown || block.text);
    if (!parts.length) add(block.text);
  }
  add(block.caption); add(block.footnote);
  const output = new TextBuffer(maxBytes);
  for (const part of parts) { if (output.bytes) output.add('\n\n'); output.add(part); }
  return output.value();
}

/** Verifies the complete package on each use. This function performs no I/O and
 * never turns parser coverage into a claim of complete PDF text extraction. */
export async function createParsedAiContext(
  value: VerifiedParsedDocument, version: PdfVersion, pageCount: number, selection: Selection,
): Promise<PdfAiContext> {
  const target = { entityId: version.entityId, data: { ...version.data } };
  const chosen = { ...selection };
  const expectedDigest = value.digest;
  let verified: VerifiedParsedDocument;
  try { verified = await verifyParsedDocument(value.document); }
  catch { throw new AiError('CONTEXT_INVALID'); }
  if (verified.digest !== expectedDigest) throw new AiError('CONTEXT_INVALID');
  const document = verified.document;
  if (!uuid.test(target.entityId) || !validateEntityData('attachmentVersion', target.data).ok
    || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > AI_LIMITS.pages
    || document.paperId !== target.data.paperId || document.attachmentVersionId !== target.entityId
    || document.pdf.sha256 !== target.data.sha256 || document.pdf.sizeBytes !== target.data.sizeBytes
    || document.pdf.pageCount !== pageCount || (target.data.pageCount !== null && target.data.pageCount !== pageCount))
    throw new PdfError('VERSION_MISMATCH');
  if (!['page', 'document'].includes(chosen.scope)
    || (chosen.scope === 'page' && (!Number.isSafeInteger(chosen.pageIndex) || chosen.pageIndex < 0 || chosen.pageIndex >= pageCount)))
    throw new AiError('CONTEXT_INVALID');
  const memo = new Map<string, string>();
  const convert = (input: string): string => {
    const previous = memo.get(input); if (previous !== undefined) return previous;
    const text = markdownText(input); memo.set(input, text); return text;
  };
  const pages = new Map<number, TextBuffer>(); let bytes = 0;
  // A trie avoids serializing long cache keys and renders an inherited table only
  // once, even for thousands of empty continuation blocks. Output is still counted.
  interface Memo { children: Map<unknown, Memo>; text?: string }
  const rendered: Memo = { children: new Map() };
  const render = (block: ParsedBlock): string => {
    let slot = rendered;
    for (const key of [block.kind, block.text, block.markdown, block.latex, block.caption, block.footnote, block.table]) {
      let child = slot.children.get(key);
      if (!child) { child = { children: new Map() }; slot.children.set(key, child); }
      slot = child;
    }
    return slot.text ??= blockText(block, convert);
  };
  const blocks = resolveParsedBlocks(document);
  for (const block of blocks) {
    if (chosen.scope === 'page' && block.pageIndex !== chosen.pageIndex) continue;
    const text = render(block);
    if (!text.trim()) continue;
    const output = pages.get(block.pageIndex) ?? new TextBuffer();
    const separator = output.bytes ? '\n\n' : '';
    bytes += encoder.encode(separator + text).byteLength;
    if (bytes > AI_LIMITS.contextBytes) throw new AiError('CONTEXT_TOO_LARGE');
    output.add(separator); output.add(text); pages.set(block.pageIndex, output);
  }
  if (!pages.size) throw new AiError('TEXT_MISSING');
  return {
    paperId: document.paperId, attachmentVersionId: document.attachmentVersionId, sha256: document.pdf.sha256,
    scope: chosen.scope, totalPages: pageCount,
    pages: [...pages].sort(([left], [right]) => left - right).map(([pageIndex, text]) => ({ pageIndex, text: text.value() })),
    complete: false, label: (target.data.fileName + ' · 解析文本').slice(0, 512),
    textSource: { kind: 'parsed-document', packageDigest: verified.digest, parserName: 'mineru', parserModel: document.parser.model },
  };
}

/** Text-only extraction for explicit review captures; URLs and image bytes stay out of prompts. */
export function parsedMarkdownText(value:string):string{return markdownText(value,8*1024*1024);}
export function parsedBlockText(block:ParsedBlock):string{return blockText(block,parsedMarkdownText,8*1024*1024);}
