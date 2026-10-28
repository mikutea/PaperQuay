import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createRichNoteData, validateRichNoteData, richNoteText, RichNoteError,
  RICH_NOTE_DATA_SCHEMA, RICH_NOTE_LIMITS,
  richNoteUnresolvedId, parseRichNoteUnresolvedId,
  type RichNoteAsset, type RichNoteData, type RichNoteMetadata, type RichNoteNode,
} from '../packages/sync-core/src/richNote.ts';

const paper = '00000000-0000-4000-8000-000000000001';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
function image(bytes: Buffer = png): RichNoteAsset {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { id: digest, mediaType: 'image/png', base64: bytes.toString('base64'), sha256: digest, sizeBytes: bytes.length, width: 1, height: 1 };
}
const text = (value: string): RichNoteNode => ({ type: 'text', text: value });
const p = (value = ''): RichNoteNode => ({ type: 'paragraph', content: value ? [text(value)] : [] });
function meta(): RichNoteMetadata {
  return { type: 'standalone', anchors: [], tags: ['中文', 'physics'], color: '#fef08a', isFavorite: true, isPinned: false,
    linkedNoteIds: [], linkedPaperIds: [], createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001, unresolvedReferences: [] };
}
function build(document: RichNoteNode = { type: 'doc', content: [p('中文正文')] }, metadata = meta(), assets: RichNoteAsset[] = []): RichNoteData {
  return createRichNoteData({ paperId: paper, title: '富文本笔记 🧪', document, metadata, assets });
}
function fails(run: () => unknown, code?: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RichNoteError);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, error.code);
    assert.doesNotMatch(error.message, /private|secret|file:|C:|server/);
    return true;
  });
}
function fixture(): RichNoteData {
  const asset = image(), metadata = meta();
  metadata.type = 'highlight';
  metadata.excerpt = '来源摘录'; metadata.linkedPaperId = paper; metadata.folderId = 'folder_1';
  metadata.aiChatId = 'chat_1'; metadata.aiChatMessageIds = ['message_1'];
  metadata.linkedNoteIds = ['note_1']; metadata.linkedPaperIds = [paper];
  metadata.unresolvedReferences = [{ kind: 'folder', id: 'folder_1', label: '原文件夹', reason: 'unmapped' }];
  metadata.pdfLocation = { pageNumber: 2, bbox: [10, 20, 30, 40], bboxCoordinateSystem: 'pdf', bboxPageSize: [600, 800], highlightColor: '#fef08a' };
  metadata.anchors = [{ id: 'anchor_1', label: 'P2', excerpt: '旧摘录', sourceTitle: '论文', source: 'pdf', paperId: paper,
    blockId: 'block_1', pageIndex: 1, pdfLocation: { ...metadata.pdfLocation, boundingRect: { x: 1.5, y: 2, width: 30, height: 40 } }, createdAt: metadata.createdAt, verification: 'unverified' }];
  const document: RichNoteNode = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [text('标题')] },
    { type: 'paragraph', content: [
      { type: 'text', text: '所有标记', marks: [
        { type: 'bold' }, { type: 'italic' }, { type: 'strike' }, { type: 'underline' },
        { type: 'highlight', attrs: { color: 'rgba(255, 255, 0, 0.5)' } },
        { type: 'link', attrs: { href: 'https://doi.org/10.1000/example', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: '论文' } },
      ] },
      { type: 'text', text: 'inline_code', marks: [{ type: 'code' }] },
      { type: 'hardBreak' }, { type: 'inlineMath', attrs: { latex: 'E=mc^2' } },
      { type: 'noteAnchorLink', attrs: { anchorId: 'anchor_1', label: 'P2' } },
      { type: 'wikiLink', attrs: { id: 'note_1', label: '同伴笔记' } },
      { type: 'hashTag', attrs: { tag: '中文' } },
      { type: 'paperReference', attrs: { paperId: paper, label: '论文' } },
    ] },
    { type: 'blockquote', content: [p('引用')] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [p('条目')] }] },
    { type: 'orderedList', attrs: { start: 3, type: 'I' }, content: [{ type: 'listItem', content: [p('第三项')] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('已完成'), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p('嵌套任务')] }] }] }] },
    { type: 'codeBlock', attrs: { language: 'python' }, content: [text('print("中文")\n')] },
    { type: 'horizontalRule' }, { type: 'blockMath', attrs: { latex: '\\int_0^1 x^2 dx' } },
    { type: 'table', content: [
      { type: 'tableRow', content: [
        { type: 'tableHeader', attrs: { rowspan: 2, colspan: 1, colwidth: [120], align: 'center' }, content: [p('合并行')] },
        { type: 'tableHeader', attrs: { rowspan: 1, colspan: 2, colwidth: [130, 140], align: null }, content: [p('合并列')] },
      ] },
      { type: 'tableRow', content: [
        { type: 'tableCell', attrs: { rowspan: 1, colspan: 1, colwidth: null, align: 'right' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '富文本', marks: [{ type: 'bold' }] }, { type: 'inlineMath', attrs: { latex: 'x_i' } }] }] },
        { type: 'tableCell', attrs: { rowspan: 1, colspan: 1, colwidth: [140], align: 'left' }, content: [p('表格末格')] },
      ] },
    ] },
    { type: 'image', attrs: { src: `asset:sha256:${asset.id}`, alt: '一像素图', title: '图题', width: 1, height: null } },
    { type: 'noteComponentBlock', attrs: { title: '组件', variant: 'note' }, content: [p('组件内容')] },
    { type: 'noteAnchorBlock', attrs: { anchorId: 'anchor_1', label: 'P2', sourceLabel: '摘录', sourceTitle: '论文', excerpt: '旧摘录' } },
  ] };
  return build(document, metadata, [asset]);
}

