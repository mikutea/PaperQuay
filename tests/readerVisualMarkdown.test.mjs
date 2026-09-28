import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { parseFragment } from 'parse5';

test('Reader preserves inline image alt text without creating fetching image elements', async () => {
  const server = await createServer({
    configFile: false, logLevel: 'silent', plugins: [react()],
    server: { middlewareMode: true }, appType: 'custom',
  });
  try {
    const { BlockItem } = await server.ssrLoadModule('/src/features/blocks/blockViewerContent.tsx');
    const { parseMineruMarkdownPages, parseMineruPages, flattenMineruPages, buildRenderableBlocks } =
      await server.ssrLoadModule('/src/services/mineru.ts');
    for (const { source, pages } of [
      ...[
        '# Heading ![Trend](chart.png)',
        '# Heading ![Trend](https://example.com/chart.png)',
        '# ![<script>Trend</script>](https://example.com/chart.png)',
      ].map((source) => ({ source, pages: parseMineruMarkdownPages(source) })),
      {
        source: 'structured list with inline image',
        pages: parseMineruPages([{ type: 'list', content: { markdown: '- ![Trend](chart.png)' } }]),
      },
    ]) {
      const [renderable] = buildRenderableBlocks(flattenMineruPages(pages));
      assert.notEqual(renderable.block.type, 'image');
      for (const mode of ['original', 'translated', 'bilingual']) {
        const html = renderToStaticMarkup(createElement(BlockItem, {
          renderable, active: false, hovered: false, flashing: false, scale: 1,
          showBlockMeta: false, compactMode: false,
          translatedText: renderable.markdown, translationDisplayMode: mode,
          onClick() {}, registerRef() {},
        }));
        const nodes = [...parseFragment(html).childNodes];
        const text = [];
        while (nodes.length) {
          const node = nodes.shift();
          assert.notEqual(node.tagName, 'img', source);
          assert.notEqual(node.tagName, 'script', source);
          if (node.nodeName === '#text') text.push(node.value);
          if (node.childNodes) nodes.unshift(...node.childNodes);
        }
        // The existing Reader shows one heading even in bilingual mode.
        const copies = mode === 'bilingual' && renderable.block.type !== 'title' ? 2 : 1;
        assert.equal(text.join(' ').split('Trend').length - 1, copies, `${source}: ${mode}`);
        assert.doesNotMatch(html, /src=|chart\.png/);
      }
    }
  } finally {
    await server.close();
  }
});
