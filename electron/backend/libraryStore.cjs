const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createLibraryDatabaseStore } = require('./libraryDatabaseStore.cjs');
const { hashBytes, now } = require('./utils.cjs');

const SYSTEM_CATEGORIES = [
  ['system-all', 'All Papers', 'all', 0],
  ['system-recent', 'Recently Imported', 'recent', 1],
  ['system-uncategorized', 'Uncategorized', 'uncategorized', 2],
  ['system-favorites', 'Favorites', 'favorites', 3],
];

function createAppPaths(app, dataDirectory) {
  const dataDir = dataDirectory || path.join(app.getPath('userData'), 'PaperQuay');
  const profileLibrary = path.join(app.getPath('userData'), 'PaperQuay');
  const normalizedPath = (value) => {
    let ancestor = path.resolve(value);
    const missing = [];
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
      missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
    const canonical = path.join(fs.realpathSync.native(ancestor), ...missing);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  const external = normalizedPath(dataDir) !== normalizedPath(profileLibrary);

  return {
    dataDir,
    // Model endpoints, credentials and automation belong to the trusted local
    // profile, never to a supplied/shared library selected by the user.
    configPath: path.join(app.getPath('userData'), 'PaperQuay', '.settings', 'paperquay.config.json'),
    legacyConfigPath: path.join(profileLibrary, 'paperquay-data', 'paperquay.config.json'),
    backupSnapshotDir: path.join(profileLibrary, '.backup-snapshots'),
    privateLibrarySettingsPath: external ? path.join(profileLibrary, '.settings', 'libraries',
      hashBytes(Buffer.from(normalizedPath(dataDir))) + '.json') : null,
    mineruCacheDir: path.join(dataDir, '.mineru-cache'),
    remotePdfDownloadDir: path.join(dataDir, '.downloads', 'pdfs'),
    libraryPath: path.join(dataDir, 'paperquay-library.json'),
    libraryDatabasePath: path.join(dataDir, 'paperquay-library.sqlite'),
    notesDatabasePath: path.join(dataDir, 'paperquay-notes.sqlite'),
    ragDatabasePath: path.join(dataDir, 'paperquay-rag.sqlite'),
    screenshotDir: path.join(dataDir, '.screenshots'),
  };
}

function createDefaultLibrary(appPaths) {
  const timestamp = now();

  return {
    version: 1,
    settings: {
      storageDir: path.join(appPaths.dataDir, 'paperquay-data'),
      zoteroLocalDataDir: '',
      importMode: 'copy',
      autoRenameFiles: true,
      fileNamingRule: '{author}_{year}_{title}',
      createCategoryFolders: false,
      folderWatchEnabled: false,
      backupEnabled: false,
      preserveOriginalPath: true,
      openAlexEnabled: true,
      openAlexApiKey: '',
      openAlexMailto: '',
    },
    categories: SYSTEM_CATEGORIES.map(([id, name, systemKey, sortOrder]) => ({
      id,
      name,
      parentId: null,
      sortOrder,
      isSystem: true,
      systemKey,
      createdAt: timestamp,
      updatedAt: timestamp,
      paperCount: 0,
    })),
    papers: [],
    webdav: {
      endpointUrl: '',
      remoteRoot: 'paperquay/backups',
      username: '',
      password: '',
      includePdfs: true,
      includeDerived: true,
      updatedAtMs: 0,
    },
  };
}

function normalizeLibrary(raw, appPaths) {
  const defaults = createDefaultLibrary(appPaths);
  const rawObject = raw && typeof raw === 'object' ? raw : {};
  const { ragIndexes: _legacyRagIndexes, ...rawLibrary } = rawObject;
  const library = {
    ...defaults,
    ...rawLibrary,
    settings: { ...defaults.settings, ...(rawLibrary.settings ?? {}) },
    categories: Array.isArray(rawLibrary.categories) ? rawLibrary.categories : defaults.categories,
    papers: Array.isArray(rawLibrary.papers) ? rawLibrary.papers : [],
    webdav: { ...defaults.webdav, ...(rawLibrary.webdav ?? {}) },
  };
  const existingIds = new Set(library.categories.map((category) => category.id));

  for (const category of defaults.categories) {
    if (!existingIds.has(category.id)) {
      library.categories.push(category);
    }
  }

  return library;
}

function createLibraryStore(appPaths) {
  const store = createLibraryDatabaseStore(appPaths, { normalizeLibrary });
  const privatePath = appPaths.privateLibrarySettingsPath;
  if (!privatePath) return store;

  const defaults = createDefaultLibrary(appPaths);
  const privateDefaults = () => ({ webdav: { ...defaults.webdav }, openAlexApiKey: '', openAlexMailto: '' });
  function readPrivate() {
    if (!fs.existsSync(privatePath)) return privateDefaults();
    const text = fs.readFileSync(privatePath, 'utf8');
    let value;
    try { value = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    const valid = value && typeof value === 'object' && !Array.isArray(value) &&
      value.webdav && typeof value.webdav === 'object' && !Array.isArray(value.webdav) &&
      ['endpointUrl', 'remoteRoot', 'username', 'password'].every((key) => value.webdav[key] == null || typeof value.webdav[key] === 'string') &&
      ['openAlexApiKey', 'openAlexMailto'].every((key) => value[key] == null || typeof value[key] === 'string');
    if (valid) return value;
    // Preserve the original bytes for recovery. Never restore a remote endpoint
    // or credential from the supplied library when local settings are damaged.
    fs.renameSync(privatePath, privatePath + '.' + randomUUID() + '.corrupt');
    const replacement = privateDefaults();
    writePrivate(replacement);
    return replacement;
  }
  function writePrivate(value) {
    const text = JSON.stringify(value);
    if (fs.existsSync(privatePath) && fs.readFileSync(privatePath, 'utf8') === text) return;
    fs.mkdirSync(path.dirname(privatePath), { recursive: true });
    const temporary = privatePath + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, privatePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  function withPrivate(library) {
    const local = readPrivate();
    return { ...library, webdav: { ...defaults.webdav, ...local.webdav },
      settings: { ...library.settings, openAlexApiKey: local.openAlexApiKey || '', openAlexMailto: local.openAlexMailto || '' } };
  }
  function save(library) {
    const previous = readPrivate();
    writePrivate({ webdav: library.webdav, openAlexApiKey: library.settings.openAlexApiKey || '', openAlexMailto: library.settings.openAlexMailto || '' });
    try {
      store.saveSync({ ...library, webdav: defaults.webdav,
        settings: { ...library.settings, openAlexApiKey: '', openAlexMailto: '' } });
    } catch (error) {
      writePrivate(previous);
      throw error;
    }
  }
  // Never trust imported endpoints/tokens, including snapshots restored later.
  // Keep the whole WebDAV connection local so a changed endpoint cannot receive
  // an otherwise trusted local password. No secret is serialized into this DB.
  return { ...store, load: () => withPrivate(store.load()), save, saveSync: save,
    loadFromSnapshot: (snapshotPath) => withPrivate(store.loadFromSnapshot(snapshotPath)) };
}

function categoryCounts(library) {
  const papers = library.papers;
  const counts = new Map();
  counts.set('all', papers.length);
  counts.set('recent', Math.min(30, papers.length));
  counts.set('uncategorized', papers.filter((paper) => paper.categoryIds.length === 0).length);
  counts.set('favorites', papers.filter((paper) => paper.isFavorite).length);

  for (const category of library.categories) {
    if (category.isSystem) continue;
    const descendants = new Set([category.id]);
    let changed = true;

    while (changed) {
      changed = false;
      for (const child of library.categories) {
        if (!child.isSystem && child.parentId && descendants.has(child.parentId) && !descendants.has(child.id)) {
          descendants.add(child.id);
          changed = true;
        }
      }
    }

    counts.set(category.id, papers.filter((paper) => paper.categoryIds.some((id) => descendants.has(id))).length);
  }

  return counts;
}

function attachCategoryCounts(library) {
  const counts = categoryCounts(library);

  return library.categories
    .map((category) => ({
      ...category,
      paperCount: category.isSystem ? counts.get(category.systemKey) ?? 0 : counts.get(category.id) ?? 0,
    }))
    .sort((left, right) =>
      Number(right.isSystem) - Number(left.isSystem) ||
      Number(Boolean(left.parentId)) - Number(Boolean(right.parentId)) ||
      left.sortOrder - right.sortOrder ||
      left.name.localeCompare(right.name),
    );
}

function normalizeAuthor(name, sortOrder) {
  return {
    id: `auth_${hashBytes(Buffer.from(name)).slice(0, 12)}`,
    name,
    givenName: null,
    familyName: null,
    sortOrder,
  };
}

function normalizeTag(name) {
  return {
    id: `tag_${hashBytes(Buffer.from(name.toLowerCase())).slice(0, 12)}`,
    name,
    color: null,
  };
}

function paperMatches(paper, request, library) {
  if (request?.categoryId) {
    const category = library.categories.find((item) => item.id === request.categoryId);

    if (category?.systemKey === 'recent') {
      const recentIds = new Set(
        library.papers
          .slice()
          .sort((left, right) => right.importedAt - left.importedAt || left.title.localeCompare(right.title))
          .slice(0, 30)
          .map((item) => item.id),
      );
      if (!recentIds.has(paper.id)) return false;
    } else if (category?.systemKey === 'uncategorized') {
      if (paper.categoryIds.length > 0) return false;
    } else if (category?.systemKey === 'favorites') {
      if (!paper.isFavorite) return false;
    } else if (!category?.systemKey) {
      const allowed = new Set([request.categoryId]);
      let changed = true;

      while (changed) {
        changed = false;
        for (const item of library.categories) {
          if (item.parentId && allowed.has(item.parentId) && !allowed.has(item.id)) {
            allowed.add(item.id);
            changed = true;
          }
        }
      }

      if (!paper.categoryIds.some((id) => allowed.has(id))) return false;
    }
  }

  if (request?.tagId && !paper.tags.some((tag) => tag.id === request.tagId)) return false;

  const search = typeof request?.search === 'string' ? request.search.trim().toLowerCase() : '';
  if (!search) return true;

  const haystack = [
    paper.title,
    paper.year,
    paper.publication,
    paper.doi,
    paper.abstractText,
    paper.keywords.join(' '),
    paper.authors.map((author) => author.name).join(' '),
    paper.tags.map((tag) => tag.name).join(' '),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  return haystack.includes(search);
}

function sortPapers(papers, request = {}) {
  const direction = request.sortDirection === 'asc' ? 1 : -1;
  const sortBy = request.sortBy || 'manual';
  const getValue = (paper) => {
    if (sortBy === 'title') return paper.title.toLowerCase();
    if (sortBy === 'year') return paper.year ?? '';
    if (sortBy === 'author') return paper.authors[0]?.name?.toLowerCase() ?? '';
    if (sortBy === 'updatedAt') return paper.updatedAt;
    if (sortBy === 'lastReadAt') return paper.lastReadAt ?? 0;
    if (sortBy === 'importedAt') return paper.importedAt;
    return paper.sortOrder;
  };

  return papers.slice().sort((left, right) => {
    const leftValue = getValue(left);
    const rightValue = getValue(right);
    if (leftValue < rightValue) return sortBy === 'manual' ? -1 : -1 * direction;
    if (leftValue > rightValue) return sortBy === 'manual' ? 1 : 1 * direction;
    return left.title.localeCompare(right.title);
  });
}

function webdavView(settings) {
  return {
    endpointUrl: settings.endpointUrl,
    remoteRoot: settings.remoteRoot,
    username: settings.username,
    passwordConfigured: Boolean(settings.password),
    includePdfs: settings.includePdfs !== false,
    includeDerived: settings.includeDerived !== false,
    updatedAtMs: settings.updatedAtMs || 0,
  };
}

module.exports = {
  attachCategoryCounts,
  createAppPaths,
  createLibraryStore,
  normalizeAuthor,
  normalizeTag,
  paperMatches,
  sortPapers,
  webdavView,
};