test('canonical round trip preserves every supported desktop node, mark, attribute and sidecar', () => {
  const data = fixture();
  const serialized = JSON.stringify(data);
  assert.equal(JSON.stringify(validateRichNoteData(JSON.parse(serialized))), serialized);
  assert.deepEqual(validateRichNoteData(data), data);
  assert.equal(data.body, richNoteText(data.document));
  assert.match(data.body, /E=mc\^2/); assert.match(data.body, /x_i/); assert.match(data.body, /组件内容/);
  assert.match(data.body, /旧摘录/); assert.match(data.body, /一像素图/);
  assert.equal(data.metadata.anchors[0].verification, 'unverified');
  assert.equal(Object.hasOwn(data.metadata.anchors[0], 'attachmentVersionId'), false);
  assert.equal(data.assets[0].sha256, createHash('sha256').update(png).digest('hex'));
});

test('changing one node preserves every unrelated rich structure and returns detached data', () => {
  const original = fixture(), edited = structuredClone(original);
  edited.document.content![0].content![0].text = '新标题';
  const result = createRichNoteData({ paperId: edited.paperId, title: edited.title, document: edited.document, metadata: edited.metadata, assets: edited.assets });
  assert.deepEqual(result.document.content!.slice(1), original.document.content!.slice(1));
  assert.deepEqual(result.metadata, original.metadata); assert.deepEqual(result.assets, original.assets);
  edited.metadata.tags.push('later'); edited.document.content![1].content![0].text = 'later';
  assert.deepEqual(result.metadata, original.metadata);
  assert.notEqual(result.document.content![1].content![0].text, 'later');
  assert.equal(original.document.content![0].content![0].text, '标题');
});

test('body is an exact deterministic derivative and never an independent editable fallback', () => {
  const data = build();
  fails(() => validateRichNoteData({ ...data, body: '正文丢失' }), 'BODY_MISMATCH');
  assert.equal(build({ type: 'doc', content: [p('  原样  '), p('C:/example and https://example.org are prose')] }).body, '  原样  \nC:/example and https://example.org are prose');
  assert.equal(richNoteText({ type: 'doc', content: [{ type: 'paragraph', content: [text('A'), { type: 'hardBreak' }, text('B')] }] }), 'A\nB');
});

