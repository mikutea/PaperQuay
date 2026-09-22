import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

test('Windows packages include the runtime dependency and sandbox ACL installer hook', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  ) as {
    build: {
      files: string[];
      nsis: { include?: string };
      msiProjectCreated?: string;
    };
  };

  assert.ok(packageJson.build.files.includes('node_modules/pako/**/*'));
  assert.equal(packageJson.build.nsis.include, 'packaging/windows/installer.nsh');
  assert.equal(packageJson.build.msiProjectCreated, 'packaging/windows/msiProjectCreated.cjs');

  const installerScript = fs.readFileSync(
    path.join(projectRoot, 'packaging', 'windows', 'installer.nsh'),
    'utf8',
  );

  assert.match(installerScript, /S-1-15-2-2:\(OI\)\(CI\)\(RX\)/);
  assert.match(installerScript, /icacls\.exe/i);
  assert.match(installerScript, /\.paperquay-nsis-install/);
  assert.doesNotMatch(installerScript, /(?:disable-gpu-sandbox|no-sandbox)/i);
});

test('Windows portable launch prepares its own sandbox ACL before starting the app', () => {
  const launcher = fs.readFileSync(
    path.join(projectRoot, 'packaging', 'windows', 'portable', 'Start-PaperQuay.cmd'),
    'utf8',
  );
  assert.match(launcher, /S-1-15-2-2:\(OI\)\(CI\)\(RX\)/);
  assert.ok(launcher.indexOf('icacls.exe') < launcher.indexOf('start ""'));
  assert.match(launcher, /if errorlevel 1/);
  assert.match(launcher, /set "APP_DIR=%~dp0PaperQuay-app"/);
  assert.doesNotMatch(launcher, /icacls\.exe" "%~dp0\."/i);
});

test('release workflow verifies the ASAR and publishes updater-compatible Windows assets', () => {
  const workflow = fs.readFileSync(
    path.join(projectRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  );

  assert.match(workflow, /electron:verify-package/);
  assert.match(workflow, /win-x64-portable\.zip/);
  assert.match(workflow, /Start-PaperQuay\.cmd/);
  assert.match(workflow, /release\/portable-stage/);
  assert.match(workflow, /PaperQuay-app/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.equal(workflow.match(/prerelease:\s*true/g)?.length, 3);
  assert.doesNotMatch(workflow, /prerelease:\s*false/);
});
