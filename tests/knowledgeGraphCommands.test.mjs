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
      listAllNotes() {
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

test('persisted unknown graph scores and epoch timestamps survive actual desktop read and create commands without invented values',async t=>{
 const prefix=path.resolve(os.tmpdir(),'paperquay-graph-contract-'),dir=await mkdtemp(prefix);
 t.after(async()=>{assert(path.isAbsolute(dir)&&path.resolve(dir).startsWith(prefix));await rm(dir,{recursive:true,force:true});});
 const {createKnowledgeGraphCommands}=await import('../electron/backend/knowledgeGraphCommands.cjs'),commands=createKnowledgeGraphCommands(createContext({dataDir:dir}));
 for(const [index,confidence] of [[0,null],[1,undefined],[2,'0.7'],[3,true],[4,0],[5,.82]]){
  const relation=commands.knowledge_graph_create_relation({request:{id:'unknown-score-'+index,source:'paper:paper-1',target:'note:note-1',type:'ai_suggested',label:'Saved relation '+index,confidence,createdAt:0,updatedAt:0}});
  assert.equal(relation.createdAt,0);assert.equal(relation.updatedAt,0);assert.equal(relation.confidence,typeof confidence==='number'?confidence:undefined);
 }
 const rows=commands.knowledge_graph_list_relations();
 for(const row of rows){assert.equal(row.createdAt,0);assert.equal(row.updatedAt,0);}
 const snapshot=commands.knowledge_graph_get({request:{includeCustomRelations:true}});assert.equal(snapshot.edges.find(e=>e.id==='unknown-score-0').confidence,undefined);assert.equal(snapshot.edges.find(e=>e.id==='unknown-score-4').confidence,0);assert.equal(snapshot.edges.find(e=>e.id==='unknown-score-5').confidence,.82);
});
test('an explicitly unknown modification time is distinct from a known creation time in stored desktop relations',async t=>{
 const prefix=path.resolve(os.tmpdir(),'paperquay-graph-clock-'),dir=await mkdtemp(prefix);t.after(async()=>{assert(path.isAbsolute(dir)&&path.resolve(dir).startsWith(prefix));await rm(dir,{recursive:true,force:true});});
 await writeFile(path.join(dir,'paperquay-knowledge-graph-relations.json'),JSON.stringify({version:1,relations:[{id:'unknown-clock',source:'paper:paper-1',target:'note:note-1',type:'ai_suggested',label:'Unknown clock',confidence:null,createdAt:0,updatedAt:null}]}));
 const snapshot=createKnowledgeGraphSnapshot(createContext({dataDir:dir})),edge=snapshot.edges.find(e=>e.id==='unknown-clock');assert.equal(edge.confidence,undefined);assert.equal(edge.createdAt,0);assert.equal(edge.updatedAt,undefined);
});


test('account graph overlay is scoped per context and suppresses only its acknowledged local source', async () => {
  const { createKnowledgeGraphCommands } = await import('../electron/backend/knowledgeGraphCommands.cjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'paperquay-graph-overlay-'));
  try {
    const local = { id: 'local-graph', source: 'paper:paper-1', target: 'paper:paper-2', type: 'ai_suggested',
      label: 'Local draft', description: 'Original local bytes', confidence: null, weight: 0.58, createdAt: 0 };
    const original = JSON.stringify({ version: 1, relations: [local] }, null, 2);
    await writeFile(path.join(root, 'paperquay-knowledge-graph-relations.json'), original);
    const overlay = { ...local, id: 'account-graph:11111111-1111-4111-8111-111111111111', label: 'Accepted account version', scope: 'account' };
    const a = createContext({ dataDir: root }), b = createContext({ dataDir: root });
    a.accountGraphProjection = () => ({ relations: [overlay], suppressedLocalIds: ['local-graph'] });
    b.accountGraphProjection = () => ({ relations: [], suppressedLocalIds: [] });
    const aEdges = createKnowledgeGraphCommands(a).knowledge_graph_get({}).edges.filter(row => ['custom_relation','ai_suggested'].includes(row.type));
    const bEdges = createKnowledgeGraphCommands(b).knowledge_graph_get({}).edges.filter(row => ['custom_relation','ai_suggested'].includes(row.type));
    assert.deepEqual(aEdges.map(row => [row.id,row.scope,row.confidence,row.createdAt]), [[overlay.id,'account',null,0]]);
    assert.deepEqual(bEdges.map(row => row.id), [local.id]);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(path.join(root, 'paperquay-knowledge-graph-relations.json'),'utf8'), original);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('paperquay-graph-overlay-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('account relation commands delegate originals without rewriting the local graph', async () => {
  const { createKnowledgeGraphCommands } = await import('../electron/backend/knowledgeGraphCommands.cjs');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'paperquay-graph-overlay-'));
  try {
    const file = path.join(root, 'paperquay-knowledge-graph-relations.json'), original = '{"version":1,"relations":[],"untouched":"extension"}';
    await writeFile(file, original);
    const ctx = createContext({ dataDir: root }), calls = [];
    ctx.updateAccountGraphRelation = async request => { calls.push(['update',request]); return request; };
    ctx.deleteAccountGraphRelation = async id => { calls.push(['delete',id]); return { deleted: true }; };
    const commands = createKnowledgeGraphCommands(ctx);
    const request = { id:'account-graph:11111111-1111-4111-8111-111111111111',source:'paper:paper-1',target:'paper:paper-2',label:'Explicit edit',confidence:null };
    assert.deepEqual(await commands.knowledge_graph_create_relation({ request }), request);
    assert.deepEqual(await commands.knowledge_graph_delete_relation({ relationId:request.id }), {deleted:true});
    assert.deepEqual(calls,[['update',request],['delete',request.id]]);
    assert.equal(await readFile(file,'utf8'),original);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('paperquay-graph-overlay-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('a colliding local relation ID remains local and cannot be shadowed or remotely deleted', async () => {
  const { createKnowledgeGraphCommands } = await import('../electron/backend/knowledgeGraphCommands.cjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'paperquay-graph-overlay-'));
  try {
    const local = { id:'account-graph:11111111-1111-4111-8111-111111111111',source:'paper:paper-1',target:'paper:paper-2',type:'custom_relation',label:'Actual local relation',createdAt:0 };
    await writeFile(path.join(root,'paperquay-knowledge-graph-relations.json'),JSON.stringify({version:1,relations:[local]}));
    const ctx=createContext({dataDir:root});
    ctx.accountGraphProjection=()=>({relations:[{...local,label:'Account relation',scope:'account'}],suppressedLocalIds:[]});
    ctx.deleteAccountGraphRelation=()=>assert.fail('must not delete remote collision');
    const commands=createKnowledgeGraphCommands(ctx);
    assert.equal(commands.knowledge_graph_list_relations()[0].label,local.label);
    assert.equal(commands.knowledge_graph_list_relations()[0].scope,undefined);
    ctx.accountGraphProjection=()=>({relations:[{...local,label:'Account relation',scope:'account'}],suppressedLocalIds:[local.id]});
    assert.equal(commands.knowledge_graph_list_relations()[0].label,local.label,'a suppressed local ID collision must not hide both layers');
    assert.deepEqual(commands.knowledge_graph_delete_relation({relationId:local.id}),{deleted:true});
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('paperquay-graph-overlay-'));
    await rm(root, { recursive: true, force: true });
  }
});
