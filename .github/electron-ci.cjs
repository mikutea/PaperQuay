// Use the same npm-pinned checksums and official URL/cache as the CI installer.
// force:false selects electron-builder's @electron/get options without bypassing
// checksum verification or changing its normal unpack/cleanup behavior.
module.exports = {
  ...require('../package.json').build,
  electronDownload: { force: false, checksums: require('electron/checksums.json') },
};
