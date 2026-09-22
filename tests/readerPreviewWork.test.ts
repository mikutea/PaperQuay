import assert from 'node:assert/strict';
import test from 'node:test';

import { mapPreviewItemsWithConcurrency } from '../src/features/reader/readerPreviewWork.ts';

test('preview hydration keeps a bounded number of lookups in flight', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapPreviewItemsWithConcurrency(
    Array.from({ length: 25 }, (_, index) => index),
    3,
    async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item * 2;
    },
  );
  assert.equal(peak, 3);
  assert.deepEqual(result, Array.from({ length: 25 }, (_, index) => index * 2));
});

test('superseded preview hydration does not start remaining lookups', async () => {
  let continueWork = true;
  const started: number[] = [];
  const result = await mapPreviewItemsWithConcurrency(
    [0, 1, 2, 3, 4],
    2,
    async (item) => {
      started.push(item);
      continueWork = false;
      return item;
    },
    () => continueWork,
  );
  assert.deepEqual(started, [0]);
  assert.deepEqual(result, [0]);
});
