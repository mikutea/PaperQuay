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
