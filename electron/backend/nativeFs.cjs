const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Node-API 8 binaries are shared by Node and Electron. Never fall back to
// pathname writes/deletes if a build is absent or cannot be loaded.
const binding = require(path.join(__dirname, '..', 'native', 'bin', `${process.platform}-${process.arch}`, 'paperquay_fs.node'));
const temporary = () => `.paperquay-${randomUUID()}.tmp`;
const request = (operation, filePath, options = {}) => ({ operation, path: filePath, ...options });
module.exports = {
  inspectSync: (filePath) => binding.runSync(request('inspect', filePath)),
  mkdir: (filePath) => binding.run(request('mkdir', filePath)),
  mkdirSync: (filePath) => binding.runSync(request('mkdir', filePath)),
  list: async (filePath) => (await binding.run(request('list', filePath))).entries,
  write: (filePath, bytes, options = {}) => binding.run(request('write', filePath, { bytes: Buffer.from(bytes), temporary: temporary(), ...options })),
  writeSync: (filePath, bytes, options = {}) => binding.runSync(request('write', filePath, { bytes: Buffer.from(bytes), temporary: temporary(), ...options })),
  copy: (source, destination, options = {}) => binding.run(request('copy', source, { destination, temporary: temporary(), ...options })),
  read: (filePath, options = {}) => binding.run(request('read', filePath, options)),
  readSync: (filePath, options = {}) => binding.runSync(request('read', filePath, options)),
  openRead: (filePath) => binding.run(request('openRead', filePath)),
  remove: (filePath, options = {}) => binding.run(request('remove', filePath, options)),
};
