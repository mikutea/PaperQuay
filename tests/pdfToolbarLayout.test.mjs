import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { parseFragment } from 'parse5';

test('PDF annotation colors can wrap inside a narrow panel without removing any control', async () => {
  const server = await createServer({ configFile: false, logLevel: 'silent', plugins: [react()], server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PdfViewerToolbar } = await server.ssrLoadModule('/src/features/pdf/PdfViewerToolbar.tsx');
    const html = renderToStaticMarkup(createElement(PdfViewerToolbar, {
      editorTool: 'none', annotationColors: { highlight: '#fff080', freetext: '#000000', ink: '#000000' },
      currentPage: 1, pageCount: 4, l: (zh) => zh,
      translationProgressCompleted: 0, translationProgressTotal: 0,
    }));
    const nodes = [];
    const collect = node => { nodes.push(node); for (const child of node.childNodes ?? []) collect(child); };
    collect(parseFragment(html));
    const toolbarClasses = nodes.find(node => node.tagName === 'div').attrs.find(attr => attr.name === 'class').value;
    assert.match(toolbarClasses, /max-h-\[40%\]/);
    assert.match(toolbarClasses, /\boverflow-y-auto\b/);
    const colors = nodes.filter(node => node.tagName === 'button' && node.attrs.some(attr => attr.name === 'aria-label' && /^高亮颜色 · (黄色|绿色|蓝色|粉色|红色)$/.test(attr.value)));
    assert.equal(colors.length, 5);
    const palette = colors[0].parentNode;
    assert.match(palette.attrs.find(attr => attr.name === 'class').value, /\bflex-wrap\b/);
    assert.match(palette.parentNode.attrs.find(attr => attr.name === 'class').value, /\bmax-w-full\b/);
    assert.ok(colors.every(node => node.parentNode === palette));
  } finally { await server.close(); }
});

test('PDF toolbar offers highlight before selecting text and restores the highlight palette in pointer mode', async () => {
  const server = await createServer({ configFile: false, logLevel: 'silent', plugins: [react()], server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PdfViewerToolbar } = await server.ssrLoadModule('/src/features/pdf/PdfViewerToolbar.tsx');
    const render = editorTool => renderToStaticMarkup(createElement(PdfViewerToolbar, {
      editorTool, annotationColors: { highlight: '#86efac', freetext: '#0d9488', ink: '#ca8a04' },
      hasLiveTextSelection: false, currentPage: 1, pageCount: 1, l: (zh) => zh,
      translationProgressCompleted: 0, translationProgressTotal: 0,
    }));
    assert.match(render('ink'), /手写颜色 · 黄色/);
    assert.match(render('none'), /高亮颜色 · 绿色/);
    assert.doesNotMatch(render('none'), /手写颜色/);
    const fragment = parseFragment(render('highlight'));
    const nodes = [];
    const walk = node => { nodes.push(node); for (const child of node.childNodes ?? []) walk(child); };
    walk(fragment);
    const button = nodes.find(node => node.tagName === 'button' && node.attrs.some(attr => attr.name === 'aria-label' && attr.value.startsWith('高亮：')));
    assert.ok(button);
    assert.ok(!button.attrs.some(attr => attr.name === 'disabled'));
    assert.ok(button.attrs.some(attr => attr.name === 'aria-pressed' && attr.value === 'true'));
  } finally { await server.close(); }
});
