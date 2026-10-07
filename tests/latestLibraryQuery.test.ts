import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestLibraryQuery } from '../src/features/literature/latestLibraryQuery.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a slow previous search cannot replace the latest category or clear its loading state', async () => {
  const query = createLatestLibraryQuery();
  const old = deferred<string>();
  const latest = deferred<string>();
  const rows: string[] = [];
  let settled = 0;
  const first = query.run(() => old.promise, value => rows.push(value), () => settled++);
  const second = query.run(() => latest.promise, value => rows.push(value), () => settled++);
  old.resolve('old'); await first;
  assert.deepEqual(rows, []);
  assert.equal(settled, 0);
  latest.resolve('latest'); await second;
  assert.deepEqual(rows, ['latest']);
  assert.equal(settled, 1);
});

test('an old response is ignored even when the new query is still being debounced', async () => {
  const query = createLatestLibraryQuery();
  const old = deferred<string>();
  const first = query.run(() => old.promise, assert.fail, assert.fail);
  query.invalidate();
  old.resolve('stale');
  await first;
});

test('a previous successful response cannot overwrite a newer completed request', async () => {
  const query = createLatestLibraryQuery();
  const old = deferred<string>();
  let visible = '';
  const first = query.run(() => old.promise, value => { visible = value; }, assert.fail);
  await query.run(async () => 'latest', value => { visible = value; }, () => {});
  old.resolve('old'); await first;
  assert.equal(visible, 'latest');
});

test('late failures from superseded requests cannot replace successful results with an error', async () => {
  const query = createLatestLibraryQuery();
  const old = deferred<string>();
  const first = query.run(() => old.promise, assert.fail, assert.fail);
  await query.run(async () => 'latest', value => assert.equal(value, 'latest'), () => {});
  old.reject(new Error('old failure'));
  await first;
});

test('current failure settles and remains retryable; empty results are committed', async () => {
  const query = createLatestLibraryQuery();
  let settled = 0;
  await assert.rejects(query.run(async () => { throw new Error('offline'); }, assert.fail, () => settled++), /offline/);
  assert.equal(settled, 1);
  await query.run(async () => [], value => assert.deepEqual(value, []), () => settled++);
  assert.equal(settled, 2);
});

test('unmount invalidation suppresses completion and failure callbacks', async () => {
  const query = createLatestLibraryQuery();
  const old = deferred<string>();
  const first = query.run(() => old.promise, assert.fail, assert.fail);
  query.invalidate();
  old.reject(new Error('closed'));
  await first;
});
