import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createLibraryStore } = require('../electron/backend/libraryStore.cjs');
const { createNoteStore } = require('../electron/backend/noteStore.cjs');
const { createRagStore } = require('../electron/backend/ragStore.cjs');
const { LATEST_MANIFEST_REMOTE_PATH, NOTES_DATABASE_REMOTE_PATH, runBackup, runRestore } = require('../electron/backend/webdavBackup.cjs');
const { WebdavClient, parseRetryAfter } = require('../electron/backend/webdavClient.cjs');

const LIBRARY_DATABASE_REMOTE_PATH = 'latest/database/paperquay-library.sqlite';
const RAG_DATABASE_REMOTE_PATH = 'latest/database/paperquay-rag.sqlite';

class MemoryWebdav {
  objects = new Map<string, Buffer>();
  fileUploadCount = 0;

  async getText(remotePath: string): Promise<string | null> {
    const bytes = this.objects.get(remotePath);
    return bytes ? bytes.toString('utf8') : null;
  }

  async getBytes(remotePath: string): Promise<Buffer | null> {
    const bytes = this.objects.get(remotePath);
    return bytes ? Buffer.from(bytes) : null;
  }

  async atomicUploadBytes(remotePath: string, _backupId: string, bytes: Buffer): Promise<void> {
    this.objects.set(remotePath, Buffer.from(bytes));
  }

  async atomicUploadFile(
    remotePath: string,
    _backupId: string,
    filePath: string,
  ): Promise<void> {
    this.fileUploadCount += 1;
    this.objects.set(remotePath, readFileSync(filePath));
  }
}

function createAppPaths(prefix: string) {
  const dataDir = mkdtempSync(path.join(tmpdir(), prefix));

  return {
    dataDir,
    configPath: path.join(dataDir, '.settings', 'paperquay.config.json'),
    mineruCacheDir: path.join(dataDir, '.mineru-cache'),
    remotePdfDownloadDir: path.join(dataDir, '.downloads', 'pdfs'),
    libraryPath: path.join(dataDir, 'paperquay-library.json'),
    libraryDatabasePath: path.join(dataDir, 'paperquay-library.sqlite'),
    notesDatabasePath: path.join(dataDir, 'paperquay-notes.sqlite'),
    ragDatabasePath: path.join(dataDir, 'paperquay-rag.sqlite'),
    screenshotDir: path.join(dataDir, '.screenshots'),
  };
}

function createContext(prefix: string) {
  const appPaths = createAppPaths(prefix);
  const store = createLibraryStore(appPaths);
  const noteStore = createNoteStore(appPaths);
  const ragStore = createRagStore(appPaths);

  return {
    appPaths,
    noteStore,
    store,
    ragStore,
    close() {
      noteStore.close();
      ragStore.close();
      store.close();
      rmSync(appPaths.dataDir, { recursive: true, force: true });
    },
  };
}

function seedLibrary(context: ReturnType<typeof createContext>) {
  const storageDir = path.join(context.appPaths.dataDir, 'papers');
  const pdfPath = path.join(storageDir, 'seed.pdf');
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(pdfPath, '%PDF-1.7\n');

  const library = context.store.load();
  library.settings.storageDir = storageDir;
  library.webdav.includePdfs = false;
  library.webdav.includeDerived = false;
  library.categories.push({
    id: 'cat-webdav',
    name: 'WebDAV',
    parentId: null,
    sortOrder: 10,
    isSystem: false,
    systemKey: null,
    createdAt: 1000,
    updatedAt: 1000,
    paperCount: 0,
  });
  library.papers.push({
    id: 'paper-webdav',
    title: 'Backed Up Paper',
    year: '2026',
    publication: 'Backup Tests',
    doi: null,
    url: null,
    abstractText: 'Backed up through SQLite.',
    keywords: ['backup'],
    importedAt: 1000,
    updatedAt: 1001,
    lastReadAt: null,
    readingProgress: 0.2,
    isFavorite: false,
    userNote: null,
    aiSummary: null,
    citation: null,
    source: 'local',
    sortOrder: 0,
    authors: [{
      id: 'author-webdav',
      name: 'Backup Author',
      givenName: null,
      familyName: null,
      sortOrder: 0,
    }],
    tags: [],
    categoryIds: ['cat-webdav'],
    attachments: [{
      id: 'att-webdav',
      paperId: 'paper-webdav',
      kind: 'pdf',
      originalPath: pdfPath,
      storedPath: pdfPath,
      relativePath: 'seed.pdf',
      fileName: 'seed.pdf',
      mimeType: 'application/pdf',
      fileSize: 9,
      contentHash: 'seed-hash',
      createdAt: 1000,
      missing: false,
    }],
  });

  context.store.save(library);
}

