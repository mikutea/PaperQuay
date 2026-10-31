import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';

const require = createRequire(import.meta.url);
async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
let ui, service;
test.before(async () => {
  [ui, service] = await Promise.all([load('src/features/reader/desktopGraphExchangePanel.tsx'), load('src/services/desktopGraphExchange.ts')]);
});
const l = (zh, en) => { assert.notEqual(en, undefined, 'Every rendered label must provide both locales'); return zh; };
const relation = overrides => ({
  source: { entityType: 'paper', entityId: '00000000-0000-4000-8000-000000000001' },
  target: { entityType: 'note', entityId: '00000000-0000-4000-8000-000000000002' },
  relationType: 'ai_suggested', label: '方法相似', description: '第一段完整说明。\n第二段仍需保留。',
  confidence: null, weight: 0.5, createdAt: '2026-10-31T01:00:00.000Z', updatedAt: null, ...overrides,
});
const local = (action, overrides = {}) => ({ key: action, localRelationId: `local-${action}`, label: `关系 ${action}`, action, local: relation(), remote: null, ...overrides });
const incoming = (state, overrides = {}) => ({ key: state, entityId: `account-${state}`, label: `传入 ${state}`, state, data: relation(), canAccept: ['new', 'update', 'delete'].includes(state), accepted: null, revision: 1, acceptedRevision: null, ...overrides });
function preview(overrides = {}) {
  return { token: 'review-token', scopeKey: 'service-account-library', revision: 2, checkedAt: '2026-10-31T02:00:00.000Z', localRows: [], incoming: [], conflicts: [], pendingRows: [], pendingResolutions: [], ...overrides };
}
function reviewProps(overrides = {}) {
  return { l, task: 'publish', preview: preview(), disabled: false, selectedLocal: [], selectedIncoming: [], confirmation: null, conflictChoices: {},
    onToggleLocal() {}, onToggleIncoming() {}, onConfirm() {}, onPublish() {}, onAdopt() {}, onConflictChoice() {}, onResolve() {}, ...overrides };
}
function nodes(markup) {
  const result = [];
  const walk = node => { result.push(node); for (const child of node.childNodes || []) walk(child); };
  walk(parseFragment(markup)); return result;
}
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const textContent = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(textContent).join('');
const render = props => renderToStaticMarkup(createElement(ui.DesktopGraphExchangeReview, reviewProps(props)));
function elements(element) {
  const result = [];
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object' || !value.props) return;
    result.push(value); walk(value.props.children);
  };
  walk(element); return result;
}
function elementText(element) {
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (Array.isArray(element)) return element.map(elementText).join('');
  return element?.props ? elementText(element.props.children) : '';
}

test('graph service invokes exact selected operations and delegates backup to the native picker', async () => {
  const calls = [], listeners = [];
  const oldWindow = globalThis.window;
  globalThis.window = { paperquay: { invoke: async (command, args) => { calls.push({ command, args }); return command === 'desktop_graph_export' ? { status: 'cancelled' } : {}; }, listen: async (name, handler) => { listeners.push({ name, handler }); return () => listeners.pop(); } } };
  try {
    const { desktopGraphExchange: graph } = service;
    await graph.status(); await graph.preview();
    await graph.publish({ token: 'review-a', keys: ['specific-local'] });
    await graph.adopt({ token: 'review-b', ids: ['specific-account'] });
    await graph.resolve({ conflictId: 'specific-conflict', choice: 'current', expectedRevision: 7 });
    await graph.continue(); await graph.stop(); await graph.retrySave();
    assert.deepEqual(await graph.exportBackup(), { status: 'cancelled' });
    const handler = () => {}, stop = await graph.onChanged(handler);
    assert.deepEqual(listeners, [{ name: 'desktop-account:changed', handler }]); stop(); assert.equal(listeners.length, 0);
    assert.deepEqual(calls, [
      { command: 'desktop_graph_status', args: {} }, { command: 'desktop_graph_preview', args: {} },
      { command: 'desktop_graph_publish', args: { token: 'review-a', keys: ['specific-local'] } },
      { command: 'desktop_graph_adopt', args: { token: 'review-b', ids: ['specific-account'] } },
      { command: 'desktop_graph_resolve', args: { conflictId: 'specific-conflict', choice: 'current', expectedRevision: 7 } },
      { command: 'desktop_graph_continue', args: {} }, { command: 'desktop_graph_stop', args: {} },
      { command: 'desktop_graph_retry_save', args: {} }, { command: 'desktop_graph_export', args: {} },
    ]);
  } finally { globalThis.window = oldWindow; }
});

