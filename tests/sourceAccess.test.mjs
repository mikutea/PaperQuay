import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createSourceAccess } = require('../electron/backend/sourceAccess.cjs');
const native = require('../electron/backend/nativeFs.cjs');
const { createZoteroCommands } = require('../electron/backend/zoteroCommands.cjs');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-source-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zotero = path.join(root, 'zotero'); fs.mkdirSync(zotero);
  const privateDir = path.join(root, 'private'); fs.mkdirSync(privateDir);
  const pdf = path.join(privateDir, 'secret.pdf'); fs.writeFileSync(pdf, 'private fixture');
  return { root, zotero, privateDir, pdf };
}

test('supplier-listed sources require approval before even inspecting UNC or local paths', async (t) => {
  const f = fixture(t), original = native.inspectSync;
  let probes = 0, prompts = 0;
  native.inspectSync = () => { probes++; throw new Error('unexpected probe'); };
  t.after(() => { native.inspectSync = original; });
  const access = createSourceAccess({ showMessageBox: async () => { prompts++; return { response: 0 }; } });
  const network = process.platform === 'win32' ? '\\\\supplier.invalid\\share\\secret.pdf' : '/supplier/secret.pdf';
  await assert.rejects(access.authorize([f.pdf, network], { mode: 'move' }), /canceled/);
  assert.equal(probes, 0); assert.equal(prompts, 1);
});

test('native-picked PDFs and selected Zotero storage remain usable without extra prompts', async (t) => {
  const f = fixture(t);
  const access = createSourceAccess({ showMessageBox: () => { throw new Error('unexpected prompt'); } });
  access.rememberPicked([f.pdf]); access.rememberZoteroRoot(f.zotero);
  const stored = path.join(f.zotero, 'storage', 'KEY', 'paper.pdf');
  fs.mkdirSync(path.dirname(stored), { recursive: true }); fs.writeFileSync(stored, 'zotero fixture');
  const mappings = await access.authorize([f.pdf, stored]);
  assert.equal(mappings.get(f.pdf), f.pdf); assert.equal(mappings.get(stored), stored);
});

test('Zotero storage links escaping its root require consent and disclose resolved sources', async (t) => {
  const f = fixture(t), prompts = [];
  const access = createSourceAccess({ showMessageBox: async (options) => { prompts.push(options); return { response: prompts.length === 1 ? 1 : 0 }; } });
  access.rememberZoteroRoot(f.zotero);
  const alias = path.join(f.zotero, 'storage');
  fs.symlinkSync(f.privateDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(access.authorize([path.join(alias, 'secret.pdf')], { mode: 'move' }), /canceled/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0].detail, /MOVE/); assert.match(prompts[1].message, /Resolved/);
  assert.ok(prompts[1].detail.includes(JSON.stringify(f.pdf)));
  assert.equal(fs.readFileSync(f.pdf, 'utf8'), 'private fixture');
});

test('canceling later batches grants no partial source capabilities', async (t) => {
  const f = fixture(t); let prompts = 0;
  const access = createSourceAccess({ showMessageBox: async () => ({ response: ++prompts === 1 ? 1 : 0 }) });
  const files = Array.from({ length: 9 }, (_, i) => path.join(f.privateDir, `${i}.pdf`));
  await assert.rejects(access.authorize(files), /canceled/);
  assert.equal(access.known(files[0]), null);
  assert.equal(prompts, 2);
  await assert.rejects(access.authorize(['relative.pdf']), /Invalid import source/);
});

test('arbitrary failed Zotero queries cannot grant a source-directory capability', async (t) => {
  const f = fixture(t); let prompts = 0;
  const access = createSourceAccess({ showMessageBox: async () => { prompts++; return { response: 0 }; } });
  const commands = createZoteroCommands({ approveZoteroSourceRoot: access.authorizeZoteroRoot });
  await assert.rejects(commands.zotero_list_local_collections({ options: { dataDir: f.privateDir } }), /canceled/);
  assert.equal(access.known(f.pdf), null);
  await assert.rejects(access.authorize([f.pdf]), /canceled/);
  assert.equal(prompts, 2);
});
