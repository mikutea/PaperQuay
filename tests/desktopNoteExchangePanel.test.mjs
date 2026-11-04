import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';
import { createNoteExchangeFixture, deferred, incomingNote, localNote, localRow, noteConflict, notePreview, noteStatus, noteSummary, scopeKey } from './fixtures/desktopNoteExchange.mjs';

const require = createRequire(import.meta.url);
async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
let ui, service, create, act;
test.before(async () => {
  // Bundle the declared desktop test renderer while sharing the desktop React instance.
  [ui, service, { create, act }] = await Promise.all([
    load('src/features/reader/desktopNoteExchangePanel.tsx'), load('src/services/desktopNoteExchange.ts'),
    load(require.resolve('react-test-renderer')),
  ]);
});
const l = (zh, en) => { assert.equal(typeof en, 'string', 'Each label has an English translation'); return zh; };
function text(node) { return typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : ''; }
function elements(markup) {
  const result = [], walk = node => { result.push(node); for (const child of node.childNodes || []) walk(child); };
  walk(parseFragment(markup)); return result;
}
const attr = (node, name) => node.attrs?.find(value => value.name === name)?.value;
const htmlText = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(htmlText).join('');
const props = patch => ({ task: 'publish', preview: notePreview(), disabled: false, selectedIncoming: [], bindingEntityId: '', deleteEntityId: '', confirmation: null, restoreConfirmed: false, conflictChoices: {},
  onToggleIncoming() {}, onBinding() {}, onConfirm() {}, onRestoreConfirmed() {}, onPublish() {}, onAdopt() {}, onBind() {}, onDeleteSelection() {}, onDelete() {}, onBackToSelection() {}, onConflictChoice() {}, onResolve() {}, l, ...patch });
const render = patch => renderToStaticMarkup(createElement(ui.DesktopNoteExchangeReview, props(patch)));

async function mount(t, options = {}) {
  const fixture = createNoteExchangeFixture(options), oldWindow = globalThis.window;
  globalThis.window = fixture.window;
  let root;
  await act(async () => { root = create(createElement(ui.DesktopNoteExchangePanel, { l, accountActive: true, ownerKey: scopeKey })); });
  t.after(async () => { await act(async () => root.unmount()); globalThis.window = oldWindow; });
  return { ...fixture, root };
}
function button(fixture, label) {
  const found = fixture.root.root.findAllByType('button').find(node => text(node) === label);
  assert.ok(found, `Button exists: ${label}`); return found;
}
async function click(fixture, label) {
  const node = button(fixture, label); assert.ok(!node.props.disabled, `Button is enabled: ${label}`);
  await act(async () => { node.props.onClick(); });
}
function inputs(fixture, type) { return fixture.root.root.findAllByType('input').filter(node => node.props.type === type); }
async function choose(fixture, type, index, checked = true) {
  const input = inputs(fixture, type)[index]; assert.ok(input); assert.ok(!input.props.disabled);
  await act(async () => { input.props.onChange({ target: { checked } }); });
}
const commands = fixture => fixture.calls.map(call => call.command);

test('service uses exact note IPC contracts and the native export picker', async () => {
  const f = createNoteExchangeFixture(), oldWindow = globalThis.window; globalThis.window = f.window;
  try {
    const s = service.desktopNoteExchange;
    await s.status(); await s.list(); await s.preview({ noteIds: ['local-one', 'local-two'] });
    await s.publish({ token: 'p' }); await s.bind({ token: 'b', localNoteId: 'local-one', entityId: 'account-one' });
    await s.adopt({ token: 'a', ids: ['account-one'] }); await s.deleteFromAccount({ token: 'd', entityId: 'account-one' }); await s.continue(); await s.stop(); await s.retrySave(); await s.resumeCopies();
    await s.resolve({ conflictId: 'c', choice: 'attempted', expectedRevision: 9 }); await s.exportBackup();
    const stop = await s.onChanged(() => {}); assert.equal(f.listeners.size, 1); stop(); assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.calls, [
      { command: 'desktop_note_status', args: {} }, { command: 'desktop_note_list', args: {} },
      { command: 'desktop_note_preview', args: { noteIds: ['local-one', 'local-two'] } },
      { command: 'desktop_note_publish', args: { token: 'p' } },
      { command: 'desktop_note_bind', args: { token: 'b', localNoteId: 'local-one', entityId: 'account-one' } },
      { command: 'desktop_note_adopt', args: { token: 'a', ids: ['account-one'] } },
      { command: 'desktop_note_delete', args: { token: 'd', entityId: 'account-one' } },
      ...['continue', 'stop', 'retry_save', 'resume_copies'].map(name => ({ command: 'desktop_note_' + name, args: {} })),
      { command: 'desktop_note_resolve', args: { conflictId: 'c', choice: 'attempted', expectedRevision: 9 } },
      { command: 'desktop_note_export', args: {} },
    ]);
  } finally { globalThis.window = oldWindow; }
});

