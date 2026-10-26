import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { useReaderFocusPosition } from '../src/components/PaperReader.tsx';
import { VerifiedPdf } from '../src/pdf/engine.ts';

type Props = Parameters<typeof useReaderFocusPosition>[0];
const page = { rotate: 0, getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale,
  height: 200 * scale, transform: [scale, 0, 0, -scale, 0, 200 * scale] }) } as PDFPageProxy;
function document(load: () => Promise<PDFPageProxy> = async () => page) {
  return new VerifiedPdf({ getPage: load } as unknown as PDFDocumentProxy, 'test-hash', 1,
    [{ width: 100, height: 200, cropBox: [0, 0, 100, 200], rotation: 0, userUnit: 1 }]);
}
function props(pdf = document()): Props {
  return { pdf, pageIndex: 0, fitWidth: 400, zoom: 1, rotation: 0, continuous: true, offsets: [0],
    focus: { requestId: 'first', attachmentVersionId: 'version', sha256: 'test-hash', pageIndex: 0,
      quads: [[.1, .8, .3, .8, .3, .7, .1, .7]] }, scroll: { current: { scrollTop: 0 } as HTMLDivElement } };
}
function Harness(value: Props) { useReaderFocusPosition(value); return null; }
async function mount(value: Props) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(Harness, value)); });
  return renderer;
}
async function update(renderer: ReactTestRenderer, value: Props) {
  await act(async () => { renderer.update(createElement(Harness, value)); });
}

test('a positioned citation keeps its highlight without taking scroll back on later zoom or resize', async () => {
  const value = props(); const renderer = await mount(value);
  try {
    assert.equal(value.scroll.current!.scrollTop, 112);
    value.scroll.current!.scrollTop = 500;
    await update(renderer, { ...value, zoom: 2, offsets: [0] });
    assert.equal(value.scroll.current!.scrollTop, 500);
    await update(renderer, { ...value, fitWidth: 300, rotation: 90, offsets: [0] });
    assert.equal(value.scroll.current!.scrollTop, 500);
    assert.equal(value.focus!.quads!.length, 1);
    await update(renderer, { ...value, zoom: 2, focus: { ...value.focus!, requestId: 'next' } });
    assert.equal(value.scroll.current!.scrollTop, 272, 'a new citation still navigates');
  } finally { act(() => renderer.unmount()); }
});

test('an interrupted asynchronous page load is not consumed before the current layout can be positioned', async () => {
  const pending: { resolve: (page: PDFPageProxy) => void; reject: (error: Error) => void }[] = [];
  const pdf = document(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const value = props(pdf); const renderer = await mount(value);
  try {
    await update(renderer, { ...value, zoom: 2 });
    await act(async () => { pending[0].resolve(page); });
    assert.equal(value.scroll.current!.scrollTop, 0, 'the old layout continuation is retired');
    await act(async () => { pending[1].reject(new Error('page not ready')); });
    assert.equal(value.scroll.current!.scrollTop, 0);
    await update(renderer, { ...value, zoom: 2, offsets: [0] });
    await act(async () => { pending[2].resolve(page); });
    assert.equal(value.scroll.current!.scrollTop, 272, 'only a successful current layout consumes the request');
  } finally { act(() => renderer.unmount()); }
});

test('closing or replacing a document resets navigation and old asynchronous pages cannot scroll the replacement', async () => {
  let resolveOld!: (page: PDFPageProxy) => void;
  const old = document(() => new Promise((resolve) => { resolveOld = resolve; }));
  const value = props(old); const renderer = await mount(value);
  const replacement = document();
  try {
    await update(renderer, { ...value, pdf: replacement });
    assert.equal(value.scroll.current!.scrollTop, 112);
    value.scroll.current!.scrollTop = 600;
    await act(async () => { resolveOld(page); });
    assert.equal(value.scroll.current!.scrollTop, 600);
    await update(renderer, { ...value, pdf: null });
    await update(renderer, { ...value, pdf: replacement });
    assert.equal(value.scroll.current!.scrollTop, 112, 'a reopened document accepts the navigation again');
  } finally { act(() => renderer.unmount()); }
});
