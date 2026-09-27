import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRenderableBlocks,
  extractCaptionFromMineruBlock,
  extractTextFromMineruBlock,
  extractTranslatableMarkdownFromMineruBlock,
  flattenMineruPages,
  parseMineruMarkdownPages,
  parseMineruPages,
  resolveMineruAssetPath,
} from '../src/services/mineru.ts';

function block(type: string, content: unknown) {
  return flattenMineruPages(parseMineruPages([[{ type, content, bbox: [10, 20, 300, 220] }]]))[0];
}

test('MinerU chart retains its asset and caption without translating its image path', () => {
  const chart = block('chart', {
    image_source: { path: 'images/chart.jpg' },
    chart_caption: [{ type: 'text', content: 'Figure 1. Trend.' }],
  });
  const [renderable] = buildRenderableBlocks([chart], 'C:/cache/content_list_v2.json');

  assert.equal(chart.type, 'image');
  assert.match(renderable.assetPath?.replaceAll('\\', '/') ?? '', /images\/chart\.jpg$/);
  assert.equal(renderable.captionText, 'Figure 1. Trend.');
  assert.match(extractTranslatableMarkdownFromMineruBlock(chart), /Figure 1\. Trend\./);
  assert.doesNotMatch(extractTranslatableMarkdownFromMineruBlock(chart), /images\//);
});

test('MinerU visual assets stay under their local extraction directory', () => {
  const source = 'C:/cache/content_list_v2.json';
  assert.match(resolveMineruAssetPath(source, 'images/chart.jpg')?.replaceAll('\\', '/') ?? '', /C:\/cache\/images\/chart\.jpg$/);
  assert.equal(resolveMineruAssetPath(source, 'https://example.com/chart.jpg'), undefined);
  assert.equal(resolveMineruAssetPath(source, 'file:///C:/private/chart.jpg'), undefined);
  assert.equal(resolveMineruAssetPath(source, '../private/chart.jpg'), undefined);
  assert.equal(resolveMineruAssetPath(source, 'C:/private/chart.jpg'), undefined);
  assert.equal(resolveMineruAssetPath(source, 'C:/cache/images/chart.jpg'), 'C:/cache/images/chart.jpg');
});

test('captionless visual block has no false translation unit', () => {
  const image = block('image', { image_source: { path: 'images/plain.jpg' }, image_caption: [] });
  const [renderable] = buildRenderableBlocks([image], 'C:/cache/content_list_v2.json');

  assert.equal(renderable.captionText, '');
  assert.equal(renderable.markdown, '');
  assert.equal(extractTranslatableMarkdownFromMineruBlock(image), '');
  assert.ok(renderable.assetPath);
});

test('empty table caption does not display HTML as a caption or translation', () => {
  const table = block('table', {
    table_caption: [],
    html: '<table><tr><td>MTOW</td></tr></table>',
    image_source: { path: 'images/table.jpg' },
  });
  const [renderable] = buildRenderableBlocks([table]);

  assert.equal(extractCaptionFromMineruBlock(table), '');
  assert.equal(renderable.captionText, '');
  assert.equal(renderable.tableHtml, '<table><tr><td>MTOW</td></tr></table>');
  assert.doesNotMatch(renderable.markdown, /<table|images\//);
  assert.doesNotMatch(extractTranslatableMarkdownFromMineruBlock(table), /<table|images\//);
});

test('real table caption and image OCR text remain translatable', () => {
  const table = block('table', {
    table_caption: [{ type: 'text', content: 'Table 1. Results.' }],
    html: '<table><tr><td>Score</td></tr></table>',
  });
  const image = block('image', {
    image_source: { path: 'images/ocr.jpg' },
    content: 'OCR text inside figure',
    image_caption: [],
  });

  assert.equal(extractCaptionFromMineruBlock(table), 'Table 1. Results.');
  assert.match(extractTranslatableMarkdownFromMineruBlock(table), /Table 1\. Results\./);
  assert.doesNotMatch(extractTranslatableMarkdownFromMineruBlock(table), /<table/);
  assert.match(extractTranslatableMarkdownFromMineruBlock(image), /OCR text inside figure/);
  assert.doesNotMatch(extractTranslatableMarkdownFromMineruBlock(image), /images\//);
});

test('table cells remain source and translation text when a generic caption exists', () => {
  for (const [captionKey, bodyKey] of [
    ['caption', 'table_body'],
    ['caption_content', 'html'],
  ] as const) {
    const [table] = flattenMineruPages(parseMineruPages([{
      type: 'table', page_idx: 0, [captionKey]: 'Table 1. Results',
      [bodyKey]: '<table><tr><td>Score</td><td>42</td></tr></table>',
    }]));
    const source = extractTextFromMineruBlock(table);
    const translation = extractTranslatableMarkdownFromMineruBlock(table);

    for (const value of [source, translation]) {
      assert.match(value, /Table 1\. Results/);
      assert.match(value, /Score 42/);
      assert.doesNotMatch(value, /<table/);
    }
  }
});

test('captioned non-HTML table keeps OCR cells in summary and RAG source text', () => {
  const [table] = flattenMineruPages(parseMineruPages([{
    type: 'table', page_idx: 0, caption: 'Table 1', content: 'OCR cells',
  }]));

  assert.match(extractTextFromMineruBlock(table), /Table 1 OCR cells/);
  assert.match(extractTranslatableMarkdownFromMineruBlock(table), /OCR cells/);
});

test('HTML table keeps distinct generic OCR content in source text', () => {
  const [table] = flattenMineruPages(parseMineruPages([{
    type: 'table', page_idx: 0,
    html: '<table><tr><td>Score</td></tr></table>',
    content: 'Confidence: high',
  }]));

  assert.match(extractTextFromMineruBlock(table), /Score Confidence: high/);
  assert.match(extractTranslatableMarkdownFromMineruBlock(table), /Confidence: high/);
});

test('blank generic table content falls through to OCR text and value aliases', () => {
  for (const [key, value] of [['text', 'OCR text cells'], ['value', 'OCR value cells']] as const) {
    const table = block('table', { content: '', [key]: value });
    assert.equal(extractTextFromMineruBlock(table), value);
    assert.match(extractTranslatableMarkdownFromMineruBlock(table), new RegExp(value));
  }
});

test('standalone visual note retains content even alongside metadata', () => {
  const [note] = flattenMineruPages(parseMineruPages([{
    type: 'chart_footnote', page_idx: 0, sub_type: 'chart', content: 'Source note',
  }]));

  assert.equal(note.type, 'caption');
  assert.equal(extractTextFromMineruBlock(note), 'Source note');
  assert.match(buildRenderableBlocks([note])[0].markdown, /Source note/);
  assert.doesNotMatch(buildRenderableBlocks([note])[0].markdown, /未提取到/);
});

test('generic structured table caption retains inline math for HTML-table Reader', () => {
  const [table] = flattenMineruPages(parseMineruPages([{
    type: 'table', page_idx: 0,
    caption_content: [
      { type: 'text', content: 'Energy *literal*: ' },
      { type: 'equation_inline', content: 'E=mc^2' },
    ],
    html: '<table><tr><td>Cells</td></tr></table>',
  }]));
  const [renderable] = buildRenderableBlocks([table]);

  assert.equal(renderable.captionText, 'Energy *literal*: E=mc^2');
  assert.match(renderable.captionMathMarkdown ?? '', /Energy \\\*literal\\\*: \$E=mc\^2\$/);
  assert.match(renderable.tableHtml ?? '', /Cells/);
});

test('matching generic and typed visual caption aliases appear only once', () => {
  const [image, table] = flattenMineruPages(parseMineruPages([
    { type: 'image', page_idx: 0, image_caption: 'Figure 1', caption: 'Figure 1' },
    { type: 'table', page_idx: 0, table_caption: 'Table 1', caption_content: 'Table 1' },
  ]));

  for (const [visual, caption] of [[image, 'Figure 1'], [table, 'Table 1']] as const) {
    assert.equal(extractCaptionFromMineruBlock(visual), caption);
    assert.equal(extractTextFromMineruBlock(visual), caption);
    assert.equal(extractTranslatableMarkdownFromMineruBlock(visual),
      `${visual.type === 'image' ? '**图片说明**' : '**表格说明**'} ${caption}`);
    assert.equal(buildRenderableBlocks([visual])[0].captionText, caption);
  }
});

test('blank visual asset and table HTML aliases fall through to valid alternatives', () => {
  const [image, table] = flattenMineruPages(parseMineruPages([
    { type: 'image', page_idx: 0, image_source: { path: '' }, img_path: 'images/usable.jpg' },
    { type: 'table', page_idx: 0, html: '', table_body: '<table><tr><td>Cells</td></tr></table>' },
  ]));

  assert.match(buildRenderableBlocks([image], 'C:/cache/content_list.json')[0].assetPath ?? '', /usable\.jpg$/);
  assert.match(buildRenderableBlocks([table])[0].tableHtml ?? '', /Cells/);
  assert.match(extractTextFromMineruBlock(table), /Cells/);
  assert.match(extractTranslatableMarkdownFromMineruBlock(table), /Cells/);
});

test('flat content-list chart uses the image rendering path', () => {
  const [chart] = flattenMineruPages(parseMineruPages([{
    type: 'chart', page_idx: 0, img_path: 'images/flat-chart.jpg',
    chart_caption: 'Figure 2. Overview.', bbox: [10, 20, 300, 220],
  }]));
  const [renderable] = buildRenderableBlocks([chart], 'C:/cache/content_list_v2.json');

  assert.equal(chart.type, 'image');
  assert.equal(renderable.captionText, 'Figure 2. Overview.');
  assert.match(renderable.assetPath?.replaceAll('\\', '/') ?? '', /images\/flat-chart\.jpg$/);
});

test('flat chart preserves generic OCR content alongside its caption', () => {
  const [chart] = flattenMineruPages(parseMineruPages([{
    type: 'chart', page_idx: 0, chart_caption: 'Chart 1', content: 'OCR labels',
  }]));

  assert.equal(chart.type, 'image');
  assert.match(extractTextFromMineruBlock(chart), /Chart 1/);
  assert.match(extractTextFromMineruBlock(chart), /OCR labels/);
  assert.match(extractTranslatableMarkdownFromMineruBlock(chart), /OCR labels/);
});

test('flat chart retains OCR value alongside its caption', () => {
  const [chart] = flattenMineruPages(parseMineruPages([{
    type: 'chart', page_idx: 0, chart_caption: 'Chart 1', value: 'OCR labels',
  }]));
  for (const value of [extractTextFromMineruBlock(chart), extractTranslatableMarkdownFromMineruBlock(chart)]) {
    assert.match(value, /Chart 1/);
    assert.match(value, /OCR labels/);
  }
});

test('visual value OCR is retained when a caption is also present', () => {
  const chart = block('chart', { chart_caption: 'Chart 1', value: 'OCR labels' });

  assert.match(extractTextFromMineruBlock(chart), /Chart 1/);
  assert.match(extractTextFromMineruBlock(chart), /OCR labels/);
});

test('flat figure retains its own caption and footnote fields', () => {
  const [figure] = flattenMineruPages(parseMineruPages([{
    type: 'figure', page_idx: 0, img_path: 'images/figure.jpg',
    figure_caption: 'Figure 1', figure_footnote: 'Source note',
  }]));

  assert.equal(figure.type, 'image');
  assert.match(extractTextFromMineruBlock(figure), /Figure 1/);
  assert.match(extractTextFromMineruBlock(figure), /Source note/);
  assert.match(buildRenderableBlocks([figure], 'C:/cache/content_list.json')[0].assetPath ?? '', /figure\.jpg$/);
});

test('flat visual blocks retain supported asset aliases and generic captions', () => {
  for (const [assetField, assetValue] of [
    ['image_path', 'images/image-path.jpg'],
    ['path', 'images/path.jpg'],
    ['image_source', { path: 'images/image-source.jpg' }],
  ] as const) {
    const [chart] = flattenMineruPages(parseMineruPages([{
      type: 'chart', page_idx: 0, caption_content: 'Generic chart caption',
      [assetField]: assetValue,
    }]));
    const [renderable] = buildRenderableBlocks([chart], 'C:/cache/content_list.json');

    assert.match(renderable.assetPath?.replaceAll('\\', '/') ?? '', /images\/.*\.jpg$/);
    assert.equal(renderable.captionText, 'Generic chart caption');
    assert.match(extractTranslatableMarkdownFromMineruBlock(chart), /Generic chart caption/);
  }

  const [table] = flattenMineruPages(parseMineruPages([{
    type: 'table', page_idx: 0, caption: 'Generic table caption',
  }]));
  assert.equal(buildRenderableBlocks([table])[0].captionText, 'Generic table caption');
});

test('flat text does not duplicate generic content already in its canonical text field', () => {
  const [paragraph] = flattenMineruPages(parseMineruPages([{
    type: 'text', page_idx: 0, text: 'Hello', content: 'Hello',
  }]));

  assert.equal(extractTextFromMineruBlock(paragraph), 'Hello');
});

test('non-HTML table OCR remains extracted plain text', () => {
  const nested = block('table', 'OCR cells');
  const [flat] = flattenMineruPages(parseMineruPages([{
    type: 'table', page_idx: 0, table_caption: [], content: 'Flat OCR cells',
  }]));

  assert.equal(extractTextFromMineruBlock(nested), 'OCR cells');
  assert.equal(extractTextFromMineruBlock(flat), 'Flat OCR cells');
});

test('non-HTML table OCR retains distinct content text and value fields', () => {
  const table = block('table', { content: 'OCR cells', text: 'Row labels', value: 'Confidence high' });
  const source = extractTextFromMineruBlock(table);
  for (const part of ['OCR cells', 'Row labels', 'Confidence high']) {
    assert.match(source, new RegExp(part));
  }
});

test('standalone chart and figure notes stay textual blocks', () => {
  const nested = block('figure_caption', 'Figure 1. Results');
  const [flat] = flattenMineruPages(parseMineruPages([{
    type: 'chart_footnote', page_idx: 0, content: 'Source: survey',
  }]));

  assert.equal(nested.type, 'caption');
  assert.equal(flat.type, 'caption');
  assert.match(buildRenderableBlocks([nested])[0].markdown, /Figure 1\. Results/);
  assert.match(buildRenderableBlocks([flat])[0].markdown, /Source: survey/);
});

test('standalone visual-note arrays keep readable separators in Reader and translation', () => {
  const [caption] = flattenMineruPages(parseMineruPages([{
    type: 'chart_caption', page_idx: 0, chart_caption: ['Figure 1', 'Overview'],
  }]));
  const [footnote] = flattenMineruPages(parseMineruPages([{
    type: 'image_footnote', page_idx: 0, image_footnote: ['Source A', 'Source B'],
  }]));

  assert.equal(buildRenderableBlocks([caption])[0].markdown, '> Figure 1 Overview');
  assert.equal(extractTranslatableMarkdownFromMineruBlock(caption), '> Figure 1 Overview');
  assert.equal(buildRenderableBlocks([footnote])[0].markdown, '> Source A Source B');
});

test('structured visual captions retain inline math in source text', () => {
  const chart = block('chart', {
    chart_caption: [
      { type: 'text', content: 'Growth (' },
      { type: 'equation_inline', content: 'x' },
      { type: 'text', content: ').' },
    ],
  });
  assert.equal(extractTextFromMineruBlock(chart), 'Growth ($x$).');
  assert.match(extractTranslatableMarkdownFromMineruBlock(chart), /Growth \(\$x\$\)\./);

  const [standalone] = flattenMineruPages(parseMineruPages([{
    type: 'chart_caption', page_idx: 0,
    chart_caption: [
      { type: 'text', content: 'Growth (' },
      { type: 'equation_inline', content: 'x' },
      { type: 'text', content: ').' },
    ],
  }]));
  assert.equal(extractTextFromMineruBlock(standalone), 'Growth ($x$).');
});

test('visual translation retains caption, footnote, and OCR text together', () => {
  const chart = block('chart', {
    chart_caption: 'Chart 1', chart_footnote: 'Source note',
    content: 'OCR labels', image_source: { path: 'images/chart.jpg' },
  });
  const translation = extractTranslatableMarkdownFromMineruBlock(chart);

  assert.match(translation, /Chart 1/);
  assert.match(translation, /Source note/);
  assert.match(translation, /OCR labels/);
  assert.doesNotMatch(translation, /images\//);
});

test('blank visual preferred fields do not hide generic OCR fallback text', () => {
  const image = block('chart', {
    chart_caption: '', caption_content: '', content: '', text: '', value: 'OCR labels',
  });

  assert.equal(extractTextFromMineruBlock(image), 'OCR labels');
});

test('generic caption_content remains a visible caption', () => {
  for (const type of ['image', 'table']) {
    const visual = block(type, { caption_content: [{ type: 'text', content: 'Generic caption' }] });
    assert.equal(extractCaptionFromMineruBlock(visual), 'Generic caption');
  }
});

test('flat table_body remains renderable HTML but never raw translation markup', () => {
  const [table] = flattenMineruPages(parseMineruPages([{
    type: 'table', page_idx: 0, table_caption: [],
    table_body: '<table><tr><td>Score</td></tr></table>',
  }]));
  const [renderable] = buildRenderableBlocks([table]);

  assert.equal(renderable.captionText, '');
  assert.match(renderable.tableHtml ?? '', /<table>/);
  assert.match(extractTranslatableMarkdownFromMineruBlock(table), /Score/);
  assert.doesNotMatch(extractTranslatableMarkdownFromMineruBlock(table), /<table>/);
});

test('image caption math remains delimited while retaining a footnote', () => {
  const image = block('image', {
    image_caption: [{ type: 'equation_inline', content: 'E=mc^2' }],
    image_footnote: 'Measured at room temperature',
    image_source: { path: 'images/math.jpg' },
  });
  const translation = extractTranslatableMarkdownFromMineruBlock(image);

  assert.match(translation, /\$E=mc\^2\$/);
  assert.match(translation, /Measured at room temperature/);
  assert.doesNotMatch(translation, /images\//);
});

test('captionless flat table retains body cells and a source footnote', () => {
  const [table] = flattenMineruPages(parseMineruPages([{
    type: 'table', page_idx: 0, table_caption: [],
    table_footnote: 'Source: field survey',
    table_body: '<table><tr><td>Score</td><td>42</td></tr></table>',
  }]));
  const translation = extractTranslatableMarkdownFromMineruBlock(table);

  assert.match(translation, /Source: field survey/);
  assert.match(translation, /Score 42/);
  assert.doesNotMatch(translation, /<table>/);
  const [renderable] = buildRenderableBlocks([table]);
  assert.equal(renderable.tableFootnoteText, 'Source: field survey');
  assert.match(extractTextFromMineruBlock(table), /Source: field survey/);
});

test('footnote-only table remains a plain-text source for summary and RAG', () => {
  const table = block('table', { table_caption: [], table_footnote: 'Source: field survey' });

  assert.equal(extractTextFromMineruBlock(table), 'Source: field survey');
});

test('multiple table footnotes remain separated in Reader, translation, and source text', () => {
  const table = block('table', {
    table_caption: [], table_footnote: ['Source A', 'Source B'],
    html: '<table><tr><td>Score</td></tr></table>',
  });
  const [renderable] = buildRenderableBlocks([table]);

  assert.equal(renderable.tableFootnoteText, 'Source A Source B');
  assert.match(extractTextFromMineruBlock(table), /Source A Source B/);
  assert.match(extractTranslatableMarkdownFromMineruBlock(table), /Source A Source B/);
});

test('inline structured table footnote keeps punctuation adjacent to its formula', () => {
  const table = block('table', {
    table_footnote: [
      { type: 'text', content: 'Source (' },
      { type: 'equation_inline', content: 'x' },
      { type: 'text', content: ').' },
    ],
  });
  const [renderable] = buildRenderableBlocks([table]);

  assert.equal(renderable.tableFootnoteText, 'Source ($x$).');
  assert.match(extractTranslatableMarkdownFromMineruBlock(table), /Source \(\$x\$\)\./);
});

test('structured chart footnote keeps inline math in source and translation', () => {
  const chart = block('image', {
    chart_caption: 'Chart 1',
    chart_footnote: [
      { type: 'text', content: 'Source (' },
      { type: 'equation_inline', content: 'x' },
      { type: 'text', content: ').' },
    ],
  });

  assert.match(extractTextFromMineruBlock(chart), /Source \(\$x\$\)\./);
  assert.match(extractTranslatableMarkdownFromMineruBlock(chart), /Source \(\$x\$\)\./);
});

test('multiple image footnotes remain separated in Reader and translation', () => {
  const image = block('image', {
    image_caption: 'Figure 1', image_footnote: ['Source A', 'Source B'],
  });
  const [renderable] = buildRenderableBlocks([image]);

  assert.match(renderable.markdown, /Source A Source B/);
  assert.match(extractTranslatableMarkdownFromMineruBlock(image), /Source A Source B/);
});

test('multiple root chart captions stay separated without splitting inline nodes', () => {
  const listCaption = block('chart', { chart_caption: ['Figure 1', 'Overview'] });
  const inlineCaption = block('chart', {
    chart_caption: [{ type: 'text', content: 'Figure' }, { type: 'text', content: ' 1' }],
  });

  assert.match(buildRenderableBlocks([listCaption])[0].markdown, /Figure 1 Overview/);
  assert.match(buildRenderableBlocks([inlineCaption])[0].markdown, /Figure 1/);
});

test('multiple generic caption entries stay separated in visual Markdown', () => {
  for (const key of ['caption', 'caption_content']) {
    const chart = block('chart', { [key]: ['Figure 1', 'Overview'] });
    assert.match(buildRenderableBlocks([chart])[0].markdown, /Figure 1 Overview/);
    assert.match(extractTranslatableMarkdownFromMineruBlock(chart), /Figure 1 Overview/);
  }
});

test('middle JSON chart retains its asset path without translating that path', () => {
  const [chart, caption] = flattenMineruPages(parseMineruPages({ pdf_info: [{
    page_idx: 0, page_size: [600, 800], para_blocks: [
      { type: 'chart', lines: [{ spans: [{ img_path: 'images/middle-chart.jpg' }] }] },
      { type: 'image_caption', lines: [{ spans: [{ content: 'Figure 1. Results' }] }] },
    ],
  }] }));

  assert.equal(chart.type, 'image');
  assert.equal(caption.type, 'caption');
  assert.match(buildRenderableBlocks([chart], 'C:/cache/middle.json')[0].assetPath ?? '', /middle-chart\.jpg$/);
  assert.doesNotMatch(extractTranslatableMarkdownFromMineruBlock(chart), /middle-chart\.jpg/);
  assert.match(buildRenderableBlocks([caption])[0].markdown, /Figure 1\. Results/);
  assert.equal(buildRenderableBlocks([chart])[0].markdown, '');
});

test('middle JSON chart accepts image_path alias as a visual asset', () => {
  const [chart] = flattenMineruPages(parseMineruPages({ pdf_info: [{
    page_idx: 0, para_blocks: [{
      type: 'chart', lines: [{ spans: [{ image_path: 'images/alias-chart.jpg' }] }],
    }],
  }] }));

  assert.match(buildRenderableBlocks([chart], 'C:/cache/middle.json')[0].assetPath ?? '', /alias-chart\.jpg$/);
  assert.doesNotMatch(extractTranslatableMarkdownFromMineruBlock(chart), /alias-chart\.jpg/);
});

test('middle JSON visual blocks retain path and image_source aliases at root or span', () => {
  for (const [field, value] of [
    ['path', 'images/path-chart.jpg'],
    ['image_source', { path: 'images/source-chart.jpg' }],
  ] as const) {
    for (const location of ['root', 'span'] as const) {
      const source = location === 'root'
        ? { type: 'chart', [field]: value }
        : { type: 'chart', lines: [{ spans: [{ [field]: value }] }] };
      const [chart] = flattenMineruPages(parseMineruPages({ pdf_info: [{
        page_idx: 0, para_blocks: [source],
      }] }));
      const path = typeof value === 'string' ? value : value.path;

      assert.equal(buildRenderableBlocks([chart], 'C:/cache/middle.json')[0].assetPath
        ?.replaceAll('\\', '/'), `C:/cache/${path}`);
      assert.doesNotMatch(extractTranslatableMarkdownFromMineruBlock(chart), /images\//);
    }
  }
});

test('Markdown image fallback translates only the parsed caption, never image markup', () => {
  const [image] = flattenMineruPages(parseMineruMarkdownPages('![Figure 1](chart.png)'));
  const translation = extractTranslatableMarkdownFromMineruBlock(image);
  assert.match(translation, /Figure 1/);
  assert.doesNotMatch(translation, /!\[|chart\.png/);
});

test('Markdown image fallback retains surrounding prose and multiple alt labels', () => {
  const [image] = flattenMineruPages(parseMineruMarkdownPages(
    'See ![Trend](trend.png) and ![Map](map.png) for results.',
  ));
  const expected = '**图片说明** See Trend and Map for results.';
  assert.equal(buildRenderableBlocks([image])[0].markdown, expected);
  assert.equal(extractTranslatableMarkdownFromMineruBlock(image), expected);
});

test('Markdown image destinations with balanced parentheses do not leak into prose', () => {
  const [image] = flattenMineruPages(parseMineruMarkdownPages(
    'See ![Trend](chart(2025).png) for results.',
  ));
  const expected = '**图片说明** See Trend for results.';
  assert.equal(buildRenderableBlocks([image])[0].markdown, expected);
  assert.equal(extractTranslatableMarkdownFromMineruBlock(image), expected);
});

test('flat paragraph text takes priority over a visual-only value alias', () => {
  const [paragraph] = flattenMineruPages(parseMineruPages([{
    type: 'text', page_idx: 0, text: 'Canonical paragraph', value: 'alternate',
  }]));
  assert.equal(buildRenderableBlocks([paragraph])[0].markdown, 'Canonical paragraph');
  assert.equal(extractTextFromMineruBlock(paragraph), 'Canonical paragraph');
});

test('captionless Markdown image fallback does not create a translation unit', () => {
  const [image] = flattenMineruPages(parseMineruMarkdownPages('![](chart.png)'));
  assert.equal(extractTranslatableMarkdownFromMineruBlock(image), '');
  assert.equal(buildRenderableBlocks([image])[0].markdown, '');
});

test('typed visual roots retain caption, footnote, and OCR fields', () => {
  const image = block('image', {
    type: 'image', image_caption: 'Caption', image_footnote: 'Footnote', content: 'OCR',
  });
  const translation = extractTranslatableMarkdownFromMineruBlock(image);
  for (const part of ['Caption', 'Footnote', 'OCR']) assert.match(translation, new RegExp(part));
});

test('structured table footnotes keep inline math for the HTML-table reader', () => {
  const table = block('table', {
    table_caption: [], table_footnote: [{ type: 'equation_inline', content: 'E=mc^2' }],
    html: '<table><tr><td>Mass</td></tr></table>',
  });
  const [renderable] = buildRenderableBlocks([table]);
  assert.equal(renderable.tableFootnoteText, '$E=mc^2$');
});

test('pipe-table Markdown fallback remains summary and RAG source text without a caption', () => {
  const [table] = flattenMineruPages(parseMineruMarkdownPages('| Label | Score |\n| --- | --- |\n| A | 42 |'));
  const [renderable] = buildRenderableBlocks([table]);
  assert.equal(table.type, 'table');
  assert.equal(renderable.captionText, '');
  assert.match(renderable.plainText, /A \| 42/);
});

test('visual sub-type metadata never enters display or translation', () => {
  const [chart] = flattenMineruPages(parseMineruPages([{
    type: 'chart', page_idx: 0, chart_caption: 'Figure 1', sub_type: 'chart',
  }]));
  assert.equal(extractTranslatableMarkdownFromMineruBlock(chart), '**图片说明** Figure 1');
});

test('HTML-table Markdown fallback strips markup and does not duplicate cell text', () => {
  const [table] = flattenMineruPages(parseMineruMarkdownPages('<table><tr><td>Score</td></tr></table>'));
  const translation = extractTranslatableMarkdownFromMineruBlock(table);
  assert.equal(table.type, 'table');
  assert.equal(translation, '**表格说明** Score');
});

test('HTML table OCR identical to its cells is not duplicated in translation', () => {
  const table = block('table', {
    html: '<table><tr><td>Score</td></tr></table>', content: 'Score',
  });
  assert.equal(extractTranslatableMarkdownFromMineruBlock(table), '**表格说明** Score');
});
