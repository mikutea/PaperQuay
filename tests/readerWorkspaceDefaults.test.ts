import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStoredNumber } from '../src/features/reader/readerWorkspaceShared.ts';

test('missing and blank layout settings retain usable defaults', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored: string | null = null;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => stored } });
  try {
    assert.equal(loadStoredNumber('width', 408), 408);
    stored = ' ';
    assert.equal(loadStoredNumber('width', 408), 408);
    stored = '560';
    assert.equal(loadStoredNumber('width', 408), 560);
    stored = 'invalid';
    assert.equal(loadStoredNumber('width', 408), 408);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
