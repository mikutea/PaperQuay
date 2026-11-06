import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDesktopReadingReaderAccess, DESKTOP_READING_PDF_BYTES } from '../src/services/desktopReadingReader.ts';
const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic loaded document\n%%EOF\n'), digest = createHash('sha256').update(bytes).digest('hex'), at = '2026-11-04T12:00:00.000Z';
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
test('registering a loaded reader reads nothing; explicit capture hashes exact complete bytes and reads the latest actual point', async () => {
  let reads = 0, pageIndex = 1; const hash = defer<string>();
  const access = createDesktopReadingReaderAccess({ isCurrent: () => true, pageCount: () => 4, readBytes: async () => { reads++; return bytes; }, readPoint: () => ({ pageIndex, offsetRatio: .25, observedAt: at }), applyPoint() { assert.fail('Capture cannot jump'); }, hashBytes: () => hash.promise });
  assert.equal(reads, 0); const capture = access.capture(); await new Promise(done => setImmediate(done)); pageIndex = 0; hash.resolve(digest);
  const snapshot = await capture; assert.equal(reads, 1); assert.deepEqual(snapshot, { sha256: digest, sizeBytes: bytes.length, pageCount: 4, pageIndex: 0, offsetRatio: .25, observedAt: at });
  assert(!JSON.stringify(snapshot).includes('sourceKey'));
});
test('actual SHA256 matches the loaded buffer and explicit resume cannot use a different hash, size or page count', async () => {
  const applied: unknown[] = [], access = createDesktopReadingReaderAccess({ isCurrent: () => true, pageCount: () => 4, readBytes: async () => bytes, readPoint: () => ({ pageIndex: 0, offsetRatio: 0, observedAt: at }), applyPoint: point => { applied.push(point); } });
  const source = await access.capture(); assert.equal(source.sha256, digest);
  for (const changed of [{ sha256: 'f'.repeat(64) }, { sizeBytes: bytes.length + 1 }, { pageCount: 3 }]) await assert.rejects(access.resume({ ...source, ...changed }), { code: 'READING_VERSION_MISMATCH' });
  assert.deepEqual(applied, []); await access.resume({ ...source, pageIndex: 2, offsetRatio: .75 }); assert.deepEqual(applied, [{ pageIndex: 2, offsetRatio: .75 }]);
});
test('retired PDF access after a pending byte read or hash cannot publish a point or jump the replacement document', async () => {
  for (const phase of ['bytes', 'hash']) {
    let current = true, applied = 0; const data = defer<Uint8Array>(), hash = defer<string>();
    const access = createDesktopReadingReaderAccess({ isCurrent: () => current, pageCount: () => 3, readBytes: () => phase === 'bytes' ? data.promise : Promise.resolve(bytes), hashBytes: () => phase === 'hash' ? hash.promise : Promise.resolve(digest), readPoint: () => ({ pageIndex: 1, offsetRatio: .5, observedAt: at }), applyPoint: () => { applied++; } });
    const pending = access.resume({ sha256: digest, sizeBytes: bytes.length, pageCount: 3, pageIndex: 2, offsetRatio: .5 }), rejected = assert.rejects(pending, { code: 'READING_READER_CHANGED' });
    await new Promise(done => setImmediate(done)); current = false; data.resolve(bytes); hash.resolve(digest); await rejected; assert.equal(applied, 0);
  }
});
test('missing current geometry, unsupported bytes and invalid points fail without converting legacy history to a version claim', async () => {
  const make = (readPoint: () => any, data = bytes) => createDesktopReadingReaderAccess({ isCurrent: () => true, pageCount: () => 3, readBytes: async () => data, readPoint, applyPoint() { assert.fail('No jump expected'); } });
  await assert.rejects(make(() => null).capture(), { code: 'READING_POSITION_UNAVAILABLE' });
  for (const point of [{ pageIndex: -1, offsetRatio: 0, observedAt: at }, { pageIndex: 3, offsetRatio: 0, observedAt: at }, { pageIndex: 0, offsetRatio: NaN, observedAt: at }, { pageIndex: 0, offsetRatio: 0, observedAt: 'unknown' }]) await assert.rejects(make(() => point).capture(), { code: 'READING_POSITION_UNAVAILABLE' });
  await assert.rejects(make(() => null, new Uint8Array(DESKTOP_READING_PDF_BYTES + 1)).capture(), { code: 'READING_PDF_LIMIT' });
});

