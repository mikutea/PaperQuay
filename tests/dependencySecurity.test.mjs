import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mergeAttributes } from '@tiptap/core';
import AdmZip from 'adm-zip';
import backendUtils from '../electron/backend/utils.cjs';

test('Tiptap attribute merging does not inherit JSON-supplied properties', () => {
  const input = JSON.parse('{"__proto__":{"data-inherited-canary":"unsafe"}}');
  const merged = mergeAttributes(input);

  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal('data-inherited-canary' in merged, false);

  const ordinary = mergeAttributes({ class: 'first' }, { class: 'second' });
  assert.equal(ordinary.class, 'first second');
});

test('MinerU ZIP extraction still accepts ordinary result files', async () => {
  const extractDir = await mkdtemp(path.join(os.tmpdir(), 'paperquay-mineru-zip-test-'));
  const zip = new AdmZip();
  zip.addFile('content_list_v2.json', Buffer.from('[]'));
  zip.addFile('full.md', Buffer.from('# Example'));
  zip.addFile('images/figure.png', Buffer.from([1, 2, 3]));

  try {
    const result = await backendUtils.readZipWithAdm(zip.toBuffer(), extractDir);
    assert.equal(result.contentJsonText, '[]');
    assert.equal(result.markdownText, '# Example');
    assert.deepEqual(
      await readFile(path.join(extractDir, 'images', 'figure.png')),
      Buffer.from([1, 2, 3]),
    );
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
});

test('MinerU ZIP extraction refuses a pre-existing linked directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paperquay-mineru-link-test-'));
  const extractDir = path.join(root, 'extract');
  const outsideDir = path.join(root, 'outside');
  const zip = new AdmZip();
  zip.addFile('images/canary.txt', Buffer.from('should not escape'));

  try {
    await mkdir(extractDir);
    await mkdir(outsideDir);
    await symlink(outsideDir, path.join(extractDir, 'images'), process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      backendUtils.readZipWithAdm(zip.toBuffer(), extractDir),
      /Illegal MinerU zip entry path/,
    );
    await assert.rejects(readFile(path.join(outsideDir, 'canary.txt')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
