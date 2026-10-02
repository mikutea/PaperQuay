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

    zotero_select_local_data_dir(_args, event) {
      return fileCommands.select_directory({ title: 'Select Zotero data directory' }, event);
    },

    zotero_list_local_collections({ options } = {}) {
      return listLocalCollections(options ?? {});
    },

    zotero_list_local_library_items({ options } = {}) {
      return listLocalLibraryItems(options ?? {});
    },

    zotero_list_local_collection_items({ options } = {}) {
      return listLocalCollectionItems(options ?? {});
    },

    zotero_list_related_notes({ options } = {}) {
      return listRelatedNotes(options ?? {});
    },
  };
}

module.exports = { createZoteroCommands };
