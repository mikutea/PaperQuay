import assert from 'node:assert/strict';
import test from 'node:test';

import { onPaperTranslationReleased, tryAcquirePaperTranslation } from '../src/features/reader/readerTranslationLock.ts';

test('same-paper translation cannot run concurrently and release is idempotent', () => {
  const releaseFirst = tryAcquirePaperTranslation('paper-1');
  assert.ok(releaseFirst);
  assert.equal(tryAcquirePaperTranslation('paper-1'), null);
  const releaseOther = tryAcquirePaperTranslation('paper-2');
  assert.ok(releaseOther);
  releaseFirst();
  releaseFirst();
  const releaseAgain = tryAcquirePaperTranslation('paper-1');
  assert.ok(releaseAgain);
  releaseAgain();
  releaseOther();
});

test('a released paper notifies auto-batch retry listeners only once', () => {
  const released: string[] = [];
  const unsubscribe = onPaperTranslationReleased((workspaceId) => released.push(workspaceId));
  const release = tryAcquirePaperTranslation('paper-3');
  assert.ok(release);
  release();
  release();
  unsubscribe();
  assert.deepEqual(released, ['paper-3']);
});
