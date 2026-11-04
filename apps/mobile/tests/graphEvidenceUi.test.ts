import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { GraphEvidencePanel } from '../src/components/GraphEvidencePanel.tsx';
import { canonicalJson } from '../../../packages/sync-core/src/index.ts';
import { ClientError } from '../src/errors.ts';
import type { TextFileExport } from '../src/platform/exportFile.ts';
import { gid, graphScope as scope, setupGraphEvidence } from './graphEvidenceFixtures.ts';
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
function button(r: ReactTestRenderer, label: string) { const node = r.root.findAllByType('button').find(node => text(node).startsWith(label)); assert(node, 'Missing button ' + label); return node; }
async function click(r: ReactTestRenderer, label: string) { const node = button(r, label); assert(!node.props.disabled, label + ' disabled'); await act(async () => { node.props.onClick(); }); }
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await act(async () => { await new Promise<void>(done => setImmediate(done)); }); } assert.fail('Graph evidence UI did not settle'); }
const checks = (r: ReactTestRenderer) => r.root.findAllByType('input').filter(node => node.props.type === 'checkbox');
async function choose(r: ReactTestRenderer, input: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(input)), file = { name: 'synthetic-graph.json', size: bytes.length, arrayBuffer: async () => bytes.buffer };
  await act(async () => { r.root.findAllByType('input').find(node => node.props.type === 'file')!.props.onChange({ currentTarget: { files: [file], value: 'synthetic-graph.json' } }); });
  await until(() => !r.root.findAllByProps({ role: 'status' }).some(node => text(node) === '正在处理来源包…'));
}
async function setup(t: TestContext) {
  const f = await setupGraphEvidence(t), sync = f.controller.getSnapshot().workspace!.sync, key = JSON.stringify([sync.accountId, sync.deviceId, sync.generation]);
  let active = true, renderer!: ReactTestRenderer; const downloads: TextFileExport[] = [];
  const props = { controller: f.controller, scopeKey: key, current: () => active,
    exportRuntime: { native: false, available: () => true, canShare: async () => true, write: async () => '', share: async () => {}, remove: async () => {}, download: (file: TextFileExport) => downloads.push(file), id: () => crypto.randomUUID() } };
  await act(async () => { renderer = create(createElement(GraphEvidencePanel, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return { ...f, renderer, downloads, retire: () => { active = false; }, updateProps: async () => { await act(async () => renderer.update(createElement(GraphEvidencePanel, { ...props }))); } };
}
test('actual hooks open locally, select no edges by default, then preview and adopt only the chosen relationship', async t => {
  const f = await setup(t), before = canonicalJson(f.controller.getSnapshot().workspace!.sync); assert.equal(f.calls(), 0); assert.equal(checks(f.renderer).length, 0);
  await choose(f.renderer, f.snapshot); assert.equal(checks(f.renderer).length, 2); assert(checks(f.renderer).every(node => !node.props.checked));
  assert(button(f.renderer, '预览采用所选关系').props.disabled); assert.equal((await f.store.read(scope))!.graphEvidence, undefined);
  await act(async () => checks(f.renderer)[0].props.onChange()); await click(f.renderer, '预览采用所选关系');
  assert.equal((await f.store.read(scope))!.graphEvidence, undefined); assert(f.renderer.root.findAllByProps({ role: 'alertdialog' }).length);
  await click(f.renderer, '确认采用到本机图谱'); await until(() => f.controller.getSnapshot().workspace?.graphEvidence?.edgeIds.length === 1);
  assert.deepEqual(f.controller.getSnapshot().workspace!.graphEvidence!.edgeIds, [f.snapshot.edges[0].id]); assert.equal(canonicalJson(f.controller.getSnapshot().workspace!.sync), before); assert.equal(f.calls(), 0);
});
test('changing the source file or selection invalidates captured confirmation callbacks and never silently adopts a replacement', async t => {
  const f = await setup(t); await choose(f.renderer, f.snapshot); await act(async () => checks(f.renderer)[0].props.onChange()); await click(f.renderer, '预览采用所选关系');
  const old = button(f.renderer, '确认采用到本机图谱').props.onClick;
  await act(async () => checks(f.renderer)[0].props.onChange()); await act(async () => old()); assert.equal((await f.store.read(scope))!.graphEvidence, undefined);
  await act(async () => checks(f.renderer)[1].props.onChange()); await click(f.renderer, '预览采用所选关系'); const previous = button(f.renderer, '确认采用到本机图谱').props.onClick;
  await choose(f.renderer, f.snapshot); await act(async () => previous()); assert.equal((await f.store.read(scope))!.graphEvidence, undefined); assert(checks(f.renderer).every(node => !node.props.checked));
});
test('a pending source invalidates the visible confirmation and the old action still cannot pass the transaction guard', async t => {
  const f = await setup(t); await choose(f.renderer, f.snapshot); await act(async () => checks(f.renderer)[0].props.onChange()); await click(f.renderer, '预览采用所选关系');
  const old = button(f.renderer, '确认采用到本机图谱').props.onClick;
  await f.store.update(scope, value => ({ ...value!, pendingResolutions: { [gid(80)]: { entityType: 'attachmentVersion', entityId: gid(12), request: { opId: gid(81), expectedRevision: 1, choice: 'current' } } } }));
  await act(async () => { await f.controller.refreshGraphEvidence(); });
  assert(button(f.renderer, '确认采用到本机图谱').props.disabled); assert(checks(f.renderer).every(node => node.props.disabled));
  await act(async () => old()); await until(() => f.renderer.root.findAllByProps({ role: 'alert' }).length > 0); assert.equal((await f.store.read(scope))!.graphEvidence, undefined); assert.equal(f.calls(), 0);
});
test('lost save acknowledgement preserves the candidate and an exact explicit retry settles the one existing adoption', async t => {
  const f = await setup(t), update = f.store.update.bind(f.store); let lost = true;
  f.store.update = async (...args) => { const value = await update(...args); if (lost && value.graphEvidence) { lost = false; throw new ClientError('STORAGE_FAILED'); } return value; };
  await choose(f.renderer, f.snapshot); await act(async () => checks(f.renderer)[0].props.onChange()); await click(f.renderer, '预览采用所选关系'); await click(f.renderer, '确认采用到本机图谱');
  await until(() => f.renderer.root.findAllByProps({ role: 'alert' }).length > 0); assert.equal(checks(f.renderer)[0].props.checked, true);
  const saved = (await f.store.read(scope))!.graphEvidence!; assert(saved); await click(f.renderer, '确认采用到本机图谱'); await until(() => f.controller.getSnapshot().workspace?.graphEvidence?.snapshot.digest === f.snapshot.digest);
  assert.deepEqual((await f.store.read(scope))!.graphEvidence, saved); assert.equal(f.calls(), 0);
});
test('stale historical evidence remains exportable and cleanup has a separate confirmation while papers/outbox stay intact', async t => {
  const f = await setup(t); await act(async () => { await f.controller.adoptGraphEvidence(f.snapshot, [f.snapshot.edges[0].id], null); });
  const before = canonicalJson(f.controller.getSnapshot().workspace!.sync);
  await f.store.update(scope, value => ({ ...value!, pendingResolutions: { [gid(80)]: { entityType: 'paper', entityId: gid(2), request: { opId: gid(81), expectedRevision: 1, choice: 'current' } } } }));
  await act(async () => { await f.controller.refreshGraphEvidence(); }); await click(f.renderer, '导出原始来源包'); await until(() => f.downloads.length === 1);
  assert.deepEqual(JSON.parse(f.downloads[0].text), f.snapshot); await click(f.renderer, '清理本机接收的来源'); assert((await f.store.read(scope))!.graphEvidence);
  await click(f.renderer, '取消'); assert((await f.store.read(scope))!.graphEvidence); await click(f.renderer, '清理本机接收的来源'); await click(f.renderer, '确认清理本机来源'); await until(() => !f.controller.getSnapshot().workspace?.graphEvidence);
  assert.equal(canonicalJson(f.controller.getSnapshot().workspace!.sync), before); assert.equal(f.calls(), 0);
});
test('retired ownership hides all old file content and captured confirm callbacks cannot store it', async t => {
  const f = await setup(t); await choose(f.renderer, f.snapshot); await act(async () => checks(f.renderer)[0].props.onChange()); await click(f.renderer, '预览采用所选关系');
  const old = button(f.renderer, '确认采用到本机图谱').props.onClick; f.retire(); await f.updateProps(); assert.equal(f.renderer.toJSON(), null);
  await act(async () => old()); assert.equal((await f.store.read(scope))!.graphEvidence, undefined);
});
