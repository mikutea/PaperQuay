import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acknowledgeNoteEditorDraftSave,
  canPersistNoteEditorDraft,
  clearNoteEditorDraft,
  clearNoteEditorDraftsForNote,
  hasUnsavedNoteEditorDrafts,
  assertNoteEditorDraftsSaved,
  componentBlockNode,
  getImageFilesFromDataTransfer,
  headingNode,
  isImageFile,
  isNoteRecord,
  mergeAnchors,
  normalizeAnchorPageLabel,
  normalizeAnchorSourceTitle,
  normalizeSuggestionQuery,
  NOTE_TEMPLATES,
  paragraphNode,
  readNoteEditorDraft,
  signature,
  slashCommandItems,
  snapshotFromNote,
  writeNoteEditorDraft,
} from '../src/features/notes/noteEditorUtils.ts';
import type { Note, NoteAnchor } from '../src/types/notes.ts';

test('close protection tracks dirty drafts across editors and clears only confirmed saves or deleted notes', () => {
  const draft = {
    noteId: 'close-guard-note', baseUpdatedAt: 1, savedSignature: 'saved',
    draftSignature: 'dirty', title: 'Private draft', tagText: '', color: '#ffffff',
    snapshot: snapshotFromNote(note()), pendingAnchors: [], updatedAt: 2,
  };
  try {
    assert.equal(hasUnsavedNoteEditorDrafts(), false);
    writeNoteEditorDraft('close-guard-one', draft);
    writeNoteEditorDraft('close-guard-two', { ...draft, noteId: 'other-close-note' });
    assert.equal(hasUnsavedNoteEditorDrafts(), true);
    assert.throws(assertNoteEditorDraftsSaved, /Save unsaved notes/);
    acknowledgeNoteEditorDraftSave('close-guard-one', {
      noteId: draft.noteId, updatedAt: 3, submittedSignature: 'dirty', savedSignature: 'dirty',
    });
    assert.equal(hasUnsavedNoteEditorDrafts(), true);
    clearNoteEditorDraftsForNote('other-close-note');
    assert.equal(hasUnsavedNoteEditorDrafts(), false);
    assert.doesNotThrow(assertNoteEditorDraftsSaved);
    writeNoteEditorDraft('close-guard-clean', { ...draft, draftSignature: 'saved' });
    assert.equal(hasUnsavedNoteEditorDrafts(), false);
  } finally {
    clearNoteEditorDraftsForNote(draft.noteId);
    clearNoteEditorDraftsForNote('other-close-note');
  }
});

test('draft persistence waits for the loaded note fields to render', () => {
  assert.equal(canPersistNoteEditorDraft('alpha', null, 'empty', 'loaded'), false);
  assert.equal(canPersistNoteEditorDraft('beta', 'alpha', 'loaded', 'loaded'), false);
  assert.equal(canPersistNoteEditorDraft('beta', 'beta', 'empty', 'loaded'), false);
  assert.equal(canPersistNoteEditorDraft('beta', 'beta', 'loaded', 'loaded'), true);
  assert.equal(canPersistNoteEditorDraft('beta', 'beta', 'new edit', null), true);
});