test('review never preselects publication, restoration, deletion, acceptance or conflict decisions', () => {
  let acted = 0;
  const content = preview({ localRows: ['create', 'restore', 'delete', 'none', 'blocked'].map(action => local(action)), incoming: ['new', 'delete', 'same', 'pending', 'unmapped'].map(state => incoming(state)) });
  const html = ['publish', 'adopt'].map(task => render({ task, preview: content, onPublish: () => acted++, onAdopt: () => acted++ })).join('');
  const all = nodes(html), inputs = all.filter(node => node.tagName === 'input');
  assert.equal(inputs.length, 10);
  assert.ok(inputs.every(node => attr(node, 'checked') === undefined));
  assert.equal(inputs.filter(node => attr(node, 'disabled') !== undefined).length, 5);
  assert.ok(all.filter(node => node.tagName === 'button' && /预览同步内容|预览带入内容/.test(textContent(node))).every(node => attr(node, 'disabled') !== undefined));
  assert.match(html, /恢复账号关系/); assert.match(html, /删除账号关系/); assert.match(html, /暂不能带入，内容保留在账号/);
  assert.equal(acted, 0);
});

test('unknown score stays unknown and full original relation fields survive the detail view', () => {
  const html = renderToStaticMarkup(createElement(ui.DesktopGraphRelationDetails, { data: relation(), title: '账号内容', l }));
  const all = nodes(html), score = all.find(node => node.tagName === 'dt' && textContent(node) === '关系分数');
  const siblings = score.parentNode.childNodes;
  assert.equal(textContent(siblings[siblings.indexOf(score) + 1]), '未提供');
  assert.match(html, /第一段完整说明。\n第二段仍需保留。/);
  assert.match(html, /00000000-0000-4000-8000-000000000001/); assert.match(html, /00000000-0000-4000-8000-000000000002/);
  assert.match(html, /2026-10-31T01:00:00.000Z/); assert.match(html, /AI 建议/);
  const zero = renderToStaticMarkup(createElement(ui.DesktopGraphRelationDetails, { data: relation({ confidence: 0 }), title: '账号内容', l }));
  assert.match(zero, /关系分数<\/dt><dd>0<\/dd>/);
});

test('differences show both descriptions and publishing requires a separate explicit confirmation', () => {
  const item = local('update', { local: relation({ description: '完整本机版本' }), remote: relation({ description: '完整账号版本', confidence: 0.72 }) });
  const selection = { preview: preview({ localRows: [item] }), selectedLocal: ['update'] };
  const ordinary = render(selection);
  assert.match(ordinary, /完整本机版本/); assert.match(ordinary, /完整账号版本/); assert.match(ordinary, /0\.72/);
  assert.doesNotMatch(ordinary, /同步这 1 条关系/);
  const confirmation = render({ ...selection, confirmation: 'publish' });
  assert.match(confirmation, /即将把所选关系同步到账号/); assert.match(confirmation, /同步这 1 条关系/);
});

test('selected publication first opens confirmation and only its confirm button dispatches the operation', () => {
  let confirmed = null, published = 0;
  const props = reviewProps({ preview: preview({ localRows: [local('create')] }), selectedLocal: ['create'], onConfirm: value => { confirmed = value; }, onPublish: () => { published++; } });
  const initial = elements(ui.DesktopGraphExchangeReview(props));
  initial.find(element => element.type === 'button' && elementText(element).startsWith('预览同步内容')).props.onClick();
  assert.equal(confirmed, 'publish'); assert.equal(published, 0);
  const final = elements(ui.DesktopGraphExchangeReview({ ...props, confirmation: confirmed }));
  final.find(element => element.type === 'button' && elementText(element) === '同步这 1 条关系').props.onClick();
  assert.equal(published, 1);
});

