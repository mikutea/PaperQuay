import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { parseFragment } from 'parse5';

test('cached Reader Markdown never creates fetching images and preserves text, math and caller links', async () => {
  const server = await createServer({
    configFile: false, logLevel: 'silent', plugins: [react()],
    server: { middlewareMode: true }, appType: 'custom',
  });
  try {
    const { MarkdownPreview } = await server.ssrLoadModule('/src/features/reader/assistantSidebarPrimitives.tsx');
    for (const content of [
      'Translation ![image label](https://fixture.invalid/pixel)',
      'Translation ![image label](//fixture.invalid/pixel)',
      'Translation ![image label][tracking]\n\n[tracking]: https://fixture.invalid/pixel',
      'Translation <img src="https://fixture.invalid/pixel">',
    ]) {
      const html = renderToStaticMarkup(createElement(MarkdownPreview, {
        content,
        components: { img: () => createElement('img', { src: 'https://fixture.invalid/override' }) },
      }));
      assert.doesNotMatch(html, /<img[\s>]|<source[\s>]/i);
      assert.match(html, /Translation/);
      if (content.includes('image label')) assert.match(html, /image label/);
    }
    const ordinary = renderToStaticMarkup(createElement(MarkdownPreview, {
      content: '**Ordinary translation** $x^2$ [citation](https://fixture.invalid/paper)',
      components: { a: ({ children }) => createElement('button', { type: 'button' }, children) },
    }));
    assert.match(ordinary, /<strong>Ordinary translation<\/strong>/);
    assert.match(ordinary, /class="katex"/);
    assert.match(ordinary, /<button type="button">citation<\/button>/);
    for (const href of ['//host/share/payload.html', '/C:/supplier.html', '../supplier.html', 'file:///C:/supplier.html', 'javascript:alert(1)']) {
      const html = renderToStaticMarkup(createElement(MarkdownPreview, { content: `[untrusted label](${href})` }));
      assert.doesNotMatch(html, /<a[\s>]/i, href);
      assert.match(html, /untrusted label/);
    }
    const external = renderToStaticMarkup(createElement(MarkdownPreview, { content: '[paper](https://example.com/paper)' }));
    assert.match(external, /href="https:\/\/example.com\/paper"/);
    assert.match(external, /target="_blank"/);
  } finally { await server.close(); }
});

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

test('Reader and review figure metadata retain caption labels without duplicated table headings', async () => {
  const fixtureTable = '<table><caption>Table 1</caption><tbody><tr><td>42</td></tr></tbody></table>';
  const fixtureImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const server = await createServer({
    configFile: false, logLevel: 'silent', plugins: [
      react(),
      {
        name: 'reader-caption-fixtures', enforce: 'pre',
        transform(code, id) {
          const path = id.replaceAll('\\', '/');
          if (path.endsWith('/src/features/blocks/blockViewerContent.tsx')) {
            // Supply an already loaded image; do not exercise native asset I/O in SSR.
            return code.replace("const [dataUrl, setDataUrl] = useState('');",
              `const [dataUrl, setDataUrl] = useState(${JSON.stringify(fixtureImage)});`);
          }
          if (path.endsWith('/src/services/libraryAgent.ts')) {
            return `${code}\nexport { collectMineruReviewFigures };`;
          }
        },
      },
    ],
    server: { middlewareMode: true }, appType: 'custom',
  });
  try {
    const { BlockItem } = await server.ssrLoadModule('/src/features/blocks/blockViewerContent.tsx');
    const { parseMineruPages, flattenMineruPages, buildRenderableBlocks } =
      await server.ssrLoadModule('/src/services/mineru.ts');
    const { collectMineruReviewFigures } = await server.ssrLoadModule('/src/services/libraryAgent.ts');
    const blocks = flattenMineruPages(parseMineruPages([
      {
        type: 'image', img_path: 'images/growth.png', image_caption: [
          { type: 'text', content: 'Growth (' },
          { type: 'equation_inline', content: 'x' },
          { type: 'text', content: ').' },
        ],
      },
      { type: 'table', img_path: 'images/table.png', table_caption: 'Table 1', html: fixtureTable },
    ]));
    blocks.push(...flattenMineruPages(parseMineruPages({ pdf_info: [{ para_blocks: [
      { type: 'image', blocks: [
        { type: 'image_body', lines: [{ spans: [{ img_path: 'images/nested-growth.png' }] }] },
        { type: 'image_caption', lines: [{ spans: [
          { type: 'text', content: 'Growth (' }, { type: 'inline_equation', content: 'x' },
          { type: 'text', content: ').' },
        ] }] },
      ] },
      { type: 'table', blocks: [
        { type: 'table_body', lines: [{ spans: [{ img_path: 'images/nested-table.png', html: fixtureTable }] }] },
        { type: 'table_caption', lines: [{ spans: [{ type: 'text', content: 'Table 1' }] }] },
      ] },
    ] }] })));
    const figures = collectMineruReviewFigures(blocks, 'C:/cache/middle.json');
    assert.deepEqual(figures.map((figure) => figure.caption), ['Growth (x).', 'Table 1', 'Growth (x).', 'Table 1']);
    // Fixed, known-safe markup only. This stub does not validate the browser sanitizer.
    globalThis.window = {};
    globalThis.DOMParser = class {
      parseFromString(html) {
        assert.equal(html, fixtureTable);
        return { querySelectorAll: () => [], body: { children: [], innerHTML: html } };
      }
    };
    for (const renderable of buildRenderableBlocks(blocks, 'C:/cache/middle.json')) {
      for (const mode of ['original', 'translated', 'bilingual']) {
        const html = renderToStaticMarkup(createElement(BlockItem, {
          renderable, active: false, hovered: false, flashing: false, scale: 1,
          showBlockMeta: false, compactMode: false,
          translatedText: renderable.markdown, translationDisplayMode: mode,
          onClick() {}, registerRef() {},
        }));
        const nodes = [...parseFragment(html).childNodes];
        const text = [];
        const labels = [];
        while (nodes.length) {
          const node = nodes.shift();
          if (node.nodeName === '#text') text.push(node.value);
          if (node.tagName === 'img') labels.push(node.attrs.find((attr) => attr.name === 'alt')?.value);
          if (node.childNodes) nodes.unshift(...node.childNodes);
        }
        assert.deepEqual(labels, [renderable.captionText]);
        if (renderable.block.type === 'table') {
          const copies = mode === 'bilingual' ? 2 : 1;
          assert.equal(text.join(' ').split('Table 1').length - 1, copies);
        }
      }
    }
  } finally {
    delete globalThis.window;
    delete globalThis.DOMParser;
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
