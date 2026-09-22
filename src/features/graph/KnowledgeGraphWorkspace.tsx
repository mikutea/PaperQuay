import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from 'cytoscape';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Crosshair,
  Download,
  FileJson2,
  Link2,
  FileText,
  Filter,
  GitBranch,
  Loader2,
  Maximize2,
  Network,
  RefreshCw,
  Search,
  Trash2,
  StickyNote,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { emitOpenLibraryPaper } from '../../app/appEvents';
import { useAppLocale, useLocaleText } from '../../i18n/uiLanguage';
import {
  createKnowledgeGraphRelation,
  deleteKnowledgeGraphRelation,
  getKnowledgeGraph,
  suggestKnowledgeGraphRelations,
} from '../../services/knowledgeGraph';
import {
  fetchAllLibraryReferences,
  listenLibraryReferenceProgress,
} from '../../services/library';
import { readReaderConfigFile } from '../../services/readerConfig';
import { useTabsStore } from '../../stores/useTabsStore';
import { useThemeStore } from '../../stores/useThemeStore';
import type {
  KnowledgeGraphAiRelationSuggestion,
  KnowledgeGraphEdge,
  KnowledgeGraphEdgeType,
  KnowledgeGraphNode,
  KnowledgeGraphNodeType,
  KnowledgeGraphSnapshot,
} from '../../types/knowledgeGraph';
import type { LibraryReferenceProgress } from '../../types/library';
import type { QaModelPreset, ReaderConfigFile, ReaderSecrets, ReaderSettings } from '../../types/reader';
import { cn } from '../../utils/cn';
import {
  DEFAULT_QA_PRESET_ID,
  DEFAULT_SETTINGS,
  getModelRuntimeConfig,
  normalizeQaModelPresets,
  normalizeReaderSettings,
  resolveModelPreset,
  SECRETS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from '../reader/readerShared';

type LayoutMode = 'global' | 'local';
type GraphPerspective = 'mixed' | 'paper' | 'note' | 'reference' | 'semantic' | 'custom';
type GraphContextMenuState = {
  x: number;
  y: number;
  node: KnowledgeGraphNode;
} | null;

function areStringSetsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

const EDGE_COLORS: Record<KnowledgeGraphEdgeType, string> = {
  related_by_embedding: '#0ea5e9',
  note_paper: '#22c55e',
  note_link: '#84cc16',
  paper_tag: '#f59e0b',
  note_tag: '#eab308',
  paper_category: '#8b5cf6',
  paper_cites_paper: '#ef4444',
  paper_reference: '#64748b',
  co_author: '#06b6d4',
  custom_relation: '#14b8a6',
  ai_suggested: '#ec4899',
};

const nodeTypes: Array<{
  type: KnowledgeGraphNodeType;
  zh: string;
  en: string;
  icon: typeof FileText;
}> = [
  { type: 'paper', zh: '文献', en: 'Papers', icon: FileText },
  { type: 'note', zh: '笔记', en: 'Notes', icon: StickyNote },
  { type: 'tag', zh: '标签', en: 'Tags', icon: Filter },
  { type: 'category', zh: '分类', en: 'Collections', icon: GitBranch },
  { type: 'reference', zh: '引用', en: 'References', icon: Link2 },
];

const edgeTypes: Array<{
  type: KnowledgeGraphEdgeType;
  zh: string;
  en: string;
}> = [
  { type: 'co_author', zh: '共同作者', en: 'Co-authors' },
  { type: 'related_by_embedding', zh: '语义相似', en: 'Embedding Related' },
  { type: 'note_paper', zh: '笔记引用文献', en: 'Note to Paper' },
  { type: 'note_link', zh: '笔记链接', en: 'Note Links' },
  { type: 'paper_tag', zh: '文献标签', en: 'Paper Tags' },
  { type: 'note_tag', zh: '笔记标签', en: 'Note Tags' },
  { type: 'paper_category', zh: '分类', en: 'Collections' },
  { type: 'paper_cites_paper', zh: '文献互引', en: 'Paper Citations' },
  { type: 'paper_reference', zh: '外部参考文献', en: 'External References' },
  { type: 'custom_relation', zh: '自定义关系', en: 'Custom Relations' },
  { type: 'ai_suggested', zh: 'AI 关系', en: 'AI Relations' },
];

const visibleNodeTypes = nodeTypes.filter((item) => item.type !== 'reference');
const visibleEdgeTypes = edgeTypes.filter((item) => item.type !== 'paper_reference');

const graphPerspectives: Array<{
  id: GraphPerspective;
  zh: string;
  en: string;
  descriptionZh: string;
  descriptionEn: string;
}> = [
  {
    id: 'mixed',
    zh: '混合图谱',
    en: 'Mixed',
    descriptionZh: '文献、笔记、标签、分类和引用一起探索。',
    descriptionEn: 'Explore papers, notes, tags, collections, and references together.',
  },
  {
    id: 'paper',
    zh: '单论文网络',
    en: 'Paper',
    descriptionZh: '突出论文之间的引用、分类和语义关系。',
    descriptionEn: 'Emphasize citation, collection, and semantic paper relations.',
  },
  {
    id: 'note',
    zh: '笔记网络',
    en: 'Notes',
    descriptionZh: '突出笔记双链、笔记引用文献和笔记标签。',
    descriptionEn: 'Emphasize note links, note-paper anchors, and note tags.',
  },
  {
    id: 'reference',
    zh: '参考文献',
    en: 'Citations',
    descriptionZh: '查看文献互引和未入库参考文献。',
    descriptionEn: 'Inspect citation links between papers already in the library.',
  },
  {
    id: 'semantic',
    zh: '语义相似',
    en: 'Semantic',
    descriptionZh: '突出 sqlite-vec/RAG 自动生成的相似文献边。',
    descriptionEn: 'Focus on sqlite-vec/RAG embedding similarity edges.',
  },
  {
    id: 'custom',
    zh: '自定义/AI',
    en: 'Custom/AI',
    descriptionZh: '查看人工添加和 AI 建议后确认的关系。',
    descriptionEn: 'Inspect manually added and approved AI-suggested relations.',
  },
];

const graphStyles = (textColor: string) => [
  {
    selector: 'node',
    style: {
      width: 'data(size)',
      height: 'data(size)',
      label: 'data(label)',
      'font-family': 'Inter, ui-sans-serif, system-ui, sans-serif',
      'font-size': 9,
      'font-weight': 600,
      color: textColor,
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 6,
      'text-wrap': 'wrap',
      'text-max-width': 110,
      'background-color': '#64748b',
      'border-color': '#ffffff',
      'border-width': 1.2,
      'overlay-opacity': 0,
      'transition-property': 'background-color, border-color, opacity, width, height',
      'transition-duration': 120,
    },
  },
  { selector: 'node[type = "paper"]', style: { 'background-color': '#2563eb' } },
  { selector: 'node[type = "note"]', style: { 'background-color': '#16a34a' } },
  { selector: 'node[type = "tag"]', style: { 'background-color': '#d97706' } },
  { selector: 'node[type = "category"]', style: { 'background-color': '#7c3aed' } },
  { selector: 'node[type = "reference"]', style: { 'background-color': '#64748b' } },
  {
    selector: 'node:selected',
    style: {
      'border-width': 4,
      'border-color': '#0f172a',
    },
  },
  {
    selector: 'edge',
    style: {
      width: 'mapData(weight, 0, 1, 0.8, 4)',
      'line-color': '#94a3b8',
      'target-arrow-color': '#94a3b8',
      'curve-style': 'bezier',
      opacity: 0.42,
      'overlay-opacity': 0,
    },
  },
  {
    selector: 'edge:selected',
    style: {
      width: 5,
      opacity: 0.92,
      'line-color': '#111827',
      'target-arrow-color': '#111827',
    },
  },
  {
    selector: 'edge[type = "related_by_embedding"]',
    style: {
      'line-color': EDGE_COLORS.related_by_embedding,
      opacity: 0.58,
    },
  },
  { selector: 'edge[type = "note_paper"]', style: { 'line-color': EDGE_COLORS.note_paper } },
  { selector: 'edge[type = "note_link"]', style: { 'line-color': EDGE_COLORS.note_link, 'target-arrow-shape': 'triangle' } },
  { selector: 'edge[type = "paper_tag"]', style: { 'line-color': EDGE_COLORS.paper_tag } },
  { selector: 'edge[type = "note_tag"]', style: { 'line-color': EDGE_COLORS.note_tag, 'line-style': 'dashed' } },
  { selector: 'edge[type = "paper_category"]', style: { 'line-color': EDGE_COLORS.paper_category } },
  { selector: 'edge[type = "paper_cites_paper"]', style: { 'line-color': EDGE_COLORS.paper_cites_paper, 'target-arrow-shape': 'triangle' } },
  { selector: 'edge[type = "paper_reference"]', style: { 'line-color': EDGE_COLORS.paper_reference, 'line-style': 'dotted', 'target-arrow-shape': 'triangle' } },
  { selector: 'edge[type = "co_author"]', style: { 'line-color': EDGE_COLORS.co_author, 'line-style': 'dashed' } },
  { selector: 'edge[type = "custom_relation"]', style: { 'line-color': EDGE_COLORS.custom_relation, 'target-arrow-shape': 'triangle' } },
  { selector: 'edge[type = "ai_suggested"]', style: { 'line-color': EDGE_COLORS.ai_suggested, 'target-arrow-shape': 'triangle' } },
  {
    selector: '.faded',
    style: {
      opacity: 0.1,
    },
  },
  {
    selector: '.focused',
    style: {
      opacity: 1,
      'border-width': 3,
      'border-color': '#111827',
    },
  },
] as unknown as StylesheetJson;

function graphNodeTextColor(container: HTMLElement): string {
  return getComputedStyle(container).getPropertyValue('--pq-text').trim() || '#1c1917';
}

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function readStorageJson<T>(key: string): Partial<T> {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : {};
  } catch {
    return {};
  }
}

