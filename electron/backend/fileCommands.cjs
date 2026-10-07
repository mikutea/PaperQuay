const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { BrowserWindow, clipboard, dialog, shell } = require('electron');
const { canonicalPath, isWithin, assertBoundPath, writeBoundFile, createWriteAuthorizer, readAuthorizedFile } = require('./pathAccess.cjs');
const {
  cleanString,
  pathExists,
  readJson,
  safeFileName,
  now,
} = require('./utils.cjs');

const MINERU_CACHE_MARKER_FILE = '.paperquay-mineru-cache.json';
const MINERU_OUTPUT_FILE_NAMES = new Set([
  'content_list_v2.json',
  'content_list.json',
  'middle.json',
  'full.md',
]);

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function directoryExists(directory) {
  try {
    const stat = await fsp.stat(directory);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function hasMineruCacheArtifact(directory) {
  const artifactNames = [
    'paper_reader_manifest.json',
    'content_list_v2.json',
    'content_list.json',
    'middle.json',
    'full.md',
  ];

  for (const artifactName of artifactNames) {
    if (await fileExists(path.join(directory, artifactName))) {
      return true;
    }
  }

  return (
    await directoryExists(path.join(directory, 'translations')) ||
    await directoryExists(path.join(directory, 'summaries'))
  );
}

async function listPaperQuayMineruCacheEntries(rootDir) {
  try {
    const entries = await fsp.readdir(rootDir, { withFileTypes: true });
    const cacheEntries = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(rootDir, entry.name);
      const looksStandard = entry.name.startsWith('document-');

      if (looksStandard || await hasMineruCacheArtifact(entryPath)) {
        cacheEntries.push({ name: entry.name, path: entryPath });
      }
    }

    return cacheEntries;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
}

async function hasLooseMineruOutputFiles(directory) {
  try {
    const entries = await fsp.readdir(directory, { withFileTypes: true });

    return entries.some((entry) => (
      entry.isFile() && MINERU_OUTPUT_FILE_NAMES.has(entry.name.toLowerCase())
    ));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function createFileCommands(context) {
  const { appPaths, approvedWritePaths } = context;
  const capturedScreenshots = new Set();
  const pendingTextWrites = new Map();
  const screenshotRoot = path.join(canonicalPath(path.dirname(path.dirname(appPaths.configPath))), '.screenshots');
  const authorizeWrite = context.authorizeLocalWrite ||= createWriteAuthorizer(context);
  const configuredMineruCacheDir = cleanString(
    readJson(appPaths.configPath, null)?.settings?.mineruCacheDir,
  );

  if (configuredMineruCacheDir) {
    try { context.approvedWriteDirectories.add(canonicalPath(configuredMineruCacheDir)); }
    catch (error) {
      // An offline custom cache must not prevent opening the library/settings.
      // Do not grant a lexical fallback: writes remain denied until available
      // and explicitly approved or prepared again.
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }

  async function writeTextFileAtomically(filePath, content) {
    assertBoundPath(filePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${now()}-${Math.random().toString(16).slice(2)}`;

    try {
      await writeBoundFile(temporaryPath, String(content ?? ''), { encoding: 'utf8', flag: 'wx' });
      assertBoundPath(filePath);
      await fsp.rename(temporaryPath, filePath);
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function selectFiles(properties, filters, event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties, filters });
    return result.canceled ? null : result.filePaths;
  }

  return {
    async read_app_config() {
      // Both locations come from the trusted profile, not the active library.
      // No caller-supplied path: derived-text loaders must use guarded reads.
      for (const filePath of [appPaths.configPath, appPaths.legacyConfigPath].filter(Boolean)) {
        try {
          const content = (await fsp.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
          if (content.trim()) return content;
        }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
      return null;
    },

    async get_app_default_paths() {
      await fsp.mkdir(authorizeWrite(appPaths.mineruCacheDir), { recursive: true });
      await fsp.mkdir(authorizeWrite(appPaths.remotePdfDownloadDir), { recursive: true });

      return {
        executableDir: appPaths.dataDir,
        configPath: appPaths.configPath,
        mineruCacheDir: appPaths.mineruCacheDir,
        remotePdfDownloadDir: appPaths.remotePdfDownloadDir,
      };
    },

    async select_pdf_file(_args, event) {
      const paths = await selectFiles(['openFile'], [{ name: 'PDF', extensions: ['pdf'] }], event);
      return paths?.[0] ?? null;
    },

    async select_json_file(_args, event) {
      const paths = await selectFiles(['openFile'], [{ name: 'JSON', extensions: ['json'] }], event);
      return paths?.[0] ?? null;
    },

    async select_attachment_files({ kind }, event) {
      const filters =
        kind === 'image'
          ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }]
          : [{ name: 'Attachments', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'txt', 'md', 'json', 'csv', 'yaml', 'yml', 'xml', 'html', 'pdf'] }];
      return (await selectFiles(['openFile', 'multiSelections'], filters, event)) ?? [];
    },

    async capture_system_screenshot() {
      if (process.platform !== 'win32') {
        return null;
      }
      // Never grant the shared library write/read authority over captures.
      assertBoundPath(screenshotRoot);
      const outputPath = path.join(screenshotRoot, `system-screenshot-${randomUUID()}.png`);

      const previousImage = clipboard.readImage().toPNG();
      spawn('cmd', ['/C', 'start', '', 'ms-screenclip:'], { windowsHide: true, detached: true });

      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = clipboard.readImage();

        if (!image.isEmpty()) {
          const bytes = image.toPNG();
          if (!Buffer.from(bytes).equals(Buffer.from(previousImage))) {
            await writeBoundFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
            capturedScreenshots.add(outputPath);
            return {
              path: outputPath,
              name: path.basename(outputPath),
              mimeType: 'image/png',
              size: bytes.length,
            };
          }
        }
      }

      return null;
    },

    async open_external_url({ url }) {
      const trimmed = cleanString(url);
      if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error('Only http and https URLs can be opened');
      }
      await shell.openExternal(trimmed);
    },

    async select_directory({ title }, event) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },

    async prepare_mineru_cache_dir({ directory, previousDirectory }) {
      const targetDir = cleanString(directory);
      if (!targetDir) throw new Error('MinerU cache directory cannot be empty');

      const resolvedTargetDir = canonicalPath(targetDir);
      const existedBefore = await directoryExists(resolvedTargetDir);
      await fsp.mkdir(resolvedTargetDir, { recursive: true });
      context.approvedWriteDirectories.add(resolvedTargetDir);

      const looseOutputFilesIgnored = await hasLooseMineruOutputFiles(resolvedTargetDir);
      const previousDir = cleanString(previousDirectory);
      let migratedCount = 0;
      let skippedCount = 0;
      const errors = [];

      if (previousDir) {
        const resolvedPreviousDir = path.resolve(previousDir);

        if (!isSamePath(resolvedPreviousDir, resolvedTargetDir) && await directoryExists(resolvedPreviousDir)) {
          const cacheEntries = await listPaperQuayMineruCacheEntries(resolvedPreviousDir);

          for (const entry of cacheEntries) {
            const resolvedSource = path.resolve(entry.path);

            if (
              isSamePath(resolvedSource, resolvedTargetDir) ||
              isPathInside(resolvedTargetDir, resolvedSource)
            ) {
              skippedCount += 1;
              continue;
            }

            const destination = authorizeWrite(path.join(resolvedTargetDir, entry.name));

            try {
              if (await directoryExists(destination)) {
                skippedCount += 1;
                continue;
              }

              await fsp.cp(entry.path, destination, {
                recursive: true,
                force: false,
                errorOnExist: false,
                async filter(source, target) {
                  if ((await fsp.lstat(source)).isSymbolicLink()) throw new Error('Linked cache entries cannot be migrated.');
                  const actual = canonicalPath(target);
                  if (!isWithin(resolvedTargetDir, actual)) throw new Error('Cache migration destination escapes approved root.');
                  assertBoundPath(target);
                  return true;
                },
              });
              migratedCount += 1;
            } catch (error) {
              errors.push({
                name: entry.name,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }

      const markerPath = authorizeWrite(path.join(resolvedTargetDir, MINERU_CACHE_MARKER_FILE));
      const cacheEntries = await listPaperQuayMineruCacheEntries(resolvedTargetDir);
      const marker = {
        version: 1,
        product: 'PaperQuay',
        kind: 'mineru-cache-root',
        updatedAt: new Date().toISOString(),
      };

      await writeBoundFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');

      return {
        directory: resolvedTargetDir,
        created: !existedBefore,
        markerPath,
        entryCount: cacheEntries.length,
        migratedCount,
        skippedCount,
        looseOutputFilesIgnored,
        errors,
      };
    },

    async list_directory_files({ directory, extensionFilter }) {
      try {
        const entries = await fsp.readdir(directory, { withFileTypes: true });
        const extension = cleanString(extensionFilter).replace(/^\./, '').toLowerCase();
        const output = [];

        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const filePath = path.join(directory, entry.name);
          if (extension && path.extname(filePath).slice(1).toLowerCase() !== extension) continue;
          const stat = await fsp.stat(filePath);
          output.push({ path: filePath, name: entry.name, size: stat.size, modifiedAtMs: stat.mtimeMs });
        }

        return output.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },

    async select_save_pdf_path({ suggestedFileName, initialDirectory }, event) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win, {
        defaultPath: path.join(initialDirectory || appPaths.remotePdfDownloadDir, safeFileName(suggestedFileName)),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });

      if (result.canceled || !result.filePath) return null;

      approvedWritePaths.add(canonicalPath(result.filePath));
      return result.filePath;
    },

    async approve_write_path({ path: filePath }) {
      const actual = canonicalPath(filePath);
      if (await directoryExists(actual)) context.approvedWriteDirectories.add(actual);
      else approvedWritePaths.add(actual);
    },

    async path_exists({ path: filePath }) {
      return pathExists(filePath);
    },

    async read_text_file({ path: filePath }) {
      return readAuthorizedFile(filePath, context.authorizeLocalRead, 'utf8');
    },

    async read_text_file_if_exists({ path: filePath }) {
      try {
        return await readAuthorizedFile(filePath, context.authorizeLocalRead, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') return null;
        throw error;
      }
    },

    async write_text_file({ path: filePath, content }) {
      const target = authorizeWrite(filePath);
      const key = comparablePath(target);
      const text = String(content ?? '');
      // Atomic replacement prevents partial files, but overlapping replacements
      // also need ordering so a slow older save cannot overwrite newer settings.
      const previous = pendingTextWrites.get(key) ?? Promise.resolve();
      const write = previous.catch(() => {}).then(() => writeTextFileAtomically(target, text));
      pendingTextWrites.set(key, write);
      const cleanup = () => {
        if (pendingTextWrites.get(key) === write) pendingTextWrites.delete(key);
      };
      void write.then(cleanup, cleanup);
      await write;
    },

    async read_binary_file_base64({ path: filePath }) {
      if (capturedScreenshots.delete(filePath)) {
        try {
          assertBoundPath(filePath);
          return (await readAuthorizedFile(filePath)).toString('base64');
        }
        finally {
          assertBoundPath(filePath);
          await fsp.rm(filePath, { force: true });
        }
      }
      return (await readAuthorizedFile(filePath, context.authorizeLocalRead)).toString('base64');
    },

    async write_binary_file_base64({ path: filePath, contentBase64 }) {
      await writeBoundFile(authorizeWrite(filePath), Buffer.from(contentBase64, 'base64'));
    },

    async download_remote_file_to_path({ url, path: filePath, headers }) {
      const target = authorizeWrite(filePath);
      const response = await fetch(url, { headers: headers ?? undefined });
      if (!response.ok) throw new Error(`Remote download returned HTTP ${response.status}`);

      await writeBoundFile(target, Buffer.from(await response.arrayBuffer()));
    },

    library_select_pdf_files(_args, event) {
      return selectFiles(['openFile', 'multiSelections'], [{ name: 'PDF', extensions: ['pdf'] }], event).then((paths) => paths ?? []);
    },
  };
}

module.exports = { createFileCommands };
