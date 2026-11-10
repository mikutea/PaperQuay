import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SystemBarsStyle} from '@capacitor/core';
import {observeSystemBarTheme} from '../src/platform/systemBarTheme.ts';

function appearance(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener(_type: string, listener: () => void) { listeners.add(listener); },
    removeEventListener(_type: string, listener: () => void) { listeners.delete(listener); },
  };
  return {query, change(dark: boolean) {
    query.matches = dark;
    for (const listener of listeners) listener();
  }, get listeners() { return listeners.size; }};
}

test('browser and desktop web surfaces never request native system bar changes', () => {
  const stop = observeSystemBarTheme(false, () => { throw Error('unexpected appearance read'); },
    async () => { throw Error('unexpected native call'); });
  stop();
});

test('a running native app reapplies light and dark bars instead of retaining its launch style', () => {
  const media = appearance(false), styles: SystemBarsStyle[] = [];
  const stop = observeSystemBarTheme(true, () => media.query, async style => { styles.push(style); });
  media.change(true);
  media.change(false);
  assert.deepEqual(styles, [SystemBarsStyle.Light, SystemBarsStyle.Dark, SystemBarsStyle.Light]);
  stop();
});

test('native dark launch is readable and disposing stops subsequent theme changes', () => {
  const media = appearance(true), styles: SystemBarsStyle[] = [];
  const stop = observeSystemBarTheme(true, () => media.query, async style => { styles.push(style); });
  assert.deepEqual(styles, [SystemBarsStyle.Dark]);
  assert.equal(media.listeners, 1);
  stop();
  assert.equal(media.listeners, 0);
  media.change(false);
  assert.deepEqual(styles, [SystemBarsStyle.Dark]);
});

test('a rejected native styling call does not interrupt startup or later appearance changes', async () => {
  const media = appearance(false);
  let calls = 0;
  const stop = observeSystemBarTheme(true, () => media.query, async () => { calls++; throw Error('unavailable'); });
  await new Promise(resolve => setImmediate(resolve));
  media.change(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  stop();
});
