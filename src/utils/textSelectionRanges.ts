/** Read only the text-node portions of a selection, excluding ancestor boxes. */
export function getSelectedTextRanges(root: HTMLElement, selection: Range): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!selection.intersectsNode(node) || !node.textContent?.length) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (node === selection.startContainer) range.setStart(node, selection.startOffset);
    if (node === selection.endContainer) range.setEnd(node, selection.endOffset);
    // An element boundary can intersect a text node without selecting its text.
    if (selection.compareBoundaryPoints(Range.END_TO_START, range) >= 0 ||
        selection.compareBoundaryPoints(Range.START_TO_END, range) <= 0) continue;
    if (!range.collapsed) ranges.push(range);
  }
  return ranges;
}

export function getTextOffset(root: HTMLElement, node: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(node, offset);
  return before.toString().length;
}

export function restoreTextRange(root: HTMLElement, start: number, end: number, text: string): Range | null {
  if (start < 0 || end <= start || root.textContent?.slice(start, end) !== text) return null;
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const nextOffset = offset + (node.textContent?.length ?? 0);
    if (!started && start < nextOffset) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= nextOffset) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset = nextOffset;
  }
  return null;
}
