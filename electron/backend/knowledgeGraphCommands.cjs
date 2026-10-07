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

const NATIVE_LIBRARY_PREFIX = 'native-library:';
const PAPER_NODE_PREFIX = 'paper:';
const RELATION_STORE_FILE = 'paperquay-knowledge-graph-relations.json';
const MAX_REFERENCE_NODES_PER_PAPER = 48;
const MAX_CO_AUTHOR_EDGES_PER_PAPER = 5;
const MAX_AI_GRAPH_ITEMS = 60;
const MAX_AI_GRAPH_SUGGESTIONS = 16;

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return value !== false;
}

function normalizeLimit(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function paperNodeId(paperId) {
  return `paper:${paperId}`;
}

function normalizePaperReferenceId(value) {
  const raw = cleanString(value);

  if (!raw) return '';

  if (raw.startsWith(NATIVE_LIBRARY_PREFIX)) {
    return raw.slice(NATIVE_LIBRARY_PREFIX.length);
  }

  if (raw.startsWith(PAPER_NODE_PREFIX)) {
    return raw.slice(PAPER_NODE_PREFIX.length);
  }

  return raw;
}

function noteNodeId(noteId) {
  return `note:${noteId}`;
}

function tagNodeId(tag) {
  return `tag:${tag.trim().toLowerCase()}`;
}

function categoryNodeId(categoryId) {
  return `category:${categoryId}`;
}

function uniqueEdgeId(type, source, target) {
  return `${type}:${source}->${target}`;
}

function normalizeDoi(value) {
  return cleanString(value)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[。.,;，；\s]+$/g, '')
    .toLowerCase();
}

function normalizeTitleKey(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/doi:\s*\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAuthorKey(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

  const createdAt = Number(input.createdAt) || Date.now();
  return {
    id: cleanString(input.id) || id(type === 'ai_suggested' ? 'kgai' : 'kgrel'),
    source,
    target,
    type,
    label,
    description: cleanString(input.description),
    confidence: Number.isFinite(Number(input.confidence))
      ? Math.max(0, Math.min(1, Number(input.confidence)))
      : type === 'ai_suggested'
        ? 0.7
        : undefined,
    weight: Number.isFinite(Number(input.weight))
      ? Math.max(0.1, Math.min(1, Number(input.weight)))
      : type === 'ai_suggested'
        ? 0.66
        : 0.58,
    createdAt,
    updatedAt: Number(input.updatedAt) || createdAt,
  };
}

function listCustomRelations(appPaths) {
  return readRelationStore(appPaths)
    .relations
    .map(normalizeCustomRelation)
    .filter(Boolean);
}

function textValuesFromUnknown(value, depth = 0) {
  if (value == null || depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => textValuesFromUnknown(item, depth + 1));
  if (typeof value !== 'object') return [];

  return [
    value.title,
    value.displayName,
    value.articleTitle,
    value.doi,
    value.DOI,
    value.raw,
    value.text,
    value.unstructured,
    value.citation,
  ].flatMap((item) => textValuesFromUnknown(item, depth + 1));
}

function normalizeReferenceCandidate(value) {
  if (!value) return null;
  const rawText = textValuesFromUnknown(value).join(' ').replace(/\s+/g, ' ').trim();
  const doiMatch = rawText.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i);
  const doi = normalizeDoi(
    typeof value === 'object'
      ? value.doi || value.DOI || value.doiUrl || value.url
      : doiMatch?.[0],
  ) || normalizeDoi(doiMatch?.[0]);
  const objectTitle = typeof value === 'object'
    ? cleanString(value.title || value.displayName || value.articleTitle || value.name)
    : '';
  const title = objectTitle || rawText
    .replace(/^\s*(\[\d+\]|\d+\.|\(\d+\))\s*/, '')
    .replace(/\bdoi:\s*\S+/ig, '')
    .replace(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!doi && !title) {
    return null;
  }

  return {
    doi,
    title: title.slice(0, 260),
    raw: rawText.slice(0, 600),
  };
}

