// Synthetic source/account data. Reader bytes and IPC responses are explicit
// fixture adapters; this does not claim actual PDFJS or authenticated service QA.
export const readingScope = 'fixture-reading-account-library';
export const readingId = value => 'd0000000-0000-4000-8000-' + String(value).padStart(12, '0');
export const readingStatus = (patch = {}) => ({ scopeKey: readingScope, supported: true, busy: false, revision: 1,
  pending: 0, continuable: 0, conflicts: 0, saveUnconfirmed: false, errorCode: null, tracking: null, ...patch });
export const readingSnapshot = (patch = {}) => ({ sha256: 'a'.repeat(64), sizeBytes: 8192, pageCount: 12, pageIndex: 3,
  offsetRatio: 0.375, observedAt: '2026-11-04T12:00:00.000Z', ...patch });
export const readingSource = (patch = {}) => ({ bindingId: readingId(1), localPaperId: 'local-reading-paper', localAttachmentId: 'local-reading-pdf',
  paperId: readingId(2), attachmentVersionId: readingId(3), sha256: 'a'.repeat(64), sizeBytes: 8192, pageCount: 12,
  title: '村庄公共空间的日常使用', fileName: '公共空间.pdf', ...patch });
export const readingData = (patch = {}) => ({ paperId: readingId(2), attachmentVersionId: readingId(3), pageIndex: 5, offsetRatio: 0.25,
  furthestPageIndex: 8, furthestOffsetRatio: 0.7, sessionId: readingId(4), deviceSequence: 10,
  observedAt: '2026-11-03T04:30:00.000Z', ...patch });
export const readingPosition = (patch = {}) => ({ entityId: readingId(7), revision: 3, deviceId: readingId(8), deviceName: '随身平板',
  isCurrentDevice: false, data: readingData({ pageIndex: 1, offsetRatio: 0.125, observedAt: '2026-11-04T05:05:00.000Z' }), ...patch });
export const readingOwn = (patch = {}) => ({ entityType: 'readingPosition', entityId: readingId(5), schemaVersion: 1, revision: 4,
  deletedAt: null, updatedAt: '2026-11-03T04:30:00.000Z', modifiedByDeviceId: readingId(6), data: readingData(), ...patch });
export const readingDraft = (patch = {}) => ({ originDeviceId: readingId(6), source: readingSource(), capture: { ...readingSnapshot(), bindingId: readingId(1) },
  furthestPageIndex: 9, furthestOffsetRatio: 0.625, sessionId: readingId(60), ...patch });
export const readingPreview = (patch = {}) => ({ token: readingId(20), scopeKey: readingScope, revision: 1, source: readingSource(),
  capture: { ...readingSnapshot(), bindingId: readingId(1) }, publicationAction: 'update', publicationReason: null,
  own: readingOwn(), positions: [readingPosition(), readingPosition({ entityId: readingId(5), revision: 4, deviceId: readingId(6), deviceName: '书桌电脑', isCurrentDevice: true, data: readingData() })],
  localDraft: null, pendingRows: [], conflicts: [], pendingResolutions: [], ...patch });
export const readingPending = (patch = {}) => ({ opId: readingId(30), entityId: readingId(5), label: '村庄公共空间的日常使用', mutation: 'put',
  stage: 'uncertain', data: readingData({ pageIndex: 3, offsetRatio: 0.375 }), errorCode: null, ...patch });
