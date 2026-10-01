const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  cleanString,
  hashBytes,
  hashFile,
  pathExists,
  readJson,
  safeFileName,
} = require('./utils.cjs');

const LIBRARY_DATABASE_REMOTE_PATH = 'latest/database/paperquay-library.sqlite';
const NOTES_DATABASE_REMOTE_PATH = 'latest/database/paperquay-notes.sqlite';
const RAG_DATABASE_REMOTE_PATH = 'latest/database/paperquay-rag.sqlite';
const LEGACY_LIBRARY_JSON_REMOTE_PATH = 'latest/database/paperquay-library.json';
const LATEST_MANIFEST_REMOTE_PATH = 'latest/manifest.json';
const DERIVED_REMOTE_ROOT = 'latest/derived';
const BACKUP_VERSION = 3;

function isoTimestamp() {
  return new Date().toISOString();
}

function createBackupId() {
  return isoTimestamp().replace(/[:.]/g, '-');
}

function remoteSegment(value, fallback = 'item') {
  return encodeURIComponent(cleanString(value) || fallback).replace(/%/g, '_');
}

function remoteJoin(...parts) {
  return parts
    .flatMap((part) => cleanString(part).replace(/\\/g, '/').split('/'))
    .filter(Boolean)
    .join('/');
}

function isSubPath(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function safeLocalJoin(root, relativePath) {
  const normalized = cleanString(relativePath).replace(/\\/g, '/');
  if (!normalized || normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Unsafe backup path: ${relativePath}`);
  }

  const target = path.resolve(root, normalized);
  if (!isSubPath(root, target)) throw new Error(`Backup path escapes restore root: ${relativePath}`);
  return target;
}

function backupSummary(objects) {
  return {
    uploadedCount: objects.filter((object) => object.status === 'uploaded').length,
    skippedCount: objects.filter((object) => object.status === 'skipped').length,
    failedCount: objects.filter((object) => object.status === 'failed').length,
    databaseCount: objects.filter((object) => object.kind === 'database').length,
    pdfCount: objects.filter((object) => object.kind === 'pdf').length,
    derivedCount: objects.filter((object) => ['mineru', 'translation', 'summary'].includes(object.kind)).length,
  };
}

async function removeDirectoryQuietly(directory) {
  await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
}

function buildManifest(backupId, createdAt, objects) {
  return {
    version: BACKUP_VERSION,
    backupId,
    createdAt,
    app: { name: 'PaperQuay', backend: 'electron' },
    objects,
    summary: backupSummary(objects),
  };
}

function previousObjectIndex(manifest) {
  const index = new Map();
  for (const object of manifest?.objects ?? []) {
    if ((object.status === 'uploaded' || object.status === 'skipped') && object.checksum) {
      index.set(object.remotePath, object);
    }
  }
  return index;
}

async function fileDigest(filePath) {
  const stat = await fsp.stat(filePath);
  return {
    byteSize: stat.size,
    checksum: await hashFile(filePath),
  };
}

function classifyDerivedFile(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const fileName = path.posix.basename(normalized);

  if (['paper_reader_manifest.json', 'content_list_v2.json', 'middle.json', 'full.md'].includes(fileName)) {
    return 'mineru';
  }

  if (normalized.includes('/translations/') && normalized.endsWith('.json')) {
    return 'translation';
  }

  if (normalized.includes('/summaries/') && normalized.endsWith('.json')) {
    return 'summary';
  }

  return null;
}

async function collectFiles(root) {
  const output = [];

  async function walk(directory) {
    let entries = [];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw new Error(
        `Failed to collect backup files from ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile()) {
        output.push(filePath);
      }
    }
  }

  await walk(root);
  return output;
}

