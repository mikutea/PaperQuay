import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeMarkdownMath } from '../src/utils/markdown.ts';
import { parseMineruMarkdownPages } from '../src/services/mineru.ts';

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

test('crossed script tags stay literal rather than partially formatting', () => {
  const html = render('<sup>a<sub>b</sup>c</sub>');
  assert.doesNotMatch(html, /<sup>|<sub>/);
  assert.match(html, /&lt;sup&gt;a&lt;sub&gt;b&lt;\/sup&gt;c&lt;\/sub&gt;/);
  const caption = renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption('<sup>a<sub>b</sup>c</sub>')));
  assert.match(caption, /&lt;sup&gt;a&lt;sub&gt;b&lt;\/sup&gt;c&lt;\/sub&gt;/);
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

test('existing MinerU formula wrappers keep subscript conversion', () => {
  assert.match(normalizeMineruReaderMarkdown('<span class="math">x<sub>i</sub></span>'), /\$x_\{i\}\$/);
  assert.match(normalizeMineruReaderMarkdown('<div class="formula">x<sub>i</sub></div>'), /\$\$[\s\S]*x_\{i\}[\s\S]*\$\$/);
  assert.match(normalizeMineruReaderMarkdown(`${'a'.repeat(16_385)} <span class="math">x<sub>i</sub></span>`), /\$x_\{i\}\$/);
  const adjacent = 'before<div class="formula">x<sub>i</sub></div>after';
  assert.equal(normalizeMineruReaderMarkdown(adjacent), normalizeMarkdownMath(adjacent));
});

test('formula-image fallback keeps the existing tagged alt text', () => {
  const source = '![H<sub>2</sub>O](images/formula.png)';
  assert.equal(normalizeMineruReaderMarkdown(source), normalizeMarkdownMath(source));
  assert.match(normalizeMineruReaderMarkdown(source), /H<sub>2<\/sub>O/);
});

test('implicit math before tagged prose still normalizes', () => {
  assert.match(normalizeMineruReaderMarkdown('x_i H<sub>2</sub>O'), /^\$x_i\$ H<sub>2<\/sub>O$/);
});

test('full.md fallback script tags display as math subscripts without changing cached text', () => {
  const direct = { type: 'root', children: [{ type: 'inlineMath', value: 'H<sub>2</sub>O' }] };
  remarkMineruInlineFormatting()(direct);
  assert.equal(direct.children[0].value, 'H_{2}O');
  const pages = parseMineruMarkdownPages('H<sub>2</sub>O');
  const markdown = pages[0]?.[0]?.content?.markdown;
  assert.equal(markdown, '$H<sub>2</sub>O$');
  const html = render(markdown);
  assert.match(html, /<msub>/);
});

test('an unmatched outer script leaves nested pairs literal', () => {
  const html = render('<sup>a<sub>b</sub>');
  assert.doesNotMatch(html, /<sup>|<sub>/);
  assert.match(html, /&lt;sup&gt;a&lt;sub&gt;b&lt;\/sub&gt;/);
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

test('captions with many unmatched tags stay literal without repeated pairing scans', () => {
  const text = '<sup>'.repeat(256);
  assert.deepEqual(renderMineruInlineCaption(text), [text]);
});

test('a paragraph with many ordinary nodes still formats a paired script', () => {
  const html = render(`${'*a* '.repeat(129)}H<sub>2</sub>O`);
  assert.match(html, /H<sub>2<\/sub>O/);
});

test('exceeding the script-tag cap still normalizes unrelated math', () => {
  const html = render(`${'H<sub>2</sub>O '.repeat(129)}\\(x_i\\)`);
  assert.match(html, /katex/);
  const lines = `${'H<sub>2</sub>O\n'.repeat(129)}\\(x_i\\)`;
  const lineHtml = render(lines);
  assert.doesNotMatch(lineHtml, /\$H&lt;sub&gt;2&lt;\/sub&gt;O\$/);
  assert.match(lineHtml, /katex/);
  const manyTags = `${'<sup>'.repeat(10_000)} \\(x_i\\)`;
  assert.equal(normalizeMineruReaderMarkdown(manyTags), manyTags);
});

test('many unmatched tags across paragraphs do not repeatedly scan siblings', () => {
  let reads = 0;
  const rawTag = () => ({
    type: 'html',
    get value() { reads += 1; return '<sup>'; },
  });
  const root = {
    type: 'root',
    children: Array.from({ length: 32 }, () => ({
      type: 'paragraph',
      children: Array.from({ length: 64 }, rawTag),
    })),
  };
  remarkMineruInlineFormatting()(root);
  assert.ok(reads < 8_192, 'unmatched tags should be inspected only a bounded number of times');
  assert.equal(root.children[0].children[0].value, '<sup>');
});

test('long formula-like prose before a script tag remains bounded', () => {
  const source = `${'x='.repeat(8_000)}H<sub>2</sub>O`;
  const started = performance.now();
  assert.equal(normalizeMineruReaderMarkdown(source), source);
  assert.ok(performance.now() - started < 2_000, 'the next scan must advance past the script tag');
  const repeated = `${'x='.repeat(30)}H<sub>2</sub>O`.repeat(120);
  assert.equal(normalizeMineruReaderMarkdown(repeated), repeated);
});
