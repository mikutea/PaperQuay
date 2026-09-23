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
  plainMineruInlineCaption,
  renderMineruInlineCaption,
  remarkMineruInlineFormatting,
} from '../src/features/blocks/remarkMineruInlineFormatting.ts';
import {
  buildRenderableBlocks,
  displayMarkdownFallback,
  flattenMineruPages,
  parseMineruMarkdownPages,
} from '../src/services/mineru.ts';
import { buildReaderTranslationBlockInputs } from '../src/features/reader/readerTranslationSource.ts';
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

test('formula HTML preserves supported tag whitespace as LaTeX scripts', () => {
  const source = '<span class="math">H<sub >2</sub >O</span>';

  assert.equal(normalizeMineruReaderMarkdown(source), '$H_{2}O$');
  assert.doesNotMatch(render(source), /katex-error/);
});

test('Markdown fallback display removes a synthetic tag fence without changing translation source', () => {
  const pages = parseMineruMarkdownPages('H<sub>2</sub>O');
  const content = pages[0]?.[0]?.content as { markdown?: string } | undefined;
  const fallbackMarkdown = content?.markdown ?? '';
  const blocks = flattenMineruPages(pages);
  const readerMarkdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(fallbackMarkdown, '$H<sub>2</sub>O$');
  assert.equal(buildReaderTranslationBlockInputs(blocks)[0]?.text, '$H<sub>2</sub>O$');
  assert.equal(readerMarkdown, 'H<sub>2</sub>O');
  assert.match(render(readerMarkdown), /H<sub>2<\/sub>O/);
});

test('ordinary currency signs around tagged text are preserved', () => {
  const source = 'It costs $5 and H<sub>2</sub>O costs $10.';
  const fallback = parseMineruMarkdownPages(source);
  const content = fallback[0]?.[0]?.content as { markdown?: string } | undefined;

  assert.equal(normalizeMineruReaderMarkdown(source), normalizeMarkdownMath(source));
  assert.match(normalizeMineruReaderMarkdown(source), /\$5 and H<sub>2<\/sub>O costs \$10/);
  assert.match(content?.markdown ?? '', /\$5 and H<sub>2<\/sub>O costs \$10/);
  assert.match(buildRenderableBlocks(flattenMineruPages(fallback))[0]?.markdown ?? '', /\$5 and H<sub>2<\/sub>O costs \$10/);
});

test('Markdown fallback preserves a dollar fence already present in source', () => {
  const source = '$x<sup>2</sup>$';
  const pages = parseMineruMarkdownPages(source);
  const content = pages[0]?.[0]?.content as { markdown?: string } | undefined;

  assert.equal(content?.markdown, source);
  assert.equal(buildRenderableBlocks(flattenMineruPages(pages))[0]?.markdown, '$x^{2}$');
});

test('Markdown fallback keeps real math adjacent to tagged prose', () => {
  const pages = parseMineruMarkdownPages('x_i H<sub>2</sub>O');
  const blocks = flattenMineruPages(pages);
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(buildReaderTranslationBlockInputs(blocks)[0]?.text, '$x_i H<sub>2</sub>O$');
  assert.equal(markdown, '$x_i H_{2}O$');
  assert.match(render(markdown), /katex/);
});

