import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SupersededLibraryRefreshError,
  shouldReportLibraryRefreshError,
} from '../src/features/reader/readerLibraryRefresh.ts';

test('superseded library requests do not surface a startup error', () => {
  assert.equal(shouldReportLibraryRefreshError(new SupersededLibraryRefreshError(), false), false);
  assert.equal(shouldReportLibraryRefreshError(new Error('disk unavailable'), true), false);
  assert.equal(shouldReportLibraryRefreshError(new Error('disk unavailable'), false), true);
});
