import { Download, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  checkForAppUpdate,
  downloadAppUpdate,
  getAppUpdateStatus,
  installAppUpdate,
  openAppUpdateReleasePage,
  type AppUpdateStatus,
} from '../../services/appUpdate';
import { SettingsField } from './readerPreferencesPrimitives';
import type { ReaderPreferencesLocalizer } from './readerPreferencesTypes';

function formatDate(value: string): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString();
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function updateSupportText(status: AppUpdateStatus | null, l: ReaderPreferencesLocalizer): string {
  if (!status) {
    return l('正在读取更新状态', 'Reading update status');
  }

  if (status.autoUpdateSupported) {
    return status.autoUpdateChannel === 'appimage'
      ? l('Linux AppImage 自动更新', 'Linux AppImage automatic updates')
      : l('Windows 安装包自动更新', 'Windows installer automatic updates');
  }

  if (status.autoUpdateUnsupportedReason === 'macos-manual') {
    return l('macOS 当前提供更新检查和手动下载', 'macOS currently supports update checks and manual downloads');
  }

  if (status.autoUpdateUnsupportedReason === 'linux-non-appimage') {
    return l('当前 Linux 包需要手动下载新版', 'This Linux package requires manual downloads');
  }

  if (status.autoUpdateUnsupportedReason === 'development') {
    return l('开发环境仅检查 GitHub 最新版本', 'Development mode checks the latest GitHub version only');
  }

  if (status.autoUpdateUnsupportedReason === 'windows-portable') {
    return l(
      '免安装版请使用已验证的 fork 更新脚本或手动下载新版 ZIP；此处不运行 NSIS 安装更新。',
      'For the portable build, use the verified fork updater or download a new ZIP. NSIS installation is disabled here.',
    );
  }

  return l('当前平台需要手动下载新版', 'This platform requires manual downloads');
}

function updateHeadline(status: AppUpdateStatus | null, l: ReaderPreferencesLocalizer): string {
  if (!status) {
    return l('尚未检查更新', 'No update check yet');
  }

  if (status.error) {
    return l('更新检查失败', 'Update check failed');
  }

  if (status.downloaded) {
    return l('新版已下载完成', 'Update downloaded');
  }

  if (status.downloading) {
    return l('正在下载新版', 'Downloading update');
  }

  if (status.hasUpdate) {
    return l(`发现新版本 ${status.latestVersion}`, `Version ${status.latestVersion} is available`);
  }

  if (status.latestVersion) {
    return l('已是最新版本', 'You are up to date');
  }

  return l('尚未检查更新', 'No update check yet');
}

