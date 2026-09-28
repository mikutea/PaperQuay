import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('MinerU RAG signature follows extracted visual text when full Markdown is unchanged', async () => {
  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true },
    appType: 'custom',
  });

  try {
    const { prepareReaderRagDocument } = await server.ssrLoadModule('/src/features/reader/readerRag.ts');
    const input = {
      item: { source: 'native-library', itemKey: 'paper-1' },
      settings: { ragSourceMode: 'mineru-markdown' },
      mineruDocumentText: '# Unchanged full.md',
      pdfDocumentText: '',
    };
    const table = (footnote) => ({
      type: 'table', blockId: 'page-1-block-1', pageIndex: 0, blockIndex: 0,
      content: { table_footnote: footnote, html: '<table><tr><td>Score</td></tr></table>' },
    });
    const before = prepareReaderRagDocument({ ...input, mineruBlocks: [table('Source A')] });
    const after = prepareReaderRagDocument({ ...input, mineruBlocks: [table('Source B')] });

    assert.equal(before.sources[0].chunks.length, after.sources[0].chunks.length);
    assert.notEqual(before.sources[0].sourceSignature, after.sources[0].sourceSignature);
  } finally {
    await server.close();
  }
});
