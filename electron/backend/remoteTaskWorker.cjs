const { createHash } = require('node:crypto');
const { normalizeRemoteScope, scopeDigest, journalArtifact } = require('./remoteTaskJournal.cjs');
const { abortableDelay } = require('./remoteMineruAdapter.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const safe = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const throttled = (error) => error?.code === 'RATE_LIMITED' || error?.statusCode === 429 || error?.status === 429;
function publicCode(error) {
  if (throttled(error)) return 'RATE_LIMITED';
  return typeof error?.code === 'string' && /^(?:DESKTOP_|REMOTE_|PROFILE_CHANGED$|SOURCE_UNAVAILABLE$|EXTERNAL_OUTCOME_UNKNOWN$|SESSION_REVOKED$|AUTHENTICATION_REQUIRED$)[A-Z0-9_]*$/.test(error.code)
    ? error.code : 'EXECUTION_FAILED';
}
function profile(value) {
  if (!exact(value, ['id', 'revision', 'digest', 'kind', 'model']) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !HASH.test(value.digest)
    || !['parse', 'index'].includes(value.kind) || !safe(value.model, 128)) fail('REMOTE_TASK_RESPONSE_INVALID');
  return { id: value.id, revision: value.revision, digest: value.digest, kind: value.kind, model: value.model };
}
function snapshotValue(input) {
  if (!exact(input, ['scope', 'generation', 'profiles']) || !exact(input.generation, ['account', 'library', 'profiles', 'credentials'])
    || !Object.values(input.generation).every((value) => safe(value) || Number.isSafeInteger(value) && value >= 0)
    || !Array.isArray(input.profiles) || input.profiles.length > 8) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
  const profiles = input.profiles.map(profile).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(profiles.map((value) => value.id)).size !== profiles.length) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
  return { scope: normalizeRemoteScope(input.scope), generation: { account: input.generation.account, library: input.generation.library,
    profiles: input.generation.profiles, credentials: input.generation.credentials }, profiles };
}
function parsedTask(input, snapshot) {
  if (!exact(input, ['id', 'kind', 'state', 'target', 'providerDeviceId', 'recoveryProviderDeviceId', 'profile', 'indexSourceDigest', 'attempt', 'createdAt', 'updatedAt',
    'leaseExpiresAt', 'failure', 'artifact']) || !UUID.test(input.id) || !['parse', 'index'].includes(input.kind)
    || !['queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'interrupted'].includes(input.state)
    || input.providerDeviceId !== snapshot.scope.deviceId || (input.recoveryProviderDeviceId !== null
      && !UUID.test(input.recoveryProviderDeviceId))
    || !Number.isInteger(input.attempt) || input.attempt < 0 || input.attempt > 100
    || !exact(input.target, ['paperId', 'attachmentVersionId', 'paperRevision', 'versionRevision', 'sha256', 'sizeBytes', 'pageCount', 'fileName'])) fail('REMOTE_TASK_RESPONSE_INVALID');
  const target = input.target; const selected = profile(input.profile);
  if (selected.kind !== input.kind || !snapshot.profiles.some((value) => JSON.stringify(value) === JSON.stringify(selected))
    || !UUID.test(target.paperId) || !UUID.test(target.attachmentVersionId) || !HASH.test(target.sha256)
    || !Number.isInteger(target.sizeBytes) || target.sizeBytes < 1 || target.sizeBytes > 64 * 1024 * 1024
    || (target.pageCount !== null && (!Number.isInteger(target.pageCount) || target.pageCount < 1 || target.pageCount > 2000))
    || !safe(target.fileName, 255) || /[\\/:]/.test(target.fileName)
    || (input.kind === 'index' ? !HASH.test(input.indexSourceDigest) : input.indexSourceDigest !== null)) fail('REMOTE_TASK_RESPONSE_INVALID');
  return structuredClone({ ...input, profile: selected });
}
function executionKey(snapshot, task) {
  // Account/session/library epochs guard a live run; they are intentionally not
  // durable identities. A stable credential revision must survive app restart.
  return sha(JSON.stringify({ scope: scopeDigest(snapshot.scope), credentials: snapshot.generation.credentials,
    kind: task.kind, target: { paperId: task.target.paperId, attachmentVersionId: task.target.attachmentVersionId,
      sha256: task.target.sha256, sizeBytes: task.target.sizeBytes }, profile: task.profile, source: task.indexSourceDigest }));
}
function createRemoteTaskWorker(options) {
  if (!options || !['capture', 'check', 'api', 'readPdf'].every((key) => typeof options[key] === 'function')
    || !options.journal || typeof options.journal.read !== 'function' || typeof options.journal.write !== 'function') fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
  const timings = { pollMs: 10000, presenceMs: 15000, heartbeatMs: 10000, guardMs: 1000, ...options.timings };
  if (Object.values(timings).some((value) => !Number.isInteger(value) || value < 1 || value > 30000)
    || timings.heartbeatMs >= 30000 || timings.presenceMs >= 30000) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
  const core = () => options.core || require('../generated/desktopSyncCore.cjs');
  let runtime = null; let lastError = null;
  const notify = () => { try { options.onState?.({ running: Boolean(runtime && !runtime.controller.signal.aborted), busy: Boolean(runtime?.active), errorCode: lastError }); } catch {} };
  async function bindingCheck(run) {
    if (run.controller.signal.aborted || runtime !== run) fail('DESKTOP_OPERATION_CANCELLED');
    await options.check(run.snapshot);
    const current = snapshotValue(await options.capture());
    if (JSON.stringify(current) !== JSON.stringify(run.snapshot)) fail('REMOTE_BINDING_CHANGED');
    if (run.controller.signal.aborted || runtime !== run) fail('DESKTOP_OPERATION_CANCELLED');
  }
  function pauseForRateLimit(run, error) {
    if (!throttled(error)) return false;
    if (runtime !== run || run.controller.signal.aborted) return true;
    const now = Date.now();
    if (run.resumeAt <= now) run.backoffMs = Math.min(300000, Math.max(60000, run.backoffMs * 2));
    run.resumeAt = Math.max(run.resumeAt, now + run.backoffMs);
    run.presenceRequired = true; lastError = 'RATE_LIMITED';
    // Losing a lease renewal cannot authorize more upstream work. Its durable
    // journal still decides whether recovery may reuse a batch or artifact.
    run.localController?.abort(); notify(); return true;
  }
  async function call(run, method, suffix, body, signal = run.controller.signal, bytes, headers) {
    try { return await options.api(run.snapshot,
      { method, path: '/v1/remote-tasks' + suffix, ...(body === undefined ? {} : { body }), ...(bytes ? { bytes } : {}), ...(headers ? { headers } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(bytes ? 45000 : 15000)].filter(Boolean)) }); }
    catch (error) { pauseForRateLimit(run, error); throw error; }
  }
  async function advertise(run) {
    if (run.presenceTask) return run.presenceTask;
    const task = (async () => {
      await bindingCheck(run); await call(run, 'PUT', '/provider', { profiles: run.snapshot.profiles });
      await bindingCheck(run); run.presenceRequired = false;
    })();
    run.presenceTask = task;
    try { return await task; } finally { if (run.presenceTask === task) run.presenceTask = null; }
  }
  function invalidate(run, error) {
    if (run.controller.signal.aborted) return;
    lastError = publicCode(error); run.controller.abort();
    for (const timer of run.timers) clearInterval(timer); run.timers.clear(); notify();
  }
  function periodic(run, ms, work, network = false) {
    let running = false;
    const timer = setInterval(() => {
      if (running || run.controller.signal.aborted || (network && Date.now() < run.resumeAt)) return;
      running = true;
      Promise.resolve().then(work).catch((error) => { if (!pauseForRateLimit(run, error)) invalidate(run, error); }).finally(() => { running = false; });
    }, ms);
    timer.unref?.(); run.timers.add(timer); return timer;
  }
  async function verifyArtifact(task, raw) {
    if (!(raw instanceof Uint8Array) || !raw.byteLength || raw.byteLength > 16 * 1024 * 1024) fail('REMOTE_TASK_ARTIFACT_LIMIT');
    const bytes = Buffer.from(raw);
    const parsed = task.kind === 'parse' ? await core().decodeParsedDocument(new Uint8Array(bytes)) : await core().decodeRemoteIndexArtifact(new Uint8Array(bytes));
    const document = parsed.document;
    if (document.paperId !== task.target.paperId || document.attachmentVersionId !== task.target.attachmentVersionId
      || document.pdf.sha256 !== task.target.sha256 || document.pdf.sizeBytes !== task.target.sizeBytes
      || (task.target.pageCount !== null && document.pdf.pageCount !== task.target.pageCount)
      || (task.kind === 'parse' ? document.parser.model !== task.profile.model : document.model !== task.profile.model || document.parseDigest !== task.indexSourceDigest)) fail('SOURCE_UNAVAILABLE');
    return task.kind === 'parse' ? Buffer.from(JSON.stringify(document)) : Buffer.from(parsed.bytes);
  }
  async function executeOne(run) {
    await bindingCheck(run);
    const response = await call(run, 'POST', '/provider/claim', {}); await bindingCheck(run);
    if (!exact(response, ['claim'])) fail('REMOTE_TASK_RESPONSE_INVALID');
    run.backoffMs = 0; run.resumeAt = 0; lastError = null;
    if (response.claim === null) return { worked: false };
    if (!exact(response.claim, ['task', 'lease']) || !exact(response.claim.lease, ['attempt', 'fence'])
      || !UUID.test(response.claim.lease.fence)) fail('REMOTE_TASK_RESPONSE_INVALID');
    const task = parsedTask(response.claim.task, run.snapshot); const lease = { ...response.claim.lease };
    if (task.state !== 'running' || !Number.isInteger(lease.attempt) || lease.attempt !== task.attempt || lease.attempt < 1 || lease.attempt > 100) fail('REMOTE_TASK_RESPONSE_INVALID');
    const local = new AbortController(); const signal = AbortSignal.any([run.controller.signal, local.signal]);
    run.localController = local;
    let cancelled = false; let heartbeatBusy = false; let heartbeatWork = null;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || signal.aborted) return;
      heartbeatBusy = true;
      heartbeatWork = (async () => {
        await bindingCheck(run); const result = await call(run, 'POST', `/jobs/${task.id}/heartbeat`, lease, signal);
        const current = parsedTask(result?.task, run.snapshot);
        if (current.id !== task.id || current.attempt !== lease.attempt) fail('REMOTE_TASK_LEASE_CHANGED');
        if (current.state !== 'running') { cancelled = true; local.abort(); }
      })().catch((error) => { if (!run.controller.signal.aborted) lastError = publicCode(error); local.abort(); }).finally(() => { heartbeatBusy = false; });
    }, timings.heartbeatMs);
    heartbeat.unref?.(); run.timers.add(heartbeat);
    const check = async () => { if (signal.aborted) fail('DESKTOP_OPERATION_CANCELLED'); await options.check(run.snapshot, task);
      await bindingCheck(run); if (signal.aborted) fail('DESKTOP_OPERATION_CANCELLED'); };
    let entry; let recoveryOrigin = null;
    const checkpoint = {
      read: async () => structuredClone(entry),
      write: async (next) => { entry = await options.journal.write(run.snapshot.scope, task.id, next); return structuredClone(entry); },
    };
    try {
      const key = executionKey(run.snapshot, task);
      if (task.recoveryProviderDeviceId !== null && task.recoveryProviderDeviceId !== run.snapshot.scope.deviceId) {
        // The service-named holder is the latest confirmed evidence, even if
        // this scope contains an older record from A -> B -> A. Never let that
        // stale prepared state authorize a new paid submission or confirmation.
        const oldScope = { ...run.snapshot.scope, deviceId: task.recoveryProviderDeviceId };
        const prior = await options.journal.read(oldScope, task.id);
        if (!prior) fail('SOURCE_UNAVAILABLE');
        const oldKey = executionKey({ ...run.snapshot, scope: oldScope }, task);
        if (prior.kind !== task.kind || prior.executionKey !== oldKey) fail('PROFILE_CHANGED');
        await check();
        entry = await options.journal.write(run.snapshot.scope, task.id, { ...prior, executionKey: key, attempt: lease.attempt });
        recoveryOrigin = { scope: oldScope, executionKey: oldKey };
      } else {
        entry = await options.journal.read(run.snapshot.scope, task.id);
        if (!entry && task.recoveryProviderDeviceId !== null) fail('SOURCE_UNAVAILABLE');
      }
      if (entry && (entry.executionKey !== key || entry.kind !== task.kind)) fail('PROFILE_CHANGED');
      if (!entry) entry = { version: 1, jobId: task.id, kind: task.kind, executionKey: key, attempt: lease.attempt, stage: 'prepared' };
      entry = await checkpoint.write({ ...entry, attempt: lease.attempt }); await check();
      // Cached output is not authority to read an unselected/removed mapping.
      // Revalidate the current pinned PDF even when no upstream call is needed.
      const read = await options.readPdf({ task, snapshot: run.snapshot, signal, check }); await check();
      const raw = read?.bytes || read;
      if (!(raw instanceof Uint8Array) || raw.byteLength !== task.target.sizeBytes || raw.byteLength > 64 * 1024 * 1024) fail('SOURCE_UNAVAILABLE');
      const pdf = Buffer.from(raw);
      if (sha(pdf) !== task.target.sha256 || !pdf.subarray(0, 1024).includes(Buffer.from('%PDF-'))
        || !pdf.subarray(Math.max(0, pdf.length - 8192)).includes(Buffer.from('%%EOF'))) fail('SOURCE_UNAVAILABLE');
      // The service advances the recovery holder only after durable local
      // proof exists. A missing or uncertain ACK never authorizes paid work.
      const confirmed = parsedTask((await call(run, 'POST', `/jobs/${task.id}/recovery-confirm`, lease, signal))?.task, run.snapshot);
      if (confirmed.id !== task.id || confirmed.attempt !== lease.attempt) fail('REMOTE_TASK_LEASE_CHANGED');
      if (confirmed.state === 'cancel_requested') {
        await call(run, 'POST', `/jobs/${task.id}/heartbeat`, lease, signal);
        cancelled = true; local.abort(); fail('REMOTE_TASK_LEASE_CHANGED');
      }
      if (confirmed.state !== 'running') { cancelled = confirmed.state === 'cancelled'; local.abort(); fail('REMOTE_TASK_LEASE_CHANGED'); }
      if (confirmed.recoveryProviderDeviceId !== run.snapshot.scope.deviceId) fail('REMOTE_TASK_RESPONSE_INVALID');
      await check();
      let bytes;
      if (entry.artifact) bytes = Buffer.from(entry.artifact.base64, 'base64');
      else {
        if (typeof options.adapters?.[task.kind]?.execute !== 'function') fail('PROFILE_CHANGED');
        bytes = await options.adapters[task.kind].execute({ task, lease, snapshot: run.snapshot, pdf, signal, check, checkpoint });
      }
      await check(); bytes = await verifyArtifact(task, bytes); await check();
      entry = await checkpoint.write({ ...entry, stage: 'complete_pending', artifact: journalArtifact(bytes) }); await check();
      // Renew immediately before the bounded upload, then stop racing a final
      // heartbeat against the completion reply. Uploads have a 45s deadline and
      // the freshly renewed server lease lasts 60s.
      clearInterval(heartbeat); run.timers.delete(heartbeat);
      await heartbeatWork; await check();
      const renewed = parsedTask((await call(run, 'POST', `/jobs/${task.id}/heartbeat`, lease, signal))?.task, run.snapshot);
      if (renewed.id !== task.id || renewed.attempt !== lease.attempt || renewed.state !== 'running') {
        cancelled = renewed.state === 'cancelled'; local.abort(); fail('REMOTE_TASK_LEASE_CHANGED');
      }
      const completed = await call(run, 'POST', `/jobs/${task.id}/complete`, undefined, signal, bytes,
        { 'Content-Type': 'application/octet-stream', 'X-PaperQuay-Remote-Attempt': String(lease.attempt), 'X-PaperQuay-Remote-Fence': lease.fence });
      const result = parsedTask(completed?.task, run.snapshot);
      if (result.id !== task.id || result.attempt !== lease.attempt || !['succeeded', 'cancelled'].includes(result.state)) fail('REMOTE_TASK_RESPONSE_INVALID');
      if (result.state === 'succeeded') {
        await checkpoint.write({ ...entry, stage: 'completed' });
        // Acknowledged completion also closes the exact older local evidence
        // used by this migration. Retain bytes; explicit cleanup may remove it.
        if (recoveryOrigin) try {
          const old = await options.journal.read(recoveryOrigin.scope, task.id);
          if (old?.executionKey === recoveryOrigin.executionKey && old.kind === task.kind)
            await options.journal.write(recoveryOrigin.scope, task.id, { ...old, stage: 'completed' });
        } catch { /* Preserve older evidence if its local bookkeeping fails. */ }
      }
      lastError = null; return { worked: true, state: result.state, taskId: task.id };
    } catch (error) {
      const code = publicCode(error);
      if (cancelled) lastError = null; else if (!signal.aborted) lastError = code;
      if (!run.controller.signal.aborted && !signal.aborted && !cancelled && !throttled(error)) {
        const failure = ['PROFILE_CHANGED', 'SOURCE_UNAVAILABLE', 'EXTERNAL_OUTCOME_UNKNOWN'].includes(code) ? code : 'EXECUTION_FAILED';
        try { await bindingCheck(run); await call(run, 'POST', `/jobs/${task.id}/fail`, { ...lease, code: failure }, AbortSignal.timeout(5000)); } catch {}
      }
      return { worked: true, state: cancelled ? 'cancelled' : 'interrupted', taskId: task.id,
        errorCode: cancelled ? null : signal.aborted ? lastError || 'DESKTOP_OPERATION_CANCELLED' : code };
    } finally {
      clearInterval(heartbeat); run.timers.delete(heartbeat); local.abort();
      if (run.localController === local) run.localController = null;
      notify();
    }
  }
  const worker = {
    async start({ manual = false } = {}) {
      if (runtime && !runtime.controller.signal.aborted) return;
      if (runtime) await worker.stop();
      const run = { controller: new AbortController(), snapshot: null, timers: new Set(), active: null, loop: null,
        resumeAt: 0, backoffMs: 0, presenceRequired: true, presenceTask: null, localController: null }; runtime = run;
      try {
        run.snapshot = snapshotValue(await options.capture()); await bindingCheck(run);
        const published = run.snapshot.profiles.filter((value) => typeof options.adapters?.[value.kind]?.execute === 'function');
        if (published.length !== run.snapshot.profiles.length || !published.length) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
        await advertise(run); lastError = null;
      } catch (error) {
        if (!run.snapshot || !pauseForRateLimit(run, error) || run.controller.signal.aborted) {
          invalidate(run, error); throw Object.assign(new Error(publicCode(error)), { code: publicCode(error) });
        }
      }
      notify();
      periodic(run, timings.guardMs, () => bindingCheck(run));
      periodic(run, timings.presenceMs, () => advertise(run), true);
      if (!manual) run.loop = (async () => {
        while (!run.controller.signal.aborted) { await worker.runOnce(); await abortableDelay(timings.pollMs, run.controller.signal); }
      })().catch((error) => { if (!run.controller.signal.aborted) invalidate(run, error); });
    },
    async runOnce() {
      const run = runtime; if (!run || run.controller.signal.aborted || !run.snapshot) fail('REMOTE_WORKER_STOPPED');
      if (run.active) return run.active;
      const active = (async () => {
        await bindingCheck(run);
        if (Date.now() < run.resumeAt) return { worked: false };
        if (run.presenceRequired) await advertise(run);
        return executeOne(run);
      })(); run.active = active; notify();
      try { return await active; }
      catch (error) {
        if (pauseForRateLimit(run, error)) return { worked: false };
        invalidate(run, error); const code = publicCode(error); throw Object.assign(new Error(code), { code });
      }
      finally { if (run.active === active) run.active = null; notify(); }
    },
    async stop() {
      const run = runtime; if (!run) return;
      run.controller.abort(); for (const timer of run.timers) clearInterval(timer); run.timers.clear(); notify();
      try {
        // Only the original binding may withdraw. A new account must never be
        // contacted as a fallback after logout or an account switch.
        if (run.snapshot) { await options.check(run.snapshot); const current = snapshotValue(await options.capture());
          if (scopeDigest(current.scope) === scopeDigest(run.snapshot.scope) && JSON.stringify(current.generation) === JSON.stringify(run.snapshot.generation))
            await call(run, 'DELETE', '/provider', undefined, AbortSignal.timeout(5000)); }
      } catch {}
      await Promise.allSettled([run.active, run.loop].filter(Boolean)); if (runtime === run) runtime = null; notify();
    },
    snapshot: () => ({ running: Boolean(runtime && !runtime.controller.signal.aborted), busy: Boolean(runtime?.active), errorCode: lastError }),
  };
  return worker;
}
module.exports = { createRemoteTaskWorker, remoteTaskExecutionKey: executionKey };
