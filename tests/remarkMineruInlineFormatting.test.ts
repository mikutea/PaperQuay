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
  remarkMineruInlineFormatting,
} from '../src/features/blocks/remarkMineruInlineFormatting.ts';

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

test('unrecognized HTML, malformed tags, and code stay literal', () => {
  const html = render('A<img src="x" onerror="alert(1)"> B<sup>open `x<sub>2</sub>`');

  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;sup&gt;open/);
  assert.match(html, /<code>x&lt;sub&gt;2&lt;\/sub&gt;<\/code>/);
});
