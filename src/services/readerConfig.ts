import {
  getAppDefaultPaths,
  readAppConfig,
  writeLocalTextFile,
  type AppDefaultPaths,
} from './desktop';
import type { ReaderConfigFile } from '../types/reader';
import { createDebouncedSave } from './debouncedSave';

interface ScheduledConfig {
  content: string;
  paths: AppDefaultPaths;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

const scheduledWrites = createDebouncedSave<ScheduledConfig>({
  delayMs: 350,
  async save({ content, paths, onSaved, onError }) {
    try {
      await writeLocalTextFile(paths.configPath, content);
    } catch (error) {
      onError(error);
      throw error;
    }
    onSaved();
  },
  onError: (error) => console.error('Failed to persist reader config to file.', error),
});

export function scheduleReaderConfigWrite(
  config: Partial<ReaderConfigFile>,
  paths: AppDefaultPaths,
  onSaved: () => void,
  onError: (error: unknown) => void,
) {
  scheduledWrites.schedule({ content: JSON.stringify(config, null, 2), paths, onSaved, onError });
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
