const fsp = require('node:fs/promises');
const path = require('node:path');
const { assertBoundPath, removeBoundFile, openAuthorizedReadFile, writeBoundFile } = require('./pathAccess.cjs');
const nativeFs = require('./nativeFs.cjs');
const {
  attachCategoryCounts,
  normalizeAuthor,
  normalizeTag,
  paperMatches,
  sortPapers,
} = require('./libraryStore.cjs');
const {
  cleanString,
  fileNameFromPath,
  hashBytes,
  id,
  isPdf,
  now,
  readRequestJson,
  safeFileName,
} = require('./utils.cjs');

const OPENALEX_API_BASE = 'https://api.openalex.org';
const LIBRARY_REFERENCE_PROGRESS_EVENT = 'paperquay://library-reference-progress';
const MAX_CROSSREF_REFERENCES_PER_PAPER = 200;

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function isSubPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pathExists(filePath) {
  return fsp.access(filePath).then(() => true).catch(() => false);
}

async function copyFileIfNeeded(sourcePath, targetPath, bound = false) {
  try { await nativeFs.copy(sourcePath, targetPath, { exclusive: true }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

async function migrateLibraryStorageDirectory(library, previousStorageDir, nextStorageDir, approval = null) {
  const previousDir = cleanString(previousStorageDir);
  const selectedDir = cleanString(nextStorageDir);
  const targetDir = selectedDir && (approval?.validateDestination(selectedDir) || selectedDir);

  if (!previousDir || !targetDir || isSamePath(previousDir, targetDir)) {
    return { copiedFiles: 0, updatedAttachments: 0 };
  }

  await nativeFs.mkdir(targetDir);
  let copiedFiles = 0;
  let updatedAttachments = 0;

  const canCopyWholeDirectory =
    !isSubPath(previousDir, targetDir) &&
    !isSubPath(targetDir, previousDir);

  if (!approval && canCopyWholeDirectory && await pathExists(previousDir)) {
    await fsp.cp(previousDir, targetDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }

  for (const paper of library.papers) {
    for (const attachment of paper.attachments ?? []) {
      if (!attachment?.storedPath) {
        continue;
      }

      const storedPath = attachment.storedPath;
      const relativePath = cleanString(attachment.relativePath) ||
        (isSubPath(previousDir, storedPath) ? path.relative(previousDir, storedPath) : '');

      if (!relativePath || !isSubPath(previousDir, storedPath)) {
        continue;
      }

      let nextPath = path.join(targetDir, relativePath);
      if (!isSubPath(targetDir, nextPath)) throw new Error('Attachment relative path escapes storage directory.');
      nextPath = approval?.validateDestination(nextPath) || nextPath;

      if (!isSamePath(storedPath, nextPath)) {
        const sourcePath = approval?.sourcePaths?.get(storedPath) || storedPath;
        if (await pathExists(sourcePath)) {
          copiedFiles += await copyFileIfNeeded(sourcePath, nextPath, Boolean(approval)) ? 1 : 0;
        }

        attachment.storedPath = nextPath;
        attachment.relativePath = relativePath;
        attachment.fileName = attachment.fileName || fileNameFromPath(nextPath);
        attachment.missing = !(await pathExists(nextPath));
        updatedAttachments += 1;
        paper.updatedAt = now();
      }
    }
  }

  return { copiedFiles, updatedAttachments };
}

function normalizeDoi(value) {
  return cleanString(value)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim()
    .toLowerCase();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (Array.isArray(value)) {
      const nextValue = value.find((item) => typeof item === 'string' && item.trim());
      if (nextValue) return nextValue.trim();
    }
  }

  return null;
}

function normalizeYear(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  const text = cleanString(value);
  const match = text.match(/\b(18|19|20|21)\d{2}\b/);
  return match?.[0] ?? null;
}

function doiUrl(doi) {
  const normalized = normalizeDoi(doi);
  return normalized ? `https://doi.org/${normalized}` : '';
}

function normalizeTitleForMatching(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(value) {
  return normalizeTitleForMatching(value)
    .split(' ')
    .filter((token) => token.length > 1);
}

function diceCoefficient(left, right) {
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightCounts = new Map();
  for (const token of rightTokens) {
    rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1);
  }

  let matches = 0;
  for (const token of leftTokens) {
    const count = rightCounts.get(token) ?? 0;
    if (count <= 0) continue;
    matches += 1;
    rightCounts.set(token, count - 1);
  }

  return (2 * matches) / (leftTokens.length + rightTokens.length);
}

function titleSimilarity(left, right) {
  const normalizedLeft = normalizeTitleForMatching(left);
  const normalizedRight = normalizeTitleForMatching(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const shorter = normalizedLeft.length < normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length < normalizedRight.length ? normalizedRight : normalizedLeft;
  const containmentScore = shorter.length >= 16 && longer.includes(shorter)
    ? Math.min(0.92, shorter.length / Math.max(longer.length, 1) + 0.18)
    : 0;

  return Math.max(diceCoefficient(normalizedLeft, normalizedRight), containmentScore);
}

function bestOpenAlexTitleMatch(results, requestedTitle) {
  const candidates = (Array.isArray(results) ? results : [])
    .map((item) => ({
      item,
      score: titleSimilarity(requestedTitle, firstString(item?.title, item?.display_name)),
    }))
    .filter((candidate) => candidate.score >= 0.78)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.item ?? null;
}

function buildUrl(base, params) {
  const url = new URL(base);

  for (const [key, value] of Object.entries(params ?? {})) {
    const normalized = cleanString(value);
    if (normalized) {
      url.searchParams.set(key, normalized);
    }
  }

  return url.toString();
}

function hasMetadataValue(metadata) {
  return Boolean(
    metadata &&
    (
      cleanString(metadata.doi) ||
      cleanString(metadata.title) ||
      cleanString(metadata.year) ||
      cleanString(metadata.publication) ||
      cleanString(metadata.url) ||
      cleanString(metadata.abstractText) ||
      (Array.isArray(metadata.authors) && metadata.authors.length > 0)
    ),
  );
}

function abstractFromOpenAlexInvertedIndex(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') {
    return null;
  }

  const positionedWords = [];

  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;

    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0) {
        positionedWords[position] = word;
      }
    }
  }

  const abstract = positionedWords.filter(Boolean).join(' ').trim();
  return abstract || null;
}