export function ReaderPreferencesUpdateSection({
  active,
  l,
}: {
  active: boolean;
  l: ReaderPreferencesLocalizer;
}) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [working, setWorking] = useState<'checking' | 'downloading' | 'installing' | ''>('');
  const [message, setMessage] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getAppUpdateStatus());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }

    void refreshStatus();
  }, [active, refreshStatus]);

  const visibleAssets = useMemo(
    () => (status?.assets ?? []).filter((asset) =>
      /\.(exe|msi|appimage|deb|dmg|zip|tar\.gz)$/i.test(asset.name),
    ),
    [status?.assets],
  );

  if (!active) {
    return null;
  }

  const checking = working === 'checking' || Boolean(status?.checking);
  const downloading = working === 'downloading' || Boolean(status?.downloading);
  const installing = working === 'installing' || Boolean(status?.installing);
  const progress = status?.downloadProgress?.percent ?? 0;

  const handleCheck = async () => {
    setWorking('checking');
    setMessage(l('正在检查更新...', 'Checking for updates...'));

    try {
      const nextStatus = await checkForAppUpdate();
      setStatus(nextStatus);
      setMessage(
        nextStatus.hasUpdate
          ? l(`发现新版本 ${nextStatus.latestVersion}`, `Version ${nextStatus.latestVersion} is available`)
          : l('当前已经是最新版本。', 'PaperQuay is already up to date.'),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking('');
    }
  };

  const handleDownload = async () => {
    setWorking('downloading');
    setMessage(l('正在下载更新...', 'Downloading update...'));
    setStatus((current) => current ? { ...current, downloading: true } : current);

    const pollId = window.setInterval(() => {
      void getAppUpdateStatus().then(setStatus).catch(() => undefined);
    }, 900);

    try {
      const nextStatus = await downloadAppUpdate();
      setStatus(nextStatus);
      setMessage(l('更新已下载，重启后安装。', 'Update downloaded. Restart to install it.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      await refreshStatus();
    } finally {
      window.clearInterval(pollId);
      setWorking('');
    }
  };

  const handleInstall = async () => {
    setWorking('installing');
    setMessage(l('正在重启并安装更新...', 'Restarting to install the update...'));

    try {
      setStatus(await installAppUpdate());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setWorking('');
    }
  };

  const handleOpenRelease = async () => {
    try {
      setStatus(await openAppUpdateReleasePage());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <SettingsField
      label={l('软件更新', 'Software Updates')}
      description={l(
        'Windows NSIS 安装版和 Linux AppImage 可自动下载并安装；免安装版与 macOS 可检查并手动下载。',
        'Windows NSIS installers and Linux AppImage can download and install automatically. Portable builds and macOS check updates for manual download.',
      )}
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-[var(--pq-surface-2)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-[var(--pq-text)]">
                {updateHeadline(status, l)}
              </div>
              <div className="mt-1 text-xs leading-5 text-slate-500 dark:text-[var(--pq-text-muted)]">
                {updateSupportText(status, l)}
              </div>
            </div>
            <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)]">
              {status?.packaged
                ? l('已打包版本', 'Packaged build')
                : l('开发环境', 'Development')}
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-[var(--pq-surface-1)]">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                {l('当前版本', 'Current')}
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-[var(--pq-text)]">
                {status?.currentVersion || '-'}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-[var(--pq-surface-1)]">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                {l('最新版本', 'Latest')}
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-[var(--pq-text)]">
                {status?.latestVersion || l('未检查', 'Not checked')}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-[var(--pq-surface-1)]">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                {l('发布时间', 'Released')}
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-[var(--pq-text)]">
                {formatDate(status?.releaseDate ?? '') || '-'}
              </div>
            </div>
          </div>
        </div>

        {downloading ? (
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 dark:border-white/10 dark:bg-[var(--pq-surface-2)]">
            <div className="flex items-center justify-between text-xs font-medium text-indigo-700 dark:text-[var(--pq-accent)]">
              <span>{l('下载进度', 'Download Progress')}</span>
              <span>{formatPercent(progress)}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/80 dark:bg-[var(--pq-surface-1)]">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all duration-300 dark:bg-[var(--pq-accent)]"
                style={{ width: formatPercent(progress) }}
              />
            </div>
          </div>
        ) : null}

        {message || status?.error ? (
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs leading-5 text-slate-600 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text-muted)]">
            {status?.error || message}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCheck}
            disabled={checking || downloading || installing}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-[var(--pq-accent-button-bg)] dark:text-[var(--pq-accent-button-text)]"
          >
            <RefreshCw
              className={checking ? 'mr-2 inline h-4 w-4 animate-spin' : 'mr-2 inline h-4 w-4'}
              strokeWidth={1.8}
            />
            {checking ? l('检查中...', 'Checking...') : l('检查更新', 'Check for Updates')}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!status?.canDownload || checking || downloading || installing}
            className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:bg-[var(--pq-surface-2)] dark:text-[var(--pq-text)] dark:hover:bg-[var(--pq-hover)]"
          >
            <Download className="mr-2 inline h-4 w-4" strokeWidth={1.8} />
            {downloading ? l('下载中...', 'Downloading...') : l('下载更新', 'Download Update')}
          </button>
          <button
            type="button"
            onClick={handleInstall}
            disabled={!status?.canInstall || checking || downloading || installing}
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200"
          >
            <RotateCcw className="mr-2 inline h-4 w-4" strokeWidth={1.8} />
            {installing ? l('重启中...', 'Restarting...') : l('重启安装', 'Restart and Install')}
          </button>
          <button
            type="button"
            onClick={handleOpenRelease}
            disabled={installing}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-white/10 dark:bg-[var(--pq-surface-1)] dark:text-[var(--pq-text)] dark:hover:bg-[var(--pq-hover)]"
          >
            <ExternalLink className="mr-2 inline h-4 w-4" strokeWidth={1.8} />
            {l('打开下载页', 'Open Downloads')}
          </button>
        </div>

        {visibleAssets.length > 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-white/10 dark:bg-[var(--pq-surface-2)]">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
              {l('发布资产', 'Release Assets')}
            </div>
            <div className="space-y-1">
              {visibleAssets.slice(0, 6).map((asset) => (
                <button
                  key={asset.url}
                  type="button"
                  onClick={() => void openAppUpdateReleasePage().then(setStatus)}
                  className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-xs text-slate-600 transition hover:bg-white dark:text-[var(--pq-text-muted)] dark:hover:bg-[var(--pq-surface-1)]"
                >
                  {asset.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </SettingsField>
  );
}
