import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const sourceUrl = new URL('../electron/backend/fileCommands.cjs', import.meta.url);
const require = createRequire(sourceUrl);
const { createAppPaths } = require('./libraryStore.cjs');

function configFixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-config-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appPaths = createAppPaths({ getPath: () => root });
  mkdirSync(path.dirname(appPaths.configPath), { recursive: true });
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(sourceUrl, 'utf8'), {
    require: (name) => name === 'electron' ? {} : overrides[name] ?? require(name),
    module, process, Buffer,
  });
  const commands = module.exports.createFileCommands({
    appPaths, approvedWritePaths: new Set(),
    store: { load: () => ({ settings: { storageDir: appPaths.dataDir } }) },
  });
  return { appPaths, commands };
}

test('successive config saves commit in request order even when the older save is slow', async (t) => {
  let releaseFirst;
  const firstPaused = new Promise((resolve) => { releaseFirst = resolve; });
  let reachedFirst;
  const firstReached = new Promise((resolve) => { reachedFirst = resolve; });
  let saved;
  let renames = 0;
  const { appPaths, commands } = configFixture(t, {
    './pathAccess.cjs': {
      ...require('./pathAccess.cjs'),
      writeBoundFile: async (_target, content) => {
        renames++;
        if (renames === 1) { reachedFirst(); await firstPaused; }
        saved = content;
      },
    },
  });
  const first = commands.write_text_file({ path: appPaths.configPath, content: 'older' });
  await firstReached;
  const second = commands.write_text_file({ path: appPaths.configPath, content: 'newer' });
  try {
    await new Promise(setImmediate);
    assert.equal(renames, 1, 'the newer save waits for the in-flight commit');
  } finally {
    releaseFirst();
    await Promise.all([first, second]);
  }
  assert.equal(saved, 'newer');
});

test('a failed config save retains the previous file and does not block a later retry', async (t) => {
  const fsp = require('node:fs/promises');
  let fail = true;
  const { appPaths, commands } = configFixture(t, {
    './pathAccess.cjs': {
      ...require('./pathAccess.cjs'),
      writeBoundFile: async (...args) => {
        if (fail) { fail = false; throw new Error('fixture disk write failure'); }
        return require('./pathAccess.cjs').writeBoundFile(...args);
      },
    },
  });
  writeFileSync(appPaths.configPath, 'previous');
  await assert.rejects(commands.write_text_file({ path: appPaths.configPath, content: 'failed' }), /fixture disk write failure/);
  assert.equal(readFileSync(appPaths.configPath, 'utf8'), 'previous');
  await commands.write_text_file({ path: appPaths.configPath, content: 'retry' });
  assert.equal(readFileSync(appPaths.configPath, 'utf8'), 'retry');
  assert.deepEqual(await fsp.readdir(path.dirname(appPaths.configPath)), ['paperquay.config.json']);
});

test('an external library can save the exact trusted profile config but not adjacent files', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-config-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const external = path.join(root, 'external');
  mkdirSync(external);
  const appPaths = createAppPaths({ getPath: () => profile }, external);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(sourceUrl, 'utf8'), {
    require: (name) => name === 'electron' ? {} : require(name), module, process, Buffer,
  });
  const context = { appPaths, approvedWritePaths: new Set(), store: { load: () => ({ settings: { storageDir: path.join(external, 'pdfs') } }) },
    authorizeLocalRead: async () => { throw new Error('unapproved generic read'); } };
  const commands = module.exports.createFileCommands(context);
  const suppliedLegacy = path.join(external, 'paperquay-data', 'paperquay.config.json');
  mkdirSync(path.dirname(suppliedLegacy), { recursive: true });
  writeFileSync(suppliedLegacy, JSON.stringify({ settings: { autoTranslateSelection: true }, qaModelPresets: [{ baseUrl: 'https://untrusted.invalid' }] }));
  assert.equal(await commands.read_app_config(), null, 'an external legacy config is never a fallback');
  mkdirSync(path.dirname(appPaths.legacyConfigPath), { recursive: true });
  const trustedLegacy = JSON.stringify({ settings: { autoTranslateSelection: false } });
  writeFileSync(appPaths.legacyConfigPath, trustedLegacy);
  assert.equal(await commands.read_app_config(), trustedLegacy, 'legacy migration only reads the trusted local profile');
  mkdirSync(path.dirname(appPaths.configPath), { recursive: true });
  for (const emptyContent of ['', ' \r\n\t', '\uFEFF \r\n']) {
    writeFileSync(appPaths.configPath, emptyContent);
    assert.equal(await commands.read_app_config(), trustedLegacy, 'an empty primary config must not hide legacy settings');
  }
  const content = JSON.stringify({ settings: { autoTranslateSelection: false }, qaModelPresets: [{ id: 'fixture', model: 'fixture-only' }] });
  await commands.write_text_file({ path: appPaths.configPath, content });
  assert.equal(readFileSync(appPaths.configPath, 'utf8'), content);
  const reopened = module.exports.createFileCommands(context);
  assert.equal(await reopened.read_app_config(), content);
  writeFileSync(appPaths.configPath, '\uFEFF' + content);
  assert.equal(await reopened.read_app_config(), content, 'UTF-8 BOM configs created by Windows tools remain valid JSON');
  writeFileSync(appPaths.configPath, '');
  writeFileSync(appPaths.legacyConfigPath, ' \r\n\t');
  assert.equal(await reopened.read_app_config(), null, 'empty trusted configs do not fall back to the external library');
  await assert.rejects(reopened.read_text_file_if_exists({ path: appPaths.configPath }), /unapproved generic read/);
  await assert.rejects(commands.write_text_file({ path: path.join(path.dirname(appPaths.configPath), 'other.json'), content }), /not allowed/);
  await assert.rejects(commands.write_text_file({ path: path.join(profile, 'private.txt'), content }), /not allowed/);
});
