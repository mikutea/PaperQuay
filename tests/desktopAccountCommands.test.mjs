import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createDesktopAccountCommands } = require('../electron/backend/desktopAccountCommands.cjs');
const { createAppPaths, createLibraryStore } = require('../electron/backend/libraryStore.cjs');
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');
const { createSourceAccess } = require('../electron/backend/sourceAccess.cjs');
const { isWithin, resolveAuthorizedPath } = require('../electron/backend/pathAccess.cjs');
const nativeFs = require('../electron/backend/nativeFs.cjs');

const CONFIG = { apiBaseUrl: 'https://sync.example.test', oidcIssuer: 'https://login.example.test/realm', oidcClientId: 'paperquay-desktop', deviceName: 'Test desktop' };
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\nfixture bytes\n%%EOF\n');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const REMOTE_CAPABILITY = { protocolVersion: 1, transport: 'persistent-jobs-v1', maxArtifactBytes: 16777216, maxAccountArtifactBytes: 67108864,
  maxActive: 1, maxQueued: 16, maxRetained: 200, maxReceipts: 2000, maxProfiles: 8, leaseSeconds: 60, providerPresenceSeconds: 45 };
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) assert.fail('Timed out waiting for test condition'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
async function remoteFixture(t, { blockSubmission = false, beforeRevision } = {}) {
  const fixtures = await import('./remoteTaskFixtures.mjs'); const f = await fixture(t);
  const secure = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'synthetic-os',
    encryptString: (value) => Buffer.from(Buffer.from(value).toString('base64')), decryptString: (value) => Buffer.from(value.toString(), 'base64').toString() };
  const submitted = deferred(), closed = deferred(); let dataId, uploads = 0, submissions = 0, publicProfiles = [], claimed = false, task, worker, manager, loseCompletion = false;
  const upstream = await fixtures.server(t, async (request, response) => {
    if (request.url.startsWith('/file-urls/batch')) {
      submissions++;
      dataId = JSON.parse(await fixtures.body(request)).files[0].data_id;
      if (blockSubmission) { response.once('close', closed.resolve); submitted.resolve(); return; }
      return fixtures.json(response, { code: 0, data: { batch_id: 'actual-command-batch', file_urls: [upstream.base + '/upload'] } });
    }
    if (request.url === '/upload') { assert.deepEqual(await fixtures.body(request), PDF); uploads++; response.end(); return; }
    if (request.url.startsWith('/extract-results/batch/')) return fixtures.json(response, { code: 0, data: { extract_result: [{ data_id: dataId, state: 'done', full_zip_url: upstream.base + '/zip' }] } });
    response.end(Buffer.from('synthetic-zip-input-to-injected-converter'));
  });
  const config = { settings: { mineruApiBaseUrl: upstream.base }, secrets: { mineruApiToken: 'PRIVATE_COMMAND_MINERU_KEY' } };
  f.service.onRoute = async (url, options, body) => {
    if (url.origin === upstream.base) return fetch(url.href, options);
    if (url.pathname === '/v1/capabilities') return Response.json({ protocolVersion: 1, features: { desktopPdfTransfer: 1, remoteTasks: 1 },
      desktopPdf: { transport: 'http-relay-v1', maxFileBytes: 67108864, requestTtlMs: 30000, pollTimeoutMs: 20000 }, remoteTasks: REMOTE_CAPABILITY });
    if (url.pathname === '/v1/remote-tasks/provider') {
      if (options.method === 'PUT') { publicProfiles = body.profiles; return Response.json({ provider: {} }); }
      if (task?.state === 'running') task.state = 'interrupted'; return Response.json({ disabled: true });
    }
    if (url.pathname === '/v1/remote-tasks/provider/claim') {
      if (claimed) return Response.json({ claim: null }); claimed = true;
      const binding = manager.getStatus().bindings[0], timestamp = new Date().toISOString();
      if (!task) task = { id: randomUUID(), kind: 'parse', state: 'running', target: { paperId: binding.paperId, attachmentVersionId: binding.attachmentVersionId,
        paperRevision: 1, versionRevision: 1, sha256: binding.sha256, sizeBytes: binding.sizeBytes, pageCount: null, fileName: binding.fileName },
      providerDeviceId: f.service.deviceId, recoveryProviderDeviceId: null, profile: publicProfiles[0], indexSourceDigest: null, attempt: 1,
      createdAt: timestamp, updatedAt: timestamp, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), failure: null, artifact: null };
      task.state = 'running';
      return Response.json({ claim: { task, lease: { attempt: task.attempt, fence } } });
    }
    if (url.pathname.endsWith('/heartbeat')) return Response.json({ task });
    if (url.pathname.endsWith('/recovery-confirm')) { task.recoveryProviderDeviceId = task.providerDeviceId; return Response.json({ task }); }
    if (url.pathname.endsWith('/complete')) {
      assert.equal(options.headers['Content-Type'], 'application/octet-stream'); assert.equal(options.headers['X-PaperQuay-Remote-Fence'], fence);
      const parsed = await fixtures.core.decodeParsedDocument(new Uint8Array(body)); assert.equal(parsed.document.pdf.sha256, digest(PDF));
      if (loseCompletion) { loseCompletion = false; throw new Error('SYNTHETIC_COMPLETION_RESPONSE_LOSS'); }
      task.state = 'succeeded'; task.artifact = { digest: digest(body), sizeBytes: body.length, mediaType: 'application/json' };
      return Response.json({ task, replayed: false });
    }
    if (url.pathname.endsWith('/fail')) { task.state = body.code === 'EXTERNAL_OUTCOME_UNKNOWN' ? 'interrupted' : 'failed'; task.failure = body.code; return Response.json({ task }); }
  };
  let fence = randomUUID();
  const revisions = beforeRevision ? require('../electron/backend/desktopRemoteTasks.cjs').createCredentialRevisionStore(
    path.join(path.dirname(f.appPaths.configPath), 'account-sync', 'remote-tasks', 'credential-revisions'), { secure }) : null;
  const managerOptions = { core: { ...require('../electron/generated/desktopSyncCore.cjs'), ...fixtures.core }, remoteTasks: {
    secure, manual: true, readConfiguration: async () => structuredClone(config),
    ...(revisions ? { revisions: { update: async (...args) => { await beforeRevision(); return revisions.update(...args); }, devices: (scope) => revisions.devices(scope) } } : {}),
    timings: { guardMs: 5, presenceMs: 100, heartbeatMs: 40, pollMs: 5 },
    createWorker(options) { worker = require('../electron/backend/remoteTaskWorker.cjs').createRemoteTaskWorker(options); return worker; },
    materialize: async ({ task: target }) => Buffer.from(JSON.stringify({ format: 'paperquay-parsed-document', version: 1, paperId: target.target.paperId,
      attachmentVersionId: target.target.attachmentVersionId, pdf: { sha256: digest(PDF), sizeBytes: PDF.length, pageCount: 1 }, parser: { name: 'mineru', model: 'vlm' },
      blocks: [{ id: 'p0', pageIndex: 0, kind: 'text', text: 'Command bridge fixture.' }], assets: [] })),
  } };
  manager = f.create(managerOptions);
  await f.login(manager); await f.publish(manager);
  const enable = () => manager.commands.desktop_remote_tasks_set_enabled({ enabled: true, consent: true, configurationToken: manager.getStatus().remoteTasks.configurationToken });
  return { ...f, get manager() { return manager; }, config, upstream, submitted, closed, enable, worker: () => worker, uploads: () => uploads,
    submissions: () => submissions, task: () => task, loseCompletion: () => { loseCompletion = true; },
    async restartAndReassign() {
      const oldDeviceId = f.service.deviceId;
      manager.close(); await manager.settled(); f.service.deviceId = randomUUID();
      task.providerDeviceId = f.service.deviceId; task.recoveryProviderDeviceId = oldDeviceId; task.attempt++; task.state = 'queued'; task.failure = null;
      claimed = false; fence = randomUUID(); manager = f.create(managerOptions); await f.login(manager, false);
    } };
}

