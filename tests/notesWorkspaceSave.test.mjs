import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

async function withNotesStore(invoke, check) {
  const server = await createServer({ configFile: false, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
  const previousWindow = globalThis.window;
  globalThis.window = { paperquay: { invoke }, dispatchEvent() {} };
  try {
    const { useNotesStore } = await server.ssrLoadModule('/src/stores/useNotesStore.ts');
    useNotesStore.setState({ notes: [{ id: 'alpha', title: 'Alpha', updatedAt: 1 }, { id: 'beta', title: 'Beta', updatedAt: 2 }], activeNoteId: 'alpha' });
    await check(useNotesStore);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a late old search result cannot replace the newer query result or selection', async () => {
  const old = deferred(), current = deferred();
  await withNotesStore(async (_command, args) => args.request.search === 'older' ? old.promise : current.promise, async store => {
    store.getState().setSearch('older'); const first = store.getState().loadNotes();
    store.getState().setSearch('current'); const second = store.getState().loadNotes();
    current.resolve([{id:'current',title:'Current result',updatedAt:3}]); await second;
    old.resolve([{id:'older',title:'Old result',updatedAt:1}]); await first;
    assert.equal(store.getState().search, 'current');
    assert.deepEqual(store.getState().notes.map(n => n.id), ['current']);
    assert.equal(store.getState().activeNoteId, 'current');
    assert.equal(store.getState().loading, false);
  });
});

test('an old read failure cannot clear a newer successful result or add an error', async () => {
  const old = deferred(), current = deferred(); let calls = 0;
  await withNotesStore(async () => ++calls === 1 ? old.promise : current.promise, async store => {
    const first = store.getState().loadNotes(), second = store.getState().loadNotes();
    current.resolve([{id:'current',title:'Current result',updatedAt:3}]); await second;
    old.reject(new Error('Obsolete read failed')); await first;
    assert.deepEqual(store.getState().notes.map(n => n.id), ['current']);
    assert.equal(store.getState().error, '');
    assert.equal(store.getState().loading, false);
  });
});

test('an older reply cannot dismiss loading while the latest request is still pending', async () => {
  const old = deferred(), current = deferred(); let calls = 0;
  await withNotesStore(async () => ++calls === 1 ? old.promise : current.promise, async store => {
    const before = store.getState().notes;
    const first = store.getState().loadNotes(), second = store.getState().loadNotes();
    old.resolve([{id:'obsolete',title:'Obsolete',updatedAt:1}]); await first;
    assert.equal(store.getState().notes, before);
    assert.equal(store.getState().loading, true);
    current.resolve([{id:'current',title:'Current',updatedAt:3}]); await second;
    assert.equal(store.getState().loading, false);
  });
});

for (const [field, setter, value] of [['search','setSearch','changed'], ['tag','setTag','changed-tag']]) {
  test(`changing ${field} retires pending results before the debounced replacement starts`, async () => {
    const gate = deferred();
    await withNotesStore(async () => gate.promise, async store => {
      const before = store.getState().notes;
      const loading = store.getState().loadNotes();
      store.getState()[setter](value);
      gate.resolve([{id:'obsolete',title:'Obsolete',updatedAt:1}]); await loading;
      assert.equal(store.getState()[field], value);
      assert.equal(store.getState().notes, before);
      assert.equal(store.getState().loading, false);
    });
  });
}

test('setting the same query value does not retire its valid pending result', async () => {
  const gate = deferred();
  await withNotesStore(async () => gate.promise, async store => {
    store.getState().setSearch('same'); const loading = store.getState().loadNotes();
    store.getState().setSearch('same'); store.getState().setTag(null);
    gate.resolve([{id:'current',title:'Current',updatedAt:3}]); await loading;
    assert.deepEqual(store.getState().notes.map(n => n.id), ['current']);
    assert.equal(store.getState().loading, false);
  });
});

for (const action of ['create','update','delete']) {
  test(`a pre-${action} snapshot cannot undo the confirmed workspace mutation`, async () => {
    const gate = deferred();
    await withNotesStore(async command => {
      if (command === 'notes_list_all') return gate.promise;
      if (command === 'notes_tags') return [];
      if (command === 'notes_create') return {id:'created',title:'Created',updatedAt:3};
      if (command === 'notes_update') return {id:'alpha',title:'Committed Alpha',updatedAt:3};
      assert.equal(command, 'notes_delete');
    }, async store => {
      const before = store.getState().notes;
      const loading = store.getState().loadNotes();
      if (action === 'create') await store.getState().createWorkspaceNote({title:'Created'});
      if (action === 'update') await store.getState().updateWorkspaceNote('alpha',{title:'Committed Alpha'});
      if (action === 'delete') await store.getState().deleteWorkspaceNote('alpha');
      const confirmed = store.getState().notes;
      gate.resolve(before); await loading;
      assert.equal(store.getState().notes, confirmed);
      if (action === 'create') assert.ok(confirmed.some(n => n.id === 'created'));
      if (action === 'update') assert.equal(confirmed.find(n => n.id === 'alpha').title, 'Committed Alpha');
      if (action === 'delete') assert.equal(confirmed.some(n => n.id === 'alpha'), false);
      assert.equal(store.getState().loading, false);
    });
  });
}

test('a failed mutation leaves the pending database read usable', async () => {
  const gate = deferred();
  await withNotesStore(async command => {
    if (command === 'notes_list_all') return gate.promise;
    throw new Error('Write refused');
  }, async store => {
    const loading = store.getState().loadNotes();
    await assert.rejects(store.getState().updateWorkspaceNote('alpha',{title:'Not committed'}), /Write refused/);
    gate.resolve([{id:'alpha',title:'Database result',updatedAt:3}]); await loading;
    assert.equal(store.getState().notes[0].title, 'Database result');
    assert.equal(store.getState().loading, false);
  });
});

test('old tag results and failures cannot replace the newest tag counts', async () => {
  for (const failOld of [false, true]) {
    const old = deferred(), current = deferred(); let calls = 0;
    await withNotesStore(async command => {
      assert.equal(command, 'notes_tags'); return ++calls === 1 ? old.promise : current.promise;
    }, async store => {
      const first = store.getState().refreshTags(), second = store.getState().refreshTags();
      current.resolve([{tag:'current',count:2}]); await second;
      if (failOld) old.reject(new Error('Obsolete tags failed'));
      else old.resolve([{tag:'old',count:1}]);
      await first;
      assert.deepEqual(store.getState().tags, [{tag:'current',count:2}]);
    });
  }
});

test('a delayed workspace save does not select its note over the user selection', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await withNotesStore(async (command, args) => {
    if (command === 'notes_tags') return [];
    assert.equal(command, 'notes_update'); assert.equal(args.id, 'alpha');
    await gate;
    return { id: 'alpha', title: 'Saved Alpha', updatedAt: 3 };
  }, async store => {
    const save = store.getState().updateWorkspaceNote('alpha', { title: 'Saved Alpha' });
    assert.equal(store.getState().saving, true);
    store.getState().setActiveNoteId('beta');
    release(); await save;
    assert.equal(store.getState().activeNoteId, 'beta');
    assert.equal(store.getState().notes.find(note => note.id === 'alpha').title, 'Saved Alpha');
    assert.equal(store.getState().notes.find(note => note.id === 'beta').title, 'Beta');
    assert.equal(store.getState().saving, false);
  });
});

test('a failed workspace save leaves the record and selection unchanged and allows retry', async () => {
  let fail = true;
  await withNotesStore(async command => {
    if (command === 'notes_tags') return [];
    assert.equal(command, 'notes_update');
    if (fail) throw new Error('Fixture save failure');
    return { id: 'alpha', title: 'Retried Alpha', updatedAt: 3 };
  }, async store => {
    const before = store.getState().notes;
    await assert.rejects(store.getState().updateWorkspaceNote('alpha', { title: 'Retried Alpha' }), /Fixture save failure/);
    assert.equal(store.getState().notes, before);
    assert.equal(store.getState().activeNoteId, 'alpha');
    assert.equal(store.getState().saving, false);
    assert.equal(store.getState().error, 'Fixture save failure');
    fail = false;
    await store.getState().updateWorkspaceNote('alpha', { title: 'Retried Alpha' });
    assert.equal(store.getState().error, '');
    assert.equal(store.getState().notes.find(note => note.id === 'alpha').title, 'Retried Alpha');
  });
});
