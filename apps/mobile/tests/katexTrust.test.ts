import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('mobile math ignores inherited trust while preserving ordinary formulas', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../../tests/fixtures/katexTrust.cjs', import.meta.url)),
    createRequire(import.meta.url).resolve('katex'),
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
