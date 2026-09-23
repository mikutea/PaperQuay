import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import {
  normalizeMineruReaderMarkdown,
  renderMineruInlineCaption,
  remarkMineruInlineFormatting,
} from '../src/features/blocks/remarkMineruInlineFormatting.ts';
import {
  buildRenderableBlocks,
  flattenMineruPages,
  parseMineruMarkdownPages,
} from '../src/services/mineru.ts';
import { normalizeMarkdownMath } from '../src/utils/markdown.ts';

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath, remarkMineruInlineFormatting],
        rehypePlugins: [[rehypeKatex, { strict: 'ignore', throwOnError: false }]],
      },
      normalizeMineruReaderMarkdown(markdown),
    ),
  );
}

test('MinerU superscript and subscript render as formatting without changing text', () => {
  const html = render('x<sup>2</sup> and H<sub>2</sub>O and RNetLo<sub>g</sub>o');

  assert.match(html, /x<sup>2<\/sup>/);
  assert.match(html, /H<sub>2<\/sub>O/);
  assert.match(html, /RNetLo<sub>g<\/sub>o/);
  assert.doesNotMatch(html, /&lt;\/?(?:sup|sub)&gt;/);
  assert.doesNotMatch(html, /\$/);
});

test('nested inline formatting and Markdown content are preserved', () => {
  const html = render('x<sup>**n**<sub>i</sub></sup>');

  assert.match(html, /x<sup><strong>n<\/strong><sub>i<\/sub><\/sup>/);
});

test('formula HTML keeps its existing LaTeX conversion', () => {
  const html = render('<span class="math">x<sup>2</sup></span>');

  assert.doesNotMatch(html, /&lt;sup|<sup>/);
  assert.match(html, /katex/);
});

test('fragmented LaTeX inside formula HTML is repaired before formula conversion', () => {
  const source = '<span class="math">x \\ in I</span>';

  assert.equal(normalizeMineruReaderMarkdown(source), normalizeMarkdownMath(source));
  assert.equal(normalizeMineruReaderMarkdown(source), '$x \\in I$');
});

test('Markdown fallback blocks recover tags wrapped in spurious math fences', () => {
  const pages = parseMineruMarkdownPages('H<sub>2</sub>O');
  const content = pages[0]?.[0]?.content as { markdown?: string } | undefined;
  const fallbackMarkdown = content?.markdown ?? '';
  const readerMarkdown = buildRenderableBlocks(flattenMineruPages(pages))[0]?.markdown ?? '';

  assert.equal(fallbackMarkdown, '$H<sub>2</sub>O$');
  assert.match(render(readerMarkdown), /H<sub>2<\/sub>O/);
});

test('literal private-use characters are never consumed as internal markers', () => {
  const markerLikeText = '\uE2000\uE201';

  assert.match(render(`A${markerLikeText} B`), new RegExp(markerLikeText));
  assert.match(render(`A${markerLikeText} B<sup>2</sup>`), new RegExp(markerLikeText));
  assert.match(render(`A${markerLikeText} B<sup>2</sup>`), /B<sup>2<\/sup>/);
});

test('caption text uses the same safe inline formatting pipeline', () => {
  const html = renderToStaticMarkup(
    createElement('span', null, ...renderMineruInlineCaption('Levels of CO<sub>2</sub>')),
  );

  assert.match(html, /CO<sub>2<\/sub>/);
});

test('caption links, images, and other HTML remain inert literal text', () => {
  const source = '![caption](https://example.invalid/pixel) <a href="https://example.invalid">link</a> <sup>1</sup>';
  const html = renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption(source)));

  assert.match(html, /!\[caption\]\(https:\/\/example\.invalid\/pixel\)/);
  assert.match(html, /&lt;a href=/);
  assert.match(html, /<sup>1<\/sup>/);
  assert.doesNotMatch(html, /<img\b|<a\b/);
});

test('fallback repair does not change inline or fenced code examples', () => {
  const inline = '`$H<sub>2</sub>O$`';
  const fenced = '```text\n$H<sub>2</sub>O$\n```';

  assert.equal(normalizeMineruReaderMarkdown(inline), inline);
  assert.equal(normalizeMineruReaderMarkdown(fenced), fenced);
});

test('unrecognized HTML, malformed tags, and code stay literal', () => {
  const html = render('A<img src="x" onerror="alert(1)"> B<sup>open `x<sub>2</sub>`');

  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;sup&gt;open/);
  assert.match(html, /<code>x&lt;sub&gt;2&lt;\/sub&gt;<\/code>/);
});
