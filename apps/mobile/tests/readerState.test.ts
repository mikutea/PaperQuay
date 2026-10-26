import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PDFPageProxy } from 'pdfjs-dist';
import {
  createAccountState, entityKey, getVisibleEntity, queueLocalEdit,
  type AccountSyncState, type LocalEdit, type ReadingPositionData, type SyncRecord,
} from '../../../packages/sync-core/src/index.ts';
import { ownReadingPosition, positionOwner, ReadingCheckpointWriter, type PositionStatus, type ReaderController } from '../src/pdf/position.ts';
import { capturePageSelection } from '../src/pdf/selection.ts';
import { boundedTextContent } from '../src/pdf/textContent.ts';
import { PdfError } from '../src/pdf/errors.ts';
import type { WorkspaceSnapshot } from '../src/sync/workspace.ts';
import type { PdfVersion } from '../src/pdf/types.ts';

const id = () => crypto.randomUUID();
const account = id(); const device = id(); const remote = id();
const scope = { apiBaseUrl: 'https://sync.example.org', accountId: account };
const now = '2026-10-25T12:00:00.000Z';
const version: PdfVersion = { entityId: id(), data: { paperId: id(), attachmentId: id(), sha256: 'a'.repeat(64),
  fileName: 'synthetic.pdf', sizeBytes: 100, pageCount: 20, mediaType: 'application/pdf' } };
const code = (expected: string) => (error: unknown) => error instanceof PdfError && error.code === expected;
const point = (pageIndex: number, patch: Partial<ReadingPositionData> = {}): ReadingPositionData => ({
  paperId: version.data.paperId, attachmentVersionId: version.entityId, pageIndex, offsetRatio: 0.3,
  furthestPageIndex: pageIndex, furthestOffsetRatio: 0.3, sessionId: id(), deviceSequence: 1, observedAt: now, ...patch,
});
function record(entityId: string, owner: string, data: ReadingPositionData, revision = 1): SyncRecord<'readingPosition'> {
  return { entityType: 'readingPosition', entityId, schemaVersion: 1, revision, deletedAt: null, updatedAt: now,
    modifiedByDeviceId: owner, data };
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve };
}
function harness(initial = createAccountState(account, device)) {
  let state = initial; let calls = 0; let fail = false; let pause: ReturnType<typeof deferred> | null = null;
  const controller: ReaderController = {
    getSnapshot() { return { workspace: { sync: state, pendingResolutions: {} }, devices: [] } as unknown as WorkspaceSnapshot; },
    async save(edit: LocalEdit, expectedRevision?: number) {
      calls++; const origin = { account: state.accountId, generation: state.generation, device: state.deviceId };
      if (pause) await pause.promise;
      if (origin.account !== state.accountId || origin.generation !== state.generation || origin.device !== state.deviceId) throw new PdfError('ACCOUNT_CHANGED');
      if (fail) throw new PdfError('POSITION_FAILED');
      assert.equal(getVisibleEntity(state, edit.entityType, edit.entityId)?.revision ?? 0, expectedRevision);
      state = queueLocalEdit(state, edit, { opId: id(), clientCreatedAt: now });
    },
  };
  return { controller, get state() { return state; }, set state(value: AccountSyncState) { state = value; },
    get calls() { return calls; }, set fail(value: boolean) { fail = value; }, set pause(value: ReturnType<typeof deferred> | null) { pause = value; } };
}

