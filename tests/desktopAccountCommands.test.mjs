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
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) assert.fail('Timed out waiting for test condition'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

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
    const url = new URL(input), body = options.body && options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : options.body;
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
  return { root, profile, libraryRoot, appPaths, store, context, paper, attachment, service, manager, create, login, publish, privateState };
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
