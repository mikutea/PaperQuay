const fs = require('node:fs');
const path = require('node:path');

const UPDATE_REPOSITORY = {
  owner: 'mikutea',
  repo: 'PaperQuay',
};
const UPDATE_CHANNEL = 'stable';
const RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases?per_page=100`;
const FORK_TAG_PATTERN = /^app-v\d+\.\d+\.\d+-mikutea\.\d+$/;
const NSIS_INSTALL_MARKER = '.paperquay-nsis-install';

function cleanVersion(value) {
  const text = String(value ?? '').trim().replace(/^app-v/i, '').replace(/^v/i, '');
  const match = text.match(/\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : '';
}

function compareVersionParts(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }

  return 0;
}

function compareVersions(leftValue, rightValue) {
  const left = cleanVersion(leftValue);
  const right = cleanVersion(rightValue);

  if (!left || !right) {
    return left === right ? 0 : left ? 1 : -1;
  }

  const [leftCore, leftPrerelease = ''] = left.split('-');
  const [rightCore, rightPrerelease = ''] = right.split('-');
  const coreDelta = compareVersionParts(
    leftCore.split('.').map((part) => Number(part) || 0),
    rightCore.split('.').map((part) => Number(part) || 0),
  );

  if (coreDelta !== 0) {
    return coreDelta;
  }

  if (leftPrerelease === rightPrerelease) {
    return 0;
  }

  if (!leftPrerelease) {
    return 1;
  }

  if (!rightPrerelease) {
    return -1;
  }

  return leftPrerelease.localeCompare(rightPrerelease, undefined, { numeric: true });
}

function getAutoUpdateSupport(app, runtime = { platform: process.platform, executablePath: process.execPath }) {
  if (!app.isPackaged) {
    return {
      supported: false,
      reason: 'development',
    };
  }

  if (runtime.platform === 'win32') {
    if (!fs.existsSync(path.join(path.dirname(runtime.executablePath), NSIS_INSTALL_MARKER))) {
      return { supported: false, reason: 'windows-portable' };
    }
    return {
      supported: true,
      channel: 'nsis',
      reason: '',
    };
  }

  if (runtime.platform === 'linux') {
    if (process.env.APPIMAGE) {
      return {
        supported: true,
        channel: 'appimage',
        reason: '',
      };
    }

    return {
      supported: false,
      reason: 'linux-non-appimage',
    };
  }

  if (runtime.platform === 'darwin') {
    return {
      supported: false,
      reason: 'macos-manual',
    };
  }

  return {
    supported: false,
    reason: 'unsupported-platform',
  };
}

function normalizeRelease(release) {
  if (!release || typeof release !== 'object') {
    return null;
  }

  const version = cleanVersion(release.tag_name || release.name);
  if (!version) {
    return null;
  }

  return {
    version,
    tagName: String(release.tag_name ?? ''),
    name: String(release.name ?? ''),
    url: String(release.html_url ?? ''),
    publishedAt: String(release.published_at ?? ''),
    notes: typeof release.body === 'string' ? release.body : '',
    assets: Array.isArray(release.assets)
      ? release.assets.map((asset) => ({
        name: String(asset?.name ?? ''),
        url: String(asset?.browser_download_url ?? ''),
        size: Number(asset?.size ?? 0),
      })).filter((asset) => asset.name && asset.url)
      : [],
  };
}

async function fetchLatestRelease() {
  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'PaperQuay-Updater',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub release check failed: HTTP ${response.status}${text ? ` ${text}` : ''}`);
  }

  const release = selectLatestForkRelease(await response.json());
  if (!release) {
    throw new Error('No complete published PaperQuay fork prerelease was found.');
  }

  return release;
}

function selectLatestForkRelease(releases) {
  if (!Array.isArray(releases)) {
    return null;
  }

  return releases
    .filter((release) =>
      !release.draft &&
      release.prerelease &&
      FORK_TAG_PATTERN.test(String(release.tag_name ?? '')) &&
      Array.isArray(release.assets) &&
      release.assets.some((asset) => asset.name === 'stable.yml') &&
      release.assets.some((asset) => /^PaperQuay-.*-win-x64\.exe$/i.test(String(asset.name ?? ''))),
    )
    .map(normalizeRelease)
    .filter(Boolean)
    .sort((left, right) => compareVersions(right.version, left.version))[0] ?? null;
}

function releaseDownloadBaseUrl(release) {
  if (!release || !FORK_TAG_PATTERN.test(release.tagName)) {
    throw new Error('Refusing an untrusted PaperQuay fork release tag.');
  }
  return `https://github.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases/download/${encodeURIComponent(release.tagName)}/`;
}

