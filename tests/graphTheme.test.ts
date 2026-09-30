import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { graphNodeTextColor } from '../src/features/graph/graphTheme.ts';

const require = createRequire(import.meta.url);
const cytoscape = require('cytoscape');

test('graph labels use resolved colors, not minified eight-digit theme tokens', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  let color = 'rgba(255, 255, 255, 0.92)';
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ color, getPropertyValue: () => '#ffffffeb' }) });
  const cy = cytoscape({ headless: true, styleEnabled: true, elements: [{ data: { id: 'fixture' } }] });
  try {
    cy.style().selector('node').style('color', graphNodeTextColor({} as HTMLElement)).update();
    assert.equal(cy.nodes()[0].style('color'), 'rgb(255,255,255)');
    color = 'rgb(28, 25, 23)';
    cy.style().selector('node').style('color', graphNodeTextColor({} as HTMLElement)).update();
    assert.equal(cy.nodes()[0].style('color'), 'rgb(28,25,23)');
  } finally {
    cy.destroy();
    if (descriptor) Object.defineProperty(globalThis, 'getComputedStyle', descriptor);
    else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});