test('task navigation exposes four clear destinations and does not fetch remotely until requested', async t => {
  const f = await mount(t);
  assert.deepEqual(commands(f), ['desktop_note_status']);
  const tasks = f.root.root.findAllByType('button').filter(node => node.props['data-note-task']);
  assert.deepEqual(tasks.map(node => text(node).slice(0, 6)), ['发送本机笔记', '接收账号笔记', '关联已有笔记', '处理未完成操']);
  await act(async () => tasks[0].props.onClick());
  assert.deepEqual(commands(f), ['desktop_note_status', 'desktop_note_list']);
  assert.equal(inputs(f, 'checkbox').filter(node => node.props.checked).length, 0);
  assert.equal(button(f, '查看发送内容').props.disabled, true);
});

test('publication chooses notes before preview and sends the entire executable preview using only its token', async t => {
  const f = await mount(t);
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'publish' }).props.onClick());
  await choose(f, 'checkbox', 0); await choose(f, 'checkbox', 1); await click(f, '查看发送内容');
  assert.deepEqual(f.calls.find(call => call.command === 'desktop_note_preview').args, { noteIds: ['local-one', 'local-two'] });
  assert.equal(inputs(f, 'checkbox').length, 0, 'No subset checkboxes after capturing references');
  assert.ok(!commands(f).includes('desktop_note_publish'));
  await click(f, '继续发送'); assert.ok(!commands(f).includes('desktop_note_publish'));
  await click(f, '发送这 2 份笔记');
  assert.deepEqual(f.calls.find(call => call.command === 'desktop_note_publish').args, { token: 'fixture-preview-token' });
  assert.match(text(f.root.toJSON()), /已处理这批笔记的发送/);
});

test('restoration needs a new explicit acknowledgement and changing selection invalidates the old confirmation', async t => {
  const f = await mount(t, { preview: { localRows: [localRow('local-one', { action: 'restore' })] } });
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'publish' }).props.onClick());
  await choose(f, 'checkbox', 0); await click(f, '查看发送内容'); await click(f, '继续发送');
  assert.equal(button(f, '发送这 1 份笔记').props.disabled, true);
  await choose(f, 'checkbox', 0); const stale = button(f, '发送这 1 份笔记').props.onClick;
  await click(f, '返回查看'); await click(f, '重新选择笔记');
  await act(async () => stale());
  assert.ok(!commands(f).includes('desktop_note_publish'));
  await click(f, '查看发送内容'); await click(f, '继续发送');
  assert.equal(inputs(f, 'checkbox')[0].props.checked, false, 'A refreshed restore is never preconfirmed');
  await choose(f, 'checkbox', 0); await click(f, '发送这 1 份笔记');
  assert.equal(commands(f).filter(name => name === 'desktop_note_publish').length, 1);
});

test('selection remains bounded across search and pagination without preselecting hidden notes', async t => {
  const f = await mount(t, { notes: Array.from({ length: 17 }, (_, i) => localNote('note-' + i, { title: '笔记 ' + i })) });
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'publish' }).props.onClick());
  for (let page = 0; page < 2; page++) { for (let i = 0; i < 8; i++) await choose(f, 'checkbox', i); await click(f, '下一页'); }
  assert.equal(inputs(f, 'checkbox')[0].props.disabled, true); assert.equal(inputs(f, 'checkbox')[0].props.checked, false);
  assert.match(text(f.root.toJSON()), /已选择 16 份/);
  await act(async () => inputs(f, 'search')[0].props.onChange({ target: { value: '笔记 16' } }));
  assert.equal(inputs(f, 'checkbox')[0].props.disabled, true);
  await click(f, '查看发送内容');
  assert.equal(f.calls.find(call => call.command === 'desktop_note_preview').args.noteIds.length, 16);
});