function createUpdateCommands(context) {
  const { app } = context;
  const shell = context.shell ?? require('electron').shell;
  const autoUpdater = context.autoUpdater ?? require('electron-updater').autoUpdater;
  const runtime = context.updateRuntime;
  const releaseFetcher = context.fetchLatestRelease ?? fetchLatestRelease;
  const state = {
    checking: false,
    downloading: false,
    downloaded: false,
    downloadProgress: null,
    error: '',
    latestRelease: null,
    updateAvailableFromUpdater: false,
  };

  autoUpdater.channel = UPDATE_CHANNEL;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (...args) => console.info('[autoUpdater]', ...args),
    warn: (...args) => console.warn('[autoUpdater]', ...args),
    error: (...args) => console.error('[autoUpdater]', ...args),
    debug: (...args) => console.debug('[autoUpdater]', ...args),
  };

  autoUpdater.on('error', (error) => {
    state.error = error instanceof Error ? error.message : String(error ?? '');
    state.checking = false;
    state.downloading = false;
  });

  autoUpdater.on('update-available', () => {
    state.updateAvailableFromUpdater = true;
  });

  autoUpdater.on('update-not-available', () => {
    state.updateAvailableFromUpdater = false;
  });

  autoUpdater.on('download-progress', (progress) => {
    state.downloadProgress = {
      percent: Number(progress?.percent ?? 0),
      transferred: Number(progress?.transferred ?? 0),
      total: Number(progress?.total ?? 0),
      bytesPerSecond: Number(progress?.bytesPerSecond ?? 0),
    };
  });

  autoUpdater.on('update-downloaded', () => {
    state.downloaded = true;
    state.downloading = false;
    state.downloadProgress = {
      percent: 100,
      transferred: state.downloadProgress?.total ?? 0,
      total: state.downloadProgress?.total ?? 0,
      bytesPerSecond: 0,
    };
  });

  function buildStatus(extra = {}) {
    const support = getAutoUpdateSupport(app, runtime);
    const currentVersion = cleanVersion(app.getVersion());
    const latestVersion = state.latestRelease?.version ?? '';
    const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
    const canDownload = Boolean(
      hasUpdate &&
      support.supported &&
      state.updateAvailableFromUpdater &&
      !state.downloading &&
      !state.downloaded,
    );

    return {
      platform: process.platform,
      packaged: app.isPackaged,
      currentVersion,
      latestVersion,
      hasUpdate,
      checking: state.checking,
      downloading: state.downloading,
      downloaded: state.downloaded,
      downloadProgress: state.downloadProgress,
      autoUpdateSupported: support.supported,
      autoUpdateChannel: support.channel ?? '',
      autoUpdateUnsupportedReason: support.reason,
      canDownload,
      canInstall: Boolean(support.supported && state.downloaded),
      error: state.error,
      releaseName: state.latestRelease?.name ?? '',
      releaseNotes: state.latestRelease?.notes ?? '',
      releaseDate: state.latestRelease?.publishedAt ?? '',
      releaseUrl: state.latestRelease?.url ?? `https://github.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases`,
      assets: state.latestRelease?.assets ?? [],
      ...extra,
    };
  }

  async function checkForLatestRelease() {
    state.checking = true;
    state.error = '';

    try {
      state.latestRelease = await releaseFetcher();
      state.downloaded = false;
      state.downloadProgress = null;
      state.updateAvailableFromUpdater = false;

      const support = getAutoUpdateSupport(app, runtime);
      const currentVersion = cleanVersion(app.getVersion());
      const hasUpdate = compareVersions(state.latestRelease.version, currentVersion) > 0;

      if (support.supported && hasUpdate) {
        // GitHubProvider cannot parse the fork's app-v... tag as SemVer. A
        // generic feed scoped to the selected immutable release uses its
        // published stable.yml and NSIS asset without consulting upstream.
        autoUpdater.setFeedURL({ provider: 'generic', url: releaseDownloadBaseUrl(state.latestRelease) });
        const result = await autoUpdater.checkForUpdates();
        state.updateAvailableFromUpdater = Boolean(result?.updateInfo);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error ?? '');
    } finally {
      state.checking = false;
    }

    return buildStatus();
  }

  return {
    app_update_get_status() {
      return buildStatus();
    },

    async app_update_check() {
      return checkForLatestRelease();
    },

    async app_update_download() {
      const status = buildStatus();

      if (!status.autoUpdateSupported) {
        throw new Error('Automatic update installation is not supported on this build.');
      }

      if (!status.hasUpdate) {
        throw new Error('No newer PaperQuay release is available.');
      }

      if (!state.updateAvailableFromUpdater) {
        autoUpdater.setFeedURL({ provider: 'generic', url: releaseDownloadBaseUrl(state.latestRelease) });
        await autoUpdater.checkForUpdates();
      }

      state.downloading = true;
      state.error = '';

      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error ?? '');
        throw error;
      } finally {
        state.downloading = false;
      }

      return buildStatus();
    },

    app_update_install() {
      const status = buildStatus();

      if (!status.canInstall) {
        throw new Error('No downloaded PaperQuay update is ready to install.');
      }

      autoUpdater.quitAndInstall(false, true);
      return buildStatus({ installing: true });
    },

    async app_update_open_release_page() {
      await shell.openExternal(buildStatus().releaseUrl);
      return buildStatus();
    },
  };
}

module.exports = {
  cleanVersion,
  compareVersions,
  createUpdateCommands,
  getAutoUpdateSupport,
  releaseDownloadBaseUrl,
  selectLatestForkRelease,
};