test('remote command bridge stays off until consent, reads selected SQLite mapping bytes and clears only completed journals', async (t) => {
  const f = await remoteFixture(t);
  assert.equal(f.manager.getStatus().enabled, false, 'remote processing does not depend on enabling the separate PDF relay');
  assert.equal(f.manager.getStatus().remoteTasks.enabled, false);
  await assert.rejects(f.manager.commands.desktop_remote_tasks_set_enabled({ enabled: true, consent: true,
    configurationToken: f.manager.getStatus().remoteTasks.configurationToken, pdfPath: '//unapproved.invalid/private.pdf' }), { code: 'DESKTOP_ARGUMENT_INVALID' });
  await f.enable(); assert.equal(f.manager.getStatus().remoteTasks.enabled, true);
  assert.equal(f.manager.getStatus().errorCode, null);
  const result = await f.worker().runOnce(); assert.equal(result.state, 'succeeded', JSON.stringify(result)); assert.equal(f.uploads(), 1);
  const publicBody = f.service.calls.filter((item) => item.url.includes('/v1/remote-tasks/provider') && item.method === 'PUT').map((item) => JSON.stringify(item.body)).join('');
  assert.equal(publicBody.includes('PRIVATE_COMMAND_MINERU_KEY'), false); assert.equal(publicBody.includes(f.upstream.base), false);
  await assert.rejects(f.manager.commands.desktop_remote_tasks_clear_completed({ confirmed: true }), { code: 'REMOTE_WORKER_BUSY' });
  await f.manager.commands.desktop_remote_tasks_set_enabled({ enabled: false });
  assert.equal((await f.manager.commands.desktop_remote_tasks_clear_completed({ confirmed: true })).removed, 1);
  assert.deepEqual(fs.readFileSync(f.attachment.storedPath), PDF); assert.equal(f.task().state, 'succeeded');
});
for (const change of ['sign-out', 'unbind', 'configuration']) {
  test(`remote command bridge aborts the actual submission and withdraws scoped presence on ${change}`, async (t) => {
    const f = await remoteFixture(t, { blockSubmission: true }); await f.enable(); const active = f.worker().runOnce(); await f.submitted.promise;
    if (change === 'sign-out') await f.manager.commands.desktop_account_sign_out();
    else if (change === 'unbind') await f.manager.commands.desktop_provider_unbind({ bindingId: f.manager.getStatus().bindings[0].bindingId });
    else { const changed = structuredClone(f.config); changed.secrets.mineruApiToken = 'NEW_PRIVATE_KEY'; await f.manager.configurationWillChange(JSON.stringify(changed)); }
    await active; await f.closed.promise; await f.manager.settled();
    assert.equal(f.manager.getStatus().remoteTasks.enabled, false);
    assert.ok(f.service.calls.some((item) => item.method === 'DELETE' && item.url === CONFIG.apiBaseUrl + '/v1/remote-tasks/provider'));
    assert.deepEqual(fs.readFileSync(f.attachment.storedPath), PDF);
  });
}
test('new desktop sid explicitly reassigns a received artifact with stable private credentials and no new upstream submission', async (t) => {
  const f = await remoteFixture(t); await f.enable(); f.loseCompletion();
  assert.equal((await f.worker().runOnce()).state, 'interrupted'); assert.equal(f.submissions(), 1);
  await f.restartAndReassign(); assert.equal(f.manager.getStatus().remoteTasks.enabled, false);
  await f.enable(); assert.equal((await f.worker().runOnce()).state, 'succeeded');
  assert.equal(f.submissions(), 1); assert.equal(f.uploads(), 1);
  await f.manager.commands.desktop_remote_tasks_set_enabled({ enabled: false });
  assert.equal((await f.manager.commands.desktop_remote_tasks_clear_completed({ confirmed: true })).removed, 2, 'both confirmed copies are clearable across private session history');
});
test('new desktop sid preserves an unknown submission and refuses a fresh paid request', async (t) => {
  const f = await remoteFixture(t, { blockSubmission: true }); await f.enable();
  const active = f.worker().runOnce(); await f.submitted.promise; await f.manager.commands.desktop_remote_tasks_set_enabled({ enabled: false });
  await active; await f.closed.promise; await f.restartAndReassign(); await f.enable();
  assert.equal((await f.worker().runOnce()).errorCode, 'EXTERNAL_OUTCOME_UNKNOWN'); assert.equal(f.submissions(), 1);
});
test('shutdown retains the real profile writer lock until an in-flight private credential revision finishes', async (t) => {
  const entered = deferred(), release = deferred(); let block = false;
  const f = await remoteFixture(t, { beforeRevision: async () => { if (block) { entered.resolve(); await release.promise; } } });
  const old = f.manager; f.config.secrets.mineruApiToken = 'CHANGED_PRIVATE_KEY'; block = true;
  const refresh = old.configurationDidChange(); await entered.promise; old.close();
  let second;
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fixtures = await import('./remoteTaskFixtures.mjs'); second = f.create({ core: { ...require('../electron/generated/desktopSyncCore.cjs'), ...fixtures.core } });
    await second.commands.desktop_account_sign_in(); await second.settled();
    assert.equal(second.getStatus().errorCode, 'DESKTOP_ACCOUNT_IN_USE'); assert.equal(second.getStatus().account, null);
  } finally { release.resolve(); }
  await refresh; await old.settled(); await second.commands.desktop_account_sign_in(); await second.settled();
  assert.equal(second.getStatus().auth.status, 'signed-in');
});
test('remote processing honors cloud-egress approval for only the explicitly selected attachment', async (t) => {
  const f = await remoteFixture(t); let checked = 0;
  f.context.authorizeCloudParsePath = async (library, source) => {
    checked++; assert.equal(source, f.attachment.storedPath); assert.equal(library.papers.length, 1);
    assert.equal(library.papers[0].attachments.length, 1); assert.equal(library.papers[0].attachments[0].id, f.attachment.id);
    throw new Error('SYNTHETIC_CLOUD_APPROVAL_DENIED');
  };
  await f.enable(); assert.equal((await f.worker().runOnce()).errorCode, 'DESKTOP_SOURCE_NOT_APPROVED');
  assert.equal(checked, 1); assert.equal(f.submissions(), 0); assert.equal(f.uploads(), 0);
});

test('parsed export derives its source and account IDs from the current binding and forwards only the native event', async (t) => {
  const f = await fixture(t); let prepared = 0, saved = 0;
  const nativeEvent = { sender: 'synthetic-native-sender' };
  const manager = f.create({ parsedDocumentExporter: {
    async prepare(input) {
      prepared++; input.check(); assert.deepEqual(input.bytes, PDF);
      const binding = manager.getStatus().bindings[0];
      assert.equal(input.binding.paperId, binding.paperId);
      assert.equal(input.binding.attachmentVersionId, binding.attachmentVersionId);
      assert.equal(input.expectedPageCount, null);
      return { bytes: Buffer.from('{}') };
    },
    async save(_prepared, input) {
      saved++; assert.equal(input.event, nativeEvent); await input.beforeWrite(); input.check();
      return { status: 'exported', blockCount: 1, assetCount: 0 };
    },
  } });
  await f.login(manager); await f.publish(manager);
  const result = await manager.commands.desktop_provider_export_parsed({ bindingId: manager.getStatus().bindings[0].bindingId,
    pdfPath: '//unapproved.invalid/share/private.pdf', paperId: randomUUID() }, nativeEvent);
  assert.deepEqual(result, { status: 'exported', blockCount: 1, assetCount: 0 });
  assert.equal(prepared, 1); assert.equal(saved, 1);
  await assert.rejects(manager.commands.desktop_provider_export_parsed({ bindingId: randomUUID() }), { code: 'DESKTOP_BINDING_NOT_FOUND' });
  assert.equal(prepared, 1);
});

