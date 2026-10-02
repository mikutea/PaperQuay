import assert from 'node:assert/strict';
import test from 'node:test';
import { paperPdfPath } from '../src/utils/libraryPaper.ts';
import type { LiteraturePaper } from '../src/types/library.ts';

test('the reader rejects escaping and absolute relative attachment paths', () => {
  const fixture = (relativePath: string) => ({ attachments: [{ kind: 'pdf', storedPath: 'C:/safe/paper.pdf', relativePath }] }) as LiteraturePaper;
  for (const unsafe of ['../../private.pdf', '..\\private.pdf', '/private.pdf', 'C:\\private.pdf']) {
    assert.equal(paperPdfPath(fixture(unsafe), { storageDir: 'C:/safe' }), null);
  }
  assert.equal(paperPdfPath(fixture('nested/paper.pdf'), { storageDir: 'C:/safe' }), 'C:/safe/nested/paper.pdf');
});
