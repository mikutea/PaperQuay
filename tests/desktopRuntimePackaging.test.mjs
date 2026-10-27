import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('desktop protocol and OIDC load with only declared packaged runtime dependencies', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const packages = ['openid-client', 'oauth4webapi', 'jose'];
  for (const name of packages) assert.ok(manifest.build.files.includes(`node_modules/${name}/**/*`), `Missing packaged ${name}`);
  const build = spawnSync(process.execPath, [path.join(root, 'electron/buildSyncCore.cjs')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const prefix = path.join(os.tmpdir(), 'paperquay-desktop-runtime-');
  const directory = await fs.mkdtemp(prefix);
  try {
    await fs.mkdir(path.join(directory, 'electron/backend'), { recursive: true });
    await fs.mkdir(path.join(directory, 'electron/generated'), { recursive: true });
    await fs.copyFile(path.join(root, 'electron/backend/desktopOidc.cjs'), path.join(directory, 'electron/backend/desktopOidc.cjs'));
    await fs.copyFile(path.join(root, 'electron/generated/desktopSyncCore.cjs'), path.join(directory, 'electron/generated/desktopSyncCore.cjs'));
    for (const name of packages) await fs.cp(path.join(root, 'node_modules', name), path.join(directory, 'node_modules', name), { recursive: true, dereference: true });
    const probe = `
      const assert = require('node:assert/strict');
      const core = require('./electron/generated/desktopSyncCore.cjs');
      for (const key of ['projectDesktopLibrary','createDesktopIdentityMap','queueLocalCreates','preparePush','applyPushResults']) assert.equal(typeof core[key], 'function');
      const auth = require('./electron/backend/desktopOidc.cjs').createDesktopOidcSession({openExternal() { throw Error('No network during package smoke'); }});
      assert.equal(auth.getSnapshot().status, 'signed-out'); auth.close();
      import('openid-client').then(client => {
        assert.equal(typeof client.authorizationCodeGrant, 'function');
        assert.equal(typeof client.enableNonRepudiationChecks, 'function');
      }).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
    `;
    await fs.writeFile(path.join(directory, 'probe.cjs'), probe);
    const checked = spawnSync(process.execPath, [path.join(directory, 'probe.cjs')], { cwd: directory,
      env: { ...process.env, NODE_PATH: '' }, windowsHide: true, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)), 'Cleanup is confined to this unique fixture');
    await fs.rm(directory, { recursive: true, force: true });
  }
});
