const path = require('node:path');
const nativeFs = require('./nativeFs.cjs');
const {
  cleanString,
  id,
  openAiChat,
  parseJsonObject,
  pickChatText,
  toError,
} = require('./utils.cjs');

const { normalizeBoolean, normalizeLimit, paperNodeId, normalizePaperReferenceId, noteNodeId, tagNodeId, categoryNodeId, uniqueEdgeId, normalizeDoi, normalizeTitleKey, normalizeAuthorKey, textValuesFromUnknown, normalizeReferenceCandidate, extractPaperReferenceCandidates, referenceCandidatesFromCache, findReferencedPaper, authorsText, addCoAuthorEdges, notePreview, matchesSearch, filterLocalGraph, createKnowledgeGraphSnapshot: createLocalKnowledgeGraphSnapshot } = require('../../packages/graph-core/index.cjs').createKnowledgeGraphCore({cleanString,listCustomRelations});
const RELATION_STORE_FILE = 'paperquay-knowledge-graph-relations.json';
const MAX_AI_GRAPH_ITEMS = 60;
const MAX_AI_GRAPH_SUGGESTIONS = 16;












function relationStorePath(appPaths) {
  return path.join(appPaths.dataDir, RELATION_STORE_FILE);
}

function readRelationStore(appPaths) {
  try {
    const raw = JSON.parse(nativeFs.readSync(relationStorePath(appPaths), { singleLink: true }).bytes.toString('utf8'));
    return {
      version: 1,
      relations: Array.isArray(raw?.relations) ? raw.relations : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, relations: [] };
    throw error;
  }
}

function writeRelationStore(appPaths, store) {
  nativeFs.writeSync(relationStorePath(appPaths), JSON.stringify({
    version: 1,
    relations: Array.isArray(store?.relations) ? store.relations : [],
  }));
}

function normalizeCustomRelation(input = {}) {
  const source = cleanString(input.source || input.sourceId);
  const target = cleanString(input.target || input.targetId);
  const label = cleanString(input.label) || 'related';
  const type = input.type === 'ai_suggested' ? 'ai_suggested' : 'custom_relation';

  if (!source || !target || source === target) {
    return null;
  }

  const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
  return {
    id: cleanString(input.id) || id(type === 'ai_suggested' ? 'kgai' : 'kgrel'),
    source,
    target,
    type,
    label,
    description: cleanString(input.description),
    confidence: typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : undefined,
    weight: Number.isFinite(Number(input.weight))
      ? Math.max(0.1, Math.min(1, Number(input.weight)))
      : type === 'ai_suggested'
        ? 0.66
        : 0.58,
    createdAt,
    updatedAt: input.updatedAt === null ? undefined : typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : createdAt,
  };
}

function listCustomRelations(appPaths) {
  return readRelationStore(appPaths)
    .relations
    .map(normalizeCustomRelation)
    .filter(Boolean);
}

function projectedRelationLayers(context) {
  const local = listCustomRelations(context.appPaths);
  const account = context.accountGraphProjection?.() || { relations: [], suppressedLocalIds: [] };
  const localIds = new Set(local.map(relation => relation.id));
  const suppressed = new Set(account.suppressedLocalIds);
  const accountIds = new Set(account.relations.map(relation => relation.id));
  return { local: local.filter(relation => !suppressed.has(relation.id) || accountIds.has(relation.id)),
    account: account.relations.filter(relation => !localIds.has(relation.id)) };
}
function createKnowledgeGraphSnapshot(context, request) {
  if (!context.accountGraphProjection) return createLocalKnowledgeGraphSnapshot(context, request);
  const layers = projectedRelationLayers(context);
  return require('../../packages/graph-core/index.cjs').createKnowledgeGraphCore({
    cleanString, listCustomRelations: () => [...layers.local, ...layers.account],
  }).createKnowledgeGraphSnapshot(context, request);
}













function graphItemText(node, library, notes) {
  if (node.type === 'paper') {
    const paper = library.papers.find((item) => item.id === node.paperId);
    return [
      paper?.title,
      authorsText(paper || {}),
      paper?.year,
      paper?.publication,
      paper?.abstractText,
      paper?.keywords?.join(', '),
      paper?.aiSummary,
      paper?.userNote,
    ].filter(Boolean).join('\n').slice(0, 1200);
  }

  if (node.type === 'note') {
    const note = notes.find((item) => item.id === node.noteId);
    return [note?.title, note?.contentText || note?.excerpt || note?.content]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1000);
  }

  return [node.label, node.subtitle].filter(Boolean).join('\n').slice(0, 500);
}

function buildAiRelationPrompt(payload) {
  const system = [
    'You are PaperQuay Knowledge Graph Builder.',
    'Infer useful scholarly graph relations among existing nodes only.',
    'Return strict JSON only. Do not use markdown fences.',
    'Never invent node ids. sourceId and targetId must be copied exactly from the provided nodes.',
    'Prefer high-signal relations: builds_on, contrasts_with, same_problem, same_method, uses_dataset, supports, extends, explains, summarizes, prerequisite_of.',
    'Do not duplicate existing edges. Skip weak or obvious generic relations.',
    'Each relation needs a concise label, evidence-grounded description, and confidence between 0 and 1.',
    'Example JSON: {"relations":[{"sourceId":"paper:paper-a","targetId":"note:note-b","label":"explains","description":"The note summarizes the paper method and limitations.","confidence":0.84}]}',
  ].join('\n');

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Suggest PaperQuay knowledge graph relations.',
        allowedNodeIds: payload.nodes.map((node) => node.id),
        nodes: payload.nodes,
        existingEdges: payload.edges,
        focusNodeId: payload.focusNodeId || null,
        maxRelations: payload.maxRelations,
      }),
    },
  ];
}

