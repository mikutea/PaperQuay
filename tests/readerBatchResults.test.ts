import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOverviewBatchOutcome,
  countVerifiedBatchResults,
  enqueueOverviewWrite,
  persistOverviewIfCurrent,
  resolveVerifiedTranslationStatus,
  saveVerifiedLibraryOverview,
  shouldWriteOverviewCache,
  sourceKeyAfterOverviewFailure,
} from '../src/features/reader/readerBatchResults.ts';

test('empty model and cached overviews fail before any persistence or success count', async () => {
  const summaryText = '';
  for (const cacheAlreadyVerified of [false, true]) {
    let writes = 0;
    await assert.rejects(persistOverviewIfCurrent({
      isCurrent: () => true,
      cacheAlreadyVerified,
      summaryText,
      saveCache: async () => { writes += 1; },
      saveNative: async () => { writes += 1; },
    }), /no usable content/);
    assert.equal(writes, 0);
  }
});

test('history overview must be saved before being counted as reusable', async () => {
  const steps: string[] = [];
  assert.equal(await persistOverviewIfCurrent({
    isCurrent: () => true,
    summaryText: 'Overview content',
    saveCache: async () => { steps.push('verified-cache'); },
    saveNative: async () => { steps.push('native-noop'); },
  }), true);
  assert.deepEqual(steps, ['verified-cache', 'native-noop']);
  await assert.rejects(persistOverviewIfCurrent({
    isCurrent: () => true,
    summaryText: 'Overview content',
    saveCache: async () => { throw new Error('cache unavailable'); },
    saveNative: async () => { throw new Error('must not reach'); },
  }), /cache unavailable/);
});

test('a superseded overview cannot commit success or start a stale native save', async () => {
  let current = true;
  let nativeSaves = 0;
  assert.equal(await persistOverviewIfCurrent({
    isCurrent: () => current,
    summaryText: 'Overview content',
    saveCache: async () => { current = false; },
    saveNative: async () => { nativeSaves += 1; },
  }), false);
  assert.equal(nativeSaves, 0);
  current = true;
  assert.equal(await persistOverviewIfCurrent({
    isCurrent: () => current,
    summaryText: 'Overview content',
    cacheAlreadyVerified: true,
    saveCache: async () => { throw new Error('already verified'); },
    saveNative: async () => { nativeSaves += 1; current = false; },
  }), false);
  assert.equal(nativeSaves, 1);
});

test('overlapping overview writes for one paper are serialized, even after failures', async () => {
  const pendingWrites = new Map<string, Promise<unknown>>();
  const steps: string[] = [];
  let releaseFirst!: () => void;
  let signalStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
  const first = enqueueOverviewWrite(pendingWrites, 'paper-1', async () => {
    steps.push('first-start');
    signalStarted();
    await firstGate;
    steps.push('first-end');
    throw new Error('first failed');
  });
  const second = enqueueOverviewWrite(pendingWrites, 'paper-1', async () => {
    steps.push('second-start');
    return 'saved';
  });
  await firstStarted;
  assert.deepEqual(steps, ['first-start']);
  releaseFirst();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'saved');
  assert.deepEqual(steps, ['first-start', 'first-end', 'second-start']);
  assert.equal(pendingWrites.size, 0);
});

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
