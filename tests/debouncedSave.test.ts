import assert from 'node:assert/strict';
import test from 'node:test';
import { createDebouncedSave } from '../src/services/debouncedSave.ts';

test('rapid settings edits coalesce and an explicit flush saves before the debounce delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved: string[] = [];
  const writer = createDebouncedSave<string>({ delayMs: 350, save: async (value) => { saved.push(value); }, onError: assert.fail });
  writer.schedule('first');
  writer.schedule('latest');
  t.mock.timers.tick(349);
  assert.deepEqual(saved, []);
  await writer.flush();
  assert.deepEqual(saved, ['latest']);
  t.mock.timers.tick(1000);
  await writer.flush();
  assert.deepEqual(saved, ['latest'], 'flushing cancels the delayed duplicate');
});

test('normal background saving still runs after the debounce interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved: number[] = [];
  const writer = createDebouncedSave<number>({ delayMs: 350, save: async (value) => { saved.push(value); }, onError: assert.fail });
  writer.schedule(1);
  t.mock.timers.tick(350);
  await writer.flush();
  assert.deepEqual(saved, [1]);
});

test('shutdown waits for in-flight saves and includes edits received during that save', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const saved: string[] = [];
  const writer = createDebouncedSave<string>({
    delayMs: 350,
    save: async (value) => { if (value === 'old') await gate; saved.push(value); },
    onError: assert.fail,
  });
  writer.schedule('old');
  const firstFlush = writer.flush();
  writer.schedule('new');
  const closeFlush = writer.flush();
  assert.equal(firstFlush, closeFlush);
  release();
  await closeFlush;
  assert.deepEqual(saved, ['old', 'new']);
});

test('failed saves remain retryable without restoring an old snapshot over a newer edit', async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_resolve, rejectSave) => { reject = rejectSave; });
  const saved: string[] = [];
  const writer = createDebouncedSave<string>({
    delayMs: 350,
    save: async (value) => { if (value === 'old') await gate; saved.push(value); },
    onError: assert.fail,
  });
  writer.schedule('old');
  const failure = writer.flush();
  writer.schedule('new');
  reject(new Error('disk full'));
  await assert.rejects(failure, /disk full/);
  await writer.flush();
  assert.deepEqual(saved, ['new']);
});

test('an autosave error is reported and closing retries the same snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = true;
  const errors: unknown[] = [];
  const saved: string[] = [];
  const writer = createDebouncedSave<string>({
    delayMs: 350,
    save: async (value) => { if (fail) throw new Error('disk full'); saved.push(value); },
    onError: (error) => { errors.push(error); },
  });
  writer.schedule('retained');
  t.mock.timers.tick(350);
  await assert.rejects(writer.flush(), /disk full/);
  assert.equal(errors.length, 1);
  fail = false;
  await writer.flush();
  assert.deepEqual(saved, ['retained']);
});