function extractPaperReferenceCandidates(paper) {
  const sources = [
    paper.references,
    paper.referenceList,
    paper.referenceTitles,
    paper.referenceDois,
    paper.parsedReferences,
    paper.bibliography,
    paper.bibliographyText,
    paper.metadata?.references,
  ];
  const candidates = [];

  for (const source of sources) {
    if (Array.isArray(source)) {
      candidates.push(...source.map(normalizeReferenceCandidate).filter(Boolean));
      continue;
    }

    if (typeof source === 'string') {
      const parts = source
        .split(/\n(?=\s*(?:\[\d+\]|\d+\.|\(\d+\))\s+)/)
        .flatMap((part) => part.split(/\n{2,}/));
      candidates.push(...parts.map(normalizeReferenceCandidate).filter(Boolean));
    }
  }

  const seen = new Set();
  return candidates
    .filter((candidate) => {
      const key = candidate.doi || normalizeTitleKey(candidate.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_REFERENCE_NODES_PER_PAPER);
}

function referenceCandidatesFromCache(store, papers) {
  if (!store || typeof store.loadAllReferences !== 'function') {
    return new Map();
  }

  const paperIds = new Set(papers.map((paper) => paper.id));
  const grouped = new Map();

  for (const reference of store.loadAllReferences()) {
    const paperId = cleanString(reference.paperId || reference.paper_id);
    if (!paperIds.has(paperId)) continue;

    const candidate = normalizeReferenceCandidate({
      doi: reference.doi,
      title: reference.title,
      articleTitle: reference.title,
      unstructured: reference.unstructured,
    });
    if (!candidate) continue;

    candidate.authors = cleanString(reference.authors);
    candidate.year = cleanString(reference.year);
    candidate.journal = cleanString(reference.journal);
    candidate.volume = cleanString(reference.volume);
    candidate.issue = cleanString(reference.issue);
    candidate.pages = cleanString(reference.pages);

    if (!grouped.has(paperId)) grouped.set(paperId, []);
    grouped.get(paperId).push(candidate);
  }

  for (const [paperId, references] of grouped) {
    const seen = new Set();
    grouped.set(
      paperId,
      references.filter((reference) => {
        const key = reference.doi || normalizeTitleKey(reference.title);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, MAX_REFERENCE_NODES_PER_PAPER),
    );
  }

  return grouped;
}

function findReferencedPaper(candidate, paper, papers, paperByDoi, paperByTitle) {
  if (candidate.doi) {
    const target = paperByDoi.get(candidate.doi);
    if (target && target.id !== paper.id) return target;
  }

  const titleKey = normalizeTitleKey(candidate.title);
  if (titleKey) {
    const exact = paperByTitle.get(titleKey);
    if (exact && exact.id !== paper.id) return exact;

    for (const target of papers) {
      if (target.id === paper.id) continue;
      const targetKey = normalizeTitleKey(target.title);
      if (targetKey.length >= 18 && titleKey.length >= 18 && (targetKey.includes(titleKey) || titleKey.includes(targetKey))) {
        return target;
      }
    }
  }

  return null;
}

function authorsText(paper) {
  const authors = Array.isArray(paper.authors) ? paper.authors : [];
  if (authors.length === 0) return '';
  const names = authors.map((author) => cleanString(author.name)).filter(Boolean);
  if (names.length <= 2) return names.join(', ');
  return `${names[0]} et al.`;
}

function addCoAuthorEdges({ papers, nodes, edges }) {
  const authorPapers = new Map();
  const authorLabels = new Map();

  for (const paper of papers) {
    for (const author of paper.authors ?? []) {
      const name = cleanString(author.name || author);
      const key = normalizeAuthorKey(name);
      if (!key || key.length < 2) continue;
      if (!authorPapers.has(key)) authorPapers.set(key, new Set());
      authorPapers.get(key).add(paper.id);
      if (!authorLabels.has(key)) authorLabels.set(key, name);
    }
  }

  const pairAuthors = new Map();
  for (const [authorKey, paperIds] of authorPapers) {
    const ids = Array.from(paperIds).sort();
    if (ids.length < 2 || ids.length > 80) continue;

    for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
        const key = `${ids[leftIndex]}::${ids[rightIndex]}`;
        if (!pairAuthors.has(key)) pairAuthors.set(key, []);
        pairAuthors.get(key).push(authorLabels.get(authorKey) || authorKey);
      }
    }
  }

  const edgeCountsByPaper = new Map();
  const rankedPairs = Array.from(pairAuthors.entries())
    .map(([pairKey, authors]) => {
      const [leftPaperId, rightPaperId] = pairKey.split('::');
      return { leftPaperId, rightPaperId, authors };
    })
    .sort((left, right) => right.authors.length - left.authors.length);

  for (const pair of rankedPairs) {
    const leftCount = edgeCountsByPaper.get(pair.leftPaperId) ?? 0;
    const rightCount = edgeCountsByPaper.get(pair.rightPaperId) ?? 0;
    if (leftCount >= MAX_CO_AUTHOR_EDGES_PER_PAPER || rightCount >= MAX_CO_AUTHOR_EDGES_PER_PAPER) {
      continue;
    }

    const source = paperNodeId(pair.leftPaperId);
    const target = paperNodeId(pair.rightPaperId);
    if (!nodes.has(source) || !nodes.has(target)) continue;

    const label = pair.authors.slice(0, 3).join(', ');
    const edgeId = uniqueEdgeId('co_author', source, target);
    edges.set(edgeId, {
      id: edgeId,
      source,
      target,
      type: 'co_author',
      label,
      description: pair.authors.length > 3
        ? `${label} and ${pair.authors.length - 3} more shared author(s)`
        : `Shared author(s): ${label}`,
      weight: Math.min(0.86, 0.5 + pair.authors.length * 0.08),
    });
    edgeCountsByPaper.set(pair.leftPaperId, leftCount + 1);
    edgeCountsByPaper.set(pair.rightPaperId, rightCount + 1);
  }
}

function notePreview(note) {
  return cleanString(note.contentText || note.excerpt || note.content).slice(0, 160);
}

function matchesSearch(node, search) {
  if (!search) return true;
  return [
    node.label,
    node.subtitle,
    node.tag,
    node.paperId,
    node.noteId,
    node.categoryId,
    node.referenceId,
    node.doi,
  ].filter(Boolean).join('\n').toLowerCase().includes(search);
}

function filterLocalGraph(snapshot, localNodeId, depth) {
  if (!localNodeId || depth <= 0 || !snapshot.nodes.some((node) => node.id === localNodeId)) {
    return snapshot;
  }

  const adjacency = new Map();
  for (const edge of snapshot.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  }

  const included = new Set([localNodeId]);
  const queue = [{ id: localNodeId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= depth) continue;

    for (const nextId of adjacency.get(current.id) ?? []) {
      if (included.has(nextId)) continue;
      included.add(nextId);
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }

  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => included.has(node.id)),
    edges: snapshot.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  };
}

