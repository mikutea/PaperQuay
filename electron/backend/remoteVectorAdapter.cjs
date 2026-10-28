const { createHash } = require('node:crypto');
const { journalArtifact } = require('./remoteTaskJournal.cjs');
const { remoteUrl, readBounded } = require('./remoteMineruAdapter.cjs');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const CHUNKER_CONFIG = Object.freeze({ id: 'parsed-blocks', revision: 1, characters: 900, overlap: 120,
  source: 'portable-v1', markdown: 'visible-math-text-v1', table: 'structured-text-v1', continuation: 'inherit-v1' });
const REMOTE_VECTOR_CHUNKER = Object.freeze({ id: CHUNKER_CONFIG.id, revision: CHUNKER_CONFIG.revision, digest: sha(JSON.stringify(CHUNKER_CONFIG)) });
let markdownParser;
async function visibleMarkdown(value) {
  if (!markdownParser) markdownParser = Promise.all([import('unified'), import('remark-parse'), import('remark-math')])
    .then(([{ unified }, { default: parse }, { default: math }]) => unified().use(parse).use(math));
  const tree = (await markdownParser).parse(value);
  let nodes = 0;
  function visit(node, depth = 0) {
    if (++nodes > 200000 || depth > 128) fail('SOURCE_UNAVAILABLE');
    if (node.type === 'definition') return '';
    if (node.type === 'image' || node.type === 'imageReference') return node.alt || '';
    if (node.type === 'html') {
      const source = node.value || ''; let offset = 0;
      while (offset < source.length) {
        while (/\s/.test(source[offset] || '') && offset < source.length) offset++;
        if (offset === source.length) return '';
        if (!source.startsWith('<!--', offset)) fail('SOURCE_UNAVAILABLE');
        const end = source.indexOf('-->', offset + 4); if (end < 0) fail('SOURCE_UNAVAILABLE'); offset = end + 3;
      }
      return '';
    }
    if (node.type === 'inlineMath') return '$' + node.value + '$';
    if (node.type === 'math') return '$$\n' + node.value + '\n$$';
    if (node.type === 'break') return '\n';
    if (node.type === 'thematicBreak') return '\n---\n';
    if (typeof node.value === 'string') return node.value;
    const separator = ['root', 'list', 'listItem', 'blockquote'].includes(node.type) ? '\n' : '';
    return (node.children || []).map((child) => visit(child, depth + 1)).join(separator);
  }
  return visit(tree).trim();
}
function resolveBlocks(document) {
  const original = new Map(document.blocks.map((block) => [block.id, block])); const done = new Map();
  for (const block of document.blocks) {
    const stack = []; let current = block;
    while (current && !done.has(current.id)) { stack.push(current); current = current.sourceBlockId ? original.get(current.sourceBlockId) : null; }
    while (stack.length) {
      const next = stack.pop(); const source = done.get(next.sourceBlockId);
      const result = { ...next };
      if (source) for (const key of ['text', 'markdown', 'latex', 'table', 'assetId', 'caption', 'footnote']) {
        if (result[key] === undefined || result[key] === '') result[key] = source[key];
      }
      done.set(next.id, result);
    }
  }
  return document.blocks.map((block) => done.get(block.id));
}
/** Full package source, independently bounded from the smaller chat context.
 * No asset bytes, resource targets, local IDs or legacy ragStore keys escape. */
