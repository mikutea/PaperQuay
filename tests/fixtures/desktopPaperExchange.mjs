// Synthetic paper records and an in-memory Electron bridge. Never opens a service or user profile.
export const scopeKey = 'fixture-paper-account-library';
export const paperData = (patch = {}) => ({ title: '村庄公共空间的使用', doi: '10.0000/fixture', year: '2026', publication: '研究札记', abstractText: '本机观察记录：清晨和傍晚的使用者不同。', authors: ['李明', '周宁'], keywords: ['公共空间'], organization: { favorite: false, readingStatus: 'unread', tags: ['田野观察'], collections: ['居游共生'], queueRank: null }, ...patch });
export const paperMetadata = (patch = {}) => ({ title: '村庄公共空间的使用', doi: '10.0000/fixture', year: '2026', publication: '研究札记', abstractText: '接收前的本机摘要。', keywords: ['公共空间'], isFavorite: false, updatedAt: 1793743200000, authors: [{ id: 'author-private', name: '李明', givenName: '明', familyName: '李', sortOrder: 0 }], tags: [{ id: 'tag-private', name: '田野观察', color: '#2266aa', sortOrder: 0 }], ...patch });
export const paperStatus = (patch = {}) => ({ scopeKey, supported: true, organizationSupported: true, loaded: true, busy: false, revision: 2, pending: 0, continuable: 0, conflicts: 0, accepted: 1, bound: 2, adoptionPending: 0, restorationPending: 0, errorCode: null, saveUnconfirmed: false, ...patch });
export const localPaper = (id = 'local-one', patch = {}) => ({ localPaperId: id, title: '村庄公共空间的使用', updatedAt: 1793743200000, boundEntityId: 'account-' + id, ...patch });
export const localRow = (id = 'local-one', patch = {}) => ({ key: 'row-' + id, localPaperId: id, entityId: 'account-' + id, label: '村庄公共空间的使用', action: 'update', reason: null, local: paperData(), remote: paperData({ abstractText: '账号里的旧观察记录。' }), organizationSource: 'account', ...patch });
export const incomingPaper = (id = 'account-one', patch = {}) => ({ entityId: id, localPaperId: 'local-one', label: '村庄公共空间的使用', state: 'update', canAccept: true, reason: null, revision: 5, acceptedRevision: 3, data: paperData({ abstractText: '账号新摘要：补充周末观察。' }), local: paperData({ abstractText: '本机正在使用的摘要。' }), accepted: paperData(), ...patch });
export const paperConflict = (patch = {}) => ({ conflictId: 'private-conflict', entityId: 'account-one', label: '村庄公共空间的使用', expectedRevision: 5, attempted: { mutation: 'put', data: paperData({ abstractText: '尝试发送的观察。' }) }, current: { revision: 5, deletedAt: null, data: paperData({ abstractText: '账号当前的观察。' }) }, ...patch });
export const paperAdoption = (patch = {}) => ({ adoptionId: 'private-adoption', entityId: 'account-one', localPaperId: 'local-one', label: '村庄公共空间的使用', revision: 5, phase: 'applied', createdAt: '2026-11-04T06:00:00.000Z', before: paperMetadata(), after: paperMetadata({ abstractText: '接收后保存的账号摘要。', isFavorite: true, updatedAt: 1793764800000 }), beforeOrganization: { readingStatus: 'unread', collections: ['旧分类'], queueRank: null }, afterOrganization: { readingStatus: 'reading', collections: ['公共空间'], queueRank: 7 }, ...patch });
export const paperPreview = (patch = {}) => ({ token: 'fixture-paper-preview', scopeKey, revision: 2, checkedAt: '2026-11-04T06:30:00.000Z', localRows: [], incoming: [incomingPaper()], organizationPolicy: 'independent-account-names', conflicts: [], pendingRows: [], pendingResolutions: [], adoptions: [paperAdoption()], ...patch });
export function createPaperExchangeFixture(options = {}) {
  const calls = [], listeners = new Set(), libraryEvents = [], overrides = new Map();
  const current = { status: paperStatus(options.status), papers: options.papers || [localPaper(), localPaper('local-two', { title: '访谈样本与时段' }), localPaper('unlinked', { title: '尚未关联的文献', boundEntityId: null })] };
  const window = new EventTarget(); window.addEventListener('paperquay:library-content-changed', event => libraryEvents.push(event.type));
  const copy = value => structuredClone(value), advance = extra => { current.status = { ...current.status, revision: current.status.revision + 1, ...extra }; return copy(current.status); };
  window.paperquay = {
    invoke: async (command, args) => {
      calls.push({ command, args: copy(args) }); if (overrides.has(command)) return overrides.get(command)(args);
      switch (command) {
        case 'desktop_paper_status': return copy(current.status);
        case 'desktop_paper_list': return { scopeKey: current.status.scopeKey, revision: current.status.revision, papers: copy(current.papers) };
        case 'desktop_paper_preview': return paperPreview({ scopeKey: current.status.scopeKey, revision: current.status.revision, localRows: args.localPaperIds.map(id => localRow(id)), ...options.preview });
        case 'desktop_paper_publish': return advance({});
        case 'desktop_paper_organization': return advance({});
        case 'desktop_paper_adopt': return { ...advance({ accepted: current.status.accepted + args.ids.length }), localPaperIds: options.adoptIds ?? ['local-one'] };
        case 'desktop_paper_resume_adoptions': return { ...advance({ adoptionPending: 0, restorationPending: 0 }), localPaperIds: ['local-one'] };
        case 'desktop_paper_restore_adoption': return { ...advance({}), localPaperIds: ['local-one'] };
        case 'desktop_paper_retry_save': return advance({ saveUnconfirmed: false, errorCode: null });
        case 'desktop_paper_continue': return advance({ pending: 0, continuable: 0 });
        case 'desktop_paper_stop': current.status.busy = false; return copy(current.status);
        case 'desktop_paper_resolve': return advance({ conflicts: 0 });
        case 'desktop_paper_export': return { status: 'exported', bytes: 500 };
        default: throw Error('Unexpected fixture command: ' + command);
      }
    },
    listen: async (event, listener) => { if (event !== 'desktop-account:changed') throw Error('Unexpected event'); listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { window, calls, libraryEvents, current, listeners, overrides, changed: () => { for (const listener of listeners) listener(); } };
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
