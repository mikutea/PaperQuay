import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdateCommands } = require('../electron/backend/updateCommands.cjs');
const { createUpdatePreferences } = require('../electron/backend/updatePreferences.cjs');

function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'paperquay-update-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.paperquay-nsis-install'), 'test');
  const version = '0.1.26-mikutea.13';
  const calls = { checks: 0, feed: 0, downloads: 0, installs: 0, prepared: 0 };
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL() { calls.feed++; },
    async checkForUpdates() { return { updateInfo: { version } }; },
    async downloadUpdate() { calls.downloads++; updater.emit('update-downloaded', { version }); },
    quitAndInstall() { calls.installs++; },
  });
  const preferences = createUpdatePreferences(path.join(root, 'update.json'));
  const context = {
    app: { isPackaged: true, getVersion: () => '0.1.26-mikutea.12' },
    shell: { openExternal: async () => {} },
    autoUpdater: updater,
    updatePreferences: preferences,
    updateRuntime: { platform: 'win32', executablePath: path.join(root, 'PaperQuay.exe') },
    fetchLatestRelease: async () => {
      calls.checks++;
      return { version, tagName: 'app-v' + version, notes: 'Library preservation and theme fixes.' };
    },
    prepareForUpdate: async () => { calls.prepared++; },
    ...overrides,
  };
  return { root, version, calls, updater, preferences, context, commands: createUpdateCommands(context) };
}

test('startup checks once per process and never downloads or installs without a user action', async (t) => {
  const { commands, calls } = fixture(t);
  const statuses = await Promise.all([commands.app_update_check_startup(), commands.app_update_check_startup()]);
  assert.equal(calls.checks, 1);
  assert.equal(calls.feed, 1);
  assert.equal(statuses[0].showStartupNotice, true);
  assert.match(statuses[0].releaseNotes, /Library/);
  await commands.app_update_check_startup();
  assert.equal(calls.checks, 1);
  assert.equal(calls.downloads, 0);
  assert.equal(calls.installs, 0);
  commands.app_update_dismiss_startup({});
  assert.equal((await commands.app_update_check_startup()).showStartupNotice, false);
});

test('startup opt-out and skipped version persist while manual checks remain available', async (t) => {
  const { commands, calls, preferences, root, context, version } = fixture(t);
  commands.app_update_set_preferences({ autoCheckOnStartup: false });
  assert.equal((await commands.app_update_check_startup()).showStartupNotice, false);
  assert.equal(calls.checks, 0);
  assert.equal((await commands.app_update_check()).hasUpdate, true);
  commands.app_update_set_preferences({ autoCheckOnStartup: true });
  commands.app_update_dismiss_startup({ skipVersion: true });
  const reopenedPreferences = createUpdatePreferences(path.join(root, 'update.json'));
  assert.deepEqual(reopenedPreferences.read(), preferences.read());
  assert.equal(reopenedPreferences.read().skippedVersion, version);
  const nextLaunch = createUpdateCommands({ ...context, autoUpdater: context.autoUpdater, updatePreferences: reopenedPreferences });
  assert.equal((await nextLaunch.app_update_check_startup()).showStartupNotice, false);
  assert.equal((await nextLaunch.app_update_check()).hasUpdate, true);
});

test('offline startup is non-blocking and reports no misleading update notice', async (t) => {
  const { commands } = fixture(t, { fetchLatestRelease: async () => { throw new Error('offline'); } });
  const status = await commands.app_update_check_startup();
  assert.equal(status.showStartupNotice, false);
  assert.equal(status.error, 'offline');
  assert.equal(status.canDownload, false);
});

test('concurrent checks are deduplicated and do not discard a downloaded update', async (t) => {
  const { commands, calls } = fixture(t);
  await Promise.all([commands.app_update_check(), commands.app_update_check()]);
  assert.equal(calls.checks, 1);
  const ready = await commands.app_update_download();
  assert.equal(ready.canInstall, true);
  const checked = await commands.app_update_check();
  assert.equal(checked.canInstall, true);
  assert.equal(calls.checks, 1);
  await commands.app_update_download();
  assert.equal(calls.downloads, 1);
  await commands.app_update_install();
  assert.equal(calls.prepared, 1);
  assert.equal(calls.installs, 1);
});

test('checks during download retain the selected release and cannot start a second download', async (t) => {
  const { commands, updater, calls, version } = fixture(t);
  let finish;
  updater.downloadUpdate = () => new Promise((resolve) => { calls.downloads++; finish = resolve; });
  await commands.app_update_check();
  const downloading = commands.app_update_download();
  const status = await commands.app_update_check();
  assert.equal(status.downloading, true);
  await commands.app_update_download();
  assert.equal(calls.downloads, 1);
  assert.equal(calls.checks, 1);
  updater.emit('update-downloaded', { version });
  finish();
  assert.equal((await downloading).canInstall, true);
});

test('mismatched feed versions cannot be downloaded and preservation failures prevent installation', async (t) => {
  const { commands, updater, calls, version, context } = fixture(t);
  updater.checkForUpdates = async () => ({ updateInfo: { version: '0.1.26-mikutea.14' } });
  const status = await commands.app_update_check();
  assert.match(status.error, /does not match/);
  assert.equal(status.canDownload, false);
  await assert.rejects(commands.app_update_download(), /not been verified/);
  assert.equal(calls.downloads, 0);
  updater.checkForUpdates = async () => ({ updateInfo: { version } });
  await commands.app_update_check();
  await commands.app_update_download();
  context.prepareForUpdate = async () => { throw new Error('cannot preserve library path'); };
  await assert.rejects(commands.app_update_install(), /cannot preserve library path/);
  assert.equal(calls.installs, 0);
});
