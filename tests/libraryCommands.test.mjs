import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createLibraryCommands } = require('../electron/backend/libraryCommands.cjs');
const { createLibraryStore } = require('../electron/backend/libraryStore.cjs');

function createAppPaths() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'paperquay-library-commands-test-'));

  return {
    dataDir,
    configPath: path.join(dataDir, '.settings', 'paperquay.config.json'),
    mineruCacheDir: path.join(dataDir, '.mineru-cache'),
    remotePdfDownloadDir: path.join(dataDir, '.downloads', 'pdfs'),
    libraryPath: path.join(dataDir, 'paperquay-library.json'),
    libraryDatabasePath: path.join(dataDir, 'paperquay-library.sqlite'),
    ragDatabasePath: path.join(dataDir, 'paperquay-rag.sqlite'),
    screenshotDir: path.join(dataDir, '.screenshots'),
  };
}

test('library_list_all_papers does not truncate a full-library task at 1000 papers', async () => {
  const appPaths = createAppPaths();
  const papers = Array.from({ length: 1001 }, (_, index) => ({
    id: `paper-${index}`,
    title: `Paper ${index}`,
    sortOrder: index,
    importedAt: index,
  }));
  const commands = createLibraryCommands({
    appPaths,
    store: { load: () => ({ papers, categories: [] }) },
  });
  try {
    assert.equal((await commands.library_list_papers({ request: { limit: 2000 } })).length, 1000);
    assert.equal((await commands.library_list_all_papers()).length, 1001);
  } finally {
    rmSync(appPaths.dataDir, { recursive: true, force: true });
  }
});

test('library_update_settings migrates stored PDFs into the new storage directory', async () => {
  const appPaths = createAppPaths();
  let store = null;

  try {
    const oldStorageDir = path.join(appPaths.dataDir, 'old-papers');
    const newStorageDir = path.join(appPaths.dataDir, 'new-papers');
    const relativePath = path.join('category-a', 'paper-1.pdf');
    const oldPdfPath = path.join(oldStorageDir, relativePath);
    const newPdfPath = path.join(newStorageDir, relativePath);

    await mkdir(path.dirname(oldPdfPath), { recursive: true });
    writeFileSync(oldPdfPath, '%PDF-1.7\npaper body\n');

    store = createLibraryStore(appPaths);
    const library = store.load();
    library.settings.storageDir = oldStorageDir;
    library.papers.push({
      id: 'paper-1',
      title: 'Migrated Paper',
      year: null,
      publication: null,
      doi: null,
      url: null,
      abstractText: null,
      keywords: [],
      importedAt: 1,
      updatedAt: 1,
      lastReadAt: null,
      readingProgress: 0,
      isFavorite: false,
      userNote: null,
      aiSummary: null,
      citation: null,
      source: 'local',
      sortOrder: 0,
      authors: [],
      tags: [],
      categoryIds: [],
      attachments: [{
        id: 'att-1',
        paperId: 'paper-1',
        kind: 'pdf',
        originalPath: oldPdfPath,
        storedPath: oldPdfPath,
        relativePath,
        fileName: 'paper-1.pdf',
        mimeType: 'application/pdf',
        fileSize: 20,
        contentHash: 'hash-1',
        createdAt: 1,
        missing: false,
      }],
    });
    await store.save(library);

    const commands = createLibraryCommands({ appPaths, store });
    const updatedSettings = await commands.library_update_settings({
      settings: {
        ...library.settings,
        storageDir: newStorageDir,
      },
    });

    assert.equal(updatedSettings.storageDir, newStorageDir);
    assert.equal(existsSync(newPdfPath), true);
    assert.equal(readFileSync(newPdfPath, 'utf8'), '%PDF-1.7\npaper body\n');

    const migrated = store.load().papers[0];
    assert.equal(migrated.attachments[0].storedPath, newPdfPath);
    assert.equal(migrated.attachments[0].relativePath, relativePath);
    assert.equal(migrated.attachments[0].missing, false);
  } finally {
    store?.close();
    rmSync(appPaths.dataDir, { recursive: true, force: true });
  }
});
