import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const sourceUrl = new URL('../electron/backend/fileCommands.cjs', import.meta.url);
const require = createRequire(sourceUrl);
const { createAppPaths } = require('./libraryStore.cjs');
const { readZipWithAdm } = require('./utils.cjs');
const { downloadZoteroAttachmentPdf } = require('./zoteroApi.cjs');
const AdmZip = require('adm-zip');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-write-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const external = path.join(root, 'library'), outside = path.join(root, 'outside');
  mkdirSync(external); mkdirSync(outside);
  const appPaths = createAppPaths({ getPath: () => path.join(root, 'profile') }, external);
  const module = { exports: {} };
  const consent = { response: 1, prompts: [] };
  vm.runInNewContext(readFileSync(sourceUrl, 'utf8'), {
    require: (name) => name === 'electron' ? { dialog: { showMessageBox: async (options) => { consent.prompts.push(options); return { response: consent.response }; } } } : require(name), module, process, Buffer,
    fetch: (...args) => globalThis.fetch(...args),
  });
  const context = { appPaths, approvedWritePaths: new Set(),
    store: { load: () => ({ settings: { storageDir: path.join(external, 'pdfs') } }) } };
  const commands = module.exports.createFileCommands(context);
  const link = (target, alias) => symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, external, outside, appPaths, context, commands, link, consent,
    reopen: () => module.exports.createFileCommands(context) };
}

test('renderer write approval cannot grant an outside capability without native consent', async (t) => {
  const f = fixture(t), target = path.join(f.outside, 'private.txt'); writeFileSync(target, 'private');
  f.consent.response = 0;
  await assert.rejects(f.commands.approve_write_path({ path: target }), /approval canceled/);
  await assert.rejects(f.commands.write_text_file({ path: target, content: 'bad' }), /not allowed/);
  assert.equal(readFileSync(target, 'utf8'), 'private'); assert.equal(f.consent.prompts.length, 1);
  f.consent.response = 1;
  const alias = path.join(f.root, 'friendly'); f.link(f.outside, alias);
  await f.commands.approve_write_path({ path: path.join(alias, 'private.txt') });
  assert.equal(f.consent.prompts.length, 3, 'link approval also discloses its actual target');
  await f.commands.write_text_file({ path: path.join(alias, 'private.txt'), content: 'explicitly approved' });
  assert.equal(readFileSync(target, 'utf8'), 'explicitly approved');
  await assert.rejects(f.commands.write_text_file({ path: path.join(f.outside, 'adjacent.txt'), content: 'bad' }), /not allowed/);
});

test('an unavailable configured cache cannot prevent opening the library and local settings', async (t) => {
  const f = fixture(t);
  const unavailable = path.join(f.root, 'offline-cache');
  f.link(path.join(f.root, 'missing-cache-volume'), unavailable);
  await f.commands.write_text_file({ path: f.appPaths.configPath, content: JSON.stringify({ settings: { mineruCacheDir: unavailable } }) });
  const reopened = f.reopen();
  assert.ok(await reopened.read_app_config());
  assert.ok(await reopened.get_app_default_paths());
  await assert.rejects(reopened.write_text_file({ path: path.join(unavailable, 'full.md'), content: 'no' }), /not allowed/);
  if (process.platform === 'win32' && !existsSync('Q:\\')) {
    await reopened.write_text_file({ path: f.appPaths.configPath, content: JSON.stringify({ settings: { mineruCacheDir: 'Q:\\PaperQuay\\MinerU' } }) });
    assert.doesNotThrow(() => f.reopen());
  }
});

test('generic text, binary and download writes reject nested companion links outside the pinned library', async (t) => {
  const f = fixture(t);
  const fetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('unexpected'); };
  t.after(() => { globalThis.fetch = fetch; });
  for (const parent of [f.appPaths.mineruCacheDir, f.appPaths.remotePdfDownloadDir, f.appPaths.screenshotDir]) {
    mkdirSync(parent, { recursive: true });
    const alias = path.join(parent, 'document-link'); f.link(f.outside, alias);
    const target = path.join(alias, 'private.txt');
    await assert.rejects(f.commands.write_text_file({ path: target, content: 'no' }), /not allowed/);
    await assert.rejects(f.commands.write_binary_file_base64({ path: target, contentBase64: 'bm8=' }), /not allowed/);
    await assert.rejects(f.commands.download_remote_file_to_path({ path: target, url: 'https://fixture.invalid' }), /not allowed/);
  }
  assert.equal(requests, 0);
  assert.deepEqual(readdirSync(f.outside), []);
  const ordinary = path.join(f.appPaths.mineruCacheDir, 'new-document', 'summaries', 'summary.json');
  await f.commands.write_text_file({ path: ordinary, content: '{"ok":true}' });
  assert.equal(readFileSync(ordinary, 'utf8'), '{"ok":true}');
  const selected = path.join(f.outside, 'annotated.pdf');
  await f.commands.approve_write_path({ path: selected });
  await f.commands.write_binary_file_base64({ path: selected, contentBase64: Buffer.from('approved annotation').toString('base64') });
  assert.equal(readFileSync(selected, 'utf8'), 'approved annotation');
  await assert.rejects(f.commands.write_text_file({ path: path.join(f.outside, 'adjacent.txt'), content: 'no' }), /not allowed/);
});

