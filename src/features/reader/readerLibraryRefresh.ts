export class SupersededLibraryRefreshError extends Error {
  constructor() {
    super('An older library refresh was superseded by a newer request.');
    this.name = 'SupersededLibraryRefreshError';
  }
}

export function shouldReportLibraryRefreshError(error: unknown, cancelled: boolean): boolean {
  return !cancelled && !(error instanceof SupersededLibraryRefreshError);
}
