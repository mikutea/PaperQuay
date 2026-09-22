import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { addMsiInstallMarker } = require('../packaging/windows/msiProjectCreated.cjs') as {
  addMsiInstallMarker: (xml: string, source: string) => string;
};

test('MSI project installs an MSI-only marker in the app folder', () => {
  const xml = '<Wix><ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER"><Component Id="existing"/></ComponentGroup></Wix>';
  const result = addMsiInstallMarker(xml, 'C:\\src\\marker & stamp.txt');
  assert.match(result, /<File Id="msiInstallMarker" Name="\.paperquay-msi-install"/);
  assert.match(result, /Source="C:\\src\\marker &amp; stamp\.txt"/);
  assert.ok(result.indexOf('msiInstallMarker') < result.indexOf('</ComponentGroup>'));
  assert.throws(() => addMsiInstallMarker(result, 'ignored'), /Unexpected MSI project layout/);
});
