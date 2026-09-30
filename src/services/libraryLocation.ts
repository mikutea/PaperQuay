import { invoke } from '../platform/electron/core';

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
export const activateLibraryLocation = (token: string) =>
  invoke<{ restarting?: boolean; canceled?: boolean; unchanged?: boolean }>('library_location_activate', { token });
