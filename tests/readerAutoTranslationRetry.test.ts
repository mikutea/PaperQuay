import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeferredAutoTranslationRetry } from '../src/features/reader/readerAutoTranslationRetry.ts';

test('busy auto-translation retries only when its paper lock is released', () => {
  const retry = createDeferredAutoTranslationRetry();
  retry.defer('paper-a');
  assert.equal(retry.canAttempt('paper-a'), false);
  assert.equal(retry.canAttempt('paper-b'), true);
  assert.equal(retry.release('paper-b'), false);
  assert.equal(retry.canAttempt('paper-a'), false);
  assert.equal(retry.release('paper-a'), true);
  assert.equal(retry.canAttempt('paper-a'), true);
  assert.equal(retry.release('paper-a'), false);
});
