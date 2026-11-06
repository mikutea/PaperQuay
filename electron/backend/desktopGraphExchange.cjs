const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const errorCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
  ? error.code : 'GRAPH_EXCHANGE_FAILED';

/** The caller owns the existing account lock until settled(). There is no
 * scheduler here. The library's relation JSON is a read-only publication source;
 * all graph sync intent and accepted account rows live in one private snapshot. */
function createDesktopGraphExchange(context, options) {
  const core = options.core, fs = options.fs || nativeFs, uuid = options.randomUUID || randomUUID;
  const root = path.join(path.dirname(context.appPaths.configPath), 'account-sync', 'graph');
  const limit = core.DESKTOP_GRAPH_LIMITS;
  let supported = false, loaded = null, previewValue = null, closed = false, generation = 0;
  let queue = Promise.resolve(), controller = null, busy = 0, lastError = null;
  const retained = new Map(); // Only candidates whose local save was not confirmed.
  const stamp = () => new Date(options.now ? options.now() : Date.now()).toISOString();
  const notify = () => { try { options.onChange?.(); } catch {} try { options.onProjectionChange?.(); } catch {} };

  function identity(snapshot) {
    if (!snapshot?.account || !snapshot.library || !snapshot.config) return null;
    const scope = core.validateDesktopGraphScope({
      serviceKey: sha(JSON.stringify([snapshot.config.apiBaseUrl, snapshot.config.oidcIssuer, snapshot.config.oidcClientId])),
      accountId: snapshot.account.accountId, libraryBindingId: snapshot.library.libraryBindingId,
    });
    const fileKey = sha(core.canonicalJson(scope));
    return { scope, file: path.join(root, fileKey + '.json'),
      scopeKey: sha(JSON.stringify([scope, snapshot.account.deviceId, snapshot.epoch])) };
  }
  function currentIdentity() { try { return identity(options.getContext()); } catch { return null; } }
  function check(owner, signal) {
    if (closed || signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED');
    options.checkContext(owner.snapshot);
    if (currentIdentity()?.scopeKey !== owner.scopeKey) fail('DESKTOP_OPERATION_CANCELLED');
  }
  function mapping(owner) {
    check(owner);
    // Account metadata may be committed with a new library object within the
    // same login epoch. Always read its current bindings, not the old snapshot.
    const material = options.getMaterialBindings(options.getContext());
    return core.createDesktopGraphMapping({ scope: owner.scope, bindings: material.bindings, live: material.live });
  }
  function readPrivate(file) {
    try { return fs.readSync(file, { maxBytes: limit.privateBytes, singleLink: true }).bytes; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function open() {
    const snapshot = options.getContext(), ownerId = identity(snapshot);
    if (!ownerId) fail('AUTHENTICATION_REQUIRED');
    options.checkContext(snapshot);
    if (closed) fail('DESKTOP_OPERATION_CANCELLED');
    if (loaded?.scopeKey === ownerId.scopeKey) return loaded;
    previewValue = null;
    const held = retained.get(ownerId.file);
    if (held) { loaded = { ...held, ...ownerId, snapshot }; retained.set(ownerId.file, loaded); return loaded; }
    const bytes = readPrivate(ownerId.file);
    let state;
    try { state = bytes === null ? core.createDesktopGraphExchangeState(ownerId.scope, snapshot.account.deviceId)
      : core.readDesktopGraphExchangeState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ownerId.scope); }
    catch (error) { throw Object.assign(new Error(errorCode(error)), { code: errorCode(error) === 'GRAPH_EXCHANGE_FAILED' ? 'GRAPH_STATE_INVALID' : errorCode(error) }); }
    // Recovery is local only. A later explicit action persists this generation
    // before sending the original opId; opening never retries a request.
    if (bytes !== null) state = core.withDesktopGraphSync(state, core.rebindDevice(state.sync, snapshot.account.deviceId));
    loaded = { ...ownerId, snapshot, state, diskHash: bytes === null ? null : sha(bytes), pending: null };
    return loaded;
  }
  function readSource() {
    let bytes;
    try { bytes = fs.readSync(path.join(context.appPaths.dataDir, 'paperquay-knowledge-graph-relations.json'), { maxBytes: limit.privateBytes, singleLink: true }).bytes; }
    catch (error) { return { rows: [], status: error.code === 'ENOENT' ? 'missing' : 'invalid', identity: error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
    const identity = sha(bytes);
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || value.version !== 1 || !Array.isArray(value.relations) || value.relations.length > limit.sourceRelations) throw Error();
      return { rows: value.relations, status: 'available', identity };
    } catch { return { rows: [], status: 'invalid', identity }; }
  }
  function assertSaved(owner) { if (owner.pending) fail('GRAPH_SAVE_UNCONFIRMED'); }
  function commit(owner, value, { receipt = false } = {}) {
    if (!receipt) check(owner);
    const state = core.readDesktopGraphExchangeState(value, owner.scope);
    const bytes = Buffer.from(JSON.stringify(state)), nextHash = sha(bytes);
    if (bytes.length > limit.privateBytes) fail('GRAPH_STATE_FULL');
    const pending = { state, bytes, nextHash, previousHash: owner.diskHash };
    // NativeFS writes are atomic replacement, not CAS. This snapshot is under
    // the account writer lock. Read-back detects uncertain completion; the
    // comparison additionally refuses overwriting an externally changed file.
    try {
      const actual = readPrivate(owner.file), actualHash = actual === null ? null : sha(actual);
      if (actualHash !== nextHash) {
        if (actualHash !== pending.previousHash) fail('GRAPH_STORAGE_CHANGED');
        fs.mkdirSync(root);
        fs.writeSync(owner.file, bytes, { mode: 0o600 });
        const confirmed = readPrivate(owner.file);
        if (confirmed === null || sha(confirmed) !== nextHash) fail('GRAPH_SAVE_UNCONFIRMED');
      }
      owner.state = state; owner.diskHash = nextHash; owner.pending = null;
      retained.delete(owner.file); previewValue = null; notify();
    } catch (error) {
      owner.pending = pending; retained.set(owner.file, owner); previewValue = null;
      lastError = errorCode(error) === 'GRAPH_STORAGE_CHANGED' ? 'GRAPH_STORAGE_CHANGED' : 'GRAPH_SAVE_UNCONFIRMED';
      notify(); fail(lastError);
    }
  }
  function status() {
    const visible = currentIdentity(), owner = loaded?.scopeKey === visible?.scopeKey ? loaded : null;
    const state = owner?.pending?.state || owner?.state;
    let mapped = 0, unmapped = 0;
    if (owner) {
      try { const m = mapping(owner); mapped = m.bindings.length; unmapped = m.blocked.length;
        unmapped += core.projectAcceptedDesktopGraphRecords(owner.state, m).filter(row => row.kind === 'unmapped').length;
        if (previewValue?.owner === owner) unmapped += previewValue.review.rows.filter(row => row.reasonCode === 'UNMAPPED_GRAPH_ENDPOINT').length;
      } catch { /* An invalid current anchor hides the projection and mapping. */ }
    }
    return { scopeKey: visible?.scopeKey || null, supported: !!visible && supported, loaded: !!owner, busy: busy > 0,
      revision: owner?.state.revision || 0, pending: state ? state.sync.outbox.length + Object.keys(state.sync.overlays).length + state.pendingResolutions.length : 0,
      continuable: state ? state.sync.outbox.filter(row => row.status === 'queued' || row.status === 'uncertain').length
        + state.pendingResolutions.filter(row => !row.lastResult || row.lastResult.status === 'rejected' && row.lastResult.retryable === true).length : 0,
      conflicts: state ? Object.keys(state.sync.conflicts).length : 0, accepted: state?.accepted.length || 0,
      mapped, unmapped, errorCode: lastError, saveUnconfirmed: !!owner?.pending };
  }
  function action(operation) {
    const requested = generation;
    const task = queue.then(async () => {
      if (closed || requested !== generation) fail('DESKTOP_OPERATION_CANCELLED');
      busy++; controller = new AbortController(); lastError = null; notify();
      try { return await operation(controller.signal); }
      catch (error) { lastError = errorCode(error); throw Object.assign(new Error(lastError), { code: lastError }); }
      finally { controller = null; busy--; notify(); }
    });
    queue = task.catch(() => {}); return task;
  }
  function online(owner, signal) { check(owner, signal); if (!supported) fail('GRAPH_FEATURE_UNAVAILABLE'); assertSaved(owner); }
  async function api(owner, input, signal) { online(owner, signal); return options.api(owner.snapshot, { ...input, signal }); }
  function prepareReview(state, source, currentMapping) {
    return core.prepareDesktopGraphReview(state, source.rows, currentMapping, { sourceStatus: source.status });
  }
  function publicPreview(value) {
    const { owner, review, candidate } = value;
    const label = (data, fallback) => data?.label || fallback;
    return { token: value.token, scopeKey: owner.scopeKey, revision: value.baseRevision, checkedAt: candidate.checkedAt,
      localRows: review.rows.map(row => ({ key: row.rowId, localRelationId: row.localRelationId, entityId: row.entityId,
        label: label(row.data, label(row.server?.data, row.localRelationId || row.entityId || 'Relation')),
        action: row.kind === 'same' ? 'none' : row.kind, reason: row.reasonCode || undefined,
        local: row.data, remote: row.server?.data || null, raw: row.raw })),
      incoming: review.incoming.map(row => ({ key: row.entityId, entityId: row.entityId,
        label: label(row.record.data, label(row.accepted?.data, row.entityId)), state: row.kind,
        canAccept: row.canAccept,
        reason: row.kind === 'unmapped' ? 'UNMAPPED_GRAPH_ENDPOINT' : undefined, data: row.record.data, accepted: row.accepted?.data || null,
        revision: row.record.revision, acceptedRevision: row.accepted?.revision || null })),
      conflicts: Object.values(candidate.sync.conflicts).map(row => {
        const head = candidate.sync.serverRecords['graphRelation:' + row.attempted.entityId];
        const current = head && head.revision > (row.current?.revision || 0) ? head : row.current;
        return { conflictId: row.conflictId, entityId: row.attempted.entityId,
          label: label(row.attempted.data, label(current?.data, row.attempted.entityId)), expectedRevision: current?.revision || 0,
          attempted: { mutation: row.attempted.mutation, data: row.attempted.data },
          current: current ? { revision: current.revision, deletedAt: current.deletedAt, data: current.data } : null };
      }),
      pendingRows: [...candidate.sync.outbox.map(row => ({ opId: row.operation.opId, entityId: row.operation.entityId,
        label: label(row.operation.data, row.operation.entityId), mutation: row.operation.mutation, stage: row.status, data: row.operation.data })),
      ...Object.values(candidate.sync.overlays).map(row => ({ opId: row.opId, entityId: row.entityId,
        label: label(row.data, row.entityId), mutation: row.mutation, stage: 'overlay', data: row.data }))],
      pendingResolutions: candidate.pendingResolutions.map(row => ({ conflictId: row.conflictId, ...row.request, lastResult: row.lastResult })),
    };
  }
  function checkedPreview(owner, token) {
    assertSaved(owner); check(owner);
    const saved = previewValue, source = readSource(), currentMapping = mapping(owner);
    if (!saved || saved.owner !== owner || saved.token !== token || saved.baseRevision !== owner.state.revision
      || saved.source.identity !== source.identity || saved.source.status !== source.status || saved.mapping.identity !== currentMapping.identity) fail('GRAPH_PREVIEW_STALE');
    return saved;
  }
  async function fetchConflicts(owner, candidate, signal, budget) {
    let cursor = null, sync = candidate.sync; const seen = new Set(), all = new Set();
    for (let i = 0; i < limit.pullPages; i++) {
      const query = new URLSearchParams({ limit: '100' }); if (cursor !== null) query.set('cursor', cursor);
      const page = await api(owner, { path: '/v1/conflicts?' + query }, signal); check(owner, signal);
      budget.bytes += Buffer.byteLength(core.canonicalJson(page));
      if (budget.bytes > limit.privateBytes || !exact(page, ['conflicts', 'nextCursor', 'hasMore']) || !Array.isArray(page.conflicts)
        || page.conflicts.length > 100 || typeof page.nextCursor !== 'string' || page.nextCursor.length > 1024 || typeof page.hasMore !== 'boolean') fail('GRAPH_STATE_INVALID');
      for (const row of page.conflicts) {
        if (!exact(row, ['conflictId', 'entityId', 'entityType', 'createdAt', 'attemptedOperation', 'observedRecord', 'currentRecord'])) fail('GRAPH_STATE_INVALID');
        const operation = core.validateOperation(row.attemptedOperation);
        if (!operation.ok || operation.value.entityId !== row.entityId || operation.value.entityType !== row.entityType
          || !new RegExp(core.UUID_PATTERN).test(row.conflictId) || new Date(row.createdAt).toISOString() !== row.createdAt) fail('GRAPH_STATE_INVALID');
        for (const record of [row.observedRecord, row.currentRecord]) if (record !== null) {
          const valid = core.validateRecord(record);
          if (!valid.ok || valid.value.entityId !== row.entityId || valid.value.entityType !== row.entityType) fail('GRAPH_STATE_INVALID');
        }
        if (row.entityType !== 'graphRelation') continue;
        if (all.has(row.conflictId)) fail('GRAPH_STATE_INVALID'); all.add(row.conflictId);
        const existing = sync.conflicts[row.conflictId];
        if (existing && core.canonicalJson(existing.attempted) !== core.canonicalJson(operation.value)) fail('GRAPH_STATE_INVALID');
        sync = { ...sync, conflicts: { ...sync.conflicts, [row.conflictId]: {
          conflictId: row.conflictId, attempted: operation.value, current: row.currentRecord } } };
      }
      if (!page.hasMore) {
        for (const conflict of Object.values(sync.conflicts)) {
          if (all.has(conflict.conflictId) || candidate.pendingResolutions.some(row => row.conflictId === conflict.conflictId)) continue;
          sync = core.applyRemoteConflictResolution(sync, core.getSyncContext(sync), { conflictId: conflict.conflictId,
            record: sync.serverRecords['graphRelation:' + conflict.attempted.entityId] || null });
        }
        return core.withDesktopGraphSync(candidate, sync);
      }
      if (seen.has(page.nextCursor) || page.nextCursor === cursor) fail('GRAPH_STATE_INVALID'); seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    fail('GRAPH_LIMIT');
  }
  async function preview(signal) {
    const owner = open(); online(owner, signal);
    const source = readSource(), currentMapping = mapping(owner), pages = [], budget = { bytes: 0 };
    let cursor = owner.state.sync.cursor;
    for (let i = 0; i < limit.pullPages; i++) {
      const query = new URLSearchParams({ limit: '100' }); if (cursor !== null) query.set('cursor', cursor);
      const response = await api(owner, { path: '/v1/sync/pull?' + query }, signal); check(owner, signal);
      const parsed = core.validatePullResponse(response); if (!parsed.ok) fail('GRAPH_STATE_INVALID');
      budget.bytes += Buffer.byteLength(core.canonicalJson(parsed.value)); if (budget.bytes > limit.privateBytes) fail('GRAPH_STATE_FULL');
      pages.push(parsed.value);
      if (!parsed.value.hasMore) break;
      if (parsed.value.nextCursor === cursor || i + 1 === limit.pullPages) fail('GRAPH_LIMIT'); cursor = parsed.value.nextCursor;
    }
    let candidate = core.stageDesktopGraphPull(owner.state, pages, currentMapping, stamp());
    candidate = await fetchConflicts(owner, candidate, signal, budget);
    check(owner, signal);
    if (mapping(owner).identity !== currentMapping.identity || readSource().identity !== source.identity) fail('GRAPH_PREVIEW_STALE');
    const value = { owner, candidate, mapping: currentMapping, source,
      baseRevision: owner.state.revision, token: uuid(), review: prepareReview(candidate, source, currentMapping) };
    previewValue = value; notify(); return publicPreview(value);
  }
  function assertEndpoints(owner, data) {
    if (!data) return;
    const current = mapping(owner), available = new Set(current.bindings.map(row => row.entityType + ':' + row.entityId));
    const deleted = new Set(owner.state.parentHeads.filter(row => row.deleted).map(row => row.entityType + ':' + row.entityId));
    for (const ref of [data.source, data.target]) if (!available.has(ref.entityType + ':' + ref.entityId) || deleted.has(ref.entityType + ':' + ref.entityId)) fail('UNMAPPED_GRAPH_ENDPOINT');
  }
  function acknowledged(owner, before, after, ids) {
    // Editing an already accepted account row is explicit acceptance of that
    // edit. Publishing a new local row never adds an accepted account overlay.
    const acceptedIds = new Set(before.accepted.map(row => row.entityId));
    const selections = ids.filter(id => acceptedIds.has(id) && !after.sync.outbox.some(row => row.operation.entityId === id)
      && !Object.values(after.sync.conflicts).some(row => row.attempted.entityId === id));
    return selections.length ? core.acceptDesktopGraphRecords(after, selections) : after;
  }
  async function send(owner, signal) {
    online(owner, signal);
    if (owner.state.sync.deviceId !== owner.snapshot.account.deviceId) {
      commit(owner, core.withDesktopGraphSync(owner.state, core.rebindDevice(owner.state.sync, owner.snapshot.account.deviceId)));
    }
    for (let i = 0; i < limit.pushPerRun; i++) {
      online(owner, signal);
      const resolution = owner.state.pendingResolutions.find(row => !row.lastResult || row.lastResult.status === 'rejected' && row.lastResult.retryable === true);
      if (resolution) {
        const conflict = owner.state.sync.conflicts[resolution.conflictId];
        const data = resolution.request.choice === 'attempted' ? conflict?.attempted.data : resolution.request.choice === 'merged' ? resolution.request.data : null;
        assertEndpoints(owner, data);
        const response = await api(owner, { path: '/v1/conflicts/' + resolution.conflictId + '/resolve', method: 'POST', body: resolution.request }, signal);
        const before = owner.state, after = core.acknowledgeDesktopGraphResolution(before, resolution.conflictId, response);
        commit(owner, acknowledged(owner, before, after, conflict ? [conflict.attempted.entityId] : []), { receipt: true });
        check(owner, signal); if (response.status !== 'applied') break; continue;
      }
      const ready = owner.state.sync.outbox.find(row => row.status === 'queued' || row.status === 'uncertain');
      if (!ready) break;
      assertEndpoints(owner, ready.operation.data);
      const prepared = core.preparePush(owner.state.sync, core.getSyncContext(owner.state.sync), 1);
      commit(owner, core.withDesktopGraphSync(owner.state, prepared.state));
      let response;
      try { response = await api(owner, { path: '/v1/sync/push', method: 'POST', body: prepared.request }, signal); }
      catch (error) {
        const uncertain = core.markPushUncertain(owner.state.sync, prepared.context, prepared.opIds, 'NETWORK_ERROR');
        commit(owner, core.withDesktopGraphSync(owner.state, uncertain), { receipt: true }); throw error;
      }
      const before = owner.state;
      let after;
      try { after = core.withDesktopGraphSync(before, core.applyPushResults(before.sync, prepared.context, response, prepared.opIds)); }
      catch (error) {
        commit(owner, core.withDesktopGraphSync(before, core.markPushUncertain(before.sync, prepared.context, prepared.opIds, 'INVALID_RESPONSE')), { receipt: true }); throw error;
      }
      commit(owner, acknowledged(owner, before, after, prepared.request.operations.map(row => row.entityId)), { receipt: true });
      check(owner, signal);
      // A retryable rejection is retained for the next explicit continue, not
      // repeated up to 32 times within the same click.
      if (response.results.some(row => row.status !== 'applied')) break;
    }
    return status();
  }
  function projection() {
    const owner = loaded; if (!owner || currentIdentity()?.scopeKey !== owner.scopeKey) return { relations: [], suppressedLocalIds: [] };
    try {
      const currentMapping = mapping(owner), source = readSource(), local = new Map(source.rows.map(row => [row?.id, row]));
      const relations = [], suppressedLocalIds = [];
      for (const row of core.projectAcceptedDesktopGraphRecords(owner.state, currentMapping)) {
        const pending = core.getVisibleEntity(owner.state.sync, 'graphRelation', row.entityId);
        const hidePendingDelete = pending?.pending && pending.deleted && ['queued', 'sending', 'uncertain', 'overlay'].includes(pending.status);
        if (row.kind === 'mapped' && !hidePendingDelete) relations.push(row.relation);
        if (row.kind === 'unmapped') continue;
        const link = owner.state.links.find(link => link.entityId === row.entityId), raw = link && local.get(link.localRelationId);
        if (raw) { try { if (core.canonicalJson(core.desktopGraphRelationToWire(raw, currentMapping, owner.scope).data) === core.canonicalJson(link.lastLocalData)) suppressedLocalIds.push(link.localRelationId); } catch {} }
      }
      return { relations, suppressedLocalIds };
    } catch { return { relations: [], suppressedLocalIds: [] }; }
  }
  function requireApplied(owner, entityId) {
    const entry = owner.state.sync.outbox.find(row => row.operation.entityId === entityId);
    if (entry?.status === 'rejected') fail('GRAPH_OPERATION_REJECTED');
    if (entry?.status === 'conflict' || Object.values(owner.state.sync.conflicts).some(row => row.attempted.entityId === entityId)) fail('GRAPH_CONFLICT');
    if (entry || owner.state.sync.overlays['graphRelation:' + entityId]) fail('GRAPH_PENDING');
    return status();
  }
  async function accountEdit(args, deleting, signal) {
    const owner = open(); online(owner, signal);
    const entityId = core.parseDesktopAccountGraphId(args?.id), accepted = owner.state.accepted.find(row => row.entityId === entityId);
    if (!entityId || !accepted || accepted.deletedAt !== null) fail('GRAPH_RELATION_NOT_FOUND');
    const visible = core.getVisibleEntity(owner.state.sync, 'graphRelation', entityId);
    if (visible?.pending && visible.deleted) return requireApplied(owner, entityId);
    const entry = owner.state.sync.outbox.find(row => row.operation.entityId === entityId);
    if (entry?.status === 'conflict' || entry?.status === 'rejected') return requireApplied(owner, entityId);
    const head = owner.state.sync.serverRecords['graphRelation:' + entityId];
    if (!head || head.revision !== accepted.revision) fail('GRAPH_PREVIEW_STALE');
    const data = visible?.pending && !visible.deleted ? visible.data : accepted.data;
    let nextData = null;
    if (!deleting) {
      const projected = core.graphWireToDesktop(accepted, mapping(owner), owner.scope);
      if (projected.kind !== 'mapped') fail('UNMAPPED_GRAPH_ENDPOINT');
      for (const key of ['source', 'target', 'type', 'createdAt']) if (args[key] !== undefined && args[key] !== projected.relation[key]) fail('GRAPH_BINDING_IMMUTABLE');
      nextData = core.validateGraphRelationData({ ...data,
        ...Object.fromEntries(['label', 'description', 'confidence', 'weight'].filter(key => args[key] !== undefined).map(key => [key, args[key]])), updatedAt: stamp() });
      assertEndpoints(owner, nextData);
    }
    const sync = core.queueLocalEdit(owner.state.sync, { entityType: 'graphRelation', entityId, mutation: deleting ? 'delete' : 'put', data: nextData }, { opId: uuid(), clientCreatedAt: stamp() });
    commit(owner, core.withDesktopGraphSync(owner.state, sync)); await send(owner, signal); return requireApplied(owner, entityId);
  }
  const result = {
    status, projection,
    setCapability(value) { supported = value === true; if (!supported) result.stop(); notify(); },
    refreshStatus() { return action(() => { open(); return status(); }); },
    preview() { return action(preview); },
    publish(args) { return action(async signal => {
      if (!exact(args, ['token', 'keys'])) fail('DESKTOP_ARGUMENT_INVALID');
      const owner = open(); online(owner, signal); const value = checkedPreview(owner, args.token);
      const next = core.materializeDesktopGraphPublication(value.candidate, value.review, args.keys,
        () => ({ entityId: uuid(), opId: uuid(), clientCreatedAt: stamp() }));
      commit(owner, next); return send(owner, signal);
    }); },
    adopt(args) { return action(() => {
      if (!exact(args, ['token', 'ids'])) fail('DESKTOP_ARGUMENT_INVALID');
      const owner = open(), value = checkedPreview(owner, args.token);
      if (!Array.isArray(args.ids) || args.ids.some(id => !value.review.incoming.find(row => row.entityId === id)?.canAccept)) fail('UNMAPPED_GRAPH_ENDPOINT');
      commit(owner, core.acceptDesktopGraphRecords(value.candidate, args.ids)); return status();
    }); },
    continue() { return action(signal => send(open(), signal)); },
    resolve(args) { return action(async signal => {
      const owner = open(); online(owner, signal);
      // Resolving a conflict observed in the RAM preview also adopts its feed
      // checkpoint, but never adopts unrelated incoming relation content.
      const base = previewValue?.owner === owner ? checkedPreview(owner, previewValue.token).candidate : owner.state;
      const next = core.stageDesktopGraphResolution(base, args, uuid); commit(owner, next); return send(owner, signal);
    }); },
    updateRelation(args) { return action(signal => accountEdit(args, false, signal)); },
    deleteRelation(args) { return action(async signal => { const value = await accountEdit(args, true, signal); return { ...value, deleted: true }; }); },
    backup() { return action(() => { const owner = open(); check(owner); return {
      format: 'paperquay-desktop-graph-backup', version: 1, exportedAt: stamp(),
      state: structuredClone(owner.state), unconfirmedState: owner.pending ? structuredClone(owner.pending.state) : null,
    }; }); },
    retrySave() { return action(() => {
      const owner = open(); check(owner); if (!owner.pending) return status();
      commit(owner, owner.pending.state); return status();
    }); },
    stop() { generation++; controller?.abort(); previewValue = null; notify(); return queue; },
    invalidate() { result.stop(); loaded = null; lastError = null; supported = false; notify(); },
    settled() { return queue; },
    close() { closed = true; result.stop(); },
  };
  return result;
}

module.exports = { createDesktopGraphExchange };
