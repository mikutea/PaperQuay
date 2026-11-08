import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateAsset } = require('../.github/scripts/cache-electron-runtime.cjs');
const version = '43.8.7';
const name = `electron-v${version}-win32-x64.zip`;
const checksum = require('electron/checksums.json')[name];
const asset = () => ({ id: 1, name, size: 151361846, state: 'uploaded', digest: `sha256:${checksum}` });
const release = () => ({ tag_name: `v${version}`, draft: false, assets: [asset()] });

test('official Electron release metadata must match the npm-pinned checksum', () => {
  assert.equal(validateAsset(release(), version, name, checksum).name, name);
  for (const field of ['digest', 'state']) {
    const value = release(); value.assets[0][field] = 'different';
    assert.throws(() => validateAsset(value, version, name, checksum), /INVALID_PINNED/);
  }
});

test('missing or duplicate Electron asset identities fail closed', () => {
  for (const assets of [[], [asset(), asset()], [null]]) {
    assert.throws(() => validateAsset({ ...release(), assets }, version, name, checksum), /MISSING_OR_DUPLICATE/);
  }
});

test('drafts, changed versions and malformed Electron releases are rejected', () => {
  for (const value of [null, {}, { ...release(), draft: true }, { ...release(), tag_name: 'v43.8.8' }]) {
    assert.throws(() => validateAsset(value, version, name, checksum), /UNEXPECTED_ELECTRON_RELEASE/);
  }
});

test('Electron release assets require bounded integer sizes and identities', () => {
  for (const [field, invalid] of [['size', 0], ['size', 268435457], ['size', 1.5], ['id', -1], ['id', true]]) {
    const value = release(); value.assets[0][field] = invalid;
    assert.throws(() => validateAsset(value, version, name, checksum), /INVALID_PINNED/);
  }
});
