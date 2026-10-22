import { invoke } from '../platform/electron/core';
import type { LiteraturePaper } from '../types/library';
import type { RadarSnapshot, RadarTopic, RadarTopicConfig, ReadingStatus } from '../types/radar';

export const RADAR_CHANGED_EVENT = 'radar:changed';
export const LIBRARY_CONTENT_CHANGED_EVENT = 'paperquay:library-content-changed';
export const getRadarSnapshot = (topicId?: string | null) => invoke<RadarSnapshot>('radar_get_snapshot', { topicId });
export const saveRadarTopic = (topic: RadarTopicConfig & { id?: string }) => invoke<RadarTopic>('radar_save_topic', { topic });
export const deleteRadarTopic = (topicId: string) => invoke<void>('radar_delete_topic', { topicId });
export const runRadar = (topicId: string) => invoke<RadarSnapshot>('radar_run', { topicId });
export const cancelRadar = () => invoke<void>('radar_cancel');
export const setRadarCandidateDismissed = (candidateId: string, dismissed: boolean) => invoke<void>('radar_set_candidate', { candidateId, dismissed });
export const setReadingQueueState = (paperId: string, patch: { status?: ReadingStatus; pinned?: boolean }) =>
  invoke<void>('radar_set_queue', { paperId, ...patch });

function libraryChanged() { window.dispatchEvent(new CustomEvent(LIBRARY_CONTENT_CHANGED_EVENT)); }
export async function importRadarCandidate(candidateId: string) {
  try { return await invoke<LiteraturePaper>('radar_import_candidate', { candidateId }); }
  finally { libraryChanged(); }
}
export async function attachRadarPdf(paperId: string, sourcePath: string) {
  const paper = await invoke<LiteraturePaper>('radar_attach_pdf', { paperId, sourcePath });
  libraryChanged();
  return paper;
}
