import type { SyncOperation, SyncRecord } from './types.ts';
import { canonicalJson } from './validation.ts';

export const SYNC_FEATURE_HEADER = 'X-PaperQuay-Features';
export const PAPER_ORGANIZATION_FEATURE = 'paper-organization-v1';

/** M1 clients validate a closed paper schema. Their records remain that shape. */
export function projectLegacyPaper<T extends SyncRecord | SyncOperation>(record: T): T {
  if (record.entityType !== 'paper' || !record.data?.organization) return record;
  const { organization: _organization, ...data } = record.data;
  return { ...record, data } as T;
}

/** The only same-revision difference allowed during a negotiated M1 hydration. */
export function isPaperOrganizationHydration(previous: SyncRecord, next: SyncRecord): boolean {
  if (previous.entityType !== 'paper' || next.entityType !== 'paper'
    || !previous.data || !next.data || previous.data.organization !== undefined
    || next.data.organization === undefined) return false;
  return canonicalJson(previous) === canonicalJson(projectLegacyPaper(next));
}