test('unknown fields, extension nodes, marks and attrs are rejected instead of stripped', () => {
  const data = build();
  for (const changed of [
    { ...data, contentHtml: '<script>secret</script>' },
    { ...data, metadata: { ...data.metadata, password: 'secret' } },
    { ...data, document: { type: 'doc', content: [{ type: 'video', attrs: { src: 'https://example.org/private' } }] } },
    { ...data, document: { type: 'doc', content: [{ type: 'paragraph', attrs: { style: 'background:url(file:///C:/private)' } }] } },
    { ...data, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle' }] }] }] } },
  ]) fails(() => validateRichNoteData(changed));
  assert.deepEqual(data, build());
});

test('historical anchors retain original coordinate fields and cannot assert a current PDF version', () => {
  const data = fixture(), anchor = data.metadata.anchors[0];
  assert.deepEqual(validateRichNoteData(data).metadata.anchors[0], anchor);
  for (const extra of [{ attachmentVersionId: paper }, { sha256: 'a'.repeat(64) }, { verification: 'version-bound' }]) {
    fails(() => validateRichNoteData({ ...data, metadata: { ...data.metadata, anchors: [{ ...anchor, ...extra }] } }));
  }
  fails(() => validateRichNoteData({ ...data, metadata: { ...data.metadata, anchors: [{ ...anchor, pageIndex: 4 }] } }));
});

test('missing anchor sidecars and unresolved document references are never silently dropped', () => {
  const data = fixture();
  fails(() => validateRichNoteData({ ...data, metadata: { ...data.metadata, anchors: [] } }));
  fails(() => validateRichNoteData({ ...data, metadata: { ...data.metadata, linkedNoteIds: [] } }));
  const changed = structuredClone(data); changed.metadata.linkedNoteIds = [];
  changed.metadata.unresolvedReferences.push({ kind: 'note', id: 'note_1', label: '同伴笔记', reason: 'unmapped' });
  assert.deepEqual(validateRichNoteData(changed).document, data.document);
  fails(() => validateRichNoteData({ ...data, metadata: { ...data.metadata, linkedPaperIds: [] } }));
});

test('unsafe resource links are rejected, citation links are retained without normalization', () => {
  function linked(href: string) {
    return build({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'citation', marks: [{ type: 'link', attrs: { href } }] }] }] });
  }
  for (const target of [
    'file:///C:/private/a', 'C:/private/a', 'C:\\private\\a', '\\\\server\\share\\a', '../private/a', '//example.org/a',
    'javascript:alert(1)', 'data:text/html,secret', 'blob:https://example.org/a',
    'https://user:secret@example.org/a', 'https://example.org/a?access_token=secret',
    'https://example.org/a?API_KEY=secret', 'https://example.org/a?signature=secret',
    'https://example.org/a?to%256ben=secret', 'https://example.org/a#access_token=secret',
    'https://example.org/a?sig=secret', 'https://example.org/a?code=secret',
    'http://127.0.0.1/a', 'http://2130706433/a', 'http://192.168.1.1/a', 'http://[::1]/a',
    'https://example.org/a?next=file%253A%252F%252F%252FC%253A%252Fprivate',
    'https://example.org/a%0aAuthorization:secret',
  ]) fails(() => linked(target), 'UNSUPPORTED_CONTENT');
  const citation = 'https://doi.org/10.1000/中文?q=paper#section-2';
  assert.equal(linked(citation).document.content![0].content![0].marks![0].attrs!.href, citation);
});

test('image payload hash, magic, dimensions, size and exact resource references are checked', () => {
  const data = fixture(), good = data.assets[0];
  const invalid = [
    { ...good, sha256: '0'.repeat(64), id: '0'.repeat(64) },
    { ...good, width: 2 }, { ...good, mediaType: 'image/jpeg' }, { ...good, sizeBytes: good.sizeBytes + 1 },
    { ...good, base64: `${good.base64.slice(0, -1)}A` }, { ...good, sourcePath: 'C:/private/a.png' },
    image(Buffer.from('not an image')),
  ];
  for (const asset of invalid) fails(() => validateRichNoteData({ ...data, assets: [asset] }));
  fails(() => validateRichNoteData({ ...data, assets: [] }), 'INVALID_ASSET');
  fails(() => validateRichNoteData({ ...data, assets: [good, good] }), 'INVALID_ASSET');
  fails(() => build(undefined, meta(), [good]), 'INVALID_ASSET');
  for (const src of ['data:image/png;base64,AAAA', 'blob:https://example.org/private', 'https://example.org/image.png', 'file:///C:/private/a.png']) {
    fails(() => build({ type: 'doc', content: [{ type: 'image', attrs: { src } }] }, meta(), [good]));
  }
});

test('image SHA256 covers multiple blocks and all padding lengths against node crypto', () => {
  // Header inspection is deliberately not a complete PNG decoder. These synthetic
  // IDAT variants exercise SHA padding; actual renderers must still decode images.
  for (const extra of [0, 1, 2, 55, 56, 63, 64, 65, 1024]) {
    const bytes = Buffer.from(png); const idat = bytes.indexOf('IDAT');
    const oldLength = bytes.readUInt32BE(idat - 4);
    const added = Buffer.alloc(extra, 42);
    const changed = Buffer.concat([bytes.subarray(0, idat + 4 + oldLength), added, bytes.subarray(idat + 4 + oldLength)]);
    changed.writeUInt32BE(oldLength + extra, idat - 4);
    const asset = image(changed);
    const result = build({ type: 'doc', content: [{ type: 'image', attrs: { src: `asset:sha256:${asset.id}` } }] }, meta(), [asset]);
    assert.equal(result.assets[0].sha256, createHash('sha256').update(changed).digest('hex'));
  }
});

