import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

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

test('isolated Windows profile resolves its PaperQuay junction path', () => {
  const app = fakeApp('D:\\PaperQuay\\UserData');
  assert.equal(
    path.win32.normalize(createAppPaths(app).configPath),
    path.win32.normalize('D:\\PaperQuay\\UserData\\PaperQuay\\.settings\\paperquay.config.json'),
  );
});

test('ordinary installs retain the userData/PaperQuay layout', () => {
  const app = fakeApp();
  assert.equal(
    path.win32.normalize(createAppPaths(app).dataDir),
    path.win32.join('C:\\Users\\test\\AppData\\Roaming\\PaperQuay', 'PaperQuay'),
  );
});