for (const change of ['sign-out', 'remove-binding', 'replace-PDF']) {
  test(`parsed export rechecks ${change} after the save picker and cannot write a retired source`, async (t) => {
    const f = await fixture(t); let beforeWriteReturned = false;
    const manager = f.create({ parsedDocumentExporter: {
      async prepare(input) { input.check(); return {}; },
      async save(_prepared, input) {
        if (change === 'sign-out') await manager.commands.desktop_account_sign_out();
        else if (change === 'remove-binding') await manager.commands.desktop_provider_unbind({ bindingId: manager.getStatus().bindings[0].bindingId });
        else fs.writeFileSync(f.attachment.storedPath, Buffer.concat([PDF, Buffer.from('replaced')]));
        await input.beforeWrite(); beforeWriteReturned = true;
        return { status: 'exported' };
      },
    } });
    await f.login(manager); await f.publish(manager);
    await assert.rejects(manager.commands.desktop_provider_export_parsed({ bindingId: manager.getStatus().bindings[0].bindingId }),
      { code: change === 'replace-PDF' ? 'DESKTOP_SOURCE_CHANGED' : 'DESKTOP_OPERATION_CANCELLED' });
    assert.equal(beforeWriteReturned, false);
  });
}

test('a missing or invalid parse proof reports a fixed code before opening a save picker', async (t) => {
  const f = await fixture(t); let pickerOpened = false;
  const manager = f.create({ parsedDocumentExporter: {
    async prepare() { throw Object.assign(new Error('private path must not escape'), { code: 'DESKTOP_PARSED_REPARSE_REQUIRED' }); },
    async save() { pickerOpened = true; },
  } });
  await f.login(manager); await f.publish(manager);
  await assert.rejects(manager.commands.desktop_provider_export_parsed({ bindingId: manager.getStatus().bindings[0].bindingId }),
    { code: 'DESKTOP_PARSED_REPARSE_REQUIRED', message: 'DESKTOP_PARSED_REPARSE_REQUIRED' });
  assert.equal(pickerOpened, false);
});
function fakeAuth() {
  let snapshot = { status: 'signed-out' }; const listeners = new Set();
  const publish = (next) => { snapshot = next; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => ({ ...snapshot }), subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async signIn() { publish({ status: 'signed-in', displayName: 'Reader', expiresAt: Date.now() + 3600000 }); },
    async getAccessToken(signal) { if (signal?.aborted) throw Object.assign(new Error('AUTH_CANCELLED'), { code: 'AUTH_CANCELLED' }); return 'synthetic-access-token'; },
    cancelSignIn() { publish({ status: 'signed-out' }); }, async signOut() { publish({ status: 'signed-out' }); },
    close() { publish({ status: 'signed-out' }); }, publish,
  };
}
function fakeService() {
  const records = new Map(), receipts = new Map(), calls = [], requests = [], uploads = [], unavailable = [];
  const service = { accountId: randomUUID(), deviceId: randomUUID(), records, receipts, calls, requests, uploads, unavailable,
    feature: true, loseAfter: null, rejectType: null, onPush: null, onRoute: null, polls: 0, stopped: 0 };
  service.target = (id) => {
    const version = records.get(id), paper = version && records.get(version.data?.paperId);
    if (!version || version.deletedAt || !paper || paper.deletedAt) return null;
    return { paper: { entityId: paper.entityId, revision: paper.revision, title: paper.data.title },
      version: { entityId: version.entityId, revision: version.revision, data: structuredClone(version.data) } };
  };
  service.fetch = async (input, options = {}) => {
    const url = new URL(input), body = options.body && options.headers?.['Content-Type'] === 'application/json' ? JSON.parse(options.body) : options.body;
    calls.push({ url: url.href, method: options.method, body });
    const intercepted = await service.onRoute?.(url, options, body);
    if (intercepted) return intercepted;
    if (url.pathname === '/v1/devices' && options.method === 'POST') return Response.json({ accountId: service.accountId,
      device: { id: service.deviceId, name: body.name, platform: body.platform, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null } });
    if (url.pathname === '/v1/capabilities') return Response.json({ protocolVersion: 1, features: service.feature ? { desktopPdfTransfer: 1 } : {},
      ...(service.feature ? { desktopPdf: { transport: 'http-relay-v1', maxFileBytes: 67108864, requestTtlMs: 30000, pollTimeoutMs: 20000,
        byteWindowMs: 900000, accountWindowBytes: 268435456, processWindowBytes: 1073741824,
        ...(service.direct === undefined ? {} : { direct: service.direct }) } } : {}) });
    if (url.pathname === '/v1/sync/push') {
      service.onPush?.(body);
      const results = body.operations.map((operation) => {
        const receipt = receipts.get(operation.opId);
        if (receipt) { assert.deepEqual(receipt.operation, operation); return { ...receipt.result, replayed: true }; }
        if (service.rejectType === operation.entityType) {
          const result = { opId: operation.opId, status: 'rejected', replayed: false, code: 'ACCOUNT_ENTITY_LIMIT', retryable: false };
          receipts.set(operation.opId, { operation: structuredClone(operation), result }); return result;
        }
        const record = { entityType: operation.entityType, entityId: operation.entityId, schemaVersion: 1, revision: 1, deletedAt: null,
          updatedAt: new Date().toISOString(), modifiedByDeviceId: service.deviceId, data: structuredClone(operation.data) };
        records.set(record.entityId, record);
        const result = { opId: operation.opId, status: 'applied', replayed: false, record };
        receipts.set(operation.opId, { operation: structuredClone(operation), result }); return result;
      });
      if (service.loseAfter === body.operations[0].entityType) { service.loseAfter = null; throw new Error('sensitive transport error must not escape'); }
      return Response.json({ protocolVersion: 1, results });
    }
    if (url.pathname === '/v1/desktop-pdfs/versions') {
      const items = [...records.values()].filter((record) => record.entityType === 'attachmentVersion').map((record) => service.target(record.entityId)).filter(Boolean);
      return Response.json({ items, nextAfter: null, hasMore: false });
    }
    if (url.pathname.startsWith('/v1/desktop-pdfs/versions/')) {
      const target = service.target(url.pathname.split('/').at(-1));
      return target ? Response.json(target) : Response.json({ error: { code: 'ATTACHMENT_VERSION_UNAVAILABLE' } }, { status: 410 });
    }
    if (url.pathname === '/v1/desktop-pdfs/provider/poll') {
      service.polls++;
      if (requests.length) return Response.json({ request: requests.shift() });
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error('aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    if (url.pathname === '/v1/desktop-pdfs/provider' && options.method === 'DELETE') { service.stopped++; return Response.json({ stopped: true }); }
    if (url.pathname.endsWith('/content')) {
      assert.equal(options.headers['Content-Type'], 'application/pdf'); assert.equal(options.headers['Content-Length'], String(body.length));
      uploads.push(Buffer.from(body)); return Response.json({ sent: true });
    }
    if (url.pathname.endsWith('/unavailable')) { unavailable.push(url.pathname); return Response.json({ acknowledged: true }); }
    assert.fail(`Unexpected fixture route: ${url.pathname}`);
  };
  return service;
}
async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-desktop-account-')));
  const profile = path.join(root, 'profile'), libraryRoot = path.join(root, 'library');
  fs.mkdirSync(profile); fs.mkdirSync(libraryRoot);
  const appPaths = createAppPaths({ getPath: () => profile }, libraryRoot), store = createLibraryStore(appPaths), managers = [];
  t.after(async () => {
    for (const item of managers) item.close();
    for (const item of managers) await item.settled();
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const access = createSourceAccess({ showMessageBox: () => { throw new Error('Unexpected native source prompt'); } });
  const context = { appPaths, store, approveImportSources: access.authorize,
    authorizeLocalProbe: (file) => resolveAuthorizedPath(file, (candidate) => isWithin(libraryRoot, candidate)) };
  const imports = createLibraryCommands(context), input = path.join(root, 'import.pdf'); fs.writeFileSync(input, PDF); access.rememberPicked([input]);
  const imported = await imports.library_import_pdfs({ request: { paths: [input], metadata: { [input]: { title: 'An explicitly selected paper', authors: ['Researcher'] } } } });
  assert.equal(imported[0].status, 'imported', imported[0].message);
  const paper = imported[0].paper, attachment = paper.attachments[0], service = fakeService();
  const create = (extra = {}) => {
    const auth = extra.auth || fakeAuth();
    const manager = createDesktopAccountCommands(context, { auth, fetch: service.fetch, ...extra }); managers.push(manager); return manager;
  };
  const manager = create();
  const login = async (target = manager, configure = true) => {
    if (configure) await target.commands.desktop_account_configure({ config: CONFIG });
    await target.commands.desktop_account_sign_in(); await target.settled();
    assert.equal(target.getStatus().auth.status, 'signed-in', JSON.stringify(target.getStatus()));
    assert.equal(target.getStatus().account.accountId, service.accountId);
  };
  const publish = (target = manager) => target.commands.desktop_provider_publish({ localPaperId: paper.id, localAttachmentId: attachment.id });
  const privateState = () => {
    const dir = path.join(profile, 'PaperQuay', '.settings', 'account-sync', 'accounts');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    return { dir, files, documents: files.map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) };
  };
  return { root, profile, libraryRoot, appPaths, store, context, paper, attachment, service, manager, create, login, publish, privateState, imports, access };
}

test('service capability extensions do not block login or escape the validated desktop projection', async (t) => {
  const f = await fixture(t); await f.login();
  assert.deepEqual(f.manager.getStatus().capability, {
    transport: 'http-relay-v1', maxFileBytes: 67108864, requestTtlMs: 30000, pollTimeoutMs: 20000,
  });
  await f.publish();
  await f.manager.commands.desktop_provider_set_enabled({ enabled: true });
  assert.equal(f.manager.getStatus().enabled, true);
  assert.deepEqual(Object.keys(f.manager.getStatus().capability).sort(), ['maxFileBytes', 'pollTimeoutMs', 'requestTtlMs', 'transport']);
});

test('direct capability is validated, projected and opted in while window shutdown stops the helper', async (t) => {
  const f = await fixture(t); let closed = 0;
  const manager = f.create({ peerHost: { close: async () => { closed++; }, settled: async () => {} } });
  const expected = { transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls: ['stun:relay-independent.test:3478'] };
  f.service.direct = { ...expected, privateServerExtension: 'do not expose' };
  await f.login(manager); assert.deepEqual(manager.getStatus().capability.direct, expected);
  const returned = manager.getStatus(); returned.capability.direct.stunUrls.push('turn:untrusted.test');
  assert.deepEqual(manager.getStatus().capability.direct, expected);
  await f.publish(manager); await manager.commands.desktop_provider_set_enabled({ enabled: true });
  await until(() => f.service.polls === 1);
  assert.deepEqual(f.service.calls.find((call) => call.url.endsWith('/provider/poll')).body, { direct: true });
  const before = closed; const stopping = manager.stopProvider();
  assert.equal(manager.getStatus().enabled, false); assert.equal(closed, before + 1);
  await stopping;
});

test('TURN or credential-bearing direct capability cannot start an account provider', async (t) => {
  for (const stunUrls of [['turn:example.test:3478'], ['stun:user:secret@example.test:3478']]) {
    await t.test(stunUrls[0].startsWith('turn:') ? 'TURN rejected' : 'credentials rejected', async (child) => {
      const f = await fixture(child);
      f.service.direct = { transport: 'webrtc-data-v1', attemptMs: 6000, maxSdpBytes: 32768, stunUrls };
      await f.manager.commands.desktop_account_configure({ config: CONFIG });
      await f.manager.commands.desktop_account_sign_in(); await f.manager.settled();
      assert.equal(f.manager.getStatus().account, null); assert.equal(f.manager.getStatus().errorCode, 'DESKTOP_INVALID_RESPONSE');
      assert.equal(f.manager.getStatus().enabled, false); assert.equal(f.service.polls, 0);
    });
  }
});

test('same-tick sign in commands share startup and register exactly one live device', async (t) => {
  const f = await fixture(t); await f.manager.commands.desktop_account_configure({ config: CONFIG });
  await Promise.all([f.manager.commands.desktop_account_sign_in(), f.manager.commands.desktop_account_sign_in()]);
  await f.manager.settled();
  const status = f.manager.getStatus();
  assert.equal(status.auth.status, 'signed-in'); assert.equal(status.account.accountId, f.service.accountId);
  assert.equal(status.errorCode, null); assert.equal(status.busy, false);
  assert.equal(f.service.calls.filter((call) => call.url.endsWith('/v1/devices')).length, 1);
});

test('cancelling during sign in startup cannot register a device after cleanup completes', async (t) => {
  const f = await fixture(t), auth = fakeAuth(), manager = f.create({ auth });
  await manager.commands.desktop_account_configure({ config: CONFIG });
  const entered = deferred(), release = deferred(), originalSignOut = auth.signOut; let delayOnce = true;
  auth.signOut = async () => {
    await originalSignOut();
    if (delayOnce) { delayOnce = false; entered.resolve(); await release.promise; }
  };
  const starting = manager.commands.desktop_account_sign_in();
  const cancelled = assert.rejects(starting, { code: 'DESKTOP_OPERATION_CANCELLED' });
  await entered.promise; await manager.commands.desktop_account_cancel_sign_in();
  release.resolve(); await cancelled; await manager.settled();
  assert.equal(manager.getStatus().auth.status, 'signed-out'); assert.equal(manager.getStatus().account, null);
  assert.equal(manager.getStatus().busy, false);
  assert.equal(f.service.calls.filter((call) => call.url.endsWith('/v1/devices')).length, 0);
});

test('real imported SQLite attachment publishes only selected metadata with durable IDs before every push', async (t) => {
  const f = await fixture(t); await f.login();
  const candidates = await f.manager.commands.desktop_provider_candidates();
  assert.equal(candidates.items.length, 1); assert.equal(candidates.items[0].localAttachmentId, f.attachment.id);
  f.service.onPush = (request) => {
    const saved = f.privateState().documents[0].libraries[0];
    assert.equal(saved.bindings.length, 1);
    const sent = saved.syncState.outbox.find((entry) => entry.operation.opId === request.operations[0].opId);
    assert.equal(sent.status, 'sending'); assert.deepEqual(sent.operation, request.operations[0]);
  };
  const [first, second] = await Promise.all([f.publish(), f.publish()]);
  assert.equal(first.bindings.length, 1); assert.deepEqual(first.bindings, second.bindings);
  assert.equal(first.bindings[0].publicationStatus, 'published'); assert.equal(first.enabled, false);
  const pushes = f.service.calls.filter((call) => call.url.endsWith('/v1/sync/push'));
  assert.deepEqual(pushes.map((call) => call.body.operations[0].entityType), ['paper', 'attachmentVersion']);
  assert.equal(f.service.records.size, 2);
  assert.doesNotMatch(JSON.stringify(pushes), /storedPath|originalPath|dataDirectory|synthetic-access-token/);
  assert.equal(f.store.load().papers.length, 1); assert.equal(f.store.load().papers[0].id, f.paper.id);
  assert.doesNotMatch(JSON.stringify(f.privateState().documents), /synthetic-access-token|refresh_token/);
});

test('lost version acknowledgement resumes the exact operation after restart and a new session', async (t) => {
  const f = await fixture(t); await f.login(); f.service.loseAfter = 'attachmentVersion';
  await assert.rejects(f.publish(), { code: 'NETWORK_UNAVAILABLE' });
  const original = f.manager.getStatus().bindings[0]; assert.equal(original.publicationStatus, 'pending-version');
  const requests = f.service.calls.filter((call) => call.url.endsWith('/v1/sync/push'));
  const versionOperation = requests.at(-1).body.operations[0];
  f.manager.close(); await f.manager.settled();
  f.service.deviceId = randomUUID(); const restarted = f.create(); await f.login(restarted, false);
  assert.equal(restarted.getStatus().enabled, false); assert.equal(restarted.getStatus().bindings[0].bindingId, original.bindingId);
  await restarted.commands.desktop_provider_retry({ bindingId: original.bindingId });
  assert.equal(restarted.getStatus().bindings[0].publicationStatus, 'published'); assert.equal(f.service.records.size, 2);
  const retried = f.service.calls.filter((call) => call.url.endsWith('/v1/sync/push')).at(-1).body;
  assert.deepEqual(retried.operations[0], versionOperation); assert.equal(retried.deviceId, f.service.deviceId);
});

test('paper acknowledgement survives version rejection and retry never creates a replacement ID', async (t) => {
  const f = await fixture(t); await f.login(); f.service.rejectType = 'attachmentVersion';
  await assert.rejects(f.publish(), { code: 'DESKTOP_PUBLICATION_BLOCKED' });
  const previous = f.manager.getStatus().bindings[0]; assert.equal(previous.publicationStatus, 'blocked');
  const count = f.service.calls.filter((call) => call.url.endsWith('/v1/sync/push')).length;
  await assert.rejects(f.manager.commands.desktop_provider_retry({ bindingId: previous.bindingId }), { code: 'DESKTOP_PUBLICATION_BLOCKED' });
  assert.equal(f.service.calls.filter((call) => call.url.endsWith('/v1/sync/push')).length, count);
  assert.equal(f.manager.getStatus().bindings[0].attachmentVersionId, previous.attachmentVersionId);
  assert.equal(f.service.records.size, 1);
});

test('explicit re-publication creates a new verified version without overwriting the published paper', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish();
  const old = f.manager.getStatus().bindings[0]; const publishedPaper = f.service.records.get(old.paperId);
  publishedPaper.data.title = 'Edited on phone'; publishedPaper.revision = 2;
  const replacement = Buffer.from('%PDF-1.7\na new immutable file version\n%%EOF\n'); fs.writeFileSync(f.attachment.storedPath, replacement);
  await f.publish(); const bindings = f.manager.getStatus().bindings;
  assert.equal(bindings.length, 2); assert.notEqual(bindings[1].attachmentVersionId, old.attachmentVersionId);
  assert.equal(bindings[1].paperId, old.paperId); assert.equal(bindings[1].sha256, digest(replacement));
  assert.equal(f.service.records.get(old.paperId).data.title, 'Edited on phone');
  assert.equal(f.service.records.size, 3);
});

test('another account receives an empty mapping and cannot inherit previously provided files', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish();
  const old = f.manager.getStatus().bindings[0]; await f.manager.commands.desktop_account_sign_out();
  f.service.accountId = randomUUID(); f.service.deviceId = randomUUID(); await f.login(f.manager, false);
  assert.deepEqual(f.manager.getStatus().bindings, []); assert.equal(f.manager.getStatus().enabled, false);
  await assert.rejects(f.manager.commands.desktop_provider_retry({ bindingId: old.bindingId }), { code: 'DESKTOP_BINDING_NOT_FOUND' });
  assert.equal(f.privateState().documents.length, 2);
});

