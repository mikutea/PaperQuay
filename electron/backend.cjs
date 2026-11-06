const { createAiCommands } = require('./backend/aiCommands.cjs');
const { createAppPaths, createLibraryStore } = require('./backend/libraryStore.cjs');
const { createFileCommands } = require('./backend/fileCommands.cjs');
const { createIntegrationCommands } = require('./backend/integrationCommands.cjs');
const { createKnowledgeGraphCommands } = require('./backend/knowledgeGraphCommands.cjs');
const { createLibraryCommands } = require('./backend/libraryCommands.cjs');
const { createNoteCommands } = require('./backend/noteCommands.cjs');
const { createNoteStore } = require('./backend/noteStore.cjs');
const { createReviewCommands } = require('./backend/reviewCommands.cjs');
const { createUpdateCommands } = require('./backend/updateCommands.cjs');
const { createRadarController } = require('./backend/radarCommands.cjs');
const { createDesktopAccountCommands } = require('./backend/desktopAccountCommands.cjs');
const { createRichNoteExportCommands } = require('./backend/richNoteExport.cjs');

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createUnavailableRagStore(error) {
  const message = toErrorMessage(error);
  const fail = () => {
    throw new Error(`Local RAG storage is unavailable: ${message}`);
  };

  return {
    available: false,
    initializationError: message,
    close() {},
    migrateFromLibraryRagIndexes(legacyRagIndexes = {}) {
      return {
        migratedCount: 0,
        failedCount: Object.keys(legacyRagIndexes).length,
        errors: Object.keys(legacyRagIndexes).map((key) => ({ key, error: message })),
      };
    },
    indexDocument: fail,
    reportFailure: fail,
    getDocumentIndexStatus: fail,
    retrieveDocumentChunks: fail,
    snapshotTo: fail,
    replaceWithSnapshot: fail,
  };
}

function createRagStoreSafely(appPaths) {
  try {
    const { createRagStore } = require('./backend/ragStore.cjs');
    const ragStore = createRagStore(appPaths);
    return {
      available: true,
      ...ragStore,
    };
  } catch (error) {
    console.error('[paperquay] Local RAG storage failed to initialize', error);
    return createUnavailableRagStore(error);
  }
}

function createBackend({ app, libraryLocation }) {
  const location = libraryLocation?.status();
  const appPaths = createAppPaths(app, location?.dataDirectory, { canonicalDataDirectory: Boolean(location?.registered) });
  const store = createLibraryStore(appPaths);
  let noteStore;
  try { noteStore = createNoteStore(appPaths); }
  catch (error) { store.close(); throw error; }
  const ragStore = createRagStoreSafely(appPaths);
  const legacyRagIndexes = store.loadLegacyRagIndexes();

  if (ragStore.available && Object.keys(legacyRagIndexes).length > 0) {
    const migration = ragStore.migrateFromLibraryRagIndexes(legacyRagIndexes);

    if (migration.failedCount === 0) {
      store.clearLegacyRagIndexesSync();
    } else {
      console.warn('PaperQuay legacy RAG index migration had failures; legacy JSON indexes were kept for retry.', migration);
    }
  }

  const context = {
    app,
    appPaths,
    noteStore,
    approvedWritePaths: new Set(),
    ragStore,
    store,
    prepareForUpdate: () => libraryLocation?.rememberActive({ makeDefault: true }),
    validateLibraryFileOperation: (library, attachments, options) => libraryLocation?.validateFileOperation(library, attachments, options),
    approveLibrarySettingsChange: (previous, next) => libraryLocation?.approveSettingsChange(previous, next),
    approveImportedAttachments: (previous, attachments) => libraryLocation?.approveImportedAttachments(previous, attachments),
    validateLibraryRestoreTarget: (kind, target) => libraryLocation?.validateRestoreTarget(kind, target),
    authorizeCloudParsePath: (library, pdfPath) => libraryLocation?.authorizeCloudParsePath(library, pdfPath),
    authorizeLocalRead: (filePath) => libraryLocation?.authorizeLocalRead(store.load(), filePath),
    authorizeLocalProbe: (filePath) => libraryLocation?.authorizeKnownRead(store.load(), filePath),
  };
  const fileCommands = createFileCommands(context);
  context.fileCommands = fileCommands;
  const radar = createRadarController(context, { onChange: () => {
    const { BrowserWindow } = require('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send('paperquay:event', 'radar:changed', {});
    }
  } });
  radar.start();
  let graphProjectionIdentity = '';
  function notifyGraphProjection() {
    const projection = JSON.stringify(desktopAccount.graphProjection());
    if (projection === graphProjectionIdentity) return;
    graphProjectionIdentity = projection;
    const { BrowserWindow } = require('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send('paperquay:event', 'knowledge-graph:changed', {});
    }
  }
  const desktopAccount = createDesktopAccountCommands(context, { onGraphChange: notifyGraphProjection, onChange: (change = {}) => {
    const { BrowserWindow } = require('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send('paperquay:event', 'desktop-account:changed', change);
    }
  } });

  context.accountGraphProjection = () => desktopAccount.graphProjection();
  context.updateAccountGraphRelation = async request => {
    await desktopAccount.updateGraphRelation(request);
    return desktopAccount.graphProjection().relations.find(row => row.id === request.id);
  };
  context.deleteAccountGraphRelation = id => desktopAccount.deleteGraphRelation(id);

  const richNoteExport = createRichNoteExportCommands(context);
  const commands = {
    ...fileCommands,
    ...createLibraryCommands(context),
    ...createNoteCommands(context),
    ...createAiCommands(context),
    ...createKnowledgeGraphCommands(context),
    ...createIntegrationCommands(context),
    ...createReviewCommands(context),
    ...createUpdateCommands(context),
    ...radar.commands,
    ...desktopAccount.commands,
    ...richNoteExport.commands,
    ...(libraryLocation ? {
      library_location_status: () => libraryLocation.status(),
      library_location_select: () => libraryLocation.selectExisting(),
      library_location_activate: (args) => libraryLocation.activateSelected(args),
    } : {}),
  };

  return {
    authorizeLocalRead: context.authorizeLocalRead,
    stopDesktopProvider: () => desktopAccount.stopProvider(),
    close() {
      richNoteExport.close();
      desktopAccount.close();
      radar.close();
      noteStore.close();
      ragStore.close();
      store.close();
    },
    async invoke(command, args, event) {
      const handler = commands[command];

      if (!handler) {
        throw new Error(`Unsupported Electron command: ${command}`);
      }

      const same = (value) => typeof value === 'string' && (process.platform === 'win32' ? require('node:path').resolve(value).toLowerCase() : require('node:path').resolve(value));
      const configWrite = command === 'write_text_file' && [appPaths.configPath, appPaths.legacyConfigPath].filter(Boolean).some((file) => same(file) === same(args?.path));
      if (configWrite) await desktopAccount.configurationWillChange(String(args?.content ?? ''));
      const result = await handler(args ?? {}, event);
      if (/^(?:library_|notes_|knowledge_graph_)/.test(command)) notifyGraphProjection();
      if (configWrite) await desktopAccount.configurationDidChange();
      return result;
    },
  };
}

module.exports = { createBackend };
