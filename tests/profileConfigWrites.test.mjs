import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const sourceUrl = new URL('../electron/backend/fileCommands.cjs', import.meta.url);
const require = createRequire(sourceUrl);
const { createAppPaths } = require('./libraryStore.cjs');

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
  const content = JSON.stringify({ settings: { autoTranslateSelection: false }, qaModelPresets: [{ id: 'fixture', model: 'fixture-only' }] });
  await commands.write_text_file({ path: appPaths.configPath, content });
  assert.equal(readFileSync(appPaths.configPath, 'utf8'), content);
  const reopened = module.exports.createFileCommands(context);
  assert.equal(await reopened.read_app_config(), content);
  await assert.rejects(reopened.read_text_file_if_exists({ path: appPaths.configPath }), /unapproved generic read/);
  await assert.rejects(commands.write_text_file({ path: path.join(path.dirname(appPaths.configPath), 'other.json'), content }), /not allowed/);
  await assert.rejects(commands.write_text_file({ path: path.join(profile, 'private.txt'), content }), /not allowed/);
});
