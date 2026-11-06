import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPaperExchangeFixture, deferred, incomingPaper, localPaper, localRow, paperAdoption, paperConflict, paperData, paperPreview, paperStatus, scopeKey } from './fixtures/desktopPaperExchange.mjs';
const require = createRequire(import.meta.url);
async function load(entry) { const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' }); const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports); return module.exports; }
let ui, service, create, act;
test.before(async () => { [ui, service, { create, act }] = await Promise.all([load('src/features/reader/desktopPaperExchangePanel.tsx'), load('src/services/desktopPaperExchange.ts'), load(require.resolve('react-test-renderer'))]); });
const l = (zh, en) => { assert.equal(typeof en, 'string'); return zh; };
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
async function mount(t, options = {}) { const f = createPaperExchangeFixture(options), old = globalThis.window; globalThis.window = f.window; let root; await act(async () => { root = create(createElement(ui.DesktopPaperExchangePanel, { l, accountActive: true, ownerKey: scopeKey, onLinkPapers: options.onLinkPapers })); }); t.after(async () => { await act(async () => root.unmount()); globalThis.window = old; }); return { ...f, root }; }
const commands = f => f.calls.map(row => row.command);
function button(f, label) { const found = f.root.root.findAllByType('button').find(node => text(node) === label); assert.ok(found, 'Button exists: ' + label); return found; }
async function click(f, label) { const node = button(f, label); assert.ok(!node.props.disabled, 'Button enabled: ' + label); await act(async () => node.props.onClick()); }
async function task(f, name) { await act(async () => f.root.root.findByProps({ 'data-paper-task': name }).props.onClick()); }
const inputs = (f, type) => f.root.root.findAllByType('input').filter(node => node.props.type === type);
async function choose(f, type, index, checked = true) { const node = inputs(f, type)[index]; assert.ok(node && !node.props.disabled); await act(async () => node.props.onChange({ target: { checked } })); }
async function prepareSend(f) { await task(f, 'publish'); await choose(f, 'checkbox', 0); await click(f, '查看发送内容'); await click(f, '继续发送'); }

test('service binds every paper operation to its exact IPC contract and native backup picker', async () => {
  const f = createPaperExchangeFixture(), old = globalThis.window; globalThis.window = f.window;
  try { const s = service.desktopPaperExchange; await s.status(); await s.list(); await s.preview({ localPaperIds: ['local-one'] }); await s.publish({ token: 'p' }); await s.adopt({ token: 'a', ids: ['account-one'] }); await s.organization({ token: 'o', localPaperId: 'local-one', readingStatus: 'reading', queued: true, collections: ['调研'] }); await s.resumeAdoptions(); await s.restoreAdoption({ adoptionId: 'r' }); await s.continue(); await s.stop(); await s.resolve({ conflictId: 'c', choice: 'current', expectedRevision: 3 }); await s.retrySave(); await s.exportBackup(); const stop = await s.onChanged(() => {}); assert.equal(f.listeners.size, 1); stop(); assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.calls, [{ command: 'desktop_paper_status', args: {} }, { command: 'desktop_paper_list', args: {} }, { command: 'desktop_paper_preview', args: { localPaperIds: ['local-one'] } }, { command: 'desktop_paper_publish', args: { token: 'p' } }, { command: 'desktop_paper_adopt', args: { token: 'a', ids: ['account-one'] } }, { command: 'desktop_paper_organization', args: { token: 'o', localPaperId: 'local-one', readingStatus: 'reading', queued: true, collections: ['调研'] } }, { command: 'desktop_paper_resume_adoptions', args: {} }, { command: 'desktop_paper_restore_adoption', args: { adoptionId: 'r' } }, { command: 'desktop_paper_continue', args: {} }, { command: 'desktop_paper_stop', args: {} }, { command: 'desktop_paper_resolve', args: { conflictId: 'c', choice: 'current', expectedRevision: 3 } }, { command: 'desktop_paper_retry_save', args: {} }, { command: 'desktop_paper_export', args: {} }]);
  } finally { globalThis.window = old; }
});
test('opening reads only status; each of four tasks is explicit and local selection cannot pick unlinked papers', async t => {
  let linked = 0; const f = await mount(t, { onLinkPapers: () => linked++ }); assert.deepEqual(commands(f), ['desktop_paper_status']);
  assert.deepEqual(f.root.root.findAllByType('button').filter(node => node.props['data-paper-task']).map(node => node.props['data-paper-task']), ['publish', 'adopt', 'organization', 'pending']);
  await task(f, 'publish'); assert.deepEqual(commands(f), ['desktop_paper_status', 'desktop_paper_list']); assert.ok(inputs(f, 'checkbox').every(node => !node.props.checked)); assert.ok(inputs(f, 'checkbox')[2].props.disabled); assert.ok(button(f, '查看发送内容').props.disabled); await click(f, '去关联文献'); assert.equal(linked, 1);
});
test('send reviews actual fields before confirmation and publishes the entire executable preview using only token', async t => {
  const f = await mount(t); await task(f, 'publish'); await choose(f, 'checkbox', 0); await choose(f, 'checkbox', 1); await click(f, '查看发送内容');
  assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_preview').args, { localPaperIds: ['local-one', 'local-two'] }); assert.match(text(f.root.toJSON()), /账号里的旧观察记录/); assert.match(text(f.root.toJSON()), /本机观察记录/); assert.equal(inputs(f, 'checkbox').length, 0); assert.ok(!commands(f).includes('desktop_paper_publish'));
  await click(f, '继续发送'); assert.ok(!commands(f).includes('desktop_paper_publish')); await click(f, '发送这 2 份修改'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_publish').args, { token: 'fixture-paper-preview' }); assert.equal(f.libraryEvents.length, 0);
});
test('selection is bounded across search and pages and does not select hidden papers', async t => {
  const f = await mount(t, { papers: Array.from({ length: 17 }, (_, i) => localPaper('paper-' + i, { title: '文献 ' + i })) }); await task(f, 'publish');
  for (let page = 0; page < 2; page++) { for (let i = 0; i < 8; i++) await choose(f, 'checkbox', i); await click(f, '下一页'); } assert.ok(inputs(f, 'checkbox')[0].props.disabled); assert.equal(inputs(f, 'checkbox')[0].props.checked, false);
  await act(async () => inputs(f, 'search')[0].props.onChange({ target: { value: '文献 16' } })); assert.ok(inputs(f, 'checkbox')[0].props.disabled); await click(f, '查看发送内容'); assert.equal(f.calls.find(row => row.command === 'desktop_paper_preview').args.localPaperIds.length, 16);
});
test('receive starts with zero choices, shows local/account diff and emits ordinary library changed event only after apply', async t => {
  const f = await mount(t); await task(f, 'adopt'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_preview').args, { localPaperIds: [] }); assert.ok(inputs(f, 'checkbox').every(node => !node.props.checked)); assert.ok(button(f, '查看接收选择').props.disabled); assert.match(text(f.root.toJSON()), /本机正在使用的摘要/); assert.match(text(f.root.toJSON()), /账号新摘要/);
  await choose(f, 'checkbox', 0); await click(f, '查看接收选择'); assert.ok(!commands(f).includes('desktop_paper_adopt')); await click(f, '接收所选 1 项'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_adopt').args, { token: 'fixture-paper-preview', ids: ['account-one'] }); assert.deepEqual(f.libraryEvents, ['paperquay:library-content-changed']);
});
test('deleted and unbound account papers explain limits and cannot be adopted or create/delete local papers', async t => {
  const f = await mount(t, { preview: { incoming: [incomingPaper('deleted', { state: 'deleted', data: null, canAccept: false, reason: 'PAPER_REMOTE_UNAVAILABLE' }), incomingPaper('unbound', { localPaperId: null, canAccept: false, reason: 'PAPER_BINDING_REQUIRED' })] } }); await task(f, 'adopt'); assert.ok(inputs(f, 'checkbox').every(node => node.props.disabled)); assert.match(text(f.root.toJSON()), /账号文献已删除，本机文献保留/); assert.match(text(f.root.toJSON()), /先在文件共享中关联/); assert.ok(!commands(f).some(name => /adopt|delete|create/.test(name)));
});
test('reading arrangement uses independent draft and saving does not publish or claim synced', async t => {
  const f = await mount(t); await task(f, 'organization'); assert.ok(inputs(f, 'radio').every(node => !node.props.checked)); await choose(f, 'radio', 0); await click(f, '检查阅读安排');
  assert.match(text(f.root.toJSON()), /账号分类名称不改本机分类层级/); await act(async () => f.root.root.findByType('select').props.onChange({ target: { value: 'reading' } })); await choose(f, 'checkbox', 0); await act(async () => f.root.root.findByType('textarea').props.onChange({ target: { value: ' 调研 \n乡村\n' } })); await click(f, '保存本机阅读安排');
  assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_organization').args, { token: 'fixture-paper-preview', localPaperId: 'local-one', readingStatus: 'reading', queued: true, collections: ['调研', '乡村'] }); assert.ok(!commands(f).includes('desktop_paper_publish')); assert.match(text(f.root.toJSON()), /已保存在此账号的本机草稿/); assert.doesNotMatch(text(f.root.toJSON()), /已同步/); assert.equal(f.libraryEvents.length, 0);
});
test('organization editing revokes a captured save callback so it cannot save an old plan', async t => {
  const f = await mount(t); await task(f, 'organization'); await choose(f, 'radio', 0); await click(f, '检查阅读安排'); const stale = button(f, '保存本机阅读安排').props.onClick;
  await act(async () => f.root.root.findByType('textarea').props.onChange({ target: { value: '修改后的分类' } })); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_paper_organization')); await click(f, '保存本机阅读安排'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_organization').args.collections, ['修改后的分类']);
});
test('pending operations preserve original status and conflict selection requires explicit choice', async t => {
  const f = await mount(t, { status: { pending: 1, continuable: 1, conflicts: 1 }, preview: { conflicts: [paperConflict()], pendingRows: [{ opId: 'private-op', entityId: 'account-one', label: '上次修改', mutation: 'put', stage: 'uncertain', data: paperData() }], pendingResolutions: [{ conflictId: 'private-other-conflict', opId: 'private-resolution', expectedRevision: 4, choice: 'current', lastResult: null }] } });
  await task(f, 'pending'); assert.match(text(f.root.toJSON()), /上次发送的结果未知/); assert.match(text(f.root.toJSON()), /账号当前的观察/); assert.match(text(f.root.toJSON()), /尝试发送的观察/); assert.ok(button(f, '确认这项选择').props.disabled); assert.ok(inputs(f, 'radio').every(node => !node.props.checked)); await choose(f, 'radio', 0); await click(f, '确认这项选择'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_resolve').args, { conflictId: 'private-conflict', choice: 'current', expectedRevision: 5 });
  await click(f, '重新检查'); await click(f, '继续处理原请求'); assert.equal(commands(f).filter(name => name === 'desktop_paper_continue').length, 1); assert.ok(!commands(f).includes('desktop_paper_publish'));
});
test('two distinct recovery buttons save sync result before resuming receipt or undo, without network re-execution', async t => {
  const f = await mount(t, { status: { saveUnconfirmed: true, adoptionPending: 2, restorationPending: 1, errorCode: 'PAPER_SAVE_UNCONFIRMED' } }); assert.ok(button(f, '继续保存到本机').props.disabled); await click(f, '保存同步结果'); assert.ok(!commands(f).includes('desktop_paper_resume_adoptions')); await click(f, '继续保存到本机'); assert.equal(f.libraryEvents.length, 1); assert.deepEqual(commands(f).filter(name => name !== 'desktop_paper_status'), ['desktop_paper_retry_save', 'desktop_paper_resume_adoptions']);
});
test('undo confirms the specific receipt and reversed metadata/organization diff, then emits library changed only', async t => {
  const f = await mount(t); await task(f, 'pending'); await click(f, '撤销这次接收'); assert.ok(!commands(f).includes('desktop_paper_restore_adoption'));
  const dialog = f.root.root.findByProps({ 'aria-label': '确认撤销接收' }); assert.match(text(dialog), /村庄公共空间的使用/); assert.match(text(dialog), /接收后保存的账号摘要/); assert.match(text(dialog), /接收前的本机摘要/); assert.match(text(dialog), /旧分类/); assert.match(text(dialog), /公共空间/); assert.match(text(dialog), /撤销后恢复的内容/);
  await click(f, '确认撤销这次接收'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_restore_adoption').args, { adoptionId: 'private-adoption' }); assert.equal(f.libraryEvents.length, 1); assert.ok(!commands(f).includes('desktop_paper_publish')); assert.match(text(f.root.toJSON()), /账号内容未改动/);
});
test('a later local edit blocks undo, keeps current data and emits no library success event', async t => {
  const f = await mount(t); f.overrides.set('desktop_paper_restore_adoption', () => { throw Object.assign(Error('PAPER_SOURCE_CHANGED'), { code: 'PAPER_SOURCE_CHANGED' }); }); await task(f, 'pending'); await click(f, '撤销这次接收'); await click(f, '确认撤销这次接收'); assert.match(text(f.root.toJSON()), /本机文献已有后续修改/); assert.equal(f.libraryEvents.length, 0); assert.doesNotMatch(text(f.root.toJSON()), /这次接收已撤销/);
});
test('restored and pending receipts do not offer a new undo action', async t => {
  const f = await mount(t, { preview: { adoptions: [paperAdoption({ phase: 'restored' }), paperAdoption({ adoptionId: 'other', phase: 'restoring' })] } }); await task(f, 'pending'); assert.ok(!f.root.root.findAllByType('button').some(node => text(node) === '撤销这次接收')); assert.match(text(f.root.toJSON()), /已撤销/); assert.match(text(f.root.toJSON()), /撤销待保存/);
});
test('new selection, preview revision or returning from confirmation revoke captured publish callbacks', async t => {
  const f = await mount(t); await prepareSend(f); const stale = button(f, '发送这 1 份修改').props.onClick; await click(f, '返回查看'); await click(f, '重新选择文献'); await choose(f, 'checkbox', 1); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_paper_publish'));
  await click(f, '查看发送内容'); await click(f, '继续发送'); const oldRevision = button(f, '发送这 2 份修改').props.onClick; await act(async () => { f.current.status.revision++; f.changed(); }); await act(async () => oldRevision()); assert.ok(!commands(f).includes('desktop_paper_publish')); assert.equal(f.root.root.findAllByProps({ 'data-paper-review': true }).length, 0);
});
for (const ownerKind of ['account', 'library']) test(`changing ${ownerKind} revokes captured undo callbacks and delayed adoption notifications`, async t => {
  const f = await mount(t), pending = deferred(); await task(f, 'pending'); await click(f, '撤销这次接收'); const stale = button(f, '确认撤销这次接收').props.onClick;
  const changeOwner = async owner => { f.current.status = paperStatus({ scopeKey: owner }); await act(async () => f.root.update(createElement(ui.DesktopPaperExchangePanel, { l, accountActive: true, ownerKey: owner }))); };
  await changeOwner('different-' + ownerKind); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_paper_restore_adoption'));
  await changeOwner(scopeKey); await task(f, 'adopt'); await choose(f, 'checkbox', 0); await click(f, '查看接收选择'); f.overrides.set('desktop_paper_adopt', () => pending.promise); await click(f, '接收所选 1 项'); await changeOwner('other-' + ownerKind);
  await act(async () => pending.resolve({ ...paperStatus({ revision: 8 }), localPaperIds: ['local-one'] })); assert.equal(f.libraryEvents.length, 0); assert.doesNotMatch(text(f.root.toJSON()), /所选修改已保存/);
});
test('stop waiting rejects a late preview and opening or navigating never exports automatically', async t => {
  const f = await mount(t), pending = deferred(); f.overrides.set('desktop_paper_preview', () => pending.promise); await task(f, 'adopt'); await click(f, '停止等待'); await act(async () => pending.resolve(paperPreview())); assert.equal(f.root.root.findAllByProps({ 'data-paper-review': true }).length, 0); assert.ok(!commands(f).includes('desktop_paper_export')); await click(f, '导出题录同步备份'); assert.equal(commands(f).filter(name => name === 'desktop_paper_export').length, 1);
});
test('empty local mutation result does not notify the library', async t => { const f = await mount(t, { adoptIds: [] }); await task(f, 'adopt'); await choose(f, 'checkbox', 0); await click(f, '查看接收选择'); await click(f, '接收所选 1 项'); assert.equal(f.libraryEvents.length, 0); });
test('legacy account data without organization previews preserved local favorite, tags and reading plan', async t => {
  const legacy = paperData(); delete legacy.organization;
  const f = await mount(t, { preview: { incoming: [incomingPaper('account-one', { data: legacy })] } }); await task(f, 'adopt');
  assert.match(text(f.root.toJSON()), /本机标签、收藏和阅读安排保留/);
  for (const key of ['favorite', 'tags', 'readingStatus', 'queued', 'collections']) {
    const field = f.root.root.findAllByProps({ 'data-paper-field': key })[0]; assert.ok(field);
    let node = field, collapsed = false; while (node) { if (node.type === 'details') { collapsed = true; break; } node = node.parent; }
    assert.ok(collapsed, key + ' must remain an unchanged field, not a proposed removal');
  }
});
test('changing receive selection revokes the previous confirmation and does not adopt the wrong set', async t => {
  const f = await mount(t, { preview: { incoming: [incomingPaper(), incomingPaper('account-two', { localPaperId: 'local-two' })] } }); await task(f, 'adopt'); await choose(f, 'checkbox', 0); await click(f, '查看接收选择'); const stale = button(f, '接收所选 1 项').props.onClick;
  await click(f, '返回选择'); await choose(f, 'checkbox', 0, false); await choose(f, 'checkbox', 1); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_paper_adopt')); await click(f, '查看接收选择'); await click(f, '接收所选 1 项'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_paper_adopt').args.ids, ['account-two']);
});
test('undo clearly restores absence of an account-local reading draft without pretending to erase account plans', async t => {
  const f = await mount(t, { preview: { adoptions: [paperAdoption({ beforeOrganization: null })] } }); await task(f, 'pending'); await click(f, '撤销这次接收'); const dialog = f.root.root.findByProps({ 'aria-label': '确认撤销接收' }); assert.match(text(dialog), /本机阅读草稿：状态/); assert.match(text(dialog), /无本机草稿，使用账号安排/);
});
test('display diff keeps queue rank/IDs out of normal content and bounds abstracts and long lists', () => {
  const html = renderToStaticMarkup(createElement(ui.DesktopPaperDiff, { before: paperData(), after: paperData({ authors: ['甲', '乙', '丙', '丁', '戊'], abstractText: '新摘要'.repeat(1000), organization: { favorite: true, tags: ['新标签'], readingStatus: 'reading', collections: ['调研'], queueRank: 987654321 } }), beforeLabel: '本机当前', afterLabel: '接收后', l }));
  assert.doesNotMatch(html, /987654321|queueRank|entityId|localPaperId/); assert.match(html, /查看全部 5 项/); assert.match(html, /max-h-40 overflow-y-auto/); assert.match(html, /已加入清单/); assert.match(html, /未设置|未变化/);
});