test('entity budget counts UTF8 bytes, rejects oversize without mutating the original', () => {
  const data = build(); const saved = JSON.stringify(data);
  const huge = { type: 'doc', content: [p('汉'.repeat(190_000))] };
  fails(() => build(huge), 'NOTE_LIMIT');
  fails(() => build({ type: 'doc', content: [p('x'.repeat(RICH_NOTE_LIMITS.bodyCharacters + 1))] }), 'NOTE_LIMIT');
  const hugeAsset = { ...image(), sizeBytes: RICH_NOTE_LIMITS.assetBytes + 1 };
  fails(() => build({ type: 'doc', content: [{ type: 'image', attrs: { src: `asset:sha256:${hugeAsset.id}` } }] }, meta(), [hugeAsset]));
  assert.equal(JSON.stringify(data), saved);
});

test('table row/column spans and rich cell structure are checked without flattening', () => {
  const cell = (colspan = 1, rowspan = 1): RichNoteNode => ({ type: 'tableCell', attrs: { colspan, rowspan }, content: [p('x')] });
  const table = (rows: RichNoteNode[][]): RichNoteNode => ({ type: 'doc', content: [{ type: 'table', content: rows.map((cells) => ({ type: 'tableRow', content: cells })) }] });
  assert.equal(build(table([[cell(1, 2)], []])).document.content![0].content![1].content!.length, 0);
  for (const document of [table([[cell(2)], [cell()]]), table([[cell(1, 3)], [cell()]]), table([[]]),
    { type: 'doc', content: [{ type: 'table', content: [{ type: 'paragraph' }] }] },
    { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ ...cell(2), attrs: { colspan: 2, colwidth: [100] } }] }] }] },
  ]) fails(() => build(document));
  const data = fixture();
  assert.deepEqual(validateRichNoteData(data).document.content![10], data.document.content![10]);
});

test('malformed grammar is rejected before an editor can silently normalize it', () => {
  for (const document of [
    { type: 'doc', content: [] }, { type: 'doc', content: [text('inline root')] },
    { type: 'doc', content: [{ type: 'paragraph', content: [p('block in inline')] }] },
    { type: 'doc', content: [{ type: 'heading', attrs: { level: 9 } }] },
    { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', content: [p()] }] }] },
    { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }] }] },
    { type: 'doc', content: [{ type: 'image', attrs: { src: `asset:sha256:${'a'.repeat(64)}` }, content: [p()] }] },
    { type: 'doc', content: [{ type: 'blockMath', attrs: { latex: '' } }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'code' }, { type: 'bold' }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hashTag', attrs: { tag: null } }] }] },
  ]) fails(() => build(document));
});

test('label-only desktop references require explicit unresolved-reference metadata', () => {
  const document: RichNoteNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'wikiLink', attrs: { id: null, label: '尚未创建' } }] }] };
  fails(() => build(document));
  const metadata = meta(); metadata.unresolvedReferences = [{ kind: 'note', id: 'placeholder_1', label: '尚未创建', reason: 'missing' }];
  assert.deepEqual(build(document, metadata).document, document);
});

test('accessors, prototypes, holes, hidden/symbol keys, undefined, cycles and lone surrogates fail closed', () => {
  let ran = false; const data = build();
  const getter = { ...data }; Object.defineProperty(getter, 'body', { enumerable: true, get() { ran = true; return data.body; } });
  const hidden = { ...data }; Object.defineProperty(hidden, 'secret', { value: 'private' });
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const value of [getter, hidden, { ...data, [Symbol('secret')]: true }, { ...data, assets: new Array(1) },
    Object.assign(Object.create({ secret: true }), data), { ...data, title: undefined }, { ...data, title: '\ud800' }, { ...data, assets: cycle },
  ]) fails(() => validateRichNoteData(value));
  assert.equal(ran, false);
});

