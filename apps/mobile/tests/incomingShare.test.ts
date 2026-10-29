import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createIncomingShareClient, IncomingShareError, INCOMING_SHARE_LIMITS, validateIncomingShareItem, validateIncomingShareList,
  validateIncomingShareMeta, incomingShareClientMatchesOwner, type IncomingShareDriver, type IncomingShareItem } from '../src/platform/incomingShare.ts';
import { assertPreparedIncomingShareSource, isPreparedIncomingShareSource, prepareIncomingShareSource } from '../src/library/incomingShare.ts';
import { createRichNoteData } from '../../../packages/sync-core/src/richNote.ts';
import { exportLibraryArchive } from '../src/library/libraryTransfer.ts';

const id = (n = 1) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ownerKey = 'https://account-a.example.test:4311|account-a';
function item(text = 'https://doi.org/10.1000/Example', patch: Partial<IncomingShareItem> = {}): IncomingShareItem {
  return { version: 1, id: id(), name: '分享文本.txt', kind: 'text', mediaType: 'text/plain', sizeBytes: new TextEncoder().encode(text).length,
    createdAt: 1_793_225_600_000, text, ...patch };
}
function meta(value = item()) { const { text: _text, ...metadata } = value; return metadata; }
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function rejects(run: () => unknown, code = 'INVALID') {
  assert.throws(run, error => error instanceof IncomingShareError && error.code === code && error.message === code);
}
function driver(change: Partial<IncomingShareDriver> = {}) {
  const calls = { list: 0, read: 0, remove: [] as string[], clear: 0, unsubscribed: 0, changed: (() => {}) as (...args: unknown[]) => void };
  const source: IncomingShareDriver = { list: async () => { calls.list++; return { items: [meta()], notice: null }; },
    read: async () => { calls.read++; return item(); }, remove: async ({ id }) => { calls.remove.push(id); }, clear: async () => { calls.clear++; },
    addListener: async (event, callback) => { assert.equal(event, 'changed'); calls.changed = callback; return { remove: async () => { calls.unsubscribed++; } }; }, ...change };
  return { source, calls, client: createIncomingShareClient(source, true, ownerKey) };
}

test('metadata listing is detached and never reads a body; notifications discard every payload field', async () => {
  const value = driver(), list = await value.client.list(); assert.equal(value.calls.read, 0); assert.deepEqual(list.items, [meta()]);
  let received: unknown[] = ['not-called']; const subscription = await value.client.subscribe((...args) => { received = args; });
  value.calls.changed({ text: 'PRIVATE_BODY', path: 'file:///private' }); assert.deepEqual(received, []);
  await subscription.remove(); assert.equal(value.calls.unsubscribed, 1);
  list.items[0].name = 'changed.txt'; assert.equal(meta().name, '分享文本.txt');
});

test('closed schemas reject hidden/symbol/unknown/accessor fields, source paths, malformed IDs and sparse arrays without reading getters', () => {
  let accessed = 0; const accessor = { ...meta() }; Object.defineProperty(accessor, 'name', { enumerable: true, get: () => { accessed++; return 'secret'; } });
  for (const value of [{ ...meta(), id: id().toUpperCase().replace('00000000', 'AAAAAAAA') }, { ...meta(), name: 'C:/private/a.json' },
    { ...meta(), name: '../a.md' }, { ...meta(), name: 'https://outside.test' }, { ...meta(), name: '..' }, { ...meta(), sourcePath: '/private' },
    { ...meta(), [Symbol('hidden')]: true }, Object.defineProperty({ ...meta() }, 'private', { value: 'body' }), accessor]) rejects(() => validateIncomingShareMeta(value));
  const sparse = new Array(1); rejects(() => validateIncomingShareList({ items: sparse, notice: null }));
  const unusual = Object.setPrototypeOf([], { map() { accessed++; } }); rejects(() => validateIncomingShareList({ items: unusual, notice: null }));
  rejects(() => validateIncomingShareList({ items: [meta()], notice: 'PRIVATE_URL' }));
  rejects(() => validateIncomingShareList({ items: [meta()], notice: null, text: 'forbidden body' })); assert.equal(accessed, 0);
});

