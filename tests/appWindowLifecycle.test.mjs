import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createAppWindowLifecycle } = require('../electron/appWindowLifecycle.cjs');

test('last real window closes its provider synchronously even while a hidden worker exists', () => {
  let stops = 0;
  const lifecycle = createAppWindowLifecycle(() => { stops++; });
  const first = new EventEmitter(), second = new EventEmitter(), worker = new EventEmitter();
  lifecycle.attach(first); lifecycle.attach(second); assert.equal(lifecycle.count(), 2);
  worker.emit('closed'); assert.equal(lifecycle.count(), 2); assert.equal(stops, 0);
  first.emit('closed'); assert.equal(lifecycle.count(), 1); assert.equal(stops, 0);
  second.emit('closed'); assert.equal(lifecycle.count(), 0); assert.equal(stops, 1);
  second.emit('closed'); assert.equal(stops, 1);
  const reopened = new EventEmitter(); lifecycle.attach(reopened); assert.equal(lifecycle.count(), 1);
  reopened.emit('closed'); assert.equal(stops, 2);
});