function shouldFallbackToChatCompletions(error) {
  const message = toError(error);
  return (
    /responses HTTP (?:400|404|405|415|422|429|500|502|503|504)/i.test(message) ||
    /upstream request failed|upstream_error|bad gateway|gateway timeout|not found|method not allowed/i.test(message)
  );
}

async function openAiChatWithGraphFallback(options, messages, extra) {
  try {
    return await openAiChat(options, messages, extra);
  } catch (error) {
    if (options?.apiMode !== 'responses' || !shouldFallbackToChatCompletions(error)) {
      throw error;
    }

    return openAiChat(
      {
        ...options,
        apiMode: 'chat_completions',
      },
      messages,
      extra,
    );
  }
}

async function suggestAiRelations(context, request = {}, options = {}) {
  const maxRelations = normalizeLimit(request.maxRelations, 8, 1, MAX_AI_GRAPH_SUGGESTIONS);
  const snapshot = createKnowledgeGraphSnapshot(context, {
    includeEmbeddingEdges: true,
    includeCustomRelations: true,
    embeddingEdgeLimit: 80,
    embeddingMinSimilarity: Number.isFinite(Number(request.embeddingMinSimilarity))
      ? Number(request.embeddingMinSimilarity)
      : 0.78,
    localNodeId: cleanString(request.focusNodeId),
    localDepth: cleanString(request.focusNodeId) ? normalizeLimit(request.localDepth, 2, 1, 4) : 0,
  });
  const library = context.store.load();
  const notes = context.noteStore.listAllNotes();
  const focusNodeId = cleanString(request.focusNodeId);
  const nodes = snapshot.nodes
    .filter((node) => node.type === 'paper' || node.type === 'note')
    .slice(0, MAX_AI_GRAPH_ITEMS)
    .map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      text: graphItemText(node, library, notes),
    }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const existingEdgeKeys = new Set(
    snapshot.edges.map((edge) => `${edge.source}->${edge.target}`),
  );

  if (nodes.length < 2) {
    return [];
  }

  const data = await openAiChatWithGraphFallback(
    options,
    buildAiRelationPrompt({
      nodes,
      edges: snapshot.edges
        .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
        .map((edge) => ({
          sourceId: edge.source,
          targetId: edge.target,
          type: edge.type,
          label: edge.label,
        }))
        .slice(0, 160),
      focusNodeId,
      maxRelations,
    }),
    { responseFormat: { type: 'json_object' } },
  );
  const parsed = parseJsonObject(pickChatText(data));
  const rawRelations = Array.isArray(parsed?.relations) ? parsed.relations : [];
  const seen = new Set();

  return rawRelations
    .map((relation) => {
      const sourceId = cleanString(relation.sourceId || relation.source);
      const targetId = cleanString(relation.targetId || relation.target);
      const label = cleanString(relation.label) || 'related';
      const key = `${sourceId}->${targetId}:${label.toLowerCase()}`;

      if (
        !nodeIds.has(sourceId) ||
        !nodeIds.has(targetId) ||
        sourceId === targetId ||
        existingEdgeKeys.has(`${sourceId}->${targetId}`) ||
        existingEdgeKeys.has(`${targetId}->${sourceId}`) ||
        seen.has(key)
      ) {
        return null;
      }

      seen.add(key);
      return {
        sourceId,
        targetId,
        label,
        description: cleanString(relation.description || relation.reason),
        confidence: typeof relation.confidence === 'number' && Number.isFinite(relation.confidence)
          ? Math.max(0, Math.min(1, relation.confidence))
          : undefined,
      };
    })
    .filter(Boolean)
    .slice(0, maxRelations);
}

function createKnowledgeGraphCommands(context) {
  return {
    knowledge_graph_get({ request = {} }) {
      return createKnowledgeGraphSnapshot(context, request);
    },
    knowledge_graph_list_relations() {
      const layers = projectedRelationLayers(context);
      return [...layers.local, ...layers.account];
    },
    knowledge_graph_create_relation({ request = {} }) {
      if (typeof request.id === 'string' && request.id.startsWith('account-graph:')
          && !listCustomRelations(context.appPaths).some(item => item.id === request.id)
          && context.updateAccountGraphRelation) return context.updateAccountGraphRelation(request);
      const relation = normalizeCustomRelation(request);

      if (!relation) {
        throw new Error('Invalid graph relation.');
      }

      const store = readRelationStore(context.appPaths);
      const nextRelations = [
        ...store.relations.filter((item) => cleanString(item.id) !== relation.id),
        relation,
      ];
      writeRelationStore(context.appPaths, { version: 1, relations: nextRelations });
      return relation;
    },
    knowledge_graph_delete_relation({ relationId }) {
      const targetId = cleanString(relationId);
      const store = readRelationStore(context.appPaths);
      if (targetId.startsWith('account-graph:') && !store.relations.some(item => cleanString(item.id) === targetId)
          && context.deleteAccountGraphRelation) return context.deleteAccountGraphRelation(targetId);
      const nextRelations = store.relations.filter((item) => cleanString(item.id) !== targetId);
      writeRelationStore(context.appPaths, { version: 1, relations: nextRelations });
      return { deleted: nextRelations.length !== store.relations.length };
    },
    knowledge_graph_suggest_relations: async ({ request = {}, options = {} }) => {
      try {
        return await suggestAiRelations(context, request, options);
      } catch (error) {
        throw new Error(`AI graph relation generation failed: ${toError(error)}`);
      }
    },
  };
}

module.exports = {
  createKnowledgeGraphCommands,
  createKnowledgeGraphSnapshot,
  extractPaperReferenceCandidates,
  shouldFallbackToChatCompletions,
};