function seedRag(context: ReturnType<typeof createContext>) {
  context.ragStore.indexDocument({
    documentKey: 'paper-webdav',
    title: 'Backed Up Paper',
    sourceType: 'pdf-text',
    sourceSignature: 'sig-webdav',
    embeddingModelKey: 'embedding-test',
    totalChunkCount: 1,
    chunks: [{
      chunkId: 'webdav-1',
      chunkIndex: 0,
      pageIndex: 0,
      blockId: 'block-webdav',
      text: 'embedding restored from WebDAV',
      embedding: [0.5, 0.5, 0.1, 0.1],
    }],
  });
}

function seedNotes(context: ReturnType<typeof createContext>) {
  context.noteStore.createNote({
    paperId: 'paper-webdav',
    type: 'highlight',
    title: 'Important method',
    content: 'This note should survive WebDAV backup.',
    excerpt: 'method excerpt',
    tags: ['method'],
    color: '#fef3c7',
    pdfLocation: {
      pageNumber: 2,
      bbox: [10, 20, 120, 80],
      bboxCoordinateSystem: 'normalized-1000',
      highlightColor: '#fef3c7',
    },
  });
}

test('WebDAV backup uploads and restores library, notes, and RAG SQLite databases', async () => {
  const source = createContext('paperquay-webdav-source-');
  const target = createContext('paperquay-webdav-target-');
  const webdav = new MemoryWebdav();

  try {
    seedLibrary(source);
    seedNotes(source);
    seedRag(source);

    const progressEvents: Array<{ phase: string; completed: number; total: number }> = [];
    const backup = await runBackup(source, webdav, {
      onProgress: (progress: { phase: string; completed: number; total: number }) => {
        progressEvents.push(progress);
      },
    });
    assert.equal(backup.ok, true);
    assert.equal(backup.databaseCount, 3);
    assert.ok(webdav.fileUploadCount >= 3);
    assert.ok(webdav.objects.has(LIBRARY_DATABASE_REMOTE_PATH));
    assert.ok(webdav.objects.has(NOTES_DATABASE_REMOTE_PATH));
    assert.ok(webdav.objects.has(RAG_DATABASE_REMOTE_PATH));
    assert.equal(progressEvents[0]?.phase, 'preparing');
    assert.equal(progressEvents.at(-1)?.phase, 'done');
    assert.equal(progressEvents.at(-1)?.completed, progressEvents.at(-1)?.total);

    const manifest = JSON.parse((await webdav.getText(LATEST_MANIFEST_REMOTE_PATH)) ?? '{}');
    assert.equal(manifest.version, 3);
    assert.deepEqual(
      manifest.objects
        .filter((object: { kind: string }) => object.kind === 'database')
        .map((object: { remotePath: string }) => object.remotePath)
        .sort(),
      [LIBRARY_DATABASE_REMOTE_PATH, NOTES_DATABASE_REMOTE_PATH, RAG_DATABASE_REMOTE_PATH].sort(),
    );

    const restore = await runRestore(target, webdav);
    assert.equal(restore.ok, true);
    assert.equal(restore.failedCount, 0);

    const restoredLibrary = target.store.load();
    const restoredPaper = restoredLibrary.papers.find((paper: { id: string }) => paper.id === 'paper-webdav');
    assert.ok(restoredPaper);
    assert.equal(restoredPaper.title, 'Backed Up Paper');
    assert.equal(restoredPaper.attachments[0].paperId, 'paper-webdav');
    assert.deepEqual(restoredPaper.categoryIds, ['cat-webdav']);

    const restoredNotes = target.noteStore.listNotes({ paperId: 'paper-webdav' });
    assert.equal(restoredNotes.length, 1);
    assert.equal(restoredNotes[0].title, 'Important method');
    assert.equal(restoredNotes[0].pdfLocation.pageNumber, 2);

    const results = target.ragStore.retrieveDocumentChunks({
      documentKey: 'paper-webdav',
      sourceType: 'pdf-text',
      queryEmbedding: [0.5, 0.5, 0.1, 0.1],
      topK: 1,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].chunkId, 'webdav-1');
    assert.equal(results[0].text, 'embedding restored from WebDAV');
  } finally {
    source.close();
    target.close();
  }
});

