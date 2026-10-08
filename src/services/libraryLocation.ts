import { invoke } from '../platform/electron/core';
import { flushReaderConfigWrites } from './readerConfig';

export interface LibraryLocation {
  profileDirectory: string;
  dataDirectory: string;
  databasePath: string;
  registryPath: string;
  registered: boolean;
  paperCount?: number;
  attachmentCount?: number;
}

export interface LibraryLocationCandidate {
  token: string;
  dataDirectory: string;
  databasePath: string;
  paperCount: number;
  attachmentCount: number;
}

export const getLibraryLocation = () => invoke<LibraryLocation>('library_location_status');
export const selectLibraryLocation = () => invoke<LibraryLocationCandidate | null>('library_location_select');
export const activateLibraryLocation = async (token: string) => {
  await flushReaderConfigWrites();
  return invoke<{ restarting?: boolean; canceled?: boolean; unchanged?: boolean }>('library_location_activate', { token });
};