async function buildRemoteVectorChunks(document) {
  const chunks = []; const markdownCache = new Map(); const tables = new WeakMap(); let characters = 0;
  const markdown = async (value) => {
    if (!markdownCache.has(value)) markdownCache.set(value, visibleMarkdown(value)); return markdownCache.get(value);
  };
  const table = async (value) => {
    if (!tables.has(value)) tables.set(value, (async () => {
      const caption = await markdown(value.caption); const rows = [`Table: ${caption}`]; let visible = Boolean(caption.trim());
      for (const row of value.rows) {
        const cells = [];
        for (const cell of row.cells) {
          const text = await markdown(cell.text); visible ||= Boolean(text.trim());
          cells.push(`[${cell.header ? 'header' : 'cell'} rowspan=${cell.rowSpan} colspan=${cell.colSpan}] ${text}`);
        }
        rows.push(`[${row.section}] ${cells.join(' | ')}`);
      }
      return visible ? rows.join('\n') : '';
    })());
    return tables.get(value);
  };
  for (const block of resolveBlocks(document)) {
    const parts = [];
    if (block.kind === 'equation' && block.latex) parts.push(`$$${block.latex}$$`);
    else if (block.kind === 'table' && block.table) parts.push(await table(block.table));
    else if (block.markdown) parts.push(await markdown(block.markdown));
    else if (block.text) parts.push(block.text);
    if (block.kind === 'equation' && block.latex && (block.markdown || block.text) !== block.latex) parts.push(await markdown(block.markdown || block.text || ''));
    if (block.kind === 'table' && block.table && (block.markdown || block.text)) parts.push(await markdown(block.markdown || block.text));
    if (!parts.some((value) => value.trim()) && block.text) parts.push(block.text);
    if (block.caption && block.caption !== block.table?.caption) parts.push(await markdown(block.caption));
    if (block.footnote) parts.push(await markdown(block.footnote));
    const text = [...new Set(parts.filter((value) => value.trim()))].join('\n').trim();
    if (!text) continue;
    characters += text.length;
    if (characters > 2000000) fail('REMOTE_TASK_ARTIFACT_LIMIT');
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + CHUNKER_CONFIG.characters);
      if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--;
      const content = text.slice(offset, end).trim();
      if (content) chunks.push({ id: `c${chunks.length}`, pageIndex: block.pageIndex, text: content });
      if (chunks.length > 10000) fail('REMOTE_TASK_ARTIFACT_LIMIT');
      if (end === text.length) break;
      offset = end - CHUNKER_CONFIG.overlap;
      if (/[\udc00-\udfff]/.test(text[offset]) && /[\ud800-\udbff]/.test(text[offset - 1])) offset++;
    }
  }
  if (!chunks.length) fail('SOURCE_UNAVAILABLE'); return chunks;
}
function createRemoteVectorAdapter(options) {
  if (typeof options?.getConfig !== 'function' || typeof options.readParsed !== 'function') fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
  const fetcher = options.fetch || fetch;
  const core = () => options.core || require('../generated/desktopSyncCore.cjs');
  return { async execute(context) {
    const { task, snapshot, pdf, signal, checkpoint } = context;
    const check = async () => { if (signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED'); await context.check(); if (signal?.aborted) fail('DESKTOP_OPERATION_CANCELLED'); };
    await check(); const config = await options.getConfig({ task, snapshot }); await check();
    if (!config || config.model !== task.profile.model || !Number.isInteger(config.dimensions) || config.dimensions < 1 || config.dimensions > 4096
      || typeof config.apiKey !== 'string' || !config.apiKey || config.apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(config.apiKey)) fail('PROFILE_CHANGED');
    const base = remoteUrl(config.baseUrl); const endpoint = /\/embeddings$/i.test(base) ? base : base.replace(/\/(?:chat\/completions|models|responses?)$/i, '') + '/embeddings';
    const batchSize = config.batchSize ?? 16; const timeout = config.timeoutMs ?? 180000;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64 || !Number.isInteger(timeout) || timeout < 1 || timeout > 600000) fail('REMOTE_PROVIDER_CONFIGURATION_INVALID');
    const raw = await options.readParsed({ task, snapshot, pdf, signal, check }); await check();
    const parsed = raw?.document ? await core().verifyParsedDocument(raw.document) : await core().decodeParsedDocument(new Uint8Array(raw?.bytes || raw));
    if (raw?.document && raw.digest !== parsed.digest) fail('SOURCE_UNAVAILABLE');
    const document = parsed.document;
    if (parsed.digest !== task.indexSourceDigest || document.paperId !== task.target.paperId || document.attachmentVersionId !== task.target.attachmentVersionId
      || document.pdf.sha256 !== task.target.sha256 || document.pdf.sizeBytes !== task.target.sizeBytes
      || (task.target.pageCount !== null && document.pdf.pageCount !== task.target.pageCount)) fail('SOURCE_UNAVAILABLE');
    const chunks = await buildRemoteVectorChunks(document); await check();
    const elements = chunks.length * config.dimensions;
    if (elements > 2000000 || Buffer.byteLength(JSON.stringify(chunks)) + elements * 24 + 16384 > 16 * 1024 * 1024) fail('REMOTE_TASK_ARTIFACT_LIMIT');
    const chunksDigest = sha(JSON.stringify(chunks)); let entry = await checkpoint.read();
    if (entry.artifact) return Buffer.from(entry.artifact.base64, 'base64');
    let progress = entry.vectorProgress;
    if (progress && (progress.sourceDigest !== parsed.digest || progress.chunkerDigest !== REMOTE_VECTOR_CHUNKER.digest
      || progress.chunksDigest !== chunksDigest || progress.dimension !== config.dimensions || progress.vectors.length > chunks.length)) fail('PROFILE_CHANGED');
    if (progress?.pendingStart !== null && progress?.pendingStart !== undefined) fail('EXTERNAL_OUTCOME_UNKNOWN');
    progress ||= { sourceDigest: parsed.digest, chunkerDigest: REMOTE_VECTOR_CHUNKER.digest, chunksDigest,
      dimension: config.dimensions, vectors: [], pendingStart: null, pendingCount: null };
    while (progress.vectors.length < chunks.length) {
      await check(); const start = progress.vectors.length; const count = Math.min(batchSize, chunks.length - start);
      progress = { ...progress, pendingStart: start, pendingCount: count };
      entry = await checkpoint.write({ ...entry, stage: 'embedding_pending', vectorProgress: progress }); await check();
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean));
      let data;
      try {
        const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, input: chunks.slice(start, start + count).map((chunk) => chunk.text), dimensions: config.dimensions }) });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status >= 400 && response.status < 500) {
            progress = { ...progress, pendingStart: null, pendingCount: null };
            await checkpoint.write({ ...entry, stage: 'embedding_progress', vectorProgress: progress }); fail('EXECUTION_FAILED');
          }
          fail('EXTERNAL_OUTCOME_UNKNOWN');
        }
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response, 16 * 1024 * 1024, requestSignal)));
      } catch (error) { if (error.code === 'EXECUTION_FAILED') throw error; fail('EXTERNAL_OUTCOME_UNKNOWN'); }
      if (!Array.isArray(data?.data) || data.data.length !== count || (Object.hasOwn(data, 'model') && data.model !== config.model)) fail('EXTERNAL_OUTCOME_UNKNOWN');
      const vectors = Array(count); const seen = new Set();
      for (const item of data.data) {
        if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= count || seen.has(item.index)
          || !Array.isArray(item.embedding) || item.embedding.length !== config.dimensions
          || item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e6)) fail('EXTERNAL_OUTCOME_UNKNOWN');
        seen.add(item.index); vectors[item.index] = item.embedding;
      }
      // Save a received result before observing a late cancellation. A restart
      // can reuse these vectors; it must not replay an unresolved paid batch.
      progress = { ...progress, vectors: [...progress.vectors, ...vectors], pendingStart: null, pendingCount: null };
      try { entry = await checkpoint.write({ ...entry, stage: 'embedding_progress', vectorProgress: progress }); }
      catch { fail('EXTERNAL_OUTCOME_UNKNOWN'); }
      await check();
    }
    const indexed = chunks.map((chunk, index) => ({ ...chunk, vector: progress.vectors[index] }));
    const artifact = { format: 'paperquay-vector-index', version: 1, paperId: document.paperId, attachmentVersionId: document.attachmentVersionId,
      pdf: document.pdf, parseDigest: parsed.digest, model: config.model, chunker: REMOTE_VECTOR_CHUNKER, dimension: config.dimensions,
      chunkCount: indexed.length, contentHash: sha(JSON.stringify(indexed)), chunks: indexed };
    const verified = await core().decodeRemoteIndexArtifact(new Uint8Array(Buffer.from(JSON.stringify(artifact)))); await check();
    const bytes = Buffer.from(verified.bytes); const { vectorProgress: _drop, ...withoutProgress } = entry;
    await checkpoint.write({ ...withoutProgress, stage: 'artifact_ready', artifact: journalArtifact(bytes) }); return bytes;
  } };
}
module.exports = { createRemoteVectorAdapter, buildRemoteVectorChunks, REMOTE_VECTOR_CHUNKER, REMOTE_VECTOR_CHUNKER_CONFIG: CHUNKER_CONFIG };
