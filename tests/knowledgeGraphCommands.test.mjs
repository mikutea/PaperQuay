import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createKnowledgeGraphSnapshot,
  shouldFallbackToChatCompletions,
} from '../electron/backend/knowledgeGraphCommands.cjs';

function createContext(overrides = {}) {
  return {
    appPaths: {
      dataDir: overrides.dataDir ?? path.join(os.tmpdir(), `paperquay-graph-empty-fixture-${process.pid}`),
    },
    store: {
      load() {
        return {
          papers: [
            {
              id: 'paper-1',
              title: 'Retrieval-Augmented Paper Reading',
              authors: [{ name: 'Smith J' }, { name: 'Chen L' }],
              year: '2025',
              publication: 'PaperQuay Journal',
              readingProgress: 0.5,
              tags: [{ name: 'RAG' }],
              categoryIds: ['cat-1'],
              references: [
                {
                  title: 'Semantic Literature Graphs',
                  doi: '10.1234/graph.1',
                },
                '[2] External Graph Mining Reference. doi:10.9999/external.1',
              ],
            },
            {
              id: 'paper-2',
              title: 'Semantic Literature Graphs',
              doi: '10.1234/graph.1',
              authors: [{ name: 'Wang K' }],
              year: '2024',
              publication: 'Knowledge Systems',
              readingProgress: 0,
              tags: [{ name: 'Graph' }],
              categoryIds: ['cat-1'],
            },
          ],
          categories: [
            {
              id: 'cat-1',
              name: 'Reading Systems',
              paperCount: 2,
              isSystem: false,
            },
          ],
        };
      },
      loadAllReferences() {
        return overrides.paperReferences ?? [];
      },
    },
    noteStore: {
      listNotes() {
        return [
          {
            id: 'note-1',
            title: 'RAG reading note',
            contentText: 'Connects paper parsing, RAG retrieval, and inline notes.',
            tags: ['RAG'],
            linkedPaperId: 'native-library:paper-1',
            linkedPaperIds: ['native-library:paper-2'],
            linkedNoteIds: ['note-2'],
            anchors: [{ paperId: 'native-library:paper-1' }],
            isPinned: true,
          },
          {
            id: 'note-2',
            title: 'Graph note',
            contentText: 'Graph view helps inspect related papers.',
            tags: ['Graph'],
            linkedPaperIds: [],
            linkedNoteIds: [],
            anchors: [],
          },
        ];
      },
    },
    ragStore: {
      available: true,
      listDocumentSimilarities() {
        return [
          {
            sourceDocumentKey: 'native-library:paper-1',
            targetDocumentKey: 'native-library:paper-2',
            similarity: 0.91,
            sourceTypes: ['mineru'],
          },
        ];
      },
    },
  };
}

test('knowledge graph snapshot includes library, note, tag, category, and embedding edges', () => {
  const snapshot = createKnowledgeGraphSnapshot(createContext(), {
    embeddingMinSimilarity: 0.8,
    embeddingEdgeLimit: 10,
  });
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const edgeTypes = new Set(snapshot.edges.map((edge) => edge.type));

  assert.ok(nodeIds.has('paper:paper-1'));
  assert.ok(nodeIds.has('paper:paper-2'));
  assert.ok(nodeIds.has('note:note-1'));
  assert.ok(nodeIds.has('tag:rag'));
  assert.ok(nodeIds.has('category:cat-1'));
  assert.ok(edgeTypes.has('note_paper'));
  assert.ok(edgeTypes.has('note_link'));
  assert.ok(edgeTypes.has('paper_tag'));
  assert.ok(edgeTypes.has('note_tag'));
  assert.ok(edgeTypes.has('paper_category'));
  assert.ok(edgeTypes.has('related_by_embedding'));
  assert.ok(edgeTypes.has('paper_cites_paper'));
  assert.ok(!edgeTypes.has('paper_reference'));

  const semanticEdge = snapshot.edges.find((edge) => edge.type === 'related_by_embedding');
  assert.equal(semanticEdge?.source, 'paper:paper-1');
  assert.equal(semanticEdge?.target, 'paper:paper-2');
  assert.equal(semanticEdge?.weight, 0.91);
});