function createKnowledgeGraphSnapshot(context, request = {}) {
  const { appPaths, noteStore, ragStore, store } = context;
  const includePapers = normalizeBoolean(request.includePapers, true);
  const includeNotes = normalizeBoolean(request.includeNotes, true);
  const includeTags = normalizeBoolean(request.includeTags, true);
  const includeCategories = normalizeBoolean(request.includeCategories, true);
  const includeReferences = normalizeBoolean(request.includeReferences, true);
  const includeCoAuthors = normalizeBoolean(request.includeCoAuthors, false);
  const includeCustomRelations = normalizeBoolean(request.includeCustomRelations, true);
  const includeEmbeddingEdges = normalizeBoolean(request.includeEmbeddingEdges, true);
  const embeddingEdgeLimit = normalizeLimit(request.embeddingEdgeLimit, 80, 0, 300);
  const embeddingMinSimilarity = Number.isFinite(Number(request.embeddingMinSimilarity))
    ? Math.max(-1, Math.min(1, Number(request.embeddingMinSimilarity)))
    : 0.82;
  const search = cleanString(request.search).toLowerCase();
  const localNodeId = cleanString(request.localNodeId);
  const localDepth = normalizeLimit(request.localDepth, 1, 0, 4);
  const library = store.load();
  const notes = includeNotes ? noteStore.listNotes({ limit: 5000 }) : [];
  const nodes = new Map();
  const edges = new Map();
  const paperIds = new Set(library.papers.map((paper) => paper.id));
  const paperByDoi = new Map(
    library.papers
      .map((paper) => [normalizeDoi(paper.doi), paper])
      .filter(([doi]) => doi),
  );
  const paperByTitle = new Map(
    library.papers
      .map((paper) => [normalizeTitleKey(paper.title), paper])
      .filter(([title]) => title),
  );
  const paperIdByReference = new Map();

  for (const paper of library.papers) {
    paperIdByReference.set(paper.id, paper.id);
    paperIdByReference.set(`${NATIVE_LIBRARY_PREFIX}${paper.id}`, paper.id);
    paperIdByReference.set(paperNodeId(paper.id), paper.id);
  }

  const resolvePaperReference = (value) => {
    const raw = cleanString(value);
    const normalized = normalizePaperReferenceId(raw);

    return paperIdByReference.get(raw) || paperIdByReference.get(normalized) || '';
  };

  if (includePapers) {
    for (const paper of library.papers) {
      nodes.set(paperNodeId(paper.id), {
        id: paperNodeId(paper.id),
        type: 'paper',
        label: paper.title,
        subtitle: [authorsText(paper), paper.year, paper.publication].filter(Boolean).join(' · '),
        paperId: paper.id,
        size: 34 + Math.min(18, Math.max(0, Number(paper.readingProgress) || 0) * 18),
      });
    }
  }

  if (includeNotes) {
    for (const note of notes) {
      nodes.set(noteNodeId(note.id), {
        id: noteNodeId(note.id),
        type: 'note',
        label: note.title || 'Untitled Note',
        subtitle: notePreview(note),
        noteId: note.id,
        paperId: resolvePaperReference(note.linkedPaperId || note.paperId) || undefined,
        size: note.isPinned ? 30 : 24,
      });

      const paperTargets = new Set([
        note.linkedPaperId,
        note.paperId,
        ...(Array.isArray(note.linkedPaperIds) ? note.linkedPaperIds : []),
        ...(Array.isArray(note.anchors) ? note.anchors.map((anchor) => anchor.paperId) : []),
      ].map(resolvePaperReference).filter((paperId) => paperId && paperIds.has(paperId)));

      for (const paperId of paperTargets) {
        const source = noteNodeId(note.id);
        const target = paperNodeId(paperId);
        if (nodes.has(target)) {
          edges.set(uniqueEdgeId('note_paper', source, target), {
            id: uniqueEdgeId('note_paper', source, target),
            source,
            target,
            type: 'note_paper',
            label: 'note',
            weight: 0.72,
          });
        }
      }

      for (const targetNoteId of note.linkedNoteIds ?? []) {
        const source = noteNodeId(note.id);
        const target = noteNodeId(targetNoteId);
        edges.set(uniqueEdgeId('note_link', source, target), {
          id: uniqueEdgeId('note_link', source, target),
          source,
          target,
          type: 'note_link',
          label: 'link',
          weight: 0.82,
        });
      }
    }
  }

  if (includeTags) {
    const tagCounts = new Map();
    for (const paper of library.papers) {
      for (const tag of paper.tags ?? []) {
        const name = cleanString(tag.name);
        if (!name) continue;
        tagCounts.set(name.toLowerCase(), {
          name,
          count: (tagCounts.get(name.toLowerCase())?.count ?? 0) + 1,
        });
      }
    }
    for (const note of notes) {
      for (const tag of note.tags ?? []) {
        const name = cleanString(tag);
        if (!name) continue;
        tagCounts.set(name.toLowerCase(), {
          name,
          count: (tagCounts.get(name.toLowerCase())?.count ?? 0) + 1,
        });
      }
    }

    for (const tag of tagCounts.values()) {
      nodes.set(tagNodeId(tag.name), {
        id: tagNodeId(tag.name),
        type: 'tag',
        label: `#${tag.name}`,
        subtitle: `${tag.count} item${tag.count === 1 ? '' : 's'}`,
        tag: tag.name,
        size: 20 + Math.min(16, tag.count * 2),
      });
    }

    for (const paper of library.papers) {
      for (const tag of paper.tags ?? []) {
        const source = paperNodeId(paper.id);
        const target = tagNodeId(cleanString(tag.name));
        if (!nodes.has(source) || !nodes.has(target)) continue;
        edges.set(uniqueEdgeId('paper_tag', source, target), {
          id: uniqueEdgeId('paper_tag', source, target),
          source,
          target,
          type: 'paper_tag',
          label: 'tag',
          weight: 0.42,
        });
      }
    }

    for (const note of notes) {
      for (const tag of note.tags ?? []) {
        const name = cleanString(tag);
        const source = noteNodeId(note.id);
        const target = tagNodeId(name);
        if (!name || !nodes.has(source) || !nodes.has(target)) continue;
        edges.set(uniqueEdgeId('note_tag', source, target), {
          id: uniqueEdgeId('note_tag', source, target),
          source,
          target,
          type: 'note_tag',
          label: 'tag',
          weight: 0.38,
        });
      }
    }
  }

  if (includeCategories) {
    const categoryById = new Map(library.categories.map((category) => [category.id, category]));
    for (const category of library.categories) {
      if (category.isSystem) continue;
      nodes.set(categoryNodeId(category.id), {
        id: categoryNodeId(category.id),
        type: 'category',
        label: category.name,
        subtitle: 'Collection',
        categoryId: category.id,
        size: 24 + Math.min(14, Number(category.paperCount) || 0),
      });
    }

    for (const paper of library.papers) {
      for (const categoryId of paper.categoryIds ?? []) {
        const category = categoryById.get(categoryId);
        if (!category || category.isSystem) continue;

        const source = paperNodeId(paper.id);
        const target = categoryNodeId(categoryId);
        if (!nodes.has(source) || !nodes.has(target)) continue;
        edges.set(uniqueEdgeId('paper_category', source, target), {
          id: uniqueEdgeId('paper_category', source, target),
          source,
          target,
          type: 'paper_category',
          label: 'category',
          weight: 0.48,
        });
      }
    }
  }

  if (includeReferences) {
    const referencesByPaperId = referenceCandidatesFromCache(store, library.papers);

    for (const paper of library.papers) {
      const source = paperNodeId(paper.id);
      if (!nodes.has(source)) continue;

      const references = referencesByPaperId.get(paper.id) ?? extractPaperReferenceCandidates(paper);
      for (const reference of references) {
        const targetPaper = findReferencedPaper(reference, paper, library.papers, paperByDoi, paperByTitle);

        if (targetPaper) {
          const target = paperNodeId(targetPaper.id);
          if (!nodes.has(target)) continue;
          const edgeId = uniqueEdgeId('paper_cites_paper', source, target);
          edges.set(edgeId, {
            id: edgeId,
            source,
            target,
            type: 'paper_cites_paper',
            label: 'cites',
            description: reference.raw || reference.title || reference.doi,
            weight: 0.78,
          });
          continue;
        }

        // Crossref may return many references that are outside the local library.
        // Keep them in the cache, but only surface references that resolve to local papers.
      }
    }
  }

  if (includeCoAuthors) {
    addCoAuthorEdges({ papers: library.papers, nodes, edges });
  }

  if (includeEmbeddingEdges && ragStore?.available !== false && typeof ragStore?.listDocumentSimilarities === 'function') {
    const documentKeys = library.papers.flatMap((paper) => [
      paper.id,
      `${NATIVE_LIBRARY_PREFIX}${paper.id}`,
    ]);
    for (const similarity of ragStore.listDocumentSimilarities({
      documentKeys,
      limit: embeddingEdgeLimit,
      minSimilarity: embeddingMinSimilarity,
    })) {
      const sourcePaperId = resolvePaperReference(similarity.sourceDocumentKey);
      const targetPaperId = resolvePaperReference(similarity.targetDocumentKey);

      if (!sourcePaperId || !targetPaperId || sourcePaperId === targetPaperId) {
        continue;
      }

      const source = paperNodeId(sourcePaperId);
      const target = paperNodeId(targetPaperId);
      if (!nodes.has(source) || !nodes.has(target)) continue;

      const id = uniqueEdgeId('related_by_embedding', source, target);
      edges.set(id, {
        id,
        source,
        target,
        type: 'related_by_embedding',
        label: 'similar',
        weight: similarity.similarity,
      });
    }
  }

  if (includeCustomRelations) {
    for (const relation of listCustomRelations(appPaths)) {
      if (!nodes.has(relation.source) || !nodes.has(relation.target)) continue;
      edges.set(relation.id, {
        id: relation.id,
        source: relation.source,
        target: relation.target,
        type: relation.type,
        label: relation.label,
        description: relation.description,
        confidence: relation.confidence,
        weight: relation.weight,
        createdAt: relation.createdAt,
        updatedAt: relation.updatedAt,
      });
    }
  }

  let snapshot = {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()).filter((edge) => nodes.has(edge.source) && nodes.has(edge.target)),
    generatedAt: Date.now(),
  };

  if (search) {
    const matchedNodes = new Set(snapshot.nodes.filter((node) => matchesSearch(node, search)).map((node) => node.id));
    const neighborNodes = new Set(matchedNodes);
    for (const edge of snapshot.edges) {
      if (matchedNodes.has(edge.source)) neighborNodes.add(edge.target);
      if (matchedNodes.has(edge.target)) neighborNodes.add(edge.source);
    }

    snapshot = {
      ...snapshot,
      nodes: snapshot.nodes.filter((node) => neighborNodes.has(node.id)),
      edges: snapshot.edges.filter((edge) => neighborNodes.has(edge.source) && neighborNodes.has(edge.target)),
    };
  }

  return filterLocalGraph(snapshot, localNodeId, localDepth);
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
  const notes = context.noteStore.listNotes({ limit: 5000 });
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
        confidence: Number.isFinite(Number(relation.confidence))
          ? Math.max(0, Math.min(1, Number(relation.confidence)))
          : 0.7,
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
      return listCustomRelations(context.appPaths);
    },
    knowledge_graph_create_relation({ request = {} }) {
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
