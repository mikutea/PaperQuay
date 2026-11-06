import { useEffect } from 'react';
import type { PdfVersion } from './types.ts';

/** Only an untouched reader may perform its one initial cache restoration. */
export class InitialPdfOpening {
  private claimed = false;

  beginExplicitOpen(): void { this.claimed = true; }

  claimAutomatic(versions: PdfVersion[], selectedVersionId: string, hasExplicitJump: boolean): PdfVersion | null {
    if (this.claimed || !versions.length || hasExplicitJump) return null;
    this.claimed = true;
    return versions.find((version) => version.entityId === selectedVersionId) ?? versions[0];
  }
}

export function useInitialPdfRestore(opening: InitialPdfOpening, versions: PdfVersion[], selectedVersionId: string,
  hasExplicitJump: boolean, restore: (version: PdfVersion) => void): void {
  useEffect(() => {
    const version = opening.claimAutomatic(versions, selectedVersionId, hasExplicitJump);
    if (version) restore(version);
  }, [opening, versions, selectedVersionId, hasExplicitJump, restore]);
}