test('manual binding never guesses from identical titles and confirms both bodies before linking only', async t => {
  const f = await mount(t, { preview: { incoming: [incomingNote('account-one'), incomingNote('account-two', { data: noteSummary({ body: '另一份同名笔记的内容。' }) })] } });
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'bind' }).props.onClick());
  assert.ok(inputs(f, 'radio').every(node => !node.props.checked));
  await choose(f, 'radio', 0); await click(f, '选择对应的账号笔记');
  assert.ok(inputs(f, 'radio').every(node => !node.props.checked)); assert.equal(button(f, '核对关联内容').props.disabled, true);
  await choose(f, 'radio', 1); await click(f, '核对关联内容');
  const confirmation = f.root.root.findByProps({ 'aria-label': '确认关联笔记' });
  assert.match(text(confirmation), /本机已保存的完整正文/); assert.match(text(confirmation), /另一份同名笔记的内容/);
  assert.ok(!commands(f).includes('desktop_note_bind'));
  await click(f, '仅关联这两份笔记');
  assert.deepEqual(f.calls.find(call => call.command === 'desktop_note_bind').args, { token: 'fixture-preview-token', localNoteId: 'local-one', entityId: 'account-two' });
  assert.ok(!commands(f).some(name => ['desktop_note_publish', 'desktop_note_adopt'].includes(name)));
});

test('receiving preserves originals and notifies ordinary note views only for created local copies', async t => {
  const f = await mount(t);
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'adopt' }).props.onClick());
  assert.deepEqual(f.calls.find(call => call.command === 'desktop_note_preview').args, { noteIds: [] });
  await choose(f, 'checkbox', 0); await click(f, '查看接收选择'); await click(f, '接收所选 1 项');
  assert.deepEqual(f.calls.find(call => call.command === 'desktop_note_adopt').args, { token: 'fixture-preview-token', ids: ['account-one'] });
  assert.deepEqual(f.noteEvents, [{ action: 'created', noteId: 'new-local-copy', sourceId: 'desktop-note-exchange' }]);
  assert.match(text(f.root.toJSON()), /新副本可在笔记中继续编辑，原笔记保留/);
});

test('account deletion clearly means receiving a marker and never dispatches a local deletion', async t => {
  const f = await mount(t, { preview: { incoming: [incomingNote('deleted-account', { state: 'delete', data: null })] }, adoptIds: [] });
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'adopt' }).props.onClick());
  assert.match(text(f.root.toJSON()), /仅接收删除标记，本机笔记保留/);
  await choose(f, 'checkbox', 0); await click(f, '查看接收选择');
  assert.match(text(f.root.root.findByProps({ 'aria-label': '确认接收笔记' })), /删除标记/);
  await click(f, '接收所选 1 项'); assert.deepEqual(f.noteEvents, []);
  assert.ok(!commands(f).includes('notes_delete'));
});

test('moving a live account note to trash previews its title and needs an explicit confirmation', async t => {
  const f = await mount(t);
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'adopt' }).props.onClick());
  const action = button(f, '从账号移到废纸篓');
  assert.equal(action.parent.type, 'details', 'The secondary action stays collapsed by default');
  await click(f, '从账号移到废纸篓');
  assert.ok(!commands(f).includes('desktop_note_delete'));
  const confirmation = f.root.root.findByProps({ 'aria-label': '确认从账号移除笔记' });
  assert.match(text(confirmation), /乡村公共空间/); assert.match(text(confirmation), /本机原笔记与已接收的副本都会保留/);
  assert.match(text(confirmation), /账号中的完整正文/);
  assert.ok(!f.root.root.findAllByType('button').some(node => text(node) === '查看接收选择'), 'Trash confirmation shows only its relevant final action');
  await click(f, '确认移到废纸篓');
  assert.deepEqual(f.calls.find(call => call.command === 'desktop_note_delete').args, { token: 'fixture-preview-token', entityId: 'account-one' });
  assert.deepEqual(f.noteEvents, []); assert.ok(!commands(f).includes('notes_delete'));
});

test('changing owner revokes a captured account-trash confirmation', async t => {
  const f = await mount(t);
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'adopt' }).props.onClick());
  await click(f, '从账号移到废纸篓'); const stale = button(f, '确认移到废纸篓').props.onClick;
  await act(async () => {
    f.current.status = noteStatus({ scopeKey: 'different-library' });
    f.root.update(createElement(ui.DesktopNoteExchangePanel, { l, accountActive: true, ownerKey: 'different-library' }));
  });
  await act(async () => stale());
  assert.ok(!commands(f).includes('desktop_note_delete'));
  assert.doesNotMatch(text(f.root.toJSON()), /确认移到废纸篓/);
});

