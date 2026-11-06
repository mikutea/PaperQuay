// Convert an explicitly accepted account snapshot into a new local note. The
// caller chooses a stable copy id and never overwrites an existing local note.
function desktopNoteCopy(core, record, localId, bindings) {
  const checked = core.validateRecord(record);
  if (!checked.ok || record.entityType !== 'note' || record.deletedAt !== null || !record.data) throw Object.assign(Error('NOTE_REMOTE_UNAVAILABLE'), { code: 'NOTE_REMOTE_UNAVAILABLE' });
  const data = checked.value.data;
  const parent = data.paperId === null ? 'global-notes' : bindings.papers.get(data.paperId);
  if (!parent) throw Object.assign(Error('UNMAPPED_NOTE_PAPER'), { code: 'UNMAPPED_NOTE_PAPER' });
  const request = { id: localId, paperId: parent, title: data.title, content: data.body, contentText: data.body };
  if (data.format === 'markdown') return { ...request, type: 'standalone',
    contentJson: { type: 'doc', content: data.body.split('\n').map(text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })) },
    anchors: [], tags: [], linkedNoteIds: [], linkedPaperIds: [], isFavorite: false, isPinned: false, color: '#fef3c7' };
  const meta = data.metadata, document = structuredClone(data.document), assets = new Map(data.assets.map(value => [value.sha256, value]));
  const inherited = new Map(meta.unresolvedReferences.map(value => [`${value.kind}:${value.id}`, value])), descriptions = new Map();
  const reference = (kind, value, label = '') => {
    const parsed = core.parseRichNoteUnresolvedId(value), previous = inherited.get(`${kind}:${value}`);
    if (!parsed && !previous) {
      const local = kind === 'paper' ? bindings.papers.get(value) : kind === 'note' ? bindings.notes.get(value) : null;
      if (local) return local;
    }
    const target = parsed ? value : core.richNoteUnresolvedId(kind, value), key = `${kind}:${target}`;
    if (!descriptions.has(key)) descriptions.set(key, { kind, id: target, label: previous?.label || label || parsed?.sourceId || value, reason: previous?.reason || 'unmapped' });
    else if (!previous && label && descriptions.get(key).label === (parsed?.sourceId || value)) descriptions.get(key).label = label;
    return target;
  };
  for (const value of meta.unresolvedReferences) reference(value.kind, value.id, value.label);
  const noteLinks = new Set(meta.linkedNoteIds.map(value => reference('note', value))), paperLinks = new Set(meta.linkedPaperIds.map(value => reference('paper', value)));
  const walk = node => {
    if (node.type === 'image') {
      const asset = assets.get(node.attrs.src.slice('asset:sha256:'.length));
      node.attrs.src = `data:${asset.mediaType};base64,${asset.base64}`;
    }
    if (node.type === 'wikiLink' && typeof node.attrs?.id === 'string') { node.attrs.id = reference('note', node.attrs.id, node.attrs.label); noteLinks.add(node.attrs.id); }
    if (node.type === 'paperReference' && typeof node.attrs?.paperId === 'string') { node.attrs.paperId = reference('paper', node.attrs.paperId, node.attrs.label); paperLinks.add(node.attrs.paperId); }
    for (const child of node.content || []) walk(child);
  };
  walk(document);
  return { ...request, type: meta.type, contentJson: document, tags: [...meta.tags], color: meta.color,
    isFavorite: meta.isFavorite, isPinned: meta.isPinned, createdAt: meta.createdAt,
    anchors: meta.anchors.map(anchor => ({ ...structuredClone(anchor), ...(anchor.paperId ? { paperId: reference('paper', anchor.paperId, anchor.sourceTitle) } : {}) })),
    linkedNoteIds: [...noteLinks], linkedPaperIds: [...paperLinks],
    ...(meta.linkedPaperId === undefined ? {} : { linkedPaperId: meta.linkedPaperId === null ? null : reference('paper', meta.linkedPaperId) }),
    ...(meta.folderId === undefined ? {} : { folderId: meta.folderId === null ? null : reference('folder', meta.folderId) }),
    ...(meta.aiChatId === undefined ? {} : { aiChatId: reference('ai-chat', meta.aiChatId) }),
    ...(meta.aiChatMessageIds === undefined ? {} : { aiChatMessageIds: [...meta.aiChatMessageIds] }),
    ...(meta.excerpt === undefined ? {} : { excerpt: meta.excerpt }), ...(meta.pdfLocation === undefined ? {} : { pdfLocation: structuredClone(meta.pdfLocation) }),
    unresolvedReferences: [...descriptions.values()] };
}

function sameDesktopNoteCopy(core, saved, request) {
  if (!saved || saved.id !== request.id || saved.deletedAt != null) return false;
  // The normal note store derives timestamps, word counts, tags and HTML. Those
  // derived fields do not determine whether the immutable copy was saved.
  for (const key of Object.keys(request)) {
    if (['createdAt', 'contentText', 'tags'].includes(key)) continue;
    if (core.canonicalJson(saved[key] ?? null) !== core.canonicalJson(request[key] ?? null)) return false;
  }
  const tags = new Set((saved.tags || []).map(tag => tag.trim().replace(/^#/, '').toLowerCase()));
  return request.tags.every(tag => tags.has(tag.trim().replace(/^#/, '').toLowerCase()));
}
module.exports = { desktopNoteCopy, sameDesktopNoteCopy };
