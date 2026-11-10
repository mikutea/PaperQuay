import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PDF_PAPER_APPEARANCE_KEY, pdfPaperAppearance, readPdfPaperAppearance, writePdfPaperAppearance} from '../src/features/pdf/pdfPaperAppearance.ts';

test('PDF appearance defaults to the app theme and only accepts known display choices', () => {
  for (const value of [null, undefined, '', 'dark', 'url(private)', {}]) assert.equal(pdfPaperAppearance(value), 'theme');
  for (const value of ['theme', 'soft-original', 'original'] as const) assert.equal(pdfPaperAppearance(value), value);
});

test('original and soft-original choices survive a reader restart without storing document or account data', () => {
  const values = new Map<string,string>();
  const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); }};
  assert.equal(readPdfPaperAppearance(storage),'theme');
  for (const choice of ['original','soft-original','theme'] as const) {
    writePdfPaperAppearance(choice,storage);
    assert.equal(readPdfPaperAppearance(storage),choice);
    assert.deepEqual([...values.keys()],[PDF_PAPER_APPEARANCE_KEY]);
  }
});

test('unavailable appearance storage does not prevent opening or changing a PDF view', () => {
  assert.equal(readPdfPaperAppearance({getItem() { throw Error('unavailable'); }}),'theme');
  assert.doesNotThrow(() => writePdfPaperAppearance('original',{setItem() { throw Error('unavailable'); }}));
});
