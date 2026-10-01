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
  const appPaths = createAppPaths(app, libraryLocation?.status().dataDirectory);
  const store = createLibraryStore(appPaths);
  const noteStore = createNoteStore(appPaths);
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
    validateLibraryFileOperation: (library, attachments) => libraryLocation?.validateFileOperation(library, attachments),
  };
  const fileCommands = createFileCommands(context);
  context.fileCommands = fileCommands;

  const commands = {
    ...fileCommands,
    ...createLibraryCommands(context),
    ...createNoteCommands(context),
    ...createAiCommands(context),
    ...createKnowledgeGraphCommands(context),
    ...createIntegrationCommands(context),
    ...createReviewCommands(context),
    ...createUpdateCommands(context),
    ...(libraryLocation ? {
      library_location_status: () => libraryLocation.status(),
      library_location_select: () => libraryLocation.selectExisting(),
      library_location_activate: (args) => libraryLocation.activateSelected(args),
    } : {}),
  };

  return {
    close() {
      noteStore.close();
      ragStore.close();
      store.close();
    },
    async invoke(command, args, event) {
      const handler = commands[command];

      if (!handler) {
        throw new Error(`Unsupported Electron command: ${command}`);
      }

      return handler(args ?? {}, event);
    },
  };
}

module.exports = { createBackend };
