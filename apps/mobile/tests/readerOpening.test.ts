import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, useRef, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { InitialPdfOpening, useInitialPdfRestore } from '../src/pdf/opening.ts';
import type { PdfVersion } from '../src/pdf/types.ts';

const version = (): PdfVersion => ({ entityId: crypto.randomUUID(), data: { paperId: crypto.randomUUID(), attachmentId: crypto.randomUUID(),
  sha256: 'a'.repeat(64), sizeBytes: 100, mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 3 } });
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve };
}

test('first manual PDF import keeps ownership after saving the first version while cache persistence is pending', async () => {
  const saved = deferred(); const cached = deferred(); const item = version(); const events: string[] = [];
  let operation!: Promise<void>; let renderer!: ReactTestRenderer;
  let activeTask: AbortController | null = null;
  const startTask = () => { activeTask?.abort(); activeTask = new AbortController(); return activeTask; };
  function ReaderOpening() {
    const opening = useRef(new InitialPdfOpening()); const [versions, setVersions] = useState<PdfVersion[]>([]);
    useInitialPdfRestore(opening.current, versions, '', false, () => {
      startTask(); events.push('automatic-cache-read-before-bytes');
    });
    return createElement('button', { onClick: () => {
      opening.current.beginExplicitOpen();
      operation = (async () => {
        const task = startTask(); events.push('manual-open');
        await saved.promise; setVersions([item]); events.push('version-published');
        await cached.promise; assert.equal(task.signal.aborted, false);
        events.push('cache-written'); events.push('document-displayed');
      })();
    } }, 'Open file');
  }
  act(() => { renderer = create(createElement(ReaderOpening)); });
  try {
    act(() => renderer.root.findByType('button').props.onClick());
    await act(async () => saved.resolve());
    assert.deepEqual(events, ['manual-open', 'version-published']);
    await act(async () => { cached.resolve(); await operation; });
    assert.deepEqual(events, ['manual-open', 'version-published', 'cache-written', 'document-displayed']);
  } finally { act(() => renderer.unmount()); }
});

test('untouched reader restores once when versions arrive; explicit selection and citation prevent automatic takeover', () => {
  const item = version(); const another = version(); const untouched = new InitialPdfOpening();
  assert.equal(untouched.claimAutomatic([], '', false), null);
  assert.equal(untouched.claimAutomatic([item, another], another.entityId, false), another);
  assert.equal(untouched.claimAutomatic([item], item.entityId, false), null);
  const manual = new InitialPdfOpening(); manual.beginExplicitOpen();
  assert.equal(manual.claimAutomatic([item], item.entityId, false), null);
  const citation = new InitialPdfOpening();
  assert.equal(citation.claimAutomatic([item], item.entityId, true), null);
  citation.beginExplicitOpen();
  assert.equal(citation.claimAutomatic([item], item.entityId, false), null);
});