test('deleted, conflicted and pending account notes have no trash action', () => {
  const html = render({ task: 'adopt', preview: notePreview({
    incoming: [incomingNote('deleted', { state: 'delete', data: null }), incomingNote('pending', { state: 'pending' }), incomingNote('conflicted')],
    conflicts: [noteConflict({ entityId: 'conflicted' })],
  }) });
  assert.doesNotMatch(html, /从账号移到废纸篓/);
});

test('preview revision changes invalidate captured action callbacks before they can publish', async t => {
  const f = await mount(t);
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'publish' }).props.onClick());
  await choose(f, 'checkbox', 0); await click(f, '查看发送内容'); await click(f, '继续发送');
  const stale = button(f, '发送这 1 份笔记').props.onClick;
  await act(async () => { f.current.status.revision++; f.changed(); });
  await act(async () => stale());
  assert.ok(!commands(f).includes('desktop_note_publish'));
  assert.equal(f.root.root.findAllByProps({ 'data-desktop-note-review': true }).length, 0);
});

test('changing account or library rejects stale publication callbacks and delayed copy notifications', async t => {
  const f = await mount(t), pending = deferred();
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'adopt' }).props.onClick());
  await choose(f, 'checkbox', 0); await click(f, '查看接收选择');
  const stale = button(f, '接收所选 1 项').props.onClick;
  f.overrides.set('desktop_note_adopt', () => pending.promise);
  await click(f, '接收所选 1 项');
  await act(async () => {
    f.current.status = noteStatus({ scopeKey: 'different-account-and-library' });
    f.root.update(createElement(ui.DesktopNoteExchangePanel, { l, accountActive: true, ownerKey: 'different-account-and-library' }));
  });
  await act(async () => { pending.resolve({ ...noteStatus(), localNoteIds: ['old-owner-copy'] }); });
  await act(async () => stale());
  assert.equal(commands(f).filter(name => name === 'desktop_note_adopt').length, 1);
  assert.deepEqual(f.noteEvents, []); assert.doesNotMatch(text(f.root.toJSON()), /old-owner-copy|所选内容已接收/);
  assert.equal(f.listeners.size, 1);
});

test('stopping an in-flight check makes its later response inert', async t => {
  const f = await mount(t), pending = deferred();
  f.overrides.set('desktop_note_preview', () => pending.promise);
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'adopt' }).props.onClick());
  await click(f, '停止等待');
  await act(async () => pending.resolve(notePreview({ incoming: [incomingNote('late', { label: '迟到的旧响应' })] })));
  assert.doesNotMatch(text(f.root.toJSON()), /迟到的旧响应/);
  assert.equal(commands(f).filter(name => name === 'desktop_note_stop').length, 1);
  assert.ok(!commands(f).includes('desktop_note_adopt'));
});

test('unmount invalidates pending results and removes listeners', async t => {
  const f = await mount(t), pending = deferred();
  f.overrides.set('desktop_note_preview', () => pending.promise);
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'pending' }).props.onClick());
  await act(async () => f.root.unmount()); assert.equal(f.listeners.size, 0);
  await act(async () => pending.resolve(notePreview()));
  assert.deepEqual(f.noteEvents, []);
});

test('unconfirmed private state and unfinished copies use distinct explicit local save actions', async t => {
  const f = await mount(t, { status: { saveUnconfirmed: true, copyPending: 1, errorCode: 'NOTE_SAVE_UNCONFIRMED' } });
  assert.equal(button(f, '继续保存本机副本').props.disabled, true);
  await click(f, '保存同步结果');
  assert.ok(!commands(f).some(name => ['desktop_note_preview', 'desktop_note_publish', 'desktop_note_adopt'].includes(name)));
  await click(f, '继续保存本机副本');
  assert.deepEqual(f.noteEvents, [{ action: 'created', noteId: 'resumed-local-copy', sourceId: 'desktop-note-exchange' }]);
  assert.ok(commands(f).includes('desktop_note_retry_save')); assert.ok(commands(f).includes('desktop_note_resume_copies'));
  assert.ok(!commands(f).some(name => ['desktop_note_preview', 'desktop_note_publish', 'desktop_note_adopt'].includes(name)));
});

