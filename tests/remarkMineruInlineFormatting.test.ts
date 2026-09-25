import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import {
  normalizeMineruReaderMarkdown,
  plainMineruInlineCaption,
  renderMineruInlineCaption,
  remarkMineruInlineFormatting,
} from '../src/features/blocks/remarkMineruInlineFormatting.ts';

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath, remarkMineruInlineFormatting],
    rehypePlugins: [[rehypeKatex, { strict: 'ignore', throwOnError: false }]],
  }, normalizeMineruReaderMarkdown(markdown)));
}

test('structured reading formats paired MinerU superscripts and subscripts', () => {
  const html = render('H<sub>2</sub>O and x<sup>2</sup>');
  assert.match(html, /H<sub>2<\/sub>O/);
  assert.match(html, /x<sup>2<\/sup>/);
  assert.match(render('H<sub >2</sub>O'), /H<sub>2<\/sub>O/);
});

test('nested pairs and Markdown emphasis retain their visible content', () => {
  const html = render('x<sup>*2*<sub>n</sub></sup>');
  assert.match(html, /x<sup><em>2<\/em><sub>n<\/sub><\/sup>/);
});

test('headings and GFM table cells use the same paired-tag display rule', () => {
  assert.match(render('# H<sub>2</sub>O'), /<h1>H<sub>2<\/sub>O<\/h1>/);
  assert.match(render('| value |\n| --- |\n| x<sup>2</sup> |'), /<td>x<sup>2<\/sup><\/td>/);
});

test('unpaired or unrelated raw HTML remains escaped text', () => {
  const html = render('H<sub>2 and <script>alert(1)</script>');
  assert.match(html, /&lt;sub&gt;/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('code samples remain literal and existing formula rendering remains active', () => {
  const html = render('`H<sub>2</sub>O` and \\(x_i\\)');
  assert.match(html, /<code>H&lt;sub&gt;2&lt;\/sub&gt;O<\/code>/);
  assert.match(html, /katex/);
  const mixed = render('H<sub>2</sub>O and \\(x_i\\)');
  assert.match(mixed, /H<sub>2<\/sub>O/);
  assert.match(mixed, /katex/);
});

test('figure and table captions format only paired scripts', () => {
  const text = 'Fig. H<sub>2</sub>O and x<sup>2</sup> <img src=x>';
  const html = renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption(text)));
  assert.match(html, /H<sub>2<\/sub>O/);
  assert.match(html, /x<sup>2<\/sup>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.equal(plainMineruInlineCaption(text), 'Fig. H2O and x2 <img src=x>');
  assert.match(renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption('H<sub >2</sub>O'))), /H<sub>2<\/sub>O/);
});

test('oversized captions stay literal rather than invoking an unbounded parser', () => {
  const text = 'a'.repeat(16_385) + '<sub>2</sub>';
  assert.deepEqual(renderMineruInlineCaption(text), [text]);
});
