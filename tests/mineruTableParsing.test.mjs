import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('MinerU reuses each table candidate parse across renderable and translation fields', async () => {
  const proxyId = '\0test:mineru-table-parse-count';
  const server = await createServer({
    configFile: false, logLevel: 'silent',
    ssr: { noExternal: ['parse5'] },
    server: { middlewareMode: true }, appType: 'custom',
    plugins: [{
      name: 'count-mineru-table-parses',
      enforce: 'pre',
      resolveId(id, importer) {
        return id === 'parse5' && importer?.replaceAll('\\', '/').endsWith('/src/services/mineru.ts')
          ? proxyId : undefined;
      },
      load(id) {
        if (id !== proxyId) return;
        return `
          import { parseFragment as parse } from 'parse5';
          const counts = new Map();
          export function parseFragment(input, ...args) {
            counts.set(input, (counts.get(input) || 0) + 1);
            return parse(input, ...args);
          }
          export function takeCounts() {
            const result = Object.fromEntries(counts);
            counts.clear();
            return result;
          }
        `;
      },
    }],
  });
  try {
    const mineru = await server.ssrLoadModule('/src/services/mineru.ts');
    const { takeCounts } = await server.ssrLoadModule(proxyId);
    const html = '<table><caption>Table 1</caption><tr><td>Score</td><td>42</td></tr></table>';
    const empty = '<table><caption>Empty shell</caption></table>';
    const [block] = mineru.flattenMineruPages(mineru.parseMineruPages([{
      type: 'table', html: empty, table_body: html,
      table_caption: 'Table 1', text: 'Separate OCR', table_footnote: 'Source',
    }]));
    takeCounts();
    const original = JSON.stringify(block);
    const [renderable] = mineru.buildRenderableBlocks([block]);
    assert.equal(renderable.tableHtml, html);
    assert.equal(renderable.plainText, 'Table 1 Score 42 Separate OCR Source');
    assert.equal(renderable.tableOcrMarkdown, 'Separate OCR');
    assert.equal(renderable.tableFootnoteText, 'Source');
    assert.equal(JSON.stringify(block), original);
    assert.deepEqual(takeCounts(), { [empty]: 1, [html]: 1 });
    for (const extract of [
      mineru.extractTextFromMineruBlock, mineru.extractCaptionFromMineruBlock,
      mineru.extractTranslatableMarkdownFromMineruBlock,
    ]) {
      extract(block);
      assert.deepEqual(takeCounts(), { [empty]: 1, [html]: 1 });
    }
    // No persistent cache: subsequent calls must see edits to the input.
    block.content.table_body = '<table><tr><td>Updated</td></tr></table>';
    assert.match(mineru.buildRenderableBlocks([block])[0].plainText, /Updated/);
    assert.deepEqual(takeCounts(), { [empty]: 1, [block.content.table_body]: 1 });
    block.content.html = block.content.table_body;
    mineru.buildRenderableBlocks([block]);
    assert.deepEqual(takeCounts(), { [block.content.table_body]: 1 });
    mineru.buildRenderableBlocks([block, block]);
    assert.deepEqual(takeCounts(), { [block.content.table_body]: 2 });
  } finally {
    await server.close();
  }
});
