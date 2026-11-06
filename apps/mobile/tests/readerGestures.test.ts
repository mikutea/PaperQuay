import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaderTapGesture, captureReaderZoomAnchor, restoreReaderZoomAnchor, type ReaderPointer } from '../src/components/readerGestures.ts';

const point = (time: number, overrides: Partial<ReaderPointer> = {}): ReaderPointer => ({
  pointerId: 1, clientX: 100, clientY: 200, time, pageIndex: 0, onText: false, ...overrides,
});
function fixture() {
  const events: string[] = []; let allowed = true;
  const gesture = new ReaderTapGesture({ allowed: () => allowed,
    tap: () => events.push('tap'), doubleTap: (value) => events.push(`zoom:${value.pageIndex}:${value.clientX}`) });
  return { gesture, events, block: () => { allowed = false; } };
}

test('tools stay visible without a user tap and a stationary tap waits only for the double-tap window', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture(); context.mock.timers.tick(60_000); assert.deepEqual(env.events, []);
  env.gesture.down(point(0), true); env.gesture.up(point(70), true);
  context.mock.timers.tick(299); assert.deepEqual(env.events, []);
  context.mock.timers.tick(1); assert.deepEqual(env.events, ['tap']); env.gesture.dispose();
});

test('two blank-page taps zoom once without toggling tools', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture();
  env.gesture.down(point(0), true); env.gesture.up(point(50), true);
  env.gesture.down(point(150, { clientX: 115 }), true); env.gesture.up(point(200, { clientX: 115 }), true);
  context.mock.timers.tick(1000);
  assert.deepEqual(env.events, ['zoom:0:115']); env.gesture.dispose();
});

test('movement, native pointer cancellation and momentum scrolling cannot hide tools', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reason of ['move', 'cancel', 'scroll']) {
    const env = fixture(); env.gesture.down(point(0), true);
    if (reason === 'move') env.gesture.move(point(20, { clientY: 211 }));
    if (reason === 'cancel') env.gesture.cancel(1);
    env.gesture.up(point(50), true);
    if (reason === 'scroll') env.gesture.interrupt();
    context.mock.timers.tick(1000); assert.deepEqual(env.events, [], reason); env.gesture.dispose();
  }
});

test('a second finger cancels the entire gesture and later one-finger taps recover', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture();
  env.gesture.down(point(0), true); env.gesture.down(point(20, { pointerId: 2 }), false);
  env.gesture.up(point(40), true); env.gesture.up(point(60, { pointerId: 2 }), false);
  context.mock.timers.tick(1000); assert.deepEqual(env.events, []);
  env.gesture.down(point(2000), true); env.gesture.up(point(2060), true);
  context.mock.timers.tick(300); assert.deepEqual(env.events, ['tap']); env.gesture.dispose();
});

test('long press, text double tap, selected text and controls remain available for their own actions', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reason of ['long', 'text', 'selection', 'control']) {
    const env = fixture();
    env.gesture.down(point(0, { onText: reason === 'text' }), reason !== 'control');
    env.gesture.up(point(reason === 'long' ? 600 : 60, { onText: reason === 'text' }), reason !== 'control');
    if (reason === 'selection') env.block();
    if (reason === 'text') {
      env.gesture.down(point(150, { onText: true }), true); env.gesture.up(point(190, { onText: true }), true);
    }
    context.mock.timers.tick(1000); assert.deepEqual(env.events, [], reason); env.gesture.dispose();
  }
});

test('unmount cancels pending tap work and cannot update a replacement reader', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture(); env.gesture.down(point(0), true); env.gesture.up(point(60), true); env.gesture.dispose();
  context.mock.timers.tick(1000); assert.deepEqual(env.events, []);
});

test('PDF zoom keeps the tapped page coordinate under the same viewport point and preserves horizontal pan', () => {
  const anchor = captureReaderZoomAnchor(7, { left: 20, top: -200, width: 400, height: 800 },
    { left: 10, top: 30, width: 300, height: 500 }, { clientX: 220, clientY: 230 });
  assert.deepEqual(anchor, { pageIndex: 7, xRatio: 0.5, yRatio: 0.5375, viewportX: 210, viewportY: 200 });
  assert.deepEqual(restoreReaderZoomAnchor(anchor, { left: 110, top: 770, width: 400, height: 800 }), { left: 100, top: 1000 });
  assert.deepEqual(restoreReaderZoomAnchor(anchor, { left: 4, top: 1000, width: 800, height: 1600 }), { left: 194, top: 1660 });
  assert.deepEqual(restoreReaderZoomAnchor(anchor, { left: 4, top: 0, width: 200, height: 400 }), { left: 0, top: 15 });
});
