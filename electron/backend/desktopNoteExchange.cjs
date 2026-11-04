const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');
const { createSavedNoteCapture } = require('./savedNoteCapture.cjs');
const { desktopNoteCopy, sameDesktopNoteCopy } = require('./desktopNoteCopy.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'NOTE_EXCHANGE_FAILED';

function createDesktopNoteExchange(context, options) {
  const core = options.core, fs = options.fs || nativeFs, uuid = options.randomUUID || randomUUID, limit = core.DESKTOP_NOTE_LIMITS;
  const root = path.join(path.dirname(context.appPaths.configPath), 'account-sync', 'notes');
  const capture = options.capture || createSavedNoteCapture(context, { ...options.captureOptions, core }).capture;
  let supported = false, richSupported = false, loaded = null, previewValue = null, closed = false, generation = 0;
  let queue = Promise.resolve(), controller = null, busy = 0, lastError = null;
  const retained = new Map(), now = () => new Date(options.now ? options.now() : Date.now()).toISOString();
  const notify = () => { try { options.onChange?.(); } catch {} try { options.onProjectionChange?.(); } catch {} };
  function identity(snapshot) {
    if (!snapshot?.account || !snapshot.library || !snapshot.config) return null;
    const scope = core.validateDesktopNoteScope({ serviceKey: sha(JSON.stringify([snapshot.config.apiBaseUrl, snapshot.config.oidcIssuer, snapshot.config.oidcClientId])),
      accountId: snapshot.account.accountId, libraryBindingId: snapshot.library.libraryBindingId });
    return { scope, file: path.join(root, sha(core.canonicalJson(scope)) + '.json'), scopeKey: sha(JSON.stringify([scope, snapshot.account.deviceId, snapshot.epoch])) };
  }
  const currentIdentity = () => { try { return identity(options.getContext()); } catch { return null; } };
  function check(owner, signal) {
    if (closed || signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED');
    options.checkContext(owner.snapshot);
    if (currentIdentity()?.scopeKey !== owner.scopeKey) fail('DESKTOP_OPERATION_CANCELLED');
  }
  function readPrivate(file) { try { return fs.readSync(file, { maxBytes: limit.privateBytes, singleLink: true }).bytes; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  function align(owner) {
    if (!owner.pending) {
      if (owner.state.sync.deviceId !== owner.snapshot.account.deviceId) owner.state = core.withDesktopNoteSync(owner.state, core.rebindDevice(owner.state.sync, owner.snapshot.account.deviceId));
      owner.state = core.withDesktopNoteFeatures(owner.state, richSupported);
    }
    return owner;
  }
  function open() {
    const snapshot = options.getContext(), ownerId = identity(snapshot);
    if (!ownerId) fail('AUTHENTICATION_REQUIRED');
    options.checkContext(snapshot); if (closed) fail('DESKTOP_OPERATION_CANCELLED');
    if (loaded?.scopeKey === ownerId.scopeKey) return align(loaded);
    previewValue = null;
    const held = retained.get(ownerId.file);
    if (held) { loaded = { ...held, ...ownerId, snapshot }; retained.set(ownerId.file, loaded); return align(loaded); }
    const bytes = readPrivate(ownerId.file);
    let state = bytes === null ? core.createDesktopNoteState(ownerId.scope, snapshot.account.deviceId)
      : core.readDesktopNoteState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ownerId.scope);
    if (bytes !== null) state = core.withDesktopNoteSync(state, core.rebindDevice(state.sync, snapshot.account.deviceId));
    state = core.withDesktopNoteFeatures(state, richSupported);
    loaded = { ...ownerId, snapshot, state, diskHash: bytes === null ? null : sha(bytes), pending: null }; return loaded;
  }
  function assertSaved(owner) { if (owner.pending) fail('NOTE_SAVE_UNCONFIRMED'); }
  function commit(owner, value, { receipt = false } = {}) {
    if (!receipt) check(owner);
    const state = core.readDesktopNoteState(value, owner.scope), bytes = Buffer.from(JSON.stringify(state)), nextHash = sha(bytes);
    if (bytes.length > limit.privateBytes) fail('NOTE_STATE_FULL');
    const pending = { state, nextHash, previousHash: owner.diskHash };
    try {
      const actual = readPrivate(owner.file), hash = actual === null ? null : sha(actual);
      if (hash !== nextHash) {
        if (hash !== pending.previousHash) fail('NOTE_STORAGE_CHANGED');
        fs.mkdirSync(root); fs.writeSync(owner.file, bytes, { mode: 0o600 });
        const confirmed = readPrivate(owner.file); if (!confirmed || sha(confirmed) !== nextHash) fail('NOTE_SAVE_UNCONFIRMED');
      }
      owner.state = state; owner.diskHash = nextHash; owner.pending = null; retained.delete(owner.file); previewValue = null; notify();
    } catch (error) {
      owner.pending = pending; retained.set(owner.file, owner); previewValue = null;
      lastError = codeOf(error) === 'NOTE_STORAGE_CHANGED' ? 'NOTE_STORAGE_CHANGED' : 'NOTE_SAVE_UNCONFIRMED'; notify(); fail(lastError);
    }
  }
  function status() {
    const visible = currentIdentity(), owner = loaded?.scopeKey === visible?.scopeKey ? loaded : null, state = owner?.pending?.state || owner?.state;
    return { scopeKey: visible?.scopeKey || null, supported: !!visible && supported, richSupported: !!visible && richSupported, loaded: !!owner, busy: busy > 0,
      revision: state?.revision || 0, pending: state ? state.sync.outbox.length + Object.keys(state.sync.overlays).length + state.pendingResolutions.length : 0,
      continuable: state ? state.sync.outbox.filter(row => ['queued', 'uncertain'].includes(row.status)).length + state.pendingResolutions.filter(row => !row.lastResult || row.lastResult.status === 'rejected' && row.lastResult.retryable).length : 0,
      conflicts: state ? Object.keys(state.sync.conflicts).length : 0, accepted: state?.accepted.length || 0, copyPending: state?.pendingCopies.length || 0,
      bound: state ? core.confirmedDesktopNoteBindings(state).length : 0, errorCode: lastError, saveUnconfirmed: !!owner?.pending };
  }
  function action(operation) {
    const requested = generation, task = queue.then(async () => {
      if (closed || requested !== generation) fail('DESKTOP_OPERATION_CANCELLED');
      busy++; controller = new AbortController(); lastError = null; notify();
      try { return await operation(controller.signal); } catch (error) { lastError = codeOf(error); throw Object.assign(Error(lastError), { code: lastError }); }
      finally { controller = null; busy--; notify(); }
    }); queue = task.catch(() => {}); return task;
  }
  function online(owner, signal) { check(owner, signal); if (!supported) fail('NOTE_FEATURE_UNAVAILABLE'); assertSaved(owner); }
  async function api(owner, input, signal) { online(owner, signal); return options.api(owner.snapshot, { ...input, signal, richNotes: richSupported }); }
  function material(owner) {
    check(owner); const value = options.getMaterialBindings(options.getContext()), candidates = new Map(), reverse = new Map();
    for (const row of value.bindings.filter(row => row.entityType === 'paper' && value.live.paperIds.includes(row.localId))) {
      const ids = candidates.get(row.localId) || new Set(); ids.add(row.entityId); candidates.set(row.localId, ids);
      const locals = reverse.get(row.entityId) || new Set(); locals.add(row.localId); reverse.set(row.entityId, locals);
    }
    const papers = [...candidates].filter(([, ids]) => ids.size === 1).map(([localId, ids]) => ({ localId, entityId: [...ids][0] })).filter(row => reverse.get(row.entityId).size === 1);
    return { papers, liveNoteIds: value.live.noteIds, identity: sha(core.canonicalJson({ papers, live: value.live })) };
  }
  function bindings() {
    const owner = loaded; if (!owner || currentIdentity()?.scopeKey !== owner.scopeKey || owner.pending) return [];
    try { const live = new Set(material(owner).liveNoteIds); return core.confirmedDesktopNoteBindings(owner.state).filter(row => live.has(row.localNoteId)); } catch { return []; }
  }
  function summary(data) { return !data ? null : { title: data.title, body: data.body, format: data.format,
    images: data.format === 'tiptap-json' ? data.assets.length : 0, tags: data.format === 'tiptap-json' ? [...data.metadata.tags] : [],
    unresolvedReferences: data.format === 'tiptap-json' ? data.metadata.unresolvedReferences.length : 0 }; }
  async function project(owner, state, noteIds, signal) {
    const m = material(owner), source = noteIds.length ? await capture(noteIds, owner.scope, () => check(owner, signal))
      : { notes: [], papers: [], richNoteResources: [], skippedNotes: {}, fingerprint: 'empty' };
    check(owner, signal);
    const identityMap = structuredClone(state.identityMap), paperMap = new Map(m.papers.map(row => [row.localId, row.entityId]));
    for (const row of m.papers) identityMap.aliases[JSON.stringify(['paper', row.localId])] = row.entityId;
    const projected = core.projectDesktopLibrary({ ...owner.scope, identityMap,
      papers: source.papers.filter(row => paperMap.has(row.id)), notes: source.notes.map((row, index) => source.skippedNotes[index] ? null : row),
      confirmedNotes: core.confirmedDesktopNoteBindings(state).filter(row => m.liveNoteIds.includes(row.localNoteId)), richNoteResources: source.richNoteResources }, uuid);
    const byId = new Map(projected.entities.filter(row => row.entityType === 'note').map(row => [row.entityId, row]));
    const rows = noteIds.map((localNoteId, index) => {
      const entityId = projected.identityMap.aliases[JSON.stringify(['note', localNoteId])] || null, entity = byId.get(entityId), head = state.sync.serverRecords['note:' + entityId];
      const pending = entityId && core.getVisibleEntity(state.sync, 'note', entityId)?.pending;
      let reason = source.skippedNotes[index] || projected.skipped.find(row => row.entityType === 'note' && row.index === index)?.code;
      if (!reason && !entity) reason = 'NOTE_UNSUPPORTED';
      if (!reason && pending) reason = 'NOTE_PENDING';
      if (!reason && entity.data.format === 'tiptap-json' && !state.richEnabled) reason = 'NOTE_RICH_UNAVAILABLE';
      const action = reason ? 'blocked' : !head ? 'create' : head.deletedAt !== null ? 'restore' : core.canonicalJson(head.data) === core.canonicalJson(entity.data) ? 'none' : 'update';
      return { key: localNoteId, localNoteId, entityId, label: entity?.data.title || source.notes[index]?.title || localNoteId, action, reason,
        local: summary(entity?.data), remote: summary(head?.data), publication: entity && !reason ? { localNoteId, entityId, data: entity.data, ...(action === 'restore' ? { mutation: 'restore' } : {}) } : null };
    });
    return { source, material: m, rows };
  }
  async function fetchConflicts(owner, state, signal, budget) {
    let cursor = null, sync = state.sync; const seen = new Set(), all = new Set();
    for (let i = 0; i < limit.pullPages; i++) {
      const query = new URLSearchParams({ limit: '1' }); if (cursor !== null) query.set('cursor', cursor);
      const page = await api(owner, { path: '/v1/conflicts?' + query }, signal); check(owner, signal);
      budget.bytes += Buffer.byteLength(core.canonicalJson(page));
      if (budget.bytes > limit.privateBytes || !exact(page, ['conflicts', 'nextCursor', 'hasMore']) || !Array.isArray(page.conflicts)
        || page.conflicts.length > 1 || typeof page.nextCursor !== 'string' || typeof page.hasMore !== 'boolean') fail('NOTE_STATE_INVALID');
      for (const row of page.conflicts) {
        if (!exact(row, ['conflictId', 'entityId', 'entityType', 'createdAt', 'attemptedOperation', 'observedRecord', 'currentRecord'])) fail('NOTE_STATE_INVALID');
        const op = core.validateOperation(row.attemptedOperation);
        if (!op.ok || op.value.entityId !== row.entityId || op.value.entityType !== row.entityType || !new RegExp(core.UUID_PATTERN).test(row.conflictId) || new Date(row.createdAt).toISOString() !== row.createdAt) fail('NOTE_STATE_INVALID');
        for (const value of [row.observedRecord, row.currentRecord]) if (value !== null) { const valid = core.validateRecord(value); if (!valid.ok || valid.value.entityId !== row.entityId || valid.value.entityType !== row.entityType) fail('NOTE_STATE_INVALID'); }
        if (row.entityType !== 'note') continue;
        if (all.has(row.conflictId)) fail('NOTE_STATE_INVALID'); all.add(row.conflictId);
        const previous = sync.conflicts[row.conflictId]; if (previous && core.canonicalJson(previous.attempted) !== core.canonicalJson(op.value)) fail('NOTE_STATE_INVALID');
        sync = { ...sync, conflicts: { ...sync.conflicts, [row.conflictId]: { conflictId: row.conflictId, attempted: op.value, current: row.currentRecord } } };
      }
      if (!page.hasMore) {
        for (const row of Object.values(sync.conflicts)) if (!all.has(row.conflictId) && !state.pendingResolutions.some(value => value.conflictId === row.conflictId)) sync = core.applyRemoteConflictResolution(sync, core.getSyncContext(sync), { conflictId: row.conflictId, record: sync.serverRecords['note:' + row.attempted.entityId] || null });
        return core.withDesktopNoteSync(state, sync);
      }
      if (seen.has(page.nextCursor) || page.nextCursor === cursor) fail('NOTE_STATE_INVALID'); seen.add(page.nextCursor); cursor = page.nextCursor;
    } fail('NOTE_LIMIT');
  }
  function publicPreview(value) {
    const state = value.candidate, accepted = new Map(state.accepted.map(row => [row.entityId, row]));
    return { token: value.token, scopeKey: value.owner.scopeKey, revision: value.baseRevision, checkedAt: state.checkedAt,
      localRows: value.projection.rows.map(({ publication: _publication, ...row }) => row),
      incoming: Object.values(state.sync.serverRecords).map(row => {
        const prior = accepted.get(row.entityId), pending = !!core.getVisibleEntity(state.sync, 'note', row.entityId)?.pending || Object.values(state.sync.conflicts).some(value => value.attempted.entityId === row.entityId);
        return { entityId: row.entityId, label: row.data?.title || prior?.data?.title || 'Deleted note',
          state: pending ? 'pending' : row.deletedAt ? 'delete' : !prior ? 'new' : prior.revision === row.revision ? 'same' : 'update',
          canAccept: !pending && (!prior || prior.revision !== row.revision), data: summary(row.data), accepted: summary(prior?.data), revision: row.revision, acceptedRevision: prior?.revision || null };
      }),
      conflicts: Object.values(state.sync.conflicts).map(row => { const head = state.sync.serverRecords['note:' + row.attempted.entityId], current = head && head.revision > (row.current?.revision || 0) ? head : row.current; return {
        conflictId: row.conflictId, entityId: row.attempted.entityId, label: row.attempted.data?.title || current?.data?.title || 'Note', expectedRevision: current?.revision || 0,
        attempted: { mutation: row.attempted.mutation, data: summary(row.attempted.data) }, current: current ? { revision: current.revision, deletedAt: current.deletedAt, data: summary(current.data) } : null }; }),
      pendingRows: [...state.sync.outbox.map(row => ({ opId: row.operation.opId, entityId: row.operation.entityId, label: row.operation.data?.title || 'Note', mutation: row.operation.mutation, stage: row.status, data: summary(row.operation.data) })),
        ...Object.values(state.sync.overlays).map(row => ({ opId: row.opId, entityId: row.entityId, label: row.data?.title || 'Note', mutation: row.mutation, stage: 'overlay', data: summary(row.data) }))],
      pendingResolutions: state.pendingResolutions.map(row => ({ conflictId: row.conflictId, ...row.request, lastResult: row.lastResult ? { status: row.lastResult.status, code: row.lastResult.code, retryable: row.lastResult.retryable } : null })) };
  }
  async function checkedPreview(owner, token, signal) {
    assertSaved(owner); check(owner, signal); const value = previewValue;
    if (!value || value.owner !== owner || value.token !== token || value.baseRevision !== owner.state.revision) fail('NOTE_PREVIEW_STALE');
    const current = await project(owner, value.candidate, value.noteIds, signal);
    if (value.projection.source.fingerprint !== current.source.fingerprint || value.projection.material.identity !== current.material.identity) fail('NOTE_PREVIEW_STALE');
    return value;
  }
  async function preview(args, signal) {
    if (!exact(args, ['noteIds']) || !Array.isArray(args.noteIds) || args.noteIds.length > limit.selected || args.noteIds.some(id => !core.isDesktopLocalId(id)) || new Set(args.noteIds).size !== args.noteIds.length) fail('NOTE_SELECTION_INVALID');
    const owner = open(); online(owner, signal); const noteIds = [...args.noteIds], pages = [], budget = { bytes: 0 }; let cursor = owner.state.sync.cursor;
    for (let i = 0; i < limit.pullPages; i++) {
      const query = new URLSearchParams({ limit: '1' }); if (cursor !== null) query.set('cursor', cursor);
      const response = await api(owner, { path: '/v1/sync/pull?' + query }, signal); check(owner, signal);
      const parsed = core.validatePullResponse(response); if (!parsed.ok) fail('NOTE_STATE_INVALID');
      budget.bytes += Buffer.byteLength(core.canonicalJson(parsed.value)); if (budget.bytes > limit.privateBytes) fail('NOTE_STATE_FULL'); pages.push(parsed.value);
      if (!parsed.value.hasMore) break;
      if (parsed.value.nextCursor === cursor || i + 1 === limit.pullPages) fail('NOTE_LIMIT'); cursor = parsed.value.nextCursor;
    }
    let candidate = core.stageDesktopNotePull(owner.state, pages, now()); candidate = await fetchConflicts(owner, candidate, signal, budget);
    const projection = await project(owner, candidate, noteIds, signal); check(owner, signal);
    previewValue = { owner, candidate, projection, noteIds, baseRevision: owner.state.revision, token: uuid() }; notify(); return publicPreview(previewValue);
  }
  async function send(owner, signal) {
    online(owner, signal);
    for (let i = 0; i < 32; i++) {
      online(owner, signal);
      const resolution = owner.state.pendingResolutions.find(row => !row.lastResult || row.lastResult.status === 'rejected' && row.lastResult.retryable);
      if (resolution) {
        const response = await api(owner, { path: '/v1/conflicts/' + resolution.conflictId + '/resolve', method: 'POST', body: resolution.request }, signal);
        commit(owner, core.applyDesktopNoteResolution(owner.state, resolution.conflictId, response), { receipt: true }); check(owner, signal);
        if (response.status !== 'applied') break; continue;
      }
      const ready = owner.state.sync.outbox.find(row => ['queued', 'uncertain'].includes(row.status)); if (!ready) break;
      if (ready.operation.data?.format === 'tiptap-json' && !richSupported) fail('NOTE_RICH_UNAVAILABLE');
      const prepared = core.preparePush(owner.state.sync, core.getSyncContext(owner.state.sync), 1);
      commit(owner, core.withDesktopNoteSync(owner.state, prepared.state));
      let response;
      try { response = await api(owner, { path: '/v1/sync/push', method: 'POST', body: prepared.request }, signal); }
      catch (error) { commit(owner, core.withDesktopNoteSync(owner.state, core.markPushUncertain(owner.state.sync, prepared.context, prepared.opIds, 'NETWORK_ERROR')), { receipt: true }); throw error; }
      let after;
      try { after = core.applyPushResults(owner.state.sync, prepared.context, response, prepared.opIds); }
      catch (error) { commit(owner, core.withDesktopNoteSync(owner.state, core.markPushUncertain(owner.state.sync, prepared.context, prepared.opIds, 'INVALID_RESPONSE')), { receipt: true }); throw error; }
      commit(owner, core.withDesktopNoteSync(owner.state, after), { receipt: true }); check(owner, signal);
      if (response.results.some(row => row.status !== 'applied')) break;
    } return status();
  }
  function saveCopies(owner, signal) {
    assertSaved(owner); check(owner, signal);
    const intents = owner.state.pendingCopies;
    const requests = intents.map(row => desktopNoteCopy(core, owner.state.accepted.find(record => record.entityId === row.entityId), row.localNoteId, {
      papers: new Map(row.paperBindings.map(value => [value.entityId, value.localId])), notes: new Map(row.noteBindings.map(value => [value.entityId, value.localId])),
    }));
    // Preflight every existing fixed target before writing any missing copy.
    // A local edit remains available and is never overwritten during recovery.
    for (const request of requests) { const existing = context.noteStore.getNote({ id: request.id }); if (existing && !sameDesktopNoteCopy(core, existing, request)) fail('NOTE_COPY_CHANGED'); }
    const localNoteIds = [];
    for (const request of requests) {
      check(owner, signal); const existing = context.noteStore.getNote({ id: request.id });
      if (!existing) { try { context.noteStore.createNote(request); } catch { /* Read back the fixed id to settle a lost write acknowledgement. */ } }
      const saved = context.noteStore.getNote({ id: request.id }); if (!sameDesktopNoteCopy(core, saved, request)) fail('NOTE_COPY_SAVE_UNCONFIRMED'); localNoteIds.push(request.id);
    }
    if (localNoteIds.length) commit(owner, core.completeDesktopNoteCopies(owner.state, localNoteIds));
    notify(); return { ...status(), localNoteIds };
  }
  const result = {
    status, bindings,
    setCapability(enabled, rich) { supported = enabled === true; richSupported = rich === true; if (!supported) result.stop(); if (loaded && currentIdentity()?.scopeKey === loaded.scopeKey && !loaded.pending) loaded.state = core.withDesktopNoteFeatures(loaded.state, richSupported); previewValue = null; notify(); },
    refreshStatus() { return action(() => { open(); return status(); }); },
    list() { return action(() => { const owner = open(); check(owner); const aliases = owner.state.identityMap.aliases;
      const notes = context.noteStore.listAllNotes(); if (notes.length > 5000) fail('NOTE_LIMIT');
      return { scopeKey: owner.scopeKey, revision: owner.state.revision, notes: notes.map(row => ({ localNoteId: row.id, title: row.title, updatedAt: row.updatedAt, boundEntityId: aliases[JSON.stringify(['note', row.id])] || null })) }; }); },
    preview(args) { return action(signal => preview(args, signal)); },
    publish(args) { return action(async signal => {
      if (!exact(args, ['token'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal); const value = await checkedPreview(owner, args.token, signal);
      const rows = value.projection.rows.filter(row => row.publication && !['blocked', 'none'].includes(row.action)).map(row => row.publication); if (!rows.length) fail('NOTE_SELECTION_INVALID');
      commit(owner, core.stageDesktopNotePublication(value.candidate, rows, uuid, now())); return send(owner, signal);
    }); },
    bind(args) { return action(async signal => {
      if (!exact(args, ['token', 'localNoteId', 'entityId'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); const value = await checkedPreview(owner, args.token, signal);
      if (!value.noteIds.includes(args.localNoteId)) fail('NOTE_SELECTION_INVALID');
      commit(owner, core.bindDesktopAccountNote(value.candidate, args.localNoteId, args.entityId)); return status();
    }); },
    delete(args) { return action(async signal => {
      if (!exact(args, ['token', 'entityId'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal);
      const value = await checkedPreview(owner, args.token, signal), state = value.candidate, head = state.sync.serverRecords['note:' + args.entityId];
      if (!head || head.deletedAt !== null || !head.data) fail('NOTE_REMOTE_UNAVAILABLE');
      if (core.getVisibleEntity(state.sync, 'note', args.entityId)?.pending || Object.values(state.sync.conflicts).some(row => row.attempted.entityId === args.entityId)) fail('NOTE_PENDING');
      if (state.pendingCopies.some(row => row.entityId === args.entityId)) fail('NOTE_COPY_SAVE_UNCONFIRMED');
      if (head.data.format === 'tiptap-json' && !richSupported) fail('NOTE_RICH_UNAVAILABLE');
      const sync = core.queueLocalEdit(state.sync, { entityType: 'note', entityId: args.entityId, mutation: 'delete', data: null }, { opId: uuid(), clientCreatedAt: now() });
      commit(owner, core.withDesktopNoteSync(state, sync)); return send(owner, signal);
    }); },
    adopt(args) { return action(async signal => {
      if (!exact(args, ['token', 'ids']) || !Array.isArray(args.ids) || !args.ids.length || args.ids.length > limit.selected || new Set(args.ids).size !== args.ids.length) fail('NOTE_SELECTION_INVALID');
      const owner = open(), value = await checkedPreview(owner, args.token, signal); let candidate = value.candidate;
      const paperBindings = value.projection.material.papers.map(row => ({ entityId: row.entityId, localId: row.localId })), copies = [];
      for (const entityId of args.ids) {
        const record = candidate.sync.serverRecords['note:' + entityId]; if (!record) fail('NOTE_REMOTE_UNAVAILABLE');
        const localId = 'account-note-' + sha(core.canonicalJson([owner.scope, entityId, record.revision]));
        candidate = core.adoptDesktopNoteCopy(candidate, entityId, localId); if (record.deletedAt === null) copies.push({ entityId, localNoteId: localId, revision: record.revision });
      }
      const noteBindings = Object.entries(candidate.identityMap.aliases).map(([key, entityId]) => ({ entityId, localId: JSON.parse(key)[1] }));
      candidate = core.stageDesktopNoteCopyIntents(candidate, copies.map(row => ({ ...row, paperBindings, noteBindings })));
      // No write occurs until all source snapshots and immutable copy mappings
      // fit the private file and are durably confirmed.
      for (const row of copies) desktopNoteCopy(core, candidate.accepted.find(record => record.entityId === row.entityId), row.localNoteId,
        { papers: new Map(paperBindings.map(value => [value.entityId, value.localId])), notes: new Map(noteBindings.map(value => [value.entityId, value.localId])) });
      commit(owner, candidate);
      return saveCopies(owner, signal);
    }); },
    resumeCopies() { return action(signal => saveCopies(open(), signal)); },
    continue() { return action(signal => send(open(), signal)); },
    resolve(args) { return action(async signal => {
      if (!exact(args, ['conflictId', 'choice', 'expectedRevision'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal);
      const base = previewValue?.owner === owner ? (await checkedPreview(owner, previewValue.token, signal)).candidate : owner.state;
      commit(owner, core.stageDesktopNoteResolution(base, args.conflictId, args.choice, args.expectedRevision, uuid())); return send(owner, signal);
    }); },
    retrySave() { return action(() => { const owner = open(); check(owner); if (owner.pending) commit(owner, owner.pending.state); align(owner); return status(); }); },
    backup() { return action(() => { const owner = open(); check(owner); return { format: 'paperquay-desktop-note-backup', version: 1, exportedAt: now(), state: structuredClone(owner.state), unconfirmedState: owner.pending ? structuredClone(owner.pending.state) : null }; }); },
    stop() { generation++; controller?.abort(); previewValue = null; notify(); return queue; },
    invalidate() { result.stop(); loaded = null; supported = false; richSupported = false; lastError = null; notify(); },
    settled() { return queue; }, close() { closed = true; result.stop(); },
  }; return result;
}
module.exports = { createDesktopNoteExchange };
