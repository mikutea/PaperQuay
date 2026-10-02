const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createUpdatePreferences(filePath) {
  let value = { autoCheckOnStartup: true, skippedVersion: '' };
  if (filePath && fs.existsSync(filePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      value = {
        autoCheckOnStartup: saved.autoCheckOnStartup !== false,
        skippedVersion: typeof saved.skippedVersion === 'string' ? saved.skippedVersion : '',
      };
    } catch {
      // A damaged preference file must not silently re-enable network access.
      value.autoCheckOnStartup = false;
    }
  }
  return {
    read: () => ({ ...value }),
    write(patch) {
      const next = { ...value };
      if (typeof patch.autoCheckOnStartup === 'boolean') next.autoCheckOnStartup = patch.autoCheckOnStartup;
      if (typeof patch.skippedVersion === 'string' && /^(?:\d+\.\d+\.\d+-mikutea\.\d+)?$/.test(patch.skippedVersion)) {
        next.skippedVersion = patch.skippedVersion;
      }
      if (filePath) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...next }), { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, filePath);
        } finally {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
      }
      value = next;
      return this.read();
    },
  };
}

module.exports = { createUpdatePreferences };
