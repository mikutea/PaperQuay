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
  displayMathTagsAsLatex,
  flattenMineruPages,
  markdownCodeSpans,
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

test('formula HTML ignores greater-than characters inside quoted attributes', () => {
  const source = '<span class="math" title=">">x<sup>2</sup></span>';

  assert.equal(normalizeMineruReaderMarkdown(source), '$x^{2}$');
  assert.doesNotMatch(render(source), /katex-error|&lt;sup/);
});

test('formula wrappers escape tag metacharacters before legacy math conversion', () => {
  const source = '<span class="math">x<sup>50%</sup></span>';

  assert.equal(normalizeMineruReaderMarkdown(source), '$x^{50\\%}$');
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

test('escaped dollar signs leave tagged prose for inline formatting', () => {
  const source = String.raw`\$H<sub>2</sub>O\$`;
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.doesNotMatch(markdown, /H_\{2\}/);
  assert.match(render(markdown), /H<sub>2<\/sub>O/);
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('escaped display-math delimiters keep paired tags as readable text', () => {
  const source = String.raw`\$$H<sub>2</sub>O\$$`;
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.doesNotMatch(markdown, /H_\{2\}/);
  assert.match(render(markdown), /H<sub>2<\/sub>O/);
});

test('a dollar inside a paired tag is not an inline-math delimiter', () => {
  const source = '$x<sup>US$</sup>$';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.equal(markdown, String.raw`$x^{US{\char"24}}$`);
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('parenthesized explicit math keeps its fence when it contains a tag', () => {
  const source = String.raw`\(x + H<sub>2</sub>O\)`;
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(buildReaderTranslationBlockInputs(blocks)[0]?.text, normalizeMarkdownMath(source));
  assert.match(markdown, /^\$x \+ H_\{2\}O\$$/);
  assert.match(render(markdown), /katex/);
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('parenthesized math with an ordinary inner parenthesis retains its authored fence', () => {
  const source = String.raw`\(f(x) + H<sub>2</sub>O\)`;
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.equal(markdown, '$f(x) + H_{2}O$');
  assert.match(render(markdown), /katex/);
});

test('parenthesized math keeps its fence with delimiter-adjacent whitespace', () => {
  const source = String.raw`\( f(x) + H<sub>2</sub>O \)`;
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.equal(markdown, '$f(x) + H_{2}O$');
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('identical authored math and prose tags keep their occurrence-specific formatting', () => {
  for (const source of ['$H<sub>2</sub>O$ and H<sub>2</sub>O', 'H<sub>2</sub>O and $H<sub>2</sub>O$']) {
    const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

    assert.equal((markdown.match(/H_\{2\}O/g) ?? []).length, 1);
    assert.equal((markdown.match(/H<sub>2<\/sub>O/g) ?? []).length, 1);
    assert.doesNotMatch(render(markdown), /katex-error/);
  }
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

test('invalid spaced pseudo-tags inside authored math stay literal', () => {
  const source = '$x< sup>2< /sup>$';
  assert.equal(displayMathTagsAsLatex('x< sup>2< /sup>'), 'x< sup>2< /sup>');
  assert.equal(normalizeMineruReaderMarkdown(source), source);
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

test('literal reader tag markers are not mistaken for protected tags', () => {
  const source = 'A{PQInlineTag0} and $x$<sup>2</sup>';

  assert.match(normalizeMineruReaderMarkdown(source), /A\{PQInlineTag0\}/);
  assert.match(render(source), /A\{PQInlineTag0\}/);
  assert.match(render(source), /<sup>2<\/sup>/);
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

test('fenced code tags do not exhaust the formatting cap or block later math', () => {
  const literal = 'H<sub>2</sub>O'.repeat(257);
  const source = ['```text', literal, '```', '\\(x_i\\)'].join('\n');
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.equal(markdown, normalizeMarkdownMath(source));
  assert.match(markdown, /\$x_i\$$/);
  assert.match(markdown, /^```text\nH<sub>2<\/sub>O/);
});

test('fenced tags cannot split later long relation text into expensive normalization', () => {
  const source = `\x60\x60\x60text\n$x$<sup>${'a'.repeat(10_000)}=b</sup>\n\x60\x60\x60\nH<sub>2</sub>O`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.ok(markdown.startsWith(`\x60\x60\x60text\n$x$<sup>${'a'.repeat(10_000)}=b</sup>\n\x60\x60\x60\n`));
  assert.match(markdown, /H<sub>2<\/sub>O$/);
});

test('inline code tags cannot split a long literal relation', () => {
  const literal = '`$x$<sup>' + 'a'.repeat(10_000) + '=b</sup>`';
  const source = `${literal}\nH<sub>2</sub>O`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.ok(markdown.startsWith(literal));
  assert.match(render(markdown), /H<sub>2<\/sub>O/);
});

test('an unmatched backtick cannot turn a later paragraph into inline code', () => {
  const source = '`unmatched\n\n\\(x + H<sub>2</sub>O\\)`';
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$`$/);
  const withFence = `${source}\n\n\x60\x60\x60text\nexample\n\x60\x60\x60`;
  assert.match(normalizeMineruReaderMarkdown(withFence), /\$x \+ H_\{2\}O\$`/);
});

test('tilde-fenced tags stay inert while outside math still formats', () => {
  const source = '~~~text\n$x$<sup>2</sup>\n~~~\n\\(x + H<sub>2</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);
  assert.match(markdown, /^~~~text\n\$x\$<sup>2<\/sup>\n~~~\n/);
  assert.match(markdown, /\$x \+ H_\{2\}O\$$/);
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

test('caption entities decode in visible text and flattened alt text', () => {
  const source = 'CO<sub>&#8322;</sub> &amp; H<sub>2</sub>O';
  const html = renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption(source)));

  assert.match(html, /CO<sub>₂<\/sub> &amp; H<sub>2<\/sub>O/);
  assert.equal(plainMineruInlineCaption(source), 'CO₂ & H2O');
});

test('caption pseudo-tags with whitespace after the angle bracket stay literal', () => {
  const source = 'x< sup>2< /sup> and H<sub >2</sub >O';
  const html = renderToStaticMarkup(createElement('span', null, ...renderMineruInlineCaption(source)));

  assert.match(html, /x&lt; sup&gt;2&lt; \/sup&gt; and H<sub>2<\/sub>O/);
  assert.equal(plainMineruInlineCaption(source), 'x< sup>2< /sup> and H2O');
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

test('reader normalization leaves four-space and tab-indented code blocks literal', () => {
  for (const indent of ['    ', '\t']) {
    const source = `text\n\n${indent}$H<sub>2</sub>O$\n\nH<sub>3</sub>O`;
    const markdown = normalizeMineruReaderMarkdown(source);

    assert.match(markdown, new RegExp(`${indent === '\t' ? '\\t' : ' {4}'}\\$H<sub>2<\\/sub>O\\$`));
    assert.match(render(markdown), /<pre><code>\$H&lt;sub&gt;2&lt;\/sub&gt;O\$\n<\/code><\/pre>/);
    assert.match(render(markdown), /H<sub>3<\/sub>O/);
  }
});

test('bare CR indented code remains literal while later math formats', () => {
  const source = 'text\r\r    $H<sub>2</sub>O$\r\r\\(x + H<sub>3</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);
  assert.match(markdown, /^text\r\r    \$H<sub>2<\/sub>O\$\r\r/);
  assert.match(markdown, /\$x \+ H_\{3\}O\$$/);
  assert.match(render(source), /<pre><code>\$H&lt;sub&gt;2&lt;\/sub&gt;O\$/);
});

test('bare CR paragraph breaks stop code spans before later formulae', () => {
  const source = 'prefix ```\r\r\\(x + H<sub>2</sub>O\\)\r\rsuffix ```';
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$/);
});

test('reader normalization recognizes indented code after blockquote prefixes', () => {
  const source = '>     $H<sub>2</sub>O$';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.equal(markdown, source);
  assert.match(render(markdown), /<code>\$H&lt;sub&gt;2&lt;\/sub&gt;O\$/);
});

test('reader normalization recognizes indented code after list markers', () => {
  const source = '-     $H<sub>2</sub>O$';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.equal(markdown, source);
  assert.match(render(markdown), /<code>\$H&lt;sub&gt;2&lt;\/sub&gt;O\$/);
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

test('tag-free unterminated formula wrappers skip inline-tag wrapper scanning', () => {
  const markdown = '<div class="formula">'.repeat(400);

  assert.equal(normalizeMineruReaderMarkdown(markdown), normalizeMarkdownMath(markdown));
});

test('malformed formula wrappers with a paired tag remain bounded and readable', () => {
  const markdown = `${'<div class="formula">'.repeat(2_000)}H<sup>2</sup>`;

  assert.match(normalizeMineruReaderMarkdown(markdown), /H<sup>2<\/sup>/);
});

test('long math tokens choose the direct fallback before tag-marker normalization', () => {
  const markdown = `${'x'.repeat(20_000)}_1 H<sup>2</sup>O`;

  assert.match(normalizeMineruReaderMarkdown(markdown), /H\^\{2\}O|H<sup>2<\/sup>O/);
});

test('long relation tokens avoid expensive protected-tag normalization', () => {
  for (const relation of ['=', '<', '>', '~']) {
    const source = `${'x'.repeat(10_000)}${relation}foo H<sup>2</sup>`;
    const started = performance.now();
    const markdown = normalizeMineruReaderMarkdown(source);

    assert.ok(performance.now() - started < 2_000);
    assert.match(markdown, /H(?:\^\{2\}|<sup>2<\/sup>)/);
  }
});

test('existing scripts on later math terms do not create duplicate KaTeX scripts', () => {
  for (const source of ['$x_i + y_j<sub>2</sub>$', '$x^i + y^j<sup>2</sup>$']) {
    const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
    const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

    assert.doesNotMatch(render(markdown), /katex-error/);
    assert.match(markdown, /y[_^]\{j2\}/);
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

test('image removal does not substitute its alt code span for later source code', () => {
  const source = 'prefix ![`alt`](images/foo.png) `literal` and H<sub>3</sub>O';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(markdown, /`literal`/);
  assert.doesNotMatch(markdown, /`alt`/);
});

test('image removal matches the later code span even when alt normalizes identically', () => {
  const source = 'prefix ![`1 2%`](images/foo.png) `12%` and H<sub>3</sub>O';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(markdown, /`12%`/);
  assert.doesNotMatch(markdown, /`1 2%`/);
});

test('source code is still restored when normalization changes text inside it', () => {
  const source = '`$H<sub>2</sub>O$` and H<sub>3</sub>O';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));

  assert.match(buildRenderableBlocks(blocks)[0]?.markdown ?? '', /`\$H<sub>2<\/sub>O\$`/);
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

test('a longer backtick fence closer preserves code while outside tags render', () => {
  const source = 'H<sub>2</sub>O\n```text\n$H<sub>3</sub>O$\n````\nCO<sub>2</sub>';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.match(markdown, /```text\n\$H<sub>3<\/sub>O\$\n````/);
  assert.match(render(markdown), /H<sub>2<\/sub>O/);
  assert.match(render(markdown), /CO<sub>2<\/sub>/);
});

test('an over-indented candidate cannot close a top-level code fence', () => {
  const source = '   ```text\n      ```\n$x_i H<sub>2</sub>O$\n   ```\nCO<sub>2</sub>';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.match(markdown, /      ```\n\$x_i H<sub>2<\/sub>O\$\n   ```/);
  assert.doesNotMatch(markdown, /\$x_i H_\{2\}O\$/);
  assert.match(render(markdown), /CO<sub>2<\/sub>/);
});

test('a fence outside the opening quote or list starts its own code block', () => {
  for (const source of [
    '> ```text\n```\n$H<sub>2</sub>O$',
    '10. ```text\n```\n$H<sub>2</sub>O$',
  ]) {
    const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

    assert.match(markdown, /```\n\$H<sub>2<\/sub>O\$/);
    assert.doesNotMatch(markdown, /H_\{2\}/);
  }
});

test('mid-line backticks cannot close a fenced block', () => {
  const source = '```text\n``` $H<sub>2</sub>O$\n$CO<sub>2</sub>$\n```\nH<sub>3</sub>O';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.match(markdown, /``` \$H<sub>2<\/sub>O\$\n\$CO<sub>2<\/sub>\$\n```/);
  assert.match(render(markdown), /H<sub>3<\/sub>O/);
});

test('blockquote and list code fences keep tag examples literal', () => {
  for (const source of [
    '> ```text\n> $H<sub>2</sub>O$\n> ```\nH<sub>3</sub>O',
    '10. ```text\n    $H<sub>2</sub>O$\n    ````\nH<sub>3</sub>O',
  ]) {
    const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

    assert.match(markdown, /\$H<sub>2<\/sub>O\$/);
    assert.doesNotMatch(markdown, /\$H_\{2\}O\$/);
    assert.match(render(markdown), /H<sub>3<\/sub>O/);
  }
});

test('nested list code fences keep tagged math examples literal', () => {
  const source = '- - ~~~text\n    $H<sub>2</sub>O$\n    ~~~\n\nH<sub>3</sub>O';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.match(markdown, /~~~text\n    \$H<sub>2<\/sub>O\$\n    ~~~/);
  assert.doesNotMatch(markdown, /H_\{2\}O/);
  assert.match(render(markdown), /H<sub>3<\/sub>O/);
});

test('an unmatched backtick does not hide a later matched code span', () => {
  const source = '` unmatched then ``x_i H<sub>2</sub>O``';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(render(markdown), /<code>x_i H&lt;sub&gt;2&lt;\/sub&gt;O<\/code>/);
});

test('an escaped backtick leaves the rest of its run available for inline code', () => {
  const source = 'H<sub>3</sub>O and \\``$H<sub>2</sub>O$`';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.match(markdown, /\$H<sub>2<\/sub>O\$/);
  assert.doesNotMatch(markdown, /\$H_\{2\}O\$/);
  assert.match(render(markdown), /H<sub>3<\/sub>O/);
  assert.match(render(markdown), /<code>\$H&lt;sub&gt;2&lt;\/sub&gt;O\$<\/code>/);
});

test('a backslash before a code-span closer does not escape the closer', () => {
  const source = '`$H<sub>2</sub>O$\\` and H<sub>3</sub>O';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.match(markdown, /\$H<sub>2<\/sub>O\$\\`/);
  assert.doesNotMatch(markdown, /H_\{2\}O/);
  assert.match(render(markdown), /H<sub>3<\/sub>O/);
});

test('literal pre blocks keep tag examples inert while surrounding text formats', () => {
  const source = '<pre>$H<sub>2</sub>O$</pre>\nH<sub>3</sub>O';
  const fallback = displayMarkdownFallback(source, normalizeMarkdownMath(source));
  const jsonBacked = normalizeMineruReaderMarkdown(source);

  for (const markdown of [fallback, jsonBacked]) {
    assert.match(markdown, /<pre>\$H<sub>2<\/sub>O\$<\/pre>/);
    assert.doesNotMatch(markdown, /H_\{2\}O/);
    assert.match(render(markdown), /H<sub>3<\/sub>O/);
  }
});

test('literal raw HTML blocks keep tag examples inert', () => {
  for (const tag of ['textarea', 'script', 'style', 'div', 'iframe', 'custom']) {
    const inner = tag === 'custom' ? '\n$H<sub>2</sub>O$\n' : '$H<sub>2</sub>O$';
    const source = `<${tag}>${inner}</${tag}>\n\nH<sub>3</sub>O`;
    for (const markdown of [
      displayMarkdownFallback(source, normalizeMarkdownMath(source)),
      normalizeMineruReaderMarkdown(source),
    ]) {
      assert.match(markdown, new RegExp(`<${tag}>\\s*\\$H<sub>2<\\/sub>O\\$\\s*<\\/${tag}>`));
      assert.doesNotMatch(markdown, /H_\{2\}O/);
      assert.match(render(markdown), /H<sub>3<\/sub>O/);
    }
  }
});

test('indented code following a raw HTML block remains literal', () => {
  const source = '<pre>x</pre>\n    $H<sub>2</sub>O$';
  assert.equal(normalizeMineruReaderMarkdown(source), source);
});

test('invalid custom HTML opening does not hide following tagged math', () => {
  const source = '<x @>\n\\(x + H<sub>2</sub>O\\)';
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$$/);
  const valid = '<x data-note="a > b">\n$H<sub>2</sub>O$\n\nH<sub>3</sub>O';
  const markdown = normalizeMineruReaderMarkdown(valid);
  assert.match(markdown, /^<x data-note="a > b">\n\$H<sub>2<\/sub>O\$/);
  assert.match(render(markdown), /H<sub>3<\/sub>O/);
});

test('CRLF blank line ends a generic raw HTML block', () => {
  const source = '<div>literal</div>\r\n\r\n\\(x + H<sub>2</sub>O\\)';
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$$/);
});

test('fenced Markdown fallback keeps escaped math text after the fence', () => {
  const source = '\x60\x60\x60text\nexample\n\x60\x60\x60\n<span class="math">x<sup>50%</sup></span>';
  const safeNormalized = normalizeMarkdownMath(source.replace('<sup>50%</sup>', String.raw`^{50\%}`));
  const markdown = displayMarkdownFallback(source, safeNormalized);
  assert.match(markdown, /\$x\^\{50\\%\}\$$/);
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('a standalone equals line is not a setext heading after a block boundary', () => {
  const source = '=\n    \\(x + H<sub>2</sub>O\\)';
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$$/);
  const heading = 'Heading\n===\n    $H<sub>2</sub>O$';
  assert.equal(normalizeMineruReaderMarkdown(heading), heading);
});

test('a short hyphen setext heading starts an indented code block', () => {
  for (const underline of ['-', '--']) {
    const source = `Heading\n${underline}\n    $H<sub>2</sub>O$`;
    assert.equal(normalizeMineruReaderMarkdown(source), source);
  }
  assert.match(normalizeMineruReaderMarkdown('--\n    \\(x + H<sub>2</sub>O\\)'), /\$x \+ H_\{2\}O\$$/);
});

test('only uppercase HTML declarations protect following raw HTML math text', () => {
  for (const opening of ['<!doctype html>', '<!foo>']) {
    const source = `${opening} \\(x + H<sub>2</sub>O\\)`;
    assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$$/);
  }
  const uppercase = '<!DOCTYPE html> \\(x + H<sub>2</sub>O\\)';
  assert.equal(normalizeMineruReaderMarkdown(uppercase), uppercase);
});

test('custom HTML blocks do not interrupt a paragraph', () => {
  for (const source of [
    'paragraph\n<x>\n\\(x + H<sub>2</sub>O\\)',
    '<span>paragraph</span>\n<x>\n\\(x + H<sub>2</sub>O\\)',
    '> paragraph\n> <x>\n> \\(x + H<sub>2</sub>O\\)',
  ]) {
    assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$$/);
  }
  const separateBlock = 'paragraph\n\n<x>\n$H<sub>2</sub>O$';
  assert.equal(normalizeMineruReaderMarkdown(separateBlock), separateBlock);
  const afterRawBlock = '<pre>x</pre>\n<x>\n$H<sub>2</sub>O$';
  assert.equal(normalizeMineruReaderMarkdown(afterRawBlock), afterRawBlock);
});

test('a setext heading ends its paragraph before a type-seven HTML block', () => {
  const source = 'Heading\n===\n<x>\nliteral H<sub>2</sub>O\n\noutside \\(x + H<sub>3</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.match(markdown, /^Heading\n===\n<x>\nliteral H<sub>2<\/sub>O\n\n/);
  assert.match(markdown, /outside \$x \+ H_\{3\}O\$$/);
});

test('an ATX heading cannot supply setext text before a type-seven tag', () => {
  const source = '# Heading\n===\n<x>\n\\(x + H<sub>2</sub>O\\)';

  assert.match(normalizeMineruReaderMarkdown(source), /<x>\n\$x \+ H_\{2\}O\$$/);
});

test('an ordered list starting above one cannot interrupt a paragraph', () => {
  const source = 'paragraph\n2. continued\n<x>\n\\(x + H<sub>2</sub>O\\)';
  assert.match(normalizeMineruReaderMarkdown(source), /<x>\n\$x \+ H_\{2\}O\$$/);
  for (const list of ['2. item\n<x>', 'paragraph\n\n2. item\n<x>']) {
    const separateBlock = `${list}\n\\(x + H<sub>2</sub>O\\)`;
    assert.equal(normalizeMineruReaderMarkdown(separateBlock), separateBlock);
  }
});

test('a dedented blockquote paragraph cannot block a new raw HTML block', () => {
  for (const source of [
    '> paragraph\n<x>\nliteral \\(x + H<sub>2</sub>O\\)',
    '- paragraph\n  continued\n<x>\nliteral \\(x + H<sub>2</sub>O\\)',
  ]) {
    assert.equal(normalizeMineruReaderMarkdown(source), source);
  }
});

test('entering a blockquote ends the outside paragraph before raw HTML', () => {
  const source = 'paragraph\n> <x>\n> literal \\(x + H<sub>2</sub>O\\)';
  assert.equal(normalizeMineruReaderMarkdown(source), source);
});

test('a slash-delimited pseudo-tag cannot open a type-six raw HTML block', () => {
  const source = '<div/foo>\n\\(x + H<sub>2</sub>O\\)';
  assert.match(renderToStaticMarkup(createElement(ReactMarkdown, null, source)), /^<p>&lt;div\/foo&gt;/);
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$$/);
});

test('Unicode case folding does not shift raw HTML closer offsets', () => {
  for (const closing of ['</pre>', '</PRE>']) {
    const source = `<pre>\nİ\n${closing}\n\\(x + H<sub>2</sub>O\\)`;
    const markdown = normalizeMineruReaderMarkdown(source);
    assert.match(markdown, /\$x \+ H_\{2\}O\$$/);
  }
});

test('a quoted ATX heading cannot supply setext text either', () => {
  const source = '> # Heading\n> ===\n> <x>\n> \\(x + H<sub>2</sub>O\\)';

  assert.match(normalizeMineruReaderMarkdown(source), /> <x>\n> \$x \+ H_\{2\}O\$$/);
});

test('a backtick info string containing a backtick cannot start a code fence', () => {
  const source = '\x60\x60\x60 bad\x60\n\\(x + H<sub>2</sub>O\\)';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));
  assert.match(markdown, /\$x \+ H_\{2\}O\$$/);
});

test('an invalid fence opener does not make later paragraph math into code', () => {
  const source = '\x60\x60\x60 bad\x60\n\\(x + H<sub>2</sub>O\\)\n\x60\x60\x60';
  const rawHtml = renderToStaticMarkup(createElement(ReactMarkdown, null, source));
  assert.match(rawHtml, /^<p>[\s\S]*<\/p>\n<pre><code><\/code><\/pre>$/);
  assert.match(render(source), /<span class="katex">/);
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$/);
});

test('an ordered marker other than one cannot interrupt a paragraph with a fence', () => {
  const source = 'paragraph\n2. ~~~text\n    \\(x + H<sub>2</sub>O\\)';
  assert.match(renderToStaticMarkup(createElement(ReactMarkdown, null, source)), /^<p>paragraph\n2\. ~~~text/);
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$$/);
});

test('a setext heading lets a later non-one ordered list open its fence', () => {
  const source = 'Heading\n===\n2. ~~~text\n   \\(x + H<sub>2</sub>O\\)\n   ~~~';
  assert.equal(normalizeMineruReaderMarkdown(source), source);
});

test('a fence opened on a list continuation ends at list dedent', () => {
  const source = '- item\n  \x60\x60\x60text\n  $H<sub>3</sub>O$\noutside \\(x + H<sub>2</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);
  assert.match(markdown, /  \$H<sub>3<\/sub>O\$/);
  assert.match(markdown, /outside \$x \+ H_\{2\}O\$$/);
});

test('bare CR line endings keep fenced examples inert and later math active', () => {
  const source = '```text\rimages/foo.png H<sub>2</sub>O\r```\r\\(x + H<sub>3</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);
  assert.match(markdown, /^```text\rimages\/foo\.png H<sub>2<\/sub>O\r```\r/);
  assert.match(markdown, /\$x \+ H_\{3\}O\$$/);
  const html = render(source);
  assert.match(html, /images\/foo\.png H&lt;sub&gt;2&lt;\/sub&gt;O/);
  assert.match(html, /class="katex"/);
});

test('a nested blockquote underline cannot complete an outer setext heading', () => {
  const source = '> Heading\n> > ===\n> > <x>\n> > \\(x + H<sub>2</sub>O\\)';
  assert.match(normalizeMineruReaderMarkdown(source), /<x>\n> > \$x \+ H_\{2\}O\$$/);
});

test('emphasized paragraph text is not a thematic-break boundary', () => {
  const source = 'paragraph\n***continued***\n<x>\n\\(x + H<sub>2</sub>O\\)';
  assert.match(normalizeMineruReaderMarkdown(source), /<x>\n\$x \+ H_\{2\}O\$$/);
});

test('list-then-quote fenced examples stay literal in Markdown fallback', () => {
  const source = '- > \x60\x60\x60text\n  > $H<sub>2</sub>O$\n  > \x60\x60\x60\n\\(x + H<sub>3</sub>O\\)';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));
  assert.match(markdown, /  > \$H<sub>2<\/sub>O\$/);
  assert.match(markdown, /\$x \+ H_\{3\}O\$$/);
});

test('fenced code preserves image paths and spaced percentages', () => {
  for (const example of ['images/foo.png H<sub>2</sub>O', '1 2% H<sub>2</sub>O']) {
    const source = `\x60\x60\x60text\n${example}\n\x60\x60\x60`;
    assert.equal(normalizeMineruReaderMarkdown(source), source);
  }
});

test('mid-line triple backticks cannot join code spans across paragraphs', () => {
  const source = 'prefix \x60\x60\x60\n\n\\(x + H<sub>2</sub>O\\)\n\nsuffix \x60\x60\x60';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));
  assert.match(markdown, /\$x \+ H_\{2\}O\$/);
});

test('indented triple-backtick spans in continued paragraphs remain inline code', () => {
  const source = 'paragraph\n    ```\\(x + H<sub>2</sub>O\\)```';

  assert.equal(normalizeMineruReaderMarkdown(source), source);
});

test('type-one raw HTML may open at the end of a line', () => {
  for (const tag of ['pre', 'script', 'style', 'textarea']) {
    const source = `<${tag}\nliteral \\(x + H<sub>2</sub>O\\)\n</${tag}>`;
    assert.equal(normalizeMineruReaderMarkdown(source), source);
  }
});

test('type-six raw HTML may open at the end of a line', () => {
  const source = '<div\nliteral $H<sub>2</sub>O$\n\n\\(x + H<sub>3</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.match(markdown, /^<div\nliteral \$H<sub>2<\/sub>O\$\n\n/);
  assert.match(markdown, /\$x \+ H_\{3\}O\$$/);
});

test('self-closing special tags end at a blank line like type-seven blocks', () => {
  for (const tag of ['pre', 'script', 'style', 'textarea']) {
    const source = `<${tag}/>\nliteral H<sub>2</sub>O\n\n\\(x + H<sub>3</sub>O\\)`;
    assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{3\}O\$$/);
  }
});

test('bare CR raw HTML boundaries leave later formulae active', () => {
  const source = '<pre>\rliteral H<sub>2</sub>O\r</pre>\r\\(x + H<sub>3</sub>O\\)';
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{3\}O\$$/);
});

test('an unclosed raw HTML block inside a list ends when the list dedents', () => {
  const source = '- item\n  <pre>\n  literal\noutside \\(x + H<sub>2</sub>O\\)';

  assert.match(normalizeMineruReaderMarkdown(source), /outside \$x \+ H_\{2\}O\$$/);
});

test('an unclosed raw HTML block in a quoted list ends at list dedent', () => {
  const source = '> - item\n>   <pre>\n>   literal\n> outside \\(x + H<sub>2</sub>O\\)';

  assert.match(normalizeMineruReaderMarkdown(source), /> outside \$x \+ H_\{2\}O\$$/);
});

test('standalone special closing tags end at the next blank line', () => {
  for (const tag of ['pre', 'script']) {
    const source = `</${tag}>\nliteral H<sub>2</sub>O\n\n\\(x + H<sub>3</sub>O\\)`;
    const markdown = normalizeMineruReaderMarkdown(source);
    assert.match(markdown, /\$x \+ H_\{3\}O\$$/);
  }
});

test('nonblank block starts terminate an inline code span from the prior block', () => {
  for (const blockStart of ['# ', '> ', '- ']) {
    const source = `\x60start\n${blockStart}\\(x + H<sub>2</sub>O\\)\n\x60end`;
    assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$/m);
  }
  for (const source of [
    '> \x60start\n\\(x + H<sub>2</sub>O\\)\n\x60end',
    '- \x60start\n\\(x + H<sub>2</sub>O\\)\n\x60end',
  ]) {
    assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$/m);
  }
  assert.equal(markdownCodeSpans('> \x60start\n> end\x60', true).length, 1);
  assert.equal(markdownCodeSpans('- \x60start\n  end\x60', true).length, 1);
});

test('long whitespace in a nested math tag cannot stall tag detection', () => {
  const source = `x<sup><a ${' '.repeat(4_000)}</sup>`;
  const started = performance.now();
  assert.match(displayMathTagsAsLatex(source) ?? '', /^x\^\{\\lt a/);
  assert.ok(performance.now() - started < 1_000);
});

test('long quote prefixes cannot stall inline code span detection', () => {
  const source = `paragraph\n> ${' '.repeat(64_000)}x\x60\x60\x60 H<sub>2</sub>O`;
  const started = performance.now();
  assert.deepEqual(markdownCodeSpans(source, true), []);
  assert.ok(performance.now() - started < 1_500);
});

test('line-level code prefixes retain quote and single-list recognition', () => {
  for (const prefix of ['', '   ', '>  >   ', '>    -  ', '123456789. ']) {
    assert.deepEqual(markdownCodeSpans(`${prefix}\x60\x60\x60x\x60\x60\x60`, true), []);
  }
  for (const prefix of ['> x', '1234567890. ', '>   -x']) {
    assert.equal(markdownCodeSpans(`${prefix}\x60\x60\x60x\x60\x60\x60`, true).length, 1);
  }
});

test('raw comment, instruction, and CDATA blocks keep tag examples inert', () => {
  for (const [opening, closing] of [
    ['<!--', '-->'],
    ['<?instruction', '?>'],
    ['<![CDATA[', ']]>'],
  ]) {
    const source = `${opening}\n$H<sub>2</sub>O$\n${closing}\n\nH<sub>3</sub>O`;
    for (const markdown of [
      displayMarkdownFallback(source, normalizeMarkdownMath(source)),
      normalizeMineruReaderMarkdown(source),
    ]) {
      assert.match(markdown, /\$H<sub>2<\/sub>O\$/);
      assert.doesNotMatch(markdown, /H_\{2\}O/);
      assert.match(render(markdown), /H<sub>3<\/sub>O/);
    }
  }
});

test('raw HTML closing lines keep trailing tag examples inert', () => {
  for (const source of [
    '<pre>example</pre> $H<sub>2</sub>O$',
    '<!-- example --> $H<sub>2</sub>O$',
    '<?example ?> $H<sub>2</sub>O$',
    '<![CDATA[example]]> $H<sub>2</sub>O$',
    '<!DOCTYPE html> $H<sub>2</sub>O$',
  ]) {
    const markdown = normalizeMineruReaderMarkdown(`${source}\n\nH<sub>3</sub>O`);
    assert.ok(markdown.startsWith(source), source);
    assert.doesNotMatch(markdown, /H_\{2\}O/);
    assert.match(render(markdown), /H<sub>3<\/sub>O/);
  }
});

test('an unclosed literal pre block keeps the remaining tag example inert', () => {
  const source = 'H<sub>3</sub>O\n<pre>$H<sub>2</sub>O$';
  const markdown = displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.match(markdown, /<pre>\$H<sub>2<\/sub>O\$$/);
  assert.doesNotMatch(markdown, /H_\{2\}O/);
  assert.match(render(markdown), /H<sub>3<\/sub>O/);
});

test('long blockquote prefixes do not backtrack while looking for a fence', () => {
  const source = `${'>   '.repeat(26)}X_1 H<sup>2</sup>`;
  const started = performance.now();
  displayMarkdownFallback(source, normalizeMarkdownMath(source));

  assert.ok(performance.now() - started < 2_000);
});

test('a completed fence adjacent to a tag does not block a later explicit formula', () => {
  const source = '$x$<sup>2</sup> and $H<sub>2</sub>O$';
  const html = render(source);

  assert.match(html, /<sup>2<\/sup>/);
  assert.doesNotMatch(html, /katex-error|&lt;sub/);
  assert.match(html, /katex/);
});

test('fence-adjacent tags do not make a long math token stall normalization', () => {
  const source = `${'x'.repeat(10_000)}_1 H<sub>2</sub>O and $x$<sup>2</sup>`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.match(markdown, /H(?:_\{2\}|<sub>2<\/sub>)O/);
  assert.match(markdown, /\$x\$<sup>2<\/sup>/);
});

test('a completed fence does not force a later long relation through marker normalization', () => {
  const source = `$x$<sup>2</sup> ${'x'.repeat(10_000)}=foo A<sup>2</sup>`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.match(markdown, /^\$x\$<sup>2<\/sup>/);
  assert.match(markdown, /A(?:\^\{2\}|<sup>2<\/sup>)/);
});

test('many unmatched adjacent tags do not rescan the remaining suffix', () => {
  const source = `${'$<sup>'.repeat(1_000)}${'x'.repeat(40_000)}=foo`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.equal(markdown, source);
});

test('equation mathText merges adjacent duplicate script tags for KaTeX', () => {
  const blocks = flattenMineruPages(parseMineruMarkdownPages('\\sum_i y_j<sub>2</sub>'));
  const rendered = buildRenderableBlocks(blocks)[0];

  assert.equal(rendered?.block.type, 'equation');
  assert.match(rendered?.mathText ?? '', /y_\{j2\}/);
  assert.doesNotMatch(rendered?.mathText ?? '', /<sub>/);
});

test('display-math fences merge adjacent duplicate script tags for KaTeX', () => {
  const markdown = '$$x_i<sub>2</sub>$$';

  assert.doesNotMatch(render(markdown), /katex-error|&lt;sub/);
  assert.match(render(markdown), /katex/);
});

test('formula terms after a duplicate script tag stay in the same math fence', () => {
  const source = '$x_i<sub>2</sub>+y_j$';
  const blocks = flattenMineruPages(parseMineruMarkdownPages(source));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.match(markdown, /^\$x_\{i2\}\+y_j\$$/);
  assert.doesNotMatch(render(markdown), /katex-error/);
});

test('math tags merge duplicate scripts even when TeX whitespace separates them', () => {
  assert.equal(displayMathTagsAsLatex('x_i <sub>2</sub>'), 'x_{i2}');
  assert.equal(displayMathTagsAsLatex('x^{i}\n<sup>2</sup>'), 'x^{i2}');
  assert.doesNotMatch(render('$$x_i <sub>2</sub>$$'), /katex-error/);

  const equation = buildRenderableBlocks(flattenMineruPages(parseMineruMarkdownPages('\\sum_i x_i <sub>2</sub>')))[0];
  assert.match(equation?.mathText ?? '', /x_\{i2\}/);
});

test('math tags merge an existing TeX control-sequence script', () => {
  assert.equal(displayMathTagsAsLatex(String.raw`x_\alpha<sub>2</sub>`), String.raw`x_{\alpha 2}`);
  assert.doesNotMatch(render(String.raw`$$x_\alpha<sub>2</sub>$$`), /katex-error/);

  const equation = buildRenderableBlocks(flattenMineruPages(parseMineruMarkdownPages(String.raw`\sum_i x_\alpha<sub>2</sub>`)))[0];
  assert.match(equation?.mathText ?? '', /x_\{\\alpha 2\}/);
});

test('math tags merge an existing nested TeX script group', () => {
  assert.equal(displayMathTagsAsLatex(String.raw`x_{\mathrm{i}}<sub>2</sub>`), String.raw`x_{\mathrm{i}2}`);
  assert.doesNotMatch(render(String.raw`$$x_{\mathrm{i}}<sub>2</sub>$$`), /katex-error/);
});

test('math tags merge an existing Unicode script argument', () => {
  assert.equal(displayMathTagsAsLatex('x_α<sub>2</sub>'), 'x_{α2}');
  assert.doesNotMatch(render('$$x_α<sub>2</sub>$$'), /katex-error/);
});

test('math tags merge an existing TeX control-symbol script argument', () => {
  assert.equal(displayMathTagsAsLatex(String.raw`x_\%<sub>2</sub>`), String.raw`x_{\% 2}`);
  assert.doesNotMatch(render(String.raw`$$x_\%<sub>2</sub>$$`), /katex-error/);
});

test('unbraced script merging never consumes a second TeX atom', () => {
  assert.equal(displayMathTagsAsLatex('x_ij<sub>2</sub>'), 'x_ij_{2}');
  assert.doesNotMatch(render('$$x_ij<sub>2</sub>$$'), /katex-error/);
});

test('escaped TeX script markers do not merge with tagged scripts', () => {
  assert.equal(displayMathTagsAsLatex('x\\_2<sub>3</sub>'), 'x\\_2_{3}');
});

test('GFM table cells cannot share one inline code span', () => {
  const source = '| value |\n| --- |\n| `start |\n| \\(x + H<sub>2</sub>O\\) |\n| `end |';
  assert.match(normalizeMineruReaderMarkdown(source), /\$x \+ H_\{2\}O\$/);
});

test('unbraced punctuation scripts merge before paired tags', () => {
  assert.equal(displayMathTagsAsLatex('x_+<sub>2</sub>'), 'x_{+2}');
  assert.doesNotMatch(render('$$x_+<sub>2</sub>$$'), /katex-error/);
});

test('braced control-word scripts keep a boundary before appended letters', () => {
  const source = String.raw`x_{\alpha}<sub>b</sub>`;
  const latex = displayMathTagsAsLatex(source);

  assert.equal(latex, String.raw`x_{\alpha b}`);
  assert.doesNotMatch(render(`$$${source}$$`), /katex-error/);
});

test('math tag entities decode to KaTeX-safe characters', () => {
  assert.equal(displayMathTagsAsLatex('x<sup>a&lt;b</sup>'), 'x^{a\\lt b}');
  assert.equal(displayMathTagsAsLatex('x<sub>a&amp;b</sub>'), 'x_{a\\&b}');
  assert.equal(displayMathTagsAsLatex('x<sup>&#x3B1;</sup>'), 'x^{α}');
  assert.equal(displayMathTagsAsLatex('x<sup>&lt;sub&gt;2&lt;/sub&gt;</sup>'), 'x^{\\lt sub\\gt 2\\lt /sub\\gt }');
  assert.doesNotMatch(render('$$x<sup>a&lt;b</sup>$$'), /katex-error/);
  assert.doesNotMatch(render('$$x<sub>a&amp;b</sub>$$'), /katex-error/);
});

test('raw math-tag metacharacters are escaped without breaking balanced TeX groups', () => {
  assert.equal(displayMathTagsAsLatex('x<sup>50%</sup>'), 'x^{50\\%}');
  assert.equal(displayMathTagsAsLatex('x<sub>a{b</sub>'), 'x_{a\\{b}');
  assert.equal(displayMathTagsAsLatex('x<sup>\\frac{1}{2}</sup>'), 'x^{\\frac{1}{2}}');
  assert.doesNotMatch(render('$$x<sup>50%</sup>$$'), /katex-error/);
  assert.doesNotMatch(render('$$x<sub>a{b</sub>$$'), /katex-error/);
});

test('multiline formula wrappers keep their closing div available to the math converter', () => {
  const source = '<div class="formula">\nx<sup>2</sup>\n</div>\n\nH<sub>2</sub>O';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.doesNotMatch(markdown, /<sup>/);
  assert.match(markdown, /x\^\{2\}/);
  assert.match(markdown, /H<sub>2<\/sub>O/);
  assert.doesNotMatch(render(source), /katex-error/);
});

test('nested math tags merge with an existing script before KaTeX rendering', () => {
  const source = '$$x_i<sub>2<sub>3</sub></sub>$$';
  const latex = displayMathTagsAsLatex('x_i<sub>2<sub>3</sub></sub>');

  assert.equal(latex, 'x_{i2_{3}}');
  assert.doesNotMatch(render(source), /katex-error|&lt;sub/);
});

test('Markdown autolinks do not become literal HTML blocks', () => {
  for (const link of ['<https://example.com>', '<user@example.com>']) {
    const source = `${link}\n\n\\(x + H<sub>2</sub>O\\)`;
    const markdown = normalizeMineruReaderMarkdown(source);
    assert.match(markdown, /x \+ H_\{2\}O/);
    assert.doesNotMatch(render(source), /katex-error|&lt;sub/);
  }
});

test('raw pre blocks inside blockquotes and lists leave tag examples untouched', () => {
  for (const [opening, continuation] of [['> <pre>', '> '], ['- <pre>', '  ']]) {
    const source = `${opening}\n${continuation}$H<sub>2</sub>O$\n${continuation}</pre>\n\nH<sub>3</sub>O`;
    const markdown = normalizeMineruReaderMarkdown(source);
    assert.match(markdown, /\$H<sub>2<\/sub>O\$/);
    assert.doesNotMatch(markdown, /H_\{2\}O/);
    assert.match(render(source), /H<sub>3<\/sub>O/);
  }
});

test('an unmatched dollar-adjacent tag cannot slow a later long relation', () => {
  const source = `$<sup>${'x'.repeat(10_000)}=foo A<sup>2</sup>`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.match(markdown, /A(?:\^\{2\}|<sup>2<\/sup>)/);
});

test('a completed adjacent tag does not stall an earlier long relation', () => {
  const source = `${'x'.repeat(20_000)}=foo H<sub>2</sub> and $x$<sup>2</sup>`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.match(markdown, /H(?:_\{2\}|<sub>2<\/sub>)/);
  assert.match(markdown, /\$x\$<sup>2<\/sup>/);
});

test('an unclosed pre inside a quote or list ends when its container ends', () => {
  for (const [opening, inner] of [
    ['> <pre>', '> literal'],
    ['- <pre>', '  literal'],
  ]) {
    const source = `${opening}\n${inner}\noutside \\(x + H<sub>2</sub>O\\)`;
    const markdown = normalizeMineruReaderMarkdown(source);
    assert.match(markdown, /outside \$x \+ H_\{2\}O\$/);
    assert.doesNotMatch(render(source), /katex-error|&lt;sub/);
  }
});

test('a blank line does not end a list-contained raw pre block', () => {
  const source = '- <pre>\n\n  $H<sub>2</sub>O$\n  </pre>\n\nH<sub>3</sub>O';

  assert.equal(normalizeMineruReaderMarkdown(source), source);
  assert.doesNotMatch(normalizeMineruReaderMarkdown(source), /H_\{2\}O/);
  assert.match(render(source), /H<sub>3<\/sub>O/);
});

test('an indented line inside a fenced block cannot hide later math', () => {
  const source = '```text\n\n    example\n```\n\\(x + H<sub>2</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.match(markdown, /^```text\n\n    example\n```\n/);
  assert.match(markdown, /\$x \+ H_\{2\}O\$/);
  assert.doesNotMatch(render(source), /katex-error|&lt;sub/);
});

test('indented code immediately after a closing fence stays literal', () => {
  const source = '```text\nx\n```\n    $H<sub>2</sub>O$';

  assert.equal(normalizeMineruReaderMarkdown(source), source);
  assert.match(render(source), /<pre><code>\$H&lt;sub&gt;2&lt;\/sub&gt;O\$\n<\/code><\/pre>/);
});

test('a list item with extra marker padding remains literal indented code', () => {
  const source = '-     ```\n      $H<sub>2</sub>O$\n      ```';

  assert.equal(normalizeMineruReaderMarkdown(source), source);
  assert.match(render(source), /<pre><code>```\n\$H&lt;sub&gt;2&lt;\/sub&gt;O\$\n```\n<\/code><\/pre>/);
});

test('authored inline math keeps a repeated script tag inside the math fence', () => {
  const blocks = flattenMineruPages(parseMineruMarkdownPages('$x_i<sub>2</sub>$'));
  const markdown = buildRenderableBlocks(blocks)[0]?.markdown ?? '';

  assert.equal(markdown, '$x_{i2}$');
  assert.doesNotMatch(render(markdown), /katex-error|&lt;sub/);
});

test('opposite HTML scripts remain inside synthetic math fences', () => {
  assert.equal(normalizeMineruReaderMarkdown('x_i<sup>2</sup>'), '$x_i^{2}$');
  assert.equal(normalizeMineruReaderMarkdown('x^i<sub>2</sub>'), '$x^i_{2}$');
  assert.doesNotMatch(render('x_i<sup>2</sup>'), /katex-error|&lt;sup/);
});

test('thematic breaks and headings end a block before indented code', () => {
  for (const prefix of ['---', '# Heading']) {
    const source = `${prefix}\n    $H<sub>2</sub>O$`;
    assert.equal(normalizeMineruReaderMarkdown(source), source);
    assert.match(render(source), /<pre><code>\$H&lt;sub&gt;2&lt;\/sub&gt;O\$\n<\/code><\/pre>/);
  }
});

test('multiline math spans reach their existing formula converter', () => {
  const source = '<span class="math">\nx<sup>2</sup>\n</span>';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.doesNotMatch(markdown, /<sup>/);
  assert.match(markdown, /x\^\{2\}/);
  assert.doesNotMatch(render(source), /katex-error/);
});

test('an unclosed math wrapper does not expose later raw pre content', () => {
  const source = '<span class="math">H<sub>2</sub>O\n\n<pre>\n$H<sub>3</sub>O$';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.match(markdown, /<pre>\n\$H<sub>3<\/sub>O\$$/);
});

test('raw HTML examples inside a code fence do not hide following math', () => {
  const source = '```html\n<div>\nexample\n</div>\n```\n\\(x + H<sub>3</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.match(markdown, /^```html\n<div>\nexample\n<\/div>\n```\n/);
  assert.match(markdown, /\$x \+ H_\{3\}O\$/);
});

test('an unclosed generic HTML block stops at its blockquote boundary', () => {
  const source = '> <div>\n> literal\noutside \\(x + H<sub>2</sub>O\\)';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.match(markdown, /outside \$x \+ H_\{2\}O\$/);
});

test('a quoted code fence ends before later indented literal code', () => {
  const source = '> ```text\n> literal\n\n    $H<sub>2</sub>O$';
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.match(markdown, /    \$H<sub>2<\/sub>O\$$/);
  assert.doesNotMatch(markdown, /H_\{2\}O/);
});

test('math tag bodies may contain a literal greater-than sign', () => {
  assert.equal(displayMathTagsAsLatex('x<sup>a>b</sup>'), 'x^{a>b}');
  assert.doesNotMatch(render('$$x<sup>a>b</sup>$$'), /katex-error|&lt;sup/);
});

test('math tag bodies distinguish less-than relations from nested HTML', () => {
  assert.equal(displayMathTagsAsLatex('x<sup>a<2</sup>'), 'x^{a\\lt 2}');
  assert.equal(displayMathTagsAsLatex('x<sup>a<b</sup>'), 'x^{a\\lt b}');
  assert.equal(displayMathTagsAsLatex('x<sup>a<sub>i</sub></sup>'), 'x^{a_{i}}');
  assert.equal(displayMathTagsAsLatex('x<sup>a<i>b</i></sup>'), null);
  assert.doesNotMatch(render('$$x<sup>a<2</sup>$$'), /katex-error|&lt;sup/);
});

test('repeated math scripts retain a less-than relation in the tag body', () => {
  assert.equal(displayMathTagsAsLatex('x_i<sub>a<2</sub>'), 'x_{ia\\lt 2}');
  assert.equal(displayMathTagsAsLatex('x_{i}<sub>a<2</sub>'), 'x_{ia\\lt 2}');
  assert.doesNotMatch(render('$$x_i<sub>a<2</sub>$$'), /katex-error|&lt;sub/);
});

test('an opening display fence is not mistaken for a completed inline fence', () => {
  const markdown = normalizeMineruReaderMarkdown('$$<sup>2</sup>x$$');

  assert.match(markdown, /^\$\$/);
  assert.match(markdown, /\$\$$/);
  assert.doesNotMatch(markdown, /<sup>/);
  assert.doesNotMatch(render('$$<sup>2</sup>x$$'), /katex-error|&lt;sup/);
});

test('many unclosed formula wrappers do not rescan every remaining block', () => {
  const source = '<div class="formula">\nH<sup>2</sup>\n\n'.repeat(20_000);
  const started = performance.now();
  normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
});

test('closed comments in one long blockquote do not rescan the remaining suffix', () => {
  const source = `${'> <!--keep-->\n'.repeat(14_000)}> H<sub>2</sub>O`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.equal((markdown.match(/<!--keep-->/g) ?? []).length, 14_000);
  assert.match(markdown, /H<sub>2<\/sub>O/);
});

test('unclosed HTML in separate quote blocks does not repeatedly search the suffix', () => {
  for (const opening of ['<!--', '<div>']) {
    const source = `${`> ${opening}\noutside\n`.repeat(8_000)}H<sub>2</sub>O`;
    const started = performance.now();
    const markdown = normalizeMineruReaderMarkdown(source);

    assert.ok(performance.now() - started < 2_000);
    assert.match(markdown, /H<sub>2<\/sub>O/);
  }
});

test('many inline comments on one line do not rescan the prefix', () => {
  const source = `${'x<!-- -->'.repeat(50_000)}H<sub>2</sub>O`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  // Windows CI runners can take over 2 s for 50,000 tokens even on the linear path.
  assert.ok(performance.now() - started < 5_000);
  assert.match(markdown, /H<sub>2<\/sub>O$/);
});

test('blank lines in a deeply nested list fence do not rescan every container', () => {
  const source = `${'- '.repeat(4_000)}\x60\x60\x60\n${'\n'.repeat(4_000)}H<sub>2</sub>O`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.match(markdown, /H<sub>2<\/sub>O$/);
});

test('malformed custom tags do not search every later line for a delimiter', () => {
  const source = `${'<x\n'.repeat(20_000)}<junk>\n\nH<sub>2</sub>O`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.match(markdown, /H<sub>2<\/sub>O$/);
});

test('blank raw HTML lines under nested lists do not rescan every container', () => {
  const source = `${'- '.repeat(100)}<pre>\n${'\n'.repeat(10_000)}outside\nH<sub>2</sub>O`;
  const started = performance.now();
  const markdown = normalizeMineruReaderMarkdown(source);

  assert.ok(performance.now() - started < 2_000);
  assert.match(markdown, /H<sub>2<\/sub>O$/);
});