test('new save recovery clears obsolete success messages and presents the required local action first', async t => {
  const f = await mount(t, { status: { continuable: 1 }, preview: { conflicts: [noteConflict()] } });
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'pending' }).props.onClick());
  await choose(f, 'radio', 0); await click(f, '应用这项选择');
  assert.match(text(f.root.toJSON()), /已处理这项选择/);
  await act(async () => { f.current.status = { ...f.current.status, saveUnconfirmed: true, copyPending: 1, errorCode: 'NOTE_SAVE_UNCONFIRMED' }; f.changed(); });
  assert.doesNotMatch(text(f.root.toJSON()), /已处理这项选择/);
  assert.ok(!f.root.root.findAllByType('button').some(node => text(node) === '继续处理'));
  assert.ok(!button(f, '保存同步结果').props.disabled);
  assert.equal(button(f, '继续保存本机副本').props.disabled, true);
});

test('pending actions retain both conflict bodies and demand an explicit choice', async t => {
  const f = await mount(t, { status: { conflicts: 1 }, preview: { conflicts: [noteConflict()] } });
  await act(async () => f.root.root.findByProps({ 'data-note-task': 'pending' }).props.onClick());
  assert.match(text(f.root.toJSON()), /账号笔记已删除/); assert.match(text(f.root.toJSON()), /本次准备恢复的内容/);
  assert.ok(inputs(f, 'radio').every(node => !node.props.checked)); assert.equal(button(f, '应用这项选择').props.disabled, true);
  await choose(f, 'radio', 1); await click(f, '应用这项选择');
  assert.deepEqual(f.calls.find(call => call.command === 'desktop_note_resolve').args, { conflictId: 'conflict-private-id', choice: 'attempted', expectedRevision: 5 });
});

test('blocked and unchanged notes cannot be sent and incoming eligibility cannot be overridden by selection', () => {
  const sent = render({ preview: notePreview({ localRows: [localRow('a', { action: 'blocked', reason: 'NOTE_RICH_UNAVAILABLE' }), localRow('b', { action: 'none' })] }), confirmation: 'publish' });
  const sendButton = elements(sent).find(node => node.tagName === 'button' && htmlText(node) === '发送这 0 份笔记');
  assert.notEqual(attr(sendButton, 'disabled'), undefined);
  const received = render({ task: 'adopt', preview: notePreview({ incoming: [incomingNote('blocked', { canAccept: false })] }), selectedIncoming: ['blocked'], confirmation: 'adopt' });
  assert.notEqual(attr(elements(received).find(node => node.tagName === 'button' && htmlText(node) === '接收所选 0 项'), 'disabled'), undefined);
});

test('technical identifiers and error codes remain in closed details; note text is escaped and fully preserved', () => {
  const html = render({ task: 'pending', preview: notePreview({ conflicts: [noteConflict()], pendingRows: [{ opId: 'private-original-op', entityId: 'private-entity-id', label: '上次笔记', stage: 'uncertain', mutation: 'put', data: noteSummary({ body: '第一段\n<script>not executable</script>\n最后一段' }) }], pendingResolutions: [{ conflictId: 'private-conflict', opId: 'private-resolution', expectedRevision: 9, choice: 'current', lastResult: { status: 'rejected', code: 'REVISION_MISMATCH', retryable: false } }] }) });
  assert.match(html, /第一段\n&lt;script&gt;not executable&lt;\/script&gt;\n最后一段/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /富文本，含 2 张图片/); assert.match(html, /保留账号内容/);
  for (const secret of ['private-original-op', 'private-entity-id', 'private-conflict', 'private-resolution', 'REVISION_MISMATCH']) {
    const node = elements(html).find(value => value.nodeName === '#text' && value.value.includes(secret));
    assert.ok(node, secret); let parent = node.parentNode;
    while (parent && parent.tagName !== 'details') parent = parent.parentNode;
    assert.equal(parent?.tagName, 'details'); assert.equal(attr(parent, 'open'), undefined);
  }
});

test('English labels, semantic tokens and native keyboard controls cover every review task', () => {
  const preview = notePreview({ localRows: [localRow('one', { action: 'restore' })], conflicts: [noteConflict()] });
  for (const task of ['publish', 'adopt', 'bind', 'pending']) {
    const html = render({ task, preview, l: (_, en) => en, confirmation: task === 'pending' ? null : task });
    assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b|onkeydown|tabindex="[1-9]/);
    assert.match(html, /var\(--pq-/);
    for (const button of elements(html).filter(node => node.tagName === 'button')) assert.match(attr(button, 'class'), /min-h-11/);
  }
});
