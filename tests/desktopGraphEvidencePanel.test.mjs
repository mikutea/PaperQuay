import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { citationEdge, createGraphEvidenceFixture, deferred, evidencePaper, evidencePreview, evidenceSnapshot, evidenceStatus, scopeKey } from './fixtures/desktopGraphEvidence.mjs';
const require = createRequire(import.meta.url);
async function load(entry) { const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' }); const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports); return module.exports; }
let ui, service, core, create, act;
test.before(async () => { [ui, service, core, { create, act }] = await Promise.all([load('src/features/reader/desktopGraphEvidencePanel.tsx'), load('src/services/desktopGraphEvidence.ts'), load('packages/sync-core/src/graphEvidence.ts'), load(require.resolve('react-test-renderer'))]); });
const l = (zh, en) => { assert.equal(typeof en, 'string'); return zh; };
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const commands = f => f.calls.map(row => row.command);
async function mount(t, options = {}) {
  const f = createGraphEvidenceFixture(options), old = globalThis.window; globalThis.window = f.window; let root;
  const props = () => ({ l, accountActive: options.accountActive ?? true, status: f.current.status, onLinkPapers: options.onLinkPapers });
  await act(async () => { root = create(createElement(ui.DesktopGraphEvidencePanel, props())); });
  t.after(async () => { await act(async () => root.unmount()); globalThis.window = old; });
  return { ...f, root, setStatus: async next => { f.current.status = next; await act(async () => root.update(createElement(ui.DesktopGraphEvidencePanel, props()))); } };
}
function button(f, label) { const found = f.root.root.findAllByType('button').find(node => text(node) === label); assert.ok(found, 'Button exists: ' + label); return found; }
async function click(f, label) { const node = button(f, label); assert.ok(!node.props.disabled, 'Button enabled: ' + label); await act(async () => node.props.onClick()); }
const inputs = f => f.root.root.findAllByType('input').filter(node => node.props.type === 'checkbox');
async function choose(f, index, checked = true) { const node = inputs(f)[index]; assert.ok(node && !node.props.disabled); await act(async () => node.props.onChange({ target: { checked } })); }
async function start(f) { const node = f.root.root.findByProps({ 'data-graph-evidence-start': true }); assert.ok(!node.props.disabled); await act(async () => node.props.onClick()); }
async function prepare(f) { await start(f); await choose(f, 0); await choose(f, 1); await click(f, '检查所选来源'); }

test('fixture snapshot satisfies the real closed schema and both envelope/edge hashes', async () => { assert.deepEqual(await core.verifyGraphEvidence(evidenceSnapshot()), evidenceSnapshot()); });
test('service uses only fixed status/list/preview/export IPC and exposes no chosen path', async () => {
  const f = createGraphEvidenceFixture(), old = globalThis.window; globalThis.window = f.window;
  try { const s = service.desktopGraphEvidence; await s.status(); await s.list(); await s.preview({ localPaperIds: ['local-one', 'local-two'], includeReferences: true, includeSimilarity: false }); const result = await s.export({ token: 'current-token' }); assert.deepEqual(result, { saved: true }); assert.deepEqual(f.calls, [{ command: 'desktop_graph_evidence_status', args: {} }, { command: 'desktop_graph_evidence_list', args: {} }, { command: 'desktop_graph_evidence_preview', args: { localPaperIds: ['local-one', 'local-two'], includeReferences: true, includeSimilarity: false } }, { command: 'desktop_graph_evidence_export', args: { token: 'current-token' } }]); }
  finally { globalThis.window = old; }
});
test('opening performs no automatic action; local list is explicit, papers default zero and source flags default true', async t => {
  let links = 0; const f = await mount(t, { onLinkPapers: () => links++ }); assert.deepEqual(commands(f), []); await start(f); assert.deepEqual(commands(f), ['desktop_graph_evidence_list']);
  assert.deepEqual(inputs(f).map(node => node.props.checked), [false, false, false, true, true]); assert.ok(inputs(f)[2].props.disabled); assert.ok(button(f, '检查所选来源').props.disabled); await click(f, '去关联文献'); assert.equal(links, 1);
});
test('source flags require at least one kind and the exact selected endpoint set reaches preview', async t => {
  const f = await mount(t); await start(f); await choose(f, 0); await choose(f, 1); await choose(f, 3, false); await choose(f, 4, false); assert.ok(button(f, '检查所选来源').props.disabled); assert.ok(!commands(f).includes('desktop_graph_evidence_preview'));
  await choose(f, 4, true); await click(f, '检查所选来源'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_graph_evidence_preview').args, { localPaperIds: ['local-one', 'local-two'], includeReferences: false, includeSimilarity: true }); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-edge': 'citation' }).length, 0); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-edge': 'similarity' }).length, 1);
});
test('review shows exact descriptions and scores, separate cache times and historical unverified PDF qualification before any save', async t => {
  const f = await mount(t); await prepare(f); const output = text(f.root.toJSON()); assert.match(output, /历史缓存，未核验对应的 PDF 版本/); assert.match(output, /不能据此确认当前 PDF 中的事实/); assert.match(output, /参考文献缓存记录：乡村步行空间与邻里交流（2021），第 8 条/); assert.match(output, /0.9123456789012345/); assert.match(output, /参考文献缓存时间/); assert.match(output, /相似记录时间/); assert.match(output, /本次检查时间/); assert.match(output, /分块向量均值余弦/); assert.match(output, /不表示正确概率/); assert.ok(!commands(f).includes('desktop_graph_evidence_export'));
  await click(f, '选择位置并保存来源包'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_graph_evidence_export').args, { token: 'fixture-evidence-token-1' }); assert.match(text(f.root.toJSON()), /已保存到你选择的位置/); assert.deepEqual(commands(f), ['desktop_graph_evidence_list', 'desktop_graph_evidence_preview', 'desktop_graph_evidence_export']);
});
test('cancelled native save is never success and preserves the same token for a later explicit save', async t => {
  const f = await mount(t); f.overrides.set('desktop_graph_evidence_export', () => ({ saved: false, cancelled: true })); await prepare(f); await click(f, '选择位置并保存来源包'); assert.match(text(f.root.toJSON()), /已取消保存，当前预览仍保留/); assert.doesNotMatch(text(f.root.toJSON()), /已保存到你选择的位置/); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-review': true }).length, 1);
  f.overrides.delete('desktop_graph_evidence_export'); await click(f, '选择位置并保存来源包'); assert.deepEqual(f.calls.filter(row => row.command === 'desktop_graph_evidence_export').map(row => row.args), [{ token: 'fixture-evidence-token-1' }, { token: 'fixture-evidence-token-1' }]); assert.match(text(f.root.toJSON()), /已保存到你选择的位置/);
});
test('double-clicking the captured export action opens only one in-flight native save', async t => {
  const f = await mount(t), pending = deferred(); f.overrides.set('desktop_graph_evidence_export', () => pending.promise); await prepare(f); const action = button(f, '选择位置并保存来源包').props.onClick; await act(async () => { action(); action(); }); assert.equal(commands(f).filter(name => name === 'desktop_graph_evidence_export').length, 1); await act(async () => pending.resolve({ saved: false, cancelled: true }));
});
test('selection remains bounded across pages and search, without selecting the seventeenth paper', async t => {
  const f = await mount(t, { papers: Array.from({ length: 17 }, (_, i) => evidencePaper('paper-' + i, { title: '文献 ' + i })) }); await start(f);
  for (let page = 0; page < 2; page++) { for (let i = 0; i < 8; i++) await choose(f, i); await click(f, '下一页'); } assert.ok(inputs(f)[0].props.disabled); assert.equal(inputs(f)[0].props.checked, false);
  await act(async () => f.root.root.findAllByType('input').find(node => node.props.type === 'search').props.onChange({ target: { value: '文献 16' } })); assert.ok(inputs(f)[0].props.disabled); await click(f, '检查所选来源'); assert.equal(f.calls.find(row => row.command === 'desktop_graph_evidence_preview').args.localPaperIds.length, 16);
});
test('editing selected papers or source flags revokes an old save callback and a new preview gets a new token', async t => {
  const f = await mount(t); await prepare(f); const stale = button(f, '选择位置并保存来源包').props.onClick; await click(f, '返回选择'); await choose(f, 1, false); await choose(f, 4, false); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_graph_evidence_export'));
  await click(f, '检查所选来源'); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_graph_evidence_export')); await click(f, '选择位置并保存来源包'); assert.deepEqual(f.calls.find(row => row.command === 'desktop_graph_evidence_export').args, { token: 'fixture-evidence-token-2' });
});
test('refreshing current sources revokes the previous token callback without automatic export', async t => {
  const f = await mount(t); await prepare(f); const stale = button(f, '选择位置并保存来源包').props.onClick; await click(f, '重新检查来源'); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_graph_evidence_export')); await click(f, '选择位置并保存来源包'); assert.equal(f.calls.find(row => row.command === 'desktop_graph_evidence_export').args.token, 'fixture-evidence-token-2');
});
test('temporary preview failure preserves selection and flags for an explicit retry', async t => {
  const f = await mount(t); await start(f); await choose(f, 0); await choose(f, 1); await choose(f, 4, false); f.overrides.set('desktop_graph_evidence_preview', () => { throw Object.assign(Error('CACHE_TEMPORARY'), { code: 'CACHE_TEMPORARY' }); }); await click(f, '检查所选来源'); assert.deepEqual(inputs(f).map(node => node.props.checked), [true, true, false, true, false]); assert.equal(commands(f).filter(name => name === 'desktop_graph_evidence_preview').length, 1);
  f.overrides.delete('desktop_graph_evidence_preview'); await click(f, '检查所选来源'); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-review': true }).length, 1);
});
test('source change during save clears the stale preview, preserves paper choice and never claims success', async t => {
  const f = await mount(t); await prepare(f); f.overrides.set('desktop_graph_evidence_export', () => { throw Object.assign(Error('GRAPH_EVIDENCE_PREVIEW_STALE'), { code: 'GRAPH_EVIDENCE_PREVIEW_STALE' }); }); await click(f, '选择位置并保存来源包'); assert.match(text(f.root.toJSON()), /缓存或文献关联已变化/); assert.doesNotMatch(text(f.root.toJSON()), /已保存到你选择的位置/); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-review': true }).length, 0); assert.deepEqual(inputs(f).slice(0, 2).map(node => node.props.checked), [true, true]);
});
test('parent source-change status also revokes a captured save callback', async t => {
  const f = await mount(t); await prepare(f); const stale = button(f, '选择位置并保存来源包').props.onClick; await f.setStatus(evidenceStatus({ errorCode: 'GRAPH_EVIDENCE_SOURCE_CHANGED' })); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_graph_evidence_export')); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-review': true }).length, 0);
});
for (const kind of ['account', 'library']) test(`changing ${kind} revokes a captured save and ignores a late native result`, async t => {
  const f = await mount(t), pending = deferred(); await prepare(f); const stale = button(f, '选择位置并保存来源包').props.onClick; await f.setStatus(evidenceStatus({ scopeKey: 'other-' + kind })); await act(async () => stale()); assert.ok(!commands(f).includes('desktop_graph_evidence_export'));
  await f.setStatus(evidenceStatus()); await prepare(f); f.overrides.set('desktop_graph_evidence_export', () => pending.promise); await click(f, '选择位置并保存来源包'); await f.setStatus(evidenceStatus({ scopeKey: 'new-' + kind })); await act(async () => pending.resolve({ saved: true })); assert.doesNotMatch(text(f.root.toJSON()), /已保存到你选择的位置/); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-review': true }).length, 0);
});
test('A to B to A rejects the old preview and late local list without resurrecting prior selections', async t => {
  const f = await mount(t), preview = deferred(), list = deferred(); await start(f); await choose(f, 0); await choose(f, 1); f.overrides.set('desktop_graph_evidence_preview', () => preview.promise); await click(f, '检查所选来源'); await f.setStatus(evidenceStatus({ scopeKey: 'owner-b' })); await f.setStatus(evidenceStatus()); await act(async () => preview.resolve(evidencePreview())); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-review': true }).length, 0);
  f.overrides.set('desktop_graph_evidence_list', () => list.promise); await start(f); await f.setStatus(evidenceStatus({ scopeKey: 'owner-c' })); await act(async () => list.resolve({ scopeKey, papers: [evidencePaper()] })); assert.equal(f.root.root.findAllByProps({ 'data-graph-evidence-selection': true }).length, 0);
});
test('unavailable or signed-out owner never dispatches local capture', async t => {
  const f = await mount(t, { accountActive: false }); assert.ok(f.root.root.findByProps({ 'data-graph-evidence-start': true }).props.disabled); assert.deepEqual(commands(f), []);
});
test('unknown reference time, skipped rows and source-only result are explicit; no sources cannot save', async t => {
  const snapshot = evidenceSnapshot({ edges: [citationEdge({ provenance: { ...citationEdge().provenance, fetchedAt: null } })] }); const f = await mount(t, { preview: { snapshot, skipped: [{ code: 'GRAPH_EVIDENCE_REFERENCE_UNAVAILABLE', label: '未缓存的来源' }], counts: { sources: 2, citations: 1, similarities: 0, skipped: 1 } } }); await prepare(f); assert.match(text(f.root.toJSON()), /未记录缓存时间/); assert.match(text(f.root.toJSON()), /没有可读取的参考文献缓存/);
  const sourceOnly = renderToStaticMarkup(createElement(ui.DesktopGraphEvidenceReview, { preview: evidencePreview({ snapshot: evidenceSnapshot({ edges: [] }) }), disabled: false, onExport() {}, onBack() {}, l })); assert.match(sourceOnly, /没有关系证据/); assert.match(sourceOnly, /只包含这些来源文献的标识与版本对照/);
  const empty = renderToStaticMarkup(createElement(ui.DesktopGraphEvidenceReview, { preview: evidencePreview({ snapshot: evidenceSnapshot({ sources: [], edges: [] }) }), disabled: false, onExport() {}, onBack() {}, l })); assert.match(empty, /没有取得可导出的文献来源/); assert.match(empty, /disabled=""/);
});
test('closed diagnostics keep all IDs, hashes, schema and local paths out of ordinary rendered content', () => {
  const snapshot = evidenceSnapshot(), html = renderToStaticMarkup(createElement(ui.DesktopGraphEvidenceReview, { preview: evidencePreview({ snapshot }), disabled: false, onExport() {}, onBack() {}, l }));
  for (const id of [snapshot.accountId, snapshot.serviceId, snapshot.digest, ...snapshot.sources.map(row => row.paperId), ...snapshot.edges.map(row => row.id)]) assert.ok(!html.includes(id)); assert.doesNotMatch(html, /mean-chunk-cosine-v1|metadataDigest|pdfVersionVerified|sourcePaperId|localPaperId|file:\/\//); assert.match(html, /0.9123456789012345/);
});
test('several identical skipped cache entries remain separate rows without duplicate React keys', async t => {
  const captured = [], original = console.error; console.error = (...args) => captured.push(args.join(' '));
  try { const row = { localPaperId: 'local-one', code: 'GRAPH_EVIDENCE_REFERENCE_UNRESOLVED' }; const f = await mount(t, { preview: { skipped: [row, { ...row }], counts: { sources: 2, citations: 1, similarities: 1, skipped: 2 } } }); await prepare(f);
    const section = f.root.root.findByProps({ 'aria-label': '未纳入的来源' }); assert.equal(section.findAllByType('li').length, 2); assert.equal(text(section).split('未找到对应的本机文献，已跳过。').length - 1, 2); assert.deepEqual(captured, []);
  } finally { console.error = original; }
});
test('ambiguous native result cannot be presented as saved', async t => { const f = await mount(t); f.overrides.set('desktop_graph_evidence_export', () => ({ saved: false })); await prepare(f); await click(f, '选择位置并保存来源包'); assert.doesNotMatch(text(f.root.toJSON()), /已保存到你选择的位置/); assert.equal(f.root.root.findAllByProps({ role: 'alert' }).length, 1); });