test('rejected SQLite and legacy JSON merges report zero committed row counts', async () => {
  const source = createContext('paperquay-webdav-rejected-source-');
  try {
    seedLibrary(source);
    for (const legacy of [false, true]) {
      const target = createContext('paperquay-webdav-rejected-target-');
      const webdav = new MemoryWebdav();
      try {
        await runBackup(source, webdav);
        const manifest = JSON.parse((await webdav.getText(LATEST_MANIFEST_REMOTE_PATH))!);
        if (legacy) {
          const remotePath = 'latest/database/paperquay-library.json';
          webdav.objects.set(remotePath, Buffer.from(JSON.stringify(source.store.load())));
          manifest.objects = [{ kind: 'database', remotePath, status: 'uploaded' }];
        } else {
          manifest.objects = manifest.objects.filter((object: { remotePath: string }) => object.remotePath === LIBRARY_DATABASE_REMOTE_PATH);
        }
        webdav.objects.set(LATEST_MANIFEST_REMOTE_PATH, Buffer.from(JSON.stringify(manifest)));
        const result = await runRestore({ ...target, validateLibraryFileOperation(library: { papers: unknown[] }) {
          if (library.papers.length) throw new Error('Unapproved restored attachment');
        } }, webdav);
        assert.equal(result.ok, false);
        assert.equal(result.mergedRowCount, 0);
        assert.equal(result.updatedRowCount, 0);
        assert.deepEqual(result.tables, []);
        assert.equal(target.store.load().papers.length, 0);
      } finally { target.close(); }
    }
  } finally { source.close(); }
});

test('WebDAV backup propagates latest manifest errors and does not leave snapshot directories', async () => {
  const context = createContext('paperquay-webdav-manifest-error-');
  const webdav = {
    async getText() {
      throw new Error('WebDAV GET failed for latest/manifest.json: HTTP 401: unauthorized');
    },
  };

  try {
    seedLibrary(context);
    await assert.rejects(
      runBackup(context, webdav),
      /latest\/manifest\.json: HTTP 401: unauthorized/,
    );
    assert.equal(existsSync(path.join(context.appPaths.dataDir, '.backup-snapshots')), false);
  } finally {
    context.close();
  }
});

test('WebDAV backup removes a partially created SQLite snapshot after collection failure', async () => {
  const context = createContext('paperquay-webdav-snapshot-error-');
  const webdav = new MemoryWebdav();
  const originalSnapshotTo = context.store.snapshotTo;

  try {
    context.store.snapshotTo = (targetPath: string) => {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, 'partial snapshot');
      throw new Error('snapshot failed');
    };

    await assert.rejects(runBackup(context, webdav), /snapshot failed/);
    const snapshotRoot = path.join(context.appPaths.dataDir, '.backup-snapshots');
    assert.deepEqual(existsSync(snapshotRoot) ? readdirSync(snapshotRoot) : [], []);
  } finally {
    context.store.snapshotTo = originalSnapshotTo;
    context.close();
  }
});

test('WebDAV client honors Retry-After when retrying HTTP 429', async () => {
  let requestCount = 0;
  const sleeps: number[] = [];
  const client = new WebdavClient(
    {
      endpointUrl: 'https://dav.example.test',
      remoteRoot: 'paperquay',
      username: '',
      password: '',
    },
    {
      fetch: async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } })
          : new Response('{}', { status: 200 });
      },
      maximumRetries: 1,
      minimumRequestIntervalMs: 0,
      random: () => 0,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    },
  );

  const response = await client.request('GET', 'latest/manifest.json');

  assert.equal(response.status, 200);
  assert.equal(requestCount, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(parseRetryAfter('3'), 3000);
});

test('WebDAV client does not retry authentication failures and includes the server response', async () => {
  let requestCount = 0;
  const client = new WebdavClient(
    {
      endpointUrl: 'https://dav.example.test',
      remoteRoot: 'paperquay',
      username: 'reader',
      password: 'secret',
    },
    {
      fetch: async () => {
        requestCount += 1;
        return new Response('application password rejected', { status: 401 });
      },
      maximumRetries: 3,
      minimumRequestIntervalMs: 0,
      sleep: async () => undefined,
    },
  );

  await assert.rejects(
    client.getText('latest/manifest.json'),
    /GET failed for latest\/manifest\.json: HTTP 401: application password rejected/,
  );
  assert.equal(requestCount, 1);
});

