export type KnowledgeGraphNodeType = 'paper' | 'note' | 'tag' | 'category' | 'reference';

export type KnowledgeGraphEdgeType =
  | 'paper_tag'
  | 'note_tag'
  | 'paper_category'
  | 'note_link'
  | 'note_paper'
  | 'related_by_embedding'
  | 'paper_cites_paper'
  | 'paper_reference'
  | 'co_author'
  | 'custom_relation'
  | 'ai_suggested';

export interface KnowledgeGraphNode {
  id: string;
  type: KnowledgeGraphNodeType;
  label: string;
  subtitle?: string;
  paperId?: string;
  noteId?: string;
  tag?: string;
  categoryId?: string;
  referenceId?: string;
  doi?: string;
  size?: number;
  score?: number;
}

export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  type: KnowledgeGraphEdgeType;
  label: string;
  description?: string;
  confidence?: number;
  weight?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface KnowledgeGraphSnapshot {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  generatedAt: number;
}

export interface KnowledgeGraphRequest {
  includePapers?: boolean;
  includeNotes?: boolean;
  includeTags?: boolean;
  includeCategories?: boolean;
  includeReferences?: boolean;
  includeCoAuthors?: boolean;
  includeCustomRelations?: boolean;
  includeEmbeddingEdges?: boolean;
  embeddingEdgeLimit?: number;
  embeddingMinSimilarity?: number;
  search?: string | null;
  localNodeId?: string | null;
  localDepth?: number;
}

export interface KnowledgeGraphRelation {
  id: string;
  source: string;
  target: string;
  type: 'custom_relation' | 'ai_suggested';
  label: string;
  description?: string;
  confidence?: number;
  weight?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface KnowledgeGraphRelationCreateRequest {
  source: string;
  target: string;
  type?: 'custom_relation' | 'ai_suggested';
  label: string;
  description?: string;
  confidence?: number;
  weight?: number;
}

export interface KnowledgeGraphAiRelationSuggestion {
  sourceId: string;
  targetId: string;
  label: string;
  description: string;
  confidence: number;
}

export interface KnowledgeGraphAiSuggestRequest {
  focusNodeId?: string | null;
  localDepth?: number;
  maxRelations?: number;
  embeddingMinSimilarity?: number;
}

export interface KnowledgeGraphAiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiMode?: 'chat_completions' | 'responses';
  temperature?: number;
  reasoningEffort?: string;
}
