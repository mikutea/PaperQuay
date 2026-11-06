import assert from 'node:assert/strict';
import test from 'node:test';
import { placeNoteExportResult } from '../src/features/notes/richNoteExportPlacement.ts';

test('the actual sidebar anchor keeps its wider result and close button inside the viewport', () => {
  const result = placeNoteExportResult({ top: 100, right: 248, bottom: 132 }, { width: 1280, height: 800 }, 200);
  assert.equal(result.left, 8); assert.equal(result.top, 140); assert.equal(result.width, 288);
  assert.ok(result.left >= 0); assert.ok(result.left + result.width <= 1280);
});

test('a low/right anchor flips above and clamps away from viewport edges', () => {
  const result = placeNoteExportResult({ top: 750, right: 1300, bottom: 782 }, { width: 1280, height: 800 }, 220);
  assert.equal(result.top, 522); assert.equal(result.left, 984); assert.ok(result.top + 220 < 800);
});

test('narrow/short windows bound width and provide a scrollable maximum height', () => {
  const result = placeNoteExportResult({ top: 70, right: 248, bottom: 102 }, { width: 260, height: 120 }, 400);
  assert.deepEqual(result, { left: 8, top: 8, width: 244, maxHeight: 104 });
  assert.equal(result.left + result.width, 252); assert.equal(result.top + result.maxHeight, 112);
});