test('UTF8 byte limits, all four slots and the complete 8MiB raw budget are exact; no implicit eviction', () => {
  assert.equal(validateIncomingShareItem(item('中😀')).sizeBytes, 7);
  rejects(() => validateIncomingShareItem(item('中😀', { sizeBytes: 3 })));
  for (const text of ['\u0000', '\u0001', '\u000b', '\ud800', '\udc00']) rejects(() => validateIncomingShareItem(item(text)));
  assert.equal(validateIncomingShareItem(item('\t\r\n')).text, '\t\r\n');
  validateIncomingShareItem(item('a'.repeat(INCOMING_SHARE_LIMITS.textBytes)));
  rejects(() => validateIncomingShareItem(item('中'.repeat(22_000))), 'TOO_LARGE');
  const full = [meta(item('a', { kind: 'file', sizeBytes: INCOMING_SHARE_LIMITS.fileBytes, id: id(1) })),
    meta(item('a', { kind: 'file', sizeBytes: INCOMING_SHARE_LIMITS.fileBytes, id: id(2) }))];
  assert.equal(validateIncomingShareList({ items: full, notice: 'FULL' }).items.length, 2);
  rejects(() => validateIncomingShareList({ items: [...full, meta(item('a', { id: id(3) }))], notice: null }), 'TOO_LARGE');
  assert.equal(validateIncomingShareList({ items: Array.from({ length: 4 }, (_, index) => meta(item('a', { id: id(index + 1) }))), notice: null }).items.length, 4);
  rejects(() => validateIncomingShareList({ items: Array.from({ length: 5 }, (_, index) => meta(item('a', { id: id(index + 1) }))), notice: null }), 'TOO_LARGE');
  rejects(() => validateIncomingShareList({ items: [meta(), meta()], notice: null }));
});

test('read binds every listed metadata field and late account/abort guards block callbacks and further operations', async () => {
  const changed = driver({ read: async () => item(undefined, { name: 'changed.txt' }) });
  await assert.rejects(changed.client.read(meta()), error => error instanceof IncomingShareError && error.code === 'CHANGED');
  let current = true; const wait = gate<unknown>(), value = driver({ read: async () => wait.promise });
  const pending = value.client.read(meta(), { current: () => current }); current = false; wait.resolve(item());
  await assert.rejects(pending, error => error instanceof IncomingShareError && error.code === 'CHANGED');
  await assert.rejects(value.client.remove(id(), { current: () => current })); await assert.rejects(value.client.clear({ current: () => current }));
  assert.deepEqual(value.calls.remove, []); assert.equal(value.calls.clear, 0);
  const abort = new AbortController(); abort.abort(); await assert.rejects(value.client.list({ signal: abort.signal })); assert.equal(value.calls.list, 0);
});

test('late listener registration is removed after retirement; errors expose fixed codes only and clear bypasses corrupt payloads', async () => {
  const wait = gate<{ remove(): Promise<void> }>(), entered = gate<void>(), controller = new AbortController(); let removed = 0;
  const value = driver({ addListener: async () => { entered.resolve(); return wait.promise; }, list: async () => ({ items: [{ text: 'PRIVATE_BODY' }], notice: 'INVALID' }) });
  const pending = value.client.subscribe(() => assert.fail('retired callback'), { signal: controller.signal });
  await entered.promise; controller.abort(); wait.resolve({ remove: async () => { removed++; } }); await assert.rejects(pending); assert.equal(removed, 1);
  await assert.rejects(value.client.list(), error => error instanceof IncomingShareError && !JSON.stringify(error).includes('PRIVATE_BODY'));
  await value.client.clear(); assert.equal(value.calls.clear, 1);
  const unavailable = createIncomingShareClient(value.source, false, ownerKey); await assert.rejects(unavailable.list(), error => error instanceof IncomingShareError && error.code === 'UNAVAILABLE');
  const throwing = driver({ read: async () => { throw new Error('token=PRIVATE file:///secret'); } });
  await assert.rejects(throwing.client.read(meta()), error => error instanceof IncomingShareError && error.message === 'READ_FAILED');
});

