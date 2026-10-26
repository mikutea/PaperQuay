import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createAccountState, queueLocalEdit, type LocalEdit } from '../../../packages/sync-core/src/index.ts';
import { ReaderDirtyState, useReaderDirty } from '../src/pdf/dirty.ts';
import { ReadingCheckpointWriter, type ReaderController } from '../src/pdf/position.ts';
import { PdfError } from '../src/pdf/errors.ts';
import type { PdfVersion } from '../src/pdf/types.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';

function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const scope = { apiBaseUrl: 'https://sync.example.org', accountId: crypto.randomUUID() };
  let state = createAccountState(scope.accountId, crypto.randomUUID());
  const version: PdfVersion = { entityId: crypto.randomUUID(), data: {
    paperId: crypto.randomUUID(), attachmentId: crypto.randomUUID(), sha256: 'a'.repeat(64),
    mediaType: 'application/pdf', fileName: 'synthetic.pdf', sizeBytes: 100, pageCount: 3,
  } };
  let gate = deferred(); let commits = 0; let leaves = 0; let parentUnsaved = false;
  const events: string[] = [];
  const dirty = new ReaderDirtyState((value) => { parentUnsaved = value; events.push(`dirty:${value}`); });
  const controller: ReaderController = {
    getSnapshot: () => ({ workspace: { sync: state, pendingResolutions: {} } } as WorkspaceSnapshot),
    async save(edit: LocalEdit) {
      await gate.promise;
      state = queueLocalEdit(state, edit, { opId: crypto.randomUUID(), clientCreatedAt: '2026-10-26T12:00:00.000Z' });
      commits++; events.push('committed');
    },
  };
  const writer = new ReadingCheckpointWriter(controller, scope, version, { onStatus: (status) => dirty.setPosition(status) });
  return {
    dirty, writer, events,
    get commits() { return commits; }, get leaves() { return leaves; }, get parentUnsaved() { return parentUnsaved; },
    get gate() { return gate; }, retry() { gate = deferred(); return gate; },
    async back() {
      await writer.flush();
      dirty.publish();
      events.push('back');
      if (!parentUnsaved) leaves++;
    },
  };
}

test('a durably flushed checkpoint publishes clean before the first return without a render or effect', async () => {
  const env = fixture();
  try {
    env.writer.record({ pageIndex: 2, offsetRatio: 0.4 });
    const returning = env.back();
    assert.equal(env.parentUnsaved, true); assert.equal(env.leaves, 0);
    env.gate.resolve(); await returning;
    assert.equal(env.commits, 1); assert.equal(env.leaves, 1); assert.equal(env.parentUnsaved, false);
    assert.deepEqual(env.events, ['dirty:true', 'committed', 'dirty:false', 'dirty:false', 'back']);
  } finally { env.writer.stop(); }
});

test('failed checkpoint persistence keeps the leave guard and a successful retry clears it', async () => {
  const env = fixture();
  try {
    env.writer.record({ pageIndex: 1, offsetRatio: 0 });
    const returning = env.back(); env.gate.reject(new PdfError('POSITION_FAILED'));
    await assert.rejects(returning, (error: unknown) => error instanceof PdfError && error.code === 'POSITION_FAILED');
    assert.equal(env.parentUnsaved, true); assert.equal(env.leaves, 0);
    const gate = env.retry(); const retrying = env.back(); gate.resolve(); await retrying;
    assert.equal(env.commits, 1); assert.equal(env.leaves, 1); assert.equal(env.parentUnsaved, false);
  } finally { env.writer.stop(); }
});

test('a comment edited while a position flush is pending remains guarded at return', async () => {
  const env = fixture();
  try {
    env.writer.record({ pageIndex: 1, offsetRatio: 0.2 });
    const returning = env.back();
    env.dirty.setComment({ comment: 'New draft', saved: 'Saved draft' });
    env.gate.resolve(); await returning;
    assert.equal(env.commits, 1); assert.equal(env.leaves, 0); assert.equal(env.parentUnsaved, true);
    env.dirty.setComment({ comment: 'New draft', saved: 'New draft' });
    assert.equal(env.parentUnsaved, false);
  } finally { env.writer.stop(); }
});

test('finishing one annotation or position never clears another pending annotation', async () => {
  const env = fixture();
  try {
    const first = env.dirty.beginSave('annotation'); const second = env.dirty.beginSave('annotation');
    env.writer.record({ pageIndex: 2, offsetRatio: 0 });
    const returning = env.back(); first(); first();
    env.gate.resolve(); await returning;
    assert.equal(env.dirty.annotationSaving, true); assert.equal(env.parentUnsaved, true); assert.equal(env.leaves, 0);
    second(); assert.equal(env.parentUnsaved, false); assert.equal(env.dirty.annotationSaving, false);
  } finally { env.writer.stop(); }
});

test('reverting a comment while its older value is being saved stays guarded until the current value is committed', () => {
  const notifications: boolean[] = [];
  const dirty = new ReaderDirtyState((value) => notifications.push(value));
  dirty.setComment({ comment: 'Writing', saved: 'Original' });
  const first = dirty.beginSave('comment');
  dirty.setComment({ comment: 'Original', saved: 'Original' });
  assert.equal(dirty.dirty, true, 'the in-flight write can still replace the original value');
  dirty.setComment({ comment: 'Original', saved: 'Writing' }); first();
  assert.equal(dirty.dirty, true);
  const successor = dirty.beginSave('comment');
  dirty.setComment({ comment: 'Original', saved: 'Original' });
  assert.equal(dirty.dirty, true); successor();
  assert.equal(dirty.dirty, false);
  assert.equal(notifications.slice(0, -1).every(Boolean), true);
});

test('the hook publishes changes synchronously to the current parent and stops publishing after unmount', () => {
  let state!: ReaderDirtyState; let renderer!: ReactTestRenderer;
  const first: boolean[] = []; const second: boolean[] = [];
  const firstListener = (value: boolean) => first.push(value);
  const secondListener = (value: boolean) => second.push(value);
  function Reader({ onDirty }: { onDirty: (value: boolean) => void }) {
    state = useReaderDirty(onDirty); return null;
  }
  act(() => { renderer = create(createElement(Reader, { onDirty: firstListener })); });
  const finish = state.beginSave('annotation');
  assert.deepEqual(first, [false, true], 'the event publishes before another React commit');
  act(() => renderer.update(createElement(Reader, { onDirty: secondListener })));
  assert.deepEqual(second, [true]);
  finish(); assert.deepEqual(second, [true, false]);
  act(() => renderer.unmount());
  state.setComment({ comment: 'Late', saved: '' });
  assert.deepEqual(second, [true, false]);
});
