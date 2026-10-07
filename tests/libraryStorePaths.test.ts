import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { createAppPaths } = require('../electron/backend/libraryStore.cjs');

function fakeApp(userData = 'C:\\Users\\test\\AppData\\Roaming\\PaperQuay') {
  return {
    getPath(name: string) {
      if (name === 'userData') return userData;
      throw new Error(`Unexpected app path: ${name}`);
    },
  };
}

test('isolated profile pins its PaperQuay junction path for companion operations', (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'paperquay-paths-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'UserData'), actual = path.join(root, 'Data');
  mkdirSync(profile); mkdirSync(actual);
  symlinkSync(actual, path.join(profile, 'PaperQuay'), process.platform === 'win32' ? 'junction' : 'dir');
  const paths = createAppPaths(fakeApp(profile));
  assert.equal(paths.dataDir, actual);
  assert.equal(paths.configPath, path.join(actual, '.settings', 'paperquay.config.json'));
});

test('ordinary installs retain the userData/PaperQuay layout', () => {
  const app = fakeApp();
  assert.equal(
    path.win32.normalize(createAppPaths(app).dataDir),
    path.win32.join('C:\\Users\\test\\AppData\\Roaming\\PaperQuay', 'PaperQuay'),
  );
});