test('existing remote version binds explicitly without issuing a sync mutation', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish(); const initial = f.manager.getStatus().bindings[0];
  await f.manager.commands.desktop_provider_unbind({ bindingId: initial.bindingId });
  const pushes = f.service.calls.filter((call) => call.url.endsWith('/v1/sync/push')).length;
  await f.manager.commands.desktop_provider_bind({ localPaperId: f.paper.id, localAttachmentId: f.attachment.id, attachmentVersionId: initial.attachmentVersionId });
  assert.equal(f.manager.getStatus().bindings[0].publicationStatus, 'published');
  assert.equal(f.service.calls.filter((call) => call.url.endsWith('/v1/sync/push')).length, pushes);
  const versions = await f.manager.commands.desktop_provider_remote_versions(); assert.equal(versions.items.length, 1);
  assert.doesNotMatch(JSON.stringify(versions), /storedPath|dataDirectory/);
});

test('read and raw relay upload use the actual imported bytes only after explicit enable', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish(); const binding = f.manager.getStatus().bindings[0];
  assert.equal(f.service.polls, 0);
  f.service.requests.push({ requestId: randomUUID(), attachmentVersionId: binding.attachmentVersionId,
    sha256: binding.sha256, sizeBytes: binding.sizeBytes, expiresAt: new Date(Date.now() + 30000).toISOString() });
  await f.manager.commands.desktop_provider_set_enabled({ enabled: true });
  await until(() => f.service.uploads.length === 1);
  assert.deepEqual(f.service.uploads[0], PDF);
  await f.manager.commands.desktop_provider_set_enabled({ enabled: false });
  assert.equal(f.manager.getStatus().enabled, false); assert.ok(f.service.stopped >= 1);
});

