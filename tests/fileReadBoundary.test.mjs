import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync, existsSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createAppPaths } = require('../electron/backend/libraryStore.cjs');
const { readAuthorizedFile } = require('../electron/backend/pathAccess.cjs');
const nativeFs = require('../electron/backend/nativeFs.cjs');

function load(relative, electron = {}, extras = {}) {
  const url = new URL(relative, import.meta.url), localRequire = createRequire(url);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(url, 'utf8'), {
    module, process, Buffer, URL, Response, Headers, __dirname: path.dirname(fileURLToPath(url)),
    setTimeout: (fn) => fn(), fetch: (...args) => globalThis.fetch(...args),
    require: (name) => name === 'electron' ? electron : name === 'node:child_process' ? { spawn() {} } : localRequire(name), ...extras,
  });
  return module.exports;
}

function fixture(t, electron = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-read-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const external = path.join(root, 'shared'); mkdirSync(external);
  const appPaths = createAppPaths({ getPath: () => path.join(root, 'profile') }, external);
  const context = { appPaths, approvedWritePaths: new Set(), store: { load: () => ({ settings: {} }) } };
  const commands = load('../electron/backend/fileCommands.cjs', electron).createFileCommands(context);
  const safe = path.join(external, 'safe.pdf'); writeFileSync(safe, 'safe bytes');
  const privateDir = path.join(root, 'private'); mkdirSync(privateDir);
  writeFileSync(path.join(privateDir, 'safe.pdf'), 'private bytes');
  const redirect = () => {
    renameSync(external, path.join(root, 'old-shared'));
    symlinkSync(privateDir, external, process.platform === 'win32' ? 'junction' : 'dir');
  };
  return { root, external, appPaths, context, commands, safe, privateDir, redirect };
}

for (const method of ['read_text_file', 'read_text_file_if_exists', 'read_binary_file_base64']) {
  test(`${method} rejects a canonical parent replaced during authorization`, async (t) => {
    const f = fixture(t);
    f.context.authorizeLocalRead = f.redirect;
    await assert.rejects(f.commands[method]({ path: f.safe }), /path changed|read file changed/);
  });
}

test('reads retain the approved descriptor if its name is replaced after verification', async (t) => {
  const f = fixture(t), originalRead = fs.readFile;
  let attempted = false;
  fs.readFile = (...args) => {
    attempted = true;
    if (process.platform === 'win32') {
      assert.throws(() => renameSync(f.safe, f.safe + '.old'), { code: 'EBUSY' });
    } else {
      renameSync(f.safe, f.safe + '.old');
      writeFileSync(f.safe, 'private replacement bytes');
    }
    return originalRead(...args);
  };
  t.after(() => { fs.readFile = originalRead; });
  assert.equal(await readAuthorizedFile(f.safe, () => {}, 'utf8'), 'safe bytes');
  assert.equal(attempted, true);
});

test('authorization precedes opening and ordinary optional reads retain their semantics', async (t) => {
  const f = fixture(t);
  assert.equal(await f.commands.read_text_file_if_exists({ path: path.join(f.external, 'absent') }), null);
  assert.equal(await f.commands.read_text_file_if_exists({ path: f.external }), null);
  assert.equal(await f.commands.read_text_file({ path: f.safe }), 'safe bytes');
  f.context.authorizeLocalRead = () => {
    renameSync(f.safe, f.safe + '.old'); writeFileSync(f.safe, 'unapproved replacement');
  };
  assert.equal(await f.commands.read_text_file({ path: f.safe }), 'unapproved replacement');
});

test('PDF full/range/HEAD serve approved handles and reject changed canonical parents', async (t) => {
  const f = fixture(t), handlers = new Map();
  const protocol = load('../electron/localPdfProtocol.cjs', { protocol: { handle: (name, fn) => handlers.set(name, fn) } });
  const request = (method = 'GET', range) => ({ url: 'paperquay-pdf://local/?path=' + encodeURIComponent(f.safe), method, headers: new Headers(range ? { range } : {}) });
  protocol.registerLocalPdfProtocol(() => {});
  const invoke = (req) => handlers.get('paperquay-pdf')(req);
  assert.equal(await (await invoke(request())).text(), 'safe bytes');
  const partial = await invoke(request('GET', 'bytes=0-3'));
  assert.equal(partial.status, 206); assert.equal(await partial.text(), 'safe');
  assert.equal((await invoke(request('HEAD'))).status, 200);
  assert.equal((await invoke(request('HEAD', 'bytes=0-3'))).status, 206);
  assert.equal((await invoke(request('GET', 'invalid'))).status, 416);
  protocol.registerLocalPdfProtocol(f.redirect);
  const denied = await invoke(request());
  assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /private bytes/);
});

test('MinerU upload rejects a file replaced after upload authorization', async (t) => {
  const f = fixture(t), originalFetch = globalThis.fetch; let approvals = 0, uploads = 0;
  f.context.authorizeCloudParsePath = (_library, actual) => { if (++approvals === 2) f.redirect(); return actual; };
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'PUT') uploads++;
    return Response.json({ code: 0, data: { batch_id: 'fixture', file_urls: ['https://fixture.invalid/upload'] } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const commands = load('../electron/backend/mineruCommands.cjs').createMineruCommands(f.context);
  await assert.rejects(commands.run_mineru_cloud_parse({ options: { apiToken: 'fixture', pdfPath: f.safe } }), /path changed|read file changed/);
  assert.equal(uploads, 0);
});

test('captured screenshots stay profile-private and are consumed once without granting generic access', { skip: process.platform !== 'win32' }, async (t) => {
  let reads = 0;
  const bytes = Buffer.from('synthetic screenshot fixture');
  const f = fixture(t, { clipboard: { readImage: () => ({ isEmpty: () => false, toPNG: () => ++reads % 2 ? Buffer.from('before') : bytes }) } });
  f.context.authorizeLocalRead = () => { throw new Error('unapproved generic read'); };
  assert.equal(f.appPaths.screenshotDir, path.join(f.root, 'profile', 'PaperQuay', '.screenshots'));
  const capture = await f.commands.capture_system_screenshot();
  assert.equal(existsSync(capture.path), true);
  assert.equal(existsSync(path.join(f.external, '.screenshots')), false);
  assert.equal(await f.commands.read_binary_file_base64({ path: capture.path }), bytes.toString('base64'));
  assert.equal(existsSync(capture.path), false);
  const failedCapture = await f.commands.capture_system_screenshot();
  const originalOpen = nativeFs.openRead;
  nativeFs.openRead = async (...args) => {
    if (args[0] === failedCapture.path) throw new Error('fixture read failure');
    return originalOpen(...args);
  };
  try { await assert.rejects(f.commands.read_binary_file_base64({ path: failedCapture.path }), /fixture read failure/); }
  finally { nativeFs.openRead = originalOpen; }
  assert.equal(existsSync(failedCapture.path), false, 'failed ingestion also removes the private temporary capture');
  await assert.rejects(f.commands.read_binary_file_base64({ path: f.safe }), /unapproved/);
  await assert.rejects(f.commands.write_binary_file_base64({ path: path.join(f.appPaths.screenshotDir, 'other.png'), contentBase64: 'AA==' }), /not allowed/);
  rmSync(f.appPaths.screenshotDir, { recursive: true });
  symlinkSync(f.privateDir, f.appPaths.screenshotDir, 'junction');
  await assert.rejects(f.commands.capture_system_screenshot(), /path changed/);
});
