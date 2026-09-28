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

test('Reader standalone visual notes match source order in original translated and bilingual modes', async () => {
  const server = await createServer({
    configFile: false, logLevel: 'silent', plugins: [react()],
    server: { middlewareMode: true }, appType: 'custom',
  });
  try {
    const { BlockItem } = await server.ssrLoadModule('/src/features/blocks/blockViewerContent.tsx');
    const { parseMineruPages, flattenMineruPages, buildRenderableBlocks } =
      await server.ssrLoadModule('/src/services/mineru.ts');
    for (const role of ['table', 'image', 'chart', 'figure']) {
      for (const kind of ['caption', 'footnote']) {
        const [renderable] = buildRenderableBlocks(flattenMineruPages(parseMineruPages([{
          type: `${role}_${kind}`, text: 'OCR label', [`${role}_footnote`]: 'Source A',
          [`${role}_caption`]: [
            { type: 'text', content: 'Figure *1* ' },
            { type: 'equation_inline', content: 'x_i' },
          ],
        }])));
        assert.equal(renderable.plainText, 'Figure *1* $x_i$ OCR label Source A');
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
            if (node.nodeName === '#text') text.push(node.value);
            if (node.childNodes) nodes.unshift(...node.childNodes);
          }
          const visible = text.join(' ');
          const copies = mode === 'bilingual' ? 2 : 1;
          assert.equal(visible.split('Figure *1*').length - 1, copies);
          assert.equal(visible.split('OCR label Source A').length - 1, copies);
          assert.ok(visible.indexOf('Figure *1*') < visible.indexOf('OCR label Source A'));
          assert.match(html, /class="katex"/);
          assert.doesNotMatch(html, /<em>|<img|src=/);
        }
      }
    }
  } finally {
    await server.close();
  }
});
