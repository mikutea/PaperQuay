const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createUpdatePreferences } = require('./updatePreferences.cjs');

const UPDATE_REPOSITORY = {
  owner: 'mikutea',
  repo: 'PaperQuay',
};
const UPDATE_CHANNEL = 'stable';
const RELEASES_API_ROUTE = `repos/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases?per_page=100`;
const RELEASES_API_URL = `https://api.github.com/${RELEASES_API_ROUTE}`;
const GITHUB_ACCEPT = 'application/vnd.github+json';
const execFileAsync = promisify(execFile);
const FORK_TAG_PATTERN = /^app-v\d+\.\d+\.\d+-mikutea\.\d+$/;
const NSIS_INSTALL_MARKER = '.paperquay-nsis-install';
const MSI_INSTALL_MARKER = '.paperquay-msi-install';

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
    const executableDirectory = path.dirname(runtime.executablePath);
    if (fs.existsSync(path.join(executableDirectory, MSI_INSTALL_MARKER))) {
      return { supported: false, reason: 'windows-msi' };
    }
    if (!fs.existsSync(path.join(executableDirectory, NSIS_INSTALL_MARKER))) {
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

function managedUpdaterUsesGitHubCli(executablePath) {
  const executableDirectory = path.dirname(executablePath);
  if (path.basename(executableDirectory).toLowerCase() !== 'app') return false;
  const preferences = path.join(executableDirectory, '..', 'Updater', 'api-preferences.json');
  try {
    const info = fs.lstatSync(preferences);
    if (!info.isFile() || info.size > 4096) return false;
    const saved = JSON.parse(fs.readFileSync(preferences, 'utf8').replace(/^\uFEFF/, ''));
    return saved?.formatVersion === 1 && saved.authentication === 'GitHubCli';
  } catch {
    return false;
  }
}

function findGitHubCli() {
  const directories = (process.env.Path || process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute);
  const programs = process.env.ProgramW6432 || process.env.ProgramFiles;
  if (programs && path.isAbsolute(programs)) directories.unshift(path.join(programs, 'GitHub CLI'));
  return directories.map((directory) => path.join(directory, 'gh.exe')).find((file) => fs.existsSync(file));
}

async function fetchGitHubCliReleases({
  locateGitHubCli = findGitHubCli,
  runGitHubCli = execFileAsync,
} = {}) {
  const executable = locateGitHubCli();
  if (!executable) throw new Error('GITHUB_CLI_MISSING');
  try {
    const { stdout } = await runGitHubCli(executable, [
      'api', '--hostname', 'github.com', '--method', 'GET',
      '-H', `Accept: ${GITHUB_ACCEPT}`, RELEASES_API_ROUTE,
    ], {
      cwd: path.dirname(executable), windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_DEBUG: '', NO_COLOR: '1' },
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error('GITHUB_CLI_RELEASE_CHECK_FAILED');
  }
}

async function fetchAnonymousReleases() {
  const response = await fetch(RELEASES_API_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: GITHUB_ACCEPT,
      'User-Agent': 'PaperQuay-Updater',
    },
  });

  if (!response.ok) {
    if (response.status === 429 || (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
      throw new Error('GITHUB_RELEASE_RATE_LIMITED');
    }
    throw new Error(`GitHub release check failed: HTTP ${response.status}.`);
  }

  return response.json();
}

async function fetchLatestRelease(useGitHubCli, metadata) {
  const releases = useGitHubCli ? await fetchGitHubCliReleases(metadata) : await fetchAnonymousReleases();
  const release = selectLatestForkRelease(releases);
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
      release.assets.some((asset) =>
        asset.name === `PaperQuay-${String(release.tag_name).slice(5)}-win-x64.exe`),
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
  const runtime = context.updateRuntime ?? { platform: process.platform, executablePath: process.execPath };
  const releaseFetcher = context.fetchLatestRelease ?? (() => {
    // The managed portable updater already records the user's authentication choice.
    const useGitHubCli = getAutoUpdateSupport(app, runtime).reason === 'windows-portable' &&
      managedUpdaterUsesGitHubCli(runtime.executablePath);
    return fetchLatestRelease(useGitHubCli, context.updateMetadata);
  });
  const preferences = context.updatePreferences ?? createUpdatePreferences(
    typeof app.getPath === 'function' ? path.join(app.getPath('userData'), 'paperquay-update-preferences.json') : null,
  );
  let checkingPromise = null;
  let startupPromise = null;
  let startupDismissed = false;
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

  // Availability is accepted only after the feed's version is matched to
  // the selected immutable release below, not on the early updater event.

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

  autoUpdater.on('update-downloaded', (info) => {
    if (info?.version && cleanVersion(info.version) !== state.latestRelease?.version) {
      state.error = 'Downloaded update version does not match the selected release.';
      state.downloading = false;
      return;
    }
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
      ...preferences.read(),
      ...extra,
    };
  }

  async function performCheck() {
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
        if (result?.updateInfo && cleanVersion(result.updateInfo.version) !== state.latestRelease.version) {
          throw new Error('Update feed version does not match the selected release. Please try again later.');
        }
        state.updateAvailableFromUpdater = Boolean(result?.updateInfo);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error ?? '');
    } finally {
      state.checking = false;
    }

    return buildStatus();
  }

  function checkForLatestRelease() {
    if (state.downloading || state.downloaded) return Promise.resolve(buildStatus());
    if (!checkingPromise) {
      checkingPromise = performCheck().finally(() => { checkingPromise = null; });
    }
    return checkingPromise;
  }

  return {
    app_update_get_status() {
      return buildStatus();
    },

    async app_update_check() {
      return checkForLatestRelease();
    },

    async app_update_check_startup() {
      if (!startupPromise) {
        startupPromise = app.isPackaged && preferences.read().autoCheckOnStartup
          ? checkForLatestRelease()
          : Promise.resolve(buildStatus());
      }
      await startupPromise;
      const status = buildStatus();
      return {
        ...status,
        showStartupNotice: Boolean(app.isPackaged && preferences.read().autoCheckOnStartup &&
          status.hasUpdate && !status.error && !startupDismissed && status.latestVersion !== status.skippedVersion),
      };
    },

    app_update_set_preferences(args) {
      preferences.write(args ?? {});
      return buildStatus();
    },

    app_update_dismiss_startup(args) {
      if (args?.skipVersion === true && state.latestRelease?.version) {
        preferences.write({ skippedVersion: state.latestRelease.version });
      }
      startupDismissed = true;
      return buildStatus();
    },

    async app_update_download() {
      if (checkingPromise) await checkingPromise;
      const status = buildStatus();

      if (!status.autoUpdateSupported) {
        throw new Error('Automatic update installation is not supported on this build.');
      }

      if (!status.hasUpdate) {
        throw new Error('No newer PaperQuay release is available.');
      }

      if (state.downloading || state.downloaded) return buildStatus();

      if (!state.updateAvailableFromUpdater) {
        throw new Error('The update feed has not been verified. Check for updates again before downloading.');
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

    async app_update_install() {
      const status = buildStatus();

      if (!status.canInstall) {
        throw new Error('No downloaded PaperQuay update is ready to install.');
      }

      await context.prepareForUpdate?.();
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
