import type { SyncOperation, SyncRecord } from './types.ts';
import { canonicalJson } from './validation.ts';

export const SYNC_FEATURE_HEADER = 'X-PaperQuay-Features';
export const PAPER_ORGANIZATION_FEATURE = 'paper-organization-v1';
export const RICH_NOTES_FEATURE='rich-notes-v1';
export const AI_CONVERSATIONS_FEATURE='ai-conversations-v1';
export interface SyncFeatureSet {richNotes:boolean;aiConversations:boolean}
export const LEGACY_SYNC_FEATURES:Readonly<SyncFeatureSet>=Object.freeze({richNotes:false,aiConversations:false});
/** Closed-schema older clients still advance their cursor through hidden
 * records. New clients must reset the feed once when enabling these features. */
export function supportsSyncRecord(features:SyncFeatureSet,value:Pick<SyncRecord,'entityType'|'data'>):boolean{
  if(value.entityType==='aiConversation'||value.entityType==='aiTemplate')return features.aiConversations;
  return value.entityType!=='note'||value.data===null||!('format'in value.data)||value.data.format!=='tiptap-json'||features.richNotes;
}

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
