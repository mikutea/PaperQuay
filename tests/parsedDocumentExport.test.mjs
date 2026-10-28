import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const { createParsedDocumentProvenance } = require('../electron/backend/parsedDocumentProvenance.cjs');
const { createParsedDocumentExporter, inspectPdfPageCount } = require('../electron/backend/parsedDocumentExport.cjs');
const { createMineruCommands } = require('../electron/backend/mineruCommands.cjs');
const core = require('../electron/generated/desktopSyncCore.cjs');
const converter = require('../electron/generated/desktopParsedDocument.cjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fKQAAAAASUVORK5CYII=', 'base64');
function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let output = '%PDF-1.7\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(output + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
async function fixture(t, blocks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-parsed-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), dataDir = path.join(profile, 'PaperQuay'), output = path.join(dataDir, '.mineru-cache', 'run');
  fs.mkdirSync(output, { recursive: true });
  const context = { app: { getPath: () => profile }, appPaths: { dataDir, configPath: path.join(dataDir, '.settings', 'paperquay.config.json'), mineruCacheDir: path.join(dataDir, '.mineru-cache') },
    store: { load: () => ({ settings: {} }) }, authorizeLocalRead: async (file) => file, authorizeCloudParsePath: async (_library, file) => file,
    approvedWritePaths: new Set(), approvedWriteDirectories: new Set() };
  const bytes = pdf(), zip = new AdmZip();
  const raw = blocks || [
    { type: 'text', text: 'Introduction', text_level: 1, page_idx: 0 },
    { type: 'text', text: 'A paragraph with **emphasis**.', page_idx: 0 },
    { type: 'equation', text: 'E=mc^2', page_idx: 0 },
    { type: 'table', table_body: '<table><caption>Results</caption><thead><tr><th colspan="2">Head</th></tr></thead><tbody><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></tbody><tfoot><tr><td colspan="2">Foot</td></tr></tfoot></table>', page_idx: 0 },
    { type: 'image', img_path: 'images/figure.png', image_caption: ['A figure'], page_idx: 0 },
  ];
  zip.addFile('content_list.json', Buffer.from(JSON.stringify(raw)));
  zip.addFile('full.md', Buffer.from('Synthetic markdown'));
  zip.addFile('images/figure.png', PNG);
  const zipBytes = zip.toBuffer();
  for (const entry of zip.getEntries()) { const file = path.join(output, entry.entryName); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entry.getData()); }
  const extracted = { assetRootDir: output, contentJsonPath: path.join(output, 'content_list.json'), middleJsonPath: null, markdownPath: path.join(output, 'full.md') };
  const provenance = createParsedDocumentProvenance(context, { key: Buffer.alloc(32, 7) });
  context.parsedDocumentProvenance = provenance;
  const evidence = await provenance.capture({ uploadBytes: bytes, zipBytes, extracted, model: 'vlm', runId: randomUUID() });
  assert.equal(evidence.status, 'verified');
  const binding = { paperId: randomUUID(), attachmentVersionId: randomUUID(), sha256: sha(bytes), sizeBytes: bytes.length };
  const exporter = createParsedDocumentExporter(context, { core, converter });
  return { root, profile, output, context, bytes, zipBytes, extracted, provenance, binding, exporter };
}

test('real captured PDF page count and portable export preserve headings, equations, table spans and image bytes', async (t) => {
  const f = await fixture(t);
  assert.equal(await inspectPdfPageCount(f.bytes), 1);
  const prepared = await f.exporter.prepare({ binding: f.binding, bytes: f.bytes });
  const document = (await core.decodeParsedDocument(prepared.bytes)).document;
  assert.equal(document.pdf.pageCount, 1);
  assert.deepEqual(document.blocks.map((block) => block.kind), ['heading', 'text', 'equation', 'table', 'image']);
  const table = document.blocks[3].table;
  assert.equal(table.caption, 'Results');
  assert.deepEqual(table.rows.map((row) => row.section), ['head', 'body', 'body', 'foot']);
  assert.equal(table.rows[0].cells[0].colSpan, 2);
  assert.equal(table.rows[1].cells[0].rowSpan, 2);
  assert.equal(document.blocks[2].latex, 'E=mc^2');
  assert.equal(document.assets[0].sha256, sha(PNG));
  assert.deepEqual(Buffer.from(document.assets[0].base64, 'base64'), PNG);
  const text = prepared.bytes.toString();
  for (const forbidden of [f.root, 'bbox', 'apiToken', 'contentJsonPath', 'assetPath', 'tableHtml']) assert.ok(!text.includes(forbidden), forbidden);
});