function mapOpenAlexWork(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const publication =
    item.primary_location?.source?.display_name ||
    item.host_venue?.display_name ||
    item.locations?.find((location) => location?.source?.display_name)?.source?.display_name ||
    null;
  const doi = normalizeDoi(item.doi);

  return {
    source: 'openalex',
    doi: doi || null,
    title: firstString(item.title, item.display_name),
    authors: (item.authorships ?? [])
      .map((authorship) => cleanString(authorship?.author?.display_name))
      .filter(Boolean),
    year: normalizeYear(item.publication_year ?? item.publication_date),
    publication: cleanString(publication) || null,
    url: firstString(item.primary_location?.landing_page_url, item.doi, item.id),
    abstractText: abstractFromOpenAlexInvertedIndex(item.abstract_inverted_index),
  };
}

function mapCrossrefWork(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  return {
    source: 'crossref',
    doi: normalizeDoi(item.DOI) || null,
    title: firstString(item.title),
    authors: (item.author ?? [])
      .map((author) => [author.given, author.family].filter(Boolean).join(' '))
      .map(cleanString)
      .filter(Boolean),
    year: normalizeYear(item.issued?.['date-parts']?.[0]?.[0] ?? item.published?.['date-parts']?.[0]?.[0]),
    publication: firstString(item['container-title']),
    url: firstString(item.URL, doiUrl(item.DOI)),
    abstractText: firstString(item.abstract),
  };
}

function mergeMetadataResults(...results) {
  const usefulResults = results.filter(hasMetadataValue);
  if (usefulResults.length === 0) {
    return null;
  }

  const merged = {
    source: usefulResults.map((result) => result.source).join('+'),
    doi: null,
    title: null,
    authors: [],
    year: null,
    publication: null,
    url: null,
    abstractText: null,
  };

  for (const result of usefulResults) {
    merged.doi ||= cleanString(result.doi) || null;
    merged.title ||= cleanString(result.title) || null;
    merged.year ||= cleanString(result.year) || null;
    merged.publication ||= cleanString(result.publication) || null;
    merged.url ||= cleanString(result.url) || null;
    merged.abstractText ||= cleanString(result.abstractText) || null;

    if (merged.authors.length === 0 && Array.isArray(result.authors) && result.authors.length > 0) {
      merged.authors = result.authors.map(cleanString).filter(Boolean);
    }
  }

  return merged;
}

