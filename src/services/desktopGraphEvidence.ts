import { invoke } from '../platform/electron/core';
import type { GraphEvidenceSnapshot } from '../../packages/sync-core/src/graphEvidence';

export interface DesktopGraphEvidenceStatus { scopeKey: string | null; busy: boolean; errorCode: string | null }
export interface DesktopGraphEvidencePaper { localPaperId: string; title: string; bound: boolean; versionCount: number }
export interface DesktopGraphEvidenceList { scopeKey: string | null; papers: DesktopGraphEvidencePaper[] }
export interface DesktopGraphEvidenceInput { localPaperIds: string[]; includeReferences: boolean; includeSimilarity: boolean }
export interface DesktopGraphEvidencePreview {
  token: string; scopeKey: string; snapshot: GraphEvidenceSnapshot;
  skipped: { localPaperId?: string; code: string; label?: string }[];
  counts: { sources: number; citations: number; similarities: number; skipped: number };
}
export interface DesktopGraphEvidenceExportResult { saved: boolean; cancelled?: boolean }
export const desktopGraphEvidence = {
  status: () => invoke<DesktopGraphEvidenceStatus>('desktop_graph_evidence_status'),
  list: () => invoke<DesktopGraphEvidenceList>('desktop_graph_evidence_list'),
  preview: (input: DesktopGraphEvidenceInput) => invoke<DesktopGraphEvidencePreview>('desktop_graph_evidence_preview', { ...input }),
  export: (input: { token: string }) => invoke<DesktopGraphEvidenceExportResult>('desktop_graph_evidence_export', input),
};
