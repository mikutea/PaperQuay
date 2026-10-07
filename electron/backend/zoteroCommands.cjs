const {
  downloadZoteroAttachmentPdf,
  listZoteroLibraryItems,
  lookupZoteroKey,
} = require('./zoteroApi.cjs');
const {
  detectLocalZoteroDataDir,
  listLocalCollections,
  listLocalLibraryItems,
  listLocalCollectionItems,
  listRelatedNotes,
} = require('./zoteroLocal.cjs');

function createZoteroCommands(context) {
  const { appPaths, fileCommands } = context;
  async function localOptions(options = {}) {
    const dataDir = options.dataDir || await detectLocalZoteroDataDir();
    const approved = await context.approveZoteroSourceRoot?.(dataDir, { detected: !options.dataDir });
    return { ...options, dataDir: approved || dataDir,
      authorizeSources: context.approveImportSources };
  }

  return {
    zotero_lookup_key({ apiKey }) {
      return lookupZoteroKey(apiKey);
    },

    zotero_list_library_items({ options }) {
      return listZoteroLibraryItems(options ?? {});
    },

    zotero_download_attachment_pdf({ options }) {
      return downloadZoteroAttachmentPdf(options ?? {}, appPaths, context.authorizeLocalWrite);
    },

    zotero_detect_local_data_dir() {
      return detectLocalZoteroDataDir();
    },

    async zotero_select_local_data_dir(_args, event) {
      const selected = await fileCommands.select_directory({ title: 'Select Zotero data directory' }, event);
      if (selected) context.rememberPickedZoteroSourceRoot?.(selected);
      return selected;
    },

    async zotero_list_local_collections({ options } = {}) {
      return listLocalCollections(await localOptions(options));
    },

    async zotero_list_local_library_items({ options } = {}) {
      return listLocalLibraryItems(await localOptions(options));
    },

    async zotero_list_local_collection_items({ options } = {}) {
      return listLocalCollectionItems(await localOptions(options));
    },

    async zotero_list_related_notes({ options } = {}) {
      return listRelatedNotes(await localOptions(options));
    },
  };
}

module.exports = { createZoteroCommands };