test('strict resolver URLs and bare DOI produce one canonical candidate without any fetch', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch'); let fetches = 0;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: () => { fetches++; throw new Error('network forbidden'); } });
  try {
    for (const text of ['10.1000/Example', 'https://doi.org/10.1000/Example', 'http://dx.doi.org/10.1000/Example', ' https://DOI.ORG/10.1000%2FExample\n']) {
      const source = await prepareIncomingShareSource(item(text)); assert.equal(source.kind, 'doi'); assert.equal(source.doi, '10.1000/example');
    }
    for (const text of ['https://doi.org.evil.test/10.1000/a', 'https://user@doi.org/10.1000/a', 'https://doi.org:443/10.1000/a',
      'https://doi.org/10.1000/a?token=private', 'https://doi.org/10.1000/a#x', 'https://doi.org/../10.1000/a',
      'https://outside.test/paper', 'Title\n10.1000/a', 'doi:10.1000/a']) {
      const source = await prepareIncomingShareSource(item(text)); assert.equal(source.kind, 'unsupported', text); assert.equal(source.doi, undefined);
    }
    const multiple = await prepareIncomingShareSource(item('10.1000/a\n10.2000/b')); assert.equal(multiple.kind, 'unsupported'); assert.equal(multiple.reason, 'MULTIPLE_DOIS');
    assert.equal(fetches, 0);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor); }
});

test('digest binds canonical metadata plus untouched source text, and prepared sources cannot be cloned or mutated into proof', async () => {
  const original = item(), source = await prepareIncomingShareSource(original);
  assert.equal(source.digest, createHash('sha256').update(JSON.stringify(validateIncomingShareItem(original))).digest('hex'));
  assert.equal(isPreparedIncomingShareSource(source), true); assert.equal(assertPreparedIncomingShareSource(source), source);
  assert.equal(isPreparedIncomingShareSource(structuredClone(source)), false); rejects(() => assertPreparedIncomingShareSource({ ...source }));
  assert.throws(() => { (source as { sourceName: string }).sourceName = 'changed'; });
  for (const patch of [{ id: id(2) }, { name: 'different.txt' }, { kind: 'file' as const }, { createdAt: original.createdAt + 1 },
    { mediaType: 'text/markdown' as const }, { text: original.text + 'x', sizeBytes: original.sizeBytes + 1 }])
    assert.notEqual((await prepareIncomingShareSource({ ...original, ...patch })).digest, source.digest);
  original.name = 'later.txt'; assert.equal(source.sourceName, '分享文本.txt');
});

test('production JSONv2/Markdown/BibTeX/RIS parsers preserve source truth and forward format warnings', async () => {
  const raw = '# Raw\r\n**bold** $x$\n![literal](https://outside.test/image.png)  ';
  const md = await prepareIncomingShareSource(item(raw, { kind: 'file', name: '原笔记.md', mediaType: 'text/markdown' }));
  assert.equal(md.kind, 'archive'); assert.equal(md.archive!.notes[0].body, raw); assert.equal(md.sourceText, raw);
  const bib = await prepareIncomingShareSource(item('@article{a,title={Preserve},author={One and Two},url={https://outside.test}}',
    { kind: 'file', name: 'library.bib', mediaType: 'application/x-bibtex' }));
  assert.equal(bib.kind, 'archive'); assert.equal(bib.archive!.papers[0].data.title, 'Preserve'); assert.ok(bib.warnings!.length > 0);
  const ris = await prepareIncomingShareSource(item('TY  - JOUR\nTI  - RIS title\nER  - \n', { kind: 'file', name: 'library.ris', mediaType: 'application/x-research-info-systems' }));
  assert.equal(ris.kind, 'archive'); assert.equal(ris.archive!.papers[0].data.title, 'RIS title');
  const rich = createRichNoteData({ paperId: null, title: '结构', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文', marks: [{ type: 'bold' }] }] }] },
    metadata: { type: 'standalone', anchors: [], tags: [], color: '#fef08a', isFavorite: false, isPinned: false,
      linkedNoteIds: [], linkedPaperIds: [], createdAt: 1, updatedAt: 1, unresolvedReferences: [] }, assets: [] });
  const archive = exportLibraryArchive([{ entityType: 'note', entityId: id(7), data: rich, revision: 1, deleted: false, pending: false, status: 'synced' }]).archive;
  const json = await prepareIncomingShareSource(item(JSON.stringify(archive), { kind: 'file', name: 'library.json', mediaType: 'application/json' }));
  assert.equal(json.kind, 'archive'); assert.deepEqual(json.archive, archive); assert.ok(Object.isFrozen(json.archive!.notes[0]));
  const corrupt = structuredClone(archive); (corrupt.notes[0] as any).document.content[0].type = 'unknown-extension';
  const rejected = await prepareIncomingShareSource(item(JSON.stringify(corrupt), { kind: 'file', name: 'bad.json', mediaType: 'application/json' }));
  assert.equal(rejected.kind, 'unsupported'); assert.equal(rejected.reason, 'INVALID_FORMAT'); assert.equal(rejected.archive, undefined);
});

