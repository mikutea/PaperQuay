import { normalizeText, tokenize } from '../../../packages/review-core/queryTokens.mts';
export { tokenize };
import type { LiteraturePaper } from '../../types/library';
import type { Note } from '../../types/notes';

// Pure, dependency-free retrieval helpers for the literature-review workspace.
// Runtime imports must remain platform-independent, so node --test can load it directly.

export type ScoredPaper = { paper: LiteraturePaper; score: number };
export type ScoredNote = { note: Note; score: number };

export const MAX_CONTEXT_ITEMS = 18;
const MIXED_PAPER_LIMIT = 12;

// Weighted scoring fields: title hits matter most, authors least.
const FIELD_WEIGHTS = {
  title: 3,
  keywords: 2,
  tags: 2,
  abstract: 1.2,
  summary: 1,
  note: 1,
  authors: 0.6,
} as const;

function countHits(tokens: string[], text: string | null | undefined): number {
  if (!text) {
    return 0;
  }
  const haystack = normalizeText(text);
  if (!haystack) {
    return 0;
  }
  return tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
}

export function paperAuthorsText(paper: LiteraturePaper): string {
  return paper.authors.map((author) => author.name).filter(Boolean).join('; ');
}

/**
 * Weighted relevance score for a paper against query tokens.
 * Returns 0 when nothing matches (callers should treat 0 as "no result").
 */
export function scorePaper(tokens: string[], paper: LiteraturePaper): number {
  if (tokens.length === 0) {
    return 0;
  }

  return (
    countHits(tokens, paper.title) * FIELD_WEIGHTS.title +
    countHits(tokens, paper.keywords.join(' ')) * FIELD_WEIGHTS.keywords +
    countHits(tokens, paper.tags.map((tag) => tag.name).join(' ')) * FIELD_WEIGHTS.tags +
    countHits(tokens, paper.abstractText) * FIELD_WEIGHTS.abstract +
    countHits(tokens, paper.aiSummary) * FIELD_WEIGHTS.summary +
    countHits(tokens, paper.userNote) * FIELD_WEIGHTS.note +
    countHits(tokens, paperAuthorsText(paper)) * FIELD_WEIGHTS.authors
  );
}

export function scoreNote(tokens: string[], note: Note): number {
  if (tokens.length === 0) {
    return 0;
  }

  const anchorsText = note.anchors.map((anchor) => `${anchor.label} ${anchor.excerpt}`).join('\n');

  return (
    countHits(tokens, note.title) * FIELD_WEIGHTS.title +
    countHits(tokens, note.tags.join(' ')) * FIELD_WEIGHTS.tags +
    countHits(tokens, note.contentText || note.content) * FIELD_WEIGHTS.abstract +
    countHits(tokens, note.excerpt) * FIELD_WEIGHTS.summary +
    countHits(tokens, anchorsText) * FIELD_WEIGHTS.note
  );
}

export interface RetrieveOptions {
  // When true, the source scope is papers-only / notes-only (single source),
  // so that source may use the full MAX_CONTEXT_ITEMS budget.
  soloSource?: boolean;
  // Number of items already taken by the other source (to share the budget).
  reservedCount?: number;
}

/**
 * Retrieve papers ranked by relevance to the query.
 * Returns ONLY papers with score > 0. Empty query or no matches -> [].
 * (No "fall back to recent N" — that was the original bug.)
 */
export function retrievePapers(
  query: string,
  papers: LiteraturePaper[],
  options: RetrieveOptions = {},
): ScoredPaper[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  const limit = options.soloSource
    ? MAX_CONTEXT_ITEMS
    : Math.min(MIXED_PAPER_LIMIT, MAX_CONTEXT_ITEMS);

  return papers
    .map((paper) => ({ paper, score: scorePaper(tokens, paper) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.paper.updatedAt - left.paper.updatedAt)
    .slice(0, limit);
}

/**
 * Retrieve notes ranked by relevance to the query.
 * Returns ONLY notes with score > 0. Empty query or no matches -> [].
 */
export function retrieveNotes(
  query: string,
  notes: Note[],
  options: RetrieveOptions = {},
): ScoredNote[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  const limit = options.soloSource
    ? MAX_CONTEXT_ITEMS
    : Math.max(0, MAX_CONTEXT_ITEMS - (options.reservedCount ?? 0));

  return notes
    .map((note) => ({ note, score: scoreNote(tokens, note) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.note.updatedAt - left.note.updatedAt)
    .slice(0, limit);
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
