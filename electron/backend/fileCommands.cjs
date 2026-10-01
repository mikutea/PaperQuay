const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { BrowserWindow, clipboard, dialog, shell } = require('electron');
const {
  cleanString,
  ensureFile,
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
  const { appPaths, approvedWritePaths, store } = context;
  const configuredMineruCacheDir = cleanString(
    readJson(appPaths.configPath, null)?.settings?.mineruCacheDir,
  );

  if (configuredMineruCacheDir) {
    approvedWritePaths.add(path.resolve(configuredMineruCacheDir));
  }

  async function writeTextFileAtomically(filePath, content) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${now()}-${Math.random().toString(16).slice(2)}`;

    try {
      await fsp.writeFile(temporaryPath, String(content ?? ''), 'utf8');
      await fsp.rename(temporaryPath, filePath);
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  function assertWriteAllowed(filePath) {
    const absolute = path.resolve(filePath);
    const comparableAbsolute = comparablePath(absolute);
    // This exact path comes from the local profile, never imported library
    // settings. Do not grant writes to its parent or neighbouring files.
    if (comparableAbsolute === comparablePath(appPaths.configPath)) return;
    const library = store.load();
    const roots = [
      path.resolve(appPaths.dataDir),
      path.resolve(library.settings.storageDir || path.join(appPaths.dataDir, 'paperquay-data')),
    ];

    if (roots.some((root) => {
      const comparableRoot = comparablePath(root);
      return comparableAbsolute === comparableRoot ||
        comparableAbsolute.startsWith(`${comparableRoot}${path.sep}`);
    })) return;
    for (const approvedPath of approvedWritePaths) {
      const comparableApprovedPath = comparablePath(approvedPath);
      if (
        comparableAbsolute === comparableApprovedPath ||
        comparableAbsolute.startsWith(`${comparableApprovedPath}${path.sep}`)
      ) return;
    }

    throw new Error(`Writing to this path is not allowed until approved: ${filePath}`);
  }

  async function selectFiles(properties, filters, event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties, filters });
    return result.canceled ? null : result.filePaths;
  }

  return {
    async get_app_default_paths() {
      await fsp.mkdir(appPaths.mineruCacheDir, { recursive: true });
      await fsp.mkdir(appPaths.remotePdfDownloadDir, { recursive: true });

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
      await fsp.mkdir(appPaths.screenshotDir, { recursive: true });
      const outputPath = path.join(appPaths.screenshotDir, `system-screenshot-${now()}.png`);

      if (process.platform !== 'win32') {
        return null;
      }

      const previousImage = clipboard.readImage().toPNG();
      spawn('cmd', ['/C', 'start', '', 'ms-screenclip:'], { windowsHide: true, detached: true });

      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = clipboard.readImage();

        if (!image.isEmpty()) {
          const bytes = image.toPNG();
          if (!Buffer.from(bytes).equals(Buffer.from(previousImage))) {
            await fsp.writeFile(outputPath, bytes);
            const stat = await fsp.stat(outputPath);
            return {
              path: outputPath,
              name: path.basename(outputPath),
              mimeType: 'image/png',
              size: stat.size,
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

      const resolvedTargetDir = path.resolve(targetDir);
      const existedBefore = await directoryExists(resolvedTargetDir);
      await fsp.mkdir(resolvedTargetDir, { recursive: true });
      approvedWritePaths.add(resolvedTargetDir);

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

            const destination = path.join(resolvedTargetDir, entry.name);

            try {
              if (await directoryExists(destination)) {
                skippedCount += 1;
                continue;
              }

              await fsp.cp(entry.path, destination, {
                recursive: true,
                force: false,
                errorOnExist: false,
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

      const markerPath = path.join(resolvedTargetDir, MINERU_CACHE_MARKER_FILE);
      const cacheEntries = await listPaperQuayMineruCacheEntries(resolvedTargetDir);
      const marker = {
        version: 1,
        product: 'PaperQuay',
        kind: 'mineru-cache-root',
        updatedAt: new Date().toISOString(),
      };

      await fsp.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');

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

      approvedWritePaths.add(path.resolve(result.filePath));
      return result.filePath;
    },

    async approve_write_path({ path: filePath }) {
      approvedWritePaths.add(path.resolve(filePath));
    },

    async path_exists({ path: filePath }) {
      return pathExists(filePath);
    },

    async read_text_file({ path: filePath }) {
      await ensureFile(filePath);
      return fsp.readFile(filePath, 'utf8');
    },

    async read_text_file_if_exists({ path: filePath }) {
      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) return null;
        return fsp.readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        throw error;
      }
    },

    async write_text_file({ path: filePath, content }) {
      assertWriteAllowed(filePath);
      await writeTextFileAtomically(filePath, content);
    },

    async read_binary_file_base64({ path: filePath }) {
      await ensureFile(filePath);
      return (await fsp.readFile(filePath)).toString('base64');
    },

    async write_binary_file_base64({ path: filePath, contentBase64 }) {
      assertWriteAllowed(filePath);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, Buffer.from(contentBase64, 'base64'));
    },

    async download_remote_file_to_path({ url, path: filePath, headers }) {
      assertWriteAllowed(filePath);
      const response = await fetch(url, { headers: headers ?? undefined });
      if (!response.ok) throw new Error(`Remote download returned HTTP ${response.status}`);

      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    },

    library_select_pdf_files(_args, event) {
      return selectFiles(['openFile', 'multiSelections'], [{ name: 'PDF', extensions: ['pdf'] }], event).then((paths) => paths ?? []);
    },
  };
}

module.exports = { createFileCommands };