function configuredMineruRoots(appPaths) {
  const config = readJson(appPaths.configPath, null);
  const roots = [
    appPaths.mineruCacheDir,
    config?.settings?.mineruCacheDir,
  ]
    .map(cleanString)
    .filter(Boolean);
  const seen = new Set();

  return roots.filter((root) => {
    const normalized = path.resolve(root);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function collectBackupSources(context, backupId) {
  const { appPaths, noteStore, ragStore, store } = context;
  const library = store.load();
  context.validateLibraryFileOperation?.(library, library.webdav.includePdfs !== false
    ? library.papers.flatMap((paper) => paper.attachments ?? []) : []);
  await store.save(library);

  const snapshotDir = path.join(appPaths.dataDir, '.backup-snapshots', backupId);
  const librarySnapshotPath = path.join(snapshotDir, 'paperquay-library.sqlite');
  const notesSnapshotPath = path.join(snapshotDir, 'paperquay-notes.sqlite');
  const ragSnapshotPath = path.join(snapshotDir, 'paperquay-rag.sqlite');
  store.snapshotTo(librarySnapshotPath);
  noteStore.snapshotTo(notesSnapshotPath);
  ragStore.snapshotTo(ragSnapshotPath);

  const sources = [{
    kind: 'database',
    localPath: librarySnapshotPath,
    remotePath: LIBRARY_DATABASE_REMOTE_PATH,
    source: appPaths.libraryDatabasePath,
  }, {
    kind: 'database',
    localPath: notesSnapshotPath,
    remotePath: NOTES_DATABASE_REMOTE_PATH,
    source: appPaths.notesDatabasePath,
  }, {
    kind: 'database',
    localPath: ragSnapshotPath,
    remotePath: RAG_DATABASE_REMOTE_PATH,
    source: appPaths.ragDatabasePath,
  }];

  if (library.webdav.includePdfs !== false) {
    for (const paper of library.papers ?? []) {
      for (const attachment of paper.attachments ?? []) {
        if (attachment.kind !== 'pdf' || !attachment.storedPath) continue;

        const exists = await pathExists(attachment.storedPath);
        const fileName = safeFileName(attachment.fileName || path.basename(attachment.storedPath));
        const remotePath = remoteJoin(
          'latest/pdfs',
          remoteSegment(paper.id, 'paper'),
          remoteSegment(attachment.id, 'attachment'),
          fileName,
        );

        if (!exists) {
          sources.push({
            kind: 'pdf',
            localPath: null,
            remotePath,
            source: `paper:${paper.id}:attachment:${attachment.id}:${attachment.storedPath}`,
            missingMessage: `Local PDF is missing: ${attachment.storedPath}`,
          });
          continue;
        }

        sources.push({
          kind: 'pdf',
          localPath: attachment.storedPath,
          remotePath,
          source: `paper:${paper.id}:attachment:${attachment.id}:${attachment.storedPath}`,
        });
      }
    }
  }

  if (library.webdav.includeDerived !== false) {
    for (const root of configuredMineruRoots(appPaths)) {
      const files = await collectFiles(root);
      const isDefaultRoot = path.resolve(root) === path.resolve(appPaths.mineruCacheDir);
      const rootLabel = isDefaultRoot ? '' : `root-${hashBytes(Buffer.from(root)).slice(0, 8)}`;

      for (const filePath of files) {
        const relative = path.relative(root, filePath).replace(/\\/g, '/');
        const kind = classifyDerivedFile(relative);
        if (!kind) continue;

        sources.push({
          kind,
          localPath: filePath,
          remotePath: remoteJoin(DERIVED_REMOTE_ROOT, rootLabel, relative),
          source: filePath,
        });
      }
    }
  }

  return { sources, snapshotDir };
}

async function loadLatestManifest(webdav) {
  const text = await webdav.getText(LATEST_MANIFEST_REMOTE_PATH);
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse latest WebDAV manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function uploadSource(webdav, backupId, source, previous) {
  if (source.missingMessage) {
    return {
      kind: source.kind,
      remotePath: source.remotePath,
      byteSize: 0,
      checksum: '',
      status: 'skipped',
      uploaded: false,
      source: source.source,
      message: source.missingMessage,
    };
  }

  try {
    const digest = await fileDigest(source.localPath);
    const previousObject = previous.get(source.remotePath);

    if (!source.forceUpload && previousObject?.checksum === digest.checksum && previousObject?.byteSize === digest.byteSize) {
      return {
        kind: source.kind,
        remotePath: source.remotePath,
        byteSize: digest.byteSize,
        checksum: digest.checksum,
        status: 'skipped',
        uploaded: false,
        source: source.source,
        message: 'unchanged object already present in latest manifest',
      };
    }

    if (typeof webdav.atomicUploadFile === 'function') {
      await webdav.atomicUploadFile(
        source.remotePath,
        backupId,
        source.localPath,
        digest.byteSize,
      );
    } else {
      await webdav.atomicUploadBytes(
        source.remotePath,
        backupId,
        await fsp.readFile(source.localPath),
      );
    }
    return {
      kind: source.kind,
      remotePath: source.remotePath,
      byteSize: digest.byteSize,
      checksum: digest.checksum,
      status: 'uploaded',
      uploaded: true,
      source: source.source,
      message: null,
    };
  } catch (error) {
    return {
      kind: source.kind,
      remotePath: source.remotePath,
      byteSize: 0,
      checksum: '',
      status: 'failed',
      uploaded: false,
      source: source.source,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runBackup(context, webdav, options = {}) {
  const backupId = createBackupId();
  const createdAt = isoTimestamp();
  const snapshotDir = path.join(context.appPaths.dataDir, '.backup-snapshots', backupId);
  const objects = [];
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : () => undefined;

  try {
    onProgress({ phase: 'preparing', completed: 0, total: 0, remotePath: null, status: null });
    const previous = previousObjectIndex(await loadLatestManifest(webdav));
    const { sources } = await collectBackupSources(context, backupId);
    onProgress({ phase: 'uploading', completed: 0, total: sources.length, remotePath: null, status: null });

    for (const source of sources) {
      const object = await uploadSource(webdav, backupId, source, previous);
      objects.push(object);
      onProgress({
        phase: 'uploading',
        completed: objects.length,
        total: sources.length,
        remotePath: object.remotePath,
        status: object.status,
      });
    }

    const manifest = buildManifest(backupId, createdAt, objects);
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const runManifestRemotePath = `runs/${backupId}/manifest.json`;

    onProgress({
      phase: 'publishing',
      completed: objects.length,
      total: sources.length,
      remotePath: runManifestRemotePath,
      status: null,
    });
    await webdav.atomicUploadBytes(runManifestRemotePath, backupId, manifestBytes);
    await webdav.atomicUploadBytes(LATEST_MANIFEST_REMOTE_PATH, backupId, manifestBytes);
    onProgress({
      phase: 'done',
      completed: objects.length,
      total: sources.length,
      remotePath: LATEST_MANIFEST_REMOTE_PATH,
      status: manifest.summary.failedCount === 0 ? 'uploaded' : 'failed',
    });

    const firstFailure = objects.find((object) => object.status === 'failed');
    return {
      ok: manifest.summary.failedCount === 0,
      backupId,
      createdAt,
      manifestRemotePath: LATEST_MANIFEST_REMOTE_PATH,
      runManifestRemotePath,
      uploadedCount: manifest.summary.uploadedCount,
      skippedCount: manifest.summary.skippedCount,
      failedCount: manifest.summary.failedCount,
      databaseCount: manifest.summary.databaseCount,
      pdfCount: manifest.summary.pdfCount,
      derivedCount: manifest.summary.derivedCount,
      message: manifest.summary.failedCount === 0
        ? `WebDAV backup finished: ${manifest.summary.uploadedCount} uploaded, ${manifest.summary.skippedCount} skipped.`
        : `WebDAV backup finished with ${manifest.summary.failedCount} failed object(s). First failure: ${firstFailure?.remotePath ?? 'unknown object'}: ${firstFailure?.message ?? 'unknown error'}`,
      objects,
    };
  } finally {
    await removeDirectoryQuietly(snapshotDir);
  }
}

function latestInfoFromManifest(manifest) {
  if (!manifest) {
    return {
      available: false,
      backupId: null,
      createdAt: null,
      manifestRemotePath: LATEST_MANIFEST_REMOTE_PATH,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      databaseCount: 0,
      pdfCount: 0,
      derivedCount: 0,
      message: 'No latest WebDAV backup is available.',
      objects: [],
    };
  }

  const summary = manifest.summary ?? backupSummary(manifest.objects ?? []);
  return {
    available: true,
    backupId: manifest.backupId ?? null,
    createdAt: manifest.createdAt ?? null,
    manifestRemotePath: LATEST_MANIFEST_REMOTE_PATH,
    uploadedCount: summary.uploadedCount ?? 0,
    skippedCount: summary.skippedCount ?? 0,
    failedCount: summary.failedCount ?? 0,
    databaseCount: summary.databaseCount ?? 0,
    pdfCount: summary.pdfCount ?? 0,
    derivedCount: summary.derivedCount ?? 0,
    message: `Latest WebDAV backup ${manifest.backupId ?? ''} is available.`,
    objects: manifest.objects ?? [],
  };
}

function mergeById(currentItems, incomingItems) {
  const byId = new Map((currentItems ?? []).map((item) => [item.id, item]));
  let insertedCount = 0;
  let updatedCount = 0;

  for (const item of incomingItems ?? []) {
    if (!item?.id) continue;
    if (byId.has(item.id)) {
      Object.assign(byId.get(item.id), item);
      updatedCount += 1;
    } else {
      currentItems.push(item);
      insertedCount += 1;
    }
  }

  return { insertedCount, updatedCount };
}

function mergeLibrary(current, incoming) {
  const categoryStats = mergeById(current.categories, incoming.categories);
  const paperStats = mergeById(current.papers, incoming.papers);
  current.settings = {
    ...(incoming.settings ?? {}),
    ...(current.settings ?? {}),
    storageDir: current.settings?.storageDir || incoming.settings?.storageDir,
  };

  return [
    { table: 'categories', ...categoryStats },
    { table: 'papers', ...paperStats },
  ];
}

function objectForRemotePath(manifest, remotePath) {
  return (manifest.objects ?? []).find((object) =>
    object.kind === 'database' &&
    object.remotePath === remotePath &&
    object.status !== 'failed'
  );
}

async function writeRestoreTempFile(appPaths, backupId, fileName, bytes) {
  const restoreDir = path.join(appPaths.dataDir, '.backup-restores', cleanString(backupId) || String(Date.now()));
  const filePath = path.join(restoreDir, safeFileName(fileName));

  await fsp.mkdir(restoreDir, { recursive: true });
  await fsp.writeFile(filePath, bytes);

  return { restoreDir, filePath };
}

async function restoreLibraryDatabaseObject(context, webdav, manifest, objects, tables) {
  const { appPaths, store } = context;
  const dbObject = objectForRemotePath(manifest, LIBRARY_DATABASE_REMOTE_PATH);
  const legacyJsonObject = objectForRemotePath(manifest, LEGACY_LIBRARY_JSON_REMOTE_PATH);
  let restoreDir = null;

  if (dbObject) {
    try {
      const bytes = await webdav.getBytes(LIBRARY_DATABASE_REMOTE_PATH);
      if (!bytes) throw new Error('Remote library SQLite database is missing');

      const temp = await writeRestoreTempFile(appPaths, manifest.backupId, 'paperquay-library.sqlite', bytes);
      restoreDir = temp.restoreDir;
      const incoming = store.loadFromSnapshot(temp.filePath);
      const current = store.load();

      tables.push(...mergeLibrary(current, incoming));
      context.validateLibraryFileOperation?.(current, current.papers.flatMap((paper) => paper.attachments ?? []));
      await store.save(current);
      objects.push({
        kind: 'database',
        remotePath: LIBRARY_DATABASE_REMOTE_PATH,
        localPath: appPaths.libraryDatabasePath,
        byteSize: bytes.length,
        checksum: hashBytes(bytes),
        status: 'downloaded',
        message: null,
      });
    } catch (error) {
      objects.push({
        kind: 'database',
        remotePath: LIBRARY_DATABASE_REMOTE_PATH,
        localPath: appPaths.libraryDatabasePath,
        byteSize: 0,
        checksum: '',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (restoreDir) await removeDirectoryQuietly(restoreDir);
    }

    return;
  }

  if (legacyJsonObject) {
    try {
      const bytes = await webdav.getBytes(LEGACY_LIBRARY_JSON_REMOTE_PATH);
      if (!bytes) throw new Error('Remote legacy library JSON is missing');

      const incoming = JSON.parse(bytes.toString('utf8'));
      const current = store.load();
      tables.push(...mergeLibrary(current, incoming));
      context.validateLibraryFileOperation?.(current, current.papers.flatMap((paper) => paper.attachments ?? []));
      await store.save(current);
      objects.push({
        kind: 'database',
        remotePath: LEGACY_LIBRARY_JSON_REMOTE_PATH,
        localPath: appPaths.libraryDatabasePath,
        byteSize: bytes.length,
        checksum: hashBytes(bytes),
        status: 'downloaded',
        message: null,
      });
    } catch (error) {
      objects.push({
        kind: 'database',
        remotePath: LEGACY_LIBRARY_JSON_REMOTE_PATH,
        localPath: appPaths.libraryDatabasePath,
        byteSize: 0,
        checksum: '',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function restoreRagDatabaseObject(context, webdav, manifest, objects) {
  const { appPaths, ragStore } = context;
  const dbObject = objectForRemotePath(manifest, RAG_DATABASE_REMOTE_PATH);
  let restoreDir = null;

  if (!dbObject) return;

  try {
    const bytes = await webdav.getBytes(RAG_DATABASE_REMOTE_PATH);
    if (!bytes) throw new Error('Remote RAG SQLite database is missing');

    const temp = await writeRestoreTempFile(appPaths, manifest.backupId, 'paperquay-rag.sqlite', bytes);
    restoreDir = temp.restoreDir;
    await ragStore.replaceWithSnapshot(temp.filePath);
    objects.push({
      kind: 'database',
      remotePath: RAG_DATABASE_REMOTE_PATH,
      localPath: appPaths.ragDatabasePath,
      byteSize: bytes.length,
      checksum: hashBytes(bytes),
      status: 'downloaded',
      message: null,
    });
  } catch (error) {
    objects.push({
      kind: 'database',
      remotePath: RAG_DATABASE_REMOTE_PATH,
      localPath: appPaths.ragDatabasePath,
      byteSize: 0,
      checksum: '',
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (restoreDir) await removeDirectoryQuietly(restoreDir);
  }
}

async function restoreNotesDatabaseObject(context, webdav, manifest, objects) {
  const { appPaths, noteStore } = context;
  const dbObject = objectForRemotePath(manifest, NOTES_DATABASE_REMOTE_PATH);
  let restoreDir = null;

  if (!dbObject) return;

  try {
    const bytes = await webdav.getBytes(NOTES_DATABASE_REMOTE_PATH);
    if (!bytes) throw new Error('Remote notes SQLite database is missing');

    const temp = await writeRestoreTempFile(appPaths, manifest.backupId, 'paperquay-notes.sqlite', bytes);
    restoreDir = temp.restoreDir;
    await noteStore.replaceWithSnapshot(temp.filePath);
    objects.push({
      kind: 'database',
      remotePath: NOTES_DATABASE_REMOTE_PATH,
      localPath: appPaths.notesDatabasePath,
      byteSize: bytes.length,
      checksum: hashBytes(bytes),
      status: 'downloaded',
      message: null,
    });
  } catch (error) {
    objects.push({
      kind: 'database',
      remotePath: NOTES_DATABASE_REMOTE_PATH,
      localPath: appPaths.notesDatabasePath,
      byteSize: 0,
      checksum: '',
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (restoreDir) await removeDirectoryQuietly(restoreDir);
  }
}

function parseAttachmentSource(source) {
  const match = cleanString(source).match(/^paper:([^:]+):attachment:([^:]+):(.*)$/);
  if (!match) return null;
  return { paperId: match[1], attachmentId: match[2], originalPath: match[3] };
}

async function localFileMatches(filePath, object) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    if (Number(object.byteSize) && stat.size !== Number(object.byteSize)) return false;
    if (object.checksum) return await hashFile(filePath) === object.checksum;
    return stat.size > 0;
  } catch {
    return false;
  }
}

function restorePdfTarget(library, object, appPaths) {
  const source = parseAttachmentSource(object.source);
  const storageDir = library.settings?.storageDir || path.join(appPaths.dataDir, 'paperquay-data');
  const fileName = safeFileName(path.posix.basename(object.remotePath) || 'paper.pdf');
  const paper = source ? library.papers.find((item) => item.id === source.paperId) : null;
  const attachment = paper?.attachments?.find((item) => item.id === source.attachmentId);
  const preferred = attachment?.storedPath || source?.originalPath || '';

  if (preferred && isSubPath(storageDir, preferred)) return preferred;
  return path.join(storageDir, `${safeFileName(source?.paperId || 'restored')}-${fileName}`);
}

async function restorePdfObject(webdav, library, object, appPaths) {
  const target = restorePdfTarget(library, object, appPaths);
  if (await localFileMatches(target, object)) {
    return { kind: 'pdf', remotePath: object.remotePath, localPath: target, byteSize: object.byteSize, checksum: object.checksum, status: 'skipped', message: 'local file already matches backup' };
  }

  const bytes = await webdav.getBytes(object.remotePath);
  if (!bytes) throw new Error(`Remote PDF is missing: ${object.remotePath}`);

  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, bytes);

  const source = parseAttachmentSource(object.source);
  const paper = source ? library.papers.find((item) => item.id === source.paperId) : null;
  const attachment = paper?.attachments?.find((item) => item.id === source.attachmentId);
  if (attachment) {
    attachment.storedPath = target;
    attachment.fileSize = bytes.length;
    attachment.contentHash = object.checksum || hashBytes(bytes);
    attachment.missing = false;
  }

  return { kind: 'pdf', remotePath: object.remotePath, localPath: target, byteSize: bytes.length, checksum: object.checksum || hashBytes(bytes), status: 'downloaded', message: null };
}

function derivedRestorePath(object, appPaths) {
  const prefix = `${DERIVED_REMOTE_ROOT}/`;
  const relative = cleanString(object.remotePath).startsWith(prefix)
    ? cleanString(object.remotePath).slice(prefix.length)
    : path.posix.basename(object.remotePath);
  const withoutCustomRoot = relative.replace(/^root-[a-f0-9]{8}\//i, '');
  return safeLocalJoin(appPaths.mineruCacheDir, withoutCustomRoot);
}

async function restoreDerivedObject(webdav, object, appPaths) {
  const target = derivedRestorePath(object, appPaths);
  if (await localFileMatches(target, object)) {
    return { kind: object.kind, remotePath: object.remotePath, localPath: target, byteSize: object.byteSize, checksum: object.checksum, status: 'skipped', message: 'local file already matches backup' };
  }

  const bytes = await webdav.getBytes(object.remotePath);
  if (!bytes) throw new Error(`Remote derived object is missing: ${object.remotePath}`);

  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, bytes);

  return { kind: object.kind, remotePath: object.remotePath, localPath: target, byteSize: bytes.length, checksum: object.checksum || hashBytes(bytes), status: 'downloaded', message: null };
}

async function runRestore(context, webdav) {
  const { appPaths, store } = context;
  const initial = store.load();
  context.validateLibraryFileOperation?.(initial, initial.papers.flatMap((paper) => paper.attachments ?? []));
  const manifest = await loadLatestManifest(webdav);
  if (!manifest) {
    return {
      ok: false,
      backupId: null,
      createdAt: null,
      manifestRemotePath: LATEST_MANIFEST_REMOTE_PATH,
      downloadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      mergedRowCount: 0,
      updatedRowCount: 0,
      pdfRestoredCount: 0,
      derivedRestoredCount: 0,
      message: 'No latest WebDAV backup is available.',
      objects: [],
      tables: [],
    };
  }

  const objects = [];
  const tables = [];
  await restoreLibraryDatabaseObject(context, webdav, manifest, objects, tables);
  await restoreNotesDatabaseObject(context, webdav, manifest, objects);
  await restoreRagDatabaseObject(context, webdav, manifest, objects);

  const library = store.load();
  context.validateLibraryFileOperation?.(library, library.papers.flatMap((paper) => paper.attachments ?? []));
  for (const object of manifest.objects ?? []) {
    if (object.status === 'failed' || !object.remotePath || object.kind === 'database') continue;
    if (!['pdf', 'mineru', 'translation', 'summary'].includes(object.kind)) continue;

    try {
      if (object.kind === 'pdf') {
        context.validateLibraryFileOperation?.(library, [{ storedPath: restorePdfTarget(library, object, appPaths) }]);
      }
      context.validateLibraryRestoreTarget?.(object.kind, object.kind === 'pdf'
        ? restorePdfTarget(library, object, appPaths) : derivedRestorePath(object, appPaths));
      const result = object.kind === 'pdf'
        ? await restorePdfObject(webdav, library, object, appPaths)
        : await restoreDerivedObject(webdav, object, appPaths);
      objects.push(result);
    } catch (error) {
      objects.push({
        kind: object.kind,
        remotePath: object.remotePath,
        localPath: '',
        byteSize: object.byteSize ?? 0,
        checksum: object.checksum ?? '',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await store.save(library);

  const downloadedCount = objects.filter((object) => object.status === 'downloaded').length;
  const skippedCount = objects.filter((object) => object.status === 'skipped').length;
  const failedCount = objects.filter((object) => object.status === 'failed').length;
  const mergedRowCount = tables.reduce((sum, table) => sum + table.insertedCount, 0);
  const updatedRowCount = tables.reduce((sum, table) => sum + table.updatedCount, 0);

  return {
    ok: failedCount === 0,
    backupId: manifest.backupId ?? null,
    createdAt: manifest.createdAt ?? null,
    manifestRemotePath: LATEST_MANIFEST_REMOTE_PATH,
    downloadedCount,
    skippedCount,
    failedCount,
    mergedRowCount,
    updatedRowCount,
    pdfRestoredCount: objects.filter((object) => object.kind === 'pdf' && object.status === 'downloaded').length,
    derivedRestoredCount: objects.filter((object) => ['mineru', 'translation', 'summary'].includes(object.kind) && object.status === 'downloaded').length,
    message: failedCount === 0
      ? `WebDAV restore finished: ${downloadedCount} downloaded, ${skippedCount} skipped.`
      : `WebDAV restore finished with ${failedCount} failed object(s).`,
    objects,
    tables,
  };
}

module.exports = {
  LATEST_MANIFEST_REMOTE_PATH,
  NOTES_DATABASE_REMOTE_PATH,
  latestInfoFromManifest,
  loadLatestManifest,
  runBackup,
  runRestore,
};
