import assert from 'node:assert/strict';
import test from 'node:test';
import { canUseWorkspaceNoteUpdate } from '../src/features/notes/noteWorkspaceRefresh.ts';
import type { NoteChangedEventDetail } from '../src/app/appEvents.ts';

const editorSourceId = 'paperquay:notes-workspace-editor';
const event = (changes: Partial<NoteChangedEventDetail> = {}): NoteChangedEventDetail => ({
  action: 'updated', noteId: 'alpha', sourceId: editorSourceId,
  note: { id: 'alpha', title: 'Confirmed edit', updatedAt: 42, linkedNoteIds: [], deletedAt: null },
  ...changes,
});
const snapshot = () => ({notes: [{id: 'alpha', linkedNoteIds: [] as string[]}], search: '', tag: null as string | null, loading: false});

test('ordinary confirmed workspace saves use the record already applied by the store', () => {
  assert.equal(canUseWorkspaceNoteUpdate(event(), snapshot(), editorSourceId), true);
});

test('search and tag membership are rechecked after editing a matching note', () => {
  assert.equal(canUseWorkspaceNoteUpdate(event(), {...snapshot(), search:'previous text'}, editorSourceId), false);
  assert.equal(canUseWorkspaceNoteUpdate(event(), {...snapshot(), tag:'previous tag'}, editorSourceId), false);
});

test('a save during an in-flight list read requests a fresh post-save view', () => {
  assert.equal(canUseWorkspaceNoteUpdate(event(), {...snapshot(), loading:true}, editorSourceId), false);
});

test('a newly added outgoing link refreshes its target backlinks', () => {
  const changed = event({note:{id:'alpha', updatedAt:42, linkedNoteIds:['target']}});
  assert.equal(canUseWorkspaceNoteUpdate(changed, snapshot(), editorSourceId), false);
});

test('removing a link or changing an existing link source refreshes old target metadata', () => {
  const linked = {...snapshot(), notes:[{id:'alpha', linkedNoteIds:['old-target']}]};
  assert.equal(canUseWorkspaceNoteUpdate(event(), linked, editorSourceId), false);
  assert.equal(canUseWorkspaceNoteUpdate(event({note:{id:'alpha', updatedAt:42, linkedNoteIds:['old-target']}}), linked, editorSourceId), false);
});

test('foreign editors and create/delete events still reload the workspace', () => {
  for (const changed of [event({sourceId:'reader'}), event({sourceId:undefined}), event({action:'created'}), event({action:'deleted'})]) {
    assert.equal(canUseWorkspaceNoteUpdate(changed, snapshot(), editorSourceId), false);
  }
});

test('unknown notes, mismatched identities and incomplete records fall back to reading the database', () => {
  for (const changed of [event({noteId:'absent'}), event({note:null}), event({note:{id:'beta',updatedAt:42,linkedNoteIds:[]}}), event({note:{id:'alpha',updatedAt:42}}), event({note:{id:'alpha',updatedAt:NaN,linkedNoteIds:[]}})]) {
    assert.equal(canUseWorkspaceNoteUpdate(changed, snapshot(), editorSourceId), false);
  }
});

test('a tombstoned record cannot use the ordinary editor update path', () => {
  assert.equal(canUseWorkspaceNoteUpdate(event({note:{id:'alpha',updatedAt:42,linkedNoteIds:[],deletedAt:42}}), snapshot(), editorSourceId), false);
});
