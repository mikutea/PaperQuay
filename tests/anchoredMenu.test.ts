import test from 'node:test';
import assert from 'node:assert/strict';

import { placeAnchoredMenu } from '../src/utils/anchoredMenu.ts';

test('model menu opens above a bottom-docked composer without leaving the viewport', () => {
  const placement = placeAnchoredMenu({
    anchor: { left: 640, top: 760, bottom: 800, width: 190 },
    viewportWidth: 1200,
    viewportHeight: 840,
    preferredWidth: 220,
  });

  assert.equal(placement.placement, 'above');
  assert.equal(placement.top, undefined);
  assert.equal(placement.bottom, 840 - 760 + 6);
  assert.ok(placement.maxHeight <= 760 - 6 - 12);
  assert.ok(placement.maxHeight > 220);
});

test('model menu stays below when the anchor has enough room', () => {
  const placement = placeAnchoredMenu({
    anchor: { left: 240, top: 180, bottom: 220, width: 156 },
    viewportWidth: 1200,
    viewportHeight: 840,
    preferredWidth: 220,
  });

  assert.equal(placement.placement, 'below');
  assert.equal(placement.top, 226);
  assert.equal(placement.bottom, undefined);
  assert.equal(placement.width, 220);
});

test('model menu height does not exceed the selected side in a short viewport', () => {
  const placement = placeAnchoredMenu({
    anchor: { left: 40, top: 150, bottom: 190, width: 180 },
    viewportWidth: 800,
    viewportHeight: 210,
    preferredWidth: 220,
  });

  assert.equal(placement.placement, 'above');
  assert.equal(placement.maxHeight, 150 - 6 - 12);
});

test('model menu is horizontally clamped on desktop and narrow viewports', () => {
  const desktop = placeAnchoredMenu({
    anchor: { left: 1100, top: 80, bottom: 120, width: 190 },
    viewportWidth: 1200,
    viewportHeight: 800,
    preferredWidth: 220,
  });
  const narrow = placeAnchoredMenu({
    anchor: { left: 200, top: 80, bottom: 120, width: 190 },
    viewportWidth: 280,
    viewportHeight: 600,
    preferredWidth: 220,
  });

  assert.equal(desktop.left, 1200 - desktop.width - 12);
  assert.ok(narrow.left >= 12);
  assert.ok(narrow.left + narrow.width <= 280 - 12);
});
