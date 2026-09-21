import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createAppPaths,
  resolveAppDataDir,
} = require('../electron/backend/libraryStore.cjs');

function fakeApp({
  executable = 'C:\\Program Files\\PaperQuay\\PaperQuay.exe',
  packaged = false,
  userData = 'C:\\Users\\test\\AppData\\Roaming\\PaperQuay',
} = {}) {
  return {
    isPackaged: packaged,
    getPath(name: string) {
      if (name === 'exe') return executable;
      if (name === 'userData') return userData;
      throw new Error(`Unexpected app path: ${name}`);
    },
  };
}

test('maintained Windows portable layout resolves the sibling Data directory', () => {
  const app = fakeApp({
    executable: 'D:\\PaperQuay\\App\\PaperQuay.exe',
    packaged: true,
    userData: 'D:\\PaperQuay\\Data',
  });

  assert.equal(
    resolveAppDataDir(app, { env: {}, platform: 'win32' }),
    path.win32.normalize('D:\\PaperQuay\\Data'),
  );
  assert.equal(
    createAppPaths(app, { env: {}, platform: 'win32' }).configPath,
    path.win32.normalize('D:\\PaperQuay\\Data\\.settings\\paperquay.config.json'),
  );
});

test('PAPERQUAY_DATA_DIR is an explicit cross-platform override', () => {
  const app = fakeApp();
  const configured = path.win32.resolve('X:\\Research\\PaperQuayData');

  assert.equal(
    resolveAppDataDir(app, {
      env: { PAPERQUAY_DATA_DIR: configured },
      platform: 'win32',
    }),
    configured,
  );
});

test('ordinary installs retain the existing userData/PaperQuay fallback', () => {
  const app = fakeApp({ packaged: false });

  assert.equal(
    resolveAppDataDir(app, { env: {}, platform: 'win32' }),
    path.win32.join('C:\\Users\\test\\AppData\\Roaming\\PaperQuay', 'PaperQuay'),
  );
});
