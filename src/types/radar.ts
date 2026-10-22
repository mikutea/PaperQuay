import type { LiteraturePaper } from './library';

export type RadarSource = 'crossref' | 'openalex';
export type RankingKey = 'relevance' | 'priority' | 'methods' | 'recency';
export type ReadingStatus = 'unread' | 'later' | 'read';

export interface RadarTopicConfig {
  name: string;
  queries: string[];
  includeTerms: string[];
  excludeTerms: string[];
  priorityTerms: string[];
  methodTerms: string[];
  sources: RadarSource[];
  lookbackDays: number;
  intervalHours: number;
  enabled: boolean;
  weights: Record<RankingKey, number>;
}

export interface RadarSourceReport {
  source: RadarSource;
  query: string;
  received: number;
  total: number;
  limited: boolean;
  error: string | null;
}

export interface RadarTopic extends RadarTopicConfig {
  id: string;
  revision: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  lastRun: {
    at: number;
    status: 'success' | 'partial' | 'failed' | 'cancelled';
    added: number;
    known: number;
    capacity: boolean;
    reports: RadarSourceReport[];
    message?: string;
  } | null;
}

export interface PaperRanking {
  score: number;
  excluded: boolean;
  reasons: Array<{ key: RankingKey; points: number; max: number; matched: string[] }>;
}

export interface RadarCandidate {
  id: string;
  title: string;
  authors: string[];
  year: string;
  doi: string;
  publication: string;
  url: string;
  abstractText: string;
  sources: RadarSource[];
  topicIds: string[];
  discoveredAt: number;
  dismissed: boolean;
  paperId: string | null;
  hasPdf: boolean;
  ranking: PaperRanking | null;
}

export interface ReadingQueueItem extends PaperRanking {
  paper: LiteraturePaper;
  pinned: boolean;
  status: ReadingStatus;
  evidence: 'pdf-available' | 'abstract' | 'metadata';
}

export interface RadarSnapshot {
  topics: RadarTopic[];
  candidates: RadarCandidate[];
  queue: ReadingQueueItem[];
  activeTopicId: string | null;
  selectedTopicId: string | null;
}