test('recent reading position follows backward navigation while furthest progress remains monotonic and device sequence increases', async () => {
  const app = harness(); const statuses: PositionStatus[] = [];
  const writer = new ReadingCheckpointWriter(app.controller, scope, version, { now: () => now, onStatus: (value) => statuses.push(value) });
  writer.record({ pageIndex: 12, offsetRatio: 0.8 }); await writer.flush();
  const first = ownReadingPosition(app.state, version)!;
  writer.record({ pageIndex: 3, offsetRatio: 0.2 }); await writer.flush();
  const recent = ownReadingPosition(app.state, version)!; const data = recent.data as ReadingPositionData;
  assert.equal(recent.entityId, first.entityId); assert.equal(data.pageIndex, 3); assert.equal(data.offsetRatio, 0.2);
  assert.equal(data.furthestPageIndex, 12); assert.equal(data.furthestOffsetRatio, 0.8); assert.equal(data.deviceSequence, 2);
  assert.equal(statuses.at(-1), 'saved'); assert.equal(app.state.outbox.length, 1);
  writer.stop();
});

test('rapid scroll checkpoints coalesce before durable write without losing the furthest page visited', async () => {
  const app = harness(); const writer = new ReadingCheckpointWriter(app.controller, scope, version, { debounceMs: 1000, now: () => now });
  writer.record({ pageIndex: 15, offsetRatio: 0.4 });
  for (let index = 14; index >= 2; index--) writer.record({ pageIndex: index, offsetRatio: 0.1 });
  assert.equal(app.calls, 0); await writer.flush(); assert.equal(app.calls, 1);
  const saved = ownReadingPosition(app.state, version)!.data as ReadingPositionData;
  assert.equal(saved.pageIndex, 2); assert.equal(saved.furthestPageIndex, 15); writer.stop();
});

test('saved status waits for durable completion; a newer point queued during a write is subsequently persisted', async () => {
  const app = harness(); const pause = deferred(); app.pause = pause;
  const statuses: PositionStatus[] = [];
  const writer = new ReadingCheckpointWriter(app.controller, scope, version, { now: () => now, onStatus: (status) => statuses.push(status) });
  writer.record({ pageIndex: 8, offsetRatio: 0.9 }); const flushing = writer.flush();
  await Promise.resolve(); assert.equal(app.calls, 1); assert.equal(statuses.includes('saved'), false);
  writer.record({ pageIndex: 1, offsetRatio: 0.2 }); app.pause = null; pause.resolve(); await flushing;
  assert.equal(app.calls, 2); const saved = ownReadingPosition(app.state, version)!.data as ReadingPositionData;
  assert.equal(saved.pageIndex, 1); assert.equal(saved.furthestPageIndex, 8); assert.equal(statuses.at(-1), 'saved'); writer.stop();
});

test('failed checkpoint stays dirty and explicit retry saves the last requested point', async () => {
  const app = harness(); app.fail = true; const statuses: PositionStatus[] = [];
  const writer = new ReadingCheckpointWriter(app.controller, scope, version, { now: () => now, onStatus: (status) => statuses.push(status) });
  writer.record({ pageIndex: 6, offsetRatio: 0.4 }); await assert.rejects(writer.flush(), code('POSITION_FAILED'));
  assert.equal(statuses.at(-1), 'error'); assert.equal(ownReadingPosition(app.state, version), null);
  writer.record({ pageIndex: 2, offsetRatio: 0.1 }); app.fail = false; await writer.flush();
  const saved = ownReadingPosition(app.state, version)!.data as ReadingPositionData;
  assert.equal(saved.pageIndex, 2); assert.equal(saved.furthestPageIndex, 6); assert.equal(statuses.at(-1), 'saved'); writer.stop();
});

test('own-device resume excludes remote high-page checkpoints and chooses the latest own observation', () => {
  const state = createAccountState(account, device); const old = id(); const recent = id(); const other = id();
  state.serverRecords[entityKey('readingPosition', other)] = record(other, remote, point(19));
  state.serverRecords[entityKey('readingPosition', old)] = record(old, device, point(14, { observedAt: '2026-10-24T12:00:00.000Z' }));
  state.serverRecords[entityKey('readingPosition', recent)] = record(recent, device, point(2));
  assert.equal(ownReadingPosition(state, version)?.entityId, recent);
  assert.equal(positionOwner(state, other), remote);
  assert.equal((ownReadingPosition(state, version)!.data as ReadingPositionData).pageIndex, 2);
});

