import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

test('theme quick toggle always changes the visible theme and retains explicit preferences', async () => {
  const original = Object.fromEntries(['window', 'document', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const dir = await mkdtemp(join(tmpdir(), 'paperquay-theme-test-'));
  try {
    for (const systemDark of [true, false]) {
      for (const saved of [null, 'system', 'light', 'dark', 'invalid']) {
        const storage = new Map<string, string>();
        if (saved !== null) storage.set('paperquay-theme-mode', saved);
        let htmlDark = false;
        let onSystemChange = () => {};
        const media = { matches: systemDark, addEventListener: (_: string, fn: () => void) => { onSystemChange = fn; }, removeEventListener() {} };
        Object.defineProperties(globalThis, {
          window: { configurable: true, value: { matchMedia: () => media } },
          document: { configurable: true, value: { documentElement: { classList: { toggle: (_: string, value: boolean) => { htmlDark = value; } } } } },
          localStorage: { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } },
        });
        const outfile = join(dir, `theme-${systemDark}-${saved}.mjs`);
        await build({ entryPoints: ['src/stores/useThemeStore.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
        const { useThemeStore } = await import(pathToFileURL(outfile).href);
        const initialDark = saved === 'dark' || (saved !== 'light' && systemDark);
        assert.equal(htmlDark, initialDark);
        for (let click = 0; click < 8; click++) {
          const before = htmlDark;
          useThemeStore.getState().toggle();
          assert.equal(htmlDark, !before, `saved=${saved}, systemDark=${systemDark}, click=${click}`);
          assert.equal(storage.get('paperquay-theme-mode'), htmlDark ? 'dark' : 'light');
        }
        const manualDark = htmlDark;
        media.matches = !systemDark;
        onSystemChange();
        assert.equal(htmlDark, manualDark, 'OS changes must not overwrite a manual choice');
        useThemeStore.getState().setMode('system');
        assert.equal(htmlDark, media.matches);
        media.matches = !media.matches;
        onSystemChange();
        assert.equal(htmlDark, media.matches, 'system following remains supported');
      }
    }
  } finally {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
