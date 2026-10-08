import {
  getAppDefaultPaths,
  readAppConfig,
  writeLocalTextFile,
  type AppDefaultPaths,
} from './desktop';
import type { ReaderConfigFile } from '../types/reader';
import { createDebouncedSave } from './debouncedSave';
import { getLibrarySettings, updateLibrarySettings } from './library';
import type { LibrarySettings } from '../types/library';

interface ScheduledConfig {
  content: string;
  zoteroLocalDataDir?: string;
  paths: AppDefaultPaths;
  onSaved: (nativeSettings?: LibrarySettings) => void;
  onError: (error: unknown) => void;
}

const scheduledWrites = createDebouncedSave<ScheduledConfig>({
  delayMs: 350,
  async save({ content, zoteroLocalDataDir, paths, onSaved, onError }) {
    let nativeSettings: LibrarySettings | undefined;
    try {
      // Hydration prefers this native value. It is part of the same awaitable
      // save as the config file, not a component-owned timer lost on restart.
      if (zoteroLocalDataDir !== undefined) {
        nativeSettings = await getLibrarySettings();
        if (nativeSettings.zoteroLocalDataDir.trim() !== zoteroLocalDataDir) {
          nativeSettings = await updateLibrarySettings({ zoteroLocalDataDir });
        }
      }
      await writeLocalTextFile(paths.configPath, content);
    } catch (error) {
      onError(error);
      throw error;
    }
    onSaved(nativeSettings);
  },
  onError: (error) => console.error('Failed to persist reader config to file.', error),
});

export function scheduleReaderConfigWrite(
  config: Partial<ReaderConfigFile>,
  paths: AppDefaultPaths,
  onSaved: (nativeSettings?: LibrarySettings) => void,
  onError: (error: unknown) => void,
) {
  scheduledWrites.schedule({ content: JSON.stringify(config, null, 2), zoteroLocalDataDir: config.zoteroLocalDataDir?.trim(), paths, onSaved, onError });
}

export function flushReaderConfigWrites(): Promise<void> {
  return scheduledWrites.flush();
}

export async function readReaderConfigFile(
  _defaultPaths?: AppDefaultPaths | null,
): Promise<Partial<ReaderConfigFile> | null> {
  const configText = await readAppConfig();

  if (!configText) {
    return null;
  }

  return JSON.parse(configText) as Partial<ReaderConfigFile>;
}

export async function writeReaderConfigFile(
  config: Partial<ReaderConfigFile>,
  defaultPaths?: AppDefaultPaths | null,
): Promise<void> {
  const paths = defaultPaths ?? await getAppDefaultPaths();
  await writeLocalTextFile(paths.configPath, JSON.stringify(config, null, 2));
}