test('Markdown fallback avoids duplicate superscript math', () => {
  const blocks = flattenMineruPages(parseMineruMarkdownPages('x^i<sup>2</sup>'));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(markdown, '$x^i$<sup>2</sup>');
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('explicit spaced inline math converts its paired tag', () => {
  const blocks = flattenMineruPages(parseMineruMarkdownPages('$H <sub>2</sub>O$'));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(markdown, /H _\{2\}O/);
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('JSON-backed and translated tagged prose retains adjacent math', () => {
  const markdown = 'x_i H<sub>2</sub>O';

  assert.equal(normalizeMineruReaderMarkdown(markdown), '$x_i H_{2}O$');
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('Markdown fallback formats tags outside an inline code span in the same block', () => {
  const source = 'H<sub>2</sub>O and `code`';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(markdown, source);
  assert.match(render(markdown), /H<sub>2<\/sub>O and <code>code<\/code>/);
});

test('Markdown fallback converts nested tags within a real formula', () => {
  const blocks = flattenMineruPages(parseMineruMarkdownPages('x_i<sub>n<sup>2</sup></sub>'));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(markdown, '$x_i$<sub>n<sup>2</sup></sub>');
  assert.match(render(markdown), /katex/);
  assert.doesNotMatch(render(markdown), /katex-error|&lt;sub/);
});

test('Markdown fallback recognizes supported tags with harmless whitespace', () => {
  const blocks = flattenMineruPages(parseMineruMarkdownPages('H<sup >2</sup >O'));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(markdown, 'H<sup >2</sup >O');
  assert.match(render(markdown), /H<sup>2<\/sup>O/);
});

test('long Markdown fallback blocks still show paired tags outside math', () => {
  const source = `${'word '.repeat(3_300)}H<sub>2</sub>O`;
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(markdown, /H<sub>2<\/sub>O/);
  assert.doesNotMatch(markdown, /\$H<sub>2<\/sub>O\$/);
});

test('oversized Markdown fallback uses its tagged display source without touching translation input', () => {
  const source = `${'word '.repeat(13_200)}H<sub>2</sub>O`;
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));

  assert.equal(buildRenderableBlocks(blocks)[0]?.markdown, source);
  assert.notEqual(buildReaderTranslationBlockInputs(blocks)[0]?.text, '');
});

test('escaped backticks do not hide paired tags from fallback display recovery', () => {
  const source = '\\` H<sub>2</sub>O \\`';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(markdown, /H<sub>2<\/sub>O/);
  assert.doesNotMatch(markdown, /\$[^$]*<sub>2<\/sub>[^$]*\$/);
});

test('display math in Markdown fallback converts paired tags to LaTeX', () => {
  const source = '\\sum_{i=1}^n x_i H<sub>2</sub>O';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(markdown, /H_\{2\}O/);
  assert.doesNotMatch(markdown, /<sub>/);
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('fragmented LaTeX repair does not leave tags inside fallback math', () => {
  const source = '\\ pmb{x} H<sup>2</sup>';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(markdown, /\\pmb\{x\}/);
  assert.match(markdown, /H\^\{2\}/);
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('literal private-use characters are never consumed as internal markers', () => {
  const markerLikeText = '\uE2000\uE201';

  assert.match(render(`A${markerLikeText} B`), new RegExp(markerLikeText));
  assert.match(render(`A${markerLikeText} B<sup>2</sup>`), new RegExp(markerLikeText));
  assert.match(render(`A${markerLikeText} B<sup>2</sup>`), /B<sup>2<\/sup>/);
});

test('long private-use runs do not grow marker expressions or alter source text', () => {
  const source = `${'\uE200'.repeat(40_000)} x<sup>2</sup>`;

  assert.equal(normalizeMineruReaderMarkdown(source), source);
});

test('excessively nested inline tags fall back to literal text without recursion failure', () => {
  const source = `${'<sup>'.repeat(8_000)}x${'</sup>'.repeat(8_000)}`;
  const html = render(source);
  const caption = renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption(source)));

  assert.match(html, /&lt;sup&gt;/);
  assert.match(caption, /&lt;sup&gt;/);
});

test('inline formatting enforces one work budget across paragraph siblings', () => {
  const tree = {
    type: 'root',
    children: Array.from({ length: 64 }, (_, index) => ({
      type: 'paragraph',
      children: index === 63
        ? [{ type: 'html', value: '<sup>' }, { type: 'text', value: '2' }, { type: 'html', value: '</sup>' }]
        : Array.from({ length: 256 }, () => ({ type: 'html', value: '<sup>' })),
    })),
  };

  remarkMineruInlineFormatting()(tree);

  assert.equal(tree.children.length, 64);
  assert.equal(tree.children[63].children[0]?.type, 'html');
});

test('caption text uses the same safe inline formatting pipeline', () => {
  const html = renderToStaticMarkup(
    createElement('span', null, ...renderMineruInlineCaption('Levels of CO<sub>2</sub>')),
  );

  assert.match(html, /CO<sub>2<\/sub>/);
  assert.equal(plainMineruInlineCaption('Levels of CO<sub>2</sub>'), 'Levels of CO2');
  assert.equal(plainMineruInlineCaption('value <sup>approx.'), 'value <sup>approx.');
});

test('caption links, images, and other HTML remain inert literal text', () => {
  const source = '![caption](https://example.invalid/pixel) <a href="https://example.invalid">link</a> <sup>1</sup>';
  const html = renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption(source)));

  assert.match(html, /!\[caption\]\(https:\/\/example\.invalid\/pixel\)/);
  assert.match(html, /&lt;a href=/);
  assert.match(html, /<sup>1<\/sup>/);
  assert.doesNotMatch(html, /<img\b|<a\b/);
});

test('caption matching has a work limit even at the accepted tag-count boundary', () => {
  const source = `${'<sup>'.repeat(510)}<sub>2</sub>`;
  const html = renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption(source)));

  assert.match(html, /&lt;sub&gt;2&lt;\/sub&gt;/);
  assert.doesNotMatch(html, /<sub>2<\/sub>/);
});

test('reader normalization does not change inline or fenced code examples', () => {
  const inline = '`$H<sub>2</sub>O$`';
  const fenced = '```text\n$H<sub>2</sub>O$\n```';

  assert.equal(normalizeMineruReaderMarkdown(inline), inline);
  assert.equal(normalizeMineruReaderMarkdown(fenced), fenced);
});

test('many paired backtick runs remain unchanged', () => {
  const source = '`x`'.repeat(40_000);

  assert.equal(normalizeMineruReaderMarkdown(source), source);
});

test('unrecognized HTML, malformed tags, and code stay literal', () => {
  const html = render('A<img src="x" onerror="alert(1)"> B<sup>open `x<sub>2</sub>`');

  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;sup&gt;open/);
  assert.match(html, /<code>x&lt;sub&gt;2&lt;\/sub&gt;<\/code>/);
});

test('adjacent math outside a formula wrapper still renders', () => {
  const markdown = '<span class="math">a</span> x_i H<sub>2</sub>O';

  assert.match(normalizeMineruReaderMarkdown(markdown), /\$a\$ \$x_i H_\{2\}O\$/);
  assert.doesNotMatch(render(markdown), /katex-error|&lt;sub/);
});

test('explicit math tags in JSON-backed text become LaTeX before remark-math', () => {
  const markdown = '$H<sub>2</sub>O$';

  assert.equal(normalizeMineruReaderMarkdown(markdown), '$H_{2}O$');
  assert.doesNotMatch(render(markdown), /katex-error|&lt;sub/);
});

test('long mathematical text without inline tags takes the ordinary path', () => {
  const markdown = 'x_1 '.repeat(40_000);

  assert.equal(normalizeMineruReaderMarkdown(markdown), normalizeMarkdownMath(markdown));
});

test('existing scripts on later math terms do not create duplicate KaTeX scripts', () => {
  for (const source of ['$x_i + y_j<sub>2</sub>$', '$x^i + y^j<sup>2</sup>$']) {
    const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
    const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

    assert.doesNotMatch(render(markdown), /katex-error/);
    assert.match(markdown, /\$<\s*(?:sub|sup)\s*>/);
  }
});

test('equation fallback repairs the mathText actually sent to KaTeX', () => {
  const blocks = flattenMineruPages(parseMineruMarkdownPages('\\sum_{i=1}^n x_i H<sub>2</sub>O'));
  const rendered = buildRenderableBlocks(blocks)[0];

  assert.equal(rendered?.block.type, 'equation');
  assert.match(rendered?.mathText ?? '', /H_\{2\}O/);
  assert.doesNotMatch(rendered?.mathText ?? '', /<sub>/);
});

test('oversized image fallback does not restore an embedded remote image', () => {
  const source = `![${'a'.repeat(66_000)} H<sub>2</sub>O](https://example.invalid/pixel)`;
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(blocks[0]?.type, 'image');
  assert.match(markdown, /^\*\*图片说明\*\*/);
  assert.doesNotMatch(markdown, /https:\/\/example\.invalid\/pixel/);
});

test('mid-line tildes do not suppress tagged prose recovery', () => {
  const source = 'Use ~~~ here and H<sub>2</sub>O';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.doesNotMatch(markdown, /\$[^$]*<sub>/);
  assert.match(render(markdown), /H<sub>2<\/sub>O/);
});

test('real tilde code fences stay inert while surrounding tags render', () => {
  const source = 'H<sub>2</sub>O\n~~~text\nH<sub>3</sub>O\n~~~\nCO<sub>2</sub>';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.match(markdown, /~~~text\nH<sub>3<\/sub>O\n~~~/);
  assert.match(render(markdown), /H<sub>2<\/sub>O/);
  assert.match(render(markdown), /CO<sub>2<\/sub>/);
});