test('delete and restore effects are counted explicitly in the final publication review', () => {
  const html = render({ preview: preview({ localRows: [local('delete'), local('restore')] }), selectedLocal: ['delete', 'restore'], confirmation: 'publish' });
  assert.match(html, /包含 1 条删除，将删除账号中的关系/); assert.match(html, /包含 1 条恢复，将恢复账号中已删除的关系/);
  const acceptance = render({ task: 'adopt', preview: preview({ incoming: [incoming('delete', { data: null })] }), selectedIncoming: ['account-delete'], confirmation: 'adopt' });
  assert.match(acceptance, /包含 1 条删除，将从本机账号图谱移除对应关系/); assert.match(acceptance, /账号关系已删除/);
});

test('incoming updates compare the accepted copy, and runtime acceptance eligibility controls selection', () => {
  const html = render({ task: 'adopt', preview: preview({ incoming: [incoming('update', { accepted: relation({ description: '此前接收的完整说明' }), data: relation({ description: '账号更新后的完整说明' }), acceptedRevision: 3, revision: 4 }), incoming('new', { key: 'blocked-new', entityId: 'blocked-new', canAccept: false })] }), selectedIncoming: ['blocked-new'], confirmation: 'adopt' });
  assert.match(html, /此前接收的完整说明/); assert.match(html, /账号更新后的完整说明/); assert.match(html, /账号版本 4/);
  assert.match(html, /带入这 0 条关系/);
  const accept = nodes(html).find(node => node.tagName === 'button' && textContent(node) === '带入这 0 条关系');
  assert.notEqual(attr(accept, 'disabled'), undefined);
});

test('blocked local rows expose preserved original fields without interpreting unknown data', () => {
  const original = { id: 'local-note-relation', source: 'note:unbound', target: 'paper:bound', description: '尚未绑定也必须保留的完整说明。', extra: { original: '<script>not executable</script>', score: null } };
  const html = render({ preview: preview({ localRows: [local('blocked', { local: null, reason: 'UNMAPPED_GRAPH_ENDPOINT', raw: original })] }) });
  assert.match(html, /保留的本机原字段/); assert.match(html, /尚未绑定也必须保留的完整说明/); assert.match(html, /note:unbound/);
  assert.match(html, /此类笔记关系暂不能同步，原内容仍保留/);
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  const all = nodes(html);
  assert.ok(all.some(node => attr(node, 'title') === 'UNMAPPED_GRAPH_ENDPOINT'));
  assert.ok(!textContent(parseFragment(html)).includes('UNMAPPED_GRAPH_ENDPOINT'));
});

test('conflict choices preserve the deleted current head and original attempted request without defaulting either', () => {
  const conflict = { conflictId: 'conflict-1', entityId: 'relation-1', label: '需要决定', expectedRevision: 5, current: { revision: 5, deletedAt: '2026-10-31T03:00:00.000Z', data: null }, attempted: { mutation: 'restore', data: relation({ description: '原始恢复请求内容' }) } };
  const html = render({ task: 'pending', preview: preview({ conflicts: [conflict], pendingRows: [{ opId: 'original-op', entityId: 'relation-1', label: '原始关系', mutation: 'restore', stage: 'uncertain', data: relation({ description: '原请求完整说明' }) }] }) });
  assert.match(html, /已删除/); assert.match(html, /原始恢复请求内容/); assert.match(html, /原请求完整说明/); assert.match(html, /original-op/);
  const all = nodes(html), radios = all.filter(node => node.tagName === 'input' && attr(node, 'type') === 'radio');
  assert.equal(radios.length, 2); assert.ok(radios.every(node => attr(node, 'checked') === undefined));
  assert.notEqual(attr(all.find(node => node.tagName === 'button' && textContent(node) === '应用这项选择'), 'disabled'), undefined);
});