test('WebDAV client caches MKCOL requests and uploads files as streams without HEAD', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'paperquay-webdav-stream-'));
  const sourcePath = path.join(directory, 'large.sqlite');
  const methods: string[] = [];
  const uploadedPayloads: Buffer[] = [];
  writeFileSync(sourcePath, Buffer.from('streamed sqlite content'));

  const client = new WebdavClient(
    {
      endpointUrl: 'https://dav.example.test',
      remoteRoot: 'paperquay',
      username: '',
      password: '',
    },
    {
      fetch: async (_url: string, options: { method?: string; body?: AsyncIterable<Uint8Array> }) => {
        const method = options.method ?? 'GET';
        methods.push(method);
        if (method === 'PUT' && options.body) {
          if (Buffer.isBuffer(options.body)) {
            uploadedPayloads.push(Buffer.from(options.body));
          } else {
            const chunks: Buffer[] = [];
            for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
            uploadedPayloads.push(Buffer.concat(chunks));
          }
        }
        return new Response(null, { status: method === 'MOVE' ? 201 : 201 });
      },
      maximumRetries: 0,
      minimumRequestIntervalMs: 0,
      sleep: async () => undefined,
    },
  );

  try {
    await client.atomicUploadFile(
      'latest/database/large.sqlite',
      'backup-1',
      sourcePath,
      readFileSync(sourcePath).length,
    );
    await client.putBytes('latest/database/manifest.json', Buffer.from('{}'));

    assert.equal(methods.filter((method) => method === 'MKCOL').length, 3);
    assert.equal(methods.includes('HEAD'), false);
    assert.equal(methods.filter((method) => method === 'PUT').length, 2);
    assert.equal(methods.filter((method) => method === 'MOVE').length, 1);
    assert.equal(uploadedPayloads[0]?.toString('utf8'), 'streamed sqlite content');
    assert.equal(uploadedPayloads[1]?.toString('utf8'), '{}');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('WebDAV client does not replace the destination when MOVE fails with authentication error', async () => {
  const methods: string[] = [];
  const client = new WebdavClient(
    {
      endpointUrl: 'https://dav.example.test',
      remoteRoot: 'paperquay',
      username: '',
      password: '',
    },
    {
      fetch: async (_url: string, options: { method?: string }) => {
        const method = options.method ?? 'GET';
        methods.push(method);
        return method === 'MOVE'
          ? new Response('not authorized to move', { status: 401 })
          : new Response(null, { status: 201 });
      },
      maximumRetries: 0,
      minimumRequestIntervalMs: 0,
      sleep: async () => undefined,
    },
  );

  await assert.rejects(
    client.atomicUploadBytes('latest/database/data.sqlite', 'backup-1', Buffer.from('data')),
    /MOVE failed.*HTTP 401: not authorized to move/,
  );
  assert.equal(methods.filter((method) => method === 'PUT').length, 1);
});

test('WebDAV backup result identifies the first failed remote object', async () => {
  const context = createContext('paperquay-webdav-object-error-');
  const webdav = new MemoryWebdav();
  const originalUploadFile = webdav.atomicUploadFile.bind(webdav);

  webdav.atomicUploadFile = async (remotePath, backupId, filePath) => {
    if (remotePath === NOTES_DATABASE_REMOTE_PATH) {
      throw new Error('WebDAV PUT failed: HTTP 507: quota exceeded');
    }
    await originalUploadFile(remotePath, backupId, filePath);
  };

  try {
    const result = await runBackup(context, webdav);

    assert.equal(result.ok, false);
    assert.equal(result.failedCount, 1);
    assert.match(result.message, new RegExp(NOTES_DATABASE_REMOTE_PATH.replaceAll('.', '\\.')));
    assert.match(result.message, /HTTP 507: quota exceeded/);
    assert.equal(
      result.objects.find((object: { remotePath: string }) => object.remotePath === NOTES_DATABASE_REMOTE_PATH)?.status,
      'failed',
    );
  } finally {
    context.close();
  }
});
