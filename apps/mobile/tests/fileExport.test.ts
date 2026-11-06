const exportScope={apiBaseUrl:'https://sync.example.test',accountId:'11111111-1111-4111-8111-111111111111'};
const exportRoot='paperquay-exports/'+createHash('sha256').update(JSON.stringify([exportScope.apiBaseUrl,exportScope.accountId])).digest('hex');
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportFilename, exportTextFile, FileExportError, type ExportRuntime } from '../src/platform/exportFile.ts';

const file = { name: '我的笔记.md', text: '# 研究记录\n\n正文与 $x^2$。', mime: 'text/markdown' as const };
function fixture(overrides: Partial<ExportRuntime> = {}) {
  const calls: { action: string; value?: unknown }[] = [];
  const platform: ExportRuntime = {
    native: true, available: () => true, canShare: async () => true,
    write: async (path, text) => { calls.push({ action: 'write', value: { path, text } }); return `file:///cache/${path}`; },
    share: async (uri) => { calls.push({ action: 'share', value: uri }); },
    remove: async (path) => { calls.push({ action: 'remove', value: path }); },
    download: (value) => { calls.push({ action: 'download', value }); },
    id: () => 'unique-export', ...overrides,
  };
  return { platform, calls };
}

test('web export hands the exact Markdown to a file download', async () => {
  const { platform, calls } = fixture({ native: false });
  assert.equal(await exportTextFile(file, () => true, platform,exportScope), 'download');
  assert.deepEqual(calls, [{ action: 'download', value: file }]);
});
test('native export shares only its generated cache URI and retains the receiver input', async () => {
  const { platform, calls } = fixture();
  assert.equal(await exportTextFile(file, () => true, platform,exportScope), 'share');
  assert.deepEqual(calls, [
    { action: 'write', value: { path: exportRoot+'/unique-export/我的笔记.md', text: file.text } },
    { action: 'share', value: 'file:///cache/'+exportRoot+'/unique-export/我的笔记.md' },
  ]);
});
test('native bibliography exports retain their format extension and exact UTF-8 text', async () => {
  for (const [extension, mime, text] of [
    ['bib', 'application/x-bibtex', '@misc{p1, title = {居游共生}}\n'],
    ['ris', 'application/x-research-info-systems', 'TY  - GEN\r\nTI  - 居游共生\r\nER  - \r\n'],
  ] as const) {
    const { platform, calls } = fixture();
    assert.equal(await exportTextFile({ name: `研究文库.${extension}`, text, mime }, () => true, platform,exportScope), 'share');
    assert.deepEqual(calls[0], { action: 'write', value: {
      path: `${exportRoot}/unique-export/研究文库.${extension}`, text,
    } });
    assert.equal(calls[1].value, `file:///cache/${exportRoot}/unique-export/研究文库.${extension}`);
  }
});
test('account change while preparing a native file deletes it without opening Share', async () => {
  let current = true;
  const { platform, calls } = fixture();
  const write = platform.write;
  platform.write = async (...args) => { const uri = await write(...args); current = false; return uri; };
  await assert.rejects(exportTextFile(file, () => current, platform,exportScope), (error: unknown) =>
    error instanceof FileExportError && error.code === 'CHANGED');
  assert.deepEqual(calls.map((call) => call.action), ['write', 'remove']);
});
test('unavailable sharing or a stale account creates no export file', async () => {
  for (const overrides of [{ available: () => false }, { canShare: async () => false }]) {
    const { platform, calls } = fixture(overrides);
    await assert.rejects(exportTextFile(file, () => true, platform,exportScope), FileExportError);
    assert.deepEqual(calls, []);
  }
  const { platform, calls } = fixture();
  await assert.rejects(exportTextFile(file, () => false, platform,exportScope), FileExportError);
  assert.deepEqual(calls, []);
});
test('native preparation failures expose no plugin error or private content', async () => {
  const { platform, calls } = fixture({ write: async () => { throw new Error(file.text); } });
  await assert.rejects(exportTextFile(file, () => true, platform,exportScope), (error: unknown) =>
    error instanceof FileExportError && error.message === 'FAILED');
  assert.equal(calls.some((call) => call.action === 'share'), false);
});
test('export names cannot become paths or Windows device names', () => {
  const escaped = exportFilename('../../note\\private:*', 'md');
  assert.equal(/[\\/:*]/.test(escaped), false);
  assert.equal(escaped.endsWith('.md'), true);
  assert.equal(exportFilename('CON', 'json'), 'PaperQuay-CON.json');
  assert.equal(exportFilename('  ... ', 'md'), 'PaperQuay.md');
});