test('saved current-version resolution is not misrepresented as deletion and retains its failed result', () => {
  const html = render({ task: 'pending', preview: preview({ pendingResolutions: [{ conflictId: 'conflict-one', opId: 'saved-decision-op', expectedRevision: 9, choice: 'current', lastResult: { status: 'rejected', code: 'REVISION_MISMATCH', retryable: false } }] }) });
  assert.match(html, /保留账号版本 9/); assert.match(html, /上次选择未被接受/); assert.match(html, /REVISION_MISMATCH/); assert.match(html, /saved-decision-op/);
  assert.doesNotMatch(html, /请求删除这条关系/);
});

test('long lists retain the total while limiting visible rows, and blocked fields are never selectable', () => {
  const html = render({ preview: preview({ localRows: Array.from({ length: 17 }, (_, index) => local('blocked', { key: `row-${index}`, label: `关系-${index}`, reason: 'UNMAPPED_GRAPH_ENDPOINT' })) }) });
  assert.equal(nodes(html).filter(node => node.tagName === 'input').length, 8);
  assert.match(html, /第 1 \/ 3 页，共 17 条/); assert.match(html, /此类笔记关系暂不能同步/); assert.doesNotMatch(html, /关系-8/);
});

test('task picker gives three concrete destinations without internal mapping or request jargon', () => {
  const chosen = [];
  const props = { disabled: false, pending: 2, l, onTask: task => chosen.push(task) };
  const html = renderToStaticMarkup(createElement(ui.DesktopGraphExchangeTaskPicker, props));
  const labels = nodes(html).filter(node => node.tagName === 'button').map(textContent);
  assert.equal(labels.length, 3);
  assert.match(labels[0], /把本机关系同步到账号/); assert.match(labels[1], /把账号关系带到本机/); assert.match(labels[2], /处理未完成操作/);
  assert.doesNotMatch(html, /映射|原请求|端点|ID|备份/);
  elements(ui.DesktopGraphExchangeTaskPicker(props)).filter(element => element.type === 'button').forEach(button => button.props.onClick());
  assert.deepEqual(chosen, ['publish', 'adopt', 'pending']);
});

test('each selected task contains only its relevant relations and actions', () => {
  const content = preview({ localRows: [local('create', { label: '只在本机' })], incoming: [incoming('new', { label: '只在账号' })], pendingRows: [{ opId: 'pending-op-secret', entityId: 'relation-a', label: '只在未完成操作', mutation: 'put', stage: 'uncertain', data: relation() }] });
  const publish = render({ preview: content, task: 'publish' });
  const adopt = render({ preview: content, task: 'adopt' });
  const pending = render({ preview: content, task: 'pending' });
  assert.match(publish, /只在本机/); assert.doesNotMatch(publish, /只在账号|只在未完成操作|pending-op-secret|预览带入内容/);
  assert.match(adopt, /只在账号/); assert.doesNotMatch(adopt, /只在本机|只在未完成操作|pending-op-secret|预览同步内容/);
  assert.match(pending, /只在未完成操作/); assert.doesNotMatch(pending, /只在本机|只在账号|预览同步内容|预览带入内容/);
  const idNode = nodes(pending).find(node => node.nodeName === '#text' && node.value.includes('pending-op-secret'));
  let parent = idNode?.parentNode;
  while (parent && parent.tagName !== 'details') parent = parent.parentNode;
  assert.equal(parent?.tagName, 'details', 'the original request identifier stays in collapsed operation details');
  assert.equal(attr(parent, 'open'), undefined);
});

test('different account scopes and sign-in states receive distinct owned view keys', () => {
  const first = ui.DesktopGraphExchangePanel({ l, accountActive: true, ownerKey: 'account-a-library-a' });
  const second = ui.DesktopGraphExchangePanel({ l, accountActive: true, ownerKey: 'account-b-library-a' });
  const signedOut = ui.DesktopGraphExchangePanel({ l, accountActive: false, ownerKey: 'account-a-library-a' });
  assert.notEqual(first.key, second.key); assert.notEqual(first.key, signedOut.key);
});