async function loadGraphModelPreset(): Promise<QaModelPreset | null> {
  let persisted: Partial<ReaderConfigFile> | null = null;

  try {
    persisted = await readReaderConfigFile();
  } catch {
    persisted = null;
  }

  const storedSettings = readStorageJson<ReaderSettings>(SETTINGS_STORAGE_KEY);
  const storedSecrets = readStorageJson<ReaderSecrets>(SECRETS_STORAGE_KEY);
  const settings = normalizeReaderSettings({
    ...DEFAULT_SETTINGS,
    ...(persisted?.settings ?? {}),
    ...storedSettings,
  });
  const secrets = {
    ...(persisted?.secrets ?? {}),
    ...storedSecrets,
  };
  const presets = normalizeQaModelPresets(secrets.qaModelPresets);
  return (
    resolveModelPreset(presets, settings.agentModelPresetId) ??
    resolveModelPreset(presets, settings.summaryModelPresetId) ??
    resolveModelPreset(presets, settings.qaActivePresetId) ??
    resolveModelPreset(presets, DEFAULT_QA_PRESET_ID) ??
    presets[0] ??
    null
  );
}

function modelOptionsFromPreset(preset: QaModelPreset, settings: Partial<ReaderSettings> = {}) {
  const runtime = getModelRuntimeConfig(normalizeReaderSettings({
    ...DEFAULT_SETTINGS,
    ...settings,
  }), 'agent');

  return {
    baseUrl: preset.baseUrl,
    apiKey: preset.apiKey,
    model: preset.model,
    apiMode: preset.apiMode,
    temperature: runtime.temperature,
    reasoningEffort: runtime.reasoningEffort,
  };
}

function perspectiveNodeTypes(perspective: GraphPerspective): Record<KnowledgeGraphNodeType, boolean> {
  const all = {
    paper: true,
    note: true,
    tag: true,
    category: true,
    reference: true,
  };

  if (perspective === 'paper') {
    return { ...all, note: false, reference: false };
  }

  if (perspective === 'note') {
    return { ...all, category: false, reference: false };
  }

  if (perspective === 'reference') {
    return { ...all, note: false, tag: false, category: false };
  }

  if (perspective === 'semantic') {
    return { paper: true, note: false, tag: false, category: false, reference: false };
  }

  if (perspective === 'custom') {
    return { paper: true, note: true, tag: false, category: false, reference: false };
  }

  return all;
}

function perspectiveEdgeTypes(perspective: GraphPerspective): Record<KnowledgeGraphEdgeType, boolean> {
  const all = {
    related_by_embedding: true,
    note_paper: true,
    note_link: true,
    paper_tag: true,
    note_tag: true,
    paper_category: true,
    paper_cites_paper: true,
    paper_reference: true,
    co_author: false,
    custom_relation: true,
    ai_suggested: true,
  };

  if (perspective === 'paper') {
    return {
      ...all,
      note_paper: false,
      note_link: false,
      note_tag: false,
      paper_reference: false,
      co_author: false,
      custom_relation: true,
      ai_suggested: true,
    };
  }

  if (perspective === 'note') {
    return {
      ...all,
      related_by_embedding: false,
      paper_tag: false,
      paper_category: false,
      paper_cites_paper: false,
      paper_reference: false,
      co_author: false,
    };
  }

  if (perspective === 'reference') {
    return {
      ...all,
      related_by_embedding: false,
      note_paper: false,
      note_link: false,
      paper_tag: false,
      note_tag: false,
      paper_category: false,
      co_author: false,
      custom_relation: false,
      ai_suggested: false,
    };
  }

  if (perspective === 'semantic') {
    return {
      related_by_embedding: true,
      note_paper: false,
      note_link: false,
      paper_tag: false,
      note_tag: false,
      paper_category: false,
      paper_cites_paper: false,
      paper_reference: false,
      co_author: false,
      custom_relation: false,
      ai_suggested: false,
    };
  }

  if (perspective === 'custom') {
    return {
      related_by_embedding: false,
      note_paper: false,
      note_link: false,
      paper_tag: false,
      note_tag: false,
      paper_category: false,
      paper_cites_paper: false,
      paper_reference: false,
      co_author: false,
      custom_relation: true,
      ai_suggested: true,
    };
  }

  return all;
}

function toElements(snapshot: KnowledgeGraphSnapshot): ElementDefinition[] {
  return [
    ...snapshot.nodes.map((node) => ({
      data: {
        ...node,
        size: node.size ?? 28,
      },
    })),
    ...snapshot.edges.map((edge) => ({
      data: edge,
    })),
  ];
}

function runGraphLayout(cy: Core, mode: LayoutMode) {
  const layout = cy.layout(
    mode === 'local'
      ? {
          name: 'concentric',
          animate: true,
          animationDuration: 320,
          fit: true,
          padding: 36,
          concentric: (node) => node.degree(),
          levelWidth: () => 2,
          minNodeSpacing: 40,
        } as cytoscape.LayoutOptions
      : {
          name: 'cose',
          animate: true,
          animationDuration: 320,
          fit: true,
          padding: 36,
          nodeRepulsion: 7600,
          idealEdgeLength: 96,
          gravity: 0.22,
          numIter: 900,
        } as cytoscape.LayoutOptions,
  );

  layout.run();
}

