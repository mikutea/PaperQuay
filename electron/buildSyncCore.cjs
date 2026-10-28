const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const esbuild = require('esbuild');

// The packaged main process cannot load the workspace's TypeScript sources.
const directory = path.join(__dirname, 'generated');
const output = path.join(directory, 'desktopSyncCore.cjs');
const result = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'packages', 'sync-core', 'src', 'index.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  write: false, sourcemap: false, legalComments: 'none',
});
fs.mkdirSync(directory, { recursive: true });
const temporary = path.join(directory, `.desktopSyncCore-${randomUUID()}.tmp`);
try {
  fs.writeFileSync(temporary, result.outputFiles[0].contents, { flag: 'wx' });
  fs.renameSync(temporary, output);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
process.stdout.write('Built desktop sync core.\n');

// Reuse the desktop parser's normalization without requiring TypeScript or
// renderer modules at runtime. parse5 is bundled into this Node-only artifact.
const parsedOutput = path.join(directory, 'desktopParsedDocument.cjs');
const parsed = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'services', 'portableParsedDocument.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  write: false, sourcemap: false, legalComments: 'none',
});
const parsedTemporary = path.join(directory, `.desktopParsedDocument-${randomUUID()}.tmp`);
try {
  fs.writeFileSync(parsedTemporary, parsed.outputFiles[0].contents, { flag: 'wx' });
  fs.renameSync(parsedTemporary, parsedOutput);
} finally {
  if (fs.existsSync(parsedTemporary)) fs.unlinkSync(parsedTemporary);
}
process.stdout.write('Built desktop parsed document converter.\n');
