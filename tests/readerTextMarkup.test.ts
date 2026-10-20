import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPdfTextMarkup } from '../src/features/pdf/pdfTextMarkup.ts';
import { normalizeBlockTextMarks, updateBlockTextMarks } from '../src/features/blocks/blockTextMarks.ts';
import { loadPaperHistory, savePaperHistory } from '../src/utils/paperHistory.ts';
import type { BlockTextRange } from '../src/types/reader.ts';

const editorTypes = { HIGHLIGHT: 9, INK: 15 };
const selection = { pageIndex: 2, rects: [
  { x: 0.1, y: 0.2, width: 0.3, height: 0.02 },
  { x: 0.1, y: 0.3, width: 0.2, height: 0.02 },
] };
const viewport = { width: 600, height: 800, convertToPdfPoint: (x: number, y: number) => [x + 10, 820 - y] };

test('multi-line PDF highlights keep separate quads in cropped PDF coordinates', () => {
  const mark = buildPdfTextMarkup(selection, viewport, 'highlight', '#86efac', editorTypes);
  assert.equal(mark.pageIndex, 2);
  assert.equal(mark.annotationType, editorTypes.HIGHLIGHT);
  assert.deepEqual(mark.color, [134, 239, 172]);
  assert.deepEqual(mark.quadPoints?.map(value => Math.round(value * 1000) / 1000), [70, 660, 250, 660, 70, 644, 250, 644, 70, 580, 190, 580, 70, 564, 190, 564]);
  assert.deepEqual(mark.rect, [70, 564, 250, 660]);
});

test('underlines use thin exportable quads at the bottom of each line, including rotated pages', () => {
  const mark = buildPdfTextMarkup(selection, viewport, 'underline', '#16a34a', editorTypes);
  assert.equal(mark.annotationType, editorTypes.HIGHLIGHT);
  assert.equal(mark.quadPoints.length, 16);
  assert.deepEqual(mark.quadPoints.slice(0, 8), [70, 645.25, 250, 645.25, 70, 644, 250, 644]);
  const rotated = buildPdfTextMarkup(selection, { ...viewport, convertToPdfPoint: (x, y) => [y, x] }, 'underline', '#16a34a', editorTypes);
  assert.deepEqual(rotated.quadPoints.slice(0, 8), [174.75, 240, 176, 240, 174.75, 60, 176, 60]);
  assert.ok(rotated.rect[2] > rotated.rect[0] && rotated.rect[3] > rotated.rect[1]);
  assert.throws(() => buildPdfTextMarkup({ pageIndex: 0, rects: [] }, viewport, 'highlight', '#ffffff', editorTypes));
});

test('block marks keep original and translated text separate, replace a color, and clear overlaps', () => {
  const original: BlockTextRange = { blockId: 'block-1', contentKey: 'original', start: 0, end: 5, text: 'words' };
  const translated = { ...original, contentKey: 'translation' };
  let marks = updateBlockTextMarks([], [original], 'highlight', '#fef08a');
  marks = updateBlockTextMarks(marks, [translated], 'underline', '#16a34a');
  marks = updateBlockTextMarks(marks, [original], 'highlight', '#86efac');
  assert.equal(marks.length, 2);
  assert.equal(marks.find(mark => mark.contentKey === 'original')?.color, '#86efac');
  assert.deepEqual(normalizeBlockTextMarks(JSON.parse(JSON.stringify(marks))), marks);
  marks = updateBlockTextMarks(marks, [{ ...original, start: 2, end: 4, text: 'rd' }], 'clear', '#000000');
  assert.deepEqual(marks.map(mark => mark.contentKey), ['translation']);
  assert.deepEqual(normalizeBlockTextMarks([null, {}, { ...marks[0], color: 'red; }' }, { ...marks[0], end: 99 }]), []);
});

test('reading history preserves text marks across save and reload and accepts older records', () => {
  const marks = updateBlockTextMarks([], [{ blockId: 'block-1', contentKey: 'translation', start: 0, end: 2, text: '译文' }], 'underline', '#16a34a');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored = JSON.stringify({ paper: { workspaceId: 'paper', lastOpenedAt: 1, blockTextMarks: marks } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } },
  });
  try {
    const record = loadPaperHistory('paper');
    assert.ok(record);
    assert.deepEqual(record.blockTextMarks, marks);
    savePaperHistory(record);
    assert.deepEqual(loadPaperHistory('paper')?.blockTextMarks, marks);
    stored = JSON.stringify({ paper: { workspaceId: 'paper', lastOpenedAt: 1 } });
    assert.deepEqual(loadPaperHistory('paper')?.blockTextMarks, []);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
