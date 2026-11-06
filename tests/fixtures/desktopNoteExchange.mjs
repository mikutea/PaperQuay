// Synthetic note content and an in-memory Electron bridge. No service or profile is opened.
export const scopeKey = 'fixture-service-account-library';
export const noteSummary = (patch = {}) => ({
  title: '乡村公共空间', body: '完整的笔记正文。\n第二段保留引用说明。', format: 'tiptap-json',
  images: 2, tags: ['田野记录'], unresolvedReferences: 1, ...patch,
});
export const noteStatus = (patch = {}) => ({
  scopeKey, supported: true, richSupported: true, loaded: true, busy: false,
  revision: 2, pending: 0, continuable: 0, conflicts: 0, accepted: 0, bound: 0,
  copyPending: 0, errorCode: null, saveUnconfirmed: false, ...patch,
});
export const localNote = (id = 'local-one', patch = {}) => ({
  localNoteId: id, title: '乡村公共空间', updatedAt: '2026-11-04T01:00:00.000Z', boundEntityId: null, ...patch,
});
export const localRow = (id = 'local-one', patch = {}) => ({
  key: 'row-' + id, localNoteId: id, entityId: null, label: '乡村公共空间', action: 'create',
  local: noteSummary({ body: '本机已保存的完整正文。' }), remote: null, ...patch,
});
export const incomingNote = (id = 'account-one', patch = {}) => ({
  entityId: id, label: '乡村公共空间', state: 'new', canAccept: true, revision: 3, acceptedRevision: null,
  data: noteSummary({ body: '账号中的完整正文。' }), accepted: null, ...patch,
});
export const noteConflict = (patch = {}) => ({
  conflictId: 'conflict-private-id', entityId: 'account-one', label: '乡村公共空间', expectedRevision: 5,
  attempted: { mutation: 'restore', data: noteSummary({ body: '本次准备恢复的内容。' }) },
  current: { revision: 5, deletedAt: '2026-11-04T02:00:00.000Z', data: null }, ...patch,
});
export const notePreview = (patch = {}) => ({
  token: 'fixture-preview-token', scopeKey, revision: 2, checkedAt: '2026-11-04T03:00:00.000Z',
  localRows: [], incoming: [incomingNote()], conflicts: [], pendingRows: [], pendingResolutions: [], ...patch,
});

export function createNoteExchangeFixture(options = {}) {
  const calls = [], listeners = new Set(), noteEvents = [], overrides = new Map();
  const current = { status: noteStatus(options.status), notes: options.notes || [localNote(), localNote('local-two', { title: '访谈摘录' })] };
  const window = new EventTarget();
  window.addEventListener('paperquay:note-changed', event => noteEvents.push(event.detail));
  const copy = value => structuredClone(value);
  const advance = extra => { current.status = { ...current.status, revision: current.status.revision + 1, ...extra }; return copy(current.status); };
  window.paperquay = {
    invoke: async (command, args) => {
      calls.push({ command, args: copy(args) });
      if (overrides.has(command)) return overrides.get(command)(args);
      switch (command) {
        case 'desktop_note_status': return copy(current.status);
        case 'desktop_note_list': return { scopeKey: current.status.scopeKey, revision: current.status.revision, notes: copy(current.notes) };
        case 'desktop_note_preview': return notePreview({ scopeKey: current.status.scopeKey, revision: current.status.revision, localRows: args.noteIds.map(id => localRow(id)), ...options.preview });
        case 'desktop_note_publish': return advance({ bound: current.status.bound + 1 });
        case 'desktop_note_bind': return advance({ bound: current.status.bound + 1 });
        case 'desktop_note_delete': return advance({});
        case 'desktop_note_adopt': return { ...advance({ accepted: current.status.accepted + args.ids.length }), localNoteIds: options.adoptIds || ['new-local-copy'] };
        case 'desktop_note_resume_copies': return { ...advance({ copyPending: 0 }), localNoteIds: ['resumed-local-copy'] };
        case 'desktop_note_retry_save': return advance({ saveUnconfirmed: false, errorCode: null });
        case 'desktop_note_continue': return advance({ pending: 0, continuable: 0 });
        case 'desktop_note_stop': return copy({ ...current.status, busy: false });
        case 'desktop_note_resolve': return advance({ conflicts: 0 });
        case 'desktop_note_export': return { status: 'exported', bytes: 500 };
        default: throw new Error('Unexpected fixture command: ' + command);
      }
    },
    listen: async (event, listener) => { if (event !== 'desktop-account:changed') throw new Error('Unexpected event'); listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { window, calls, noteEvents, listeners, current, overrides, changed: () => { for (const listener of listeners) listener(); } };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