function CollapsiblePanel({
  title,
  summary,
  icon,
  collapsed,
  onToggle,
  children,
  className,
}: {
  title: string;
  summary?: ReactNode;
  icon?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mt-3 rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)]', className)}>
      <button
        type="button"
        onClick={onToggle}
        className="flex h-9 w-full items-center gap-2 px-3 text-left text-xs font-semibold text-[var(--pq-text)]"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--pq-text-muted)]" strokeWidth={1.8} />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--pq-text-muted)]" strokeWidth={1.8} />
        )}
        {icon ? <span className="shrink-0 text-[var(--pq-text-muted)]">{icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {summary ? (
          <span className="shrink-0 text-[11px] font-medium text-[var(--pq-text-muted)]">
            {summary}
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <div className="border-t border-[var(--pq-border)] p-3">
          {children}
        </div>
      )}
    </section>
  );
}

export default function KnowledgeGraphWorkspace() {
  const locale = useAppLocale();
  const l = useLocaleText();
  const resolvedTheme = useThemeStore((state) => state.resolved);
  const isEnglish = locale === 'en-US';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const quickRelationSourceRef = useRef<KnowledgeGraphNode | null>(null);
  const renderedNodeIdsRef = useRef<Set<string>>(new Set());
  const renderedEdgeIdsRef = useRef<Set<string>>(new Set());
  const renderedLayoutModeRef = useRef<LayoutMode>('global');
  const openNoteTab = useTabsStore((state) => state.openNoteTab);
  const [snapshot, setSnapshot] = useState<KnowledgeGraphSnapshot | null>(null);
  const [selectedNode, setSelectedNode] = useState<KnowledgeGraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<KnowledgeGraphEdge | null>(null);
  const [relationSourceNode, setRelationSourceNode] = useState<KnowledgeGraphNode | null>(null);
  const [quickRelationSourceNode, setQuickRelationSourceNode] = useState<KnowledgeGraphNode | null>(null);
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [perspective, setPerspective] = useState<GraphPerspective>('mixed');
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('global');
  const [localNodeId, setLocalNodeId] = useState('');
  const [localDepth, setLocalDepth] = useState(1);
  const [enabledNodeTypes, setEnabledNodeTypes] = useState<Record<KnowledgeGraphNodeType, boolean>>(
    perspectiveNodeTypes('mixed'),
  );
  const [enabledEdgeTypes, setEnabledEdgeTypes] = useState<Record<KnowledgeGraphEdgeType, boolean>>(
    perspectiveEdgeTypes('mixed'),
  );
  const [embeddingMinSimilarity, setEmbeddingMinSimilarity] = useState(0.82);
  const [relationLabel, setRelationLabel] = useState('related');
  const [relationDescription, setRelationDescription] = useState('');
  const [aiSuggestions, setAiSuggestions] = useState<KnowledgeGraphAiRelationSuggestion[]>([]);
  const [aiWorking, setAiWorking] = useState(false);
  const [relationWorking, setRelationWorking] = useState(false);
  const [referenceSyncProgress, setReferenceSyncProgress] = useState<LibraryReferenceProgress | null>(null);
  const [referenceSyncWorking, setReferenceSyncWorking] = useState(false);
  const [relationTargetSearch, setRelationTargetSearch] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [collapsedPanels, setCollapsedPanels] = useState<Record<string, boolean>>({
    localDepth: false,
    nodeTypes: false,
    edgeTypes: false,
    embedding: true,
    customRelations: true,
    graphStats: true,
    aiRelations: true,
  });

  const openGraphNode = useCallback(async (node: KnowledgeGraphNode) => {
    if (node.type === 'paper' && node.paperId) {
      emitOpenLibraryPaper(node.paperId);
      return;
    }

    if (node.type === 'note' && node.noteId) {
      openNoteTab(node.noteId, node.label);
    }
  }, [openNoteTab]);

  const filteredSnapshot = useMemo<KnowledgeGraphSnapshot | null>(() => {
    if (!snapshot) return null;
    const allowedNodeIds = new Set(
      snapshot.nodes
        .filter((node) => enabledNodeTypes[node.type])
        .map((node) => node.id),
    );

    return {
      ...snapshot,
      nodes: snapshot.nodes.filter((node) => allowedNodeIds.has(node.id)),
      edges: snapshot.edges.filter((edge) =>
        enabledEdgeTypes[edge.type] &&
        allowedNodeIds.has(edge.source) &&
        allowedNodeIds.has(edge.target),
      ),
    };
  }, [enabledEdgeTypes, enabledNodeTypes, snapshot]);

  const nodeById = useMemo(() => {
    const nodes = snapshot?.nodes ?? [];
    return new Map(nodes.map((node) => [node.id, node]));
  }, [snapshot]);

  const graphStats = useMemo(() => {
    const graph = filteredSnapshot;
    if (!graph) {
      return { topNodes: [] as Array<{ node: KnowledgeGraphNode; degree: number }> };
    }

    const degreeByNode = new Map(graph.nodes.map((node) => [node.id, 0]));
    for (const edge of graph.edges) {
      degreeByNode.set(edge.source, (degreeByNode.get(edge.source) ?? 0) + 1);
      degreeByNode.set(edge.target, (degreeByNode.get(edge.target) ?? 0) + 1);
    }

    return {
      topNodes: graph.nodes
        .map((node) => ({ node, degree: degreeByNode.get(node.id) ?? 0 }))
        .filter((item) => item.degree > 0)
        .sort((left, right) => right.degree - left.degree)
        .slice(0, 10),
    };
  }, [filteredSnapshot]);

  const selectedCustomEdges = useMemo(() => {
    if (!snapshot || !selectedNode) return [];
    return snapshot.edges.filter((edge) =>
      (edge.type === 'custom_relation' || edge.type === 'ai_suggested') &&
      (edge.source === selectedNode.id || edge.target === selectedNode.id),
    );
  }, [selectedNode, snapshot]);

  const activePerspective = graphPerspectives.find((item) => item.id === perspective) ?? graphPerspectives[0];

  useEffect(() => {
    quickRelationSourceRef.current = quickRelationSourceNode;
  }, [quickRelationSourceNode]);

  const selectGraphNode = useCallback((node: KnowledgeGraphNode, target?: cytoscape.NodeSingular) => {
    const cy = cyRef.current;
    setSelectedNode(node);
    setSelectedEdge(null);
    setContextMenu(null);

    if (!cy) return;

    cy.elements().removeClass('faded focused');
    cy.elements().unselect();
    const element = target ?? cy.$id(node.id);
    if (element.empty()) return;
    element.select();
    cy.elements().addClass('faded');
    element.removeClass('faded').addClass('focused');
    element.neighborhood().removeClass('faded').addClass('focused');
  }, []);

  const selectGraphEdge = useCallback((edge: KnowledgeGraphEdge, target?: cytoscape.EdgeSingular) => {
    const cy = cyRef.current;
    setSelectedEdge(edge);
    setSelectedNode(null);
    setContextMenu(null);

    if (!cy) return;

    cy.elements().removeClass('faded focused');
    cy.elements().unselect();
    const element = target ?? cy.$id(edge.id);
    if (element.empty()) return;
    element.select();
    cy.elements().addClass('faded');
    element.removeClass('faded').addClass('focused');
    element.connectedNodes().removeClass('faded').addClass('focused');
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(search.trim()), 220);
    return () => window.clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void listenLibraryReferenceProgress((progress) => {
      if (!cancelled) {
        setReferenceSyncProgress(progress);
      }
    }).then((nextUnsubscribe) => {
      if (cancelled) {
        nextUnsubscribe();
        return;
      }
      unsubscribe = nextUnsubscribe;
    }).catch(console.error);

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadGraph() {
      setLoading(true);
      setError('');

      try {
        const graph = await getKnowledgeGraph({
          search: debouncedSearch,
          localNodeId: layoutMode === 'local' ? localNodeId : '',
          localDepth: layoutMode === 'local' ? localDepth : 0,
          includeEmbeddingEdges: enabledEdgeTypes.related_by_embedding,
          includeReferences: enabledEdgeTypes.paper_cites_paper,
          includeCoAuthors: enabledEdgeTypes.co_author,
          includeCustomRelations: enabledEdgeTypes.custom_relation || enabledEdgeTypes.ai_suggested,
          embeddingMinSimilarity,
          embeddingEdgeLimit: 120,
        });

        if (cancelled) return;
        setSnapshot(graph);
        setSelectedNode((current) =>
          current && graph.nodes.some((node) => node.id === current.id)
            ? graph.nodes.find((node) => node.id === current.id) ?? null
            : null,
        );
        setSelectedEdge((current) =>
          current && graph.edges.some((edge) => edge.id === current.id)
            ? graph.edges.find((edge) => edge.id === current.id) ?? null
            : null,
        );
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadGraph();
    return () => {
      cancelled = true;
    };
  }, [
    debouncedSearch,
    embeddingMinSimilarity,
    enabledEdgeTypes.ai_suggested,
    enabledEdgeTypes.custom_relation,
    enabledEdgeTypes.co_author,
    enabledEdgeTypes.paper_cites_paper,
    enabledEdgeTypes.related_by_embedding,
    layoutMode,
    localDepth,
    localNodeId,
    refreshToken,
  ]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !filteredSnapshot) return;

    const nextNodeIds = new Set(filteredSnapshot.nodes.map((node) => node.id));
    const nextEdgeIds = new Set(filteredSnapshot.edges.map((edge) => edge.id));
    const nodesChanged = !areStringSetsEqual(renderedNodeIdsRef.current, nextNodeIds);
    const layoutModeChanged = renderedLayoutModeRef.current !== layoutMode;

    if (nodesChanged || layoutModeChanged) {
      cy.elements().remove();
      cy.add(toElements(filteredSnapshot));
      renderedNodeIdsRef.current = nextNodeIds;
      renderedEdgeIdsRef.current = nextEdgeIds;
      renderedLayoutModeRef.current = layoutMode;
      runGraphLayout(cy, layoutMode);
      return;
    }

    for (const edgeId of renderedEdgeIdsRef.current) {
      if (!nextEdgeIds.has(edgeId)) {
        cy.$id(edgeId).remove();
      }
    }

    for (const edge of filteredSnapshot.edges) {
      if (!renderedEdgeIdsRef.current.has(edge.id)) {
        cy.add({ data: edge });
      } else {
        cy.$id(edge.id).data(edge);
      }
    }

    for (const node of filteredSnapshot.nodes) {
      cy.$id(node.id).data({ ...node, size: node.size ?? 28 });
    }

    renderedEdgeIdsRef.current = nextEdgeIds;
  }, [filteredSnapshot, layoutMode]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selectedEdge) return;

    const edge = cy.$id(selectedEdge.id);
    if (edge.empty()) return;

    cy.elements().removeClass('faded focused');
    cy.elements().unselect();
    edge.select();
    cy.elements().addClass('faded');
    edge.removeClass('faded').addClass('focused');
    edge.connectedNodes().removeClass('faded').addClass('focused');
  }, [selectedEdge]);

  const fitGraph = () => {
    cyRef.current?.fit(undefined, 36);
  };

  const rerunLayout = () => {
    if (cyRef.current) {
      runGraphLayout(cyRef.current, layoutMode);
    }
  };

  const focusSelectedAsLocal = () => {
    if (!selectedNode) return;
    setLocalNodeId(selectedNode.id);
    setLayoutMode('local');
  };

  const focusGraphNode = (node: KnowledgeGraphNode) => {
    const cy = cyRef.current;
    if (!cy) return;

    const target = cy.$id(node.id);
    if (target.empty()) return;

    cy.elements().unselect();
    target.select();
    setSelectedNode(node);
    cy.animate({
      center: { eles: target },
      zoom: Math.max(cy.zoom(), 1.05),
      duration: 260,
    });
  };

  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const exportGraphPng = () => {
    const cy = cyRef.current;
    if (!cy) return;

    const blob = cy.png({ output: 'blob', full: true, scale: 2 }) as Blob;
    downloadBlob(blob, `paperquay-knowledge-graph-${Date.now()}.png`);
  };

  const exportGraphJson = () => {
    const graph = filteredSnapshot ?? snapshot;
    if (!graph) return;

    downloadBlob(
      new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' }),
      `paperquay-knowledge-graph-${Date.now()}.json`,
    );
  };

  const syncReferences = async () => {
    setReferenceSyncWorking(true);
    setError('');

    try {
      await fetchAllLibraryReferences(false);
      setRefreshToken((value) => value + 1);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setReferenceSyncWorking(false);
    }
  };

  const applyPerspective = (nextPerspective: GraphPerspective) => {
    setPerspective(nextPerspective);
    setEnabledNodeTypes(perspectiveNodeTypes(nextPerspective));
    setEnabledEdgeTypes(perspectiveEdgeTypes(nextPerspective));
    if (nextPerspective === 'semantic') {
      setLayoutMode('global');
    }
  };

  const toggleNodeType = (type: KnowledgeGraphNodeType) => {
    setEnabledNodeTypes((current) => ({ ...current, [type]: !current[type] }));
  };

  const toggleEdgeType = (type: KnowledgeGraphEdgeType) => {
    setEnabledEdgeTypes((current) => ({ ...current, [type]: !current[type] }));
  };

  const togglePanel = (panel: string) => {
    setCollapsedPanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

  const createRelation = useCallback(async (
    source: KnowledgeGraphNode | null,
    target: KnowledgeGraphNode | null,
    label = relationLabel,
    description = relationDescription,
    type: 'custom_relation' | 'ai_suggested' = 'custom_relation',
    confidence?: number,
  ) => {
    if (!source || !target || source.id === target.id) {
      setError(l('请选择两个不同节点。', 'Select two different nodes.'));
      return;
    }

    setRelationWorking(true);
    setError('');

    try {
      const relation = await createKnowledgeGraphRelation({
        source: source.id,
        target: target.id,
        label,
        description,
        type,
        confidence,
      });
      const edge: KnowledgeGraphEdge = {
        id: relation.id,
        source: relation.source,
        target: relation.target,
        type: relation.type,
        label: relation.label,
        description: relation.description,
        confidence: relation.confidence,
        weight: relation.weight ?? (relation.type === 'ai_suggested' ? 0.66 : 0.58),
        createdAt: relation.createdAt,
        updatedAt: relation.updatedAt,
      };

      setSnapshot((current) => current
        ? {
            ...current,
            edges: current.edges.some((item) => item.id === edge.id)
              ? current.edges.map((item) => (item.id === edge.id ? edge : item))
              : [...current.edges, edge],
          }
        : current);
      setSelectedEdge(edge);
      setSelectedNode(null);
      setRelationDescription('');
      setRelationLabel('related');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setRelationWorking(false);
    }
  }, [l, relationDescription, relationLabel]);

  const deleteRelation = async (relationId: string) => {
    setRelationWorking(true);
    setError('');

    try {
      await deleteKnowledgeGraphRelation(relationId);
      setSnapshot((current) => current
        ? {
            ...current,
            edges: current.edges.filter((edge) => edge.id !== relationId),
          }
        : current);
      setSelectedEdge((current) => (current?.id === relationId ? null : current));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setRelationWorking(false);
    }
  };

  const startQuickRelation = useCallback((node: KnowledgeGraphNode) => {
    setQuickRelationSourceNode(node);
    setRelationSourceNode(node);
    setSelectedNode(node);
    setSelectedEdge(null);
    setContextMenu(null);
  }, []);

  const cancelQuickRelation = useCallback(() => {
    setQuickRelationSourceNode(null);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: graphStyles(graphNodeTextColor(containerRef.current)),
      wheelSensitivity: 0.18,
      minZoom: 0.08,
      maxZoom: 2.8,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (event) => {
      const data = event.target.data() as KnowledgeGraphNode;
      const quickSource = quickRelationSourceRef.current;
      if (quickSource && quickSource.id !== data.id) {
        void createRelation(quickSource, data).then(() => {
          setQuickRelationSourceNode(null);
        });
        return;
      }

      selectGraphNode(data, event.target);
    });

    cy.on('tap', 'edge', (event) => {
      const data = event.target.data() as KnowledgeGraphEdge;
      selectGraphEdge(data, event.target);
    });

    cy.on('tap', (event) => {
      if (event.target === cy) {
        setSelectedNode(null);
        setSelectedEdge(null);
        setContextMenu(null);
        cy.elements().removeClass('faded focused');
      }
    });

    cy.on('dbltap', 'node', (event) => {
      const data = event.target.data() as KnowledgeGraphNode;
      setLocalNodeId(data.id);
      setLayoutMode('local');
    });

    cy.on('cxttap', 'node', (event) => {
      const data = event.target.data() as KnowledgeGraphNode;
      selectGraphNode(data, event.target);
      setContextMenu({
        x: event.renderedPosition.x,
        y: event.renderedPosition.y,
        node: data,
      });
    });

    cy.on('tapdragover', 'node', (event) => {
      containerRef.current?.style.setProperty('cursor', 'grab');
      event.target.addClass('focused');
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [createRelation, selectGraphEdge, selectGraphNode]);

  useEffect(() => {
    if (!containerRef.current || !cyRef.current) return;
    cyRef.current.style().selector('node').style('color', graphNodeTextColor(containerRef.current)).update();
  }, [resolvedTheme]);

  const runAiRelationSuggestion = async () => {
    setAiWorking(true);
    setError('');
    setAiSuggestions([]);

    try {
      const preset = await loadGraphModelPreset();

      if (!preset?.apiKey.trim() || !preset.baseUrl.trim() || !preset.model.trim()) {
        throw new Error(l('请先在设置中配置 Agent 或摘要模型。', 'Configure an Agent or summary model in settings first.'));
      }

      const settings = readStorageJson<ReaderSettings>(SETTINGS_STORAGE_KEY);
      const suggestions = await suggestKnowledgeGraphRelations(
        {
          focusNodeId: selectedNode?.id ?? null,
          localDepth: selectedNode ? Math.max(2, localDepth) : 0,
          maxRelations: 10,
          embeddingMinSimilarity,
        },
        modelOptionsFromPreset(preset, settings),
      );
      setAiSuggestions(suggestions);
    } catch (suggestError) {
      setError(suggestError instanceof Error ? suggestError.message : String(suggestError));
    } finally {
      setAiWorking(false);
    }
  };

  const approveAiSuggestion = async (suggestion: KnowledgeGraphAiRelationSuggestion) => {
    const source = nodeById.get(suggestion.sourceId) ?? null;
    const target = nodeById.get(suggestion.targetId) ?? null;
    await createRelation(source, target, suggestion.label, suggestion.description, 'ai_suggested', suggestion.confidence);
    setAiSuggestions((current) => current.filter((item) => item !== suggestion));
  };

  const nodeCount = filteredSnapshot?.nodes.length ?? 0;
  const edgeCount = filteredSnapshot?.edges.length ?? 0;
  const enabledNodeTypeCount = visibleNodeTypes.filter((item) => enabledNodeTypes[item.type]).length;
  const enabledEdgeTypeCount = visibleEdgeTypes.filter((item) => enabledEdgeTypes[item.type]).length;
  const canOpenSelectedNode =
    Boolean(selectedNode?.type === 'paper' && selectedNode.paperId) ||
    Boolean(selectedNode?.type === 'note' && selectedNode.noteId);
  const selectedEdgeSource = selectedEdge ? nodeById.get(selectedEdge.source) : null;
  const selectedEdgeTarget = selectedEdge ? nodeById.get(selectedEdge.target) : null;
  const canDeleteSelectedEdge = selectedEdge?.type === 'custom_relation' || selectedEdge?.type === 'ai_suggested';
  const normalizedRelationTargetSearch = relationTargetSearch.trim().toLowerCase();
  const relationTargetOptions = (filteredSnapshot?.nodes ?? [])
    .filter((node) =>
      node.id !== relationSourceNode?.id &&
      (node.type === 'paper' || node.type === 'note'),
    )
    .filter((node) => {
      if (!normalizedRelationTargetSearch) return true;
      return [node.label, node.subtitle, node.id]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
        .includes(normalizedRelationTargetSearch);
    })
    .slice(0, 50);

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface)]">
      <aside className="flex w-[292px] shrink-0 flex-col border-r border-[var(--pq-border)] bg-[var(--pq-surface-1)]">
        <div className="border-b border-[var(--pq-border)] p-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--pq-accent-bg)] text-[var(--pq-accent)]">
              <Network className="h-4 w-4" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--pq-text)]">
                {l('知识图谱', 'Knowledge Graph')}
              </div>
              <div className="text-[11px] text-[var(--pq-text-muted)]">
                {compactNumber(nodeCount)} {l('节点', 'nodes')} · {compactNumber(edgeCount)} {l('关系', 'edges')}
              </div>
            </div>
          </div>

          <label className="mt-3 flex h-9 items-center gap-2 rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] px-2">
            <Search className="h-4 w-4 shrink-0 text-[var(--pq-text-muted)]" strokeWidth={1.8} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={l('搜索文献、笔记、标签', 'Search papers, notes, tags')}
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--pq-text)] outline-none placeholder:text-[var(--pq-text-faint)]"
            />
          </label>

          <div className="mt-3">
            <div className="mb-1.5 text-xs font-semibold text-[var(--pq-text)]">
              {l('图谱视角', 'Graph Perspective')}
            </div>
            <select
              value={perspective}
              onChange={(event) => applyPerspective(event.target.value as GraphPerspective)}
              className="h-8 w-full rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] px-2 text-xs text-[var(--pq-text)] outline-none"
            >
              {graphPerspectives.map((item) => (
                <option key={item.id} value={item.id}>
                  {isEnglish ? item.en : item.zh}
                </option>
              ))}
            </select>
            <div className="mt-1.5 text-[11px] leading-5 text-[var(--pq-text-faint)]">
              {isEnglish ? activePerspective.descriptionEn : activePerspective.descriptionZh}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="grid grid-cols-2 gap-1 rounded-[var(--pq-radius-sm)] bg-[var(--pq-bg-secondary)] p-1">
            {(['global', 'local'] as LayoutMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setLayoutMode(mode)}
                className={cn(
                  'h-8 rounded-[var(--pq-radius-sm)] text-xs font-medium transition',
                  layoutMode === mode
                    ? 'bg-[var(--pq-surface)] text-[var(--pq-text)] shadow-[var(--pq-shadow-sm)]'
                    : 'text-[var(--pq-text-muted)] hover:text-[var(--pq-text)]',
                )}
              >
                {mode === 'global' ? l('全局', 'Global') : l('局部', 'Local')}
              </button>
            ))}
          </div>

          {layoutMode === 'local' ? (
            <CollapsiblePanel
              title={l('局部深度', 'Local Depth')}
              summary={localDepth}
              collapsed={collapsedPanels.localDepth}
              onToggle={() => togglePanel('localDepth')}
            >
              <div className="mb-2 flex items-center justify-between text-xs font-semibold text-[var(--pq-text)]">
                <span>{l('局部深度', 'Local Depth')}</span>
                <span className="text-[var(--pq-text-muted)]">{localDepth}</span>
              </div>
              <input
                type="range"
                min={1}
                max={4}
                step={1}
                value={localDepth}
                onChange={(event) => setLocalDepth(Number(event.target.value))}
                className="w-full accent-[var(--pq-accent)]"
              />
              <div className="mt-2 text-[11px] leading-5 text-[var(--pq-text-faint)]">
                {localNodeId
                  ? l('双击节点或点击详情卡按钮可更换局部中心。', 'Double-click a node or use the detail card to change the local center.')
                  : l('先选择一个节点作为局部中心。', 'Select a node as the local center first.')}
              </div>
            </CollapsiblePanel>
          ) : null}

          <CollapsiblePanel
            title={l('节点类型', 'Node Types')}
            summary={`${enabledNodeTypeCount}/${visibleNodeTypes.length}`}
            collapsed={collapsedPanels.nodeTypes}
            onToggle={() => togglePanel('nodeTypes')}
          >
            <div className="mb-2 text-xs font-semibold text-[var(--pq-text)]">
              {l('节点类型', 'Node Types')}
            </div>
            <div className="space-y-1.5">
              {visibleNodeTypes.map((item) => {
                const Icon = item.icon;
                return (
                  <label
                    key={item.type}
                    className="flex h-8 cursor-default items-center gap-2 rounded-[var(--pq-radius-sm)] px-2 text-xs text-[var(--pq-text-muted)] hover:bg-[var(--pq-bg-secondary)]"
                  >
                    <input
                      type="checkbox"
                      checked={enabledNodeTypes[item.type]}
                      onChange={() => toggleNodeType(item.type)}
                      className="h-3.5 w-3.5 accent-[var(--pq-accent)]"
                    />
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
                    <span>{isEnglish ? item.en : item.zh}</span>
                  </label>
                );
              })}
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            title={l('关系类型', 'Edge Types')}
            summary={`${enabledEdgeTypeCount}/${visibleEdgeTypes.length}`}
            collapsed={collapsedPanels.edgeTypes}
            onToggle={() => togglePanel('edgeTypes')}
          >
            <div className="mb-2 text-xs font-semibold text-[var(--pq-text)]">
              {l('关系类型', 'Edge Types')}
            </div>
            <div className="space-y-1.5">
              {visibleEdgeTypes.map((item) => (
                <label
                  key={item.type}
                  className="flex h-8 cursor-default items-center gap-2 rounded-[var(--pq-radius-sm)] px-2 text-xs text-[var(--pq-text-muted)] hover:bg-[var(--pq-bg-secondary)]"
                >
                  <input
                    type="checkbox"
                    checked={enabledEdgeTypes[item.type]}
                    onChange={() => toggleEdgeType(item.type)}
                    className="h-3.5 w-3.5 accent-[var(--pq-accent)]"
                  />
                  <span
                    className="h-2 w-5 rounded-full"
                    style={{ backgroundColor: EDGE_COLORS[item.type] }}
                  />
                  <span>{isEnglish ? item.en : item.zh}</span>
                </label>
              ))}
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            title={l('语义相似阈值', 'Embedding Similarity')}
            summary={embeddingMinSimilarity.toFixed(2)}
            collapsed={collapsedPanels.embedding}
            onToggle={() => togglePanel('embedding')}
          >
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-[var(--pq-text)]">
              <span>{l('语义相似阈值', 'Embedding Similarity')}</span>
              <span className="text-[var(--pq-text-muted)]">{embeddingMinSimilarity.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.6}
              max={0.98}
              step={0.01}
              value={embeddingMinSimilarity}
              onChange={(event) => setEmbeddingMinSimilarity(Number(event.target.value))}
              className="w-full accent-[var(--pq-accent)]"
            />
          </CollapsiblePanel>

          <CollapsiblePanel
            title={l('自定义关系', 'Custom Relations')}
            icon={<Link2 className="h-3.5 w-3.5" strokeWidth={1.8} />}
            summary={relationSourceNode ? l('已选起点', 'Source set') : undefined}
            collapsed={collapsedPanels.customRelations}
            onToggle={() => togglePanel('customRelations')}
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--pq-text)]">
              <Link2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              {l('自定义关系', 'Custom Relations')}
            </div>
            <div className="space-y-2">
              <button
                type="button"
                disabled={!selectedNode}
                onClick={() => selectedNode && setRelationSourceNode(selectedNode)}
                className="pq-button h-8 w-full justify-center px-2 text-xs disabled:opacity-40"
              >
                {relationSourceNode
                  ? l(`起点：${relationSourceNode.label}`, `Source: ${relationSourceNode.label}`)
                  : l('将选中节点设为起点', 'Use selected node as source')}
              </button>
              <div className="space-y-1">
                <input
                  value={relationTargetSearch}
                  onChange={(event) => setRelationTargetSearch(event.target.value)}
                  placeholder={l('搜索终点节点', 'Search target node')}
                  className="h-8 w-full rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] px-2 text-xs text-[var(--pq-text)] outline-none"
                />
                <div className="max-h-36 overflow-auto rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)]">
                  {relationTargetOptions.length > 0 ? relationTargetOptions.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => {
                        selectGraphNode(node);
                        if (relationSourceNode && relationSourceNode.id !== node.id) {
                          void createRelation(relationSourceNode, node);
                        }
                      }}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-[var(--pq-bg-secondary)]',
                        selectedNode?.id === node.id ? 'text-[var(--pq-accent)]' : 'text-[var(--pq-text-muted)]',
                      )}
                    >
                      <span className="min-w-0 truncate">{node.label}</span>
                      <span className="shrink-0 text-[10px] uppercase text-[var(--pq-text-faint)]">{node.type}</span>
                    </button>
                  )) : (
                    <div className="px-2 py-2 text-[11px] text-[var(--pq-text-faint)]">
                      {l('没有匹配节点', 'No matching nodes')}
                    </div>
                  )}
                </div>
              </div>
              <input
                value={relationLabel}
                onChange={(event) => setRelationLabel(event.target.value)}
                placeholder={l('关系名，例如：方法相似', 'Relation label, e.g. similar method')}
                className="h-8 w-full rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] px-2 text-xs text-[var(--pq-text)] outline-none"
              />
              <textarea
                value={relationDescription}
                onChange={(event) => setRelationDescription(event.target.value)}
                placeholder={l('可选说明', 'Optional description')}
                className="min-h-16 w-full resize-none rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] px-2 py-2 text-xs leading-5 text-[var(--pq-text)] outline-none"
              />
              <button
                type="button"
                disabled={relationWorking || !relationSourceNode || !selectedNode || relationSourceNode.id === selectedNode.id}
                onClick={() => void createRelation(relationSourceNode, selectedNode)}
                className="pq-button h-8 w-full justify-center px-2 text-xs disabled:opacity-40"
              >
                {relationWorking ? l('保存中...', 'Saving...') : l('添加关系', 'Add Relation')}
              </button>
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            title={l('图谱统计', 'Graph Stats')}
            summary={`${nodeCount}/${edgeCount}`}
            collapsed={collapsedPanels.graphStats}
            onToggle={() => togglePanel('graphStats')}
          >
            <div className="mb-2 flex items-center justify-between text-xs font-semibold text-[var(--pq-text)]">
              <span>{l('图谱统计', 'Graph Stats')}</span>
              <span className="text-[var(--pq-text-muted)]">{nodeCount}/{edgeCount}</span>
            </div>
            <div className="space-y-1">
              {graphStats.topNodes.length > 0 ? graphStats.topNodes.map((item, index) => (
                <button
                  key={item.node.id}
                  type="button"
                  onClick={() => focusGraphNode(item.node)}
                  className="flex w-full items-center gap-2 rounded-[var(--pq-radius-sm)] px-2 py-1.5 text-left text-[11px] text-[var(--pq-text-muted)] hover:bg-[var(--pq-bg-secondary)] hover:text-[var(--pq-text)]"
                >
                  <span className="w-4 shrink-0 text-[var(--pq-text-faint)]">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{item.node.label}</span>
                  <span className="shrink-0 rounded bg-[var(--pq-bg-secondary)] px-1.5 py-0.5 text-[10px]">
                    {item.degree}
                  </span>
                </button>
              )) : (
                <div className="text-[11px] leading-5 text-[var(--pq-text-faint)]">
                  {l('暂无中心节点排名。', 'No centrality ranking yet.')}
                </div>
              )}
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            title={l('AI 关系候选', 'AI Relation Candidates')}
            icon={<Brain className="h-3.5 w-3.5" strokeWidth={1.8} />}
            summary={aiSuggestions.length > 0 ? aiSuggestions.length : undefined}
            collapsed={collapsedPanels.aiRelations}
            onToggle={() => togglePanel('aiRelations')}
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--pq-text)]">
              <Brain className="h-3.5 w-3.5" strokeWidth={1.8} />
              {l('AI 关系候选', 'AI Relation Candidates')}
            </div>
            <button
              type="button"
              disabled={aiWorking}
              onClick={() => void runAiRelationSuggestion()}
              className="pq-button h-8 w-full justify-center px-2 text-xs disabled:opacity-40"
            >
              {aiWorking
                ? l('正在分析...', 'Analyzing...')
                : selectedNode
                  ? l('围绕选中节点生成', 'Suggest around selected node')
                  : l('生成图谱关系候选', 'Suggest graph relations')}
            </button>
            {aiSuggestions.length > 0 ? (
              <div className="mt-2 space-y-2">
                {aiSuggestions.map((suggestion, index) => {
                  const source = nodeById.get(suggestion.sourceId);
                  const target = nodeById.get(suggestion.targetId);
                  return (
                    <div
                      key={`${suggestion.sourceId}-${suggestion.targetId}-${suggestion.label}-${index}`}
                      className="rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-bg-secondary)] p-2"
                    >
                      <div className="text-[11px] font-semibold text-[var(--pq-text)]">
                        {source?.label ?? suggestion.sourceId} {'->'} {target?.label ?? suggestion.targetId}
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--pq-accent)]">
                        {suggestion.label} · {(suggestion.confidence * 100).toFixed(0)}%
                      </div>
                      <div className="mt-1 line-clamp-3 text-[11px] leading-5 text-[var(--pq-text-muted)]">
                        {suggestion.description}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          onClick={() => void approveAiSuggestion(suggestion)}
                          className="pq-button h-7 flex-1 justify-center px-2 text-[11px]"
                        >
                          {l('确认', 'Approve')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setAiSuggestions((current) => current.filter((item) => item !== suggestion))}
                          className="pq-button h-7 w-9 justify-center px-2 text-[11px]"
                        >
                          X
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </CollapsiblePanel>
        </div>

        <div className="border-t border-[var(--pq-border)] p-3">
          <div className="grid grid-cols-6 gap-2">
            <button type="button" onClick={rerunLayout} className="pq-button h-8 px-2 text-xs" title={l('重新布局', 'Re-layout')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={fitGraph} className="pq-button h-8 px-2 text-xs" title={l('适配视图', 'Fit view')}>
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={focusSelectedAsLocal}
              disabled={!selectedNode}
              className="pq-button h-8 px-2 text-xs disabled:opacity-40"
              title={l('设为局部中心', 'Use as local center')}
            >
              <Crosshair className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={exportGraphPng} className="pq-button h-8 px-2 text-xs" title={l('导出 PNG', 'Export PNG')}>
              <Download className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={exportGraphJson} className="pq-button h-8 px-2 text-xs" title={l('导出 JSON', 'Export JSON')}>
              <FileJson2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void syncReferences()}
              disabled={referenceSyncWorking}
              className="pq-button h-8 px-2 text-xs disabled:opacity-40"
              title={l('同步参考文献', 'Sync references')}
            >
              {referenceSyncWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
            </button>
          </div>
          {referenceSyncProgress ? (
            <div className="mt-2 truncate text-[11px] text-[var(--pq-text-muted)]">
              {l(
                `参考文献 ${referenceSyncProgress.current}/${referenceSyncProgress.total}，成功 ${referenceSyncProgress.fetched}，跳过 ${referenceSyncProgress.skipped}，失败 ${referenceSyncProgress.failed}`,
                `References ${referenceSyncProgress.current}/${referenceSyncProgress.total}, fetched ${referenceSyncProgress.fetched}, skipped ${referenceSyncProgress.skipped}, failed ${referenceSyncProgress.failed}`,
              )}
            </div>
          ) : null}
        </div>
      </aside>

      <section className="relative min-w-0 flex-1 bg-[radial-gradient(circle_at_1px_1px,var(--pq-border)_1px,transparent_0)] [background-size:22px_22px]">
        <div ref={containerRef} className="h-full w-full" />

        {quickRelationSourceNode ? (
          <div className="absolute left-4 top-4 flex items-center gap-2 rounded-[var(--pq-radius-sm)] border border-[var(--pq-accent-border)] bg-[var(--pq-surface)] px-3 py-2 text-xs text-[var(--pq-text)] shadow-[var(--pq-shadow-md)]">
            <Link2 className="h-4 w-4 text-[var(--pq-accent)]" strokeWidth={1.8} />
            <span className="max-w-[360px] truncate">
              {l(`已选择起点：${quickRelationSourceNode.label}。点击另一个节点添加连接。`, `Source: ${quickRelationSourceNode.label}. Click another node to add a relation.`)}
            </span>
            <button
              type="button"
              onClick={cancelQuickRelation}
              className="ml-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--pq-text-muted)] hover:bg-[var(--pq-bg-secondary)] hover:text-[var(--pq-text)]"
            >
              {l('取消', 'Cancel')}
            </button>
          </div>
        ) : null}

        {contextMenu ? (
          <div
            className="absolute z-20 w-44 overflow-hidden rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] py-1 text-xs shadow-[var(--pq-shadow-md)]"
            style={{
              left: Math.min(contextMenu.x + 8, Math.max(8, (containerRef.current?.clientWidth ?? 220) - 188)),
              top: Math.min(contextMenu.y + 8, Math.max(8, (containerRef.current?.clientHeight ?? 220) - 180)),
            }}
          >
            <button
              type="button"
              disabled={!(contextMenu.node.type === 'paper' || contextMenu.node.type === 'note')}
              onClick={() => {
                const node = contextMenu.node;
                setContextMenu(null);
                void openGraphNode(node).catch(console.error);
              }}
              className="flex h-8 w-full items-center gap-2 px-3 text-left text-[var(--pq-text-muted)] hover:bg-[var(--pq-bg-secondary)] hover:text-[var(--pq-text)] disabled:opacity-40"
            >
              <FileText className="h-3.5 w-3.5" strokeWidth={1.8} />
              {l('打开', 'Open')}
            </button>
            <button
              type="button"
              onClick={() => {
                setLocalNodeId(contextMenu.node.id);
                setLayoutMode('local');
                setContextMenu(null);
              }}
              className="flex h-8 w-full items-center gap-2 px-3 text-left text-[var(--pq-text-muted)] hover:bg-[var(--pq-bg-secondary)] hover:text-[var(--pq-text)]"
            >
              <Crosshair className="h-3.5 w-3.5" strokeWidth={1.8} />
              {l('设为局部中心', 'Use as local center')}
            </button>
            <button
              type="button"
              onClick={() => startQuickRelation(contextMenu.node)}
              className="flex h-8 w-full items-center gap-2 px-3 text-left text-[var(--pq-text-muted)] hover:bg-[var(--pq-bg-secondary)] hover:text-[var(--pq-text)]"
            >
              <Link2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              {l('从此节点添加连接', 'Add relation from here')}
            </button>
            <button
              type="button"
              onClick={() => {
                setRelationSourceNode(contextMenu.node);
                setCollapsedPanels((current) => ({ ...current, customRelations: false }));
                setContextMenu(null);
              }}
              className="flex h-8 w-full items-center gap-2 px-3 text-left text-[var(--pq-text-muted)] hover:bg-[var(--pq-bg-secondary)] hover:text-[var(--pq-text)]"
            >
              <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} />
              {l('设为关系起点', 'Set relation source')}
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--pq-surface)]/70 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] px-3 py-2 text-xs text-[var(--pq-text-muted)] shadow-[var(--pq-shadow-md)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {l('正在构建图谱...', 'Building graph...')}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="absolute left-4 top-4 flex max-w-md items-start gap-2 rounded-[var(--pq-radius-sm)] border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 shadow-[var(--pq-shadow-md)]">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {!loading && !error && nodeCount === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="rounded-[var(--pq-radius-sm)] border border-dashed border-[var(--pq-border)] bg-[var(--pq-surface)] px-4 py-8 text-center text-xs leading-5 text-[var(--pq-text-muted)]">
              {l('暂无可显示的图谱节点。导入文献、创建笔记或完成 RAG 索引后再试。', 'No graph nodes yet. Import papers, create notes, or build RAG indexes first.')}
            </div>
          </div>
        ) : null}

        {selectedNode ? (
          <div className="absolute bottom-4 right-4 w-[320px] rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] p-3 shadow-[var(--pq-shadow-md)]">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-[var(--pq-accent-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--pq-accent)]">
                {selectedNode.type}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--pq-text)]">
                {selectedNode.label}
              </span>
            </div>
            {selectedNode.subtitle ? (
              <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--pq-text-muted)]">
                {selectedNode.subtitle}
              </p>
            ) : null}
            <div className="mt-2 text-[11px] leading-5 text-[var(--pq-text-faint)]">
              {selectedNode.type === 'paper'
                ? l('文献节点可直接打开阅读，也可作为局部图谱中心。', 'Paper nodes can be opened in the reader or used as a local graph center.')
                : selectedNode.type === 'note'
                  ? l('笔记节点可直接打开编辑，也可作为局部图谱中心。', 'Note nodes can be opened for editing or used as a local graph center.')
                  : selectedNode.type === 'reference'
                    ? l('参考文献节点来自解析到的引用列表；入库后会自动合并为文献节点。', 'Reference nodes come from parsed bibliographies; they merge into paper nodes once imported.')
                    : l('标签和分类节点适合用于观察主题聚合关系。', 'Tag and collection nodes help inspect thematic clusters.')}
            </div>
            {selectedNode.doi ? (
              <div className="mt-2 truncate rounded-[var(--pq-radius-sm)] bg-[var(--pq-bg-secondary)] px-2 py-1 text-[11px] text-[var(--pq-text-muted)]">
                DOI: {selectedNode.doi}
              </div>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={!canOpenSelectedNode}
                onClick={() => selectedNode && void openGraphNode(selectedNode).catch(console.error)}
                className="pq-button h-8 px-3 text-xs disabled:opacity-40"
              >
                {l('打开', 'Open')}
              </button>
              <button
                type="button"
                onClick={focusSelectedAsLocal}
                className="pq-button h-8 px-3 text-xs"
              >
                {l('局部图谱', 'Local Graph')}
              </button>
              <button
                type="button"
                onClick={() => startQuickRelation(selectedNode)}
                className="pq-button h-8 px-3 text-xs"
              >
                {l('设为关系起点', 'Set Source')}
              </button>
            </div>
            {selectedCustomEdges.length > 0 ? (
              <div className="mt-3 border-t border-[var(--pq-border)] pt-2">
                <div className="mb-1.5 text-[11px] font-semibold text-[var(--pq-text)]">
                  {l('人工/AI 关系', 'Manual / AI Relations')}
                </div>
                <div className="max-h-36 space-y-1 overflow-auto pr-1">
                  {selectedCustomEdges.map((edge) => {
                    const otherNode = nodeById.get(edge.source === selectedNode.id ? edge.target : edge.source);
                    return (
                      <div key={edge.id} className="flex items-center gap-2 rounded-[var(--pq-radius-sm)] bg-[var(--pq-bg-secondary)] px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-medium text-[var(--pq-text)]">
                            {edge.label} {'->'} {otherNode?.label ?? edge.target}
                          </div>
                          {edge.description ? (
                            <div className="truncate text-[10px] text-[var(--pq-text-faint)]">
                              {edge.description}
                            </div>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => void deleteRelation(edge.id)}
                          className="pq-icon-button h-6 w-6"
                          title={l('删除关系', 'Delete relation')}
                          aria-label={l('删除关系', 'Delete relation')}
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {selectedEdge ? (
          <div className="absolute bottom-4 right-4 w-[320px] rounded-[var(--pq-radius-sm)] border border-[var(--pq-border)] bg-[var(--pq-surface)] p-3 shadow-[var(--pq-shadow-md)]">
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-7 shrink-0 rounded-full"
                style={{ backgroundColor: EDGE_COLORS[selectedEdge.type] }}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--pq-text)]">
                {selectedEdge.label || selectedEdge.type}
              </span>
              <span className="shrink-0 rounded-md bg-[var(--pq-bg-secondary)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--pq-text-faint)]">
                {selectedEdge.type}
              </span>
            </div>
            <div className="mt-3 space-y-1.5 text-xs text-[var(--pq-text-muted)]">
              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-[var(--pq-text-faint)]">{l('起点', 'From')}</span>
                <span className="min-w-0 truncate text-[var(--pq-text)]">{selectedEdgeSource?.label ?? selectedEdge.source}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-[var(--pq-text-faint)]">{l('终点', 'To')}</span>
                <span className="min-w-0 truncate text-[var(--pq-text)]">{selectedEdgeTarget?.label ?? selectedEdge.target}</span>
              </div>
            </div>
            {selectedEdge.description ? (
              <p className="mt-3 line-clamp-4 rounded-[var(--pq-radius-sm)] bg-[var(--pq-bg-secondary)] px-2 py-2 text-xs leading-5 text-[var(--pq-text-muted)]">
                {selectedEdge.description}
              </p>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              {selectedEdgeSource ? (
                <button
                  type="button"
                  onClick={() => focusGraphNode(selectedEdgeSource)}
                  className="pq-button h-8 px-3 text-xs"
                >
                  {l('定位起点', 'Focus From')}
                </button>
              ) : null}
              {selectedEdgeTarget ? (
                <button
                  type="button"
                  onClick={() => focusGraphNode(selectedEdgeTarget)}
                  className="pq-button h-8 px-3 text-xs"
                >
                  {l('定位终点', 'Focus To')}
                </button>
              ) : null}
              {canDeleteSelectedEdge ? (
                <button
                  type="button"
                  onClick={() => {
                    const edgeId = selectedEdge.id;
                    setSelectedEdge(null);
                    void deleteRelation(edgeId);
                  }}
                  className="pq-button h-8 px-3 text-xs text-red-600"
                >
                  {l('删除', 'Delete')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
