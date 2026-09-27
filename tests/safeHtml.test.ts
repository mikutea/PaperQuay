import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeMineruTableHtml } from '../src/utils/safeHtml.ts';

class TextNode {
  parentNode: ElementNode | null = null;
  readonly text: string;
  constructor(text: string) { this.text = text; }
}

class ElementNode {
  parentNode: ElementNode | null = null;
  readonly nodes: Array<ElementNode | TextNode> = [];
  readonly tagName: string;
  readonly attributes: Array<{ name: string; value: string }>;
  constructor(tagName: string, attributes: Array<{ name: string; value: string }> = []) {
    this.tagName = tagName;
    this.attributes = attributes;
  }
  get children() { return this.nodes.filter((node): node is ElementNode => node instanceof ElementNode); }
  get firstChild() { return this.nodes[0] ?? null; }
  get innerHTML(): string {
    return this.nodes.map((node) => node instanceof TextNode
      ? node.text
      : `<${node.tagName.toLowerCase()}${node.attributes.map(({ name, value }) => ` ${name}="${value}"`).join('')}>${node.innerHTML}</${node.tagName.toLowerCase()}>`).join('');
  }
  appendChild(node: ElementNode | TextNode) { this.nodes.push(node); node.parentNode = this; }
  insertBefore(node: ElementNode | TextNode, reference: ElementNode | TextNode) {
    node.parentNode?.removeChild(node);
    this.nodes.splice(this.nodes.indexOf(reference), 0, node);
    node.parentNode = this;
  }
  removeChild(node: ElementNode | TextNode) {
    this.nodes.splice(this.nodes.indexOf(node), 1);
    node.parentNode = null;
  }
  removeAttribute(name: string) {
    const index = this.attributes.findIndex((attribute) => attribute.name === name);
    if (index >= 0) this.attributes.splice(index, 1);
  }
}

test('unwrapped table HTML descendants are sanitized before entering the Reader', () => {
  const body = new ElementNode('body');
  const table = new ElementNode('table');
  const row = new ElementNode('tr');
  const cell = new ElementNode('td');
  const wrapper = new ElementNode('div');
  const image = new ElementNode('img', [
    { name: 'src', value: 'x' }, { name: 'onerror', value: 'window.paperquay' },
  ]);
  body.appendChild(table);
  table.appendChild(row);
  row.appendChild(cell);
  cell.appendChild(wrapper);
  wrapper.appendChild(image);
  wrapper.appendChild(new TextNode('Data'));

  const previousWindow = globalThis.window;
  const previousParser = globalThis.DOMParser;
  Object.assign(globalThis, {
    window: {},
    DOMParser: class { parseFromString() { return { body, querySelectorAll: () => [] }; } },
  });
  try {
    assert.equal(
      sanitizeMineruTableHtml('<table><tr><td><div><img src=x onerror=window.paperquay>Data</div></td></tr></table>'),
      '<table><tr><td>Data</td></tr></table>',
    );
  } finally {
    Object.assign(globalThis, { window: previousWindow, DOMParser: previousParser });
  }
});
