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
  assert.equal(normalizeMarkdownMath('P(A | B) = P(C | D)'), '$P(A | B) = P(C | D)$');
});

test('explicit math in a table remains protected', () => {
  const source = '| Label | Formula |\n| --- | --- |\n| Value | $P(A \\mid B)$ |';
  assert.match(render(source), /<td><span class="katex">/);
  assert.doesNotMatch(render(source), /katex-error/);
  const withHtml = '| Label | Formula |\n| --- | --- |\n| Value | $x$ <br> |';
  assert.match(normalizeMarkdownMath(withHtml), /\| Value \| \$x\$ <br> \|/);
});

test('escaped vertical bars inside a table cell are not delimiters', () => {
  const source = '| Label | Formula | Note |\n| --- | --- | --- |\n| Value | x | P(A \\| B)_i |';
  assert.match(normalizeMarkdownMath(source), /\| \$P\(A \\?\| B\)_i\$ \|/);
});

test('a block starter with pipes ends the preceding GFM table', () => {
  for (const block of [
    '# P(A | B) = P(C | D)',
    '> P(A | B) = P(C | D)',
    '- P(A | B) = P(C | D)',
    '1. P(A | B) = P(C | D)',
  ]) {
    const source = `A | B\n--- | ---\nx | y\n${block}`;
    const normalized = normalizeMarkdownMath(source);
    assert.doesNotMatch(normalized, /\$B\)|C\$/);
    assert.match(render(source), /<table>/);
    assert.match(render(source), /<ms>|<mrow>|<mi>/);
  }
});

test('a block starter with pipes cannot become a GFM table header', () => {
  for (const header of [
    '# Label | Note',
    '> Label | Note',
    '- Label | Note',
    '1. Label | Note',
  ]) {
    const source = `${header}\n--- | ---\nP(A | B) = P(C | D)`;
    assert.match(normalizeMarkdownMath(source), /\$P\(A \| B\) = P\(C \| D\)\$/);
    assert.doesNotMatch(render(source), /<table>/);
  }
});

test('indented code is not a GFM table delimiter', () => {
  const source = 'Label | Note\n    --- | ---\nP(A | B) = P(C | D)';
  assert.match(normalizeMarkdownMath(source), /\$P\(A \| B\) = P\(C \| D\)\$/);
  assert.doesNotMatch(render(source), /<table>/);
});

test('HTML block headings are not GFM table headers', () => {
  for (const tag of ['h1', 'ul', 'form', 'figure']) {
    const source = `<${tag}>Label | Formula</${tag}>\n--- | ---\nP(A | B) = P(C | D)`;
    assert.match(normalizeMarkdownMath(source), /\$P\(A \| B\) = P\(C \| D\)\$/);
    assert.doesNotMatch(render(source), /<table>/);
  }
});

test('single-column GFM table keeps the structural outer pipes outside math', () => {
  const source = '| Formula |\n| --- |\n| T_i |';
  const normalized = normalizeMarkdownMath(source);
  assert.match(normalized, /\| \$T_i\$ \|/);
  assert.match(render(source), /<td><span class="katex">/);
});

test('nested GFM tables keep formulas within their own cells', () => {
  for (const source of [
    '> Label | Formula | Note\n> --- | --- | ---\n> Value | T_i | text',
    '- Label | Formula | Note\n  --- | --- | ---\n  Value | T_i | text',
  ]) {
    assert.match(normalizeMarkdownMath(source), /\| \$T_i\$ \|/);
    assert.match(render(source), /<td><span class="katex">/);
  }
});

test('nested table headers retain list and quote container markers', () => {
  for (const source of [
    '1. T_i | Note\n   --- | ---\n   Value | text',
    '- T_i | Note\n  --- | ---\n  Value | text',
    '> T_i | Note\n> --- | ---\n> Value | text',
  ]) {
    const normalized = normalizeMarkdownMath(source);
    assert.match(normalized, /(?:1\. |- |> )\$T_i\$ \| Note/);
    assert.match(render(source), /<th><span class="katex">/);
  }
});
