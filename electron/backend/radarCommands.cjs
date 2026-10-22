const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRadarStore } = require('./radarStore.cjs');
const { searchTopic } = require('./radarSources.cjs');
const { normalizeTopic, samePaper, candidatePaperId, createPaperIndex, buildQueue, mergeCandidates, rankPaper } = require('./radarDomain.cjs');
const { openAuthorizedReadFile, writeBoundFile, removeBoundFile } = require('./pathAccess.cjs');
const { hashBytes, safeFileName } = require('./utils.cjs');

function createRadarController(context, options = {}) {
  const persistence = options.persistence || createRadarStore(context.appPaths);
  const discover = options.discover || searchTopic;
  const clock = options.clock || Date.now;
  const changed = () => { try { options.onChange?.(); } catch { /* A closing renderer cannot invalidate a committed change. */ } };
  let active = null, closed = false, timer, initialTimer;
  const attaching = new Set();

  function snapshot(topicId) {
    const state = persistence.load(), library = context.store.load();
    const topic = state.topics.find((item) => item.id === topicId) || state.topics[0];
    const papers = createPaperIndex(library.papers);
    return { topics: state.topics, activeTopicId: active?.topicId || null,
      candidates: state.candidates.map((candidate) => {
        const paper = papers.byId.get(candidate.paperId) || papers.byId.get(candidatePaperId(candidate.id)) || papers.find(candidate);
        return { ...candidate, paperId: paper?.id || null, hasPdf: Boolean(paper?.attachments?.some((a) => a.kind === 'pdf' && !a.missing)),
          ranking: topic ? rankPaper(candidate, topic, clock()) : null };
      }), queue: buildQueue(library, state, topic?.id, clock()), selectedTopicId: topic?.id || null };
  }

  async function run(topicId) {
    if (closed) throw new Error('Radar is shutting down.');
    if (active) throw new Error('A radar check is already running.');
    const topic = persistence.load().topics.find((item) => item.id === topicId);
    if (!topic) throw new Error('Topic does not exist.');
    const now = clock();
    if (topic.lastAttemptAt && now - topic.lastAttemptAt < 60000) throw new Error('Wait one minute before checking this topic again.');
    if (topic.retryAt && now < topic.retryAt) throw new Error('The metadata source requested a cooldown. Try again after ' + new Date(topic.retryAt).toISOString());
    const controller = new AbortController();
    const runToken = { topicId, controller };
    active = runToken;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(new Error('Check timed out')); }, 90000);
    deadline.unref?.();
    try {
      persistence.update((state) => {
        const current = state.topics.find((item) => item.id === topicId);
        current.lastAttemptAt = now;
        current.nextRunAt = now + current.intervalHours * 3600000;
      });
      changed();
      const { records, reports } = await discover(topic, context.store.load().settings, { signal: controller.signal, timestamp: now });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (closed) return null;
      persistence.update((state) => {
        const current = state.topics.find((item) => item.id === topicId);
        if (!current || current.revision !== topic.revision) return;
        const result = mergeCandidates(state, records, topic, clock(), context.store.load());
        const failed = reports.some((item) => item.error);
        current.lastRun = { at: clock(), status: failed ? 'partial' : 'success', ...result, reports };
        current.retryAt = Math.max(0, ...reports.map((item) => item.retryAt || 0));
        current.nextRunAt = Math.max(current.nextRunAt, current.retryAt);
        if (reports.every((item) => item.error)) current.lastRun.status = 'failed';
        if (!failed) current.lastSuccessAt = clock();
      });
    } catch (error) {
      if (!closed) persistence.update((state) => {
        const current = state.topics.find((item) => item.id === topicId);
        if (!current || current.revision !== topic.revision) return;
        current.lastRun = { at: clock(), status: controller.signal.aborted && !timedOut ? 'cancelled' : 'failed', added: 0, known: 0,
          capacity: false, reports: [], message: controller.signal.aborted ? 'Check stopped; existing candidates were kept.' : 'Check failed; existing candidates were kept.' };
      });
    } finally {
      clearTimeout(deadline);
      if (active === runToken) active = null;
      if (!closed) changed();
    }
    return closed ? null : snapshot(topicId);
  }

  async function tick() {
    if (closed || active) return;
    const now = clock();
    const due = persistence.load().topics.find((topic) => topic.enabled && (!topic.nextRunAt || topic.nextRunAt <= now));
    if (due) await run(due.id);
  }

  function markImported(candidateId, paperId) {
    persistence.update((state) => {
      const candidate = state.candidates.find((item) => item.id === candidateId);
      if (candidate) { candidate.paperId = paperId; candidate.dismissed = false; }
    });
    changed();
  }

  function importCandidate(candidateId) {
    const candidate = persistence.load().candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new Error('Candidate does not exist.');
    const library = context.store.load();
    const paperId = candidatePaperId(candidate.id);
    const existing = library.papers.find((item) => item.id === candidate.paperId || item.id === paperId || samePaper(item, candidate));
    if (existing) { markImported(candidateId, existing.id); return existing; }
    const now = clock();
    const paper = {
      id: paperId, title: candidate.title, year: candidate.year || null, doi: candidate.doi || null,
      publication: candidate.publication || null, url: candidate.url || null, abstractText: candidate.abstractText || null,
      keywords: candidate.keywords || [], authors: candidate.authors.map((name, sortOrder) => ({ id: `author-${randomUUID()}`, name, givenName: null, familyName: null, sortOrder })),
      importedAt: now, updatedAt: now, lastReadAt: null, readingProgress: 0, isFavorite: false, userNote: null,
      aiSummary: null, citation: null, source: 'radar', sortOrder: Math.min(0, ...library.papers.map((item) => item.sortOrder || 0)) - 1,
      tags: [], categoryIds: [], attachments: [],
    };
    library.papers.push(paper);
    // No await between loading and committing. If recording the candidate fails
    // after this commit, the deterministic candidate ID also makes sparse
    // metadata (no DOI, year or author) retry-safe.
    context.store.saveSync(library);
    markImported(candidateId, paperId);
    return paper;
  }

  async function attachPdf(paperId, sourcePath) {
    if (attaching.has(paperId)) throw new Error('A PDF is already being attached to this paper.');
    const previous = context.store.load();
    const paper = previous.papers.find((item) => item.id === paperId);
    if (!paper || paper.attachments.some((item) => item.kind === 'pdf' && !item.missing)) throw new Error('Select a paper without an available PDF attachment.');
    const previousPdfs = JSON.stringify(paper.attachments.filter((item) => item.kind === 'pdf'));
    const duplicate = (library, hash) => library.papers.some((item) => item.attachments.some((attachment) =>
      attachment.contentHash === hash && !(item.id === paperId && attachment.kind === 'pdf' && attachment.missing)));
    if (typeof sourcePath !== 'string' || !sourcePath.toLowerCase().endsWith('.pdf')) throw new Error('Select a PDF file.');
    attaching.add(paperId);
    let destination = null, writtenIdentity, committed = false;
    try {
      const approved = context.validateLibraryFileOperation?.(previous, previous.papers.flatMap((item) => item.attachments));
      const sources = await context.approveImportSources?.([sourcePath], { mode: 'copy' });
      const actualSource = sources?.get(sourcePath) || sourcePath;
      const { handle } = await openAuthorizedReadFile(actualSource);
      let bytes;
      try {
        const limit = 200 * 1024 * 1024;
        if ((await handle.stat()).size > limit) throw new Error('Attach a PDF smaller than 200 MB.');
        const chunks = []; let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
          size += chunk.length;
          if (size > limit) throw new Error('Attach a PDF smaller than 200 MB.');
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks, size);
      } finally { await handle.close(); }
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')) || !bytes.subarray(-8192).includes(Buffer.from('%%EOF'))) throw new Error('This file does not contain a complete PDF header and trailer.');
      const contentHash = hashBytes(bytes);
      if (duplicate(previous, contentHash)) throw new Error('This PDF is already attached to another library paper.');
      const storageDir = approved?.storageRoot || previous.settings.storageDir || path.join(context.appPaths.dataDir, 'paperquay-data');
      const fileName = safeFileName(path.basename(sourcePath));
      destination = path.join(storageDir, `paper-${randomUUID()}-${fileName}`);
      const result = await writeBoundFile(destination, bytes, { flag: 'wx' });
      writtenIdentity = result.identity;
      const attachment = { id: `att-${randomUUID()}`, paperId, kind: 'pdf', originalPath: sourcePath, storedPath: destination,
        relativePath: path.relative(storageDir, destination), fileName, mimeType: 'application/pdf', fileSize: bytes.length,
        contentHash, createdAt: clock(), missing: false };
      const approval = await context.approveImportedAttachments?.(previous, [attachment]);
      const commit = () => {
        const current = context.store.load();
        const target = current.papers.find((item) => item.id === paperId);
        if (!target || JSON.stringify(target.attachments.filter((item) => item.kind === 'pdf')) !== previousPdfs ||
            current.settings.storageDir !== previous.settings.storageDir) throw new Error('The library changed; refresh and try again.');
        if (duplicate(current, contentHash)) throw new Error('This PDF was already attached while importing.');
        target.attachments = [...target.attachments.filter((item) => item.kind !== 'pdf'), attachment]; target.updatedAt = clock();
        context.store.saveSync(current);
        committed = true;
      };
      if (approval) approval.commit(commit); else commit();
      changed();
      return context.store.load().papers.find((item) => item.id === paperId);
    } finally {
      attaching.delete(paperId);
      if (destination && writtenIdentity && !committed) await removeBoundFile(destination, { expectedIdentity: writtenIdentity }).catch(() => {});
    }
  }

  const commands = {
    radar_get_snapshot: ({ topicId } = {}) => snapshot(topicId),
    radar_save_topic({ topic }) {
      let saved;
      persistence.update((state) => {
        const previous = topic?.id ? state.topics.find((item) => item.id === topic.id) : null;
        if (topic?.id && !previous) throw new Error('Topic does not exist.');
        if (!previous && state.topics.length >= 20) throw new Error('Use at most 20 topics.');
        saved = normalizeTopic(topic, previous);
        if (previous) state.topics[state.topics.indexOf(previous)] = saved; else state.topics.push(saved);
      });
      if (active?.topicId === saved.id) active.controller.abort();
      changed(); return saved;
    },
    radar_delete_topic({ topicId }) {
      if (active?.topicId === topicId) active.controller.abort();
      persistence.update((state) => {
        state.topics = state.topics.filter((item) => item.id !== topicId);
        state.candidates = state.candidates.map((item) => ({ ...item, topicIds: item.topicIds.filter((id) => id !== topicId) })).filter((item) => item.topicIds.length);
      });
      changed();
    },
    radar_run: ({ topicId }) => run(topicId),
    radar_cancel() { active?.controller.abort(); },
    radar_set_candidate({ candidateId, dismissed }) {
      persistence.update((state) => {
        const candidate = state.candidates.find((item) => item.id === candidateId);
        if (!candidate) throw new Error('Candidate does not exist.');
        candidate.dismissed = dismissed === true;
      });
      changed();
    },
    radar_import_candidate: ({ candidateId }) => importCandidate(candidateId),
    radar_attach_pdf: ({ paperId, sourcePath }) => attachPdf(paperId, sourcePath),
    radar_set_queue({ paperId, status, pinned }) {
      if (!context.store.load().papers.some((paper) => paper.id === paperId)) throw new Error('Paper does not exist.');
      if (status !== undefined && !['unread', 'later', 'read'].includes(status)) throw new Error('Invalid reading status.');
      if (pinned !== undefined && typeof pinned !== 'boolean') throw new Error('Invalid pin state.');
      persistence.update((state) => {
        let item = state.queue.find((entry) => entry.paperId === paperId);
        if (!item) {
          const ids = new Set(context.store.load().papers.map((paper) => paper.id));
          state.queue = state.queue.filter((entry) => ids.has(entry.paperId));
          if (state.queue.length >= 50000) throw new Error('Reading queue preferences are full.');
          item = { paperId }; state.queue.push(item);
        }
        if (status !== undefined) item.status = status;
        if (pinned !== undefined) item.pinned = pinned;
      });
      changed();
    },
  };

  return { commands, tick, start() {
    initialTimer = setTimeout(() => { void tick().catch(() => {}); }, 10000);
    timer = setInterval(() => { void tick().catch(() => {}); }, 60000);
    initialTimer.unref?.(); timer.unref?.();
  }, close() { closed = true; clearTimeout(initialTimer); clearInterval(timer); active?.controller.abort(); } };
}

module.exports = { createRadarController };