test('disposed reader access stays retired after A-B-A and detaches actual point observers without reading bytes', async () => {
  let active = true, reads = 0, detached = 0; const hash = defer<string>(), observed: unknown[] = [];
  let send: (point: any) => void = () => {};
  const access = createDesktopReadingReaderAccess({ isCurrent: () => active, pageCount: () => 3,
    readBytes: async () => { reads++; return bytes; }, hashBytes: () => hash.promise,
    readPoint: () => ({ pageIndex: 1, offsetRatio: .5, observedAt: at }),
    subscribePosition: listener => { send = listener; return () => { detached++; }; }, applyPoint() { assert.fail('Retired access must not jump'); } });
  const stop = access.subscribePosition(point => observed.push(point));
  assert.deepEqual(access.currentPoint(), { pageIndex: 1, offsetRatio: .5, observedAt: at }); assert.equal(reads, 0);
  send({ pageIndex: 2, offsetRatio: .75, observedAt: at }); assert.equal(observed.length, 1);
  const pending = access.resume({ sha256: digest, sizeBytes: bytes.length, pageCount: 3, pageIndex: 2, offsetRatio: .7 });
  const rejected = assert.rejects(pending, { code: 'READING_READER_CHANGED' });
  await new Promise(done => setImmediate(done)); active = false; access.dispose(); active = true; hash.resolve(digest); await rejected;
  assert.equal(access.isCurrent(), false); assert.equal(access.currentPoint(), null); assert.equal(detached, 1);
  send({ pageIndex: 0, offsetRatio: 0, observedAt: at }); stop(); access.dispose(); assert.equal(observed.length, 1); assert.equal(detached, 1);
});

test('an already dispatched resume checks its owner request again after hashing and cannot apply after account A-B-A', async () => {
  let owner = 1, applied = 0; const hash = defer<string>();
  const access = createDesktopReadingReaderAccess({ isCurrent: () => true, pageCount: () => 3, readBytes: async () => bytes,
    hashBytes: () => hash.promise, readPoint: () => ({ pageIndex: 0, offsetRatio: 0, observedAt: at }), applyPoint: () => { applied++; } });
  const expected = owner, pending = access.resume({ sha256: digest, sizeBytes: bytes.length, pageCount: 3, pageIndex: 2, offsetRatio: .75 }, { isCurrent: () => owner === expected });
  const rejected = assert.rejects(pending, { code: 'READING_READER_CHANGED' });
  await new Promise(done => setImmediate(done)); owner++; owner++; hash.resolve(digest); await rejected; assert.equal(applied, 0);
});

test('observing actual same-document points never hashes bytes and rejects malformed or retired events', () => {
  let emit: (point: any) => void = () => {}, current = true, reads = 0; const seen: unknown[] = [];
  const access = createDesktopReadingReaderAccess({ isCurrent: () => current, pageCount: () => 3, readBytes: async () => { reads++; return bytes; },
    readPoint: () => null, subscribePosition: listener => { emit = listener; return () => {}; }, applyPoint() {} });
  access.subscribePosition(point => seen.push(point));
  for (const point of [{ pageIndex: 3, offsetRatio: 0, observedAt: at }, { pageIndex: 0, offsetRatio: NaN, observedAt: at }, { pageIndex: 0, offsetRatio: 0, observedAt: 'bad' }]) emit(point);
  emit({ pageIndex: 2, offsetRatio: .5, observedAt: at }); current = false; emit({ pageIndex: 1, offsetRatio: .4, observedAt: at });
  assert.deepEqual(seen, [{ pageIndex: 2, offsetRatio: .5, observedAt: at }]); assert.equal(reads, 0);
});