async function lookupOpenAlexMetadata({ doi, title, settings }) {
  if (settings?.openAlexEnabled === false) {
    return null;
  }

  const params = {
    api_key: settings?.openAlexApiKey,
    mailto: settings?.openAlexMailto,
  };
  let endpoint = '';

  if (doi) {
    endpoint = buildUrl(`${OPENALEX_API_BASE}/works/${encodeURIComponent(doiUrl(doi))}`, params);
  } else if (title) {
    endpoint = buildUrl(`${OPENALEX_API_BASE}/works`, {
      ...params,
      filter: `title.search:${title}`,
      'per-page': '10',
    });
  }

  if (!endpoint) {
    return null;
  }

  const data = await readRequestJson(await fetch(endpoint), 'OpenAlex metadata');
  const item = doi ? data : bestOpenAlexTitleMatch(data?.results, title);
  return mapOpenAlexWork(item);
}

async function lookupCrossrefMetadata({ doi, title }) {
  const endpoint = doi
    ? `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    : title
      ? `https://api.crossref.org/works?rows=1&query.title=${encodeURIComponent(title)}`
      : '';

  if (!endpoint) {
    return null;
  }

  const data = await readRequestJson(await fetch(endpoint), 'Crossref metadata');
  const item = doi ? data.message : data.message?.items?.[0];
  return mapCrossrefWork(item);
}