test('knowledge graph builds citation edges from cached paper references', () => {
  const snapshot = createKnowledgeGraphSnapshot(createContext({
    paperReferences: [
      {
        id: 'ref:paper-2:1',
        paperId: 'paper-2',
        seq: 1,
        doi: '10.1234/graph.1',
        title: 'Retrieval-Augmented Paper Reading',
        authors: 'Smith J',
        year: '2025',
        journal: 'PaperQuay Journal',
        pages: '1-10',
        unstructured: '',
        fetchedAt: Date.now(),
      },
      {
        id: 'ref:paper-2:2',
        paperId: 'paper-2',
        seq: 2,
        doi: '10.7777/external.2',
        title: 'External Cached Reference',
        unstructured: 'External Cached Reference. doi:10.7777/external.2',
        fetchedAt: Date.now(),
      },
    ],
  }), {
    includeReferences: true,
  });

  const citeEdge = snapshot.edges.find((edge) =>
    edge.type === 'paper_cites_paper' &&
    edge.source === 'paper:paper-2' &&
    edge.target === 'paper:paper-1',
  );
  const externalNode = snapshot.nodes.find((node) =>
    node.type === 'reference' &&
    node.label === 'External Cached Reference',
  );
  const externalReferenceEdge = snapshot.edges.find((edge) => edge.type === 'paper_reference');

  assert.ok(citeEdge);
  assert.equal(externalNode, undefined);
  assert.equal(externalReferenceEdge, undefined);
});

test('knowledge graph includes persisted custom and AI-approved relations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'paperquay-graph-'));

  try {
    await writeFile(
      path.join(dir, 'paperquay-knowledge-graph-relations.json'),
      JSON.stringify({
        version: 1,
        relations: [
          {
            id: 'rel-1',
            source: 'paper:paper-1',
            target: 'note:note-1',
            type: 'custom_relation',
            label: 'explains',
            description: 'The note explains the paper.',
          },
          {
            id: 'rel-2',
            source: 'note:note-1',
            target: 'paper:paper-2',
            type: 'ai_suggested',
            label: 'contrasts_with',
            confidence: 0.82,
          },
        ],
      }),
      'utf8',
    );

    const snapshot = createKnowledgeGraphSnapshot(createContext({ dataDir: dir }));
    const customEdge = snapshot.edges.find((edge) => edge.id === 'rel-1');
    const aiEdge = snapshot.edges.find((edge) => edge.id === 'rel-2');

    assert.equal(customEdge?.type, 'custom_relation');
    assert.equal(customEdge?.label, 'explains');
    assert.equal(aiEdge?.type, 'ai_suggested');
    assert.equal(aiEdge?.confidence, 0.82);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('knowledge graph AI generation falls back when responses upstream fails', () => {
  assert.equal(
    shouldFallbackToChatCompletions(
      new Error('OpenAI-compatible responses HTTP 502: {"error":{"message":"Upstream request failed","type":"upstream_error"}}'),
    ),
    true,
  );
  assert.equal(shouldFallbackToChatCompletions(new Error('Model returned invalid JSON')), false);
});

test('knowledge graph local mode keeps only nodes within the requested depth', () => {
  const snapshot = createKnowledgeGraphSnapshot(createContext(), {
    localNodeId: 'paper:paper-1',
    localDepth: 1,
  });
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));

  assert.ok(nodeIds.has('paper:paper-1'));
  assert.ok(nodeIds.has('note:note-1'));
  assert.ok(nodeIds.has('tag:rag'));
  assert.ok(nodeIds.has('category:cat-1'));
  assert.equal(nodeIds.has('note:note-2'), false);
});