test('save acknowledgements keep newer drafts and clear only the submitted snapshot', () => {
  const sourceId = 'save-race';
  const draft = {
    noteId: 'alpha', baseUpdatedAt: 1, savedSignature: 'original',
    draftSignature: 'submitted', title: 'Submitted', tagText: '', color: '#ffffff',
    snapshot: snapshotFromNote(note()), pendingAnchors: [], updatedAt: 2,
  };
  writeNoteEditorDraft(sourceId, draft);
  acknowledgeNoteEditorDraftSave(sourceId, {
    noteId: 'alpha', updatedAt: 3, submittedSignature: 'submitted', savedSignature: 'saved',
  });
  assert.equal(readNoteEditorDraft(sourceId, 'alpha', 3), null);

  writeNoteEditorDraft(sourceId, { ...draft, draftSignature: 'newer', title: 'Newer draft' });
  acknowledgeNoteEditorDraftSave(sourceId, {
    noteId: 'alpha', updatedAt: 3, submittedSignature: 'submitted', savedSignature: 'saved',
  });
  const retained = readNoteEditorDraft(sourceId, 'alpha', 3);
  assert.equal(retained?.title, 'Newer draft');
  assert.equal(retained?.draftSignature, 'newer');
  assert.equal(retained?.savedSignature, 'saved');
  acknowledgeNoteEditorDraftSave(sourceId, {
    noteId: 'beta', updatedAt: 4, submittedSignature: 'newer', savedSignature: 'saved',
  });
  assert.equal(readNoteEditorDraft(sourceId, 'alpha', 3)?.title, 'Newer draft');
  clearNoteEditorDraft(sourceId, 'alpha');
});

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: overrides.id ?? 'note-1',
    paperId: overrides.paperId ?? 'paper-1',
    type: overrides.type ?? 'standalone',
    title: overrides.title ?? 'Note',
    content: overrides.content ?? 'Plain note',
    contentJson: overrides.contentJson ?? null,
    contentHtml: overrides.contentHtml ?? '<p>Plain note</p>',
    contentText: overrides.contentText ?? 'Plain note',
    aiChatMessageIds: overrides.aiChatMessageIds ?? [],
    anchors: overrides.anchors ?? [],
    tags: overrides.tags ?? [],
    color: overrides.color ?? '#fef3c7',
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 2,
    linkedNoteIds: overrides.linkedNoteIds ?? [],
    linkedPaperIds: overrides.linkedPaperIds ?? [],
    ...overrides,
  };
}

function anchor(overrides: Partial<NoteAnchor> & Pick<NoteAnchor, 'id'>): NoteAnchor {
  return {
    id: overrides.id,
    label: overrides.label ?? 'P1',
    excerpt: overrides.excerpt ?? 'excerpt',
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
  };
}

function imageFile(name: string, type = '', size = 10, lastModified = 1): File {
  return new File(['x'.repeat(size)], name, { type, lastModified });
}

test('node builders create stable Tiptap JSON blocks', () => {
  assert.deepEqual(paragraphNode('hello'), {
    type: 'paragraph',
    content: [{ type: 'text', text: 'hello' }],
  });
  assert.deepEqual(headingNode(2, 'Section'), {
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text: 'Section' }],
  });
  assert.deepEqual(componentBlockNode('Card'), {
    type: 'noteComponentBlock',
    attrs: { title: 'Card', variant: 'note' },
    content: [{ type: 'paragraph' }],
  });
});

test('note templates expose expected slash-command templates', () => {
  assert.deepEqual(
    NOTE_TEMPLATES.map((template) => template.id),
    ['literature-review', 'method-analysis', 'experiment-note', 'qa-summary'],
  );
});

test('slash command items filter base commands and note templates', () => {
  assert.equal(slashCommandItems('').some((item) => item.id === 'paragraph'), true);
  assert.deepEqual(slashCommandItems('/h2').map((item) => item.id), ['heading-2']);
  assert.deepEqual(
    slashCommandItems('/literature').map((item) => item.id),
    ['template:literature-review'],
  );
  assert.deepEqual(slashCommandItems('/missing-command'), []);
});

test('anchor labels and source titles normalize legacy values', () => {
  assert.equal(normalizeAnchorPageLabel(' p 12 '), 'P12');
  assert.equal(normalizeAnchorPageLabel(''), '定位');
  assert.equal(normalizeAnchorSourceTitle('PDF 12', '正文摘录'), '文献');
  assert.equal(normalizeAnchorSourceTitle('', 'Actual Paper'), 'Actual Paper');
  assert.equal(normalizeAnchorSourceTitle('Paper Title', '摘录'), 'Paper Title');
});

test('normalizeSuggestionQuery removes repeated triggers and hidden characters', () => {
  assert.equal(normalizeSuggestionQuery('\u200B[[[[Graph', ['[[']), 'graph');
  assert.equal(normalizeSuggestionQuery('///Heading', ['/', '//']), 'heading');
});