export const readingConflict = (patch = {}) => ({ conflictId: readingId(31), entityId: readingId(5), label: '村庄公共空间的日常使用', expectedRevision: 5,
  canResolve: true, reason: null, attempted: { mutation: 'put', data: readingData({ pageIndex: 3, offsetRatio: 0.375 }) },
  current: { revision: 5, deletedAt: null, data: readingData({ pageIndex: 1, offsetRatio: 0.125 }) }, ...patch });
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function createReadingFixture(options = {}) {
  const calls = [], readerCalls = [], readerApplied = [], overrides = new Map(), listeners = new Set(), positionListeners = new Set(), copy = value => structuredClone(value);
  const current = { status: readingStatus(options.status), snapshot: readingSnapshot(options.snapshot), versions: options.versions || [readingSource()],
    preview: options.preview || {}, readerCurrent: true, serial: 0, lastPreview: null };
  const reader = { id: readingId(50), isCurrent: () => current.readerCurrent,
    capture: async () => { readerCalls.push({ action: 'capture' }); if (overrides.has('reader_capture')) return overrides.get('reader_capture')(); return copy(current.snapshot); },
    currentPoint: () => current.readerCurrent ? { pageIndex: current.snapshot.pageIndex, offsetRatio: current.snapshot.offsetRatio, observedAt: current.snapshot.observedAt } : null,
    subscribePosition: listener => { positionListeners.add(listener); return () => positionListeners.delete(listener); },
    dispose: () => { current.readerCurrent = false; positionListeners.clear(); },
    resume: async (point, request) => { readerCalls.push({ action: 'resume', point: copy(point) }); if (overrides.has('reader_resume')) await overrides.get('reader_resume')(point, request); if (!current.readerCurrent || request && !request.isCurrent()) throw Error('READING_READER_CHANGED'); readerApplied.push(copy(point)); },
  };
  const emitChange = (payload = null) => { for (const listener of listeners) listener({ event: 'desktop-account:changed', payload }); };
  const finish = () => { current.status = readingStatus({ ...current.status, revision: current.status.revision + 1, pending: 0, continuable: 0, conflicts: 0, errorCode: null, saveUnconfirmed: false }); return copy(current.status); };
  const window = new EventTarget();
  window.paperquay = {
    listen: async (name, listener) => { if (name !== 'desktop-account:changed') throw Error('Unexpected event: ' + name); listeners.add(listener); return () => listeners.delete(listener); },
    invoke: async (command, args) => {
      calls.push({ command, args: copy(args) }); if (overrides.has(command)) return overrides.get(command)(args);
      if (command === 'desktop_reading_status') return copy(current.status);
      if (command === 'desktop_reading_versions') return { scopeKey: current.status.scopeKey, versions: copy(current.versions) };
      if (command === 'desktop_reading_preview') {
        current.lastPreview = readingPreview({ token: readingId(100 + ++current.serial), scopeKey: current.status.scopeKey, revision: current.status.revision,
          source: copy(current.versions.find(row => row.bindingId === args.capture.bindingId)), capture: copy(args.capture), ...copy(current.preview) });
        return copy(current.lastPreview);
      }
      if (command === 'desktop_reading_resume') {
        const view = current.lastPreview, row = view.positions.find(position => position.entityId === args.entityId);
        if (!row) throw Error('READING_SELECTION_INVALID');
        return { scopeKey: current.status.scopeKey, source: copy(view.source), position: copy(row.data), origin: { entityId: row.entityId, revision: row.revision, deviceId: row.deviceId, deviceName: row.deviceName } };
      }
      if (['desktop_reading_publish', 'desktop_reading_continue', 'desktop_reading_resolve', 'desktop_reading_retry_save'].includes(command)) return finish();
      if (command === 'desktop_reading_track_start') {
        const view = current.lastPreview; if (!view || view.token !== args.token) throw Error('READING_PREVIEW_STALE');
        const trackingId = readingId(70 + current.serial); current.status = { ...current.status, revision: current.status.revision + 1,
          tracking: { trackingId, bindingId: view.source.bindingId, attachmentVersionId: view.source.attachmentVersionId } };
        const draft = readingDraft({ source: copy(view.source), capture: copy(view.capture) }); current.preview.localDraft = draft;
        return { status: copy(current.status), trackingId, source: copy(view.source), capture: copy(view.capture), furthestPageIndex: draft.furthestPageIndex, furthestOffsetRatio: draft.furthestOffsetRatio };
      }
      if (command === 'desktop_reading_track_point') {
        const draft = current.preview.localDraft;
        if (draft) current.preview.localDraft = { ...draft, capture: { ...draft.capture, pageIndex: args.point.pageIndex, offsetRatio: args.point.offsetRatio, observedAt: args.point.observedAt }, furthestPageIndex: args.point.furthestPageIndex, furthestOffsetRatio: args.point.furthestOffsetRatio };
        current.status.revision++; return copy(current.status);
      }
      if (command === 'desktop_reading_track_stop') { if (current.status.tracking?.trackingId === args.trackingId) current.status.tracking = null; return copy(current.status); }
      if (command === 'desktop_reading_stop') return copy(current.status);
      if (command === 'desktop_reading_export') return { status: 'exported', bytes: 1024 };
      throw Error('Unexpected fixture command: ' + command);
    },
  };
  return { calls, readerCalls, readerApplied, overrides, listeners, current, reader, window, emitChange };
}

// Explicit synthetic controller for Panel hooks/UI only. Root separately tests the
// actual throttled controller, PDFJS DOM events, native verification and ledger.
export function createReadingTrackingFixture(f) {
  const calls = [], listeners = new Set();
  let trackingId = null, state = { phase: 'stopped', errorCode: null, recent: null, furthest: null };
  const update = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const controller = {
    snapshot: () => structuredClone(state),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async preview => {
      calls.push({ action: 'start', token: preview.token }); update({ phase: 'starting', errorCode: null });
      try {
        if (f.overrides.has('tracking_start')) await f.overrides.get('tracking_start')(preview);
        const result = await f.window.paperquay.invoke('desktop_reading_track_start', { token: preview.token }); trackingId = result.trackingId;
        update({ phase: 'recording', recent: { pageIndex: result.capture.pageIndex, offsetRatio: result.capture.offsetRatio, observedAt: result.capture.observedAt }, furthest: { pageIndex: result.furthestPageIndex, offsetRatio: result.furthestOffsetRatio } });
        f.emitChange();
      } catch (error) { update({ phase: 'error', errorCode: error.code || error.message }); throw error; }
    },
    stop: async () => {
      calls.push({ action: 'stop', trackingId });
      try {
        if (f.overrides.has('tracking_stop')) await f.overrides.get('tracking_stop')();
        if (trackingId) await f.window.paperquay.invoke('desktop_reading_track_stop', { trackingId });
        trackingId = null; update({ phase: 'stopped', errorCode: null }); f.emitChange();
      } catch (error) { update({ phase: 'error', errorCode: error.code || error.message }); f.emitChange(); throw error; }
    },
  };
  return { controller, calls, listeners, update };
}
