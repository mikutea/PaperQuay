import type { BlockTextMark, BlockTextRange, TextMarkupStyle } from '../../types/reader';
import { getSelectedTextRanges, getTextOffset, restoreTextRange } from '../../utils/textSelectionRanges.ts';

const CONTENT_SELECTOR = '[data-text-mark-content]';

export function captureBlockTextRanges(container: HTMLElement, selection: Range): BlockTextRange[] {
  const ranges: BlockTextRange[] = [];
  for (const content of container.querySelectorAll<HTMLElement>(CONTENT_SELECTOR)) {
    const blockId = content.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
    if (!blockId) continue;
    const selected = getSelectedTextRanges(content, selection);
    if (!selected.length) continue;
    const start = getTextOffset(content, selected[0].startContainer, selected[0].startOffset);
    const last = selected[selected.length - 1];
    const end = getTextOffset(content, last.endContainer, last.endOffset);
    const text = content.textContent?.slice(start, end) ?? '';
    if (text.trim()) ranges.push({ blockId, contentKey: content.dataset.textMarkContent!, start, end, text });
  }
  return ranges;
}

export function normalizeBlockTextMarks(value: unknown): BlockTextMark[] {
  if (!Array.isArray(value)) return [];
  return value.filter((mark): mark is BlockTextMark => Boolean(mark &&
    typeof mark.id === 'string' && typeof mark.blockId === 'string' && typeof mark.contentKey === 'string' &&
    Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.start >= 0 && mark.end > mark.start &&
    typeof mark.text === 'string' && mark.text.length === mark.end - mark.start &&
    (mark.style === 'highlight' || mark.style === 'underline') &&
    typeof mark.color === 'string' && /^#[0-9a-f]{6}$/i.test(mark.color)));
}

export function updateBlockTextMarks(
  marks: BlockTextMark[], ranges: BlockTextRange[], style: TextMarkupStyle | 'clear', color: string,
): BlockTextMark[] {
  const next = marks.filter((mark) => !ranges.some((range) =>
    mark.blockId === range.blockId && mark.contentKey === range.contentKey &&
    mark.start < range.end && mark.end > range.start && (style === 'clear' || mark.style === style),
  ));
  return style === 'clear' ? next : [...next, ...ranges.map((range) => ({ ...range, id: crypto.randomUUID(), style, color }))];
}

/** CSS highlights preserve the Markdown DOM, links, math, and native text selection. */
export function renderBlockTextMarks(container: HTMLElement, marks: BlockTextMark[], prefix: string): () => void {
  const registry = CSS.highlights;
  if (!registry || typeof Highlight === 'undefined') return () => undefined;
  const contents = new Map<string, Map<string, HTMLElement>>();
  for (const element of container.querySelectorAll<HTMLElement>(CONTENT_SELECTOR)) {
    const blockId = element.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
    if (!blockId) continue;
    const blockContents = contents.get(blockId) ?? new Map<string, HTMLElement>();
    blockContents.set(element.dataset.textMarkContent!, element);
    contents.set(blockId, blockContents);
  }
  const groups = new Map<string, { style: TextMarkupStyle; color: string; ranges: Range[] }>();
  for (const mark of normalizeBlockTextMarks(marks)) {
    const content = contents.get(mark.blockId)?.get(mark.contentKey);
    const range = content && restoreTextRange(content, mark.start, mark.end, mark.text);
    if (!range) continue;
    const key = `${prefix}-${mark.style}-${mark.color.slice(1)}`;
    const group = groups.get(key) ?? { style: mark.style, color: mark.color, ranges: [] };
    group.ranges.push(range);
    groups.set(key, group);
  }
  const stylesheet = document.createElement('style');
  stylesheet.textContent = Array.from(groups, ([name, group]) =>
    `::highlight(${name}) { ${group.style === 'highlight'
      ? `background-color: ${group.color}; color: #0f172a;`
      : `text-decoration: underline solid ${group.color} 2px;`} }`,
  ).join('\n');
  document.head.append(stylesheet);
  for (const [name, group] of groups) registry.set(name, new Highlight(...group.ranges));
  return () => {
    for (const name of groups.keys()) registry.delete(name);
    stylesheet.remove();
  };
}