test('snapshotFromNote and signature normalize saved note state', () => {
  const snapshot = snapshotFromNote(note({
    title: 'Saved',
    contentText: 'Saved text',
    wordCount: 2,
  }));

  assert.equal(snapshot.contentText, 'Saved text');
  assert.equal(snapshot.wordCount, 2);
  assert.equal(
    signature({ title: ' Saved ', tagText: ' tag ', color: '#fff', snapshot }),
    JSON.stringify({
      title: 'Saved',
      tagText: 'tag',
      color: '#fff',
      contentJson: snapshot.contentJson,
      contentText: 'Saved text',
    }),
  );
});

test('note editor drafts restore only for the same saved note version', () => {
  const sourceId = 'reader-sidebar';
  const noteId = 'note-1';
  const saved = note({ id: noteId, title: 'Saved', updatedAt: 10 });
  const savedSnapshot = snapshotFromNote(saved);
  const savedSignature = signature({
    title: saved.title,
    tagText: saved.tags.join(', '),
    color: saved.color,
    snapshot: savedSnapshot,
  });
  const draftSnapshot = {
    ...savedSnapshot,
    contentText: 'Unsaved draft',
    contentJson: paragraphNode('Unsaved draft'),
  };

  writeNoteEditorDraft(sourceId, {
    noteId,
    baseUpdatedAt: saved.updatedAt,
    savedSignature,
    draftSignature: signature({
      title: 'Draft title',
      tagText: '',
      color: saved.color,
      snapshot: draftSnapshot,
    }),
    title: 'Draft title',
    tagText: '',
    color: saved.color,
    snapshot: draftSnapshot,
    pendingAnchors: [],
    updatedAt: 20,
  });

  assert.equal(readNoteEditorDraft(sourceId, noteId, saved.updatedAt)?.title, 'Draft title');
  assert.equal(readNoteEditorDraft(sourceId, noteId, saved.updatedAt + 1), null);

  writeNoteEditorDraft(sourceId, {
    noteId,
    baseUpdatedAt: saved.updatedAt,
    savedSignature,
    draftSignature: savedSignature,
    title: saved.title,
    tagText: '',
    color: saved.color,
    snapshot: savedSnapshot,
    pendingAnchors: [],
    updatedAt: 30,
  });
  clearNoteEditorDraft(sourceId, noteId);

  assert.equal(readNoteEditorDraft(sourceId, noteId, saved.updatedAt), null);
});

test('isNoteRecord validates note identity and update timestamp', () => {
  assert.equal(isNoteRecord(note({ id: 'n1' }), 'n1'), true);
  assert.equal(isNoteRecord(note({ id: 'n1' }), 'n2'), false);
  assert.equal(isNoteRecord({ id: 'n1' }, 'n1'), false);
});

test('mergeAnchors keeps later anchors with the same id', () => {
  const merged = mergeAnchors(
    [anchor({ id: 'a1', excerpt: 'old' })],
    [anchor({ id: 'a1', excerpt: 'new' }), anchor({ id: 'a2' })],
  );

  assert.deepEqual(merged.map((item) => [item.id, item.excerpt]), [
    ['a1', 'new'],
    ['a2', 'excerpt'],
  ]);
});

test('image file helpers accept image MIME types and image extensions', () => {
  const png = imageFile('image.png', '');
  const text = imageFile('note.txt', 'text/plain');
  const jpeg = imageFile('photo.bin', 'image/jpeg');

  assert.equal(isImageFile(png), true);
  assert.equal(isImageFile(jpeg), true);
  assert.equal(isImageFile(text), false);

  const transfer = {
    files: [png, text],
    items: [
      { kind: 'file', getAsFile: () => png },
      { kind: 'file', getAsFile: () => jpeg },
      { kind: 'string', getAsFile: () => null },
    ],
  } as unknown as DataTransfer;

  assert.deepEqual(getImageFilesFromDataTransfer(transfer).map((file) => file.name), [
    'image.png',
    'photo.bin',
  ]);
});
