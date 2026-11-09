import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observePdfTextScale } from '../src/pdf/textScale.ts';

function fixture() {
  let height = 1000; let removed = 0;
  const values = new Map<string, string>();
  const attributes = new Map<string, string>();
  const probe = { style: { cssText: '' }, textContent: '',
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    getBoundingClientRect: () => ({ height }), remove: () => { removed++; } };
  const container = { ownerDocument: { createElement: () => probe, body: { append: (node: unknown) => assert.equal(node, probe) } },
    style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) } };
  return { container: container as unknown as HTMLElement, probe, attributes, values,
    height(value: number) { height = value; }, removed: () => removed };
}

test('a live system text-zoom change updates only PDF glyph correction and late callbacks cannot outlive it', (context) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  let changed!: ResizeObserverCallback; let disconnected = 0;
  class Observer {
    constructor(callback: ResizeObserverCallback) { changed = callback; }
    observe(node: unknown) { assert.equal(node, data.probe); }
    disconnect() { disconnected++; }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  });
  const data = fixture(); const close = observePdfTextScale(data.container);
  assert.equal(data.values.get('--pdf-text-scale-correction'), '1');
  assert.equal(data.attributes.get('aria-hidden'), 'true');
  assert.match(data.probe.style.cssText, /position:fixed/);
  for (const scale of [1.3, 2, 0.85]) {
    data.height(1000 * scale); changed([], {} as ResizeObserver);
    assert.equal(Number(data.values.get('--pdf-text-scale-correction')) * scale, 1);
  }
  close(); data.height(2000); changed([], {} as ResizeObserver);
  assert.equal(data.values.size, 0); assert.equal(disconnected, 1); assert.equal(data.removed(), 1);
});

test('an unavailable measurement keeps default geometry and a failed observer leaves no probe or correction', (context) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: undefined });
  for (const height of [0, NaN, Infinity]) {
    const data = fixture(); data.height(height); const close = observePdfTextScale(data.container);
    assert.equal(data.values.get('--pdf-text-scale-correction'), '1'); close(); assert.equal(data.removed(), 1);
  }
  const data = fixture();
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() { throw new Error('observe failed'); } disconnect() {} } });
  assert.throws(() => observePdfTextScale(data.container), /observe failed/);
  assert.equal(data.values.size, 0); assert.equal(data.removed(), 1);
});
