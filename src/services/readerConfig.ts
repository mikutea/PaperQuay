import {
  getAppDefaultPaths,
  readAppConfig,
  writeLocalTextFile,
  type AppDefaultPaths,
} from './desktop';
import type { ReaderConfigFile } from '../types/reader';

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
