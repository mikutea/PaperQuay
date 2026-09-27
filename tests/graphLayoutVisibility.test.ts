import assert from 'node:assert/strict';
import test from 'node:test';
import { graphContainerHasSize } from '../src/features/graph/graphLayoutVisibility.ts';

test('defer graph layout while a hidden workspace has no drawable size', () => {
  assert.equal(graphContainerHasSize(null), false);
  assert.equal(graphContainerHasSize({ clientWidth: 0, clientHeight: 600 }), false);
  assert.equal(graphContainerHasSize({ clientWidth: 900, clientHeight: 0 }), false);
  assert.equal(graphContainerHasSize({ clientWidth: 900, clientHeight: 600 }), true);
});