test('remote downloads retain the approved canonical destination across a network await', async (t) => {
  const f = fixture(t);
  const safe = path.join(f.external, 'safe'); mkdirSync(safe);
  const alias = path.join(f.external, 'alias'); f.link(safe, alias);
  writeFileSync(path.join(f.outside, 'download.pdf'), 'unrelated');
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    unlinkSync(alias); f.link(f.outside, alias);
    return new Response('downloaded fixture');
  };
  t.after(() => { globalThis.fetch = fetch; });
  await f.commands.download_remote_file_to_path({ path: path.join(alias, 'download.pdf'), url: 'https://fixture.invalid' });
  assert.equal(readFileSync(path.join(safe, 'download.pdf'), 'utf8'), 'downloaded fixture');
  assert.equal(readFileSync(path.join(f.outside, 'download.pdf'), 'utf8'), 'unrelated');
});

test('a canonical directory replaced during download is rejected before writing', async (t) => {
  const f = fixture(t);
  const safe = path.join(f.external, 'safe'); mkdirSync(safe);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    rmSync(safe, { recursive: true }); f.link(f.outside, safe);
    return new Response('must not escape');
  };
  t.after(() => { globalThis.fetch = fetch; });
  await assert.rejects(f.commands.download_remote_file_to_path({ path: path.join(safe, 'download.pdf'), url: 'https://fixture.invalid' }), /path changed/);
  assert.deepEqual(readdirSync(f.outside), []);
});

test('dangling links and aliases to the exact local config do not grant generic write access', async (t) => {
  const f = fixture(t);
  const missing = path.join(f.outside, 'missing');
  const dangling = path.join(f.external, 'dangling'); f.link(missing, dangling);
  await assert.rejects(f.commands.write_text_file({ path: path.join(dangling, 'new.txt'), content: 'no' }), /not allowed/);
  assert.equal(existsSync(missing), false);
  await f.commands.write_text_file({ path: f.appPaths.configPath, content: 'trusted config' });
  const alias = path.join(f.external, 'profile-alias'); f.link(path.dirname(f.appPaths.configPath), alias);
  await assert.rejects(f.commands.write_text_file({ path: path.join(alias, path.basename(f.appPaths.configPath)), content: 'no' }), /not allowed/);
  assert.equal(readFileSync(f.appPaths.configPath, 'utf8'), 'trusted config');
});

test('MinerU extraction validates its output root as well as nested entries', async (t) => {
  const f = fixture(t);
  mkdirSync(f.appPaths.mineruCacheDir, { recursive: true });
  const alias = path.join(f.appPaths.mineruCacheDir, 'document-linked'); f.link(f.outside, alias);
  const zip = new AdmZip(); zip.addFile('full.md', Buffer.from('# fixture'));
  await assert.rejects(readZipWithAdm(zip.toBuffer(), alias, f.context.authorizeLocalWrite), /not allowed/);
  assert.deepEqual(readdirSync(f.outside), []);
  const ordinary = path.join(f.appPaths.mineruCacheDir, 'document-safe');
  const result = await readZipWithAdm(zip.toBuffer(), ordinary, f.context.authorizeLocalWrite);
  assert.equal(result.markdownText, '# fixture');
  assert.equal(readFileSync(result.markdownPath, 'utf8'), '# fixture');
});

test('a selected custom cache directory stays pinned and ordinary cache migration still works', async (t) => {
  const f = fixture(t);
  const custom = path.join(f.root, 'custom-cache'); mkdirSync(custom);
  const alias = path.join(f.root, 'custom-alias'); f.link(custom, alias);
  const old = path.join(f.external, 'old-cache'); mkdirSync(path.join(old, 'document-safe'), { recursive: true });
  writeFileSync(path.join(old, 'document-safe', 'full.md'), '# migrated');
  const prepared = await f.commands.prepare_mineru_cache_dir({ directory: alias, previousDirectory: old });
  assert.equal(prepared.directory, realpathSync.native(custom));
  assert.equal(prepared.migratedCount, 1);
  assert.equal(readFileSync(path.join(custom, 'document-safe', 'full.md'), 'utf8'), '# migrated');
  unlinkSync(alias); f.link(f.outside, alias);
  await f.commands.write_text_file({ path: path.join(alias, 'summary.json'), content: 'pinned' });
  assert.equal(readFileSync(path.join(custom, 'summary.json'), 'utf8'), 'pinned');
  assert.equal(existsSync(path.join(f.outside, 'summary.json')), false);
  await f.commands.write_text_file({ path: path.join(prepared.directory, 'summary.json'), content: 'yes' });
  assert.equal(readFileSync(path.join(custom, 'summary.json'), 'utf8'), 'yes');
});

test('Zotero download uses the same pinned output authorization', async (t) => {
  const f = fixture(t);
  mkdirSync(f.appPaths.remotePdfDownloadDir, { recursive: true });
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('zotero fixture');
  t.after(() => { globalThis.fetch = fetch; });
  const options = { apiKey: 'fixture', userId: 'fixture', attachmentKey: 'fixture', filename: 'fixture.pdf' };
  const result = await downloadZoteroAttachmentPdf(options, f.appPaths, f.context.authorizeLocalWrite);
  assert.equal(readFileSync(result.path, 'utf8'), 'zotero fixture');
  rmSync(f.appPaths.remotePdfDownloadDir, { recursive: true }); f.link(f.outside, f.appPaths.remotePdfDownloadDir);
  await assert.rejects(downloadZoteroAttachmentPdf(options, f.appPaths, f.context.authorizeLocalWrite), /not allowed/);
  assert.deepEqual(readdirSync(f.outside), []);
});
