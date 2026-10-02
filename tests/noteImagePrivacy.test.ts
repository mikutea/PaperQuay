import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalNoteImageSource } from '../src/features/notes/notesTiptap.ts';

test('note images allow embedded/local blobs but never implicit remote or file requests', () => {
  for (const source of ['https://example.invalid/pixel', 'http://127.0.0.1/admin', '//example.invalid/pixel', 'file:///private.pdf', 'javascript:alert(1)', null]) {
    assert.equal(isLocalNoteImageSource(source), false);
  }
  assert.equal(isLocalNoteImageSource('data:image/png;base64,AAAA'), true);
  assert.equal(isLocalNoteImageSource('blob:file:///fixture-id'), true);
});