test('crypto failure is fixed and a pending hash cannot cross account retirement', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => { throw new Error('PRIVATE_BYTES'); } } } });
    await assert.rejects(prepareIncomingShareSource(item()), error => error instanceof IncomingShareError && error.message === 'CRYPTO_UNAVAILABLE');
    const wait = gate<ArrayBuffer>(); let current = true;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => wait.promise } } });
    const pending = prepareIncomingShareSource(item(), { current: () => current }); current = false; wait.resolve(new ArrayBuffer(32));
    await assert.rejects(pending, error => error instanceof IncomingShareError && error.code === 'CHANGED');
  } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); }
});

test('escaped invalid Unicode/controls and damaged rich image resources never downgrade into a usable archive', async () => {
  for (const body of ['\ud800', '\u0000', '\u0001']) {
    const text = JSON.stringify({ format: 'paperquay-library', version: 1, papers: [], notes: [{ ref: 'n1', paperRef: null, title: 'N', body, format: 'markdown' }] });
    const source = await prepareIncomingShareSource(item(text, { kind: 'file', name: 'escaped.json', mediaType: 'application/json' }));
    assert.equal(source.kind, 'unsupported'); assert.equal(source.reason, 'INVALID_FORMAT'); assert.equal(source.archive, undefined);
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
  const sha256 = createHash('sha256').update(png).digest('hex');
  const rich = createRichNoteData({ paperId: null, title: '图片', document: { type: 'doc', content: [{ type: 'image', attrs: { src: `asset:sha256:${sha256}`, alt: '原图' } }] },
    metadata: { type: 'standalone', anchors: [], tags: [], color: '#fef08a', isFavorite: false, isPinned: false,
      linkedNoteIds: [], linkedPaperIds: [], createdAt: 1, updatedAt: 1, unresolvedReferences: [] },
    assets: [{ id: sha256, sha256, mediaType: 'image/png', base64: png.toString('base64'), sizeBytes: png.length, width: 1, height: 1 }] });
  const archive = exportLibraryArchive([{ entityType: 'note', entityId: id(7), data: rich, revision: 1, deleted: false, pending: false, status: 'synced' }]).archive;
  const valid = await prepareIncomingShareSource(item(JSON.stringify(archive), { kind: 'file', name: 'image.json', mediaType: 'application/json' }));
  assert.equal(valid.kind, 'archive');
  rich.assets[0].base64 = Buffer.from('corrupt bytes').toString('base64');
  const damaged = structuredClone(archive); if (damaged.notes[0].format === 'tiptap-json') damaged.notes[0].assets[0].base64 = rich.assets[0].base64;
  const invalid = await prepareIncomingShareSource(item(JSON.stringify(damaged), { kind: 'file', name: 'image.json', mediaType: 'application/json' }));
  assert.equal(invalid.kind, 'unsupported'); assert.equal(invalid.archive, undefined); assert.equal(invalid.sourceText, JSON.stringify(damaged));
});

test('stable hashed owners atomically claim at first read and another account cannot list/read/remove/clear the claimed source', async () => {
  const boxes = new Map([[id(), { value: item(), owner: null as string | null }]]), payloads: unknown[] = [];
  const policy: IncomingShareDriver = {
    list: async ({ owner }) => { payloads.push({ owner }); return { items: [...boxes.values()].filter(box => !box.owner || box.owner === owner).map(box => meta(box.value)), notice: null }; },
    read: async ({ id, owner }) => { payloads.push({ id, owner }); const box = boxes.get(id);
      if (!box || box.owner && box.owner !== owner) throw new Error(`PRIVATE ${ownerKey}`);
      box.owner = owner; return structuredClone(box.value); },
    remove: async ({ id, owner }) => { payloads.push({ id, owner }); const box = boxes.get(id); if (box?.owner && box.owner !== owner) throw new Error(`PRIVATE ${ownerKey}`); boxes.delete(id); },
    clear: async ({ owner }) => { payloads.push({ owner }); for (const [id, box] of boxes) if (!box.owner || box.owner === owner) boxes.delete(id); },
    addListener: async () => ({ remove: async () => {} }),
  };
  const a = createIncomingShareClient(policy, true, ownerKey), b = createIncomingShareClient(policy, true, 'https://account-b.example.test|account-b');
  assert.equal((await a.list()).items.length, 1); assert.equal((await b.list()).items.length, 1);
  const source = await prepareIncomingShareSource(await a.read(meta())); const ownerHash = createHash('sha256').update(ownerKey).digest('hex');
  assert.equal(boxes.get(id())!.owner, ownerHash); assert.equal((await b.list()).items.length, 0);
  await assert.rejects(b.read(meta()), error => error instanceof IncomingShareError && error.message === 'READ_FAILED');
  await assert.rejects(b.remove(id()), error => error instanceof IncomingShareError && error.message === 'REMOVE_FAILED');
  await b.clear(); assert.equal(boxes.has(id()), true);
  const relogin = createIncomingShareClient(policy, true, ownerKey); assert.equal((await relogin.list()).items.length, 1);
  await relogin.read(meta()); assert.equal(boxes.get(id())!.owner, ownerHash);
  assert.equal(incomingShareClientMatchesOwner(relogin, ownerKey), true); assert.equal(incomingShareClientMatchesOwner(a, 'other-account'), false);
  assert.ok(!JSON.stringify(payloads).includes(ownerKey)); assert.doesNotMatch(JSON.stringify(payloads), /account-a|account-b|https?:/);
  for (const payload of payloads) assert.match((payload as { owner: string }).owner, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(source).includes(ownerHash)); assert.ok(!Object.hasOwn(source, 'owner'));
  boxes.set(id(2), { value: item('# local note', { id: id(2), kind: 'file', name: 'note.md', mediaType: 'text/markdown' }), owner: null });
  const archive = await prepareIncomingShareSource(await a.read(meta(boxes.get(id(2))!.value)));
  assert.equal(archive.kind, 'archive'); assert.ok(!JSON.stringify(archive.archive).includes(ownerHash)); assert.ok(!JSON.stringify(archive).includes(ownerKey));
});

test('empty owners and a late owner hash cannot dispatch native operations; crypto errors do not disclose owner keys', async () => {
  let native = 0;
  const policy: IncomingShareDriver = { list: async () => { native++; return { items: [], notice: null }; }, read: async () => { native++; return item(); },
    remove: async () => { native++; }, clear: async () => { native++; }, addListener: async () => { native++; return { remove: async () => {} }; } };
  const empty = createIncomingShareClient(policy, true, '');
  for (const operation of [() => empty.list(), () => empty.read(meta()), () => empty.remove(id()), () => empty.clear(), () => empty.subscribe(() => {})])
    await assert.rejects(operation(), error => error instanceof IncomingShareError && error.message === 'INVALID');
  assert.equal(native, 0);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    const wait = gate<ArrayBuffer>(); let current = true;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => wait.promise } } });
    const client = createIncomingShareClient(policy, true, ownerKey), pending = client.list({ current: () => current });
    current = false; wait.resolve(new ArrayBuffer(32)); await assert.rejects(pending, error => error instanceof IncomingShareError && error.code === 'CHANGED');
    assert.equal(native, 0);
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => { throw new Error(ownerKey); } } } });
    await assert.rejects(createIncomingShareClient(policy, true, ownerKey).list(), error => error instanceof IncomingShareError && error.message === 'CRYPTO_UNAVAILABLE' && !JSON.stringify(error).includes(ownerKey));
  } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); }
});
