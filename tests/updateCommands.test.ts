import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  cleanVersion,
  compareVersions,
  createUpdateCommands,
  getAutoUpdateSupport,
  releaseDownloadBaseUrl,
  selectLatestForkRelease,
} = require('../electron/backend/updateCommands.cjs') as {
  cleanVersion: (value: unknown) => string;
  compareVersions: (left: unknown, right: unknown) => number;
  createUpdateCommands: (context: Record<string, unknown>) => {
    app_update_check: () => Promise<{ hasUpdate: boolean; autoUpdateSupported: boolean; canDownload: boolean; releaseUrl: string }>;
  };
  getAutoUpdateSupport: (app: { isPackaged: boolean }, runtime?: { platform: string; executablePath: string }) => {
    supported: boolean;
    channel?: string;
    reason: string;
  };
  releaseDownloadBaseUrl: (release: { tagName: string }) => string;
  selectLatestForkRelease: (releases: unknown) => { version: string; tagName: string } | null;
};

test('cleanVersion normalizes PaperQuay release tags', () => {
  assert.equal(cleanVersion('app-v0.1.19'), '0.1.19');
  assert.equal(cleanVersion('v1.2.3'), '1.2.3');
});

test('compareVersions orders semantic versions and prereleases', () => {
  assert.equal(compareVersions('0.1.20', '0.1.19'), 1);
  assert.equal(compareVersions('0.1.19', '0.1.19'), 0);
  assert.equal(compareVersions('0.1.19-beta.1', '0.1.19'), -1);
  assert.equal(compareVersions('0.1.26-mikutea.10', '0.1.26-mikutea.9'), 1);
});

test('getAutoUpdateSupport disables automatic install in development', () => {
  assert.deepEqual(getAutoUpdateSupport({ isPackaged: false }), {
    supported: false,
    reason: 'development',
  });
});

test('selectLatestForkRelease ignores upstream, draft, and incomplete releases', () => {
  const release = (tag: string, extras: Record<string, unknown> = {}) => ({
    tag_name: tag,
    prerelease: true,
    draft: false,
    assets: [
      { name: 'stable.yml', browser_download_url: 'https://example.com/stable.yml' },
      { name: `PaperQuay-${tag.slice(5)}-win-x64.exe`, browser_download_url: 'https://example.com/setup.exe' },
    ],
    ...extras,
  });
  const selected = selectLatestForkRelease([
    release('app-v0.1.26-mikutea.9'),
    release('app-v0.1.26-mikutea.10'),
    release('app-v0.1.26-mikutea.13', {
      assets: [
        { name: 'stable.yml', browser_download_url: 'https://example.com/stable.yml' },
        { name: 'PaperQuay-0.1.26-mikutea.12-win-x64.exe', browser_download_url: 'https://example.com/setup.exe' },
      ],
    }),
    release('app-v0.1.26-mikutea.11', { draft: true }),
    release('app-v0.1.26-mikutea.12', { assets: [] }),
    release('app-v9.9.9-upstream.1'),
  ]);
  assert.equal(selected?.tagName, 'app-v0.1.26-mikutea.10');
  assert.equal(releaseDownloadBaseUrl(selected!), 'https://github.com/mikutea/PaperQuay/releases/download/app-v0.1.26-mikutea.10/');
  assert.throws(() => releaseDownloadBaseUrl({ tagName: 'app-v9.9.9-upstream.1' }));
});

test('Windows portable builds cannot invoke the NSIS updater', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paperquay-update-support-'));
  const runtime = { platform: 'win32', executablePath: path.join(dir, 'PaperQuay.exe') };
  try {
    assert.deepEqual(getAutoUpdateSupport({ isPackaged: true }, runtime), {
      supported: false,
      reason: 'windows-portable',
    });
    writeFileSync(path.join(dir, '.paperquay-nsis-install'), 'test');
    assert.equal(getAutoUpdateSupport({ isPackaged: true }, runtime).supported, true);
    writeFileSync(path.join(dir, '.paperquay-msi-install'), 'test');
    assert.deepEqual(getAutoUpdateSupport({ isPackaged: true }, runtime), {
      supported: false,
      reason: 'windows-msi',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packaged NSIS update check binds the downloader to the selected fork prerelease', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'paperquay-update-feed-'));
  const runtime = { platform: 'win32', executablePath: path.join(dir, 'PaperQuay.exe') };
  const feedUrls: unknown[] = [];
  try {
    writeFileSync(path.join(dir, '.paperquay-nsis-install'), 'test');
    const commands = createUpdateCommands({
      app: { isPackaged: true, getVersion: () => '0.1.26-mikutea.5' },
      shell: { openExternal: async () => {} },
      autoUpdater: {
        on: () => {},
        setFeedURL: (config: unknown) => feedUrls.push(config),
        checkForUpdates: async () => ({ updateInfo: { version: '0.1.26-mikutea.6' } }),
      },
      updateRuntime: runtime,
      fetchLatestRelease: async () => ({
        version: '0.1.26-mikutea.6',
        tagName: 'app-v0.1.26-mikutea.6',
        url: 'https://github.com/mikutea/PaperQuay/releases/tag/app-v0.1.26-mikutea.6',
      }),
    });
    const status = await commands.app_update_check();
    assert.equal(status.hasUpdate, true);
    assert.equal(status.autoUpdateSupported, true);
    assert.equal(status.canDownload, true);
    assert.equal(status.releaseUrl.includes('mikutea/PaperQuay'), true);
    assert.deepEqual(feedUrls, [{
      provider: 'generic',
      url: 'https://github.com/mikutea/PaperQuay/releases/download/app-v0.1.26-mikutea.6/',
    }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
