import type { JSONContent } from '@tiptap/core';
import type { BBox, BBoxCoordinateSystem, BBoxPageSize } from './reader';

export type NoteType = 'highlight' | 'area' | 'standalone' | 'ai-chat';

export interface NotePdfLocation {
  pageNumber: number;
  boundingRect?: { x: number; y: number; width: number; height: number };
  bbox?: BBox;
  bboxCoordinateSystem?: BBoxCoordinateSystem;
  bboxPageSize?: BBoxPageSize;
  highlightColor?: string;
}

export interface NoteAnchor {
  id: string;
  paperId?: string;
  label: string;
  sourceTitle?: string;
  excerpt: string;
  source?: 'pdf' | 'blocks' | 'ai-chat' | 'manual';
  blockId?: string | null;
  pageIndex?: number | null;
  pdfLocation?: NotePdfLocation;
  createdAt: number;
  verification?: 'unverified';
}

export interface NoteUnresolvedReference {
  kind: 'note' | 'paper' | 'folder' | 'ai-chat';
  id: string;
  label: string;
  reason: 'unmapped' | 'missing' | 'historical-unverified';
}

export interface NoteAnchorInsertRequest {
  requestId: string;
  noteId?: string;
  anchor: NoteAnchor;
}

export interface Note {
  id: string;
  paperId: string;
  type: NoteType;
  title: string;
  content: string;
  contentJson?: JSONContent | null;
  contentHtml?: string | null;
  contentText?: string | null;
  excerpt?: string;
  pdfLocation?: NotePdfLocation;
  aiChatId?: string;
  aiChatMessageIds: string[];
  anchors: NoteAnchor[];
  linkedPaperId?: string | null;
  folderId?: string | null;
  tags: string[];
  color: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  wordCount?: number;
  isFavorite?: boolean;
  isPinned?: boolean;
  linkedNoteIds: string[];
  linkedPaperIds: string[];
  unresolvedReferences?: NoteUnresolvedReference[];
  backlinks?: NoteBacklink[];
}

export interface NoteBacklink {
  sourceNoteId: string;
  targetNoteId: string;
  linkText: string;
  sourceTitle: string;
  sourceExcerpt?: string | null;
  sourceUpdatedAt: number;
  createdAt: number;
}

export interface NoteTagSummary {
  tag: string;
  count: number;
}

export interface ListNotesRequest {
  paperId?: string | null;
  linkedPaperId?: string | null;
  type?: NoteType | null;
  tag?: string | null;
  search?: string | null;
  includeDeleted?: boolean;
  limit?: number;
}

export interface CreateNoteRequest {
  paperId: string;
  type: NoteType;
  title: string;
  content?: string;
  contentJson?: JSONContent | null;
  contentHtml?: string | null;
  contentText?: string | null;
  excerpt?: string | null;
  pdfLocation?: NotePdfLocation | null;
  aiChatId?: string | null;
  aiChatMessageIds?: string[];
  anchors?: NoteAnchor[];
  linkedPaperId?: string | null;
  folderId?: string | null;
  tags?: string[];
  color?: string;
  wordCount?: number;
  isFavorite?: boolean;
  isPinned?: boolean;
  linkedNoteIds?: string[];
  linkedPaperIds?: string[];
  linkedNoteTitles?: string[];
  unresolvedReferences?: NoteUnresolvedReference[];
}

export type UpdateNoteRequest = Partial<Omit<CreateNoteRequest, 'paperId'>> & {
  paperId?: string;
  deletedAt?: number | null;
};
