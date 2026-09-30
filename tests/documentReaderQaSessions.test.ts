import test from 'node:test';
import assert from 'node:assert/strict';

import {
  removeQaSession,
  resolveActiveQaSession,
  resolveQaModelPreset,
  resolveQaSessionSelection,
  isQaRequestSessionSelected,
} from '../src/features/reader/documentReaderQaSessions.ts';

test('late QA failures may update the composer only for the selected request session', () => {
  assert.equal(isQaRequestSessionSelected('doc', 'doc', 'A', 'A'), true);
  assert.equal(isQaRequestSessionSelected('doc', 'doc', 'B', 'A'), false);
  assert.equal(isQaRequestSessionSelected('other-doc', 'doc', 'A', 'A'), false);
  assert.equal(isQaRequestSessionSelected('', 'doc', 'A', 'A'), false);
  assert.equal(isQaRequestSessionSelected('doc', 'doc', '', 'A'), false);
});
import type { DocumentChatSession, QaModelPreset } from '../src/types/reader.ts';

function session(id: string): DocumentChatSession {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
}

function preset(id: string): QaModelPreset {
  return {
    id,
    label: id,
    baseUrl: 'https://api.example.test',
    apiKey: 'key',
    model: 'model',
    apiMode: 'chat_completions',
  };
}

test('resolveActiveQaSession falls back to the first session', () => {
  const sessions = [session('s1'), session('s2')];

  assert.equal(resolveActiveQaSession(sessions, 's2')?.id, 's2');
  assert.equal(resolveActiveQaSession(sessions, 'missing')?.id, 's1');
  assert.equal(resolveActiveQaSession([], 'missing'), null);
});

test('resolveQaSessionSelection only returns explicit existing sessions', () => {
  const sessions = [session('s1')];

  assert.equal(resolveQaSessionSelection(sessions, 's1')?.id, 's1');
  assert.equal(resolveQaSessionSelection(sessions, 'missing'), null);
  assert.equal(resolveQaSessionSelection(sessions, ''), null);
});

test('removeQaSession removes existing sessions and reports fallback selection', () => {
  const removedMiddle = removeQaSession(
    [session('s1'), session('s2'), session('s3')],
    's2',
    () => session('fallback'),
  );

  assert.equal(removedMiddle.removed, true);
  assert.deepEqual(removedMiddle.sessions.map((item) => item.id), ['s1', 's3']);
  assert.equal(removedMiddle.selectedSessionId, 's1');

  const removedLast = removeQaSession([session('s1')], 's1', () => session('fallback'));

  assert.equal(removedLast.removed, true);
  assert.deepEqual(removedLast.sessions.map((item) => item.id), ['fallback']);
  assert.equal(removedLast.selectedSessionId, 'fallback');
});

test('removeQaSession leaves unknown ids unchanged', () => {
  const sessions = [session('s1')];
  const result = removeQaSession(sessions, 'missing', () => session('fallback'));

  assert.equal(result.removed, false);
  assert.equal(result.sessions, sessions);
});

test('resolveQaModelPreset returns requested preset or first fallback', () => {
  const presets = [preset('p1'), preset('p2')];

  assert.equal(resolveQaModelPreset(presets, 'p2')?.id, 'p2');
  assert.equal(resolveQaModelPreset(presets, 'missing')?.id, 'p1');
  assert.equal(resolveQaModelPreset([], 'missing'), null);
});