function emitLibraryReferenceProgress(sender, payload) {
  if (!sender || typeof sender.send !== 'function') {
    return;
  }

  sender.send('paperquay:event', LIBRARY_REFERENCE_PROGRESS_EVENT, {
    updatedAt: Date.now(),
    ...payload,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function crossrefReferenceTitle(reference) {
  return firstString(
    reference?.['article-title'],
    reference?.articleTitle,
    reference?.title,
    reference?.['series-title'],
  );
}

function crossrefReferenceJournal(reference) {
  return firstString(
    reference?.['journal-title'],
    reference?.journalTitle,
    reference?.['volume-title'],
    reference?.['container-title'],
  );
}

function mapCrossrefReference(reference, index, paperId) {
  const doi = normalizeDoi(reference?.DOI || reference?.doi);
  const title = crossrefReferenceTitle(reference);
  const unstructured = firstString(reference?.unstructured, reference?.key);

  return {
    id: `ref:${paperId}:${index + 1}`,
    paperId,
    seq: index + 1,
    doi,
    title: title || '',
    authors: firstString(reference?.author) || '',
    year: normalizeYear(reference?.year),
    journal: crossrefReferenceJournal(reference) || '',
    volume: cleanString(reference?.volume),
    issue: cleanString(reference?.issue),
    pages: firstString(reference?.['first-page'], reference?.page, reference?.pages) || '',
    unstructured: unstructured || '',
  };
}

async function fetchCrossrefReferences(doi, paperId = '') {
  const normalizedDoi = normalizeDoi(doi);
  if (!normalizedDoi) {
    return [];
  }

  const endpoint = `https://api.crossref.org/works/${encodeURIComponent(normalizedDoi)}`;
  const data = await readRequestJson(await fetch(endpoint), 'Crossref references');
  const references = Array.isArray(data?.message?.reference) ? data.message.reference : [];

  return references
    .slice(0, MAX_CROSSREF_REFERENCES_PER_PAPER)
    .map((reference, index) => mapCrossrefReference(reference, index, paperId))
    .filter((reference) => reference.doi || reference.title || reference.unstructured);
}

function createLibraryCommands(context) {
  const { appPaths, store } = context;

  const commands = {
    async library_init() {
      const library = store.load();
      await store.save(library);
      return {
        settings: library.settings,
        categories: attachCategoryCounts(library),
        papers: sortPapers(library.papers, { sortBy: 'manual' }),
      };
    },

    async library_get_settings() {
      return store.load().settings;
    },

    async library_update_settings({ settings }) {
      const library = store.load();
      const nextSettings = {
        ...library.settings,
        ...settings,
        importMode: settings.importMode || library.settings.importMode,
      };
      const storageChanged = nextSettings.storageDir !== library.settings.storageDir || nextSettings.importMode !== library.settings.importMode;
      context.validateLibraryFileOperation?.(library, storageChanged ? library.papers.flatMap((paper) => paper.attachments) : [], { metadataOnly: !storageChanged });
      const previous = structuredClone(library);
      const previousStorageDir = library.settings.storageDir;
      library.settings = nextSettings;
      const approval = await context.approveLibrarySettingsChange?.(previous, library);
      if (storageChanged && library.settings.storageDir) {
        await migrateLibraryStorageDirectory(
          library,
          previousStorageDir,
          library.settings.storageDir,
          approval,
        );
        await nativeFs.mkdir(approval?.storageRoot || library.settings.storageDir);
      }
      if (approval) approval.commit(() => store.saveSync(library));
      else await store.save(library);
      return library.settings;
    },

    async library_list_categories() {
      return attachCategoryCounts(store.load());
    },

    async library_create_category({ request }) {
      const library = store.load();
      const name = cleanString(request?.name);
      if (!name) throw new Error('Category name cannot be empty');

      const parentId = request?.parentId || null;
      const category = {
        id: id('cat'),
        name,
        parentId,
        sortOrder: library.categories.filter((item) => item.parentId === parentId && !item.isSystem).length,
        isSystem: false,
        systemKey: null,
        createdAt: now(),
        updatedAt: now(),
        paperCount: 0,
      };
      library.categories.push(category);
      await store.save(library);
      return attachCategoryCounts(library).find((item) => item.id === category.id);
    },

    async library_update_category({ request }) {
      const library = store.load();
      const category = library.categories.find((item) => item.id === request.id);
      if (!category) throw new Error('Category does not exist');
      if (category.isSystem) throw new Error('System categories cannot be modified');

      if (request.name != null && cleanString(request.name)) category.name = cleanString(request.name);
      if (request.parentId !== undefined) category.parentId = request.parentId || null;
      if (request.sortOrder != null) category.sortOrder = request.sortOrder;
      category.updatedAt = now();

      await store.save(library);
      return attachCategoryCounts(library).find((item) => item.id === category.id);
    },

    async library_move_category({ request }) {
      return commands.library_update_category({
        request: {
          id: request.categoryId,
          parentId: request.parentId ?? null,
          sortOrder: request.sortOrder,
        },
      });
    },

    async library_delete_category({ categoryId }) {
      const library = store.load();
      const target = library.categories.find((item) => item.id === categoryId);
      if (!target) throw new Error('Category does not exist');
      if (target.isSystem) throw new Error('System categories cannot be deleted');

      const removeIds = new Set([categoryId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const category of library.categories) {
          if (category.parentId && removeIds.has(category.parentId) && !removeIds.has(category.id)) {
            removeIds.add(category.id);
            changed = true;
          }
        }
      }

      library.categories = library.categories.filter((item) => !removeIds.has(item.id));
      for (const paper of library.papers) {
        paper.categoryIds = paper.categoryIds.filter((id) => !removeIds.has(id));
      }
      await store.save(library);
    },

    async library_list_papers({ request = {} }) {
      const library = store.load();
      const limit = Math.max(1, Math.min(1000, request.limit ?? 300));
      return sortPapers(library.papers.filter((paper) => paperMatches(paper, request, library)), request).slice(0, limit);
    },

    async library_list_all_papers({ request = {} } = {}) {
      const library = store.load();
      return sortPapers(library.papers, request);
    },

    async library_list_papers_page({ request = {} } = {}) {
      const library = store.load();
      const pageSize = Number.isSafeInteger(request.pageSize) && request.pageSize > 0
        ? Math.min(request.pageSize, 500) : 100;
      const requestedPage = Number.isSafeInteger(request.page) && request.page >= 0 ? request.page : 0;
      const matches = sortPapers(library.papers.filter((paper) => paperMatches(paper, request, library)), request);
      const total = matches.length;
      const page = Math.min(requestedPage, Math.max(0, Math.ceil(total / pageSize) - 1));
      return { papers: matches.slice(page * pageSize, (page + 1) * pageSize), total, page, pageSize };
    },

    async library_reorder_papers({ request }) {
      const library = store.load();
      const requestedIds = request?.paperIds;
      const byId = new Map(library.papers.map((paper) => [paper.id, paper]));
      if (!Array.isArray(requestedIds) || new Set(requestedIds).size !== requestedIds.length ||
          requestedIds.some((paperId) => typeof paperId !== 'string' || !byId.has(paperId))) {
        throw new Error('Invalid paper order; refresh the library and retry.');
      }
      if (requestedIds.length < 2) return;
      // A page or filtered list occupies slots in the global manual order.
      // Replace only those slots; never move unseen papers to the beginning.
      const selected = new Set(requestedIds);
      let next = 0;
      const ordered = sortPapers(library.papers, { sortBy: 'manual' });
      const reordered = ordered.map((paper) => selected.has(paper.id) ? byId.get(requestedIds[next++]) : paper);
      reordered.forEach((paper, index) => { paper.sortOrder = index; });
      await store.save(library);
    },

    async library_import_pdfs({ request }) {
      const library = store.load();
      const approved = context.validateLibraryFileOperation?.(library, library.papers.flatMap((paper) => paper.attachments));
      const previous = structuredClone(library);
      const results = [];
      const storageDir = approved?.storageRoot || library.settings.storageDir || path.join(appPaths.dataDir, 'paperquay-data');
      const importMode = request.importMode || library.settings.importMode;
      if (!['copy', 'move', 'keep'].includes(importMode)) throw new Error('Invalid PDF import mode.');
      const sourceMappings = await context.approveImportSources?.(request.paths ?? [], { mode: importMode });
      const moveCleanup = [];

      for (const sourcePath of request.paths ?? []) {
        try {
          if (!isPdf(sourcePath)) throw new Error('Only PDF files can be imported');
          const actualSource = sourceMappings?.get(sourcePath) || sourcePath;
          const { handle } = await openAuthorizedReadFile(actualSource);
          let bytes, sourceIdentity, sourceVersion;
          try { bytes = await handle.readFile(); sourceIdentity = handle.identity; sourceVersion = handle.version; }
          finally { await handle.close(); }
          const contentHash = hashBytes(bytes);
          const duplicate = library.papers.find((paper) =>
            paper.attachments.some((attachment) => attachment.contentHash === contentHash),
          );

          if (duplicate) {
            results.push({ sourcePath, paper: duplicate, duplicated: true, existingPaperId: duplicate.id, status: 'duplicate', message: 'Duplicate PDF' });
            continue;
          }

          const metadata = request.metadata?.[sourcePath] ?? {};
          const paperId = id('paper');
          const fileName = safeFileName(fileNameFromPath(sourcePath));
          let storedPath = actualSource;
          let relativePath = null;
          if (importMode !== 'keep') {
            storedPath = path.join(storageDir, `${paperId}-${fileName}`);
            await writeBoundFile(storedPath, bytes, { flag: 'wx' });
            relativePath = path.relative(storageDir, storedPath);
          }
          const paper = {
            id: paperId,
            title: cleanString(metadata.title) || path.basename(fileName, path.extname(fileName)),
            year: metadata.year ?? null,
            publication: metadata.publication ?? null,
            doi: metadata.doi ?? null,
            url: metadata.url ?? null,
            abstractText: metadata.abstractText ?? null,
            keywords: Array.isArray(metadata.keywords) ? metadata.keywords : [],
            importedAt: now(),
            updatedAt: now(),
            lastReadAt: null,
            readingProgress: 0,
            isFavorite: false,
            userNote: null,
            aiSummary: null,
            citation: null,
            source: 'local',
            sortOrder: Math.min(0, ...library.papers.map((item) => item.sortOrder ?? 0)) - 1,
            authors: (metadata.authors ?? []).map(normalizeAuthor),
            tags: [],
            categoryIds: request.targetCategoryId ? [request.targetCategoryId] : [],
            attachments: [{
              id: id('att'),
              paperId,
              kind: 'pdf',
              originalPath: sourcePath,
              storedPath,
              relativePath,
              fileName,
              mimeType: 'application/pdf',
              fileSize: bytes.length,
              contentHash,
              createdAt: now(),
              missing: false,
            }],
          };
          library.papers.push(paper);
          results.push({ sourcePath, paper, duplicated: false, existingPaperId: null, status: 'imported', message: 'Imported' });
          if (importMode === 'move') moveCleanup.push({ actualSource, sourceIdentity, sourceVersion, sourcePath });
        } catch (error) {
          results.push({ sourcePath, paper: null, duplicated: false, existingPaperId: null, status: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
      }

      const approval = await context.approveImportedAttachments?.(previous,
        results.filter((result) => result.status === 'imported').flatMap((result) => result.paper.attachments));
      if (approval) approval.commit(() => store.saveSync(library));
      else await store.save(library);
      // Never remove a MOVE source before the destination and metadata exist.
      // An independently replaced source is retained; report the partial move.
      for (const source of moveCleanup) {
        try { await removeBoundFile(source.actualSource, { expectedIdentity: source.sourceIdentity, expectedVersion: source.sourceVersion }); }
        catch (error) {
          const result = results.find((item) => item.sourcePath === source.sourcePath);
          result.originalRetained = true;
          result.message = `Imported copy; original retained: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      for (const result of results) {
        const paper = result.status === 'imported' ? result.paper : null;
        if (!paper?.id || !paper.doi) {
          continue;
        }

        fetchCrossrefReferences(paper.doi, paper.id)
          .then((refs) => {
            if (refs.length > 0) {
              store.saveReferences(paper.id, refs);
            }
          })
          .catch((error) => {
            console.warn(`[PaperQuay] Failed to fetch Crossref references for imported paper ${paper.id}: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
      return results;
    },

    async library_assign_paper_category({ request }) {
      const library = store.load();
      const paper = library.papers.find((item) => item.id === request.paperId);
      if (!paper) throw new Error('Paper does not exist');
      if (!paper.categoryIds.includes(request.categoryId)) paper.categoryIds.push(request.categoryId);
      paper.updatedAt = now();
      await store.save(library);
      return paper;
    },

    async library_update_paper({ request }) {
      const library = store.load();
      const paper = library.papers.find((item) => item.id === request.paperId);
      if (!paper) throw new Error('Paper does not exist');

      for (const key of ['title', 'year', 'publication', 'doi', 'url', 'abstractText', 'userNote', 'aiSummary', 'citation']) {
        if (request[key] !== undefined) paper[key] = request[key];
      }
      if (request.keywords) paper.keywords = request.keywords.map(cleanString).filter(Boolean);
      if (request.authors) paper.authors = request.authors.map(cleanString).filter(Boolean).map(normalizeAuthor);
      if (request.tags) {
        const existingNames = new Map();
        for (const item of library.papers) {
          for (const tag of item.tags) {
            const name = cleanString(tag.name);
            if (name && !existingNames.has(name.toLowerCase())) {
              existingNames.set(name.toLowerCase(), name);
            }
          }
        }
        const uniqueNames = new Map();
        for (const rawName of request.tags) {
          const name = cleanString(rawName);
          const key = name.toLowerCase();
          if (key && !uniqueNames.has(key)) {
            uniqueNames.set(key, existingNames.get(key) ?? name);
          }
        }
        paper.tags = [...uniqueNames.values()].map(normalizeTag);
      }
      if (request.isFavorite != null) paper.isFavorite = Boolean(request.isFavorite);
      paper.updatedAt = now();

      await store.save(library);
      return paper;
    },

    async library_delete_paper({ request }) {
      const library = store.load();
      const paper = library.papers.find((item) => item.id === request.paperId);
      const approved = request.deleteFiles && paper
        ? context.validateLibraryFileOperation?.(library, paper.attachments) : null;
      if (request.deleteFiles && paper) {
        for (const [index, attachment] of paper.attachments.entries()) {
          const target = approved?.attachmentPaths[index] || attachment.storedPath;
          if (approved) assertBoundPath(target);
          // Leave metadata available for recovery/retry when any file fails.
          // Missing files are harmless; denied/replaced paths are not.
          await removeBoundFile(target, { force: true });
        }
      }

      library.papers = library.papers.filter((item) => item.id !== request.paperId);
      await store.save(library);
    },

    async library_relocate_attachment({ request }) {
      const library = store.load();
      context.validateLibraryFileOperation?.(library, library.papers.flatMap((paper) => paper.attachments));
      const previous = structuredClone(library);
      const paper = library.papers.find((item) => item.attachments.some((attachment) => attachment.id === request.attachmentId));
      if (!paper) throw new Error('Attachment does not exist');

      const attachment = paper.attachments.find((item) => item.id === request.attachmentId);
      const sources = await context.approveImportSources?.([request.newPath], { mode: 'keep' });
      const actualSource = sources?.get(request.newPath) || request.newPath;
      const { handle } = await openAuthorizedReadFile(actualSource);
      let bytes;
      try { bytes = await handle.readFile(); }
      finally { await handle.close(); }
      attachment.storedPath = actualSource;
      const storageDir = library.settings.storageDir || path.join(appPaths.dataDir, 'paperquay-data');
      attachment.relativePath = isSubPath(storageDir, actualSource)
        ? path.relative(storageDir, actualSource) : null;
      attachment.fileName = fileNameFromPath(actualSource);
      attachment.fileSize = bytes.length;
      attachment.contentHash = hashBytes(bytes);
      attachment.missing = false;
      paper.updatedAt = now();

      const approval = await context.approveImportedAttachments?.(previous, [attachment]);
      if (approval) approval.commit(() => store.saveSync(library));
      else await store.save(library);
      return attachment;
    },

    async library_get_paper_references({ paperId }) {
      return store.loadReferences(cleanString(paperId));
    },

    async library_fetch_paper_references({ paperId, force = false }) {
      const targetPaperId = cleanString(paperId);
      if (!targetPaperId) {
        throw new Error('Paper id is required');
      }

      const library = store.load();
      const paper = library.papers.find((item) => item.id === targetPaperId);
      if (!paper) {
        throw new Error('Paper does not exist');
      }

      if (!paper.doi) {
        return { paperId: targetPaperId, fetched: 0, skipped: true, references: [] };
      }

      const cached = store.loadReferences(targetPaperId);
      if (!force && cached.length > 0) {
        return { paperId: targetPaperId, fetched: cached.length, skipped: true, references: cached };
      }

      const refs = await fetchCrossrefReferences(paper.doi, targetPaperId);
      const saved = store.saveReferences(targetPaperId, refs);
      return { paperId: targetPaperId, fetched: saved.length, skipped: false, references: saved };
    },

    async library_fetch_all_references({ force = false } = {}, event) {
      const papers = store.load().papers.filter((paper) => normalizeDoi(paper.doi));
      let fetched = 0;
      let skipped = 0;
      let failed = 0;

      emitLibraryReferenceProgress(event?.sender, {
        status: 'running',
        current: 0,
        total: papers.length,
        fetched,
        skipped,
        failed,
      });

      for (const [index, paper] of papers.entries()) {
        const cached = store.loadReferences(paper.id);
        if (!force && cached.length > 0) {
          skipped += 1;
          emitLibraryReferenceProgress(event?.sender, {
            status: 'running',
            current: index + 1,
            total: papers.length,
            paperId: paper.id,
            title: paper.title,
            fetched,
            skipped,
            failed,
          });
          await delay(50);
          continue;
        }

        try {
          const refs = await fetchCrossrefReferences(paper.doi, paper.id);
          store.saveReferences(paper.id, refs);
          fetched += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[PaperQuay] Failed to fetch Crossref references for ${paper.id}: ${error instanceof Error ? error.message : String(error)}`);
        }

        emitLibraryReferenceProgress(event?.sender, {
          status: 'running',
          current: index + 1,
          total: papers.length,
          paperId: paper.id,
          title: paper.title,
          fetched,
          skipped,
          failed,
        });
        await delay(50);
      }

      const result = { fetched, skipped, failed };
      emitLibraryReferenceProgress(event?.sender, {
        status: failed > 0 ? 'error' : 'done',
        current: papers.length,
        total: papers.length,
        ...result,
      });
      return result;
    },

    async lookup_literature_metadata({ request }) {
      const library = store.load();
      const doi = normalizeDoi(request?.doi);
      const title = cleanString(request?.title);
      if (!doi && !title) return null;

      const [openAlexResult, crossrefResult] = await Promise.all([
        lookupOpenAlexMetadata({ doi, title, settings: library.settings }).catch(() => null),
        lookupCrossrefMetadata({ doi, title }).catch(() => null),
      ]);

      return mergeMetadataResults(openAlexResult, crossrefResult);
    },
  };

  return commands;
}

module.exports = { createLibraryCommands };
