import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeMarkdownMath } from '../src/utils/markdown.ts';

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [[rehypeKatex, { strict: 'ignore', throwOnError: false }]],
  }, normalizeMarkdownMath(markdown)));
}

test('bare formulas in adjacent GFM table cells stay in their own cells', () => {
  const source = '| Label | Formula | Note |\n| --- | --- | --- |\n| Value | T_i | τ pre-scheduling |';
  const html = render(source);
  assert.match(html, /<td>Value<\/td><td><span class="katex">/);
  assert.match(html, /<msub>/);
  assert.match(html, /<td>τ pre-scheduling<\/td>/);
  assert.doesNotMatch(html, /<td>[^<]*\$/);
  const withoutOuterPipes = render('Label | Formula | Note\n--- | --- | ---\nValue | T_i | τ pre-scheduling');
  assert.match(withoutOuterPipes, /<td>Value<\/td><td><span class="katex">/);
});

test('math vertical bars in ordinary prose are not treated as table delimiters', () => {
  assert.equal(normalizeMarkdownMath('A = |x| < 1'), '$A = |x| < 1$');
  assert.equal(normalizeMarkdownMath('P(A | B) is conditional'), 'P(A | B) is conditional');
});

test('explicit math in a table remains protected', () => {
  const source = '| Label | Formula |\n| --- | --- |\n| Value | $P(A \\mid B)$ |';
  assert.match(render(source), /<td><span class="katex">/);
  assert.doesNotMatch(render(source), /katex-error/);
});
