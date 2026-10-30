export interface ReviewFigureCandidate {
  id: string;
  sourceId?: string;
  title?: string;
  sourceTitle?: string;
  caption: string;
  path: string;
  pageIndex?: number;
  blockId?: string;
  kind: 'image' | 'table' | string;
}

export interface ReviewJsonFigure extends ReviewFigureCandidate {
  placement?: string;
  reason?: string;
}

export interface ReviewContextItem {
  id: string;
  sourceType: 'paper' | 'note' | 'summary';
  title: string;
  authors?: string;
  year?: string;
  journal?: string;
  pages?: string;
  doi?: string;
  text: string;
  paperId?: string;
  noteId?: string;
  score?: number;
  figures?: ReviewFigureCandidate[];
}

export interface ReviewJsonSection {
  id?: string;
  heading: string;
  content: string;
  citations: string[];
}

export interface ReviewBlueprintTask {
  id?: string;
  task: string;
  evidenceIds: string[];
  retrievalNotes?: string;
  keyEvidence?: string[];
  target?: string;
}

export interface ReviewBlueprintSection extends ReviewBlueprintTask {
  id: string;
  heading: string;
  paragraphTasks: ReviewBlueprintTask[];
}

export interface ReviewBlueprintComparison extends ReviewBlueprintTask {
  id: string;
  theme: string;
}

export interface ReviewBlueprint {
  title: string;
  keywords: string[];
  intentSummary: string;
  thesis: string;
  abstractTask: ReviewBlueprintTask;
  introductionTask: ReviewBlueprintTask;
  sections: ReviewBlueprintSection[];
  comparisonTable: ReviewBlueprintComparison[];
  researchGaps: ReviewBlueprintTask[];
  futureDirections: ReviewBlueprintTask[];
  conclusionTask: ReviewBlueprintTask;
  references: ReviewJsonReference[];
  sources: ReviewJsonSource[];
  figures: ReviewJsonFigure[];
}

export interface ReviewJsonComparisonRow {
  theme: string;
  papers: string[];
  conclusion: string;
}

export interface ReviewJsonReference {
  id: string;
  title: string;
  authors: string;
  year: string;
  journal?: string;
  pages?: string;
  doi: string;
}

export interface ReviewJsonSource {
  id: string;
  title: string;
  sourceType: string;
  relevance: string;
}

export interface ReviewJsonDraft {
  title: string;
  abstract: string;
  keywords: string[];
  intentSummary: string;
  thesis: string;
  introduction: string;
  sections: ReviewJsonSection[];
  comparisonTable: ReviewJsonComparisonRow[];
  researchGaps: string[];
  futureDirections: string[];
  conclusion: string;
  references: ReviewJsonReference[];
  sources: ReviewJsonSource[];
  figures: ReviewJsonFigure[];
}

export interface ReviewGeneratedPart {
  content: string;
  citations: string[];
}

export interface ReviewGeneratedPartsCheckpoint {
  abstract?: ReviewGeneratedPart | null;
  introduction?: ReviewGeneratedPart | null;
  sectionParagraphs?: Array<Array<ReviewGeneratedPart | null>>;
  comparisonTable?: Array<ReviewGeneratedPart | null>;
  researchGaps?: Array<ReviewGeneratedPart | null>;
  futureDirections?: Array<ReviewGeneratedPart | null>;
  conclusion?: ReviewGeneratedPart | null;
}
