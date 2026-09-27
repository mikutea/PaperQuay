import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRenderableBlocks,
  extractCaptionFromMineruBlock,
  extractTranslatableMarkdownFromMineruBlock,
  flattenMineruPages,
  parseMineruPages,
} from '../src/services/mineru.ts';

function block(type: string, content: Record<string, unknown>) {
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
});
