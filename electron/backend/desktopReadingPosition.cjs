const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key)) && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => row.enumerable && 'value' in row);
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'READING_FAILED';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createDesktopReadingPosition(context, options) {
  const core = options.core, files = options.fs || nativeFs, uuid = options.randomUUID || randomUUID, limit = core.DESKTOP_READING_LIMITS;
  const root = path.join(path.dirname(context.appPaths.configPath), 'account-sync', 'reading-positions');
  let supported = false, loaded = null, previewValue = null, tracking = null, closed = false, generation = 0;
  let queue = Promise.resolve(), controller = null, busy = 0, lastError = null;
  const retained = new Map(), sessions = new Map(), now = () => new Date(options.now ? options.now() : Date.now()).toISOString();
  const notify = () => { try { options.onChange?.(); } catch {} };
  const same = (a, b) => core.canonicalJson(a) === core.canonicalJson(b);
  const sameSource = (a, b) => core.sameDesktopReadingSource(a, b);
  function clearTracking() { if (tracking) { tracking = null; notify(); } }
  function identity(snapshot) {
    if (!snapshot?.account || !snapshot.library || !snapshot.config) return null;
    const scope = core.validateDesktopReadingScope({ serviceKey: sha(JSON.stringify([snapshot.config.apiBaseUrl, snapshot.config.oidcIssuer, snapshot.config.oidcClientId])),
      accountId: snapshot.account.accountId, libraryBindingId: snapshot.library.libraryBindingId });
    if (!UUID.test(snapshot.account.deviceId)) fail('READING_SCOPE_CHANGED');
    return { scope, file: path.join(root, sha(core.canonicalJson(scope)) + '.json'), scopeKey: sha(JSON.stringify([scope, snapshot.account.deviceId, snapshot.epoch])) };
  }
  const currentIdentity = () => { try { return identity(options.getContext()); } catch { return null; } };
  function check(owner, signal) {
    if (closed || signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED'); options.checkContext(owner.snapshot);
    if (currentIdentity()?.scopeKey !== owner.scopeKey) fail('DESKTOP_OPERATION_CANCELLED');
  }
  function readPrivate(file) { try { return files.readSync(file, { maxBytes: limit.privateBytes, singleLink: true }).bytes; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  function align(owner) {
    if (!owner.pending && owner.state.sync.deviceId !== owner.snapshot.account.deviceId)
      owner.state = core.withDesktopReadingSync(owner.state, core.rebindDevice(owner.state.sync, owner.snapshot.account.deviceId));
    return owner;
  }
  function open() {
    const snapshot = options.getContext(), ownerId = identity(snapshot);
    if (!ownerId) fail('AUTHENTICATION_REQUIRED'); options.checkContext(snapshot); if (closed) fail('DESKTOP_OPERATION_CANCELLED');
    if (loaded?.scopeKey === ownerId.scopeKey) return align(loaded); previewValue = null; clearTracking();
    const held = retained.get(ownerId.file);
    if (held) { loaded = { ...held, ...ownerId, snapshot }; retained.set(ownerId.file, loaded); return align(loaded); }
    const bytes = readPrivate(ownerId.file); let state;
    if (bytes === null) state = core.createDesktopReadingState(ownerId.scope, snapshot.account.deviceId);
    else {
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('READING_STATE_INVALID'); }
      state = core.readDesktopReadingState(value, ownerId.scope);
      state = core.withDesktopReadingSync(state, core.rebindDevice(state.sync, snapshot.account.deviceId));
    }
    loaded = { ...ownerId, snapshot, state, diskHash: bytes === null ? null : sha(bytes), pending: null }; return loaded;
  }
  function assertSaved(owner) { if (owner.pending) fail('READING_SAVE_UNCONFIRMED'); }
  function commit(owner, input, { receipt = false } = {}) {
    if (!receipt) check(owner);
    const state = core.readDesktopReadingState(input, owner.scope), bytes = Buffer.from(JSON.stringify(state)), nextHash = sha(bytes);
    if (bytes.length > limit.privateBytes) fail('READING_STATE_FULL'); const pending = { state, nextHash, previousHash: owner.diskHash };
    try {
      const actual = readPrivate(owner.file), hash = actual === null ? null : sha(actual);
      if (hash !== nextHash) {
        if (hash !== pending.previousHash) fail('READING_STORAGE_CHANGED');
        files.mkdirSync(root); files.writeSync(owner.file, bytes, { mode: 0o600 });
        const confirmed = readPrivate(owner.file); if (!confirmed || sha(confirmed) !== nextHash) fail('READING_SAVE_UNCONFIRMED');
      }
      owner.state = state; owner.diskHash = nextHash; owner.pending = null; retained.delete(owner.file); previewValue = null; notify();
    } catch (error) {
      owner.pending = pending; retained.set(owner.file, owner); previewValue = null;
      lastError = codeOf(error) === 'READING_STORAGE_CHANGED' ? 'READING_STORAGE_CHANGED' : 'READING_SAVE_UNCONFIRMED'; notify(); fail(lastError);
    }
  }
  function status() {
    const visible = currentIdentity(); pruneTracking(visible);
    const owner = loaded?.scopeKey === visible?.scopeKey ? loaded : null, state = owner?.pending?.state || owner?.state;
    const continuable = state ? state.sync.outbox.filter(row => ['queued', 'uncertain'].includes(row.status) && row.originDeviceId === state.sync.deviceId).length
      + state.pendingResolutions.filter(row => row.originDeviceId === state.sync.deviceId && (!row.lastResult || row.lastResult.status === 'rejected' && row.lastResult.retryable)).length : 0;
    return { scopeKey: visible?.scopeKey || null, supported: !!visible && supported, busy: busy > 0, revision: state?.revision || 0,
      pending: state ? state.sync.outbox.length + state.pendingResolutions.length : 0, continuable,
      conflicts: state ? Object.keys(state.sync.conflicts).length : 0, saveUnconfirmed: !!owner?.pending,
      tracking: tracking ? { trackingId: tracking.id, bindingId: tracking.source.bindingId, attachmentVersionId: tracking.source.attachmentVersionId } : null,
      errorCode: lastError };
  }
  function action(operation) {
    const requested = generation, task = queue.then(async () => {
      if (closed || requested !== generation) fail('DESKTOP_OPERATION_CANCELLED'); busy++; controller = new AbortController(); lastError = null; notify();
      try { return await operation(controller.signal); } catch (error) { lastError = codeOf(error); throw Object.assign(new Error(lastError), { code: lastError }); }
      finally { controller = null; busy--; notify(); }
    }); queue = task.catch(() => {}); return task;
  }
  function online(owner, signal) { check(owner, signal); if (!supported) fail('READING_FEATURE_UNAVAILABLE'); assertSaved(owner); }
  async function api(owner, input, signal) { online(owner, signal); return options.api(owner.snapshot, { ...input, signal }); }
  function material(owner, pageCount) {
    check(owner); const rows = options.getBindings(owner.snapshot);
    if (!Array.isArray(rows) || rows.length > limit.bindings) fail('READING_BINDING_INVALID'); const seen = new Set();
    return rows.map(row => {
      if (!exact(row, ['bindingId', 'localPaperId', 'localAttachmentId', 'paperId', 'attachmentVersionId', 'sha256', 'sizeBytes', 'title', 'fileName'])
        || seen.has(row.bindingId)) fail('READING_BINDING_INVALID'); seen.add(row.bindingId);
      return core.readVerifiedDesktopReadingSource({ ...row, pageCount });
    });
  }
  function assertBinding(owner, source) {
    const row = material(owner, source.pageCount).find(value => value.bindingId === source.bindingId);
    if (!row || !sameSource(row, source)) fail('READING_BINDING_CHANGED'); return row;
  }
  function pruneTracking(visible = currentIdentity()) {
    if (!tracking) return;
    if (closed || !supported || tracking.owner.scopeKey !== visible?.scopeKey) { clearTracking(); return; }
    try { assertBinding(tracking.owner, tracking.source); }
    catch (error) { lastError = codeOf(error); clearTracking(); }
  }
  async function verify(owner, captureInput, signal, expected = null) {
    const capture = core.readDesktopReadingCapture(captureInput); online(owner, signal);
    const before = material(owner, capture.pageCount).find(row => row.bindingId === capture.bindingId);
    if (!before || before.sha256 !== capture.sha256 || before.sizeBytes !== capture.sizeBytes) fail('READING_BINDING_CHANGED');
    const source = core.readVerifiedDesktopReadingSource(await options.verifySource(owner.snapshot, structuredClone(capture), signal)); check(owner, signal);
    if (!sameSource(source, before) || expected && !sameSource(source, expected) || !sameSource(assertBinding(owner, source), before)) fail('READING_SOURCE_CHANGED');
    return source;
  }
  function budgetResponse(value, budget) {
    let length; try { length = Buffer.byteLength(core.canonicalJson(value)); } catch { fail('READING_STATE_INVALID'); }
    budget.bytes += length; if (budget.bytes > limit.privateBytes) fail('READING_STATE_FULL');
  }
  async function pull(owner, state, signal, budget) {
    const pages = [], seen = new Set(); let cursor = state.sync.cursor;
    for (let index = 0; index < limit.pullPages; index++) {
      const query = new URLSearchParams({ limit: '1' }); if (cursor !== null) query.set('cursor', cursor);
      const response = await api(owner, { path: '/v1/sync/pull?' + query }, signal); check(owner, signal); budgetResponse(response, budget);
      const checked = core.validatePullResponse(response); if (!checked.ok) fail('READING_STATE_INVALID'); pages.push(checked.value);
      if (!checked.value.hasMore) return core.stageDesktopReadingPull(state, pages, now());
      if (checked.value.nextCursor === cursor || seen.has(checked.value.nextCursor)) fail('READING_STATE_INVALID'); seen.add(checked.value.nextCursor); cursor = checked.value.nextCursor;
    } fail('READING_LIMIT');
  }
  async function conflicts(owner, state, signal, budget) {
    let cursor = null, sync = state.sync; const seen = new Set(), all = new Set();
    for (let index = 0; index < limit.pullPages; index++) {
      const query = new URLSearchParams({ limit: '1' }); if (cursor !== null) query.set('cursor', cursor);
      const page = await api(owner, { path: '/v1/conflicts?' + query }, signal); check(owner, signal); budgetResponse(page, budget);
      if (!exact(page, ['conflicts', 'nextCursor', 'hasMore']) || !Array.isArray(page.conflicts) || page.conflicts.length > 1
        || typeof page.nextCursor !== 'string' || typeof page.hasMore !== 'boolean') fail('READING_STATE_INVALID');
      for (const row of page.conflicts) {
        if (!exact(row, ['conflictId', 'entityId', 'entityType', 'createdAt', 'attemptedOperation', 'observedRecord', 'currentRecord']) || !UUID.test(row.conflictId)) fail('READING_STATE_INVALID');
        const operation = core.validateOperation(row.attemptedOperation);
        if (!operation.ok || operation.value.entityId !== row.entityId || operation.value.entityType !== row.entityType
          || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || new Date(row.createdAt).toISOString() !== row.createdAt) fail('READING_STATE_INVALID');
        for (const record of [row.observedRecord, row.currentRecord]) if (record !== null) {
          const checked = core.validateRecord(record); if (!checked.ok || checked.value.entityId !== row.entityId || checked.value.entityType !== row.entityType) fail('READING_STATE_INVALID');
        }
        if (row.entityType !== 'readingPosition') continue;
        if (all.has(row.conflictId)) fail('READING_STATE_INVALID'); all.add(row.conflictId);
        const prior = sync.conflicts[row.conflictId]; if (prior && !same(prior.attempted, operation.value)) fail('READING_STATE_INVALID');
        sync = { ...sync, conflicts: { ...sync.conflicts, [row.conflictId]: { conflictId: row.conflictId, attempted: operation.value, current: row.currentRecord } } };
      }
      if (!page.hasMore) {
        for (const row of Object.values(sync.conflicts)) if (!all.has(row.conflictId) && !state.pendingResolutions.some(value => value.conflictId === row.conflictId))
          sync = core.applyRemoteConflictResolution(sync, core.getSyncContext(sync), { conflictId: row.conflictId, record: sync.serverRecords['readingPosition:' + row.attempted.entityId] || null });
        return core.withDesktopReadingSync(state, sync);
      }
      if (page.nextCursor === cursor || seen.has(page.nextCursor)) fail('READING_STATE_INVALID'); seen.add(page.nextCursor); cursor = page.nextCursor;
    } fail('READING_LIMIT');
  }
  async function devices(owner, signal, budget) {
    let page;
    try { page = await api(owner, { path: '/v1/devices' }, signal); }
    catch (error) {
      check(owner, signal);
      if (['NOT_FOUND', 'METHOD_NOT_ALLOWED', 'UNSUPPORTED', 'NETWORK_ERROR', 'NETWORK_UNAVAILABLE', 'DESKTOP_REQUEST_TIMEOUT'].includes(codeOf(error))) return new Map(); throw error;
    }
    check(owner, signal); budgetResponse(page, budget);
    if (!exact(page, ['devices']) || !Array.isArray(page.devices) || page.devices.length > limit.positions) fail('READING_STATE_INVALID');
    const result = new Map();
    for (const row of page.devices) {
      if (!exact(row, ['id', 'name', 'platform', 'createdAt', 'lastSeenAt', 'revokedAt']) || !UUID.test(row.id) || result.has(row.id)
        || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80 || /[\x00-\x1f\x7f]/.test(row.name)
        || !['web', 'windows', 'macos', 'linux', 'ios', 'android'].includes(row.platform)) fail('READING_STATE_INVALID');
      for (const value of [row.createdAt, row.lastSeenAt, ...(row.revokedAt === null ? [] : [row.revokedAt])])
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('READING_STATE_INVALID');
      result.set(row.id, row.name);
    }
    return result;
  }
  function positions(state, source, labels) {
    return Object.values(state.sync.serverRecords).filter(row => row.entityType === 'readingPosition' && row.deletedAt === null && row.data
      && core.desktopReadingPointFits(row.data, source)).sort((a, b) => b.data.observedAt.localeCompare(a.data.observedAt)
      || b.data.deviceSequence - a.data.deviceSequence || b.revision - a.revision || a.entityId.localeCompare(b.entityId))
      .map(row => ({ entityId: row.entityId, revision: row.revision, deviceId: row.modifiedByDeviceId, deviceName: labels.get(row.modifiedByDeviceId) || null,
        isCurrentDevice: row.modifiedByDeviceId === state.sync.deviceId, data: row.data }));
  }
  function publicPreview(value) {
    const state = value.candidate, plan = core.desktopReadingPlan(state, value.source);
    const pendingRows = state.sync.outbox.map(row => ({ opId: row.operation.opId, entityId: row.operation.entityId,
      label: state.intents.find(value => value.opId === row.operation.opId)?.source.title || 'Reading position', mutation: row.operation.mutation,
      stage: row.status, errorCode: row.errorCode, data: row.operation.data }));
    const rows = Object.values(state.sync.conflicts).map(row => {
      const head = state.sync.serverRecords['readingPosition:' + row.attempted.entityId], current = head && head.revision > (row.current?.revision || 0) ? head : row.current;
      const proof = state.intents.find(value => value.opId === row.attempted.opId); let reason = !proof || proof.originDeviceId !== state.sync.deviceId
        || [head, row.current].some(record => record && record.modifiedByDeviceId !== proof.originDeviceId) ? 'READING_DEVICE_CHANGED' : null;
      if (!reason) try { assertBinding(value.owner, proof.source); } catch { reason = 'READING_BINDING_CHANGED'; }
      return { conflictId: row.conflictId, entityId: row.attempted.entityId, label: proof?.source.title || 'Reading position', expectedRevision: current?.revision || 0,
        canResolve: !reason, reason, attempted: { mutation: row.attempted.mutation, data: row.attempted.data },
        current: current ? { revision: current.revision, deletedAt: current.deletedAt, data: current.data } : null };
    });
    return structuredClone({ token: value.token, scopeKey: value.owner.scopeKey, revision: value.baseRevision, source: value.source, capture: value.capture,
      publicationAction: plan.publicationAction, publicationReason: plan.publicationReason, own: plan.own,
      localDraft: core.desktopReadingLocalDraft(state, value.source),
      positions: positions(state, value.source, value.labels), pendingRows, conflicts: rows,
      pendingResolutions: state.pendingResolutions.map(row => ({ conflictId: row.conflictId, ...row.request,
        errorCode: row.originDeviceId === state.sync.deviceId ? null : 'READING_DEVICE_CHANGED',
        lastResult: row.lastResult ? { status: row.lastResult.status, ...(row.lastResult.code ? { code: row.lastResult.code } : {}),
          ...(row.lastResult.retryable === undefined ? {} : { retryable: row.lastResult.retryable }) } : null })) });
  }
  function checkedPreview(owner, token, signal) {
    assertSaved(owner); check(owner, signal); const value = previewValue;
    if (!value || value.owner !== owner || value.token !== token || value.baseRevision !== owner.state.revision) fail('READING_PREVIEW_STALE');
    assertBinding(owner, value.source); return value;
  }
  async function send(owner, signal) {
    online(owner, signal);
    for (let index = 0; index < 32; index++) {
      online(owner, signal);
      const resolution = owner.state.pendingResolutions.find(row => row.originDeviceId === owner.state.sync.deviceId
        && (!row.lastResult || row.lastResult.status === 'rejected' && row.lastResult.retryable));
      if (resolution) {
        const conflict = owner.state.sync.conflicts[resolution.conflictId], proof = owner.state.intents.find(row => row.opId === conflict?.attempted.opId);
        if (!proof || proof.originDeviceId !== owner.state.sync.deviceId) fail('READING_DEVICE_CHANGED');
        await verify(owner, proof.capture, signal, proof.source); check(owner, signal);
        const response = await api(owner, { path: '/v1/conflicts/' + resolution.conflictId + '/resolve', method: 'POST', body: resolution.request }, signal);
        commit(owner, core.applyDesktopReadingResolution(owner.state, resolution.conflictId, response), { receipt: true }); check(owner, signal);
        if (response.status !== 'applied') break; continue;
      }
      const ready = owner.state.sync.outbox.find(row => ['queued', 'uncertain'].includes(row.status) && row.originDeviceId === owner.state.sync.deviceId); if (!ready) break;
      const proof = owner.state.intents.find(row => row.opId === ready.operation.opId); if (!proof) fail('READING_STATE_INVALID');
      await verify(owner, proof.capture, signal, proof.source); check(owner, signal);
      const prepared = core.preparePush(owner.state.sync, core.getSyncContext(owner.state.sync), 1);
      if (prepared.opIds[0] !== ready.operation.opId) fail('READING_STATE_INVALID');
      commit(owner, core.withDesktopReadingSync(owner.state, prepared.state)); let response;
      try { response = await api(owner, { path: '/v1/sync/push', method: 'POST', body: prepared.request }, signal); }
      catch (error) { commit(owner, core.withDesktopReadingSync(owner.state, core.markPushUncertain(owner.state.sync, prepared.context, prepared.opIds, 'NETWORK_ERROR')), { receipt: true }); throw error; }
      let after;
      try { after = core.applyDesktopReadingPush(owner.state, prepared.context, response, prepared.opIds); }
      catch (error) { commit(owner, core.withDesktopReadingSync(owner.state, core.markPushUncertain(owner.state.sync, prepared.context, prepared.opIds, 'INVALID_RESPONSE')), { receipt: true }); throw error; }
      commit(owner, after, { receipt: true }); check(owner, signal); if (response.results.some(row => row.status !== 'applied')) break;
    }
    return status();
  }
  const result = {
    status,
    setCapability(value) { supported = value === true; if (!supported) { clearTracking(); result.stop(); } previewValue = null; notify(); },
    refreshStatus() { return action(() => { open(); return status(); }); },
    versions(args) { return action(signal => {
      if (!exact(args, ['localPaperId', 'sha256', 'sizeBytes', 'pageCount']) || !core.isDesktopLocalId(args.localPaperId)) fail('READING_SELECTION_INVALID');
      core.readDesktopReadingCapture({ bindingId: '00000000-0000-4000-8000-000000000001', sha256: args.sha256, sizeBytes: args.sizeBytes,
        pageCount: args.pageCount, pageIndex: 0, offsetRatio: 0, observedAt: now() });
      const owner = open(); check(owner, signal);
      return { scopeKey: owner.scopeKey, versions: material(owner, args.pageCount).filter(row => row.localPaperId === args.localPaperId && row.sha256 === args.sha256 && row.sizeBytes === args.sizeBytes) };
    }); },
    preview(args) { return action(async signal => {
      if (!exact(args, ['capture'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal);
      const capture = core.readDesktopReadingCapture(args.capture), source = await verify(owner, capture, signal), budget = { bytes: 0 };
      let candidate = await pull(owner, owner.state, signal, budget); candidate = await conflicts(owner, candidate, signal, budget);
      const labels = await devices(owner, signal, budget); await verify(owner, capture, signal, source); check(owner, signal);
      previewValue = { owner, capture, source, candidate, labels, token: uuid(), baseRevision: owner.state.revision }; notify(); return publicPreview(previewValue);
    }); },
    startTracking(args) { return action(async signal => {
      if (!exact(args, ['token'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal); pruneTracking();
      if (tracking) fail('READING_TRACKING_ACTIVE'); const value = checkedPreview(owner, args.token, signal);
      await verify(owner, value.capture, signal, value.source); checkedPreview(owner, args.token, signal);
      const sessionId = uuid(), id = uuid(), candidate = core.stageDesktopReadingDraft(value.candidate, value.source, value.capture, sessionId);
      commit(owner, candidate);
      sessions.set(JSON.stringify([owner.scopeKey, value.source.attachmentVersionId]), sessionId);
      tracking = { id, owner, source: structuredClone(value.source), sessionId, lastSequence: 0, lastPoint: null }; notify();
      const local = core.desktopReadingLocalDraft(owner.state, value.source);
      return { status: status(), trackingId: id, source: structuredClone(value.source), capture: structuredClone(local.capture),
        furthestPageIndex: local.furthestPageIndex, furthestOffsetRatio: local.furthestOffsetRatio };
    }); },
    recordTracked(args) { return action(signal => {
      const requestedId = args && Object.getOwnPropertyDescriptor(args, 'trackingId')?.value;
      try {
        if (!exact(args, ['trackingId', 'sequence', 'point']) || !UUID.test(args.trackingId)
          || !Number.isSafeInteger(args.sequence) || args.sequence < 1) fail('DESKTOP_ARGUMENT_INVALID');
        const owner = open(); online(owner, signal); const active = tracking;
        if (!active || active.id !== args.trackingId || active.owner !== owner) fail('READING_TRACKING_CHANGED');
        assertBinding(owner, active.source); const point = core.readDesktopReadingTrackedPoint(args.point, active.source.pageCount);
        if (args.sequence === active.lastSequence && same(point, active.lastPoint)) return status();
        if (args.sequence <= active.lastSequence || active.lastSequence === 0 && args.sequence !== 1) fail('READING_TRACKING_SEQUENCE');
        const candidate = core.recordDesktopReadingDraft(owner.state, active.source, active.sessionId, point); commit(owner, candidate);
        active.lastSequence = args.sequence; active.lastPoint = point; return status();
      } catch (error) { if (tracking?.id === requestedId) clearTracking(); throw error; }
    }); },
    stopTracking(args) { return action(() => {
      if (!exact(args, ['trackingId']) || !UUID.test(args.trackingId)) fail('DESKTOP_ARGUMENT_INVALID');
      if (tracking?.id === args.trackingId) clearTracking(); return status();
    }); },
    publish(args) { return action(async signal => {
      if (!exact(args, ['token'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal); const value = checkedPreview(owner, args.token, signal);
      await verify(owner, value.capture, signal, value.source); checkedPreview(owner, args.token, signal);
      const plan = core.desktopReadingPlan(value.candidate, value.source); if (plan.publicationAction === 'blocked') fail(plan.publicationReason);
      const sessionKey = JSON.stringify([owner.scopeKey, value.source.attachmentVersionId]); if (!sessions.has(sessionKey)) sessions.set(sessionKey, uuid());
      const candidate = core.stageDesktopReadingPublication(value.candidate, value.source, value.capture,
        { opId: uuid(), entityId: plan.own?.entityId || uuid(), sessionId: sessions.get(sessionKey) }, now());
      commit(owner, candidate); return send(owner, signal);
    }); },
    resume(args) { return action(async signal => {
      if (!exact(args, ['token', 'entityId', 'expectedRevision']) || !UUID.test(args.entityId) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) fail('READING_SELECTION_INVALID');
      const owner = open(); online(owner, signal); const value = checkedPreview(owner, args.token, signal);
      const selected = value.candidate.sync.serverRecords['readingPosition:' + args.entityId];
      if (!selected || selected.revision !== args.expectedRevision || selected.deletedAt !== null || !selected.data || !core.desktopReadingPointFits(selected.data, value.source)) fail('READING_PREVIEW_STALE');
      await verify(owner, value.capture, signal, value.source); checkedPreview(owner, args.token, signal);
      const fresh = await pull(owner, value.candidate, signal, { bytes: 0 });
      const current = fresh.sync.serverRecords['readingPosition:' + args.entityId]; if (!current || !same(current, selected)) fail('READING_PREVIEW_STALE');
      await verify(owner, value.capture, signal, value.source); checkedPreview(owner, args.token, signal);
      return { scopeKey: owner.scopeKey, source: structuredClone(value.source), position: structuredClone(selected.data),
        origin: { entityId: selected.entityId, revision: selected.revision, deviceId: selected.modifiedByDeviceId, deviceName: value.labels.get(selected.modifiedByDeviceId) || null } };
    }); },
    continue() { return action(signal => send(open(), signal)); },
    resolve(args) { return action(async signal => {
      if (!exact(args, ['conflictId', 'choice', 'expectedRevision'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal);
      const base = previewValue?.owner === owner ? checkedPreview(owner, previewValue.token, signal).candidate : owner.state;
      const candidate = core.stageDesktopReadingResolution(base, args.conflictId, args.choice, args.expectedRevision, uuid());
      const conflict = candidate.sync.conflicts[args.conflictId], proof = candidate.intents.find(row => row.opId === conflict.attempted.opId);
      await verify(owner, proof.capture, signal, proof.source); check(owner, signal); commit(owner, candidate); return send(owner, signal);
    }); },
    retrySave() { return action(() => { const owner = open(); check(owner); if (owner.pending) commit(owner, owner.pending.state); align(owner); return status(); }); },
    backup() { return action(() => { const owner = open(); check(owner); return { format: 'paperquay-desktop-reading-backup', version: 1, exportedAt: now(),
      state: structuredClone(owner.state), unconfirmedState: owner.pending ? structuredClone(owner.pending.state) : null }; }); },
    stop() { generation++; controller?.abort(); previewValue = null; notify(); return queue; },
    invalidate() { clearTracking(); result.stop(); loaded = null; supported = false; lastError = null; notify(); },
    settled() { return queue; }, close() { closed = true; clearTracking(); result.stop(); },
  }; return result;
}
module.exports = { createDesktopReadingPosition };