test('same-path source replacement is unavailable and never uploads replacement bytes', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish(); const binding = f.manager.getStatus().bindings[0];
  const replacement = Buffer.from(PDF); replacement[20] ^= 1; fs.writeFileSync(f.attachment.storedPath, replacement);
  f.service.requests.push({ requestId: randomUUID(), attachmentVersionId: binding.attachmentVersionId,
    sha256: binding.sha256, sizeBytes: binding.sizeBytes, expiresAt: new Date(Date.now() + 30000).toISOString() });
  await f.manager.commands.desktop_provider_set_enabled({ enabled: true });
  await until(() => f.service.unavailable.length === 1);
  assert.equal(f.service.uploads.length, 0); assert.equal(f.manager.getStatus().bindings[0].publicationStatus, 'source-changed');
});

test('cancel during native read discards a late result and retains the transfer slot until the read ends', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish(); const binding = f.manager.getStatus().bindings[0];
  const original = nativeFs.openRead, opened = deferred(), release = deferred(); let intercepted = false;
  nativeFs.openRead = async (...args) => {
    if (!intercepted && args[0] === f.attachment.storedPath) { intercepted = true; opened.resolve(); await release.promise; }
    return original(...args);
  };
  t.after(() => { nativeFs.openRead = original; release.resolve(); });
  const requestId = randomUUID();
  f.service.requests.push({ requestId, attachmentVersionId: binding.attachmentVersionId, sha256: binding.sha256,
    sizeBytes: binding.sizeBytes, expiresAt: new Date(Date.now() + 30000).toISOString() });
  await f.manager.commands.desktop_provider_set_enabled({ enabled: true }); await opened.promise;
  await f.manager.commands.desktop_provider_cancel({ transferId: requestId });
  assert.equal(f.manager.getStatus().transfers.length, 1); assert.equal(f.service.polls, 1);
  release.resolve(); await until(() => f.manager.getStatus().transfers.length === 0);
  assert.equal(f.service.uploads.length, 0);
});

test('revoked provider session disables the provider and clears the live account', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish();
  f.service.onRoute = (url) => url.pathname.endsWith('/provider/poll') ? Response.json({ error: { code: 'SESSION_REVOKED' } }, { status: 403 }) : null;
  await f.manager.commands.desktop_provider_set_enabled({ enabled: true });
  await until(() => f.manager.getStatus().account === null);
  assert.equal(f.manager.getStatus().enabled, false); assert.equal(f.manager.getStatus().bindings.length, 0);
});

test('profile scoped writer lock prevents two desktop instances overwriting mappings', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish();
  const second = f.create(); await second.commands.desktop_account_sign_in(); await second.settled();
  assert.equal(second.getStatus().account, null); assert.equal(second.getStatus().errorCode, 'DESKTOP_ACCOUNT_IN_USE');
  assert.equal(f.manager.getStatus().bindings.length, 1);
});

