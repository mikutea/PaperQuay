const { createHash, randomUUID } = require('node:crypto');
const { createKnowledgeGraphCore } = require('../../packages/graph-core/index.cjs');
const graph = createKnowledgeGraphCore();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, HASH = /^[0-9a-f]{64}$/;
const CAPTURE_LIMITS = Object.freeze({ libraryPapers: 10000, referenceRows: 4096, referenceBytes: 4 * 1024 * 1024, referenceRowBytes: 64 * 1024, matchComparisons: 200000, matchingBytes: 8 * 1024 * 1024 });
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',') && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => 'value' in row);
const codeOf = error => typeof error?.code === 'string' && /^(GRAPH_EVIDENCE_|DESKTOP_|ACCOUNT_)[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'GRAPH_EVIDENCE_FAILED';
const portableText = value => {
  if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    || /(?:^|[\s"'(])(?:[a-z]:[\\/]|\\\\|file:\/\/)|\b(?:authorization|cookie|set-cookie|x-api-key)\s*:/i.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
};

function createDesktopGraphEvidence(context, options) {
  const core = options.core, allocate = options.randomUUID || randomUUID, L = core.GRAPH_EVIDENCE_LIMITS;
  let closed = false, generation = 0, busy = false, lastError = null, previewValue = null, queue = Promise.resolve();
  const notify = () => { try { options.onChange?.(); } catch {} };
  const jsonHash = value => sha(core.canonicalJson(value));
  function identity() {
    const snapshot = options.getContext();
    if (!snapshot?.account || !snapshot?.library || !snapshot?.config) fail('GRAPH_EVIDENCE_SCOPE_CHANGED');
    const accountId = snapshot.account.accountId, deviceId = snapshot.account.deviceId, libraryBindingId = snapshot.library.libraryBindingId;
    if (![accountId, deviceId, libraryBindingId].every(value => typeof value === 'string' && UUID.test(value))) fail('GRAPH_EVIDENCE_SCOPE_CHANGED');
    const serviceId = sha(core.normalizeGraphEvidenceServiceUrl(snapshot.config.apiBaseUrl));
    return { snapshot, serviceId, accountId, deviceId, libraryBindingId,
      scopeKey: jsonHash([serviceId, accountId, deviceId, libraryBindingId, snapshot.epoch ?? null, snapshot.config.oidcIssuer ?? null, snapshot.config.oidcClientId ?? null]) };
  }
  function check(owner) {
    if (closed) fail('DESKTOP_OPERATION_CANCELLED'); options.checkContext(owner.snapshot);
    if (identity().scopeKey !== owner.scopeKey) fail('GRAPH_EVIDENCE_SCOPE_CHANGED');
  }
  function status() { let scopeKey = null; try { scopeKey = identity().scopeKey; } catch {} return { scopeKey, busy, errorCode: lastError }; }
  function action(operation) {
    const requested = generation, task = queue.then(() => {
      if (closed || requested !== generation) fail('DESKTOP_OPERATION_CANCELLED'); busy = true; lastError = null; notify();
      try { return operation(); } catch (error) { lastError = codeOf(error); throw Object.assign(new Error(lastError), { code: lastError }); }
      finally { busy = false; notify(); }
    }); queue = task.catch(() => {}); return task;
  }
  function material(owner) {
    check(owner); const value = options.getMaterialBindings(options.getContext());
    if (!value || !Array.isArray(value.bindings) || value.bindings.length > CAPTURE_LIMITS.libraryPapers) fail('GRAPH_EVIDENCE_BINDING_INVALID');
    const candidates = new Map(), reverse = new Map();
    for (const row of value.bindings) {
      if (!exact(row, ['localPaperId', 'entityId', 'versions']) || !core.isDesktopLocalId(row.localPaperId) || !UUID.test(row.entityId) || !Array.isArray(row.versions)) fail('GRAPH_EVIDENCE_BINDING_INVALID');
      const rows = candidates.get(row.localPaperId) || []; rows.push(row); candidates.set(row.localPaperId, rows);
      const locals = reverse.get(row.entityId) || new Set(); locals.add(row.localPaperId); reverse.set(row.entityId, locals);
    }
    const output = new Map();
    for (const [localPaperId, rows] of candidates) {
      if (rows.length !== 1 || reverse.get(rows[0].entityId).size !== 1) continue;
      const row = rows[0]; let code = null;
      if (row.versions.length > L.versions) code = 'GRAPH_EVIDENCE_VERSION_LIMIT';
      else if (row.versions.some(version => !exact(version, ['versionId', 'sha256', 'sizeBytes']) || !UUID.test(version.versionId) || !HASH.test(version.sha256)
        || !Number.isSafeInteger(version.sizeBytes) || version.sizeBytes < 1) || new Set(row.versions.map(version => version.versionId)).size !== row.versions.length) code = 'GRAPH_EVIDENCE_BINDING_INVALID';
      output.set(localPaperId, { localPaperId, entityId: row.entityId, versions: structuredClone(row.versions).sort((a, b) => a.versionId.localeCompare(b.versionId)), code });
    }
    check(owner); return output;
  }
  function library(owner) {
    check(owner); const value = context.store.load();
    if (!value || !Array.isArray(value.papers) || value.papers.length > CAPTURE_LIMITS.libraryPapers) fail('GRAPH_EVIDENCE_LIBRARY_LIMIT');
    const ids = value.papers.map(row => row.id); if (new Set(ids).size !== ids.length) fail('GRAPH_EVIDENCE_LIBRARY_INVALID');
    return value;
  }
  function request(value) {
    if (!exact(value, ['localPaperIds', 'includeReferences', 'includeSimilarity']) || !Array.isArray(value.localPaperIds) || !value.localPaperIds.length || value.localPaperIds.length > L.sources
      || new Set(value.localPaperIds).size !== value.localPaperIds.length || value.localPaperIds.some(id => !core.isDesktopLocalId(id))
      || typeof value.includeReferences !== 'boolean' || typeof value.includeSimilarity !== 'boolean') fail('GRAPH_EVIDENCE_SELECTION_INVALID');
    return { localPaperIds: [...value.localPaperIds], includeReferences: value.includeReferences, includeSimilarity: value.includeSimilarity };
  }
  function capture(owner, selected, createdAt) {
    check(owner); const sourceLibrary = library(owner), bindings = material(owner), localPapers = new Map(sourceLibrary.papers.map(row => [row.id, row]));
    const skipped = [], sources = [], sourceLocal = new Map(), identityMap = core.createDesktopIdentityMap(owner.accountId, owner.libraryBindingId);
    const skip = (localPaperId, code, label) => skipped.push({ ...(localPaperId ? { localPaperId } : {}), code,
      ...(typeof label === 'string' && label.length <= L.titleCharacters && portableText(label) ? { label } : {}) });
    for (const localPaperId of selected.localPaperIds) {
      const paper = localPapers.get(localPaperId), binding = bindings.get(localPaperId);
      if (!paper) { skip(localPaperId, 'GRAPH_EVIDENCE_LOCAL_UNAVAILABLE'); continue; }
      if (!binding) { skip(localPaperId, 'GRAPH_EVIDENCE_BINDING_REQUIRED', paper.title); continue; }
      if (binding.code) { skip(localPaperId, binding.code, paper.title); continue; }
      if (typeof paper.title !== 'string' || paper.title.trim().length > L.titleCharacters || !portableText(paper.title)) { skip(localPaperId, 'GRAPH_EVIDENCE_TITLE_UNSUPPORTED'); continue; }
      identityMap.aliases[JSON.stringify(['paper', localPaperId])] = binding.entityId;
      const projected = core.projectDesktopLibrary({ accountId: owner.accountId, libraryBindingId: owner.libraryBindingId, identityMap,
        papers: [{ id: localPaperId, title: paper.title, doi: paper.doi, year: paper.year, publication: paper.publication, abstractText: paper.abstractText, authors: paper.authors, keywords: paper.keywords }] }, () => fail('GRAPH_EVIDENCE_BINDING_REQUIRED'));
      const entity = projected.entities.find(row => row.entityType === 'paper'); if (!entity) { skip(localPaperId, 'GRAPH_EVIDENCE_METADATA_UNSUPPORTED', paper.title); continue; }
      const metadata = core.graphEvidenceMetadata(entity.data), source = { paperId: binding.entityId, title: metadata.title, metadataDigest: jsonHash(metadata), versions: binding.versions };
      sources.push(source); sourceLocal.set(localPaperId, source);
    }
    const allVersionIds = sources.flatMap(row => row.versions.map(version => version.versionId));
    if (new Set(allVersionIds).size !== allVersionIds.length) fail('GRAPH_EVIDENCE_BINDING_INVALID');
    const matchInputs = selected.includeReferences ? sourceLibrary.papers.map(row => ({ id: row.id, title: typeof row.title === 'string' ? row.title : '', doi: typeof row.doi === 'string' ? row.doi : '' })) : [];
    if (Buffer.byteLength(core.canonicalJson(matchInputs)) > CAPTURE_LIMITS.matchingBytes) fail('GRAPH_EVIDENCE_REFERENCE_LIMIT');
    const byDoi = new Map(), byTitle = new Map(), normalized = matchInputs.map(row => ({ paper: row, doi: graph.normalizeDoi(row.doi), title: graph.normalizeTitleKey(row.title) }));
    for (const entry of normalized) {
      for (const [map, key] of [[byDoi, entry.doi], [byTitle, entry.title]]) { if (!key) continue; const values = map.get(key) || []; values.push(entry.paper); map.set(key, values); }
    }
    const paperByDoi = new Map([...byDoi].filter(([, rows]) => rows.length === 1).map(([key, rows]) => [key, rows[0]]));
    const paperByTitle = new Map([...byTitle].filter(([, rows]) => rows.length === 1).map(([key, rows]) => [key, rows[0]]));
    let referenceRows = 0, referenceBytes = 0, comparisons = 0;
    const referenceInputs = [], edges = [], seenEdges = new Set();
    const add = (body, localPaperId) => {
      if (body.description !== null && (body.description.length > L.descriptionCharacters || !portableText(body.description))) { skip(localPaperId, 'GRAPH_EVIDENCE_DESCRIPTION_UNSUPPORTED'); return; }
      const id = jsonHash(body); if (seenEdges.has(id)) { skip(localPaperId, 'GRAPH_EVIDENCE_DUPLICATE'); return; }
      if (edges.length >= L.edges) fail('GRAPH_EVIDENCE_EDGE_LIMIT'); seenEdges.add(id); edges.push({ id, ...body });
    };
    const referenceCache = selected.includeReferences && typeof context.store.loadReferences === 'function';
    if (selected.includeReferences && !referenceCache) skip(null, 'GRAPH_EVIDENCE_REFERENCE_UNAVAILABLE');
    if (referenceCache) for (const [localPaperId, source] of sourceLocal) {
      check(owner); const rows = context.store.loadReferences(localPaperId);
      if (!Array.isArray(rows) || (referenceRows += rows.length) > CAPTURE_LIMITS.referenceRows) fail('GRAPH_EVIDENCE_REFERENCE_LIMIT');
      const captured = [];
      for (const [index, raw] of rows.entries()) {
        const row = { seq: raw.seq, doi: raw.doi, title: raw.title, authors: raw.authors, year: raw.year, journal: raw.journal, volume: raw.volume, issue: raw.issue, pages: raw.pages,
          unstructured: raw.unstructured, fetchedAt: Number.isSafeInteger(raw.fetchedAt) && raw.fetchedAt >= 0 ? raw.fetchedAt : null };
        let serialized; try { serialized = core.canonicalJson(row); } catch { fail('GRAPH_EVIDENCE_REFERENCE_INVALID'); }
        const bytes = Buffer.byteLength(serialized); referenceBytes += bytes; if (referenceBytes > CAPTURE_LIMITS.referenceBytes) fail('GRAPH_EVIDENCE_REFERENCE_LIMIT');
        const referenceDigest = sha(serialized); captured.push(referenceDigest);
        if (bytes > CAPTURE_LIMITS.referenceRowBytes) { skip(localPaperId, 'GRAPH_EVIDENCE_REFERENCE_ROW_LIMIT'); continue; }
        if (typeof row.title !== 'string' || row.title.length > L.titleCharacters || !portableText(row.title)) { skip(localPaperId, 'GRAPH_EVIDENCE_DESCRIPTION_UNSUPPORTED'); continue; }
        const candidate = graph.normalizeReferenceCandidate({ doi: row.doi, title: row.title, unstructured: row.unstructured });
        if (!candidate) { skip(localPaperId, 'GRAPH_EVIDENCE_REFERENCE_UNRESOLVED'); continue; }
        // The matching helper's presentation fields are truncated. Match with
        // the original cache title and never export its raw unstructured body.
        if (row.title.trim()) candidate.title = row.title.trim();
        if (candidate.doi && !/^10\.\d{4,9}\/\S+$/i.test(candidate.doi)) candidate.doi = '';
        const titleKey = graph.normalizeTitleKey(candidate.title);
        let candidates = candidate.doi ? (byDoi.get(candidate.doi) || []).filter(row => row.id !== localPaperId) : [];
        if (!candidates.length && titleKey) candidates = (byTitle.get(titleKey) || []).filter(row => row.id !== localPaperId);
        if (!candidates.length && titleKey.length >= 18) {
          for (const entry of normalized) {
            if (++comparisons > CAPTURE_LIMITS.matchComparisons) fail('GRAPH_EVIDENCE_REFERENCE_LIMIT');
            if (entry.paper.id !== localPaperId && entry.title.length >= 18 && (entry.title.includes(titleKey) || titleKey.includes(entry.title))) candidates.push(entry.paper);
          }
        }
        if (candidates.length !== 1) { skip(localPaperId, candidates.length > 1 ? 'GRAPH_EVIDENCE_REFERENCE_AMBIGUOUS' : 'GRAPH_EVIDENCE_REFERENCE_UNRESOLVED', 'Reference ' + (index + 1)); continue; }
        const target = graph.findReferencedPaper(candidate, { id: localPaperId }, candidates, paperByDoi, paperByTitle);
        if (!target || target.id !== candidates[0].id) { skip(localPaperId, 'GRAPH_EVIDENCE_REFERENCE_AMBIGUOUS'); continue; }
        const targetSource = sourceLocal.get(target.id); if (!targetSource) { skip(localPaperId, 'GRAPH_EVIDENCE_TARGET_NOT_SELECTED'); continue; }
        add({ sourcePaperId: source.paperId, targetPaperId: targetSource.paperId, kind: 'citation', description: row.title.trim() || candidate.doi || null, score: null,
          provenance: { kind: 'reference-cache', referenceDigest, fetchedAt: row.fetchedAt, pdfVersionVerified: false } }, localPaperId);
      }
      referenceInputs.push([localPaperId, captured]);
    }
    const vectorCache = selected.includeSimilarity && context.ragStore?.available !== false && typeof context.ragStore?.captureDocumentSimilarityEvidence === 'function';
    let vectorFingerprint = null;
    if (selected.includeSimilarity && !vectorCache) skip(null, 'GRAPH_EVIDENCE_VECTOR_UNAVAILABLE');
    if (vectorCache) {
      const documents = new Map();
      for (const localPaperId of sourceLocal.keys()) for (const key of [localPaperId, 'native-library:' + localPaperId]) {
        if (documents.has(key) && documents.get(key) !== localPaperId) fail('GRAPH_EVIDENCE_BINDING_INVALID'); documents.set(key, localPaperId);
      }
      let evidence;
      try { evidence = context.ragStore.captureDocumentSimilarityEvidence({ documentKeys: [...documents.keys()], minSimilarity: 0.82 }); }
      catch (error) { if (error.code === 'RAG_SIMILARITY_LIMIT') fail('GRAPH_EVIDENCE_VECTOR_LIMIT'); fail('GRAPH_EVIDENCE_VECTOR_INVALID'); }
      vectorFingerprint = evidence.fingerprint;
      for (const edge of evidence.similarities) {
        const sourceLocalId = documents.get(edge.sourceDocumentKey), targetLocalId = documents.get(edge.targetDocumentKey);
        if (!sourceLocalId || !targetLocalId || sourceLocalId === targetLocalId) continue;
        let source = sourceLocal.get(sourceLocalId), target = sourceLocal.get(targetLocalId), sourceCacheDigest = edge.sourceCacheDigest, targetCacheDigest = edge.targetCacheDigest;
        if (source.paperId > target.paperId) { [source, target] = [target, source]; [sourceCacheDigest, targetCacheDigest] = [targetCacheDigest, sourceCacheDigest]; }
        add({ sourcePaperId: source.paperId, targetPaperId: target.paperId, kind: 'similarity', description: 'Historical cache mean-chunk cosine (threshold 0.82); PDF version unverified.', score: edge.similarity,
          provenance: { kind: 'vector-cache', method: 'mean-chunk-cosine-v1', dimension: edge.dimension, modelDigest: edge.modelDigest, sourceCacheDigest, targetCacheDigest,
            indexedAt: edge.indexedAt, pdfVersionVerified: false } }, sourceLocalId);
      }
    }
    sources.sort((a, b) => a.paperId.localeCompare(b.paperId)); edges.sort((a, b) => a.id.localeCompare(b.id));
    const body = { format: 'paperquay-graph-evidence', version: 1, serviceId: owner.serviceId, accountId: owner.accountId,
      producer: { deviceId: owner.deviceId, libraryBindingId: owner.libraryBindingId }, createdAt, sources, edges,
      coverage: { referenceCache, vectorCache, versionPolicy: 'historical-cache-unverified-pdf' } };
    const snapshot = core.readGraphEvidence({ ...body, digest: jsonHash(body) }); check(owner);
    return { snapshot, skipped, fingerprint: jsonHash([selected, snapshot, skipped, matchInputs, referenceInputs, vectorFingerprint]),
      counts: { sources: sources.length, citations: edges.filter(row => row.kind === 'citation').length, similarities: edges.filter(row => row.kind === 'similarity').length, skipped: skipped.length } };
  }
  const result = {
    status,
    list() { return action(() => {
      const owner = identity(); check(owner); const rows = library(owner), bindings = material(owner);
      return { scopeKey: owner.scopeKey, papers: rows.papers.map(row => ({ localPaperId: row.id, title: row.title,
        bound: !!bindings.get(row.id) && !bindings.get(row.id).code, versionCount: bindings.get(row.id)?.versions.length || 0 })) };
    }); },
    preview(args) { return action(() => {
      const owner = identity(), selected = request(args); check(owner);
      const createdAt = new Date(options.now ? options.now() : Date.now()).toISOString(), captured = capture(owner, selected, createdAt), token = allocate();
      if (!UUID.test(token)) fail('GRAPH_EVIDENCE_INVALID'); previewValue = { owner, selected, createdAt, captured, token };
      return { token, scopeKey: owner.scopeKey, snapshot: structuredClone(captured.snapshot), skipped: structuredClone(captured.skipped), counts: { ...captured.counts } };
    }); },
    // Synchronous final guard, suitable immediately before the atomic OS write.
    current(token) {
      try {
        const value = previewValue; if (!value || value.token !== token || busy) fail('GRAPH_EVIDENCE_PREVIEW_STALE'); check(value.owner);
        const captured = capture(value.owner, value.selected, value.createdAt);
        if (captured.fingerprint !== value.captured.fingerprint) fail('GRAPH_EVIDENCE_PREVIEW_STALE');
        return structuredClone(value.captured.snapshot);
      } catch (error) { lastError = codeOf(error); throw Object.assign(new Error(lastError), { code: lastError }); }
    },
    invalidate() { generation++; previewValue = null; lastError = null; notify(); },
    close() { closed = true; generation++; previewValue = null; notify(); },
  }; return result;
}
module.exports = { createDesktopGraphEvidence, CAPTURE_LIMITS };
