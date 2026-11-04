import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import * as core from '../packages/sync-core/src/index.ts';
import { evidenceSnapshot } from './fixtures/desktopGraphEvidence.mjs';
const require = createRequire(import.meta.url), { createGraphEvidenceExporter } = require('../electron/backend/graphEvidenceExport.cjs'), nativeFs = require('../electron/backend/nativeFs.cjs');
function temporary(t) { const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paperquay-graph-evidence-export-'))); t.after(() => { assert.equal(path.dirname(path.resolve(directory)), fs.realpathSync.native(os.tmpdir())); assert(path.basename(directory).startsWith('paperquay-graph-evidence-export-')); fs.rmSync(directory, { recursive: true, force: true }); }); return path.join(directory, 'chosen.json'); }
test('native evidence export saves the verified compact envelope and returns no filesystem path', async t => {
  const file = temporary(t), snapshot = evidenceSnapshot(); let dialogs = 0, guards = 0;
  const exporter = createGraphEvidenceExporter({ core, showSaveDialog: async options => { dialogs++; assert.deepEqual(options.filters[0].extensions, ['json']); return { canceled: false, filePath: file }; } });
  const result = await exporter.save(snapshot, { check: () => { guards++; }, checkCurrent: () => { guards++; } });
  assert.equal(result.saved, true); assert.equal(dialogs, 1); assert.equal(guards, 3); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), snapshot); assert(!('path' in result)); assert(!('filePath' in result)); assert.equal(result.bytes, fs.statSync(file).size);
});
test('native cancel preserves the preview without writing any file', async t => {
  const file = temporary(t); const result = await createGraphEvidenceExporter({ core, showSaveDialog: async () => ({ canceled: true, filePath: file }) }).save(evidenceSnapshot());
  assert.deepEqual(result, { saved: false, cancelled: true }); assert.equal(fs.existsSync(file), false);
});
test('changed source after the picker returns is rejected by the last synchronous guard before NativeFS commit', async t => {
  const file = temporary(t); let writes = 0;
  const exporter = createGraphEvidenceExporter({ core, showSaveDialog: async () => ({ canceled: false, filePath: file }), files: { ...nativeFs, writeSync() { writes++; assert.fail('No write expected'); } } });
  await assert.rejects(exporter.save(evidenceSnapshot(), { checkCurrent: () => { throw Object.assign(Error('Stale cache'), { code: 'GRAPH_EVIDENCE_PREVIEW_STALE' }); } }), { code: 'GRAPH_EVIDENCE_PREVIEW_STALE' });
  assert.equal(writes, 0); assert.equal(fs.existsSync(file), false);
});
test('tampered envelope or edge hash is rejected before opening the native save window', async () => {
  const snapshot = evidenceSnapshot(); snapshot.edges[0].description = 'Unacknowledged changed evidence'; let dialogs = 0;
  const exporter = createGraphEvidenceExporter({ core, showSaveDialog: async () => { dialogs++; return { canceled: true }; } });
  await assert.rejects(exporter.save(snapshot), { code: 'GRAPH_EVIDENCE_INTEGRITY' }); assert.equal(dialogs, 0);
});