test('disabled service feature and invalid config do not start a provider', async (t) => {
  const f = await fixture(t); f.service.feature = false; await f.login();
  assert.equal(f.manager.getStatus().capability, null);
  await assert.rejects(f.publish(), { code: 'DESKTOP_FEATURE_UNAVAILABLE' });
  await assert.rejects(f.manager.commands.desktop_account_configure({ config: { ...CONFIG, oidcClientId: 'bad client' } }), { code: 'DESKTOP_CONFIG_INVALID' });
  await assert.rejects(f.manager.commands.desktop_account_configure({ config: { ...CONFIG, apiBaseUrl: 'http://remote.example' } }), { code: 'DESKTOP_CONFIG_INVALID' });
  assert.equal(f.service.polls, 0); assert.equal(f.service.records.size, 0);
});

test('a failed durable publication write sends no mutation and leaves the persisted mapping intact', async (t) => {
  const f = await fixture(t); await f.login();
  const before = f.privateState().documents, originalWrite = nativeFs.write;
  nativeFs.write = async (file, bytes, options) => {
    if (file.includes(`${path.sep}accounts${path.sep}`) && file.endsWith('.json') && JSON.parse(bytes).libraries.some((library) => library.bindings.length)) {
      throw Object.assign(new Error('sensitive file location and disk error'), { code: 'ENOSPC' });
    }
    return originalWrite(file, bytes, options);
  };
  t.after(() => { nativeFs.write = originalWrite; });
  await assert.rejects(f.publish(), { code: 'DESKTOP_STORAGE_UNAVAILABLE' });
  assert.equal(f.service.records.size, 0); assert.equal(f.manager.getStatus().bindings.length, 0);
  assert.deepEqual(f.privateState().documents, before);
  assert.doesNotMatch(JSON.stringify(f.manager.getStatus()), /sensitive|storedPath|dataDirectory/);
});

test('replacing the library database disables access even at the same canonical pathname', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish();
  f.store.close(); fs.renameSync(f.appPaths.libraryDatabasePath, f.appPaths.libraryDatabasePath + '.original');
  fs.writeFileSync(f.appPaths.libraryDatabasePath, 'replacement library file');
  await assert.rejects(f.publish(), { code: 'DESKTOP_LIBRARY_CHANGED' });
  await assert.rejects(f.manager.commands.desktop_provider_set_enabled({ enabled: true }), { code: 'DESKTOP_LIBRARY_CHANGED' });
  assert.equal(f.service.records.size, 2); assert.equal(f.service.polls, 0);
});

test('unknown remote versions and renderer-supplied paths never open a native file', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish();
  const original = nativeFs.openRead; let reads = 0;
  nativeFs.openRead = (...args) => { reads++; return original(...args); };
  t.after(() => { nativeFs.openRead = original; });
  await assert.rejects(f.manager.commands.desktop_provider_publish({ localPaperId: f.paper.id, localAttachmentId: f.attachment.id,
    path: '\\\\unapproved.invalid\\share\\secret.pdf' }), { code: 'DESKTOP_ARGUMENT_INVALID' });
  f.service.requests.push({ requestId: randomUUID(), attachmentVersionId: randomUUID(), sha256: digest(PDF),
    sizeBytes: PDF.length, expiresAt: new Date(Date.now() + 30000).toISOString() });
  await f.manager.commands.desktop_provider_set_enabled({ enabled: true });
  await until(() => f.service.unavailable.length === 1);
  assert.equal(reads, 0); assert.equal(f.service.uploads.length, 0);
});

test('unbind during a native open cancels that binding without deleting published entities', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish(); const binding = f.manager.getStatus().bindings[0];
  const original = nativeFs.openRead, entered = deferred(), release = deferred(); let intercepted = false;
  nativeFs.openRead = async (...args) => {
    if (!intercepted && args[0] === f.attachment.storedPath) { intercepted = true; entered.resolve(); await release.promise; }
    return original(...args);
  };
  t.after(() => { nativeFs.openRead = original; release.resolve(); });
  f.service.requests.push({ requestId: randomUUID(), attachmentVersionId: binding.attachmentVersionId, sha256: binding.sha256,
    sizeBytes: binding.sizeBytes, expiresAt: new Date(Date.now() + 30000).toISOString() });
  await f.manager.commands.desktop_provider_set_enabled({ enabled: true }); await entered.promise;
  await f.manager.commands.desktop_provider_unbind({ bindingId: binding.bindingId });
  assert.equal(f.manager.getStatus().bindings.length, 0); assert.equal(f.service.records.size, 2);
  release.resolve(); await until(() => f.manager.getStatus().transfers.length === 0);
  assert.equal(f.service.uploads.length, 0);
});

test('sign out clears visible identity before a cancelled native open can finish', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish(); const binding = f.manager.getStatus().bindings[0];
  const original = nativeFs.openRead, entered = deferred(), release = deferred(); let intercepted = false;
  nativeFs.openRead = async (...args) => {
    if (!intercepted && args[0] === f.attachment.storedPath) { intercepted = true; entered.resolve(); await release.promise; }
    return original(...args);
  };
  t.after(() => { nativeFs.openRead = original; release.resolve(); });
  f.service.requests.push({ requestId: randomUUID(), attachmentVersionId: binding.attachmentVersionId, sha256: binding.sha256,
    sizeBytes: binding.sizeBytes, expiresAt: new Date(Date.now() + 30000).toISOString() });
  await f.manager.commands.desktop_provider_set_enabled({ enabled: true }); await entered.promise;
  const status = await f.manager.commands.desktop_account_sign_out();
  assert.equal(status.account, null); assert.equal(status.auth.status, 'signed-out'); assert.equal(status.enabled, false);
  assert.equal(status.transfers.length, 1, 'the old native operation still owns its slot');
  release.resolve(); await until(() => f.manager.getStatus().transfers.length === 0);
  assert.equal(f.service.uploads.length, 0); assert.equal(f.manager.getStatus().account, null);
});

test('a late capability response cannot reverse a newer disable action', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish();
  const entered = deferred(), release = deferred();
  f.service.onRoute = async (url) => { if (url.pathname === '/v1/capabilities') { entered.resolve(); await release.promise; } return null; };
  const enabling = f.manager.commands.desktop_provider_set_enabled({ enabled: true });
  const rejected = assert.rejects(enabling, { code: 'DESKTOP_OPERATION_CANCELLED' });
  await entered.promise; await f.manager.commands.desktop_provider_set_enabled({ enabled: false });
  release.resolve(); await rejected;
  assert.equal(f.manager.getStatus().enabled, false); assert.equal(f.service.polls, 0);
});

test('an expiring token that cannot cover the request never starts a native read or body upload', async (t) => {
  const f = await fixture(t); const auth = fakeAuth(), manager = f.create({ auth }); await f.login(manager); await f.publish(manager);
  const binding = manager.getStatus().bindings[0];
  f.service.requests.push({ requestId: randomUUID(), attachmentVersionId: binding.attachmentVersionId, sha256: binding.sha256,
    sizeBytes: binding.sizeBytes, expiresAt: new Date(Date.now() + 30000).toISOString() });
  const original = nativeFs.openRead; let reads = 0;
  nativeFs.openRead = (...args) => { reads++; return original(...args); };
  t.after(() => { nativeFs.openRead = original; });
  f.service.onRoute = (url) => { if (url.pathname.endsWith('/provider/poll')) auth.publish({ status: 'signed-in', expiresAt: Date.now() + 5000 }); return null; };
  await manager.commands.desktop_provider_set_enabled({ enabled: true });
  await until(() => manager.getStatus().account === null);
  assert.equal(reads, 0); assert.equal(f.service.uploads.length, 0); assert.equal(manager.getStatus().enabled, false);
});