test('page inspection works with only the packaged PDF module and worker, without optional canvas', async (t) => {
  const f = await fixture(t), runtime = path.join(f.root, 'packaged', 'node_modules', 'pdfjs-dist');
  fs.mkdirSync(path.join(runtime, 'legacy', 'build'), { recursive: true });
  for (const file of ['package.json', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'])
    fs.copyFileSync(require.resolve('pdfjs-dist/' + file), path.join(runtime, file));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const pdfjs = await import(process.argv[1]); const task = pdfjs.getDocument({data:new Uint8Array(Buffer.from(process.argv[2],"base64")),isEvalSupported:false,disableFontFace:true,verbosity:0}); const doc=await task.promise; console.log("INSPECT-PAGES:"+doc.numPages); await doc.destroy();',
    pathToFileURL(path.join(runtime, 'legacy', 'build', 'pdf.mjs')).href, f.bytes.toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /INSPECT-PAGES:1/);
});

test('old/manual outputs cannot acquire proof by supplementing the current PDF hash', async (t) => {
  const f = await fixture(t);
  const changed = Buffer.concat([f.bytes, Buffer.from('changed')]);
  await assert.rejects(f.exporter.prepare({ binding: { ...f.binding, sha256: sha(changed), sizeBytes: changed.length }, bytes: changed }), { code: 'DESKTOP_PARSED_REPARSE_REQUIRED' });
  await assert.rejects(f.exporter.prepare({ binding: f.binding, bytes: changed }), { code: 'DESKTOP_SOURCE_CHANGED' });
  await assert.rejects(f.exporter.prepare({ binding: f.binding, bytes: f.bytes, expectedPageCount: 2 }), { code: 'DESKTOP_PARSED_PAGE_MISMATCH' });
});

test('unavailable OS secure storage preserves existing files and never certifies the parse', async (t) => {
  const f = await fixture(t);
  const original = fs.readFileSync(f.extracted.contentJsonPath);
  const unavailable = createParsedDocumentProvenance(f.context);
  const result = await unavailable.capture({ uploadBytes: f.bytes, zipBytes: f.zipBytes, extracted: f.extracted,
    model: 'vlm', runId: randomUUID() });
  assert.deepEqual(result, { status: 'unavailable', code: 'DESKTOP_PARSED_PROVENANCE_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(f.extracted.contentJsonPath), original);
});

test('output JSON and image mutations or hard links fail closed without export', async (t) => {
  for (const file of ['content_list.json', 'images/figure.png']) {
    const f = await fixture(t); const target = path.join(f.output, file), bytes = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.from(bytes.map((byte, index) => index === bytes.length - 1 ? byte ^ 1 : byte)));
    await assert.rejects(f.exporter.prepare({ binding: f.binding, bytes: f.bytes }), { code: 'DESKTOP_PARSED_OUTPUT_CHANGED' });
  }
  const f = await fixture(t);
  fs.linkSync(path.join(f.output, 'images/figure.png'), path.join(f.root, 'image-hardlink.png'));
  await assert.rejects(f.exporter.prepare({ binding: f.binding, bytes: f.bytes }), { code: 'DESKTOP_PARSED_OUTPUT_CHANGED' });
});

test('an authenticated empty resource never disables the native read byte bound after replacement', async (t) => {
  const f = await fixture(t), empty = new AdmZip();
  for (const entry of new AdmZip(f.zipBytes).getEntries())
    empty.addFile(entry.entryName, entry.entryName === 'images/figure.png' ? Buffer.alloc(0) : entry.getData());
  const evidence = await f.provenance.capture({ uploadBytes: f.bytes, zipBytes: empty.toBuffer(), extracted: f.extracted,
    model: 'vlm', runId: randomUUID() });
  assert.equal(evidence.status, 'verified');
  let resourceAuthorization = 0;
  f.context.authorizeLocalRead = async (file) => { if (file.endsWith('figure.png')) resourceAuthorization++; return file; };
  await assert.rejects(f.exporter.prepare({ binding: f.binding, bytes: f.bytes }), { code: 'DESKTOP_PARSED_RESOURCE_INVALID' });
  assert.equal(resourceAuthorization, 0, 'Reject zero-byte evidence before authorization or native file reads');
});

test('a rewritten evidence payload cannot certify another PDF or arbitrary resource path', async (t) => {
  const f = await fixture(t);
  const manifest = path.join(f.profile, '.paperquay-parsed-provenance', f.binding.sha256 + '.json');
  const envelope = JSON.parse(fs.readFileSync(manifest));
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64'));
  payload.root = f.root;
  envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  fs.writeFileSync(manifest, JSON.stringify(envelope));
  await assert.rejects(f.exporter.prepare({ binding: f.binding, bytes: f.bytes }), { code: 'DESKTOP_PARSED_PROVENANCE_INVALID' });
});

test('image traversal, remote URLs and unsupported table content never read an external resource', async (t) => {
  for (const img_path of ['../outside.png', 'https://example.invalid/pixel.png']) {
    const f = await fixture(t, [{ type: 'image', img_path, page_idx: 0 }]);
    let outsideReads = 0;
    f.context.authorizeLocalRead = async (file) => { if (!file.startsWith(f.output + path.sep)) outsideReads++; return file; };
    await assert.rejects(f.exporter.prepare({ binding: f.binding, bytes: f.bytes }));
    assert.equal(outsideReads, 0);
  }
  assert.throws(() => converter.portableTableFromHtml('<table><tr><td><table><tr><td>Nested</td></tr></table></td></tr></table>'), { code: 'DESKTOP_PARSED_TABLE_UNSUPPORTED' });
});

test('tables refuse embedded images, exponent/subscript and other unsupported visible semantics instead of losing them', () => {
  for (const cell of ['<img src="images/formula.png" alt="x=1">', '10<sup>3</sup>', 'x<sub>i</sub>',
    '<math><mi>x</mi></math>', '<svg><text>x</text></svg>', '<input value="42">']) {
    assert.throws(() => converter.portableTableFromHtml(`<table><tr><td>${cell}</td><td>42</td></tr></table>`),
      (error) => ['DESKTOP_PARSED_TABLE_UNSUPPORTED', 'DESKTOP_PARSED_RESOURCE_INVALID'].includes(error.code));
  }
  for (const html of ['<table><tr><td>First</td></tr></table><table><tr><td>Second</td></tr></table>',
    'Visible outside text<table><tr><td>First</td></tr></table>', '<table><tr><td>First</td></tr></table><img src="https://example.org/image.png">'])
    assert.throws(() => converter.portableTableFromHtml(html), { code: 'DESKTOP_PARSED_TABLE_UNSUPPORTED' });
});

test('resource destinations are checked as Markdown and HTML syntax, including escapes, definitions and percent encoding', () => {
  for (const markdown of [
    '![private](C:/private/chart.png)', '[cache](file:///C:/private/data.txt)', '![private](C:\\\\private\\\\chart.png)',
    '[private](%43%3A%2Fprivate%2Fdata.txt)', '[private](file%3A%2F%2F%2FC%3A%2Fprivate%2Fdata.txt)',
    '![chart][asset]\n\n[asset]: file:///C:/private/chart.png', '[cache][file]\n\n[file]: ../private.txt',
    '![chart](images/chart.png)', '[private](\\\\\\\\server\\\\share\\\\private.txt)', '<file:///C:/private/data.txt>',
    '<img src="C:&#x2f;private&#x2f;chart.png">', '<a href="file:///C:/private/data.txt">cache</a>',
    '<object data="file:///C:/private/data.txt"></object>',
    '<span style="background-image:url(file:///C:/private/chart.png)">caption</span>',
    '<table background="file:///C:/private/chart.png"><tr><td>A</td></tr></table>',
    '<style>@import url(file:///C:/private/hidden.css)</style>',
    '<iframe srcdoc="&lt;img src=file:///C:/private/chart.png&gt;"></iframe>',
  ]) assert.throws(() => converter.assertPortableResourceTargets(markdown), { code: 'DESKTOP_PARSED_RESOURCE_INVALID' }, markdown);
  for (const prose of ['A path such as C:/example/data.txt is discussed in this paper.',
    '[Citation](https://doi.org/10.1000/example)', '<https://doi.org/10.1000/example>',
    '`![example](C:/example.png)` is a code sample.', '![figure][public]\n\n[public]: https://example.org/figure.png'])
    assert.doesNotThrow(() => converter.assertPortableResourceTargets(prose), prose);
});

test('converter rejects local link/image targets without deleting ordinary prose path mentions', async (t) => {
  const bad = await fixture(t, [{ type: 'text', text: 'See ![secret](C:/private/run/images/secret.png) and [cache](file:///C:/private/run/data.txt)', page_idx: 0 }]);
  await assert.rejects(bad.exporter.prepare({ binding: bad.binding, bytes: bad.bytes }), { code: 'DESKTOP_PARSED_RESOURCE_INVALID' });
  const ordinary = await fixture(t, [{ type: 'text', text: 'The paper discusses C:/example/data.txt as a textual example.', page_idx: 0 }]);
  const prepared = await ordinary.exporter.prepare({ binding: ordinary.binding, bytes: ordinary.bytes });
  assert.match(prepared.bytes.toString(), /C:\/example\/data.txt/);
});

test('native save returns only a status and rechecks after picker; cancellation leaves files untouched', async (t) => {
  const f = await fixture(t), destination = path.join(f.root, 'export.json');
  const prepared = await f.exporter.prepare({ binding: f.binding, bytes: f.bytes });
  let checks = 0;
  const exporter = createParsedDocumentExporter(f.context, { core, converter, showSaveDialog: async () => ({ canceled: false, filePath: destination }) });
  const result = await exporter.save(prepared, { fileName: 'paper.pdf', beforeWrite: async () => { checks++; } });
  assert.deepEqual(result, { status: 'exported', blockCount: 5, assetCount: 1 });
  assert.equal(checks, 1);
  assert.equal((await core.decodeParsedDocument(fs.readFileSync(destination))).document.paperId, f.binding.paperId);
  fs.unlinkSync(destination);
  await assert.rejects(exporter.save(prepared, { beforeWrite: async () => { throw Object.assign(new Error('cancel'), { code: 'DESKTOP_OPERATION_CANCELLED' }); } }), { code: 'DESKTOP_OPERATION_CANCELLED' });
  assert.ok(!fs.existsSync(destination));
  const cancelled = createParsedDocumentExporter(f.context, { showSaveDialog: async () => ({ canceled: true, filePath: destination }) });
  assert.deepEqual(await cancelled.save(prepared, {}), { status: 'cancelled' });
  assert.ok(!fs.existsSync(destination));
});

test('cloud proof records bytes actually uploaded, isolates parser runs, and unavailable secure storage preserves output', async (t) => {
  const f = await fixture(t), source = path.join(f.context.appPaths.dataDir, 'source.pdf');
  fs.writeFileSync(source, f.bytes);
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let uploaded;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('file-urls/batch')) {
      fs.writeFileSync(source, Buffer.concat([f.bytes, Buffer.from('replaced during request')]));
      return Response.json({ code: 0, data: { batch_id: 'batch', file_urls: ['https://synthetic.invalid/upload'] } });
    }
    if (options.method === 'PUT') { uploaded = Buffer.from(options.body); return new Response(null); }
    if (String(url).includes('extract-results/batch')) return Response.json({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://synthetic.invalid/output.zip' }] } });
    return new Response(f.zipBytes);
  };
  const commands = createMineruCommands(f.context);
  const result = await commands.run_mineru_cloud_parse({ options: { apiToken: 'synthetic', pdfPath: source, extractDir: f.output, pollIntervalSecs: 1 } });
  assert.deepEqual(uploaded, f.bytes);
  assert.equal(result.provenance.pdf.sha256, sha(f.bytes));
  assert.match(result.contentJsonPath, /parse-[0-9a-f-]+/);
  assert.notEqual(result.assetRootDir, f.output);
  const unavailableContext = { ...f.context, parsedDocumentProvenance: { capture: async () => ({ status: 'unavailable', code: 'DESKTOP_PARSED_PROVENANCE_UNAVAILABLE' }) } };
  const unavailable = await createMineruCommands(unavailableContext).run_mineru_cloud_parse({ options: { apiToken: 'synthetic', pdfPath: source, extractDir: f.output, pollIntervalSecs: 1 } });
  assert.equal(unavailable.provenance.status, 'unavailable');
  assert.ok(unavailable.contentJsonText);
  assert.notEqual(result.assetRootDir, unavailable.assetRootDir);
});