test('account or device-generation change prevents queued and in-flight checkpoints from entering the replacement session', async () => {
  const app = harness(); const pause = deferred(); app.pause = pause;
  const writer = new ReadingCheckpointWriter(app.controller, scope, version, { now: () => now });
  writer.record({ pageIndex: 4, offsetRatio: 0.2 }); const pending = writer.flush(); await Promise.resolve();
  app.state = { ...app.state, generation: app.state.generation + 1 }; app.pause = null; pause.resolve();
  await assert.rejects(pending, code('ACCOUNT_CHANGED')); assert.equal(app.state.outbox.length, 0);
  await assert.rejects(writer.flush(), code('ACCOUNT_CHANGED')); assert.equal(app.calls, 1); writer.stop();
  const stopped = new ReadingCheckpointWriter(app.controller, scope, version, { debounceMs: 1 });
  stopped.record({ pageIndex: 3, offsetRatio: 0 }); stopped.stop(); await stopped.flush(); assert.equal(app.calls, 1);
});

test('selection captures exact text and clipped page-local quads, while cross-page and oversized selections are rejected', () => {
  const first = {} as Node; const last = {} as Node; const outside = {} as Node;
  const layer = { textContent: 'Before selected text after', contains: (node: Node) => node === first || node === last,
    closest: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20, right: 310, bottom: 420 }) }) } as unknown as HTMLElement;
  const rects = [{ left: 40, top: 80, right: 160, bottom: 100 }, { left: 40, top: 80, right: 160, bottom: 100 },
    { left: -20, top: 110, right: 100, bottom: 130 }];
  const selection = { isCollapsed: false, rangeCount: 1, anchorNode: first, focusNode: last,
    toString: () => 'selected text', getRangeAt: () => ({ getClientRects: () => rects }) } as unknown as Selection;
  const view = { width: 300, height: 400, transform: [1, 0, 0, -1, -10, 420] };
  const captured = capturePageSelection(layer, 2, [10, 20, 310, 420], view, selection)!;
  assert.equal(captured.pageIndex, 2); assert.equal(captured.coordinateSpace, 'pdf-crop-box-unrotated-normalized');
  assert.deepEqual(captured.quote, { exact: 'selected text', prefix: 'Before ', suffix: ' after' });
  assert.equal(captured.quads.length, 2); assert.deepEqual(captured.quads[0], [0.1, 0.85, 0.5, 0.85, 0.5, 0.8, 0.1, 0.8]);
  assert.equal(captured.quads[1][0], 0, 'selection geometry clips at the page edge');
  assert.equal(capturePageSelection(layer, 2, [10, 20, 310, 420], view, { ...selection, focusNode: outside } as Selection), null);
  assert.throws(() => capturePageSelection(layer, 2, [10, 20, 310, 420], view,
    { ...selection, toString: () => 'x'.repeat(8193) } as Selection), code('SELECTION_LIMIT'));
});

test('text extraction cancellation closes the worker stream and page limits stop before the remainder is buffered', async () => {
  let cancelled = false; const abort = new AbortController(); let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const stalled = { streamTextContent: () => new ReadableStream({ start() { started(); }, cancel() { cancelled = true; } }) } as unknown as PDFPageProxy;
  const pending = boundedTextContent(stalled, abort.signal); await ready; abort.abort();
  await assert.rejects(pending, code('CANCELLED')); assert.equal(cancelled, true);
  let read = 0; cancelled = false;
  const large = { streamTextContent: () => new ReadableStream({ pull(controller) {
    read++; controller.enqueue({ items: [{ str: 'x'.repeat(200000), hasEOL: false }], styles: {}, lang: null });
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 }) } as unknown as PDFPageProxy;
  await assert.rejects(boundedTextContent(large), code('TEXT_LIMIT')); assert.equal(cancelled, true); assert.equal(read, 2);
});