test('a corrupted or foreign-account private mapping is preserved and never adopted', async (t) => {
  const f = await fixture(t); await f.login(); await f.publish(); f.manager.close(); await f.manager.settled();
  const saved = f.privateState(), file = path.join(saved.dir, saved.files[0]), foreign = saved.documents[0]; foreign.accountId = randomUUID();
  fs.writeFileSync(file, JSON.stringify(foreign)); const before = fs.readFileSync(file, 'utf8');
  const next = f.create(); await next.commands.desktop_account_sign_in(); await next.settled();
  assert.equal(next.getStatus().account, null); assert.equal(next.getStatus().errorCode, 'DESKTOP_STORAGE_INVALID');
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(f.service.records.size, 2);
});

async function modelCommandFixture(t,{showSaveDialog}={}){
 const f=await fixture(t),core=require('../electron/generated/desktopSyncCore.cjs'),{MODEL_INFERENCE_CAPABILITY}=await import('../server/src/model-inference.ts'),secure={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'fixture-vault',encryptString:s=>Buffer.from(Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(b.toString(),'base64').toString()},configuration={secrets:{qaModelPresets:[{id:'selected-chat',label:'Selected chat',baseUrl:'https://private-model.fixture.test/v1',model:'synthetic-chat',apiKey:'PRIVATE_MODEL_COMMAND_KEY',apiMode:'chat_completions'}]}};
 let worker,profiles=[],claim=null,saved=null,modelCalls=0,claimed=false;
 f.service.onRoute=async(url,options,body)=>{
  if(url.pathname==='/v1/capabilities')return Response.json({protocolVersion:1,features:{modelInference:1},modelInference:MODEL_INFERENCE_CAPABILITY});
  if(url.origin==='https://private-model.fixture.test'){modelCalls++;assert.equal(options.headers.Authorization,'Bearer PRIVATE_MODEL_COMMAND_KEY');return Response.json({choices:[{index:0,message:{role:'assistant',content:'Known synthetic answer PRIVATE_MODEL_COMMAND_KEY'},finish_reason:'stop'}]});}
  if(url.pathname==='/v1/model-inference/provider'){if(options.method==='PUT')profiles=body.profiles;return Response.json({disabled:true});}
  if(url.pathname==='/v1/model-inference/provider/claim'){if(claimed)return Response.json({claim:null});claimed=true;const profile=profiles[0],request=await core.prepareModelInferenceRequest({id:randomUUID(),target:{kind:'computer',deviceId:f.service.deviceId},profileRef:{id:profile.id,revision:profile.revision,digest:profile.digest},model:profile.model,messages:[{role:'user',content:'Explicit synthetic command evidence'}],maxOutputTokens:1024}),at=new Date().toISOString();claim={request,lease:{fence:randomUUID()},job:{id:request.id,state:'running',target:request.target,profile,requesterDeviceId:randomUUID(),inputDigest:request.digest,inputBytes:Buffer.byteLength(core.canonicalJson(request)),outputBytes:0,outputDigest:null,createdAt:at,updatedAt:at,leaseExpiresAt:new Date(Date.now()+60000).toISOString(),failure:null}};return Response.json({claim});}
  if(url.pathname.startsWith('/v1/model-inference/jobs/')&&url.pathname.endsWith('/heartbeat'))return Response.json({job:claim.job});
  if(url.pathname.startsWith('/v1/model-inference/jobs/')&&url.pathname.endsWith('/complete')){saved=body.output;claim.job={...claim.job,state:'complete',leaseExpiresAt:null,outputBytes:Buffer.byteLength(core.canonicalJson(saved)),outputDigest:saved.digest};return Response.json({replayed:false,result:{id:claim.request.id,status:'known',job:claim.job,output:saved}});}
 };
 const destination=path.join(f.root,'selected-model-backup.json'),manager=f.create({models:{secure,manual:true,readConfiguration:async()=>structuredClone(configuration),createWorker:options=>(worker=require('../electron/backend/computerModelWorker.cjs').createComputerModelWorker(options))},modelBackupExport:{showSaveDialog:showSaveDialog||(async()=>({canceled:false,filePath:destination}))}});
 await f.login(manager);const enabled=()=>manager.commands.desktop_models_set_enabled({enabled:true,consent:true,presetId:'selected-chat',configurationToken:manager.getStatus().modelInference.configurationToken});
 return{...f,manager,configuration,destination,enabled,worker:()=>worker,claim:()=>claim,modelCalls:()=>modelCalls,saved:()=>saved};
}
test('actual desktop model commands stay independent of PDF sharing, save the redacted result and export through native storage',async t=>{
 const f=await modelCommandFixture(t);assert.equal(f.manager.getStatus().enabled,false);assert.equal(f.manager.getStatus().capability,null);assert.equal(f.manager.getStatus().bindings.length,0);
 await f.enabled();await f.worker().runOnce();assert.equal(f.modelCalls(),1);assert.equal(f.saved().redacted,true);const records=await f.manager.commands.desktop_models_records();assert.equal(records.items[0].stage,'acknowledged');
 await assert.rejects(f.manager.commands.desktop_models_export({id:records.items[0].id,path:f.destination}),{code:'DESKTOP_ARGUMENT_INVALID'});assert.equal(fs.existsSync(f.destination),false);
 const exported=await f.manager.commands.desktop_models_export({id:records.items[0].id});assert.equal(exported.status,'exported');const text=fs.readFileSync(f.destination,'utf8'),backup=JSON.parse(text);assert.equal(backup.record.claim.request.id,f.claim().request.id);assert.equal(backup.record.outcome.output.digest,f.saved().digest);assert(!text.includes('PRIVATE_MODEL_COMMAND_KEY'));assert(!text.includes('https://private-model.fixture.test'));
 await f.manager.commands.desktop_account_sign_out();await f.manager.settled();assert.equal(f.manager.getStatus().modelInference.enabled,false);assert.deepEqual(f.manager.getStatus().modelInference.presets,[]);assert.equal(f.manager.getStatus().modelInference.configurationToken,null);assert(f.service.calls.some(c=>c.url===CONFIG.apiBaseUrl+'/v1/model-inference/provider'&&c.method==='DELETE'));assert.equal(f.modelCalls(),1);
});
test('actual model backup command rejects a dialog reply after sign out and keeps the profile lock until export settles',async t=>{
 const entered=deferred(),release=deferred();let destination;const f=await modelCommandFixture(t,{showSaveDialog:async()=>{entered.resolve();await release.promise;return{canceled:false,filePath:destination};}});destination=f.destination;await f.enabled();await f.worker().runOnce();const pending=f.manager.commands.desktop_models_export({id:f.claim().request.id}),rejected=assert.rejects(pending,{code:'DESKTOP_OPERATION_CANCELLED'});await entered.promise;await f.manager.commands.desktop_account_sign_out();assert.equal(f.manager.getStatus().account,null);assert.equal(fs.existsSync(destination),false);release.resolve();await rejected;await f.manager.settled();assert.equal(fs.existsSync(destination),false);assert.equal(f.modelCalls(),1);
});


async function graphCommandFixture(t, extra = {}) {
  const f = await fixture(t);
  f.context.noteStore = { listAllNotes: () => [] };
  const input = path.join(f.root,'second.pdf');
  fs.writeFileSync(input, Buffer.from('%PDF-1.7\nsecond selected graph paper\n%%EOF\n'));
  f.access.rememberPicked([input]);
  const second = (await f.imports.library_import_pdfs({request:{paths:[input],metadata:{[input]:{title:'Second selected graph paper'}}}}))[0].paper;
  const headers = [];
  f.service.onRoute = (url, options) => {
    if (url.pathname === '/v1/capabilities') return Response.json({protocolVersion:1,features:{desktopPdfTransfer:1,graphRelations:1},desktopPdf:{transport:'http-relay-v1',maxFileBytes:67108864,requestTtlMs:30000,pollTimeoutMs:20000}});
    if (url.pathname === '/v1/sync/pull' || url.pathname === '/v1/conflicts' || url.pathname === '/v1/sync/push' && JSON.parse(options.body).operations[0].entityType === 'graphRelation') {
      headers.push(options.headers);
      assert.equal(options.headers['X-PaperQuay-Features'],'graph-relations-v1');
    }
    if (url.pathname === '/v1/sync/pull') return Response.json({protocolVersion:1,records:[...f.service.records.values()],nextCursor:'preview-cursor',hasMore:false});
    if (url.pathname === '/v1/conflicts') return Response.json({conflicts:[],nextCursor:'conflict-cursor',hasMore:false});
  };
  const manager = Object.keys(extra).length ? f.create(extra) : f.manager;
  await f.login(manager);
  await f.publish(manager);
  await manager.commands.desktop_provider_publish({localPaperId:second.id,localAttachmentId:second.attachments[0].id});
  const file=path.join(f.appPaths.dataDir,'paperquay-knowledge-graph-relations.json');
  const original=JSON.stringify({version:1,relations:[{id:'actual-local-graph',source:'paper:'+f.paper.id,target:'paper:'+second.id,type:'ai_suggested',label:'Supports',description:'Full first line.\nFull second line.',confidence:null,weight:.58,createdAt:0,updatedAt:null}],localExtension:'preserve'},null,2);
  fs.writeFileSync(file,original);
  return {...f,manager,second,headers,file,original};
}

test('actual graph account commands negotiate the feature, preview before publishing and adopt into a private overlay only',async t=>{
  const f=await graphCommandFixture(t);
  assert.equal(f.manager.getStatus().graphExchange.supported,true);
  assert.equal(f.service.calls.filter(row=>row.url.includes('/v1/sync/pull')).length,0,'login never pulls graph content');
  let preview=await f.manager.commands.desktop_graph_preview();
  assert.equal(preview.localRows.length,1);assert.equal(preview.localRows[0].action,'create',JSON.stringify(preview.localRows[0]));
  assert.equal(f.service.calls.filter(row=>row.url.endsWith('/v1/sync/push')).length,4,'preview is read only');
  await f.manager.commands.desktop_graph_publish({token:preview.token,keys:[preview.localRows[0].key]});
  assert.equal(f.manager.getStatus().graphExchange.pending,0);
  const record=[...f.service.records.values()].find(row=>row.entityType==='graphRelation');
  assert.equal(record.data.confidence,null);assert.equal(record.data.createdAt,'1970-01-01T00:00:00.000Z');
  assert.deepEqual(f.manager.graphProjection().relations,[],'publication does not implicitly receive an account overlay');
  preview=await f.manager.commands.desktop_graph_preview();
  await f.manager.commands.desktop_graph_adopt({token:preview.token,ids:[record.entityId]});
  assert.equal(f.manager.graphProjection().relations[0].scope,'account');
  assert.deepEqual(f.manager.graphProjection().suppressedLocalIds,['actual-local-graph']);
  assert.equal(fs.readFileSync(f.file,'utf8'),f.original);
  assert.equal(f.headers.length,5);
  const owner=f.manager.getStatus().graphExchange.scopeKey;
  await f.manager.commands.desktop_account_sign_out();
  assert.deepEqual(f.manager.graphProjection(),{relations:[],suppressedLocalIds:[]});
  f.service.accountId=randomUUID();f.service.deviceId=randomUUID();await f.login(f.manager,false);
  assert.notEqual(f.manager.getStatus().graphExchange.scopeKey,owner);
  assert.deepEqual(f.manager.graphProjection().relations,[]);
});

test('actual graph export retains the account writer lock while the native picker is pending and refuses a late signed-out save',async t=>{
  const entered=deferred(),release=deferred();let invoked=0;
  const f=await graphCommandFixture(t,{graphBackupExporter:{async save(backup,{check,event}){
    invoked++;assert.equal(backup.format,'paperquay-desktop-graph-backup');assert.equal(event,'native-event');
    entered.resolve();await release.promise;check();return{status:'exported'};
  }}});
  const exportTask=f.manager.commands.desktop_graph_export({path:'renderer path is ignored'},'native-event');
  const cancelled=assert.rejects(exportTask,{code:'DESKTOP_OPERATION_CANCELLED'});
  await entered.promise;await f.manager.commands.desktop_account_sign_out();
  const other=f.create();await other.commands.desktop_account_sign_in();await other.settled();
  assert.equal(other.getStatus().errorCode,'DESKTOP_ACCOUNT_IN_USE');
  release.resolve();await cancelled;await f.manager.settled();
  await other.commands.desktop_account_sign_in();await other.settled();
  assert.equal(other.getStatus().account.accountId,f.service.accountId);
  assert.equal(invoked,1);assert.equal(fs.readFileSync(f.file,'utf8'),f.original);
});

test('current graph mappings remove an unbound material immediately without recreating it by UUID',async t=>{
  const f=await graphCommandFixture(t);
  let preview=await f.manager.commands.desktop_graph_preview();
  await f.manager.commands.desktop_graph_publish({token:preview.token,keys:[preview.localRows[0].key]});
  const record=[...f.service.records.values()].find(row=>row.entityType==='graphRelation');
  preview=await f.manager.commands.desktop_graph_preview();
  await f.manager.commands.desktop_graph_adopt({token:preview.token,ids:[record.entityId]});
  const binding=f.manager.getStatus().bindings.find(row=>row.localPaperId===f.second.id);
  await f.manager.commands.desktop_provider_unbind({bindingId:binding.bindingId});
  assert.deepEqual(f.manager.graphProjection().relations,[]);
  preview=await f.manager.commands.desktop_graph_preview();
  assert.equal(preview.incoming.find(row=>row.entityId===record.entityId).canAccept,false);
  await assert.rejects(f.manager.commands.desktop_graph_adopt({token:preview.token,ids:[record.entityId]}),{code:'UNMAPPED_GRAPH_ENDPOINT'});
  assert.equal(fs.readFileSync(f.file,'utf8'),f.original);
});


test('a late graph receipt keeps the profile locked after a later login capability check fails',async t=>{
  const f=await graphCommandFixture(t);
  const preview=await f.manager.commands.desktop_graph_preview();
  f.service.loseAfter='graphRelation';
  await assert.rejects(f.manager.commands.desktop_graph_publish({token:preview.token,keys:[preview.localRows[0].key]}),{code:'NETWORK_UNAVAILABLE'});
  await f.manager.commands.desktop_account_sign_out();await f.manager.settled();
  const entered=deferred(),release=deferred(),normalRoute=f.service.onRoute;
  let continued,started=false,badCapability=true,manager;
  f.service.onRoute=async(url,options,body)=>{
    if(url.pathname==='/v1/capabilities'&&badCapability)return Response.json({protocolVersion:1,features:{desktopPdfTransfer:1,graphRelations:1},desktopPdf:{transport:'http-relay-v1',maxFileBytes:67108864,requestTtlMs:30000,pollTimeoutMs:0}});
    if(url.pathname==='/v1/sync/push'&&body.operations[0].entityType==='graphRelation'){
      entered.resolve();await release.promise;
      const receipt=f.service.receipts.get(body.operations[0].opId);
      return Response.json({protocolVersion:1,results:[{...receipt.result,replayed:true}]});
    }
    return normalRoute(url,options,body);
  };
  manager=f.create({onGraphChange(){
    if(!started&&manager?.getStatus().graphExchange.loaded){
      started=true;continued=manager.commands.desktop_graph_continue().catch(error=>error);
    }
  }});
  await manager.commands.desktop_account_sign_in();
  await entered.promise;
  await until(()=>manager.getStatus().account===null&&manager.getStatus().errorCode==='DESKTOP_INVALID_RESPONSE');
  const other=f.create();
  try{
    await other.commands.desktop_account_sign_in();await other.settled();
    assert.equal(other.getStatus().errorCode,'DESKTOP_ACCOUNT_IN_USE');
  }finally{release.resolve();}
  await continued;await manager.settled();
  assert.deepEqual(manager.graphProjection(),{relations:[],suppressedLocalIds:[]});
  badCapability=false;
  await other.commands.desktop_account_sign_in();await other.settled();
  assert.equal(other.getStatus().account.accountId,f.service.accountId);
});