test('canonical keys do not depend on incoming object insertion order', () => {
  function reverse(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverse);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)]));
    return value;
  }
  const data = fixture();
  assert.equal(JSON.stringify(validateRichNoteData(reverse(data))), JSON.stringify(data));
  assert.equal(RICH_NOTE_DATA_SCHEMA.additionalProperties, false);
  assert.equal(RICH_NOTE_DATA_SCHEMA.properties!.format.const, 'tiptap-json');
});

test('installed TipTap standard schema emits only accepted attributes and valid document grammar', async () => {
  const [{ getSchema, Node }, { default: StarterKit }, { default: Highlight }, { default: Image },
    { Table, TableRow, TableCell, TableHeader }, { TaskList, TaskItem }, { default: Mathematics }] = await Promise.all([
    import('@tiptap/core'), import('@tiptap/starter-kit'), import('@tiptap/extension-highlight'), import('@tiptap/extension-image'),
    import('@tiptap/extension-table'), import('@tiptap/extension-list'), import('@tiptap/extension-mathematics'),
  ]);
  // Node views and suggestion plugins do not affect the custom persisted schema.
  const custom = [
    { name: 'noteComponentBlock', group: 'block', content: 'block+', attrs: { title: 'Component', variant: 'note' } },
    { name: 'noteAnchorBlock', group: 'block', attrs: { anchorId: null, label: '定位', sourceLabel: '摘录', sourceTitle: '', excerpt: '' } },
    { name: 'noteAnchorLink', group: 'inline', attrs: { anchorId: null, label: null } },
    { name: 'wikiLink', group: 'inline', attrs: { id: null, label: null } },
    { name: 'hashTag', group: 'inline', attrs: { tag: null } },
    { name: 'paperReference', group: 'inline', attrs: { paperId: null, label: null } },
  ].map((definition) => Node.create({ name: definition.name, group: definition.group, inline: definition.group === 'inline',
    atom: !definition.content, ...(definition.content ? { content: definition.content } : {}),
    addAttributes() { return Object.fromEntries(Object.entries(definition.attrs).map(([key, value]) => [key, { default: value }])); },
  }));
  const schema = getSchema([StarterKit, Highlight.configure({ multicolor: true }), Image, Table, TableRow, TableCell, TableHeader,
    TaskList, TaskItem.configure({ nested: true }), Mathematics, ...custom]);
  const data = fixture();
  const model = schema.nodeFromJSON(data.document); model.check();
  const emitted = model.toJSON();
  const result = createRichNoteData({ paperId: data.paperId, title: data.title, document: emitted, metadata: data.metadata, assets: data.assets });
  assert.deepEqual(result.document, JSON.parse(JSON.stringify(emitted)));
  assert.equal(JSON.stringify(validateRichNoteData(result)), JSON.stringify(result));
});

test('unmapped source identities stay explicit and cannot become active account UUID references', () => {
  const source = '00000000-0000-4000-8000-000000000099', unresolved = richNoteUnresolvedId('paper', source), data = fixture();
  assert.equal(unresolved, `unresolved:paper:${source}`);
  assert.deepEqual(parseRichNoteUnresolvedId(unresolved), { kind: 'paper', sourceId: source });
  const changed = structuredClone(data);
  changed.metadata.linkedPaperId = unresolved; changed.metadata.linkedPaperIds = [unresolved]; changed.metadata.anchors[0].paperId = unresolved;
  changed.document.content![1].content!.find((node) => node.type === 'paperReference')!.attrs!.paperId = unresolved;
  changed.metadata.unresolvedReferences.push({ kind: 'paper', id: unresolved, label: '未导入文献', reason: 'unmapped' });
  changed.body = richNoteText(changed.document);
  assert.deepEqual(validateRichNoteData(changed), changed);
  fails(() => validateRichNoteData({ ...changed, metadata: { ...changed.metadata, unresolvedReferences: [] } }));
  fails(() => validateRichNoteData({ ...changed, paperId: unresolved }));
  fails(() => validateRichNoteData({ ...changed, metadata: { ...changed.metadata, linkedPaperId: 'any-identifier' } }));
  fails(() => validateRichNoteData({ ...changed, metadata: { ...changed.metadata, unresolvedReferences: [{ kind: 'note', id: unresolved, label: '', reason: 'unmapped' }] } }));
  fails(() => richNoteUnresolvedId('paper', 'file:///C:/private'));
  fails(() => richNoteUnresolvedId('paper', unresolved));
  fails(() => parseRichNoteUnresolvedId(`unresolved:unsupported:${source}`));
});
