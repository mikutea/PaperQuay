import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOverviewBatchOutcome,
  countVerifiedBatchResults,
  resolveVerifiedTranslationStatus,
  saveVerifiedLibraryOverview,
  shouldWriteOverviewCache,
  sourceKeyAfterOverviewFailure,
} from '../src/features/reader/readerBatchResults.ts';

test('a generated but unsaved overview retains its source key for a save-only retry', () => {
  assert.equal(sourceKeyAfterOverviewFailure(true, 'new-source', ''), 'new-source');
  assert.equal(sourceKeyAfterOverviewFailure(true, 'new-source', 'old-source'), 'new-source');
  assert.equal(sourceKeyAfterOverviewFailure(false, 'new-source', 'old-source'), 'old-source');
  assert.equal(sourceKeyAfterOverviewFailure(true, '', 'old-source'), 'old-source');
});

test('native library remains a verified overview save target without a cache path', () => {
  assert.equal(shouldWriteOverviewCache('native-library', ''), false);
  assert.equal(shouldWriteOverviewCache('native-library', '  '), false);
  assert.equal(shouldWriteOverviewCache('native-library', 'D:/cache'), true);
  assert.throws(() => shouldWriteOverviewCache('standalone', ''), /cache directory/);
  assert.throws(() => shouldWriteOverviewCache('zotero-local', ''), /cache directory/);
});

test('only saved or verified overviews contribute to confirmed batch results', () => {
  assert.equal(classifyOverviewBatchOutcome('generated'), 'succeeded');
  assert.equal(classifyOverviewBatchOutcome('loaded'), 'reused');
  assert.equal(classifyOverviewBatchOutcome('skipped'), 'skipped');
  assert.equal(classifyOverviewBatchOutcome('failed'), 'failed');
  assert.equal(countVerifiedBatchResults({ succeeded: 2, reused: 3 }), 5);
  assert.equal(countVerifiedBatchResults({ succeeded: 2 }), 2);
});

test('overview success requires a nonempty result and confirmed library write', async () => {
  let saved = false;
  await assert.rejects(
    saveVerifiedLibraryOverview('', async () => { saved = true; return { aiSummary: '' }; }),
    /no usable content/,
  );
  assert.equal(saved, false);
  await assert.rejects(
    saveVerifiedLibraryOverview('Saved overview', async () => ({ aiSummary: null })),
    /did not confirm/,
  );
  await assert.rejects(
    saveVerifiedLibraryOverview('Saved overview', async () => { throw new Error('disk full'); }),
    /disk full/,
  );
  assert.deepEqual(
    await saveVerifiedLibraryOverview('Saved overview', async () => ({ aiSummary: 'Saved overview' })),
    { aiSummary: 'Saved overview' },
  );
});

test('translation cannot succeed if its cache was not verified after writing', () => {
  const base = {
    rateLimited: false,
    serviceUnavailable: false,
    cancelled: false,
    cacheSaveFailed: false,
    translatedCount: 10,
    totalBlocks: 10,
    failedBlocks: 0,
  };

  assert.equal(resolveVerifiedTranslationStatus(base), 'success');
  assert.equal(resolveVerifiedTranslationStatus({ ...base, cacheSaveFailed: true }), 'failed');
  assert.equal(resolveVerifiedTranslationStatus({ ...base, translatedCount: 0 }), 'failed');
  assert.equal(resolveVerifiedTranslationStatus({ ...base, translatedCount: 9 }), 'partial');
  assert.equal(resolveVerifiedTranslationStatus({ ...base, failedBlocks: 1 }), 'partial');
  assert.equal(resolveVerifiedTranslationStatus({ ...base, cancelled: true }), 'cancelled');
  assert.equal(resolveVerifiedTranslationStatus({ ...base, rateLimited: true }), 'rate-limited');
});
