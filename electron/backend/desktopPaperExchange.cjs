const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const nativeFs = require('./nativeFs.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'PAPER_EXCHANGE_FAILED';

function createDesktopPaperExchange(context, options) {
  const core = options.core, fs = options.fs || nativeFs, uuid = options.randomUUID || randomUUID, limit = core.DESKTOP_PAPER_LIMITS;
  const root = path.join(path.dirname(context.appPaths.configPath), 'account-sync', 'papers');
  let supported = false, organizationSupported = false, loaded = null, previewValue = null, closed = false, generation = 0;
  let queue = Promise.resolve(), controller = null, busy = 0, lastError = null;
  const retained = new Map(), now = () => new Date(options.now ? options.now() : Date.now()).toISOString();
  const notify = () => { try { options.onChange?.(); } catch {} try { options.onProjectionChange?.(); } catch {} };
  function identity(snapshot) {
    if (!snapshot?.account || !snapshot.library || !snapshot.config) return null;
    const scope = core.validateDesktopPaperScope({ serviceKey: sha(JSON.stringify([snapshot.config.apiBaseUrl, snapshot.config.oidcIssuer, snapshot.config.oidcClientId])),
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
      if (owner.state.sync.deviceId !== owner.snapshot.account.deviceId) owner.state = core.withDesktopPaperSync(owner.state, core.rebindDevice(owner.state.sync, owner.snapshot.account.deviceId));
      owner.state = core.withDesktopPaperFeatures(owner.state, organizationSupported);
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
    let state = bytes === null ? core.createDesktopPaperState(ownerId.scope, snapshot.account.deviceId)
      : core.readDesktopPaperState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ownerId.scope);
    if (bytes !== null) state = core.withDesktopPaperSync(state, core.rebindDevice(state.sync, snapshot.account.deviceId));
    state = core.withDesktopPaperFeatures(state, organizationSupported);
    loaded = { ...ownerId, snapshot, state, diskHash: bytes === null ? null : sha(bytes), pending: null }; return loaded;
  }
  function assertSaved(owner) { if (owner.pending) fail('PAPER_SAVE_UNCONFIRMED'); }
  function commit(owner, value, { receipt = false } = {}) {
    if (!receipt) check(owner);
    const state = core.readDesktopPaperState(value, owner.scope), bytes = Buffer.from(JSON.stringify(state)), nextHash = sha(bytes);
    if (bytes.length > limit.privateBytes) fail('PAPER_STATE_FULL');
    const pending = { state, nextHash, previousHash: owner.diskHash };
    try {
      const actual = readPrivate(owner.file), hash = actual === null ? null : sha(actual);
      if (hash !== nextHash) {
        if (hash !== pending.previousHash) fail('PAPER_STORAGE_CHANGED');
        fs.mkdirSync(root); fs.writeSync(owner.file, bytes, { mode: 0o600 });
        const confirmed = readPrivate(owner.file); if (!confirmed || sha(confirmed) !== nextHash) fail('PAPER_SAVE_UNCONFIRMED');
      }
      owner.state = state; owner.diskHash = nextHash; owner.pending = null; retained.delete(owner.file); previewValue = null; notify();
    } catch (error) {
      owner.pending = pending; retained.set(owner.file, owner); previewValue = null;
      lastError = codeOf(error) === 'PAPER_STORAGE_CHANGED' ? 'PAPER_STORAGE_CHANGED' : 'PAPER_SAVE_UNCONFIRMED'; notify(); fail(lastError);
    }
  }
  function status() {
    const visible = currentIdentity(), owner = loaded?.scopeKey === visible?.scopeKey ? loaded : null, state = owner?.pending?.state || owner?.state;
    return { scopeKey: visible?.scopeKey || null, supported: !!visible && supported, organizationSupported: !!visible && organizationSupported, loaded: !!owner, busy: busy > 0,
      revision: state?.revision || 0, pending: state ? state.sync.outbox.length + Object.keys(state.sync.overlays).length + state.pendingResolutions.length : 0,
      continuable: state ? state.sync.outbox.filter(row => ['queued', 'uncertain'].includes(row.status)).length + state.pendingResolutions.filter(row => !row.lastResult || row.lastResult.status === 'rejected' && row.lastResult.retryable).length : 0,
      conflicts: state ? Object.keys(state.sync.conflicts).length : 0, accepted: state?.accepted.length || 0,
      adoptionPending: state?.adoptions.filter(row => row.phase === 'pending' || row.phase === 'restoring').length || 0,
      restorationPending: state?.adoptions.filter(row => row.phase === 'restoring').length || 0,
      bound: state?.bindings.length || 0, errorCode: lastError, saveUnconfirmed: !!owner?.pending };
  }
  function action(operation) {
    const requested = generation, task = queue.then(async () => {
      if (closed || requested !== generation) fail('DESKTOP_OPERATION_CANCELLED');
      busy++; controller = new AbortController(); lastError = null; notify();
      try { return await operation(controller.signal); } catch (error) { lastError = codeOf(error); throw Object.assign(Error(lastError), { code: lastError }); }
      finally { controller = null; busy--; notify(); }
    }); queue = task.catch(() => {}); return task;
  }
  function online(owner, signal) { check(owner, signal); if (!supported) fail('PAPER_FEATURE_UNAVAILABLE'); assertSaved(owner); }
  async function api(owner, input, signal) { online(owner, signal); return options.api(owner.snapshot, { ...input, signal, paperOrganization: organizationSupported }); }

  function material(owner) {
    check(owner); const value = options.getMaterialBindings(options.getContext()), candidates = new Map(), reverse = new Map();
    for (const row of value.bindings.filter(row => row.entityType === 'paper' && value.live.paperIds.includes(row.localId))) {
      const ids = candidates.get(row.localId) || new Set(); ids.add(row.entityId); candidates.set(row.localId, ids);
      const locals = reverse.get(row.entityId) || new Set(); locals.add(row.localId); reverse.set(row.entityId, locals);
    }
    const papers = [...candidates].filter(([, ids]) => ids.size === 1).map(([localPaperId, ids]) => ({ localPaperId, entityId: [...ids][0] }))
      .filter(row => reverse.get(row.entityId).size === 1).sort((a, b) => a.localPaperId.localeCompare(b.localPaperId));
    if (papers.length > limit.papers) fail('PAPER_LIMIT');
    return { papers, identity: sha(core.canonicalJson(papers)) };
  }
  function choice(state, binding, head) {
    const draft = state.organizations.find(row => row.localPaperId === binding.localPaperId && row.entityId === binding.entityId);
    if (draft) return { value: draft.value, source: 'desktop-choice' };
    if (head?.data?.organization) { const { readingStatus, queueRank, collections } = head.data.organization; return { value: { readingStatus, queueRank, collections }, source: 'account' }; }
    return { value: { readingStatus: 'unread', queueRank: null, collections: [] }, source: 'initial' };
  }
  function capture(owner, ids, signal) {
    check(owner, signal);
    if (typeof context.store.capturePaperMetadata !== 'function') fail('PAPER_STORE_UNAVAILABLE');
    const rows = context.store.capturePaperMetadata(ids).map(row => ({ localPaperId: row.localPaperId, metadata: core.readDesktopPaperMetadata(row.metadata) }));
    check(owner, signal);
    if (rows.length !== ids.length || rows.some((row, i) => row.localPaperId !== ids[i])) fail('PAPER_SOURCE_CHANGED');
    return { rows, fingerprint: sha(core.canonicalJson(rows)) };
  }
  function project(owner, state, localPaperIds, signal) {
    const m = material(owner), byLocal = new Map(m.papers.map(row => [row.localPaperId, row])), byEntity = new Map(m.papers.map(row => [row.entityId, row]));
    const captureIds = [...new Set([...localPaperIds, ...Object.values(state.sync.serverRecords).map(row => byEntity.get(row.entityId)?.localPaperId).filter(Boolean)])].sort();
    const source = capture(owner, captureIds, signal), sources = new Map(source.rows.map(row => [row.localPaperId, row.metadata]));
    const identityMap = core.createDesktopIdentityMap(owner.scope.accountId, owner.scope.libraryBindingId), paperOrganizations = Object.create(null);
    const boundSources = source.rows.filter(row => byLocal.has(row.localPaperId));
    for (const row of boundSources) {
      const binding = byLocal.get(row.localPaperId), head = state.sync.serverRecords['paper:' + binding.entityId];
      identityMap.aliases[JSON.stringify(['paper', row.localPaperId])] = binding.entityId;
      paperOrganizations[row.localPaperId] = { favorite: row.metadata.isFavorite, tags: row.metadata.tags.map(tag => tag.name), ...choice(state, binding, head).value };
    }
    const projected = core.projectDesktopLibrary({ ...owner.scope, identityMap, papers: boundSources.map(row => ({ id: row.localPaperId, ...row.metadata })),
      paperOrganizationEnabled: state.organizationEnabled, paperOrganizations }, () => fail('PAPER_BINDING_REQUIRED'));
    const entities = new Map(projected.entities.filter(row => row.entityType === 'paper').map(row => [row.entityId, row]));
    const pending = entityId => core.getVisibleEntity(state.sync, 'paper', entityId)?.pending || Object.values(state.sync.conflicts).some(row => row.attempted.entityId === entityId);
    const reasonFor = (binding, head) => !binding ? 'PAPER_BINDING_REQUIRED' : !head || head.deletedAt !== null ? 'PAPER_REMOTE_UNAVAILABLE'
      : pending(binding.entityId) ? 'PAPER_PENDING' : state.adoptions.some(row => row.entityId === binding.entityId && (row.phase === 'pending' || row.phase === 'restoring')) ? 'PAPER_ADOPTION_UNCONFIRMED'
      : head.data?.organization && !state.organizationEnabled ? 'PAPER_ORGANIZATION_UNAVAILABLE' : null;
    const rows = localPaperIds.map(localPaperId => {
      const binding = byLocal.get(localPaperId), head = binding && state.sync.serverRecords['paper:' + binding.entityId], entity = binding && entities.get(binding.entityId);
      const reason = reasonFor(binding, head) || (!entity ? 'PAPER_SOURCE_UNSUPPORTED' : null), action = reason ? 'blocked' : core.canonicalJson(head.data) === core.canonicalJson(entity.data) ? 'none' : 'update';
      return { key: localPaperId, localPaperId, entityId: binding?.entityId || null, label: sources.get(localPaperId)?.title || localPaperId, action, reason,
        local: entity?.data || null, remote: head?.data || null, organizationSource: binding ? choice(state, binding, head).source : null,
        publication: entity && !reason ? { localPaperId, entityId: binding.entityId, data: entity.data } : null };
    });
    const accepted = new Map(state.accepted.map(row => [row.entityId, row]));
    const incoming = Object.values(state.sync.serverRecords).map(row => {
      const binding = byEntity.get(row.entityId), prior = accepted.get(row.entityId), local = entities.get(row.entityId)?.data || null, reason = reasonFor(binding, row);
      return { entityId: row.entityId, localPaperId: binding?.localPaperId || null, label: row.data?.title || prior?.data?.title || 'Deleted paper',
        state: pending(row.entityId) ? 'pending' : row.deletedAt ? 'deleted' : !prior ? 'new' : prior.revision === row.revision ? 'same' : 'update',
        canAccept: !reason && (!prior || prior.revision !== row.revision || core.canonicalJson(local) !== core.canonicalJson(row.data)), reason,
        data: row.data, local, accepted: prior?.data || null, revision: row.revision, acceptedRevision: prior?.revision || null };
    });
    return { source, sources, captureIds, material: m, rows, incoming };
  }
  function publicPreview(value) {
    const state = value.candidate;
    return structuredClone({ token: value.token, scopeKey: value.owner.scopeKey, revision: value.baseRevision, checkedAt: state.checkedAt,
      localRows: value.projection.rows.map(({ publication: _publication, ...row }) => row), incoming: value.projection.incoming,
      organizationPolicy: 'independent-account-names',
      conflicts: Object.values(state.sync.conflicts).map(row => {
        const head = state.sync.serverRecords['paper:' + row.attempted.entityId], current = head && head.revision > (row.current?.revision || 0) ? head : row.current;
        return { conflictId: row.conflictId, entityId: row.attempted.entityId, label: row.attempted.data?.title || current?.data?.title || 'Paper', expectedRevision: current?.revision || 0,
          attempted: { mutation: row.attempted.mutation, data: row.attempted.data }, current: current ? { revision: current.revision, deletedAt: current.deletedAt, data: current.data } : null };
      }), pendingRows: [...state.sync.outbox.map(row => ({ opId: row.operation.opId, entityId: row.operation.entityId, label: row.operation.data?.title || 'Paper', mutation: row.operation.mutation, stage: row.status, data: row.operation.data })),
        ...Object.values(state.sync.overlays).map(row => ({ opId: row.opId, entityId: row.entityId, label: row.data?.title || 'Paper', mutation: row.mutation, stage: 'overlay', data: row.data }))],
      pendingResolutions: state.pendingResolutions.map(row => ({ conflictId: row.conflictId, ...row.request, lastResult: row.lastResult ? { status: row.lastResult.status, code: row.lastResult.code, retryable: row.lastResult.retryable } : null })),
      adoptions: state.adoptions.map(row => ({ adoptionId: row.adoptionId, entityId: row.entityId, localPaperId: row.localPaperId, label: row.record.data?.title || row.after.title,
        revision: row.record.revision, phase: row.phase, createdAt: row.createdAt, before: row.before, after: row.after,
        beforeOrganization: row.beforeOrganization, afterOrganization: row.afterOrganization })) });
  }
  function checkedPreview(owner, token, signal) {
    assertSaved(owner); check(owner, signal); const value = previewValue;
    if (!value || value.owner !== owner || value.token !== token || value.baseRevision !== owner.state.revision) fail('PAPER_PREVIEW_STALE');
    if (value.projection.material.identity !== material(owner).identity || value.projection.source.fingerprint !== capture(owner, value.projection.captureIds, signal).fingerprint) fail('PAPER_PREVIEW_STALE');
    return value;
  }

  async function fetchConflicts(owner, state, signal, budget) {
    let cursor = null, sync = state.sync; const seen = new Set(), all = new Set();
    for (let i = 0; i < limit.pullPages; i++) {
      const query = new URLSearchParams({ limit: '1' }); if (cursor !== null) query.set('cursor', cursor);
      const page = await api(owner, { path: '/v1/conflicts?' + query }, signal); check(owner, signal);
      budget.bytes += Buffer.byteLength(core.canonicalJson(page));
      if (budget.bytes > limit.privateBytes || !exact(page, ['conflicts', 'nextCursor', 'hasMore']) || !Array.isArray(page.conflicts)
        || page.conflicts.length > 1 || typeof page.nextCursor !== 'string' || typeof page.hasMore !== 'boolean') fail('PAPER_STATE_INVALID');
      for (const row of page.conflicts) {
        if (!exact(row, ['conflictId', 'entityId', 'entityType', 'createdAt', 'attemptedOperation', 'observedRecord', 'currentRecord'])) fail('PAPER_STATE_INVALID');
        const op = core.validateOperation(row.attemptedOperation);
        if (!op.ok || op.value.entityId !== row.entityId || op.value.entityType !== row.entityType || !new RegExp(core.UUID_PATTERN).test(row.conflictId) || new Date(row.createdAt).toISOString() !== row.createdAt) fail('PAPER_STATE_INVALID');
        for (const value of [row.observedRecord, row.currentRecord]) if (value !== null) { const valid = core.validateRecord(value); if (!valid.ok || valid.value.entityId !== row.entityId || valid.value.entityType !== row.entityType) fail('PAPER_STATE_INVALID'); }
        if (row.entityType !== 'paper') continue;
        if (all.has(row.conflictId)) fail('PAPER_STATE_INVALID'); all.add(row.conflictId);
        const previous = sync.conflicts[row.conflictId]; if (previous && core.canonicalJson(previous.attempted) !== core.canonicalJson(op.value)) fail('PAPER_STATE_INVALID');
        sync = { ...sync, conflicts: { ...sync.conflicts, [row.conflictId]: { conflictId: row.conflictId, attempted: op.value, current: row.currentRecord } } };
      }
      if (!page.hasMore) {
        for (const row of Object.values(sync.conflicts)) if (!all.has(row.conflictId) && !state.pendingResolutions.some(value => value.conflictId === row.conflictId)) sync = core.applyRemoteConflictResolution(sync, core.getSyncContext(sync), { conflictId: row.conflictId, record: sync.serverRecords['paper:' + row.attempted.entityId] || null });
        return core.withDesktopPaperSync(state, sync);
      }
      if (seen.has(page.nextCursor) || page.nextCursor === cursor) fail('PAPER_STATE_INVALID'); seen.add(page.nextCursor); cursor = page.nextCursor;
    } fail('PAPER_LIMIT');
  }

  async function send(owner, signal) {
    online(owner, signal);
    for (let i = 0; i < 32; i++) {
      online(owner, signal);
      const resolution = owner.state.pendingResolutions.find(row => !row.lastResult || row.lastResult.status === 'rejected' && row.lastResult.retryable);
      if (resolution) {
        assertCurrentBinding(owner, owner.state.sync.conflicts[resolution.conflictId].attempted.entityId);
        const response = await api(owner, { path: '/v1/conflicts/' + resolution.conflictId + '/resolve', method: 'POST', body: resolution.request }, signal);
        commit(owner, core.applyDesktopPaperResolution(owner.state, resolution.conflictId, response), { receipt: true }); check(owner, signal);
        if (response.status !== 'applied') break; continue;
      }
      const ready = owner.state.sync.outbox.find(row => ['queued', 'uncertain'].includes(row.status)); if (!ready) break;
      assertCurrentBinding(owner, ready.operation.entityId);
      if (ready.operation.data?.organization && !organizationSupported) fail('PAPER_ORGANIZATION_UNAVAILABLE');
      const prepared = core.preparePush(owner.state.sync, core.getSyncContext(owner.state.sync), 1);
      commit(owner, core.withDesktopPaperSync(owner.state, prepared.state));
      let response;
      try { response = await api(owner, { path: '/v1/sync/push', method: 'POST', body: prepared.request }, signal); }
      catch (error) { commit(owner, core.withDesktopPaperSync(owner.state, core.markPushUncertain(owner.state.sync, prepared.context, prepared.opIds, 'NETWORK_ERROR')), { receipt: true }); throw error; }
      let after;
      try { after = core.applyPushResults(owner.state.sync, prepared.context, response, prepared.opIds); }
      catch (error) { commit(owner, core.withDesktopPaperSync(owner.state, core.markPushUncertain(owner.state.sync, prepared.context, prepared.opIds, 'INVALID_RESPONSE')), { receipt: true }); throw error; }
      commit(owner, core.withDesktopPaperSync(owner.state, after), { receipt: true }); check(owner, signal);
      if (response.results.some(row => row.status !== 'applied')) break;
    } return status();
  }
  async function preview(args, signal) {
    if (!exact(args, ['localPaperIds']) || !Array.isArray(args.localPaperIds) || args.localPaperIds.length > limit.selected
      || args.localPaperIds.some(id => !core.isDesktopLocalId(id)) || new Set(args.localPaperIds).size !== args.localPaperIds.length) fail('PAPER_SELECTION_INVALID');
    const owner = open(); online(owner, signal); const pages = [], budget = { bytes: 0 }; let cursor = owner.state.sync.cursor;
    for (let i = 0; i < limit.pullPages; i++) {
      const query = new URLSearchParams({ limit: '1' }); if (cursor !== null) query.set('cursor', cursor);
      const response = await api(owner, { path: '/v1/sync/pull?' + query }, signal); check(owner, signal);
      const parsed = core.validatePullResponse(response); if (!parsed.ok) fail('PAPER_STATE_INVALID');
      budget.bytes += Buffer.byteLength(core.canonicalJson(parsed.value)); if (budget.bytes > limit.privateBytes) fail('PAPER_STATE_FULL'); pages.push(parsed.value);
      if (!parsed.value.hasMore) break;
      if (parsed.value.nextCursor === cursor || i + 1 === limit.pullPages) fail('PAPER_LIMIT'); cursor = parsed.value.nextCursor;
    }
    let candidate = core.stageDesktopPaperPull(owner.state, pages, now()); candidate = await fetchConflicts(owner, candidate, signal, budget);
    const projection = project(owner, candidate, args.localPaperIds, signal); check(owner, signal);
    candidate = core.withDesktopPaperBindings(candidate, projection.material.papers);
    previewValue = { owner, candidate, projection, localPaperIds: [...args.localPaperIds], baseRevision: owner.state.revision, token: uuid() };
    notify(); return publicPreview(previewValue);
  }
  function assertCurrentBinding(owner, entityId) {
    const expected = owner.state.bindings.find(row => row.entityId === entityId), current = material(owner).papers.find(row => row.entityId === entityId);
    if (!expected || !current || expected.localPaperId !== current.localPaperId) fail('PAPER_BINDING_CHANGED');
  }
  function afterMetadata(before, data) {
    const { normalizeAuthor, normalizeTag } = require('./libraryStore.cjs');
    const occurrences = (previous, names, create, prefix) => {
      const buckets = new Map(), usedIds = new Set();
      for (const row of previous) { const bucket = buckets.get(row.name) || []; bucket.push(row); buckets.set(row.name, bucket); }
      return names.map((name, sortOrder) => {
        // Wire names are not personal identities. A same-name match consumes
        // at most one existing occurrence; an extra author inherits no details.
        const row = { ...(buckets.get(name)?.shift() || create(name, sortOrder)), sortOrder };
        if (usedIds.has(row.id)) {
          const allocated = uuid(); if (!new RegExp(core.UUID_PATTERN).test(allocated)) fail('PAPER_STATE_INVALID'); row.id = prefix + allocated;
        }
        if (usedIds.has(row.id)) fail('PAPER_STATE_INVALID'); usedIds.add(row.id); return row;
      });
    };
    return core.readDesktopPaperMetadata({ ...before, title: data.title, year: data.year, publication: data.publication, doi: data.doi, abstractText: data.abstractText,
      keywords: [...data.keywords], updatedAt: Math.max(before.updatedAt, Date.parse(now())),
      authors: occurrences(before.authors, data.authors, normalizeAuthor, 'auth_account_'),
      ...(data.organization ? { isFavorite: data.organization.favorite, tags: occurrences(before.tags, data.organization.tags, normalizeTag, 'tag_account_') } : {}) });
  }
  function saveAdoptions(owner, signal) {
    assertSaved(owner); check(owner, signal);
    const rows = owner.state.adoptions.filter(row => row.phase === 'pending' || row.phase === 'restoring'); if (!rows.length) return { ...status(), localPaperIds: [] };
    const changes = rows.map(row => ({ localPaperId: row.localPaperId, before: row.phase === 'restoring' ? row.after : row.before, after: row.phase === 'restoring' ? row.before : row.after }));
    const m = material(owner);
    for (const row of rows) if (!m.papers.some(binding => binding.localPaperId === row.localPaperId && binding.entityId === row.entityId)) fail('PAPER_BINDING_CHANGED');
    if (typeof context.store.compareAndApplyPaperMetadata !== 'function') fail('PAPER_STORE_UNAVAILABLE');
    try { context.store.compareAndApplyPaperMetadata(changes); }
    catch (error) {
      // A successful COMMIT may lose its acknowledgement. Settle only a complete
      // exact post-image; changed local fields remain untouched and recoverable.
      const actual = capture(owner, rows.map(row => row.localPaperId), signal);
      if (actual.rows.some((value, i) => core.canonicalJson(value.metadata) !== core.canonicalJson(changes[i].after))) {
        if (error.code === 'PAPER_SOURCE_CHANGED' || error.code === 'PAPER_LOCAL_UNAVAILABLE') throw error;
        fail('PAPER_ADOPTION_UNCONFIRMED');
      }
    }
    const actual = capture(owner, rows.map(row => row.localPaperId), signal);
    if (actual.rows.some((value, i) => core.canonicalJson(value.metadata) !== core.canonicalJson(changes[i].after))) fail('PAPER_ADOPTION_UNCONFIRMED');
    let candidate = owner.state;
    const adopted = rows.filter(row => row.phase === 'pending').map(row => row.adoptionId), restored = rows.filter(row => row.phase === 'restoring').map(row => row.adoptionId);
    if (adopted.length) candidate = core.completeDesktopPaperAdoptions(candidate, adopted);
    if (restored.length) candidate = core.completeDesktopPaperRestorations(candidate, restored);
    commit(owner, candidate);
    return { ...status(), localPaperIds: rows.map(row => row.localPaperId) };
  }
  const result = {
    status,
    setCapability(enabled, organization) {
      supported = enabled === true; organizationSupported = organization === true;
      if (!supported) result.stop();
      if (loaded && currentIdentity()?.scopeKey === loaded.scopeKey && !loaded.pending) loaded.state = core.withDesktopPaperFeatures(loaded.state, organizationSupported);
      previewValue = null; notify();
    },
    refreshStatus() { return action(() => { open(); return status(); }); },
    list() { return action(() => {
      const owner = open(); check(owner); const m = material(owner), papers = context.store.load().papers;
      if (papers.length > 10000) fail('PAPER_LIMIT');
      return { scopeKey: owner.scopeKey, revision: owner.state.revision, papers: papers.map(row => ({ localPaperId: row.id, title: row.title, updatedAt: row.updatedAt,
        boundEntityId: m.papers.find(binding => binding.localPaperId === row.id)?.entityId || null })) };
    }); },
    preview(args) { return action(signal => preview(args, signal)); },
    publish(args) { return action(async signal => {
      if (!exact(args, ['token'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal); const value = checkedPreview(owner, args.token, signal);
      const rows = value.projection.rows.filter(row => row.publication && row.action === 'update').map(row => row.publication);
      if (!rows.length) fail('PAPER_SELECTION_INVALID');
      commit(owner, core.stageDesktopPaperPublication(value.candidate, rows, uuid, now())); return send(owner, signal);
    }); },
    updateOrganization(args) { return action(signal => {
      if (!exact(args, ['token', 'localPaperId', 'readingStatus', 'queued', 'collections']) || typeof args.queued !== 'boolean') fail('DESKTOP_ARGUMENT_INVALID');
      const owner = open(), value = checkedPreview(owner, args.token, signal), state = value.candidate;
      const binding = state.bindings.find(row => row.localPaperId === args.localPaperId);
      if (!binding || !value.localPaperIds.includes(args.localPaperId)) fail('PAPER_SELECTION_INVALID');
      const previous = choice(state, binding, state.sync.serverRecords['paper:' + binding.entityId]).value;
      let queueRank = args.queued ? previous.queueRank : null;
      if (args.queued && queueRank === null) {
        const ranks = [...Object.values(state.sync.serverRecords).map(row => row.data?.organization?.queueRank), ...state.organizations.map(row => row.value.queueRank)].filter(Number.isSafeInteger);
        const maximum = Math.max(-1, ...ranks); if (maximum >= Number.MAX_SAFE_INTEGER) fail('PAPER_ORGANIZATION_INVALID'); queueRank = maximum + 1;
      }
      commit(owner, core.updateDesktopPaperOrganization(state, args.localPaperId, { readingStatus: args.readingStatus, queueRank, collections: args.collections })); return status();
    }); },
    adopt(args) { return action(signal => {
      if (!exact(args, ['token', 'ids']) || !Array.isArray(args.ids) || !args.ids.length || args.ids.length > limit.selected || new Set(args.ids).size !== args.ids.length) fail('PAPER_SELECTION_INVALID');
      const owner = open(), value = checkedPreview(owner, args.token, signal), state = value.candidate;
      const rows = args.ids.map(entityId => {
        const incoming = value.projection.incoming.find(row => row.entityId === entityId); if (!incoming?.canAccept || !incoming.localPaperId) fail(incoming?.reason || 'PAPER_SELECTION_INVALID');
        const record = state.sync.serverRecords['paper:' + entityId], before = value.projection.sources.get(incoming.localPaperId);
        const previous = state.organizations.find(row => row.localPaperId === incoming.localPaperId && row.entityId === entityId)?.value || null;
        const afterOrganization = record.data.organization ? core.readDesktopPaperOrganizationChoice({ readingStatus: record.data.organization.readingStatus,
          queueRank: record.data.organization.queueRank, collections: record.data.organization.collections }) : previous;
        return { adoptionId: uuid(), entityId, localPaperId: incoming.localPaperId, record, before, after: afterMetadata(before, record.data),
          beforeOrganization: previous, afterOrganization, phase: 'pending', createdAt: now() };
      });
      commit(owner, core.stageDesktopPaperAdoptions(state, rows)); return saveAdoptions(owner, signal);
    }); },
    resumeAdoptions() { return action(signal => saveAdoptions(open(), signal)); },
    restoreAdoption(args) { return action(signal => {
      if (!exact(args, ['adoptionId'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); assertSaved(owner); check(owner, signal);
      const row = owner.state.adoptions.find(entry => entry.adoptionId === args.adoptionId); if (!row) fail('PAPER_SELECTION_INVALID');
      if (row.phase === 'restored') return { ...status(), localPaperIds: [] };
      assertCurrentBinding(owner, row.entityId);
      if (row.phase !== 'restoring') {
        const current = capture(owner, [row.localPaperId], signal).rows[0].metadata;
        if (core.canonicalJson(current) !== core.canonicalJson(row.after)) fail('PAPER_SOURCE_CHANGED');
        commit(owner, core.stageDesktopPaperRestoration(owner.state, row.adoptionId));
      }
      return saveAdoptions(owner, signal);
    }); },
    continue() { return action(signal => send(open(), signal)); },
    resolve(args) { return action(async signal => {
      if (!exact(args, ['conflictId', 'choice', 'expectedRevision'])) fail('DESKTOP_ARGUMENT_INVALID'); const owner = open(); online(owner, signal);
      const base = previewValue?.owner === owner ? checkedPreview(owner, previewValue.token, signal).candidate : owner.state;
      commit(owner, core.stageDesktopPaperResolution(base, args.conflictId, args.choice, args.expectedRevision, uuid())); return send(owner, signal);
    }); },
    retrySave() { return action(() => { const owner = open(); check(owner); if (owner.pending) commit(owner, owner.pending.state); align(owner); return status(); }); },
    backup() { return action(() => {
      const owner = open(); check(owner); return { format: 'paperquay-desktop-paper-backup', version: 1, exportedAt: now(),
        state: structuredClone(owner.state), unconfirmedState: owner.pending ? structuredClone(owner.pending.state) : null };
    }); },
    stop() { generation++; controller?.abort(); previewValue = null; notify(); return queue; },
    invalidate() { result.stop(); loaded = null; supported = false; organizationSupported = false; lastError = null; notify(); },
    settled() { return queue; }, close() { closed = true; result.stop(); },
  }; return result;
}
module.exports = { createDesktopPaperExchange };

